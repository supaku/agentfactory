import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock redis before importing module under test
vi.mock('./redis.js', () => ({
  isRedisConfigured: vi.fn(() => true),
  redisZAdd: vi.fn(),
  redisZRem: vi.fn(),
  redisZRangeByScore: vi.fn(() => []),
  redisZCard: vi.fn(() => 0),
  redisZPopMin: vi.fn(),
  redisHSet: vi.fn(),
  redisHGet: vi.fn(),
  redisHDel: vi.fn(),
  redisHGetAll: vi.fn(() => ({})),
  redisHLen: vi.fn(() => 0),
  redisSet: vi.fn(),
  redisGet: vi.fn(),
  redisDel: vi.fn(),
  redisExpire: vi.fn(),
  redisRPush: vi.fn(),
  redisEval: vi.fn(),
}))

import {
  MergeQueueStorage,
  calculateMergeScore,
} from './merge-queue-storage.js'
import type { MergeQueueEntry } from './merge-queue-storage.js'
import {
  isRedisConfigured,
  redisZAdd,
  redisZRem,
  redisZRangeByScore,
  redisZCard,
  redisZPopMin,
  redisHSet,
  redisHGet,
  redisHDel,
  redisHGetAll,
  redisHLen,
  redisSet,
  redisGet,
  redisDel,
  redisEval,
} from './redis.js'

const mockIsRedisConfigured = vi.mocked(isRedisConfigured)
const mockRedisZAdd = vi.mocked(redisZAdd)
const mockRedisZRem = vi.mocked(redisZRem)
const mockRedisZRangeByScore = vi.mocked(redisZRangeByScore)
const mockRedisZCard = vi.mocked(redisZCard)
const mockRedisZPopMin = vi.mocked(redisZPopMin)
const mockRedisHSet = vi.mocked(redisHSet)
const mockRedisHGet = vi.mocked(redisHGet)
const mockRedisHDel = vi.mocked(redisHDel)
const mockRedisHGetAll = vi.mocked(redisHGetAll)
const mockRedisHLen = vi.mocked(redisHLen)
const mockRedisSet = vi.mocked(redisSet)
const mockRedisGet = vi.mocked(redisGet)
const mockRedisDel = vi.mocked(redisDel)
const mockRedisEval = vi.mocked(redisEval)

function makeEntry(overrides: Partial<MergeQueueEntry> = {}): MergeQueueEntry {
  return {
    repoId: 'repo-1',
    prNumber: 42,
    prUrl: 'https://github.com/org/repo/pull/42',
    issueIdentifier: 'SUP-100',
    priority: 2,
    enqueuedAt: 1700000000000,
    sourceBranch: 'feature/my-branch',
    targetBranch: 'main',
    ...overrides,
  }
}

let storage: MergeQueueStorage

beforeEach(() => {
  vi.clearAllMocks()
  mockIsRedisConfigured.mockReturnValue(true)
  storage = new MergeQueueStorage()
})

// ============================================
// calculateMergeScore
// ============================================

describe('calculateMergeScore', () => {
  it('returns priority * 1e13 + timestamp', () => {
    const score = calculateMergeScore(2, 1700000000000)
    expect(score).toBe(2 * 1e13 + 1700000000000)
  })

  it('lower priority number = lower score = higher priority in queue', () => {
    const ts = 1700000000000
    const score1 = calculateMergeScore(1, ts)
    const score2 = calculateMergeScore(3, ts)
    expect(score1).toBeLessThan(score2)
  })

  it('clamps priority to 1-5 range', () => {
    const ts = 1700000000000
    expect(calculateMergeScore(0, ts)).toBe(1 * 1e13 + ts) // clamped to 1
    expect(calculateMergeScore(10, ts)).toBe(5 * 1e13 + ts) // clamped to 5
  })

  it('uses timestamp as tiebreaker within same priority', () => {
    const score1 = calculateMergeScore(2, 1000)
    const score2 = calculateMergeScore(2, 2000)
    expect(score1).toBeLessThan(score2)
  })
})

// ============================================
// enqueue
// ============================================

