import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock redis before importing module under test
vi.mock('./redis.js', () => ({
  isRedisConfigured: vi.fn(() => true),
  redisSetNX: vi.fn(),
  redisGet: vi.fn(),
  redisDel: vi.fn(),
  redisExpire: vi.fn(),
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
  redisHGetAll: vi.fn(),
  redisHLen: vi.fn(() => 0),
  redisKeys: vi.fn(() => []),
  redisLRange: vi.fn(() => []),
  redisLLen: vi.fn(() => 0),
  redisLRem: vi.fn(),
}))

import {
  queueWork,
  peekWork,
  getQueueLength,
  claimWork,
  releaseClaim,
  getClaimOwner,
  isSessionInQueue,
  requeueWork,
  removeFromQueue,
} from './work-queue.js'
import type { QueuedWork } from './work-queue.js'
import {
  isRedisConfigured,
  redisSetNX,
  redisGet,
  redisDel,
  redisZAdd,
  redisZRem,
  redisZRangeByScore,
  redisZCard,
  redisHSet,
  redisHGet,
  redisHDel,
  redisHMGet,
} from './redis.js'

const mockIsRedisConfigured = vi.mocked(isRedisConfigured)
const mockRedisSetNX = vi.mocked(redisSetNX)
const mockRedisGet = vi.mocked(redisGet)
const mockRedisDel = vi.mocked(redisDel)
const mockRedisZAdd = vi.mocked(redisZAdd)
const mockRedisZRem = vi.mocked(redisZRem)
const mockRedisZRangeByScore = vi.mocked(redisZRangeByScore)
const mockRedisZCard = vi.mocked(redisZCard)
const mockRedisHSet = vi.mocked(redisHSet)
const mockRedisHGet = vi.mocked(redisHGet)
const mockRedisHDel = vi.mocked(redisHDel)
const mockRedisHMGet = vi.mocked(redisHMGet)

function makeWork(overrides: Partial<QueuedWork> = {}): QueuedWork {
  return {
    sessionId: 'session-1',
    issueId: 'issue-1',
    issueIdentifier: 'SUP-100',
    priority: 2,
    queuedAt: Date.now(),
    prompt: 'test prompt',
    workType: 'development',
    ...overrides,
  }
}

describe('queueWork', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns false when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    const result = await queueWork(makeWork())
    expect(result).toBe(false)
    expect(mockRedisHSet).not.toHaveBeenCalled()
    expect(mockRedisZAdd).not.toHaveBeenCalled()
  })

  it('stores work in hash and sorted set', async () => {
    const work = makeWork({ sessionId: 'sess-42', priority: 3 })
    mockRedisHSet.mockResolvedValue(1)
    mockRedisZAdd.mockResolvedValue(1)

    const result = await queueWork(work)

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

    const result = await queueWork(makeWork())
    expect(result).toBe(true)
  })

  it('returns false on Redis error', async () => {
    mockRedisHSet.mockRejectedValue(new Error('connection lost'))

    const result = await queueWork(makeWork())
    expect(result).toBe(false)
  })
})

describe('peekWork', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns empty array when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    const result = await peekWork()
    expect(result).toEqual([])
  })

  it('returns empty array when queue is empty', async () => {
    mockRedisZRangeByScore.mockResolvedValue([])
    const result = await peekWork()
    expect(result).toEqual([])
  })

  it('returns parsed work items sorted by priority', async () => {
    const work1 = makeWork({ sessionId: 'sess-1', priority: 1 })
    const work2 = makeWork({ sessionId: 'sess-2', priority: 3 })

    mockRedisZRangeByScore.mockResolvedValue(['sess-1', 'sess-2'])
    mockRedisHMGet.mockResolvedValue([JSON.stringify(work1), JSON.stringify(work2)])

    const result = await peekWork(10)

    expect(result).toHaveLength(2)
    expect(result[0].sessionId).toBe('sess-1')
    expect(result[1].sessionId).toBe('sess-2')
    expect(mockRedisZRangeByScore).toHaveBeenCalledWith(
      'work:queue',
      '-inf',
      '+inf',
      10
    )
    expect(mockRedisHMGet).toHaveBeenCalledWith('work:items', ['sess-1', 'sess-2'])
  })

  it('handles invalid JSON gracefully', async () => {
    const validWork = makeWork({ sessionId: 'sess-1' })

    mockRedisZRangeByScore.mockResolvedValue(['sess-1', 'sess-bad'])
    mockRedisHMGet.mockResolvedValue([JSON.stringify(validWork), '{not valid json'])

    const result = await peekWork()

    expect(result).toHaveLength(1)
    expect(result[0].sessionId).toBe('sess-1')
  })
})

describe('getQueueLength', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns 0 when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    const result = await getQueueLength()
    expect(result).toBe(0)
  })

  it('returns count from ZCARD', async () => {
    mockRedisZCard.mockResolvedValue(7)
    const result = await getQueueLength()
    expect(result).toBe(7)
    expect(mockRedisZCard).toHaveBeenCalledWith('work:queue')
  })
})

