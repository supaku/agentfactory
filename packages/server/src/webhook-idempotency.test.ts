import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock redis before importing module under test
vi.mock('./redis.js', () => ({
  isRedisConfigured: vi.fn(() => true),
  redisSet: vi.fn(),
  redisExists: vi.fn(() => false),
  redisDel: vi.fn(),
}))

import {
  generateIdempotencyKey,
  isWebhookProcessed,
  markWebhookProcessed,
  unmarkWebhookProcessed,
  getCacheStats,
} from './webhook-idempotency.js'
import { isRedisConfigured, redisSet, redisExists, redisDel } from './redis.js'

const mockIsRedisConfigured = vi.mocked(isRedisConfigured)
const mockRedisSet = vi.mocked(redisSet)
const mockRedisExists = vi.mocked(redisExists)
const mockRedisDel = vi.mocked(redisDel)

describe('webhook-idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
    mockRedisExists.mockResolvedValue(false)
  })

  describe('generateIdempotencyKey', () => {
    it('prefers webhookId with wh: prefix', () => {
      const key = generateIdempotencyKey('wh-123', 'sess-1')
      expect(key).toBe('wh:wh-123')
    })

    it('falls back to sessionId with session: prefix', () => {
      const key = generateIdempotencyKey(undefined, 'sess-1')
      expect(key).toBe('session:sess-1')
    })

    it('uses webhookId even when empty string is falsy', () => {
      const key = generateIdempotencyKey('', 'sess-1')
      expect(key).toBe('session:sess-1')
    })
  })

  describe('isWebhookProcessed', () => {
    it('returns false when not in memory and not in Redis', async () => {
      mockRedisExists.mockResolvedValue(false)
      const result = await isWebhookProcessed('key-not-processed')
      expect(result).toBe(false)
    })

    it('returns true from Redis hit and warms memory cache', async () => {
      const key = 'key-redis-hit'
      mockRedisExists.mockResolvedValue(true)

      const result = await isWebhookProcessed(key)
      expect(result).toBe(true)
      expect(mockRedisExists).toHaveBeenCalledWith(`webhook:processed:${key}`)

      // Second call should hit memory (no additional Redis call)
      mockRedisExists.mockClear()
      const result2 = await isWebhookProcessed(key)
      expect(result2).toBe(true)
      expect(mockRedisExists).not.toHaveBeenCalled()
    })

    it('returns false when Redis is not configured and key is not in memory', async () => {
      mockIsRedisConfigured.mockReturnValue(false)
      const result = await isWebhookProcessed('key-no-redis')
      expect(result).toBe(false)
    })

    it('returns true from memory when previously marked', async () => {
      const key = 'key-memory-hit'
      await markWebhookProcessed(key)

      // Reset Redis mock so it would return false
      mockRedisExists.mockResolvedValue(false)

      const result = await isWebhookProcessed(key)
      expect(result).toBe(true)
    })
  })

  describe('markWebhookProcessed', () => {
    it('stores in memory so subsequent isWebhookProcessed returns true', async () => {
      const key = 'key-mark-memory'
      await markWebhookProcessed(key)

      // Should be findable in memory without Redis
      mockIsRedisConfigured.mockReturnValue(false)
      const result = await isWebhookProcessed(key)
      expect(result).toBe(true)
    })

    it('stores in Redis with TTL', async () => {
      const key = 'key-mark-redis'
      await markWebhookProcessed(key)

      expect(mockRedisSet).toHaveBeenCalledWith(
        `webhook:processed:${key}`,
        expect.any(Number),
        86400 // 24 * 60 * 60
      )
    })

    it('handles Redis error gracefully without throwing', async () => {
      mockRedisSet.mockRejectedValue(new Error('Redis connection failed'))

      // Should not throw
      await expect(markWebhookProcessed('key-redis-error')).resolves.toBeUndefined()
    })
  })

  describe('unmarkWebhookProcessed', () => {
    it('removes from memory', async () => {
      const key = 'key-unmark-memory'
      await markWebhookProcessed(key)

      // Verify it's in memory
      mockIsRedisConfigured.mockReturnValue(false)
      expect(await isWebhookProcessed(key)).toBe(true)

      // Unmark
      await unmarkWebhookProcessed(key)
      expect(await isWebhookProcessed(key)).toBe(false)
    })

    it('removes from Redis', async () => {
      const key = 'key-unmark-redis'
      mockIsRedisConfigured.mockReturnValue(true)
      await unmarkWebhookProcessed(key)

      expect(mockRedisDel).toHaveBeenCalledWith(`webhook:processed:${key}`)
    })
  })

  describe('getCacheStats', () => {
    it('returns current cache statistics', () => {
      const stats = getCacheStats()
      expect(stats).toEqual({
        memorySize: expect.any(Number),
        memoryExpiryMs: 300000, // 5 * 60 * 1000
        kvExpirySeconds: 86400, // 24 * 60 * 60
      })
    })

    it('reflects memory size after marking', async () => {
      const before = getCacheStats().memorySize
      await markWebhookProcessed('key-stats-growth')
      const after = getCacheStats().memorySize
      expect(after).toBeGreaterThanOrEqual(before)
    })
  })
})