describe('enqueue', () => {
  it('adds entry to sorted set and hash', async () => {
    mockRedisHSet.mockResolvedValue(1)
    mockRedisZAdd.mockResolvedValue(1)

    const entry = makeEntry({ prNumber: 42, priority: 2, enqueuedAt: 1700000000000 })
    await storage.enqueue(entry)

    expect(mockRedisHSet).toHaveBeenCalledWith(
      'merge:items:repo-1',
      '42',
      JSON.stringify(entry)
    )
    expect(mockRedisZAdd).toHaveBeenCalledWith(
      'merge:queue:repo-1',
      2 * 1e13 + 1700000000000,
      '42'
    )
  })

  it('does nothing when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    await storage.enqueue(makeEntry())
    expect(mockRedisHSet).not.toHaveBeenCalled()
    expect(mockRedisZAdd).not.toHaveBeenCalled()
  })

  it('throws on Redis error', async () => {
    mockRedisHSet.mockRejectedValue(new Error('connection lost'))
    await expect(storage.enqueue(makeEntry())).rejects.toThrow('connection lost')
  })
})

// ============================================
// dequeue
// ============================================

describe('dequeue', () => {
  it('returns lowest-score item and sets processing key with TTL', async () => {
    const entry = makeEntry({ prNumber: 42 })

    mockRedisZPopMin.mockResolvedValue({ member: '42', score: 2e13 + 1700000000000 })
    mockRedisHGet.mockResolvedValue(JSON.stringify(entry))
    mockRedisHDel.mockResolvedValue(1)
    mockRedisSet.mockResolvedValue(undefined)

    const result = await storage.dequeue('repo-1')

    expect(result).toEqual(entry)
    expect(mockRedisZPopMin).toHaveBeenCalledWith('merge:queue:repo-1')
    expect(mockRedisHGet).toHaveBeenCalledWith('merge:items:repo-1', '42')
    expect(mockRedisHDel).toHaveBeenCalledWith('merge:items:repo-1', '42')
    expect(mockRedisSet).toHaveBeenCalledWith(
      'merge:processing:repo-1',
      entry,
      1800 // default 30 min TTL
    )
  })

  it('returns null on empty queue', async () => {
    mockRedisZPopMin.mockResolvedValue(null)

    const result = await storage.dequeue('repo-1')

    expect(result).toBeNull()
    expect(mockRedisHGet).not.toHaveBeenCalled()
  })

  it('returns null when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)

    const result = await storage.dequeue('repo-1')
    expect(result).toBeNull()
  })

  it('returns null when entry not found in hash after zpopmin', async () => {
    mockRedisZPopMin.mockResolvedValue({ member: '99', score: 1e13 })
    mockRedisHGet.mockResolvedValue(null)

    const result = await storage.dequeue('repo-1')

    expect(result).toBeNull()
  })

  it('accepts custom TTL', async () => {
    const entry = makeEntry({ prNumber: 42 })

    mockRedisZPopMin.mockResolvedValue({ member: '42', score: 2e13 })
    mockRedisHGet.mockResolvedValue(JSON.stringify(entry))
    mockRedisHDel.mockResolvedValue(1)
    mockRedisSet.mockResolvedValue(undefined)

    await storage.dequeue('repo-1', 600)

    expect(mockRedisSet).toHaveBeenCalledWith(
      'merge:processing:repo-1',
      entry,
      600
    )
  })
})

// ============================================
// peek
// ============================================

describe('peek', () => {
  it('returns next item without removing', async () => {
    const entry = makeEntry({ prNumber: 42 })

    mockRedisZRangeByScore.mockResolvedValue(['42'])
    mockRedisHGet.mockResolvedValue(JSON.stringify(entry))

    const result = await storage.peek('repo-1')

    expect(result).toEqual(entry)
    expect(mockRedisZRangeByScore).toHaveBeenCalledWith(
      'merge:queue:repo-1',
      '-inf',
      '+inf',
      1
    )
    // Should NOT remove from queue
    expect(mockRedisZRem).not.toHaveBeenCalled()
    expect(mockRedisHDel).not.toHaveBeenCalled()
    expect(mockRedisZPopMin).not.toHaveBeenCalled()
  })

  it('returns null on empty queue', async () => {
    mockRedisZRangeByScore.mockResolvedValue([])

    const result = await storage.peek('repo-1')
    expect(result).toBeNull()
  })

  it('returns null when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)

    const result = await storage.peek('repo-1')
    expect(result).toBeNull()
  })
})

// ============================================
// reorder
// ============================================