describe('claimWork', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns null when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    const result = await claimWork('session-1', 'worker-1')
    expect(result).toBeNull()
  })

  it('returns null when already claimed (SETNX returns false)', async () => {
    mockRedisSetNX.mockResolvedValue(false)

    const result = await claimWork('session-1', 'worker-1')

    expect(result).toBeNull()
    expect(mockRedisHGet).not.toHaveBeenCalled()
  })

  it('returns work item and removes from queue on successful claim', async () => {
    const work = makeWork({ sessionId: 'session-1' })

    mockRedisSetNX.mockResolvedValue(true)
    mockRedisHGet.mockResolvedValue(JSON.stringify(work))
    mockRedisZRem.mockResolvedValue(1)
    mockRedisHDel.mockResolvedValue(1)

    const result = await claimWork('session-1', 'worker-1')

    expect(result).toEqual(work)
    expect(mockRedisSetNX).toHaveBeenCalledWith(
      'work:claim:session-1',
      'worker-1',
      expect.any(Number)
    )
    expect(mockRedisZRem).toHaveBeenCalledWith('work:queue', 'session-1')
    expect(mockRedisHDel).toHaveBeenCalledWith('work:items', 'session-1')
  })

  it('returns null when work item not found in hash', async () => {
    mockRedisSetNX.mockResolvedValue(true)
    mockRedisHGet.mockResolvedValue(null)

    const result = await claimWork('session-1', 'worker-1')

    expect(result).toBeNull()
    // Should release the claim
    expect(mockRedisDel).toHaveBeenCalledWith('work:claim:session-1')
  })

  it('releases claim on error (cleanup behavior)', async () => {
    mockRedisSetNX.mockResolvedValue(true)
    mockRedisHGet.mockRejectedValue(new Error('Redis down'))

    const result = await claimWork('session-1', 'worker-1')

    expect(result).toBeNull()
    // Should clean up the claim key to prevent deadlock
    expect(mockRedisDel).toHaveBeenCalledWith('work:claim:session-1')
  })
})

describe('releaseClaim', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns false when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    const result = await releaseClaim('session-1')
    expect(result).toBe(false)
  })

  it('returns true when claim key deleted', async () => {
    mockRedisDel.mockResolvedValue(1)

    const result = await releaseClaim('session-1')

    expect(result).toBe(true)
    expect(mockRedisDel).toHaveBeenCalledWith('work:claim:session-1')
  })
})

describe('getClaimOwner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns null when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    const result = await getClaimOwner('session-1')
    expect(result).toBeNull()
  })

  it('returns worker ID from claim key', async () => {
    mockRedisGet.mockResolvedValue('worker-42')

    const result = await getClaimOwner('session-1')

    expect(result).toBe('worker-42')
    expect(mockRedisGet).toHaveBeenCalledWith('work:claim:session-1')
  })
})

describe('isSessionInQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns false when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    const result = await isSessionInQueue('session-1')
    expect(result).toBe(false)
  })

  it('returns true when session exists in hash', async () => {
    mockRedisHGet.mockResolvedValue(JSON.stringify(makeWork()))

    const result = await isSessionInQueue('session-1')

    expect(result).toBe(true)
    expect(mockRedisHGet).toHaveBeenCalledWith('work:items', 'session-1')
  })

  it('returns false when session not in hash', async () => {
    mockRedisHGet.mockResolvedValue(null)

    const result = await isSessionInQueue('session-1')
    expect(result).toBe(false)
  })
})

describe('requeueWork', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('re-queues with boosted priority', async () => {
    mockRedisDel.mockResolvedValue(1) // releaseClaim
    mockRedisHSet.mockResolvedValue(1)
    mockRedisZAdd.mockResolvedValue(1)

    const work = makeWork({ priority: 4 })
    const result = await requeueWork(work, 2)

    expect(result).toBe(true)
    // The re-queued item should have priority 4 - 2 = 2
    const storedJson = mockRedisHSet.mock.calls[0][2] as string
    const stored = JSON.parse(storedJson) as QueuedWork
    expect(stored.priority).toBe(2)
  })

  it('releases existing claim before re-queuing', async () => {
    mockRedisDel.mockResolvedValue(1)
    mockRedisHSet.mockResolvedValue(1)
    mockRedisZAdd.mockResolvedValue(1)

    const work = makeWork({ sessionId: 'sess-requeue' })
    await requeueWork(work)

    expect(mockRedisDel).toHaveBeenCalledWith('work:claim:sess-requeue')
  })

  it('clamps priority to minimum 1', async () => {
    mockRedisDel.mockResolvedValue(1)
    mockRedisHSet.mockResolvedValue(1)
    mockRedisZAdd.mockResolvedValue(1)

    const work = makeWork({ priority: 1 })
    const result = await requeueWork(work, 5)

    expect(result).toBe(true)
    const storedJson = mockRedisHSet.mock.calls[0][2] as string
    const stored = JSON.parse(storedJson) as QueuedWork
    expect(stored.priority).toBe(1)
  })
})

describe('removeFromQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns false when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    const result = await removeFromQueue('session-1')
    expect(result).toBe(false)
  })

  it('removes from both sorted set and hash', async () => {
    mockRedisZRem.mockResolvedValue(1)
    mockRedisHDel.mockResolvedValue(1)

    const result = await removeFromQueue('session-1')

    expect(result).toBe(true)
    expect(mockRedisZRem).toHaveBeenCalledWith('work:queue', 'session-1')
    expect(mockRedisHDel).toHaveBeenCalledWith('work:items', 'session-1')
  })
})
