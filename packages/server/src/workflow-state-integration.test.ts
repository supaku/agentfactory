/**
 * Integration tests for the 4-cycle workflow state progression
 * and escalate-human circuit breaker.
 *
 * Mocks Redis to test the full lifecycle:
 *   Cycle 1 (normal) → Cycle 2 (context-enriched) → Cycle 3 (decompose) → Cycle 4 (escalate-human)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// In-memory Redis store for testing
const store = new Map<string, string>()

vi.mock('./redis.js', () => ({
  redisSet: vi.fn(async (key: string, value: unknown, _ttl?: number) => {
    store.set(key, JSON.stringify(value))
  }),
  redisGet: vi.fn(async (key: string) => {
    const val = store.get(key)
    return val ? JSON.parse(val) : null
  }),
  redisDel: vi.fn(async (key: string) => {
    const existed = store.has(key) ? 1 : 0
    store.delete(key)
    return existed
  }),
  redisExists: vi.fn(async (key: string) => store.has(key)),
}))

import {
  computeStrategy,
  getWorkflowState,
  updateWorkflowState,
  recordPhaseAttempt,
  incrementCycleCount,
  appendFailureSummary,
  clearWorkflowState,
  extractFailureReason,
  type EscalationStrategy,
} from './agent-tracking.js'

beforeEach(() => {
  store.clear()
})

/**
 * Simulate what the webhook-orchestrator onAgentComplete handler does
 * when a QA/acceptance agent fails.
 */
async function simulateQAFailure(issueId: string, failureMessage: string) {
  const state = await incrementCycleCount(issueId)
  const failureReason = extractFailureReason(failureMessage)
  const formattedFailure = `--- Cycle ${state.cycleCount}, qa (${new Date().toISOString()}) ---\n${failureReason}`
  await appendFailureSummary(issueId, formattedFailure)
  return await getWorkflowState(issueId)
}

/**
 * Simulate what the webhook-orchestrator onAgentComplete handler does
 * when recording a phase attempt.
 */
async function simulatePhaseCompletion(
  issueId: string,
  phase: 'development' | 'qa' | 'refinement' | 'acceptance',
  result: 'passed' | 'failed',
  costUsd = 0.50
) {
  await recordPhaseAttempt(issueId, phase, {
    attempt: 1,
    sessionId: `session-${phase}-${Date.now()}`,
    startedAt: Date.now(),
    completedAt: Date.now(),
    result,
    costUsd,
  })
}