describe('reorder', () => {
  it('updates score and entry for a PR', async () => {
    const entry = makeEntry({ prNumber: 42, priority: 2, enqueuedAt: 1700000000000 })

    mockRedisHGet.mockResolvedValue(JSON.stringify(entry))
    mockRedisHSet.mockResolvedValue(0)
    mockRedisZAdd.mockResolvedValue(0)

    await storage.reorder('repo-1', 42, 1)

    // Should update priority in hash
    const updatedEntry = { ...entry, priority: 1 }
    expect(mockRedisHSet).toHaveBeenCalledWith(
      'merge:items:repo-1',
      '42',
      JSON.stringify(updatedEntry)
    )

    // Should update score in sorted set
    expect(mockRedisZAdd).toHaveBeenCalledWith(
      'merge:queue:repo-1',
      1 * 1e13 + 1700000000000,
      '42'
    )
  })

  it('does nothing when entry not found', async () => {
    mockRedisHGet.mockResolvedValue(null)

    await storage.reorder('repo-1', 999, 1)

    expect(mockRedisHSet).not.toHaveBeenCalled()
    expect(mockRedisZAdd).not.toHaveBeenCalled()
  })
})

// ============================================
// markCompleted
// ============================================

describe('markCompleted', () => {
  it('removes from processing and adds to history', async () => {
    mockRedisDel.mockResolvedValue(1)
    mockRedisEval.mockResolvedValue(1)

    await storage.markCompleted('repo-1', 42)

    expect(mockRedisDel).toHaveBeenCalledWith('merge:processing:repo-1')
    expect(mockRedisEval).toHaveBeenCalledWith(
      expect.any(String), // Lua script
      ['merge:history:repo-1'],
      [expect.stringContaining('"prNumber":42'), 100]
    )
  })

  it('does nothing when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)

    await storage.markCompleted('repo-1', 42)

    expect(mockRedisDel).not.toHaveBeenCalled()
    expect(mockRedisEval).not.toHaveBeenCalled()
  })
})

// ============================================
// markFailed
// ============================================

describe('markFailed', () => {
  it('moves processing entry to failed hash with reason', async () => {
    const entry = makeEntry({ prNumber: 42 })

    mockRedisGet.mockResolvedValue(entry)
    mockRedisDel.mockResolvedValue(1)
    mockRedisHSet.mockResolvedValue(1)

    await storage.markFailed('repo-1', 42, 'CI checks failed')

    // Should remove from processing
    expect(mockRedisDel).toHaveBeenCalledWith('merge:processing:repo-1')

    // Should add to failed hash
    expect(mockRedisHSet).toHaveBeenCalledWith(
      'merge:failed:repo-1',
      '42',
      JSON.stringify({ entry, reason: 'CI checks failed' })
    )
  })

  it('stores in failed hash even without processing entry', async () => {
    mockRedisGet.mockResolvedValue(null)
    mockRedisHSet.mockResolvedValue(1)

    await storage.markFailed('repo-1', 42, 'CI checks failed')

    // Should NOT try to delete processing
    expect(mockRedisDel).not.toHaveBeenCalled()

    // Should still add to failed hash (entry will be null)
    expect(mockRedisHSet).toHaveBeenCalledWith(
      'merge:failed:repo-1',
      '42',
      JSON.stringify({ entry: null, reason: 'CI checks failed' })
    )
  })

  it('does not remove processing when prNumber does not match', async () => {
    const entry = makeEntry({ prNumber: 99 }) // different PR
    mockRedisGet.mockResolvedValue(entry)
    mockRedisHSet.mockResolvedValue(1)

    await storage.markFailed('repo-1', 42, 'CI checks failed')

    // Should NOT delete processing (different PR)
    expect(mockRedisDel).not.toHaveBeenCalled()
  })
})

// ============================================
// markBlocked
// ============================================

describe('markBlocked', () => {
  it('moves processing entry to blocked hash with reason', async () => {
    const entry = makeEntry({ prNumber: 42 })

    mockRedisGet.mockResolvedValue(entry)
    mockRedisDel.mockResolvedValue(1)
    mockRedisHSet.mockResolvedValue(1)

    await storage.markBlocked('repo-1', 42, 'Merge conflict with PR #40')

    // Should remove from processing
    expect(mockRedisDel).toHaveBeenCalledWith('merge:processing:repo-1')

    // Should add to blocked hash
    expect(mockRedisHSet).toHaveBeenCalledWith(
      'merge:blocked:repo-1',
      '42',
      JSON.stringify({ entry, reason: 'Merge conflict with PR #40' })
    )
  })

  it('stores in blocked hash even without processing entry', async () => {
    mockRedisGet.mockResolvedValue(null)
    mockRedisHSet.mockResolvedValue(1)

    await storage.markBlocked('repo-1', 42, 'Merge conflict')

    expect(mockRedisDel).not.toHaveBeenCalled()
    expect(mockRedisHSet).toHaveBeenCalledWith(
      'merge:blocked:repo-1',
      '42',
      JSON.stringify({ entry: null, reason: 'Merge conflict' })
    )
  })
})

