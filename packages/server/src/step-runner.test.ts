/**
 * Tests for the cooperative step runner (REN-1398).
 *
 * Covers the three ADR-mandated acceptance criteria for cancel:
 *
 *   1. session.cancel-requested -> between-step observation -> in-flight
 *      step completes -> final session.cancelled event.
 *   2. interrupt: 'safe' falls back to cooperative when no checkpoint
 *      primitive was declared.
 *   3. interrupt: 'unsafe' surfaces kill-requested only when the step
 *      is also marked idempotent.
 *
 * Plus a kill-and-replay test wired through the journal-mock + resume
 * path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const cancelStore = new Map<string, unknown>()
const journalEntries: Array<{
  sessionId: string
  stepId: string
  status: string
  inputHash: string
  outputCAS?: string
  startedAt?: number
  completedAt?: number
  error?: string
}> = []

vi.mock('./redis.js', () => ({
  isRedisConfigured: vi.fn(() => true),
  redisSet: vi.fn(async (key: string, value: unknown) => {
    cancelStore.set(key, value)
  }),
  redisGet: vi.fn(async (key: string) => cancelStore.get(key) ?? null),
  redisDel: vi.fn(async (key: string) => {
    const had = cancelStore.has(key)
    cancelStore.delete(key)
    return had ? 1 : 0
  }),
  redisHGetAll: vi.fn(async () => ({})),
  redisKeys: vi.fn(async () => []),
  getRedisClient: vi.fn(() => ({
    hset: vi.fn(),
    hgetall: vi.fn(async () => ({})),
  })),
}))

vi.mock('./journal.js', async () => {
  const actual = await vi.importActual<typeof import('./journal.js')>('./journal.js')
  return {
    ...actual,
    writeJournalEntry: vi.fn(async (input: Record<string, unknown>) => {
      journalEntries.push({ ...input } as (typeof journalEntries)[number])
      return true
    }),
    listSessionJournal: vi.fn(async (sessionId: string) =>
      journalEntries
        .filter((e) => e.sessionId === sessionId)
        .map((e) => ({
          sessionId: e.sessionId,
          stepId: e.stepId,
          status: e.status,
          inputHash: e.inputHash,
          outputCAS: e.outputCAS ?? '',
          startedAt: e.startedAt ?? 0,
          completedAt: e.completedAt ?? 0,
          attempt: 0,
          ...(e.error !== undefined && { error: e.error }),
        })),
    ),
  }
})

import {
  requestSessionCancel,
  clearCancel,
} from './session-cancel.js'
import {
  runSessionLoop,
  runStepWithCancel,
  type StepDefinition,
} from './step-runner.js'
import { resumeSessionFromJournal } from './session-resume.js'
import {
  sessionEventBus,
  type SessionLifecycleEvent,
} from './session-event-bus.js'

beforeEach(() => {
  cancelStore.clear()
  journalEntries.length = 0
  sessionEventBus.clear()
  vi.clearAllMocks()
})

function step(
  stepId: string,
  body: () => Promise<string>,
  over: Partial<StepDefinition> = {},
): StepDefinition<unknown, unknown> {
  return {
    stepId,
    nodeVersion: 'v1',
    input: { stepId },
    run: async () => {
      const cas = await body()
      return { outputCAS: cas }
    },
    ...over,
  }
}

describe('runStepWithCancel — single step', () => {
  it('writes running -> completed journal entries on the happy path', async () => {
    const result = await runStepWithCancel(step('step-1', async () => 'cas:1'), {
      sessionId: 's1',
      workerId: 'w1',
    })
    expect(result.kind).toBe('completed')
    expect(journalEntries.map((e) => e.status)).toEqual(['running', 'completed'])
    expect(journalEntries[1]!.outputCAS).toBe('cas:1')
  })

  it('skips the step when cancel was already requested before start', async () => {
    await requestSessionCancel('s1', {})
    const ran = vi.fn()
    const result = await runStepWithCancel(
      step('step-1', async () => {
        ran()
        return 'never'
      }),
      { sessionId: 's1', workerId: 'w1' },
    )
    expect(result.kind).toBe('cancelled-before-start')
    expect(ran).not.toHaveBeenCalled()
    expect(journalEntries).toHaveLength(0)
  })

  it('writes failed journal entry when the step throws', async () => {
    const result = await runStepWithCancel(
      step('step-1', async () => {
        throw new Error('boom')
      }),
      { sessionId: 's1', workerId: 'w1' },
    )
    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') throw new Error('typed-narrow')
    expect(result.error).toBe('boom')
    expect(journalEntries.map((e) => e.status)).toEqual(['running', 'failed'])
  })

  it('returns cancelled-after-step when cancel is requested mid-step', async () => {
    let resolveStep!: () => void
    const stepPromise = new Promise<void>((r) => {
      resolveStep = r
    })

    const stepDef = step('step-1', async () => {
      await stepPromise
      return 'cas:1'
    })

    const runPromise = runStepWithCancel(stepDef, {
      sessionId: 's1',
      workerId: 'w1',
    })

    // Simulate an external cancel signal arriving while the step is in flight.
    await requestSessionCancel('s1', { reason: 'test' })
    resolveStep()

    const result = await runPromise
    expect(result.kind).toBe('cancelled-after-step')
    if (result.kind !== 'cancelled-after-step') throw new Error('typed-narrow')
    expect(result.mode).toBe('cooperative')
    // Step still completed, output journaled.
    expect(journalEntries.map((e) => e.status)).toEqual(['running', 'completed'])
  })
})

describe('runStepWithCancel — interrupt policies', () => {
  it('safe-without-checkpoint falls back to cooperative', async () => {
    const stepDef = step('step-x', async () => 'cas:1', {
      interrupt: 'safe',
      hasCheckpoint: false,
    })
    const run = runStepWithCancel(stepDef, { sessionId: 's1', workerId: 'w1' })
    await requestSessionCancel('s1', {})
    const result = await run
    expect(result.kind).toBe('cancelled-after-step')
    if (result.kind !== 'cancelled-after-step') throw new Error('typed-narrow')
    expect(result.mode).toBe('cooperative')
  })

  it('safe-with-checkpoint surfaces mode=safe', async () => {
    const stepDef = step('step-x', async () => 'cas:1', {
      interrupt: 'safe',
      hasCheckpoint: true,
    })
    const run = runStepWithCancel(stepDef, { sessionId: 's1', workerId: 'w1' })
    await requestSessionCancel('s1', {})
    const result = await run
    if (result.kind !== 'cancelled-after-step') throw new Error('typed-narrow')
    expect(result.mode).toBe('safe')
  })

  it('unsafe-without-idempotent falls back to cooperative', async () => {
    const stepDef = step('step-x', async () => 'cas:1', {
      interrupt: 'unsafe',
      idempotent: false,
    })
    const run = runStepWithCancel(stepDef, { sessionId: 's1', workerId: 'w1' })
    await requestSessionCancel('s1', {})
    const result = await run
    if (result.kind !== 'cancelled-after-step') throw new Error('typed-narrow')
    expect(result.mode).toBe('cooperative')
  })

  it('unsafe-with-idempotent surfaces kill-requested', async () => {
    const stepDef = step('step-x', async () => 'cas:1', {
      interrupt: 'unsafe',
      idempotent: true,
    })
    const run = runStepWithCancel(stepDef, { sessionId: 's1', workerId: 'w1' })
    await requestSessionCancel('s1', {})
    const result = await run
    expect(result.kind).toBe('kill-requested')
    if (result.kind !== 'kill-requested') throw new Error('typed-narrow')
    expect(result.mode).toBe('unsafe')
    expect(result.output?.outputCAS).toBe('cas:1')
  })
})

describe('runSessionLoop — E2E cancel', () => {
  it('AC: session.cancel-requested -> step completes -> session.cancelled', async () => {
    const events: SessionLifecycleEvent[] = []
    sessionEventBus.subscribe(
      { kinds: ['session.cancel-requested', 'session.cancelled'] },
      (e) => {
        events.push(e)
      },
    )

    let stepBStarted = false
    let resolveStepB!: () => void
    const stepBPromise = new Promise<void>((r) => {
      resolveStepB = r
    })

    const steps: StepDefinition<unknown, unknown>[] = [
      step('step-A', async () => 'cas:A'),
      step('step-B', async () => {
        stepBStarted = true
        await stepBPromise
        return 'cas:B'
      }),
      step('step-C', async () => 'cas:C-should-not-run'),
    ]

    const loopPromise = runSessionLoop({
      sessionId: 's1',
      workerId: 'w1',
      steps,
    })

    // Wait for step B to actually start before requesting cancel.
    await vi.waitUntil(() => stepBStarted, { timeout: 1_000 })
    await requestSessionCancel('s1', { requestedBy: 'admin' })
    resolveStepB()

    const result = await loopPromise

    // The cancel-requested event fired AND the cancelled event fired.
    const kinds = events.map((e) => e.kind)
    expect(kinds).toContain('session.cancel-requested')
    expect(kinds).toContain('session.cancelled')

    // step-B completed, step-C never ran.
    expect(result.completed).toEqual(['step-A', 'step-B'])
    expect(result.cancelled).toBe(true)
    expect(result.cancelMode).toBe('cooperative')

    const cancelledEvent = events.find((e) => e.kind === 'session.cancelled')
    if (cancelledEvent?.kind !== 'session.cancelled') throw new Error('typed-narrow')
    expect(cancelledEvent.lastCompletedStepId).toBe('step-B')
  })

  it('exits early if cancel was already pending before any step', async () => {
    await requestSessionCancel('s1', {})
    const result = await runSessionLoop({
      sessionId: 's1',
      workerId: 'w1',
      steps: [step('step-A', async () => 'cas:A')],
    })
    expect(result.cancelled).toBe(true)
    expect(result.completed).toEqual([])
  })
})

describe('Resume from journal after kill (AC #3)', () => {
  it('kill mid-session -> restart -> replay starts from latest completedAt', async () => {
    // First "worker" run: step-1 + step-2 complete; worker dies before step-3.
    await runStepWithCancel(step('step-1', async () => 'cas:1'), {
      sessionId: 'sess-K',
      workerId: 'w1',
    })
    await runStepWithCancel(step('step-2', async () => 'cas:2'), {
      sessionId: 'sess-K',
      workerId: 'w1',
    })

    // Simulate the worker crash — no further journal writes.

    // New worker starts: read the journal and decide where to resume.
    const marker = await resumeSessionFromJournal('sess-K')
    expect(marker.lastCompletedStepId).toBe('step-2')
    expect(marker.totalEntries).toBe(4) // running+completed for step-1, step-2

    // Replay from step-3 (the workflow engine consults filterUnfinishedSteps).
    await clearCancel('sess-K') // ensure no stale cancel
    const result = await runStepWithCancel(step('step-3', async () => 'cas:3'), {
      sessionId: 'sess-K',
      workerId: 'w2',
    })
    expect(result.kind).toBe('completed')
    const after = await resumeSessionFromJournal('sess-K')
    expect(after.lastCompletedStepId).toBe('step-3')
  })
})
