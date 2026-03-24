import { describe, it, expect } from 'vitest'
import {
  schedule,
  classifyFilterFailures,
  type ScheduleRequest,
  type ScheduleResult,
} from '../scheduler/orchestrator.js'
import {
  CapacityFilter as RealCapacityFilter,
  StatusFilter as RealStatusFilter,
  runFilters,
  type SchedulerFilter,
  type FilterResult,
} from '../scheduler/filters.js'
import {
  createDefaultScorers,
  runScorers,
  type SchedulerScorer,
  type ScoringContext,
  type ScoreResult,
} from '../scheduler/scorers.js'
import type { WorkerInfo } from '../worker-storage.js'
import type { QueuedWork } from '../work-queue.js'

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeWorker(overrides: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    id: 'wkr_default',
    hostname: 'test-host',
    capacity: 3,
    activeCount: 0,
    registeredAt: Date.now() - 60_000,
    lastHeartbeat: Date.now(),
    status: 'active',
    activeSessions: [],
    ...overrides,
  }
}

function makeWork(overrides: Partial<QueuedWork> = {}): QueuedWork {
  return {
    sessionId: 'sess-1',
    issueId: 'issue-1',
    issueIdentifier: 'ENG-100',
    priority: 3,
    queuedAt: Date.now(),
    projectName: 'my-project',
    ...overrides,
  }
}

function makeContext(overrides: Partial<ScoringContext> = {}): ScoringContext {
  return {
    allWorkers: [],
    activeSessionsByProject: new Map(),
    workerHistory: new Map(),
    workerCosts: new Map(),
    ...overrides,
  }
}

/**
 * Simple pass-all filter for tests that just want to exercise scoring.
 */
const passAllFilter: SchedulerFilter = {
  name: 'PassAll',
  filter: () => ({ pass: true }),
}

/**
 * Simple equal-weight scorers that sum to 1.0 for deterministic tests.
 */
function makeSimpleScorer(
  name: string,
  weight: number,
  scoreFn: (work: QueuedWork, worker: WorkerInfo) => number,
): SchedulerScorer {
  return {
    name,
    weight,
    score(work: QueuedWork, worker: WorkerInfo, _ctx: ScoringContext): ScoreResult {
      return { score: scoreFn(work, worker), reason: `${name} score` }
    },
  }
}

// ---------------------------------------------------------------------------
// End-to-end scheduling
// ---------------------------------------------------------------------------