// ============================================
// getStatus
// ============================================

describe('getStatus', () => {
  it('returns correct depth, processing, failed/blocked counts', async () => {
    const processingEntry = makeEntry({ prNumber: 10 })

    mockRedisZCard.mockResolvedValue(5)
    mockRedisGet.mockResolvedValue(processingEntry)
    mockRedisHLen.mockResolvedValueOnce(2) // failed count
    mockRedisHLen.mockResolvedValueOnce(1) // blocked count

    const status = await storage.getStatus('repo-1')

    expect(status).toEqual({
      depth: 5,
      processing: processingEntry,
      failedCount: 2,
      blockedCount: 1,
    })

    expect(mockRedisZCard).toHaveBeenCalledWith('merge:queue:repo-1')
    expect(mockRedisGet).toHaveBeenCalledWith('merge:processing:repo-1')
    expect(mockRedisHLen).toHaveBeenCalledWith('merge:failed:repo-1')
    expect(mockRedisHLen).toHaveBeenCalledWith('merge:blocked:repo-1')
  })

  it('returns null processing when nothing is processing', async () => {
    mockRedisZCard.mockResolvedValue(0)
    mockRedisGet.mockResolvedValue(null)
    mockRedisHLen.mockResolvedValue(0)

    const status = await storage.getStatus('repo-1')

    expect(status.processing).toBeNull()
    expect(status.depth).toBe(0)
    expect(status.failedCount).toBe(0)
    expect(status.blockedCount).toBe(0)
  })

  it('returns defaults when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)

    const status = await storage.getStatus('repo-1')

    expect(status).toEqual({
      depth: 0,
      processing: null,
      failedCount: 0,
      blockedCount: 0,
    })
  })
})

// ============================================
// retry
// ============================================

describe('retry', () => {
  it('moves from failed back to queue', async () => {
    const entry = makeEntry({ prNumber: 42, enqueuedAt: 1700000000000 })
    const failedData = JSON.stringify({ entry, reason: 'CI failed' })

    mockRedisHGet.mockResolvedValueOnce(failedData) // failed lookup
    mockRedisHDel.mockResolvedValue(1)
    // For the re-enqueue via this.enqueue()
    mockRedisHSet.mockResolvedValue(1)
    mockRedisZAdd.mockResolvedValue(1)

    await storage.retry('repo-1', 42)

    // Should remove from failed hash
    expect(mockRedisHDel).toHaveBeenCalledWith('merge:failed:repo-1', '42')

    // Should re-enqueue (via enqueue method)
    expect(mockRedisHSet).toHaveBeenCalledWith(
      'merge:items:repo-1',
      '42',
      expect.any(String)
    )
    expect(mockRedisZAdd).toHaveBeenCalledWith(
      'merge:queue:repo-1',
      expect.any(Number),
      '42'
    )
  })

  it('moves from blocked back to queue', async () => {
    const entry = makeEntry({ prNumber: 42 })
    const blockedData = JSON.stringify({ entry, reason: 'Merge conflict' })

    mockRedisHGet.mockResolvedValueOnce(null) // not in failed
    mockRedisHGet.mockResolvedValueOnce(blockedData) // found in blocked
    mockRedisHDel.mockResolvedValue(1)
    mockRedisHSet.mockResolvedValue(1)
    mockRedisZAdd.mockResolvedValue(1)

    await storage.retry('repo-1', 42)

    // Should remove from blocked hash
    expect(mockRedisHDel).toHaveBeenCalledWith('merge:blocked:repo-1', '42')

    // Should re-enqueue
    expect(mockRedisZAdd).toHaveBeenCalled()
  })

  it('does nothing when entry not found in failed or blocked', async () => {
    mockRedisHGet.mockResolvedValue(null) // not in failed or blocked

    await storage.retry('repo-1', 999)

    expect(mockRedisHDel).not.toHaveBeenCalled()
    expect(mockRedisHSet).not.toHaveBeenCalled()
    expect(mockRedisZAdd).not.toHaveBeenCalled()
  })
})

