/**
 * Tests for phase-metrics aggregation service.
 *
 * @see SUP-1653
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// In-memory Redis store for testing
const store = new Map<string, string>()

vi.mock('../redis.js', () => ({
  isRedisConfigured: vi.fn(() => true),
  redisKeys: vi.fn(async (pattern: string) => {
    const prefix = pattern.replace('*', '')
    return Array.from(store.keys()).filter(k => k.startsWith(prefix))
  }),
  redisGet: vi.fn(async (key: string) => {
    const val = store.get(key)
    return val ? JSON.parse(val) : null
  }),
  redisSet: vi.fn(async (key: string, value: unknown) => {
    store.set(key, JSON.stringify(value))
  }),
}))

import { aggregatePhaseMetrics, getAllWorkflowStates } from '../phase-metrics.js'
import type { WorkflowState } from '../agent-tracking.js'

function makeState(overrides: Partial<WorkflowState> & { issueId: string }): WorkflowState {
  return {
    issueIdentifier: overrides.issueIdentifier ?? 'TEST-1',
    cycleCount: overrides.cycleCount ?? 1,
    phases: overrides.phases ?? {
      development: [],
      qa: [],
      refinement: [],
      acceptance: [],
    },
    strategy: overrides.strategy ?? 'normal',
    failureSummary: overrides.failureSummary ?? null,
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt ?? Date.now(),
    ...overrides,
  }
}

function storeWorkflowState(state: WorkflowState) {
  store.set(`workflow:state:${state.issueId}`, JSON.stringify(state))
}

beforeEach(() => {
  store.clear()
})

describe('getAllWorkflowStates', () => {
  it('returns empty array when no states exist', async () => {
    const states = await getAllWorkflowStates()
    expect(states).toEqual([])
  })

  it('returns all states when no time range specified', async () => {
    storeWorkflowState(makeState({ issueId: 'a' }))
    storeWorkflowState(makeState({ issueId: 'b' }))

    const states = await getAllWorkflowStates()
    expect(states).toHaveLength(2)
  })

  it('filters by time range', async () => {
    const now = Date.now()
    storeWorkflowState(makeState({ issueId: 'recent', createdAt: now - 1000 }))
    storeWorkflowState(makeState({ issueId: 'old', createdAt: now - 31 * 24 * 60 * 60 * 1000 }))

    const states7d = await getAllWorkflowStates('7d')
    expect(states7d).toHaveLength(1)
    expect(states7d[0]!.issueId).toBe('recent')

    const states30d = await getAllWorkflowStates('30d')
    expect(states30d).toHaveLength(1)

    const states90d = await getAllWorkflowStates('90d')
    expect(states90d).toHaveLength(2)
  })
})

describe('aggregatePhaseMetrics', () => {
  it('returns zeros for empty dataset', async () => {
    const result = await aggregatePhaseMetrics('30d')

    expect(result.timeRange).toBe('30d')
    expect(result.issueCount).toBe(0)
    expect(result.reworkRate).toBe(0)
    expect(result.phases.development.avgCycleTimeMs).toBe(0)
    expect(result.phases.development.avgCostUsd).toBe(0)
    expect(result.phases.development.avgAttempts).toBe(0)
    expect(result.phases.development.totalRecords).toBe(0)
    expect(result.escalationDistribution.normal).toBe(0)
    expect(result.escalationDistribution['context-enriched']).toBe(0)
    expect(result.escalationDistribution.decompose).toBe(0)
    expect(result.escalationDistribution['escalate-human']).toBe(0)
  })

  it('computes average cycle time from completedAt - startedAt', async () => {
    const now = Date.now()
    storeWorkflowState(makeState({
      issueId: 'a',
      phases: {
        development: [
          { attempt: 1, startedAt: now - 10000, completedAt: now - 5000, result: 'passed', costUsd: 1.0 },
          { attempt: 2, startedAt: now - 4000, completedAt: now - 1000, result: 'passed', costUsd: 2.0 },
        ],
        qa: [],
        refinement: [],
        acceptance: [],
      },
    }))

    const result = await aggregatePhaseMetrics('30d')

    // Record 1: 5000ms, Record 2: 3000ms → average = 4000ms
    expect(result.phases.development.avgCycleTimeMs).toBe(4000)
    expect(result.phases.development.totalRecords).toBe(2)
  })

  it('computes average cost per phase', async () => {
    const now = Date.now()
    storeWorkflowState(makeState({
      issueId: 'a',
      phases: {
        development: [
          { attempt: 1, startedAt: now, costUsd: 1.0 },
          { attempt: 2, startedAt: now, costUsd: 3.0 },
        ],
        qa: [
          { attempt: 1, startedAt: now, costUsd: 0.5 },
        ],
        refinement: [],
        acceptance: [],
      },
    }))

    const result = await aggregatePhaseMetrics('30d')

    expect(result.phases.development.avgCostUsd).toBe(2.0)
    expect(result.phases.qa.avgCostUsd).toBe(0.5)
  })

  it('handles undefined costUsd values', async () => {
    const now = Date.now()
    storeWorkflowState(makeState({
      issueId: 'a',
      phases: {
        development: [
          { attempt: 1, startedAt: now, costUsd: undefined },
          { attempt: 2, startedAt: now, costUsd: 4.0 },
        ],
        qa: [],
        refinement: [],
        acceptance: [],
      },
    }))

    const result = await aggregatePhaseMetrics('30d')

    // (0 + 4.0) / 2 = 2.0
    expect(result.phases.development.avgCostUsd).toBe(2.0)
  })

  it('computes average attempts per issue per phase', async () => {
    const now = Date.now()
    storeWorkflowState(makeState({
      issueId: 'a',
      phases: {
        development: [
          { attempt: 1, startedAt: now },
          { attempt: 2, startedAt: now },
        ],
        qa: [{ attempt: 1, startedAt: now }],
        refinement: [],
        acceptance: [],
      },
    }))
    storeWorkflowState(makeState({
      issueId: 'b',
      phases: {
        development: [
          { attempt: 1, startedAt: now },
          { attempt: 2, startedAt: now },
          { attempt: 3, startedAt: now },
          { attempt: 4, startedAt: now },
        ],
        qa: [{ attempt: 1, startedAt: now }],
        refinement: [],
        acceptance: [],
      },
    }))

    const result = await aggregatePhaseMetrics('30d')

    // Issue a: 2 dev records, issue b: 4 dev records → 6 total / 2 issues = 3.0
    expect(result.phases.development.avgAttempts).toBe(3)
    // Issue a: 1 qa record, issue b: 1 qa record → 2 total / 2 issues = 1.0
    expect(result.phases.qa.avgAttempts).toBe(1)
  })

  it('computes rework rate (QA rejection ratio)', async () => {
    const now = Date.now()
    storeWorkflowState(makeState({
      issueId: 'a',
      phases: {
        development: [],
        qa: [
          { attempt: 1, startedAt: now, result: 'failed' },
          { attempt: 2, startedAt: now, result: 'failed' },
          { attempt: 3, startedAt: now, result: 'passed' },
        ],
        refinement: [],
        acceptance: [],
      },
    }))

    const result = await aggregatePhaseMetrics('30d')

    // 2 failures out of 3 QA records
    expect(result.reworkRate).toBeCloseTo(2 / 3, 4)
  })

  it('returns 0 rework rate when no QA records', async () => {
    storeWorkflowState(makeState({
      issueId: 'a',
      phases: {
        development: [{ attempt: 1, startedAt: Date.now() }],
        qa: [],
        refinement: [],
        acceptance: [],
      },
    }))

    const result = await aggregatePhaseMetrics('30d')
    expect(result.reworkRate).toBe(0)
  })

  it('computes escalation strategy distribution', async () => {
    storeWorkflowState(makeState({ issueId: 'a', strategy: 'normal' }))
    storeWorkflowState(makeState({ issueId: 'b', strategy: 'normal' }))
    storeWorkflowState(makeState({ issueId: 'c', strategy: 'context-enriched' }))
    storeWorkflowState(makeState({ issueId: 'd', strategy: 'escalate-human' }))

    const result = await aggregatePhaseMetrics('30d')

    expect(result.escalationDistribution.normal).toBe(2)
    expect(result.escalationDistribution['context-enriched']).toBe(1)
    expect(result.escalationDistribution.decompose).toBe(0)
    expect(result.escalationDistribution['escalate-human']).toBe(1)
    expect(result.issueCount).toBe(4)
  })

  it('uses 30d default time range', async () => {
    const result = await aggregatePhaseMetrics()
    expect(result.timeRange).toBe('30d')
  })

  it('supports all three time ranges', async () => {
    for (const tr of ['7d', '30d', '90d'] as const) {
      const result = await aggregatePhaseMetrics(tr)
      expect(result.timeRange).toBe(tr)
    }
  })

  it('handles single issue with all phases', async () => {
    const now = Date.now()
    storeWorkflowState(makeState({
      issueId: 'a',
      strategy: 'decompose',
      cycleCount: 3,
      phases: {
        development: [
          { attempt: 1, startedAt: now - 60000, completedAt: now - 50000, result: 'passed', costUsd: 1.0 },
          { attempt: 2, startedAt: now - 40000, completedAt: now - 30000, result: 'passed', costUsd: 1.5 },
          { attempt: 3, startedAt: now - 20000, completedAt: now - 10000, result: 'passed', costUsd: 2.0 },
        ],
        qa: [
          { attempt: 1, startedAt: now - 49000, completedAt: now - 41000, result: 'failed', costUsd: 0.5 },
          { attempt: 2, startedAt: now - 29000, completedAt: now - 21000, result: 'failed', costUsd: 0.5 },
          { attempt: 3, startedAt: now - 9000, completedAt: now - 1000, result: 'passed', costUsd: 0.75 },
        ],
        refinement: [
          { attempt: 1, startedAt: now - 48000, completedAt: now - 42000, result: 'passed', costUsd: 0.3 },
          { attempt: 2, startedAt: now - 28000, completedAt: now - 22000, result: 'passed', costUsd: 0.3 },
        ],
        acceptance: [
          { attempt: 1, startedAt: now - 500, completedAt: now, result: 'passed', costUsd: 0.2 },
        ],
      },
    }))

    const result = await aggregatePhaseMetrics('30d')

    expect(result.issueCount).toBe(1)
    expect(result.phases.development.totalRecords).toBe(3)
    expect(result.phases.qa.totalRecords).toBe(3)
    expect(result.phases.refinement.totalRecords).toBe(2)
    expect(result.phases.acceptance.totalRecords).toBe(1)
    expect(result.phases.development.avgAttempts).toBe(3)
    expect(result.escalationDistribution.decompose).toBe(1)
    // 2 QA failures out of 3 → ~0.6667
    expect(result.reworkRate).toBeCloseTo(2 / 3, 4)
  })

  it('handles records without completedAt for cycle time', async () => {
    const now = Date.now()
    storeWorkflowState(makeState({
      issueId: 'a',
      phases: {
        development: [
          { attempt: 1, startedAt: now - 10000, completedAt: now - 5000, result: 'passed' },
          { attempt: 2, startedAt: now }, // in-progress, no completedAt
        ],
        qa: [],
        refinement: [],
        acceptance: [],
      },
    }))

    const result = await aggregatePhaseMetrics('30d')

    // Only the completed record contributes to cycle time
    expect(result.phases.development.avgCycleTimeMs).toBe(5000)
    // But both count toward total records
    expect(result.phases.development.totalRecords).toBe(2)
  })
})

describe('aggregatePhaseMetrics with redis not configured', () => {
  it('returns zeros when redis is not configured', async () => {
    const { isRedisConfigured } = await import('../redis.js')
    vi.mocked(isRedisConfigured).mockReturnValueOnce(false)

    const result = await aggregatePhaseMetrics('30d')

    expect(result.issueCount).toBe(0)
    expect(result.reworkRate).toBe(0)
  })
})
