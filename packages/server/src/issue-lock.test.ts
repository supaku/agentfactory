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
  redisZPopMin: vi.fn(),
  redisZCard: vi.fn(() => 0),
  redisHSet: vi.fn(),
  redisHGet: vi.fn(),
  redisHDel: vi.fn(),
  redisHGetAll: vi.fn(),
  redisKeys: vi.fn(() => []),
}))

vi.mock('./work-queue.js', () => ({
  queueWork: vi.fn(() => true),
}))

vi.mock('./session-storage.js', () => ({
  getSessionState: vi.fn(),
}))

import {
  clearAllParkedWork,
  parkWorkForIssue,
  promoteNextPendingWork,
} from './issue-lock.js'
import {
  isRedisConfigured,
  redisDel,
  redisZCard,
  redisZPopMin,
  redisHGet,
  redisHDel,
  redisZAdd,
  redisHSet,
  redisExpire,
} from './redis.js'
import type { QueuedWork } from './work-queue.js'

const mockIsRedisConfigured = vi.mocked(isRedisConfigured)
const mockRedisDel = vi.mocked(redisDel)
const mockRedisZCard = vi.mocked(redisZCard)
const mockRedisZPopMin = vi.mocked(redisZPopMin)
const mockRedisHGet = vi.mocked(redisHGet)
const mockRedisHDel = vi.mocked(redisHDel)

function makeWork(overrides: Partial<QueuedWork> = {}): QueuedWork {
  return {
    sessionId: 'session-1',
    issueId: 'issue-1',
    issueIdentifier: 'SUP-100',
    priority: 2,
    queuedAt: Date.now(),
    prompt: 'test prompt',
    workType: 'qa',
    ...overrides,
  }
}

describe('clearAllParkedWork', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns 0 when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    const result = await clearAllParkedWork('issue-1')
    expect(result).toBe(0)
    expect(mockRedisDel).not.toHaveBeenCalled()
  })

  it('returns 0 when no parked work exists', async () => {
    mockRedisZCard.mockResolvedValue(0)
    const result = await clearAllParkedWork('issue-1')
    expect(result).toBe(0)
    expect(mockRedisDel).not.toHaveBeenCalled()
  })

  it('clears a single parked item', async () => {
    mockRedisZCard.mockResolvedValue(1)
    mockRedisDel.mockResolvedValue(1)

    const result = await clearAllParkedWork('issue-1')
    expect(result).toBe(1)
    expect(mockRedisDel).toHaveBeenCalledWith('issue:pending:issue-1')
    expect(mockRedisDel).toHaveBeenCalledWith('issue:pending:items:issue-1')
  })

  it('clears multiple parked items', async () => {
    mockRedisZCard.mockResolvedValue(3)
    mockRedisDel.mockResolvedValue(1)

    const result = await clearAllParkedWork('issue-1')
    expect(result).toBe(3)
    expect(mockRedisDel).toHaveBeenCalledTimes(2)
  })

  it('promoteNextPendingWork returns null after clear', async () => {
    // First park some work
    vi.mocked(redisZAdd).mockResolvedValue(1)
    vi.mocked(redisHSet).mockResolvedValue(1)
    vi.mocked(redisExpire).mockResolvedValue(true)
    await parkWorkForIssue('issue-1', makeWork())

    // Clear it
    mockRedisZCard.mockResolvedValue(1)
    mockRedisDel.mockResolvedValue(1)
    await clearAllParkedWork('issue-1')

    // Promote should find nothing
    mockRedisZPopMin.mockResolvedValue(null)
    const promoted = await promoteNextPendingWork('issue-1')
    expect(promoted).toBeNull()
  })
})
