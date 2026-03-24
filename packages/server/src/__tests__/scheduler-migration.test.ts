import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — must be declared before the module under test is imported
// ---------------------------------------------------------------------------

vi.mock('../scheduling-queue.js', () => ({
  promoteFromBackoff: vi.fn().mockResolvedValue(0),
  reevaluateSuspended: vi.fn().mockResolvedValue([]),
  getQueueStats: vi.fn().mockResolvedValue({ active: 0, backoff: 0, suspended: 0 }),
}))

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

import {
  getSchedulerMode,
  runQueueMaintenance,
  compareSchedulerResults,
  type SchedulerMode,
} from '../scheduler/migration.js'

import {
  promoteFromBackoff,
  reevaluateSuspended,
  getQueueStats,
} from '../scheduling-queue.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockedPromote = vi.mocked(promoteFromBackoff)
const mockedReevaluate = vi.mocked(reevaluateSuspended)
const mockedStats = vi.mocked(getQueueStats)

// ---------------------------------------------------------------------------
// getSchedulerMode
// ---------------------------------------------------------------------------

describe('getSchedulerMode', () => {
  const originalEnv = process.env.SCHEDULER_MODE

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SCHEDULER_MODE
    } else {
      process.env.SCHEDULER_MODE = originalEnv
    }
  })

  it('returns legacy by default when env var is not set', () => {
    delete process.env.SCHEDULER_MODE
    expect(getSchedulerMode()).toBe('legacy')
  })

  it('returns legacy when env var is empty string', () => {
    process.env.SCHEDULER_MODE = ''
    expect(getSchedulerMode()).toBe('legacy')
  })

  it('returns shadow when SCHEDULER_MODE=shadow', () => {
    process.env.SCHEDULER_MODE = 'shadow'
    expect(getSchedulerMode()).toBe('shadow')
  })

  it('returns pipeline when SCHEDULER_MODE=pipeline', () => {
    process.env.SCHEDULER_MODE = 'pipeline'
    expect(getSchedulerMode()).toBe('pipeline')
  })

  it('returns legacy when SCHEDULER_MODE=legacy', () => {
    process.env.SCHEDULER_MODE = 'legacy'
    expect(getSchedulerMode()).toBe('legacy')
  })

  it('returns legacy for invalid values', () => {
    process.env.SCHEDULER_MODE = 'invalid'
    expect(getSchedulerMode()).toBe('legacy')
  })

  it('returns legacy for typos like "Pipeline"', () => {
    process.env.SCHEDULER_MODE = 'Pipeline'
    expect(getSchedulerMode()).toBe('legacy')
  })
})

// ---------------------------------------------------------------------------
// runQueueMaintenance
// ---------------------------------------------------------------------------