describe('4-cycle workflow progression integration', () => {
  const issueId = 'test-issue-001'
  const issueIdentifier = 'TEST-42'

  it('progresses through all 4 escalation tiers across full dev-QA-rejected cycles', async () => {
    // Initialize workflow state (happens on first agent completion)
    await updateWorkflowState(issueId, { issueIdentifier })

    // === Cycle 1: normal ===
    // Development completes, QA fails
    await simulatePhaseCompletion(issueId, 'development', 'passed')
    await simulatePhaseCompletion(issueId, 'qa', 'failed')
    let state = await simulateQAFailure(issueId, '## QA Failed\n\nTests failed: TypeError in handleUserLogin — null check missing')

    expect(state).not.toBeNull()
    expect(state!.cycleCount).toBe(1)
    expect(state!.strategy).toBe('normal')
    expect(state!.failureSummary).toContain('TypeError in handleUserLogin')

    // At cycle 1 (normal), strategy would provide retry context for development
    expect(computeStrategy(1)).toBe('normal')

    // === Cycle 2: context-enriched ===
    // Refinement completes, development re-runs, QA fails again
    await simulatePhaseCompletion(issueId, 'refinement', 'passed')
    await simulatePhaseCompletion(issueId, 'development', 'passed')
    await simulatePhaseCompletion(issueId, 'qa', 'failed')
    state = await simulateQAFailure(issueId, '## QA Failed\n\nBuild passes but integration test for /api/users returns 500. Missing database migration.')

    expect(state!.cycleCount).toBe(2)
    expect(state!.strategy).toBe('context-enriched')
    expect(state!.failureSummary).toContain('Cycle 1')
    expect(state!.failureSummary).toContain('Cycle 2')
    expect(state!.failureSummary).toContain('database migration')

    // At cycle 2 (context-enriched), refinement gets full failure history
    expect(computeStrategy(2)).toBe('context-enriched')

    // === Cycle 3: decompose ===
    await simulatePhaseCompletion(issueId, 'refinement', 'passed')
    await simulatePhaseCompletion(issueId, 'development', 'passed')
    await simulatePhaseCompletion(issueId, 'qa', 'failed')
    state = await simulateQAFailure(issueId, 'Failure Reason: The same /api/users endpoint still returns 500. Root cause is the missing foreign key constraint in the migration.')

    expect(state!.cycleCount).toBe(3)
    expect(state!.strategy).toBe('decompose')
    expect(state!.failureSummary).toContain('Cycle 3')

    // At cycle 3 (decompose), refinement gets decomposition instructions
    expect(computeStrategy(3)).toBe('decompose')

    // === Cycle 4: escalate-human ===
    await simulatePhaseCompletion(issueId, 'refinement', 'passed')
    await simulatePhaseCompletion(issueId, 'development', 'passed')
    await simulatePhaseCompletion(issueId, 'qa', 'failed')
    state = await simulateQAFailure(issueId, 'Issues Found:\n1. API endpoint still broken\n2. Migration file has syntax error\n3. Schema mismatch between ORM and SQL')

    expect(state!.cycleCount).toBe(4)
    expect(state!.strategy).toBe('escalate-human')
    expect(state!.failureSummary).toContain('Cycle 4')

    // At cycle 4+ (escalate-human), the loop should stop entirely
    expect(computeStrategy(state!.cycleCount)).toBe('escalate-human')
    expect(computeStrategy(state!.cycleCount + 1)).toBe('escalate-human')

    // Verify all 4 phase records tracked for development and QA
    expect(state!.phases.development).toHaveLength(4)
    expect(state!.phases.qa).toHaveLength(4)
    expect(state!.phases.refinement).toHaveLength(3)
  })

  it('accumulates failure summaries across all cycles with correct formatting', async () => {
    await updateWorkflowState(issueId, { issueIdentifier })

    // Simulate 4 failures with distinct messages
    const failures = [
      '## QA Failed\n\nNull pointer in UserService.getById',
      'Failure Reason: Missing validation on email field causes 500',
      'Issues Found:\n1. Race condition in session manager\n2. Stale cache returns wrong user',
      '## QA Failed\n\nDatabase connection pool exhausted after 10 concurrent requests',
    ]

    for (const msg of failures) {
      await simulateQAFailure(issueId, msg)
    }

    const state = await getWorkflowState(issueId)
    expect(state).not.toBeNull()
    expect(state!.cycleCount).toBe(4)
    expect(state!.strategy).toBe('escalate-human')

    // All 4 cycle markers should be present
    expect(state!.failureSummary).toContain('Cycle 1')
    expect(state!.failureSummary).toContain('Cycle 2')
    expect(state!.failureSummary).toContain('Cycle 3')
    expect(state!.failureSummary).toContain('Cycle 4')

    // Failure details from each cycle should be present
    expect(state!.failureSummary).toContain('Null pointer in UserService')
    expect(state!.failureSummary).toContain('Missing validation on email')
    expect(state!.failureSummary).toContain('Race condition in session manager')
    expect(state!.failureSummary).toContain('Database connection pool exhausted')
  })

  it('tracks per-phase attempt records and costs across cycles', async () => {
    await updateWorkflowState(issueId, { issueIdentifier })

    // Cycle 1: dev → qa(fail)
    await simulatePhaseCompletion(issueId, 'development', 'passed', 1.50)
    await simulatePhaseCompletion(issueId, 'qa', 'failed', 0.75)
    await simulateQAFailure(issueId, 'Tests failed')

    // Cycle 2: refinement → dev → qa(fail)
    await simulatePhaseCompletion(issueId, 'refinement', 'passed', 0.50)
    await simulatePhaseCompletion(issueId, 'development', 'passed', 2.00)
    await simulatePhaseCompletion(issueId, 'qa', 'failed', 0.80)
    await simulateQAFailure(issueId, 'Build failed')

    const state = await getWorkflowState(issueId)
    expect(state).not.toBeNull()

    // Check phase records exist
    expect(state!.phases.development).toHaveLength(2)
    expect(state!.phases.qa).toHaveLength(2)
    expect(state!.phases.refinement).toHaveLength(1)
    expect(state!.phases.acceptance).toHaveLength(0)

    // Calculate total cost (simulates what the escalation comment builder does)
    const allPhases = [
      ...state!.phases.development,
      ...state!.phases.qa,
      ...state!.phases.refinement,
      ...state!.phases.acceptance,
    ]
    const totalCost = allPhases.reduce((sum, p) => sum + (p.costUsd ?? 0), 0)
    expect(totalCost).toBeCloseTo(5.55, 2)
  })

  it('clears workflow state on acceptance pass', async () => {
    await updateWorkflowState(issueId, { issueIdentifier })
    await simulateQAFailure(issueId, 'Tests failed')

    let state = await getWorkflowState(issueId)
    expect(state).not.toBeNull()
    expect(state!.cycleCount).toBe(1)

    // Acceptance pass clears everything
    await clearWorkflowState(issueId)

    state = await getWorkflowState(issueId)
    expect(state).toBeNull()
  })

  it('strategy-based circuit breaker blocks at cycle 4+', async () => {
    await updateWorkflowState(issueId, { issueIdentifier })

    // Progress to escalate-human (cycle 4)
    for (let i = 0; i < 4; i++) {
      await simulateQAFailure(issueId, `Failure in cycle ${i + 1}`)
    }

    const state = await getWorkflowState(issueId)
    expect(state!.strategy).toBe('escalate-human')

    // Circuit breaker check: this is what issue-updated.ts does
    const shouldBlock = state!.strategy === 'escalate-human'
    expect(shouldBlock).toBe(true)

    // Verify further increments stay at escalate-human
    await simulateQAFailure(issueId, 'Yet another failure')
    const state2 = await getWorkflowState(issueId)
    expect(state2!.cycleCount).toBe(5)
    expect(state2!.strategy).toBe('escalate-human')
  })
})

