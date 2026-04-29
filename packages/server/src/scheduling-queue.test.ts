import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock redis before importing module under test
vi.mock('./redis.js', () => ({
  isRedisConfigured: vi.fn(() => true),
  getRedisClient: vi.fn(() => ({
    pipeline: vi.fn(() => ({
      zrem: vi.fn().mockReturnThis(),
      hdel: vi.fn().mockReturnThis(),
      zadd: vi.fn().mockReturnThis(),
      hset: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    })),
  })),
  redisSetNX: vi.fn(),
  redisGet: vi.fn(),
  redisDel: vi.fn(),
  redisSet: vi.fn(),
  redisZAdd: vi.fn(),
  redisZRem: vi.fn(),
  redisZRangeByScore: vi.fn(() => []),
  redisZCard: vi.fn(() => 0),
  redisZPopMin: vi.fn(),
  redisHSet: vi.fn(),
  redisHGet: vi.fn(),
  redisHDel: vi.fn(),
  redisHMGet: vi.fn(() => []),
  redisHGetAll: vi.fn(() => ({})),
  redisHLen: vi.fn(() => 0),
  redisKeys: vi.fn(() => []),
  redisExpire: vi.fn(),
}))

// Mock work-queue.js to provide key constants and calculateScore
vi.mock('./work-queue.js', () => ({
  WORK_QUEUE_KEY: 'work:queue',
  WORK_ITEMS_KEY: 'work:items',
  calculateScore: vi.fn((priority: number, queuedAt: number) => {
    const clampedPriority = Math.max(1, Math.min(9, priority))
    return clampedPriority * 1e13 + queuedAt
  }),
}))

// Mock journal.js so moveToCompleted's writeJournalEntry call is observable.
vi.mock('./journal.js', () => ({
  writeJournalEntry: vi.fn(async () => true),
}))

import {
  addToActive,
  moveToBackoff,
  moveToSuspended,
  moveToCompleted,
  promoteFromBackoff,
  reevaluateSuspended,
  getQueueStats,
  calculateBackoff,
} from './scheduling-queue.js'
import { writeJournalEntry } from './journal.js'
import type { QueuedWork, BackoffEntry, SuspendedEntry } from './scheduling-queue.js'
import {
  isRedisConfigured,
  getRedisClient,
  redisZAdd,
  redisZRem,
  redisZRangeByScore,
  redisZCard,
  redisHSet,
  redisHGet,
  redisHDel,
  redisHGetAll,
  redisHLen,
} from './redis.js'

const mockIsRedisConfigured = vi.mocked(isRedisConfigured)
const mockGetRedisClient = vi.mocked(getRedisClient)
const mockRedisZAdd = vi.mocked(redisZAdd)
const mockRedisZRem = vi.mocked(redisZRem)
const mockRedisZRangeByScore = vi.mocked(redisZRangeByScore)
const mockRedisZCard = vi.mocked(redisZCard)
const mockRedisHSet = vi.mocked(redisHSet)
const mockRedisHGet = vi.mocked(redisHGet)
const mockRedisHDel = vi.mocked(redisHDel)
const mockRedisHGetAll = vi.mocked(redisHGetAll)
const mockRedisHLen = vi.mocked(redisHLen)

function makeWork(overrides: Partial<QueuedWork> = {}): QueuedWork {
  return {
    sessionId: 'session-1',
    issueId: 'issue-1',
    issueIdentifier: 'SUP-100',
    priority: 2,
    queuedAt: 1_700_000_000_000,
    prompt: 'test prompt',
    workType: 'development',
    ...overrides,
  }
}

function makePipelineMock() {
  const pipeline = {
    zrem: vi.fn().mockReturnThis(),
    hdel: vi.fn().mockReturnThis(),
    zadd: vi.fn().mockReturnThis(),
    hset: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  }
  return pipeline
}

// ---------------------------------------------------------------------------
// addToActive
// ---------------------------------------------------------------------------