// ============================================
// skip
// ============================================

describe('skip', () => {
  it('removes from queue entirely', async () => {
    mockRedisZRem.mockResolvedValue(1)
    mockRedisHDel.mockResolvedValue(1)

    await storage.skip('repo-1', 42)

    expect(mockRedisZRem).toHaveBeenCalledWith('merge:queue:repo-1', '42')
    expect(mockRedisHDel).toHaveBeenCalledWith('merge:items:repo-1', '42')
  })

  it('does nothing when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)

    await storage.skip('repo-1', 42)

    expect(mockRedisZRem).not.toHaveBeenCalled()
    expect(mockRedisHDel).not.toHaveBeenCalled()
  })
})

// ============================================
// list
// ============================================

describe('list', () => {
  it('returns all entries ordered by score', async () => {
    const entry1 = makeEntry({ prNumber: 10, priority: 1 })
    const entry2 = makeEntry({ prNumber: 20, priority: 3 })

    mockRedisZRangeByScore.mockResolvedValue(['10', '20'])
    mockRedisHGet.mockResolvedValueOnce(JSON.stringify(entry1))
    mockRedisHGet.mockResolvedValueOnce(JSON.stringify(entry2))

    const result = await storage.list('repo-1')

    expect(result).toHaveLength(2)
    expect(result[0].prNumber).toBe(10)
    expect(result[1].prNumber).toBe(20)
    expect(mockRedisZRangeByScore).toHaveBeenCalledWith(
      'merge:queue:repo-1',
      '-inf',
      '+inf'
    )
  })

  it('returns empty array on empty queue', async () => {
    mockRedisZRangeByScore.mockResolvedValue([])

    const result = await storage.list('repo-1')
    expect(result).toEqual([])
  })

  it('returns empty array when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)

    const result = await storage.list('repo-1')
    expect(result).toEqual([])
  })

  it('skips entries with invalid JSON', async () => {
    const validEntry = makeEntry({ prNumber: 10 })

    mockRedisZRangeByScore.mockResolvedValue(['10', '20'])
    mockRedisHGet.mockResolvedValueOnce(JSON.stringify(validEntry))
    mockRedisHGet.mockResolvedValueOnce('{invalid json')

    const result = await storage.list('repo-1')

    expect(result).toHaveLength(1)
    expect(result[0].prNumber).toBe(10)
  })
})

// ============================================
// listFailed
// ============================================

describe('listFailed', () => {
  it('returns all failed entries with failure reasons', async () => {
    const entry = makeEntry({ prNumber: 42 })

    mockRedisHGetAll.mockResolvedValue({
      '42': JSON.stringify({ entry, reason: 'CI checks failed' }),
    })

    const result = await storage.listFailed('repo-1')

    expect(result).toHaveLength(1)
    expect(result[0].prNumber).toBe(42)
    expect(result[0].failureReason).toBe('CI checks failed')
    expect(mockRedisHGetAll).toHaveBeenCalledWith('merge:failed:repo-1')
  })

  it('returns empty array when no failed entries', async () => {
    mockRedisHGetAll.mockResolvedValue({})

    const result = await storage.listFailed('repo-1')
    expect(result).toEqual([])
  })

  it('returns empty array when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)

    const result = await storage.listFailed('repo-1')
    expect(result).toEqual([])
  })
})

// ============================================
// listBlocked
// ============================================

describe('listBlocked', () => {
  it('returns all blocked entries with block reasons', async () => {
    const entry = makeEntry({ prNumber: 42 })

    mockRedisHGetAll.mockResolvedValue({
      '42': JSON.stringify({ entry, reason: 'Merge conflict with PR #40' }),
    })

    const result = await storage.listBlocked('repo-1')

    expect(result).toHaveLength(1)
    expect(result[0].prNumber).toBe(42)
    expect(result[0].blockReason).toBe('Merge conflict with PR #40')
    expect(mockRedisHGetAll).toHaveBeenCalledWith('merge:blocked:repo-1')
  })

  it('returns empty array when no blocked entries', async () => {
    mockRedisHGetAll.mockResolvedValue({})

    const result = await storage.listBlocked('repo-1')
    expect(result).toEqual([])
  })

  it('returns empty array when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)

    const result = await storage.listBlocked('repo-1')
    expect(result).toEqual([])
  })
})
