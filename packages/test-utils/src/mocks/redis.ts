import { vi } from 'vitest'

export function createRedisMock() {
  return {
    isRedisConfigured: vi.fn().mockReturnValue(true),
    redisSet: vi.fn().mockResolvedValue(undefined),
    redisGet: vi.fn().mockResolvedValue(null),
    redisDel: vi.fn().mockResolvedValue(0),
    redisExists: vi.fn().mockResolvedValue(false),
    redisKeys: vi.fn().mockResolvedValue([]),
    redisExpire: vi.fn().mockResolvedValue(false),
    redisSetNX: vi.fn().mockResolvedValue(false),
    redisRPush: vi.fn().mockResolvedValue(0),
    redisLPop: vi.fn().mockResolvedValue(null),
    redisLRange: vi.fn().mockResolvedValue([]),
    redisLLen: vi.fn().mockResolvedValue(0),
    redisLRem: vi.fn().mockResolvedValue(0),
    redisSAdd: vi.fn().mockResolvedValue(0),
    redisSRem: vi.fn().mockResolvedValue(0),
    redisSMembers: vi.fn().mockResolvedValue([]),
    redisSCard: vi.fn().mockResolvedValue(0),
    redisZAdd: vi.fn().mockResolvedValue(0),
    redisZRem: vi.fn().mockResolvedValue(0),
    redisZRangeByScore: vi.fn().mockResolvedValue([]),
    redisZCard: vi.fn().mockResolvedValue(0),
    redisZPopMin: vi.fn().mockResolvedValue(null),
    redisHSet: vi.fn().mockResolvedValue(0),
    redisHGet: vi.fn().mockResolvedValue(null),
    redisHDel: vi.fn().mockResolvedValue(0),
    redisHMGet: vi.fn().mockResolvedValue([]),
    redisHGetAll: vi.fn().mockResolvedValue({}),
    redisHLen: vi.fn().mockResolvedValue(0),
  }
}
