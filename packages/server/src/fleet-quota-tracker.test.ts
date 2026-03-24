import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./redis.js', () => ({
  redisSAdd: vi.fn(),
  redisSRem: vi.fn(),
  redisSCard: vi.fn(() => 0),
  redisSMembers: vi.fn(() => []),
  redisIncrByFloat: vi.fn(() => 0),
  redisGet: vi.fn(),
  redisExpire: vi.fn(),
  redisExists: vi.fn(() => false),
}))

vi.mock('./fleet-quota-storage.js', () => ({
  getCohortConfig: vi.fn(),
}))

import {
  addConcurrentSession,
  removeConcurrentSession,
  getConcurrentSessionCount,
  getConcurrentSessionIds,
  addDailyCost,
  getDailyCost,
  getDailyCostForDate,
  getQuotaUsage,
  getCohortUsage,
  cleanupStaleSessions,
} from './fleet-quota-tracker.js'
import {
  redisSAdd,
  redisSRem,
  redisSCard,
  redisSMembers,
  redisIncrByFloat,
  redisGet,
  redisExpire,
  redisExists,
} from './redis.js'
import { getCohortConfig } from './fleet-quota-storage.js'

const mockRedisSAdd = vi.mocked(redisSAdd)
const mockRedisSRem = vi.mocked(redisSRem)
const mockRedisSCard = vi.mocked(redisSCard)
const mockRedisSMembers = vi.mocked(redisSMembers)
const mockRedisIncrByFloat = vi.mocked(redisIncrByFloat)
const mockRedisGet = vi.mocked(redisGet)
const mockRedisExpire = vi.mocked(redisExpire)
const mockRedisExists = vi.mocked(redisExists)
const mockGetCohortConfig = vi.mocked(getCohortConfig)

describe('addConcurrentSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('adds session to Redis set and returns count', async () => {
    mockRedisSAdd.mockResolvedValue(1)
    mockRedisSCard.mockResolvedValue(3)

    const count = await addConcurrentSession('team-alpha', 'sess-1')

    expect(count).toBe(3)
    expect(mockRedisSAdd).toHaveBeenCalledWith(
      'fleet:quota:concurrent:team-alpha',
      'sess-1'
    )
    expect(mockRedisSCard).toHaveBeenCalledWith(
      'fleet:quota:concurrent:team-alpha'
    )
  })
})

describe('removeConcurrentSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('removes session from Redis set and returns count', async () => {
    mockRedisSRem.mockResolvedValue(1)
    mockRedisSCard.mockResolvedValue(2)

    const count = await removeConcurrentSession('team-alpha', 'sess-1')

    expect(count).toBe(2)
    expect(mockRedisSRem).toHaveBeenCalledWith(
      'fleet:quota:concurrent:team-alpha',
      'sess-1'
    )
  })

  it('is idempotent — removing non-member returns current count', async () => {
    mockRedisSRem.mockResolvedValue(0)
    mockRedisSCard.mockResolvedValue(5)

    const count = await removeConcurrentSession('team-alpha', 'nonexistent')
    expect(count).toBe(5)
  })
})

describe('getConcurrentSessionCount', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns count from SCARD', async () => {
    mockRedisSCard.mockResolvedValue(7)

    const count = await getConcurrentSessionCount('team-alpha')
    expect(count).toBe(7)
  })
})

describe('getConcurrentSessionIds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns members from SMEMBERS', async () => {
    mockRedisSMembers.mockResolvedValue(['sess-1', 'sess-2'])

    const ids = await getConcurrentSessionIds('team-alpha')
    expect(ids).toEqual(['sess-1', 'sess-2'])
  })
})

describe('addDailyCost', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('increments daily cost and sets TTL on first write', async () => {
    mockRedisExists.mockResolvedValue(false)
    mockRedisIncrByFloat.mockResolvedValue(5.5)
    mockRedisExpire.mockResolvedValue(true)

    const total = await addDailyCost('team-alpha', 5.5)

    expect(total).toBe(5.5)
    expect(mockRedisIncrByFloat).toHaveBeenCalledWith(
      expect.stringContaining('fleet:quota:daily:team-alpha:'),
      5.5
    )
    expect(mockRedisExpire).toHaveBeenCalledWith(
      expect.stringContaining('fleet:quota:daily:team-alpha:'),
      48 * 60 * 60
    )
  })

  it('does not reset TTL on subsequent writes', async () => {
    mockRedisExists.mockResolvedValue(true)
    mockRedisIncrByFloat.mockResolvedValue(10.0)

    const total = await addDailyCost('team-alpha', 4.5)

    expect(total).toBe(10.0)
    expect(mockRedisExpire).not.toHaveBeenCalled()
  })
})

