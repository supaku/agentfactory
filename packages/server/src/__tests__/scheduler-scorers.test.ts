import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { QueuedWork } from '../work-queue.js'
import type { WorkerInfo } from '../worker-storage.js'
import {
  AffinityScorer,
  LoadBalanceScorer,
  FairnessScorer,
  CostScorer,
  RecencyScorer,
  createDefaultScorers,
  runScorers,
  type ScoringContext,
  type WorkerHistory,
  type WorkerCostInfo,
  type SchedulerScorer,
} from '../scheduler/scorers.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkerData(overrides: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    id: 'wkr_test001',
    hostname: 'worker-1',
    capacity: 4,
    activeCount: 1,
    registeredAt: Date.now() - 60_000,
    lastHeartbeat: Date.now(),
    status: 'active',
    activeSessions: ['session-1'],
    ...overrides,
  }
}

function makeQueuedWork(overrides: Partial<QueuedWork> = {}): QueuedWork {
  return {
    sessionId: 'sess_test001',
    issueId: 'issue_abc',
    issueIdentifier: 'SUP-100',
    priority: 2,
    queuedAt: Date.now(),
    projectName: 'TestProject',
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

// ---------------------------------------------------------------------------
// AffinityScorer
// ---------------------------------------------------------------------------

describe('AffinityScorer', () => {
  const scorer = new AffinityScorer()

  it('returns 100 when the worker ran the previous phase', () => {
    const worker = makeWorkerData({ id: 'wkr_aaa' })
    const work = makeQueuedWork({ issueId: 'issue_1' })
    const ctx = makeContext({
      workerHistory: new Map<string, WorkerHistory>([
        ['issue_1', { lastWorkerId: 'wkr_aaa', lastWorkType: 'development' }],
      ]),
    })

    const result = scorer.score(work, worker, ctx)
    expect(result.score).toBe(100)
    expect(result.reason).toContain('Same worker')
  })

  it('returns 0 when a different worker ran the previous phase', () => {
    const worker = makeWorkerData({ id: 'wkr_bbb' })
    const work = makeQueuedWork({ issueId: 'issue_1' })
    const ctx = makeContext({
      workerHistory: new Map<string, WorkerHistory>([
        ['issue_1', { lastWorkerId: 'wkr_aaa', lastWorkType: 'development' }],
      ]),
    })

    const result = scorer.score(work, worker, ctx)
    expect(result.score).toBe(0)
    expect(result.reason).toContain('Different worker')
  })

  it('returns 50 (neutral) when no affinity history exists', () => {
    const worker = makeWorkerData()
    const work = makeQueuedWork({ issueId: 'issue_no_history' })
    const ctx = makeContext()

    const result = scorer.score(work, worker, ctx)
    expect(result.score).toBe(50)
    expect(result.reason).toContain('No affinity history')
  })

  it('has correct name and weight', () => {
    expect(scorer.name).toBe('affinity')
    expect(scorer.weight).toBe(0.30)
  })
})

// ---------------------------------------------------------------------------
// LoadBalanceScorer
// ---------------------------------------------------------------------------

describe('LoadBalanceScorer', () => {
  const scorer = new LoadBalanceScorer()

  it('returns 100 when worker has no active sessions', () => {
    const worker = makeWorkerData({ activeCount: 0, capacity: 4 })
    const result = scorer.score(makeQueuedWork(), worker, makeContext())
    expect(result.score).toBe(100)
  })

  it('returns 0 when worker is at full capacity', () => {
    const worker = makeWorkerData({ activeCount: 4, capacity: 4 })
    const result = scorer.score(makeQueuedWork(), worker, makeContext())
    expect(result.score).toBe(0)
  })

  it('returns 50 when worker is at half capacity', () => {
    const worker = makeWorkerData({ activeCount: 2, capacity: 4 })
    const result = scorer.score(makeQueuedWork(), worker, makeContext())
    expect(result.score).toBe(50)
  })

  it('returns 0 when worker has zero capacity', () => {
    const worker = makeWorkerData({ activeCount: 0, capacity: 0 })
    const result = scorer.score(makeQueuedWork(), worker, makeContext())
    expect(result.score).toBe(0)
    expect(result.reason).toContain('zero capacity')
  })

  it('has correct name and weight', () => {
    expect(scorer.name).toBe('load-balance')
    expect(scorer.weight).toBe(0.25)
  })
})

// ---------------------------------------------------------------------------
// FairnessScorer
// ---------------------------------------------------------------------------

describe('FairnessScorer', () => {
  const scorer = new FairnessScorer()

  it('returns 100 when no workers have active sessions', () => {
    const worker = makeWorkerData({ id: 'wkr_a', activeSessions: [] })
    const ctx = makeContext({
      allWorkers: [
        worker,
        makeWorkerData({ id: 'wkr_b', activeSessions: [] }),
      ],
    })
    const result = scorer.score(makeQueuedWork(), worker, ctx)
    expect(result.score).toBe(100)
  })

  it('scores worker with fewer sessions higher', () => {
    const workerA = makeWorkerData({ id: 'wkr_a', activeSessions: ['s1'] })
    const workerB = makeWorkerData({ id: 'wkr_b', activeSessions: ['s2', 's3', 's4'] })
    const ctx = makeContext({
      allWorkers: [workerA, workerB],
    })

    const resultA = scorer.score(makeQueuedWork(), workerA, ctx)
    const resultB = scorer.score(makeQueuedWork(), workerB, ctx)
    expect(resultA.score).toBeGreaterThan(resultB.score)
  })

  it('scores the most loaded worker as 0', () => {
    const workerA = makeWorkerData({ id: 'wkr_a', activeSessions: ['s1', 's2', 's3'] })
    const workerB = makeWorkerData({ id: 'wkr_b', activeSessions: [] })
    const ctx = makeContext({
      allWorkers: [workerA, workerB],
    })

    const result = scorer.score(makeQueuedWork(), workerA, ctx)
    expect(result.score).toBe(0)
  })

  it('has correct name and weight', () => {
    expect(scorer.name).toBe('fairness')
    expect(scorer.weight).toBe(0.20)
  })
})

// ---------------------------------------------------------------------------
// CostScorer
// ---------------------------------------------------------------------------

describe('CostScorer', () => {
  const scorer = new CostScorer()

  it('returns 50 (neutral) when no cost history exists for worker', () => {
    const worker = makeWorkerData({ id: 'wkr_nocost' })
    const ctx = makeContext()

    const result = scorer.score(makeQueuedWork(), worker, ctx)
    expect(result.score).toBe(50)
    expect(result.reason).toContain('No cost history')
  })

  it('returns 100 for the cheapest worker', () => {
    const cheapWorker = makeWorkerData({ id: 'wkr_cheap' })
    const ctx = makeContext({
      workerCosts: new Map<string, WorkerCostInfo>([
        ['wkr_cheap', { averageCostUsd: 0.10, sessionCount: 5 }],
        ['wkr_mid', { averageCostUsd: 0.50, sessionCount: 5 }],
        ['wkr_expensive', { averageCostUsd: 1.00, sessionCount: 5 }],
      ]),
    })

    const result = scorer.score(makeQueuedWork(), cheapWorker, ctx)
    expect(result.score).toBe(100)
  })

  it('returns 0 for the most expensive worker', () => {
    const expensiveWorker = makeWorkerData({ id: 'wkr_expensive' })
    const ctx = makeContext({
      workerCosts: new Map<string, WorkerCostInfo>([
        ['wkr_cheap', { averageCostUsd: 0.10, sessionCount: 5 }],
        ['wkr_expensive', { averageCostUsd: 1.00, sessionCount: 5 }],
      ]),
    })

    const result = scorer.score(makeQueuedWork(), expensiveWorker, ctx)
    expect(result.score).toBe(0)
  })

  it('returns 100 when all workers have the same cost', () => {
    const worker = makeWorkerData({ id: 'wkr_a' })
    const ctx = makeContext({
      workerCosts: new Map<string, WorkerCostInfo>([
        ['wkr_a', { averageCostUsd: 0.50, sessionCount: 5 }],
        ['wkr_b', { averageCostUsd: 0.50, sessionCount: 5 }],
      ]),
    })

    const result = scorer.score(makeQueuedWork(), worker, ctx)
    expect(result.score).toBe(100)
    expect(result.reason).toContain('same average cost')
  })

  it('has correct name and weight', () => {
    expect(scorer.name).toBe('cost')
    expect(scorer.weight).toBe(0.15)
  })
})

// ---------------------------------------------------------------------------
// RecencyScorer
// ---------------------------------------------------------------------------

describe('RecencyScorer', () => {
  const scorer = new RecencyScorer()

  it('returns 100 for a worker with a very recent heartbeat', () => {
    const worker = makeWorkerData({ lastHeartbeat: Date.now() })
    const result = scorer.score(makeQueuedWork(), worker, makeContext())
    expect(result.score).toBe(100)
  })

  it('returns 0 for a worker with heartbeat older than 5 minutes', () => {
    const worker = makeWorkerData({ lastHeartbeat: Date.now() - 300_001 })
    const result = scorer.score(makeQueuedWork(), worker, makeContext())
    expect(result.score).toBe(0)
  })

  it('returns ~50 for a worker with heartbeat at 2.5 minutes ago', () => {
    const worker = makeWorkerData({ lastHeartbeat: Date.now() - 150_000 })
    const result = scorer.score(makeQueuedWork(), worker, makeContext())
    expect(result.score).toBe(50)
  })

  it('returns 0 for a very stale heartbeat', () => {
    const worker = makeWorkerData({ lastHeartbeat: Date.now() - 600_000 })
    const result = scorer.score(makeQueuedWork(), worker, makeContext())
    expect(result.score).toBe(0)
  })

  it('has correct name and weight', () => {
    expect(scorer.name).toBe('recency')
    expect(scorer.weight).toBe(0.10)
  })
})

// ---------------------------------------------------------------------------
// createDefaultScorers
// ---------------------------------------------------------------------------

describe('createDefaultScorers', () => {
  it('returns 5 scorers', () => {
    const scorers = createDefaultScorers()
    expect(scorers).toHaveLength(5)
  })

  it('weights sum to 1.0', () => {
    const scorers = createDefaultScorers()
    const totalWeight = scorers.reduce((sum, s) => sum + s.weight, 0)
    expect(Math.abs(totalWeight - 1.0)).toBeLessThan(0.001)
  })

  it('contains all expected scorer names', () => {
    const scorers = createDefaultScorers()
    const names = scorers.map((s) => s.name)
    expect(names).toContain('affinity')
    expect(names).toContain('load-balance')
    expect(names).toContain('fairness')
    expect(names).toContain('cost')
    expect(names).toContain('recency')
  })
})

// ---------------------------------------------------------------------------
// runScorers
// ---------------------------------------------------------------------------

describe('runScorers', () => {
  it('returns empty array for empty feasible workers', () => {
    const scorers = createDefaultScorers()
    const work = makeQueuedWork()
    const ctx = makeContext()

    const result = runScorers(work, [], scorers, ctx)
    expect(result).toEqual([])
  })

  it('throws when weights do not sum to 1.0', () => {
    const badScorers: SchedulerScorer[] = [
      {
        name: 'over',
        weight: 0.8,
        score: () => ({ score: 50, reason: 'test' }),
      },
      {
        name: 'also-over',
        weight: 0.8,
        score: () => ({ score: 50, reason: 'test' }),
      },
    ]

    const work = makeQueuedWork()
    const worker = makeWorkerData()
    const ctx = makeContext({ allWorkers: [worker] })

    expect(() => runScorers(work, [worker], badScorers, ctx)).toThrow(
      /weights must sum to 1\.0/
    )
  })

  it('accepts weights within tolerance of 1.0', () => {
    // Floating point: 0.1 + 0.2 + 0.3 + 0.15 + 0.25 may not be exactly 1.0
    const scorers = createDefaultScorers()
    const worker = makeWorkerData()
    const work = makeQueuedWork()
    const ctx = makeContext({ allWorkers: [worker] })

    // Should not throw
    expect(() => runScorers(work, [worker], scorers, ctx)).not.toThrow()
  })

  it('returns workers sorted by totalScore descending', () => {
    const now = Date.now()
    const workerA = makeWorkerData({
      id: 'wkr_a',
      capacity: 4,
      activeCount: 3, // heavily loaded
      lastHeartbeat: now,
      activeSessions: ['s1', 's2', 's3'],
    })
    const workerB = makeWorkerData({
      id: 'wkr_b',
      capacity: 4,
      activeCount: 0, // idle
      lastHeartbeat: now,
      activeSessions: [],
    })

    const work = makeQueuedWork()
    const scorers = createDefaultScorers()
    const ctx = makeContext({ allWorkers: [workerA, workerB] })

    const result = runScorers(work, [workerA, workerB], scorers, ctx)

    expect(result).toHaveLength(2)
    // Worker B (idle) should score higher than worker A (loaded)
    expect(result[0].worker.id).toBe('wkr_b')
    expect(result[1].worker.id).toBe('wkr_a')
    expect(result[0].totalScore).toBeGreaterThan(result[1].totalScore)
  })

  it('breaks ties deterministically by worker.id ascending', () => {
    const now = Date.now()
    // Two identical workers — same capacity, load, heartbeat
    const workerA = makeWorkerData({
      id: 'wkr_aaa',
      capacity: 4,
      activeCount: 2,
      lastHeartbeat: now,
      activeSessions: ['s1', 's2'],
    })
    const workerB = makeWorkerData({
      id: 'wkr_bbb',
      capacity: 4,
      activeCount: 2,
      lastHeartbeat: now,
      activeSessions: ['s3', 's4'],
    })

    const work = makeQueuedWork()
    const scorers = createDefaultScorers()
    const ctx = makeContext({ allWorkers: [workerA, workerB] })

    const result = runScorers(work, [workerA, workerB], scorers, ctx)

    expect(result).toHaveLength(2)
    // Same scores -> alphabetical by ID
    expect(result[0].totalScore).toBe(result[1].totalScore)
    expect(result[0].worker.id).toBe('wkr_aaa')
    expect(result[1].worker.id).toBe('wkr_bbb')
  })

  it('includes per-scorer breakdown in scores map', () => {
    const worker = makeWorkerData({ id: 'wkr_test', lastHeartbeat: Date.now() })
    const work = makeQueuedWork()
    const scorers = createDefaultScorers()
    const ctx = makeContext({ allWorkers: [worker] })

    const result = runScorers(work, [worker], scorers, ctx)

    expect(result).toHaveLength(1)
    const scoredWorker = result[0]
    expect(scoredWorker.scores.size).toBe(5)
    expect(scoredWorker.scores.has('affinity')).toBe(true)
    expect(scoredWorker.scores.has('load-balance')).toBe(true)
    expect(scoredWorker.scores.has('fairness')).toBe(true)
    expect(scoredWorker.scores.has('cost')).toBe(true)
    expect(scoredWorker.scores.has('recency')).toBe(true)

    // Each score should have a number and reason
    for (const [, scoreResult] of scoredWorker.scores) {
      expect(typeof scoreResult.score).toBe('number')
      expect(scoreResult.score).toBeGreaterThanOrEqual(0)
      expect(scoreResult.score).toBeLessThanOrEqual(100)
      expect(typeof scoreResult.reason).toBe('string')
      expect(scoreResult.reason.length).toBeGreaterThan(0)
    }
  })

  it('computes correct composite score with all 5 scorers', () => {
    const now = Date.now()
    const worker = makeWorkerData({
      id: 'wkr_test',
      capacity: 4,
      activeCount: 0, // load-balance: 100
      lastHeartbeat: now, // recency: 100
      activeSessions: [],
    })

    const work = makeQueuedWork({ issueId: 'issue_x' })

    // Set up context so we know exact scores
    const ctx = makeContext({
      allWorkers: [worker],
      workerHistory: new Map([
        // affinity: 100 (same worker ran previous phase)
        ['issue_x', { lastWorkerId: 'wkr_test', lastWorkType: 'development' }],
      ]),
      workerCosts: new Map([
        // cost: 100 (only one worker, same cost as itself)
        ['wkr_test', { averageCostUsd: 0.50, sessionCount: 10 }],
      ]),
    })

    const scorers = createDefaultScorers()
    const result = runScorers(work, [worker], scorers, ctx)

    expect(result).toHaveLength(1)
    const scored = result[0]

    // With single worker: affinity=100, load=100, fairness=100, cost=100, recency=100
    // Weighted: 0.30*100 + 0.25*100 + 0.20*100 + 0.15*100 + 0.10*100 = 100
    expect(scored.totalScore).toBe(100)
  })

  it('single worker returns that worker with a computed score', () => {
    const worker = makeWorkerData({
      id: 'wkr_solo',
      capacity: 4,
      activeCount: 2,
      lastHeartbeat: Date.now(),
      activeSessions: ['s1', 's2'],
    })
    const work = makeQueuedWork()
    const scorers = createDefaultScorers()
    const ctx = makeContext({ allWorkers: [worker] })

    const result = runScorers(work, [worker], scorers, ctx)

    expect(result).toHaveLength(1)
    expect(result[0].worker.id).toBe('wkr_solo')
    expect(typeof result[0].totalScore).toBe('number')
    expect(result[0].totalScore).toBeGreaterThanOrEqual(0)
    expect(result[0].totalScore).toBeLessThanOrEqual(100)
  })

  it('all workers with equal attributes score equally', () => {
    const now = Date.now()
    const workers = ['wkr_1', 'wkr_2', 'wkr_3'].map((id) =>
      makeWorkerData({
        id,
        capacity: 4,
        activeCount: 1,
        lastHeartbeat: now,
        activeSessions: ['s'],
      })
    )

    const work = makeQueuedWork()
    const scorers = createDefaultScorers()
    const ctx = makeContext({ allWorkers: workers })

    const result = runScorers(work, workers, scorers, ctx)

    expect(result).toHaveLength(3)
    // All should have the same total score
    expect(result[0].totalScore).toBe(result[1].totalScore)
    expect(result[1].totalScore).toBe(result[2].totalScore)
    // Tie-breaking: sorted by ID ascending
    expect(result[0].worker.id).toBe('wkr_1')
    expect(result[1].worker.id).toBe('wkr_2')
    expect(result[2].worker.id).toBe('wkr_3')
  })

  it('affinity has the biggest impact on final ranking', () => {
    const now = Date.now()

    // Worker A: has affinity but slightly more loaded
    const workerA = makeWorkerData({
      id: 'wkr_affinity',
      capacity: 4,
      activeCount: 2,
      lastHeartbeat: now,
      activeSessions: ['s1', 's2'],
    })

    // Worker B: no affinity but less loaded
    const workerB = makeWorkerData({
      id: 'wkr_no_affinity',
      capacity: 4,
      activeCount: 1,
      lastHeartbeat: now,
      activeSessions: ['s3'],
    })

    const work = makeQueuedWork({ issueId: 'issue_aff' })
    const scorers = createDefaultScorers()
    const ctx = makeContext({
      allWorkers: [workerA, workerB],
      workerHistory: new Map([
        ['issue_aff', { lastWorkerId: 'wkr_affinity', lastWorkType: 'development' }],
      ]),
    })

    const result = runScorers(work, [workerA, workerB], scorers, ctx)

    // Worker A should rank higher despite being more loaded, because
    // affinity weight (0.30) is the highest and gives 100 vs 0
    expect(result[0].worker.id).toBe('wkr_affinity')
  })
})