describe('schedule — end-to-end', () => {
  it('assigns a single work item to the best worker', () => {
    const workerA = makeWorker({ id: 'wkr_a', activeCount: 2, capacity: 3 })
    const workerB = makeWorker({ id: 'wkr_b', activeCount: 0, capacity: 3 })

    const work = makeWork({ sessionId: 'sess-1' })

    const scorer = makeSimpleScorer('load', 1.0, (_w, worker) => {
      // Lower activeCount -> higher score
      return 100 - (worker.activeCount / worker.capacity) * 100
    })

    const result = schedule({
      workItems: [work],
      workers: [workerA, workerB],
      filters: [passAllFilter],
      scorers: [scorer],
      context: makeContext({ allWorkers: [workerA, workerB] }),
    })

    expect(result.assignments).toHaveLength(1)
    expect(result.unschedulable).toHaveLength(0)
    expect(result.assignments[0].worker.id).toBe('wkr_b')
    expect(result.assignments[0].work.sessionId).toBe('sess-1')
    expect(result.assignments[0].score).toBeGreaterThan(0)
  })

  it('assigns multiple work items to multiple workers', () => {
    const workerA = makeWorker({ id: 'wkr_a', activeCount: 0, capacity: 2 })
    const workerB = makeWorker({ id: 'wkr_b', activeCount: 0, capacity: 2 })

    const work1 = makeWork({ sessionId: 'sess-1', priority: 1 })
    const work2 = makeWork({ sessionId: 'sess-2', priority: 2 })

    // Score based on remaining capacity — worker with more free capacity wins
    const scorer = makeSimpleScorer('capacity', 1.0, (_w, worker) => {
      return Math.round(100 * (1 - worker.activeCount / worker.capacity))
    })

    const result = schedule({
      workItems: [work1, work2],
      workers: [workerA, workerB],
      filters: [passAllFilter],
      scorers: [scorer],
      context: makeContext({ allWorkers: [workerA, workerB] }),
    })

    expect(result.assignments).toHaveLength(2)
    expect(result.unschedulable).toHaveLength(0)

    // Both should be assigned (potentially to different workers due to capacity tracking)
    const assignedWorkerIds = result.assignments.map(a => a.worker.id)
    expect(assignedWorkerIds).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Multiple work items, multiple workers
// ---------------------------------------------------------------------------

describe('schedule — multi-item multi-worker', () => {
  it('spreads work across workers as capacity is consumed', () => {
    // Each worker has capacity for exactly 1 more item
    const workerA = makeWorker({ id: 'wkr_a', activeCount: 2, capacity: 3 })
    const workerB = makeWorker({ id: 'wkr_b', activeCount: 2, capacity: 3 })

    const work1 = makeWork({ sessionId: 'sess-1' })
    const work2 = makeWork({ sessionId: 'sess-2' })

    // Prefer lower load
    const scorer = makeSimpleScorer('load', 1.0, (_w, worker) => {
      return Math.round(100 * (1 - worker.activeCount / worker.capacity))
    })

    const result = schedule({
      workItems: [work1, work2],
      workers: [workerA, workerB],
      filters: [passAllFilter],
      scorers: [scorer],
      context: makeContext({ allWorkers: [workerA, workerB] }),
    })

    expect(result.assignments).toHaveLength(2)
    // Each worker should get one assignment since each only has room for 1
    const workerIds = result.assignments.map(a => a.worker.id)
    expect(workerIds.sort()).toEqual(['wkr_a', 'wkr_b'])
  })

  it('fills one worker before moving to the next when it has more capacity', () => {
    const workerA = makeWorker({ id: 'wkr_a', activeCount: 0, capacity: 3 })
    const workerB = makeWorker({ id: 'wkr_b', activeCount: 2, capacity: 3 })

    const work1 = makeWork({ sessionId: 'sess-1' })
    const work2 = makeWork({ sessionId: 'sess-2' })

    // Prefer lower load
    const scorer = makeSimpleScorer('load', 1.0, (_w, worker) => {
      return Math.round(100 * (1 - worker.activeCount / worker.capacity))
    })

    const result = schedule({
      workItems: [work1, work2],
      workers: [workerA, workerB],
      filters: [passAllFilter],
      scorers: [scorer],
      context: makeContext({ allWorkers: [workerA, workerB] }),
    })

    expect(result.assignments).toHaveLength(2)
    // Work 1 should go to workerA (0/3 = most free)
    expect(result.assignments[0].worker.id).toBe('wkr_a')
    // Work 2 should also go to workerA (now 1/3 still more free than workerB 2/3)
    expect(result.assignments[1].worker.id).toBe('wkr_a')
  })
})

// ---------------------------------------------------------------------------
// Unschedulable work — backoff vs suspend
// ---------------------------------------------------------------------------

describe('schedule — unschedulable work routing', () => {
  it('marks work as backoff when failure is transient (capacity)', () => {
    // Worker exists but is at capacity
    const worker = makeWorker({ id: 'wkr_full', activeCount: 3, capacity: 3, status: 'active' })
    const work = makeWork({ sessionId: 'sess-stuck' })

    // Use a filter that rejects due to capacity
    const capacityFilter: SchedulerFilter = {
      name: 'CapacityFilter',
      filter: (_work, w) => {
        if (w.activeCount >= w.capacity) {
          return { pass: false, reason: 'worker at capacity (3/3)' }
        }
        return { pass: true }
      },
    }

    const scorer = makeSimpleScorer('dummy', 1.0, () => 50)

    const result = schedule({
      workItems: [work],
      workers: [worker],
      filters: [capacityFilter],
      scorers: [scorer],
      context: makeContext({ allWorkers: [worker] }),
    })

    expect(result.assignments).toHaveLength(0)
    expect(result.unschedulable).toHaveLength(1)
    expect(result.unschedulable[0].action).toBe('backoff')
    expect(result.unschedulable[0].work.sessionId).toBe('sess-stuck')
  })

  it('marks work as suspend when failure is permanent (project mismatch)', () => {
    const worker = makeWorker({ id: 'wkr_proj', projects: ['alpha'] })
    const work = makeWork({ sessionId: 'sess-wrong', projectName: 'beta' })

    const projectFilter: SchedulerFilter = {
      name: 'ProjectFilter',
      filter: (w, worker) => {
        const projects = worker.projects
        if (projects && projects.length > 0 && w.projectName && !projects.includes(w.projectName)) {
          return { pass: false, reason: `project ${w.projectName} not in worker's project list` }
        }
        return { pass: true }
      },
    }

    const scorer = makeSimpleScorer('dummy', 1.0, () => 50)

    const result = schedule({
      workItems: [work],
      workers: [worker],
      filters: [projectFilter],
      scorers: [scorer],
      context: makeContext({ allWorkers: [worker] }),
    })

    expect(result.assignments).toHaveLength(0)
    expect(result.unschedulable).toHaveLength(1)
    expect(result.unschedulable[0].action).toBe('suspend')
  })

  it('prefers backoff when mix of transient and permanent reasons across workers', () => {
    // Worker 1: rejected by capacity (transient)
    // Worker 2: rejected by project (permanent)
    const worker1 = makeWorker({ id: 'wkr_1', activeCount: 3, capacity: 3 })
    const worker2 = makeWorker({ id: 'wkr_2', projects: ['alpha'] })
    const work = makeWork({ sessionId: 'sess-mix', projectName: 'beta' })

    const filters: SchedulerFilter[] = [
      {
        name: 'CapacityFilter',
        filter: (_w, worker) => {
          if (worker.activeCount >= worker.capacity) {
            return { pass: false, reason: 'worker at capacity (3/3)' }
          }
          return { pass: true }
        },
      },
      {
        name: 'ProjectFilter',
        filter: (w, worker) => {
          const projects = worker.projects
          if (projects && projects.length > 0 && w.projectName && !projects.includes(w.projectName)) {
            return { pass: false, reason: `project ${w.projectName} not in worker's project list` }
          }
          return { pass: true }
        },
      },
    ]

    const scorer = makeSimpleScorer('dummy', 1.0, () => 50)

    const result = schedule({
      workItems: [work],
      workers: [worker1, worker2],
      filters,
      scorers: [scorer],
      context: makeContext({ allWorkers: [worker1, worker2] }),
    })

    expect(result.assignments).toHaveLength(0)
    expect(result.unschedulable).toHaveLength(1)
    // Worker 1 was rejected only by capacity (transient), so should be backoff
    expect(result.unschedulable[0].action).toBe('backoff')
  })
})

// ---------------------------------------------------------------------------
// Worker capacity decrements across iterations
// ---------------------------------------------------------------------------

describe('schedule — capacity tracking', () => {
  it('decrements capacity after each assignment', () => {
    // Worker has capacity for 2 items
    const worker = makeWorker({ id: 'wkr_a', activeCount: 1, capacity: 3 })

    const work1 = makeWork({ sessionId: 'sess-1' })
    const work2 = makeWork({ sessionId: 'sess-2' })
    const work3 = makeWork({ sessionId: 'sess-3' })

    // Use actual capacity filter to verify capacity is tracked
    const capacityFilter: SchedulerFilter = {
      name: 'CapacityFilter',
      filter: (_w, w) => {
        if (w.activeCount >= w.capacity) {
          return { pass: false, reason: `worker at capacity (${w.activeCount}/${w.capacity})` }
        }
        return { pass: true }
      },
    }

    const scorer = makeSimpleScorer('simple', 1.0, () => 50)

    const result = schedule({
      workItems: [work1, work2, work3],
      workers: [worker],
      filters: [capacityFilter],
      scorers: [scorer],
      context: makeContext({ allWorkers: [worker] }),
    })

    // Worker starts at 1/3, so can take 2 more items
    expect(result.assignments).toHaveLength(2)
    expect(result.unschedulable).toHaveLength(1)
    expect(result.unschedulable[0].work.sessionId).toBe('sess-3')
    expect(result.unschedulable[0].action).toBe('backoff') // capacity is transient
  })

  it('tracks capacity across multiple workers correctly', () => {
    const workerA = makeWorker({ id: 'wkr_a', activeCount: 0, capacity: 1 })
    const workerB = makeWorker({ id: 'wkr_b', activeCount: 0, capacity: 1 })

    const work1 = makeWork({ sessionId: 'sess-1' })
    const work2 = makeWork({ sessionId: 'sess-2' })
    const work3 = makeWork({ sessionId: 'sess-3' })

    const capacityFilter: SchedulerFilter = {
      name: 'CapacityFilter',
      filter: (_w, w) => {
        if (w.activeCount >= w.capacity) {
          return { pass: false, reason: `worker at capacity (${w.activeCount}/${w.capacity})` }
        }
        return { pass: true }
      },
    }

    const scorer = makeSimpleScorer('simple', 1.0, () => 50)

    const result = schedule({
      workItems: [work1, work2, work3],
      workers: [workerA, workerB],
      filters: [capacityFilter],
      scorers: [scorer],
      context: makeContext({ allWorkers: [workerA, workerB] }),
    })

    // Each worker can take 1 item, so 2 assigned, 1 unschedulable
    expect(result.assignments).toHaveLength(2)
    expect(result.unschedulable).toHaveLength(1)
    expect(result.unschedulable[0].work.sessionId).toBe('sess-3')
  })
})

// ---------------------------------------------------------------------------
// Empty cases
// ---------------------------------------------------------------------------

describe('schedule — empty cases', () => {
  it('returns empty results when no work items', () => {
    const worker = makeWorker({ id: 'wkr_a' })
    const scorer = makeSimpleScorer('dummy', 1.0, () => 50)

    const result = schedule({
      workItems: [],
      workers: [worker],
      filters: [passAllFilter],
      scorers: [scorer],
      context: makeContext({ allWorkers: [worker] }),
    })

    expect(result.assignments).toHaveLength(0)
    expect(result.unschedulable).toHaveLength(0)
    expect(result.decisions).toHaveLength(0)
  })

  it('returns no_workers decision when no workers are available', () => {
    const work = makeWork({ sessionId: 'sess-lonely' })
    const scorer = makeSimpleScorer('dummy', 1.0, () => 50)

    const result = schedule({
      workItems: [work],
      workers: [],
      filters: [passAllFilter],
      scorers: [scorer],
      context: makeContext(),
    })

    expect(result.assignments).toHaveLength(0)
    expect(result.unschedulable).toHaveLength(0)
    expect(result.decisions).toHaveLength(1)
    expect(result.decisions[0].outcome).toBe('no_workers')
    expect(result.decisions[0].workSessionId).toBe('sess-lonely')
    expect(result.decisions[0].totalWorkers).toBe(0)
  })

  it('handles all workers filtered out', () => {
    const worker = makeWorker({ id: 'wkr_a', status: 'draining' })
    const work = makeWork({ sessionId: 'sess-1' })

    const statusFilter: SchedulerFilter = {
      name: 'StatusFilter',
      filter: (_w, worker) => {
        if (worker.status !== 'active') {
          return { pass: false, reason: `worker status is ${worker.status}` }
        }
        return { pass: true }
      },
    }

    const scorer = makeSimpleScorer('dummy', 1.0, () => 50)

    const result = schedule({
      workItems: [work],
      workers: [worker],
      filters: [statusFilter],
      scorers: [scorer],
      context: makeContext({ allWorkers: [worker] }),
    })

    expect(result.assignments).toHaveLength(0)
    expect(result.unschedulable).toHaveLength(1)
    expect(result.unschedulable[0].action).toBe('suspend') // status is permanent
  })
})

// ---------------------------------------------------------------------------
// Decision records
// ---------------------------------------------------------------------------

describe('schedule — decision records', () => {
  it('creates a decision record for each work item', () => {
    const worker = makeWorker({ id: 'wkr_a', capacity: 5 })
    const work1 = makeWork({ sessionId: 'sess-1' })
    const work2 = makeWork({ sessionId: 'sess-2' })
    const work3 = makeWork({ sessionId: 'sess-3' })

    const scorer = makeSimpleScorer('simple', 1.0, () => 50)

    const result = schedule({
      workItems: [work1, work2, work3],
      workers: [worker],
      filters: [passAllFilter],
      scorers: [scorer],
      context: makeContext({ allWorkers: [worker] }),
    })

    expect(result.decisions).toHaveLength(3)
    expect(result.decisions.map(d => d.workSessionId)).toEqual([
      'sess-1',
      'sess-2',
      'sess-3',
    ])
  })

  it('records assigned outcome with worker ID and score', () => {
    const worker = makeWorker({ id: 'wkr_assigned' })
    const work = makeWork({ sessionId: 'sess-1' })

    const scorer = makeSimpleScorer('test', 1.0, () => 75)

    const result = schedule({
      workItems: [work],
      workers: [worker],
      filters: [passAllFilter],
      scorers: [scorer],
      context: makeContext({ allWorkers: [worker] }),
    })

    const decision = result.decisions[0]
    expect(decision.outcome).toBe('assigned')
    expect(decision.assignedWorkerId).toBe('wkr_assigned')
    expect(decision.assignedScore).toBe(75)
    expect(decision.totalWorkers).toBe(1)
    expect(decision.feasibleWorkers).toBe(1)
    expect(decision.filterDurationMs).toBeGreaterThanOrEqual(0)
    expect(decision.scoreDurationMs).toBeGreaterThanOrEqual(0)
    expect(decision.totalDurationMs).toBeGreaterThanOrEqual(0)
  })

  it('records backoff outcome for transient filter failures', () => {
    const worker = makeWorker({ id: 'wkr_full', activeCount: 3, capacity: 3 })
    const work = makeWork({ sessionId: 'sess-stuck' })

    const capacityFilter: SchedulerFilter = {
      name: 'CapacityFilter',
      filter: (_w, w) => {
        if (w.activeCount >= w.capacity) {
          return { pass: false, reason: 'worker at capacity (3/3)' }
        }
        return { pass: true }
      },
    }

    const scorer = makeSimpleScorer('dummy', 1.0, () => 50)

    const result = schedule({
      workItems: [work],
      workers: [worker],
      filters: [capacityFilter],
      scorers: [scorer],
      context: makeContext({ allWorkers: [worker] }),
    })

    const decision = result.decisions[0]
    expect(decision.outcome).toBe('backoff')
    expect(decision.assignedWorkerId).toBeUndefined()
    expect(decision.totalWorkers).toBe(1)
    expect(decision.feasibleWorkers).toBe(0)
  })

  it('records suspended outcome for permanent filter failures', () => {
    const worker = makeWorker({ id: 'wkr_draining', status: 'draining' })
    const work = makeWork({ sessionId: 'sess-1' })

    const statusFilter: SchedulerFilter = {
      name: 'StatusFilter',
      filter: (_w, worker) => {
        if (worker.status !== 'active') {
          return { pass: false, reason: `worker status is ${worker.status}` }
        }
        return { pass: true }
      },
    }

    const scorer = makeSimpleScorer('dummy', 1.0, () => 50)

    const result = schedule({
      workItems: [work],
      workers: [worker],
      filters: [statusFilter],
      scorers: [scorer],
      context: makeContext({ allWorkers: [worker] }),
    })

    const decision = result.decisions[0]
    expect(decision.outcome).toBe('suspended')
  })

  it('records no_workers outcome when worker list is empty', () => {
    const work = makeWork({ sessionId: 'sess-1' })
    const scorer = makeSimpleScorer('dummy', 1.0, () => 50)

    const result = schedule({
      workItems: [work],
      workers: [],
      filters: [passAllFilter],
      scorers: [scorer],
      context: makeContext(),
    })

    const decision = result.decisions[0]
    expect(decision.outcome).toBe('no_workers')
    expect(decision.totalWorkers).toBe(0)
    expect(decision.feasibleWorkers).toBe(0)
    expect(decision.scoreDurationMs).toBe(0)
  })

  it('includes timing durations in decision records', () => {
    const worker = makeWorker({ id: 'wkr_a' })
    const work = makeWork({ sessionId: 'sess-1' })
    const scorer = makeSimpleScorer('test', 1.0, () => 50)

    const result = schedule({
      workItems: [work],
      workers: [worker],
      filters: [passAllFilter],
      scorers: [scorer],
      context: makeContext({ allWorkers: [worker] }),
    })

    const decision = result.decisions[0]
    expect(typeof decision.filterDurationMs).toBe('number')
    expect(typeof decision.scoreDurationMs).toBe('number')
    expect(typeof decision.totalDurationMs).toBe('number')
    expect(decision.totalDurationMs).toBeGreaterThanOrEqual(
      decision.filterDurationMs + decision.scoreDurationMs - 1, // allow 1ms tolerance
    )
  })
})

// ---------------------------------------------------------------------------
// classifyFilterFailures
// ---------------------------------------------------------------------------

describe('classifyFilterFailures', () => {
  const dummyFilters: SchedulerFilter[] = [
    { name: 'CapacityFilter', filter: () => ({ pass: true }) },
    { name: 'StatusFilter', filter: () => ({ pass: true }) },
    { name: 'ProjectFilter', filter: () => ({ pass: true }) },
  ]

  it('returns backoff when any worker was rejected only by transient reasons', () => {
    const filtered = new Map<string, string[]>([
      ['wkr_1', ['worker at capacity (3/3)']],
      ['wkr_2', ['worker status is draining']],
    ])

    const result = classifyFilterFailures(filtered, dummyFilters)
    expect(result).toBe('backoff')
  })

  it('returns suspend when all workers have at least one permanent reason', () => {
    const filtered = new Map<string, string[]>([
      ['wkr_1', ['worker status is draining']],
      ['wkr_2', ["project beta not in worker's project list"]],
    ])

    const result = classifyFilterFailures(filtered, dummyFilters)
    expect(result).toBe('suspend')
  })

  it('returns backoff when quota rejection is the only reason', () => {
    const filtered = new Map<string, string[]>([
      ['wkr_1', ['quota low for org org_123']],
    ])

    const result = classifyFilterFailures(filtered, dummyFilters)
    expect(result).toBe('backoff')
  })

  it('returns suspend when worker has both transient and permanent reasons', () => {
    // A single worker rejected by both capacity (transient) and project (permanent)
    // is NOT "all transient" for that worker, so if it's the only worker, it's suspend
    const filtered = new Map<string, string[]>([
      ['wkr_1', ['worker at capacity (3/3)', "project beta not in worker's project list"]],
    ])

    const result = classifyFilterFailures(filtered, dummyFilters)
    expect(result).toBe('suspend')
  })

  it('returns backoff if one worker is transient-only, another has permanent', () => {
    const filtered = new Map<string, string[]>([
      ['wkr_1', ['worker at capacity (5/5)']],       // transient only
      ['wkr_2', ['worker status is offline']],         // permanent
    ])

    const result = classifyFilterFailures(filtered, dummyFilters)
    expect(result).toBe('backoff')
  })
})

// ---------------------------------------------------------------------------
// Integration with real filters and scorers
// ---------------------------------------------------------------------------

describe('schedule — with real filter and scorer implementations', () => {
  it('uses imported runFilters and runScorers correctly', () => {
    const now = Date.now()
    const workerA = makeWorker({
      id: 'wkr_a',
      capacity: 4,
      activeCount: 0,
      lastHeartbeat: now,
      activeSessions: [],
      status: 'active',
    })
    const workerB = makeWorker({
      id: 'wkr_b',
      capacity: 4,
      activeCount: 3,
      lastHeartbeat: now,
      activeSessions: ['s1', 's2', 's3'],
      status: 'active',
    })
    const workerC = makeWorker({
      id: 'wkr_c',
      capacity: 2,
      activeCount: 2,
      lastHeartbeat: now,
      activeSessions: ['s4', 's5'],
      status: 'active',
    })

    const work = makeWork({ sessionId: 'sess-real', projectName: undefined })
    const scorers = createDefaultScorers()

    const result = schedule({
      workItems: [work],
      workers: [workerA, workerB, workerC],
      filters: [RealStatusFilter, RealCapacityFilter],
      scorers,
      context: makeContext({
        allWorkers: [workerA, workerB, workerC],
      }),
    })

    // Worker C is at capacity (2/2) so should be filtered out
    // Worker A (0/4) should score higher than Worker B (3/4)
    expect(result.assignments).toHaveLength(1)
    expect(result.assignments[0].worker.id).toBe('wkr_a')
    expect(result.decisions[0].outcome).toBe('assigned')
    expect(result.decisions[0].feasibleWorkers).toBe(2) // A and B pass, C filtered
  })
})