describe('getDailyCost', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns parsed cost from Redis', async () => {
    mockRedisGet.mockResolvedValue('42.5')

    const cost = await getDailyCost('team-alpha')
    expect(cost).toBe(42.5)
  })

  it('returns 0 when no cost exists', async () => {
    mockRedisGet.mockResolvedValue(null)

    const cost = await getDailyCost('team-alpha')
    expect(cost).toBe(0)
  })
})

describe('getDailyCostForDate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('fetches cost for a specific date', async () => {
    mockRedisGet.mockResolvedValue('99.99')

    const cost = await getDailyCostForDate('team-alpha', '2026-03-20')

    expect(cost).toBe(99.99)
    expect(mockRedisGet).toHaveBeenCalledWith(
      'fleet:quota:daily:team-alpha:2026-03-20'
    )
  })
})

describe('getQuotaUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns combined usage snapshot', async () => {
    mockRedisSCard.mockResolvedValue(3)
    mockRedisGet.mockResolvedValue('15.5')

    const usage = await getQuotaUsage('team-alpha')

    expect(usage).toEqual({
      currentSessions: 3,
      dailyCostUsd: 15.5,
      lastResetAt: 0,
    })
  })
})

describe('getCohortUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns usage for all projects in a cohort', async () => {
    mockGetCohortConfig.mockResolvedValue({
      name: 'engineering',
      projects: ['alpha', 'beta'],
    })

    // alpha: 2 sessions, $10
    // beta: 1 session, $5
    mockRedisSCard
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)
    mockRedisGet
      .mockResolvedValueOnce('10')
      .mockResolvedValueOnce('5')

    const usageMap = await getCohortUsage('engineering')

    expect(usageMap.size).toBe(2)
    expect(usageMap.get('alpha')).toEqual({
      currentSessions: 2,
      dailyCostUsd: 10,
      lastResetAt: 0,
    })
    expect(usageMap.get('beta')).toEqual({
      currentSessions: 1,
      dailyCostUsd: 5,
      lastResetAt: 0,
    })
  })

  it('returns empty map when cohort does not exist', async () => {
    mockGetCohortConfig.mockResolvedValue(null)

    const usageMap = await getCohortUsage('nonexistent')
    expect(usageMap.size).toBe(0)
  })
})

describe('cleanupStaleSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('removes sessions not in active set', async () => {
    mockRedisSMembers.mockResolvedValue(['sess-1', 'sess-2', 'sess-3'])
    mockRedisSRem.mockResolvedValue(1)
    mockRedisSCard.mockResolvedValue(1)

    const activeIds = new Set(['sess-1'])
    const removed = await cleanupStaleSessions('team-alpha', activeIds)

    expect(removed).toBe(2)
    expect(mockRedisSRem).toHaveBeenCalledWith(
      'fleet:quota:concurrent:team-alpha',
      'sess-2'
    )
    expect(mockRedisSRem).toHaveBeenCalledWith(
      'fleet:quota:concurrent:team-alpha',
      'sess-3'
    )
  })

  it('returns 0 when all sessions are active', async () => {
    mockRedisSMembers.mockResolvedValue(['sess-1', 'sess-2'])

    const activeIds = new Set(['sess-1', 'sess-2'])
    const removed = await cleanupStaleSessions('team-alpha', activeIds)

    expect(removed).toBe(0)
    expect(mockRedisSRem).not.toHaveBeenCalled()
  })

  it('returns 0 when concurrent set is empty', async () => {
    mockRedisSMembers.mockResolvedValue([])

    const removed = await cleanupStaleSessions('team-alpha', new Set())
    expect(removed).toBe(0)
  })
})