describe('runQueueMaintenance', () => {
  const originalEnv = process.env.SCHEDULER_MODE

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SCHEDULER_MODE
    } else {
      process.env.SCHEDULER_MODE = originalEnv
    }
  })

  it('skips all work in legacy mode', async () => {
    delete process.env.SCHEDULER_MODE

    const result = await runQueueMaintenance()

    expect(result).toEqual({
      promoted: 0,
      reevaluated: 0,
      stats: null,
      skipped: true,
    })
    expect(mockedPromote).not.toHaveBeenCalled()
    expect(mockedReevaluate).not.toHaveBeenCalled()
    expect(mockedStats).not.toHaveBeenCalled()
  })

  it('runs promotion, re-evaluation, and stats in pipeline mode', async () => {
    process.env.SCHEDULER_MODE = 'pipeline'

    const mockStats = { active: 5, backoff: 2, suspended: 1 }
    mockedPromote.mockResolvedValue(3)
    mockedReevaluate.mockResolvedValue([
      {
        sessionId: 's1',
        issueId: 'i1',
        issueIdentifier: 'ENG-1',
        priority: 3,
        queuedAt: Date.now(),
        suspendedAt: Date.now() - 60_000,
        suspendReason: 'no_feasible_worker',
        lastEvaluatedAt: Date.now(),
      },
    ])
    mockedStats.mockResolvedValue(mockStats)

    const result = await runQueueMaintenance()

    expect(result.skipped).toBe(false)
    expect(result.promoted).toBe(3)
    expect(result.reevaluated).toBe(1)
    expect(result.stats).toEqual(mockStats)
    expect(mockedPromote).toHaveBeenCalledOnce()
    expect(mockedReevaluate).toHaveBeenCalledOnce()
    expect(mockedStats).toHaveBeenCalledOnce()
  })

  it('runs maintenance in shadow mode', async () => {
    process.env.SCHEDULER_MODE = 'shadow'

    mockedPromote.mockResolvedValue(0)
    mockedReevaluate.mockResolvedValue([])
    mockedStats.mockResolvedValue({ active: 0, backoff: 0, suspended: 0 })

    const result = await runQueueMaintenance()

    expect(result.skipped).toBe(false)
    expect(mockedPromote).toHaveBeenCalledOnce()
    expect(mockedReevaluate).toHaveBeenCalledOnce()
    expect(mockedStats).toHaveBeenCalledOnce()
  })

  it('propagates errors from promoteFromBackoff', async () => {
    process.env.SCHEDULER_MODE = 'pipeline'
    mockedPromote.mockRejectedValue(new Error('Redis connection failed'))

    await expect(runQueueMaintenance()).rejects.toThrow('Redis connection failed')
  })

  it('propagates errors from reevaluateSuspended', async () => {
    process.env.SCHEDULER_MODE = 'pipeline'
    mockedPromote.mockResolvedValue(0)
    mockedReevaluate.mockRejectedValue(new Error('Suspended scan failed'))

    await expect(runQueueMaintenance()).rejects.toThrow('Suspended scan failed')
  })

  it('propagates errors from getQueueStats', async () => {
    process.env.SCHEDULER_MODE = 'pipeline'
    mockedPromote.mockResolvedValue(0)
    mockedReevaluate.mockResolvedValue([])
    mockedStats.mockRejectedValue(new Error('Stats fetch failed'))

    await expect(runQueueMaintenance()).rejects.toThrow('Stats fetch failed')
  })

  it('returns zero counts when queues are empty in pipeline mode', async () => {
    process.env.SCHEDULER_MODE = 'pipeline'
    mockedPromote.mockResolvedValue(0)
    mockedReevaluate.mockResolvedValue([])
    mockedStats.mockResolvedValue({ active: 0, backoff: 0, suspended: 0 })

    const result = await runQueueMaintenance()

    expect(result.promoted).toBe(0)
    expect(result.reevaluated).toBe(0)
    expect(result.stats).toEqual({ active: 0, backoff: 0, suspended: 0 })
    expect(result.skipped).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// compareSchedulerResults
// ---------------------------------------------------------------------------

describe('compareSchedulerResults', () => {
  it('returns match=true when both arrays are identical', () => {
    const result = compareSchedulerResults(
      ['work-1', 'work-2', 'work-3'],
      ['work-1', 'work-2', 'work-3'],
    )

    expect(result.match).toBe(true)
    expect(result.legacyWorkIds).toEqual(['work-1', 'work-2', 'work-3'])
    expect(result.pipelineWorkIds).toEqual(['work-1', 'work-2', 'work-3'])
  })

  it('returns match=false when arrays have different lengths', () => {
    const result = compareSchedulerResults(
      ['work-1', 'work-2'],
      ['work-1'],
    )

    expect(result.match).toBe(false)
  })

  it('returns match=false when arrays have same length but different order', () => {
    const result = compareSchedulerResults(
      ['work-1', 'work-2'],
      ['work-2', 'work-1'],
    )

    expect(result.match).toBe(false)
  })

  it('returns match=false when arrays have same length but different items', () => {
    const result = compareSchedulerResults(
      ['work-1', 'work-2'],
      ['work-1', 'work-3'],
    )

    expect(result.match).toBe(false)
  })

  it('returns match=true for two empty arrays', () => {
    const result = compareSchedulerResults([], [])

    expect(result.match).toBe(true)
    expect(result.legacyWorkIds).toEqual([])
    expect(result.pipelineWorkIds).toEqual([])
  })

  it('returns match=false when legacy is empty but pipeline is not', () => {
    const result = compareSchedulerResults([], ['work-1'])
    expect(result.match).toBe(false)
  })

  it('returns match=false when pipeline is empty but legacy is not', () => {
    const result = compareSchedulerResults(['work-1'], [])
    expect(result.match).toBe(false)
  })

  it('returns the original arrays in the result', () => {
    const legacy = ['a', 'b']
    const pipeline = ['a', 'b']
    const result = compareSchedulerResults(legacy, pipeline)

    expect(result.legacyWorkIds).toBe(legacy)
    expect(result.pipelineWorkIds).toBe(pipeline)
  })
})
