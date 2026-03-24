import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock redis before importing module under test
vi.mock('./redis.js', () => ({
  isRedisConfigured: vi.fn(() => true),
  redisSet: vi.fn(),
  redisGet: vi.fn(() => null),
  redisDel: vi.fn(() => 1),
  redisKeys: vi.fn(() => []),
}))

import { RedisPosteriorStore } from './routing-posterior-store.js'
import { isRedisConfigured, redisSet, redisGet, redisDel, redisKeys } from './redis.js'

const mockIsRedisConfigured = vi.mocked(isRedisConfigured)
const mockRedisSet = vi.mocked(redisSet)
const mockRedisGet = vi.mocked(redisGet)
const mockRedisDel = vi.mocked(redisDel)
const mockRedisKeys = vi.mocked(redisKeys)

describe('RedisPosteriorStore', () => {
  let store: RedisPosteriorStore

  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
    mockRedisGet.mockResolvedValue(null)
    mockRedisKeys.mockResolvedValue([])
    store = new RedisPosteriorStore()
  })

  describe('getPosterior', () => {
    it('returns default posterior for missing key', async () => {
      mockRedisGet.mockResolvedValue(null)

      const result = await store.getPosterior('claude', 'development')

      expect(result.provider).toBe('claude')
      expect(result.workType).toBe('development')
      expect(result.alpha).toBe(1)
      expect(result.beta).toBe(1)
      expect(result.totalObservations).toBe(0)
      expect(result.avgReward).toBe(0)
    })

    it('returns stored data for existing key', async () => {
      const stored = {
        provider: 'claude' as const,
        workType: 'development' as const,
        alpha: 5.2,
        beta: 2.1,
        totalObservations: 7,
        avgReward: 0.72,
        avgCostUsd: 0.35,
        lastUpdated: 1700000000,
      }
      mockRedisGet.mockResolvedValue(stored)

      const result = await store.getPosterior('claude', 'development')

      expect(result).toEqual(stored)
      expect(mockRedisGet).toHaveBeenCalledWith('routing:posteriors:claude:development')
    })

    it('returns default when Redis is not configured', async () => {
      mockIsRedisConfigured.mockReturnValue(false)

      const result = await store.getPosterior('codex', 'qa')

      expect(result.provider).toBe('codex')
      expect(result.workType).toBe('qa')
      expect(result.alpha).toBe(1)
      expect(result.beta).toBe(1)
      expect(mockRedisGet).not.toHaveBeenCalled()
    })
  })

  describe('updatePosterior', () => {
    it('increments alpha on high reward (>= 0.5)', async () => {
      mockRedisGet.mockResolvedValue(null) // starts from default

      const result = await store.updatePosterior('claude', 'development', 0.8)

      expect(result.alpha).toBe(1 + 0.8) // default alpha(1) + reward
      expect(result.beta).toBe(1) // unchanged
      expect(mockRedisSet).toHaveBeenCalledWith(
        'routing:posteriors:claude:development',
        expect.objectContaining({
          alpha: 1.8,
          beta: 1,
        }),
      )
    })

    it('increments beta on low reward (< 0.5)', async () => {
      mockRedisGet.mockResolvedValue(null) // starts from default

      const result = await store.updatePosterior('claude', 'development', 0.2)

      expect(result.alpha).toBe(1) // unchanged
      expect(result.beta).toBe(1 + 0.8) // default beta(1) + (1 - reward)
      expect(mockRedisSet).toHaveBeenCalledWith(
        'routing:posteriors:claude:development',
        expect.objectContaining({
          alpha: 1,
          beta: 1.8,
        }),
      )
    })

    it('increments totalObservations', async () => {
      const existing = {
        provider: 'claude' as const,
        workType: 'development' as const,
        alpha: 3,
        beta: 2,
        totalObservations: 4,
        avgReward: 0.6,
        avgCostUsd: 0.3,
        lastUpdated: 1700000000,
      }
      mockRedisGet.mockResolvedValue(existing)

      const result = await store.updatePosterior('claude', 'development', 0.9)

      expect(result.totalObservations).toBe(5)
    })

    it('recalculates running average reward', async () => {
      const existing = {
        provider: 'claude' as const,
        workType: 'development' as const,
        alpha: 2,
        beta: 1,
        totalObservations: 2,
        avgReward: 0.7,
        avgCostUsd: 0.3,
        lastUpdated: 1700000000,
      }
      mockRedisGet.mockResolvedValue(existing)

      const result = await store.updatePosterior('claude', 'development', 1.0)

      // Running average: (0.7 * 2 + 1.0) / 3 = 2.4 / 3 = 0.8
      expect(result.avgReward).toBeCloseTo(0.8, 10)
    })

    it('updates lastUpdated timestamp', async () => {
      mockRedisGet.mockResolvedValue(null)

      const before = Date.now()
      const result = await store.updatePosterior('claude', 'development', 0.5)
      const after = Date.now()

      expect(result.lastUpdated).toBeGreaterThanOrEqual(before)
      expect(result.lastUpdated).toBeLessThanOrEqual(after)
    })

    it('returns default when Redis is not configured', async () => {
      mockIsRedisConfigured.mockReturnValue(false)

      const result = await store.updatePosterior('claude', 'development', 0.8)

      expect(result.alpha).toBe(1)
      expect(result.beta).toBe(1)
      expect(mockRedisSet).not.toHaveBeenCalled()
    })

    it('handles reward exactly at threshold (0.5) as success', async () => {
      mockRedisGet.mockResolvedValue(null)

      const result = await store.updatePosterior('claude', 'development', 0.5)

      expect(result.alpha).toBe(1.5) // 1 + 0.5
      expect(result.beta).toBe(1) // unchanged
    })
  })

  describe('getAllPosteriors', () => {
    it('returns all stored posteriors', async () => {
      const posterior1 = {
        provider: 'claude' as const,
        workType: 'development' as const,
        alpha: 3,
        beta: 2,
        totalObservations: 4,
        avgReward: 0.6,
        avgCostUsd: 0.3,
        lastUpdated: 1700000000,
      }
      const posterior2 = {
        provider: 'codex' as const,
        workType: 'qa' as const,
        alpha: 2,
        beta: 3,
        totalObservations: 4,
        avgReward: 0.4,
        avgCostUsd: 0.5,
        lastUpdated: 1700000001,
      }

      mockRedisKeys.mockResolvedValue([
        'routing:posteriors:claude:development',
        'routing:posteriors:codex:qa',
      ])
      mockRedisGet
        .mockResolvedValueOnce(posterior1)
        .mockResolvedValueOnce(posterior2)

      const result = await store.getAllPosteriors()

      expect(result).toHaveLength(2)
      expect(result[0]).toEqual(posterior1)
      expect(result[1]).toEqual(posterior2)
      expect(mockRedisKeys).toHaveBeenCalledWith('routing:posteriors:*')
    })

    it('returns empty array when no posteriors exist', async () => {
      mockRedisKeys.mockResolvedValue([])

      const result = await store.getAllPosteriors()

      expect(result).toEqual([])
    })

    it('returns empty array when Redis is not configured', async () => {
      mockIsRedisConfigured.mockReturnValue(false)

      const result = await store.getAllPosteriors()

      expect(result).toEqual([])
      expect(mockRedisKeys).not.toHaveBeenCalled()
    })

    it('skips null values from Redis', async () => {
      mockRedisKeys.mockResolvedValue([
        'routing:posteriors:claude:development',
        'routing:posteriors:codex:qa',
      ])
      mockRedisGet
        .mockResolvedValueOnce({
          provider: 'claude',
          workType: 'development',
          alpha: 3,
          beta: 2,
          totalObservations: 4,
          avgReward: 0.6,
          avgCostUsd: 0.3,
          lastUpdated: 1700000000,
        })
        .mockResolvedValueOnce(null)

      const result = await store.getAllPosteriors()

      expect(result).toHaveLength(1)
    })
  })

  describe('resetPosterior', () => {
    it('deletes the key from Redis', async () => {
      await store.resetPosterior('claude', 'development')

      expect(mockRedisDel).toHaveBeenCalledWith('routing:posteriors:claude:development')
    })

    it('does not call redisDel when Redis is not configured', async () => {
      mockIsRedisConfigured.mockReturnValue(false)

      await store.resetPosterior('claude', 'development')

      expect(mockRedisDel).not.toHaveBeenCalled()
    })
  })
})