describe('escalate-human blocker creation data', () => {
  const issueId = 'blocker-test-001'
  const issueIdentifier = 'TEST-99'

  it('provides correct data for blocker issue creation at cycle 4', async () => {
    await updateWorkflowState(issueId, { issueIdentifier })

    // Simulate 4 cycles with realistic failures
    const qaFailures = [
      '## QA Failed\n\nUnit tests in packages/core fail with TypeError: Cannot read property of undefined',
      'Failure Reason: Integration test for webhook handler times out after 30s',
      'Issues Found:\n1. Missing mock for Redis in test setup\n2. Race condition in async handler',
      '## QA Failed\n\nTypecheck fails: Property "strategy" does not exist on type "WorkflowState"',
    ]

    for (const msg of qaFailures) {
      await simulatePhaseCompletion(issueId, 'development', 'passed', 1.00)
      await simulatePhaseCompletion(issueId, 'qa', 'failed', 0.50)
      await simulateQAFailure(issueId, msg)
    }

    const state = await getWorkflowState(issueId)
    expect(state).not.toBeNull()
    expect(state!.strategy).toBe('escalate-human')
    expect(state!.cycleCount).toBe(4)

    // Verify the data that would be used to create the blocker issue
    const { cycleCount, failureSummary, phases } = state!

    // Blocker title matches what issue-updated.ts generates
    const blockerTitle = `Human review needed: ${issueIdentifier} failed ${cycleCount} automated cycles`
    expect(blockerTitle).toBe('Human review needed: TEST-99 failed 4 automated cycles')

    // Blocker description includes failure summary
    const blockerDescription = [
      `This issue has failed **${cycleCount} automated dev-QA-rejected cycles** and requires human intervention.`,
      '',
      '### Failure History',
      failureSummary ?? 'No failure details recorded.',
      '',
      '---',
      `*Source issue: ${issueIdentifier}*`,
    ].join('\n')
    expect(blockerDescription).toContain('4 automated dev-QA-rejected cycles')
    expect(blockerDescription).toContain('TypeError: Cannot read property')
    expect(blockerDescription).toContain('Race condition in async handler')
    expect(blockerDescription).toContain('Source issue: TEST-99')

    // Escalation comment includes total cost
    const allPhases = [
      ...phases.development,
      ...phases.qa,
      ...phases.refinement,
      ...phases.acceptance,
    ]
    const totalCost = allPhases.reduce((sum, p) => sum + (p.costUsd ?? 0), 0)
    expect(totalCost).toBeCloseTo(6.00, 2) // 4 × (1.00 + 0.50)
    const costLine = totalCost > 0 ? `\n**Total cost across all attempts:** $${totalCost.toFixed(2)}` : ''
    expect(costLine).toContain('$6.00')

    // Escalation comment content
    const escalationComment =
      `## Circuit Breaker: Human Intervention Required\n\n` +
      `This issue has gone through **${cycleCount} dev-QA-rejected cycles** without passing.\n` +
      `The automated system is stopping further attempts.\n` +
      costLine +
      `\n\n### Failure History\n\n${failureSummary ?? 'No failure details recorded.'}\n\n` +
      `### Recommended Actions\n` +
      `1. Review the failure patterns above\n` +
      `2. Consider if the acceptance criteria need clarification\n` +
      `3. Investigate whether there's an architectural issue\n` +
      `4. Manually fix or decompose the issue before re-enabling automation`

    expect(escalationComment).toContain('4 dev-QA-rejected cycles')
    expect(escalationComment).toContain('$6.00')
    expect(escalationComment).toContain('Cycle 1')
    expect(escalationComment).toContain('Cycle 4')
    expect(escalationComment).toContain('Recommended Actions')
  })

  it('verifies escalation strategy is deterministic and never regresses', async () => {
    await updateWorkflowState(issueId, { issueIdentifier })

    const expectedProgression: Array<{ cycle: number; strategy: EscalationStrategy }> = [
      { cycle: 1, strategy: 'normal' },
      { cycle: 2, strategy: 'context-enriched' },
      { cycle: 3, strategy: 'decompose' },
      { cycle: 4, strategy: 'escalate-human' },
      { cycle: 5, strategy: 'escalate-human' },
      { cycle: 6, strategy: 'escalate-human' },
    ]

    for (const { cycle, strategy } of expectedProgression) {
      const state = await incrementCycleCount(issueId)
      expect(state.cycleCount).toBe(cycle)
      expect(state.strategy).toBe(strategy)
      // Verify computeStrategy matches what's stored
      expect(computeStrategy(state.cycleCount)).toBe(state.strategy)
    }
  })
})