describe('addToActive', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns false when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    const result = await addToActive(makeWork())
    expect(result).toBe(false)
    expect(mockRedisHSet).not.toHaveBeenCalled()
    expect(mockRedisZAdd).not.toHaveBeenCalled()
  })

  it('stores work in hash and sorted set using existing keys', async () => {
    const work = makeWork({ sessionId: 'sess-42', priority: 3 })
    mockRedisHSet.mockResolvedValue(1)
    mockRedisZAdd.mockResolvedValue(1)

    const result = await addToActive(work)

    expect(result).toBe(true)
    expect(mockRedisHSet).toHaveBeenCalledWith(
      'work:items',
      'sess-42',
      JSON.stringify(work)
    )
    expect(mockRedisZAdd).toHaveBeenCalledWith(
      'work:queue',
      expect.any(Number),
      'sess-42'
    )
  })

  it('returns true on success', async () => {
    mockRedisHSet.mockResolvedValue(1)
    mockRedisZAdd.mockResolvedValue(1)

    const result = await addToActive(makeWork())
    expect(result).toBe(true)
  })

  it('returns false on Redis error', async () => {
    mockRedisHSet.mockRejectedValue(new Error('connection lost'))

    const result = await addToActive(makeWork())
    expect(result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// moveToBackoff
// ---------------------------------------------------------------------------

describe('moveToBackoff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns false when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    const result = await moveToBackoff('session-1', 'test reason')
    expect(result).toBe(false)
  })

  it('returns false when item not found in active queue', async () => {
    mockRedisHGet.mockResolvedValue(null)

    const result = await moveToBackoff('session-1', 'test reason')
    expect(result).toBe(false)
  })

  it('moves item from active to backoff with pipeline', async () => {
    const work = makeWork({ sessionId: 'sess-1' })
    const pipeline = makePipelineMock()
    mockGetRedisClient.mockReturnValue({ pipeline: () => pipeline } as never)

    // First call: get from active items; second call: check existing backoff
    mockRedisHGet
      .mockResolvedValueOnce(JSON.stringify(work)) // active item
      .mockResolvedValueOnce(null) // no existing backoff

    const result = await moveToBackoff('sess-1', 'worker_busy', 10_000)

    expect(result).toBe(true)
    expect(pipeline.zrem).toHaveBeenCalledWith('work:queue', 'sess-1')
    expect(pipeline.hdel).toHaveBeenCalledWith('work:items', 'sess-1')
    expect(pipeline.zadd).toHaveBeenCalledWith(
      'work:backoff',
      expect.any(Number),
      'sess-1'
    )
    expect(pipeline.hset).toHaveBeenCalledWith(
      'work:backoff:items',
      'sess-1',
      expect.any(String)
    )
    expect(pipeline.exec).toHaveBeenCalled()

    // Verify the stored backoff entry
    const storedJson = pipeline.hset.mock.calls[0][2] as string
    const stored = JSON.parse(storedJson) as BackoffEntry
    expect(stored.backoffAttempt).toBe(0)
    expect(stored.backoffReason).toBe('worker_busy')
    expect(stored.backoffUntil).toBeGreaterThan(Date.now() - 1000)
  })

  it('increments attempt when item was previously in backoff', async () => {
    const work = makeWork({ sessionId: 'sess-1' })
    const previousBackoff: BackoffEntry = {
      ...work,
      backoffUntil: Date.now() - 5000,
      backoffAttempt: 2,
      backoffReason: 'previous reason',
    }
    const pipeline = makePipelineMock()
    mockGetRedisClient.mockReturnValue({ pipeline: () => pipeline } as never)

    mockRedisHGet
      .mockResolvedValueOnce(JSON.stringify(work)) // active item
      .mockResolvedValueOnce(JSON.stringify(previousBackoff)) // existing backoff

    const result = await moveToBackoff('sess-1', 'retry', 15_000)

    expect(result).toBe(true)
    const storedJson = pipeline.hset.mock.calls[0][2] as string
    const stored = JSON.parse(storedJson) as BackoffEntry
    expect(stored.backoffAttempt).toBe(3)
  })

  it('uses calculateBackoff when no explicit backoffMs provided', async () => {
    const work = makeWork({ sessionId: 'sess-1' })
    const pipeline = makePipelineMock()
    mockGetRedisClient.mockReturnValue({ pipeline: () => pipeline } as never)

    mockRedisHGet
      .mockResolvedValueOnce(JSON.stringify(work))
      .mockResolvedValueOnce(null)

    const beforeTime = Date.now()
    await moveToBackoff('sess-1', 'auto_backoff')
    const afterTime = Date.now()

    const storedJson = pipeline.hset.mock.calls[0][2] as string
    const stored = JSON.parse(storedJson) as BackoffEntry
    // For attempt 0: baseMs=5000, so backoffUntil should be ~now + 5000 + jitter(0-1000)
    expect(stored.backoffUntil).toBeGreaterThanOrEqual(beforeTime + 5_000)
    expect(stored.backoffUntil).toBeLessThanOrEqual(afterTime + 6_000 + 100) // small tolerance
  })

  it('returns false on Redis error', async () => {
    mockRedisHGet.mockRejectedValue(new Error('connection lost'))

    const result = await moveToBackoff('session-1', 'test')
    expect(result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// moveToSuspended
// ---------------------------------------------------------------------------

describe('moveToSuspended', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns false when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    const result = await moveToSuspended('session-1', 'quota_exceeded')
    expect(result).toBe(false)
  })

  it('returns false when item not found in either queue', async () => {
    mockRedisHGet
      .mockResolvedValueOnce(null) // not in active
      .mockResolvedValueOnce(null) // not in backoff

    const result = await moveToSuspended('session-1', 'no_feasible_worker')
    expect(result).toBe(false)
  })

  it('moves item from active queue to suspended', async () => {
    const work = makeWork({ sessionId: 'sess-1' })
    const pipeline = makePipelineMock()
    mockGetRedisClient.mockReturnValue({ pipeline: () => pipeline } as never)

    mockRedisHGet.mockResolvedValueOnce(JSON.stringify(work)) // found in active

    const result = await moveToSuspended('sess-1', 'no_feasible_worker')

    expect(result).toBe(true)
    expect(pipeline.zrem).toHaveBeenCalledWith('work:queue', 'sess-1')
    expect(pipeline.hdel).toHaveBeenCalledWith('work:items', 'sess-1')
    expect(pipeline.hset).toHaveBeenCalledWith(
      'work:suspended',
      'sess-1',
      expect.any(String)
    )
    expect(pipeline.exec).toHaveBeenCalled()

    // Verify suspended entry fields
    const storedJson = pipeline.hset.mock.calls[0][2] as string
    const stored = JSON.parse(storedJson) as SuspendedEntry
    expect(stored.suspendReason).toBe('no_feasible_worker')
    expect(stored.suspendedAt).toBeGreaterThan(0)
    expect(stored.lastEvaluatedAt).toBeGreaterThan(0)
    expect(stored.sessionId).toBe('sess-1')
  })

  it('moves item from backoff queue to suspended', async () => {
    const backoffEntry: BackoffEntry = {
      ...makeWork({ sessionId: 'sess-2' }),
      backoffUntil: Date.now() + 10_000,
      backoffAttempt: 3,
      backoffReason: 'some reason',
    }
    const pipeline = makePipelineMock()
    mockGetRedisClient.mockReturnValue({ pipeline: () => pipeline } as never)

    mockRedisHGet
      .mockResolvedValueOnce(null) // not in active
      .mockResolvedValueOnce(JSON.stringify(backoffEntry)) // found in backoff

    const result = await moveToSuspended('sess-2', 'quota_exceeded')

    expect(result).toBe(true)
    expect(pipeline.zrem).toHaveBeenCalledWith('work:backoff', 'sess-2')
    expect(pipeline.hdel).toHaveBeenCalledWith('work:backoff:items', 'sess-2')
    expect(pipeline.hset).toHaveBeenCalledWith(
      'work:suspended',
      'sess-2',
      expect.any(String)
    )

    // Verify backoff-specific fields are stripped
    const storedJson = pipeline.hset.mock.calls[0][2] as string
    const stored = JSON.parse(storedJson) as SuspendedEntry
    expect(stored.suspendReason).toBe('quota_exceeded')
    expect((stored as unknown as Record<string, unknown>)['backoffUntil']).toBeUndefined()
    expect((stored as unknown as Record<string, unknown>)['backoffAttempt']).toBeUndefined()
    expect((stored as unknown as Record<string, unknown>)['backoffReason']).toBeUndefined()
  })

  it('returns false on Redis error', async () => {
    mockRedisHGet.mockRejectedValue(new Error('connection lost'))

    const result = await moveToSuspended('session-1', 'test')
    expect(result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// promoteFromBackoff
// ---------------------------------------------------------------------------

describe('promoteFromBackoff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns 0 when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    const result = await promoteFromBackoff()
    expect(result).toBe(0)
  })

  it('returns 0 when no eligible items', async () => {
    mockRedisZRangeByScore.mockResolvedValue([])

    const result = await promoteFromBackoff()
    expect(result).toBe(0)
  })

  it('promotes eligible items from backoff to active', async () => {
    const work = makeWork({ sessionId: 'sess-1' })
    const backoffEntry: BackoffEntry = {
      ...work,
      backoffUntil: Date.now() - 1000, // already past
      backoffAttempt: 1,
      backoffReason: 'test',
    }
    const pipeline = makePipelineMock()
    mockGetRedisClient.mockReturnValue({ pipeline: () => pipeline } as never)

    mockRedisZRangeByScore.mockResolvedValue(['sess-1'])
    mockRedisHGet.mockResolvedValue(JSON.stringify(backoffEntry))

    const result = await promoteFromBackoff()

    expect(result).toBe(1)
    expect(pipeline.zrem).toHaveBeenCalledWith('work:backoff', 'sess-1')
    expect(pipeline.hdel).toHaveBeenCalledWith('work:backoff:items', 'sess-1')
    expect(pipeline.zadd).toHaveBeenCalledWith(
      'work:queue',
      expect.any(Number),
      'sess-1'
    )
    expect(pipeline.hset).toHaveBeenCalledWith(
      'work:items',
      'sess-1',
      expect.any(String)
    )

    // Verify backoff fields are stripped from promoted work
    const storedJson = pipeline.hset.mock.calls[0][2] as string
    const stored = JSON.parse(storedJson) as QueuedWork
    expect((stored as unknown as Record<string, unknown>)['backoffUntil']).toBeUndefined()
    expect((stored as unknown as Record<string, unknown>)['backoffAttempt']).toBeUndefined()
    expect((stored as unknown as Record<string, unknown>)['backoffReason']).toBeUndefined()
  })

  it('cleans up orphaned sorted set members', async () => {
    mockRedisZRangeByScore.mockResolvedValue(['orphan-sess'])
    mockRedisHGet.mockResolvedValue(null) // item hash missing

    const result = await promoteFromBackoff()

    expect(result).toBe(0)
    expect(mockRedisZRem).toHaveBeenCalledWith('work:backoff', 'orphan-sess')
  })

  it('promotes multiple items and handles partial failures', async () => {
    const work1 = makeWork({ sessionId: 'sess-1' })
    const work2 = makeWork({ sessionId: 'sess-2' })
    const backoff1: BackoffEntry = {
      ...work1,
      backoffUntil: Date.now() - 1000,
      backoffAttempt: 0,
      backoffReason: 'test',
    }
    const backoff2: BackoffEntry = {
      ...work2,
      backoffUntil: Date.now() - 500,
      backoffAttempt: 1,
      backoffReason: 'test',
    }
    const pipeline = makePipelineMock()
    mockGetRedisClient.mockReturnValue({ pipeline: () => pipeline } as never)

    mockRedisZRangeByScore.mockResolvedValue(['sess-1', 'sess-2'])
    mockRedisHGet
      .mockResolvedValueOnce(JSON.stringify(backoff1))
      .mockResolvedValueOnce(JSON.stringify(backoff2))

    const result = await promoteFromBackoff()
    expect(result).toBe(2)
  })

  it('queries backoff queue with correct score range', async () => {
    mockRedisZRangeByScore.mockResolvedValue([])

    const beforeTime = Date.now()
    await promoteFromBackoff()
    const afterTime = Date.now()

    expect(mockRedisZRangeByScore).toHaveBeenCalledWith(
      'work:backoff',
      '-inf',
      expect.any(Number)
    )

    // Verify the max score is approximately "now"
    const maxScore = mockRedisZRangeByScore.mock.calls[0][2] as number
    expect(maxScore).toBeGreaterThanOrEqual(beforeTime)
    expect(maxScore).toBeLessThanOrEqual(afterTime)
  })

  it('returns 0 on Redis error', async () => {
    mockRedisZRangeByScore.mockRejectedValue(new Error('connection lost'))

    const result = await promoteFromBackoff()
    expect(result).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// reevaluateSuspended
// ---------------------------------------------------------------------------

describe('reevaluateSuspended', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns empty array when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    const result = await reevaluateSuspended()
    expect(result).toEqual([])
  })

  it('returns empty array when no suspended items', async () => {
    mockRedisHGetAll.mockResolvedValue({})

    const result = await reevaluateSuspended()
    expect(result).toEqual([])
  })

  it('updates lastEvaluatedAt on all suspended items', async () => {
    const entry1: SuspendedEntry = {
      ...makeWork({ sessionId: 'sess-1' }),
      suspendedAt: 1_700_000_000_000,
      suspendReason: 'no_feasible_worker',
      lastEvaluatedAt: 1_700_000_000_000,
    }
    const entry2: SuspendedEntry = {
      ...makeWork({ sessionId: 'sess-2' }),
      suspendedAt: 1_700_000_001_000,
      suspendReason: 'quota_exceeded',
      lastEvaluatedAt: 1_700_000_001_000,
    }

    mockRedisHGetAll.mockResolvedValue({
      'sess-1': JSON.stringify(entry1),
      'sess-2': JSON.stringify(entry2),
    })
    mockRedisHSet.mockResolvedValue(0)

    const beforeTime = Date.now()
    const result = await reevaluateSuspended()
    const afterTime = Date.now()

    expect(result).toHaveLength(2)

    // lastEvaluatedAt should be updated to approximately now
    for (const entry of result) {
      expect(entry.lastEvaluatedAt).toBeGreaterThanOrEqual(beforeTime)
      expect(entry.lastEvaluatedAt).toBeLessThanOrEqual(afterTime)
    }

    // Should have written updates back to Redis
    expect(mockRedisHSet).toHaveBeenCalledTimes(2)
    expect(mockRedisHSet).toHaveBeenCalledWith(
      'work:suspended',
      'sess-1',
      expect.any(String)
    )
    expect(mockRedisHSet).toHaveBeenCalledWith(
      'work:suspended',
      'sess-2',
      expect.any(String)
    )
  })

  it('preserves original suspended entry fields', async () => {
    const entry: SuspendedEntry = {
      ...makeWork({ sessionId: 'sess-1', priority: 3 }),
      suspendedAt: 1_700_000_000_000,
      suspendReason: 'no_feasible_worker',
      lastEvaluatedAt: 1_700_000_000_000,
    }

    mockRedisHGetAll.mockResolvedValue({
      'sess-1': JSON.stringify(entry),
    })
    mockRedisHSet.mockResolvedValue(0)

    const result = await reevaluateSuspended()

    expect(result[0].suspendReason).toBe('no_feasible_worker')
    expect(result[0].suspendedAt).toBe(1_700_000_000_000)
    expect(result[0].priority).toBe(3)
    expect(result[0].sessionId).toBe('sess-1')
  })

  it('skips unparseable entries gracefully', async () => {
    const validEntry: SuspendedEntry = {
      ...makeWork({ sessionId: 'sess-1' }),
      suspendedAt: 1_700_000_000_000,
      suspendReason: 'test',
      lastEvaluatedAt: 1_700_000_000_000,
    }

    mockRedisHGetAll.mockResolvedValue({
      'sess-1': JSON.stringify(validEntry),
      'sess-bad': '{not valid json',
    })
    mockRedisHSet.mockResolvedValue(0)

    const result = await reevaluateSuspended()
    expect(result).toHaveLength(1)
    expect(result[0].sessionId).toBe('sess-1')
  })

  it('returns empty array on Redis error', async () => {
    mockRedisHGetAll.mockRejectedValue(new Error('connection lost'))

    const result = await reevaluateSuspended()
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// getQueueStats
// ---------------------------------------------------------------------------

describe('getQueueStats', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns zeros when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    const result = await getQueueStats()
    expect(result).toEqual({ active: 0, backoff: 0, suspended: 0 })
  })

  it('returns correct counts for all three tiers', async () => {
    mockRedisZCard
      .mockResolvedValueOnce(5)  // active
      .mockResolvedValueOnce(3)  // backoff
    mockRedisHLen.mockResolvedValueOnce(2) // suspended

    const result = await getQueueStats()

    expect(result).toEqual({ active: 5, backoff: 3, suspended: 2 })
    expect(mockRedisZCard).toHaveBeenCalledWith('work:queue')
    expect(mockRedisZCard).toHaveBeenCalledWith('work:backoff')
    expect(mockRedisHLen).toHaveBeenCalledWith('work:suspended')
  })

  it('returns zeros on Redis error', async () => {
    mockRedisZCard.mockRejectedValue(new Error('connection lost'))

    const result = await getQueueStats()
    expect(result).toEqual({ active: 0, backoff: 0, suspended: 0 })
  })
})

// ---------------------------------------------------------------------------
// calculateBackoff
// ---------------------------------------------------------------------------

describe('calculateBackoff', () => {
  it('returns value in expected range for attempt 0', () => {
    const result = calculateBackoff(0)
    // baseMs=5000, pow(2,0)=1, so 5000 + jitter(0-1000)
    expect(result).toBeGreaterThanOrEqual(5_000)
    expect(result).toBeLessThanOrEqual(6_000)
  })

  it('returns value in expected range for attempt 1', () => {
    const result = calculateBackoff(1)
    // baseMs=5000, pow(2,1)=2, so 10000 + jitter(0-1000)
    expect(result).toBeGreaterThanOrEqual(10_000)
    expect(result).toBeLessThanOrEqual(11_000)
  })

  it('returns value in expected range for attempt 2', () => {
    const result = calculateBackoff(2)
    // baseMs=5000, pow(2,2)=4, so 20000 + jitter(0-1000)
    expect(result).toBeGreaterThanOrEqual(20_000)
    expect(result).toBeLessThanOrEqual(21_000)
  })

  it('caps at maxMs (300_000) for high attempt counts', () => {
    const result = calculateBackoff(10)
    // baseMs * pow(2,10) = 5000 * 1024 = 5_120_000 > 300_000
    // So capped at 300_000 + jitter(0-1000)
    expect(result).toBeGreaterThanOrEqual(300_000)
    expect(result).toBeLessThanOrEqual(301_000)
  })

  it('caps at maxMs for very large attempt counts', () => {
    const result = calculateBackoff(100)
    expect(result).toBeGreaterThanOrEqual(300_000)
    expect(result).toBeLessThanOrEqual(301_000)
  })

  it('returns increasing values for successive attempts', () => {
    // Run multiple times and check the trend (with tolerance for jitter)
    const attempt0Values: number[] = []
    const attempt3Values: number[] = []

    for (let i = 0; i < 10; i++) {
      attempt0Values.push(calculateBackoff(0))
      attempt3Values.push(calculateBackoff(3))
    }

    const avg0 = attempt0Values.reduce((a, b) => a + b, 0) / attempt0Values.length
    const avg3 = attempt3Values.reduce((a, b) => a + b, 0) / attempt3Values.length

    // Attempt 3 average should be significantly higher than attempt 0 average
    expect(avg3).toBeGreaterThan(avg0 * 2)
  })
})

// ---------------------------------------------------------------------------
// moveToCompleted (REN-1397 — journal-first, then dequeue)
// ---------------------------------------------------------------------------

describe('moveToCompleted', () => {
  const mockWriteJournalEntry = vi.mocked(writeJournalEntry)

  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
    mockWriteJournalEntry.mockResolvedValue(true)
  })

  it('returns false when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    const result = await moveToCompleted('s1', 'step-1', {
      inputHash: 'h',
      outputCAS: 'cas://x',
      startedAt: 1,
    })
    expect(result).toBe(false)
    expect(mockWriteJournalEntry).not.toHaveBeenCalled()
  })

  it('writes the journal entry BEFORE dequeueing the work item', async () => {
    const order: string[] = []
    mockWriteJournalEntry.mockImplementation(async () => {
      order.push('journal')
      return true
    })

    const pipeline = makePipelineMock()
    pipeline.exec = vi.fn().mockImplementation(async () => {
      order.push('dequeue')
      return []
    })
    mockGetRedisClient.mockReturnValue({ pipeline: () => pipeline } as never)

    const ok = await moveToCompleted('sess-7', 'step-x', {
      inputHash: 'h-1',
      outputCAS: 'cas://result/7',
      startedAt: 100,
      completedAt: 200,
      attempt: 1,
    })

    expect(ok).toBe(true)
    expect(order).toEqual(['journal', 'dequeue'])
    expect(pipeline.zrem).toHaveBeenCalledWith('work:queue', 'sess-7')
    expect(pipeline.hdel).toHaveBeenCalledWith('work:items', 'sess-7')

    // Journal write captured all the result fields.
    expect(mockWriteJournalEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-7',
        stepId: 'step-x',
        status: 'completed',
        inputHash: 'h-1',
        outputCAS: 'cas://result/7',
        startedAt: 100,
        completedAt: 200,
        attempt: 1,
      })
    )
  })

  it('returns false (and does NOT dequeue) if the journal write fails', async () => {
    mockWriteJournalEntry.mockResolvedValue(false)

    const pipeline = makePipelineMock()
    mockGetRedisClient.mockReturnValue({ pipeline: () => pipeline } as never)

    const ok = await moveToCompleted('sess-8', 'step-x', {
      inputHash: 'h',
      outputCAS: 'cas://y',
      startedAt: 1,
    })

    expect(ok).toBe(false)
    expect(pipeline.exec).not.toHaveBeenCalled()
  })

  it('defaults completedAt to Date.now() when omitted', async () => {
    const pipeline = makePipelineMock()
    mockGetRedisClient.mockReturnValue({ pipeline: () => pipeline } as never)

    const before = Date.now()
    await moveToCompleted('sess-9', 'step-y', {
      inputHash: 'h',
      outputCAS: 'cas://z',
      startedAt: 1,
    })
    const after = Date.now()

    const args = mockWriteJournalEntry.mock.calls[0][0]
    expect(args.completedAt).toBeGreaterThanOrEqual(before)
    expect(args.completedAt).toBeLessThanOrEqual(after)
  })
})
