import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'node:crypto'

// Use vi.hoisted so the mock logger instance is available when vi.mock factories run
const { mockLoggerInstance } = vi.hoisted(() => ({
  mockLoggerInstance: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

// Mock redis before importing module under test
vi.mock('../redis.js', () => ({
  isRedisConfigured: vi.fn(() => true),
  getRedisClient: vi.fn(),
}))

// Mock logger — return the shared hoisted instance so tests can inspect calls
vi.mock('../logger.js', () => ({
  createLogger: vi.fn(() => mockLoggerInstance),
}))

import {
  recordSchedulingDecision,
  getSchedulingDecision,
  getRecentDecisions,
} from '../scheduler/audit.js'
import type { StoredSchedulingDecision } from '../scheduler/audit.js'
import type { SchedulingDecision } from '../scheduler/orchestrator.js'
import { isRedisConfigured, getRedisClient } from '../redis.js'

const mockIsRedisConfigured = vi.mocked(isRedisConfigured)
const mockGetRedisClient = vi.mocked(getRedisClient)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDecision(
  overrides: Partial<SchedulingDecision> = {},
): SchedulingDecision {
  return {
    workSessionId: 'sess-1',
    outcome: 'assigned',
    assignedWorkerId: 'wkr_abc',
    assignedScore: 85,
    totalWorkers: 3,
    feasibleWorkers: 2,
    filterDurationMs: 1.2,
    scoreDurationMs: 2.3,
    totalDurationMs: 3.5,
    ...overrides,
  }
}

function makeRedisMock() {
  return {
    setex: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    lpush: vi.fn().mockResolvedValue(1),
    ltrim: vi.fn().mockResolvedValue('OK'),
    lrange: vi.fn().mockResolvedValue([]),
    pipeline: vi.fn(() => ({
      get: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    })),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scheduler-audit', () => {
  let redisMock: ReturnType<typeof makeRedisMock>

  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
    redisMock = makeRedisMock()
    mockGetRedisClient.mockReturnValue(redisMock as never)
    // Reset the shared logger instance mocks
    mockLoggerInstance.info.mockClear()
    mockLoggerInstance.warn.mockClear()
    mockLoggerInstance.error.mockClear()
    mockLoggerInstance.debug.mockClear()
    // Ensure deterministic UUIDs for tests
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      '550e8400-e29b-41d4-a716-446655440000',
    )
  })

  // -----------------------------------------------------------------------
  // recordSchedulingDecision
  // -----------------------------------------------------------------------

  describe('recordSchedulingDecision', () => {
    it('records and stores a decision in Redis', async () => {
      const decision = makeDecision()
      const id = await recordSchedulingDecision(decision)

      expect(id).toBe('550e8400-e29b-41d4-a716-446655440000')

      // Should store by session ID with 24hr TTL
      expect(redisMock.setex).toHaveBeenCalledWith(
        'scheduling:decisions:sess-1',
        86400,
        expect.any(String),
      )

      // Should store by decision ID with 24hr TTL
      expect(redisMock.setex).toHaveBeenCalledWith(
        'scheduling:decisions:log:550e8400-e29b-41d4-a716-446655440000',
        86400,
        expect.any(String),
      )

      // Verify the stored record contains all fields
      const sessionCallArgs = redisMock.setex.mock.calls[0]
      const stored = JSON.parse(sessionCallArgs[2]) as StoredSchedulingDecision
      expect(stored.id).toBe('550e8400-e29b-41d4-a716-446655440000')
      expect(stored.timestamp).toBeGreaterThan(0)
      expect(stored.workSessionId).toBe('sess-1')
      expect(stored.outcome).toBe('assigned')
      expect(stored.assignedWorkerId).toBe('wkr_abc')
      expect(stored.assignedScore).toBe(85)
      expect(stored.totalWorkers).toBe(3)
      expect(stored.feasibleWorkers).toBe(2)

      // Should push to recent list and cap at 1000
      expect(redisMock.lpush).toHaveBeenCalledWith(
        'scheduling:decisions:recent',
        '550e8400-e29b-41d4-a716-446655440000',
      )
      expect(redisMock.ltrim).toHaveBeenCalledWith(
        'scheduling:decisions:recent',
        0,
        999,
      )
    })

    it('emits structured log for every decision', async () => {
      const decision = makeDecision({
        workSessionId: 'sess-42',
        outcome: 'backoff',
        assignedWorkerId: undefined,
        assignedScore: undefined,
        totalWorkers: 5,
        feasibleWorkers: 0,
        totalDurationMs: 7.8,
      })

      await recordSchedulingDecision(decision)

      // The logger is the shared mock instance
      expect(mockLoggerInstance.info).toHaveBeenCalledWith('scheduling_decision', {
        sessionId: 'sess-42',
        outcome: 'backoff',
        totalWorkers: 5,
        feasibleWorkers: 0,
        assignedWorkerId: undefined,
        assignedScore: undefined,
        durationMs: 7.8,
      })
    })

    it('returns UUID even when Redis is not configured', async () => {
      mockIsRedisConfigured.mockReturnValue(false)
      const decision = makeDecision()

      const id = await recordSchedulingDecision(decision)

      expect(id).toBe('550e8400-e29b-41d4-a716-446655440000')
      // Redis calls should NOT have happened
      expect(redisMock.setex).not.toHaveBeenCalled()
      expect(redisMock.lpush).not.toHaveBeenCalled()
      expect(redisMock.ltrim).not.toHaveBeenCalled()
    })

    it('handles Redis errors gracefully and still returns ID', async () => {
      redisMock.setex.mockRejectedValue(new Error('connection lost'))
      const decision = makeDecision()

      const id = await recordSchedulingDecision(decision)

      expect(id).toBe('550e8400-e29b-41d4-a716-446655440000')
    })

    it('sets 24hr TTL (86400 seconds) on stored decisions', async () => {
      await recordSchedulingDecision(makeDecision())

      // Both setex calls should use 86400
      for (const call of redisMock.setex.mock.calls) {
        expect(call[1]).toBe(86400)
      }
    })

    it('caps the recent decisions list at 1000', async () => {
      await recordSchedulingDecision(makeDecision())

      expect(redisMock.ltrim).toHaveBeenCalledWith(
        'scheduling:decisions:recent',
        0,
        999, // 0-indexed, so 0..999 = 1000 items
      )
    })

    it('records decision with assigned outcome', async () => {
      const decision = makeDecision({
        outcome: 'assigned',
        assignedWorkerId: 'wkr_1',
        assignedScore: 92,
      })

      await recordSchedulingDecision(decision)

      const stored = JSON.parse(
        redisMock.setex.mock.calls[0][2],
      ) as StoredSchedulingDecision
      expect(stored.outcome).toBe('assigned')
      expect(stored.assignedWorkerId).toBe('wkr_1')
      expect(stored.assignedScore).toBe(92)
    })

    it('records decision with backoff outcome', async () => {
      const decision = makeDecision({
        outcome: 'backoff',
        assignedWorkerId: undefined,
        assignedScore: undefined,
        feasibleWorkers: 0,
      })

      await recordSchedulingDecision(decision)

      const stored = JSON.parse(
        redisMock.setex.mock.calls[0][2],
      ) as StoredSchedulingDecision
      expect(stored.outcome).toBe('backoff')
      expect(stored.assignedWorkerId).toBeUndefined()
      expect(stored.feasibleWorkers).toBe(0)
    })

    it('records decision with suspended outcome', async () => {
      const decision = makeDecision({
        outcome: 'suspended',
        assignedWorkerId: undefined,
        assignedScore: undefined,
        feasibleWorkers: 0,
      })

      await recordSchedulingDecision(decision)

      const stored = JSON.parse(
        redisMock.setex.mock.calls[0][2],
      ) as StoredSchedulingDecision
      expect(stored.outcome).toBe('suspended')
    })

    it('records decision with no_workers outcome', async () => {
      const decision = makeDecision({
        outcome: 'no_workers',
        assignedWorkerId: undefined,
        assignedScore: undefined,
        totalWorkers: 0,
        feasibleWorkers: 0,
        scoreDurationMs: 0,
      })

      await recordSchedulingDecision(decision)

      const stored = JSON.parse(
        redisMock.setex.mock.calls[0][2],
      ) as StoredSchedulingDecision
      expect(stored.outcome).toBe('no_workers')
      expect(stored.totalWorkers).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // getSchedulingDecision
  // -----------------------------------------------------------------------

  describe('getSchedulingDecision', () => {
    it('retrieves a stored decision by session ID', async () => {
      const stored: StoredSchedulingDecision = {
        ...makeDecision({ workSessionId: 'sess-99' }),
        id: 'uuid-1',
        timestamp: 1700000000000,
      }
      redisMock.get.mockResolvedValue(JSON.stringify(stored))

      const result = await getSchedulingDecision('sess-99')

      expect(result).toEqual(stored)
      expect(redisMock.get).toHaveBeenCalledWith(
        'scheduling:decisions:sess-99',
      )
    })

    it('returns null for non-existent session', async () => {
      redisMock.get.mockResolvedValue(null)

      const result = await getSchedulingDecision('nonexistent')

      expect(result).toBeNull()
      expect(redisMock.get).toHaveBeenCalledWith(
        'scheduling:decisions:nonexistent',
      )
    })

    it('returns null when Redis is not configured', async () => {
      mockIsRedisConfigured.mockReturnValue(false)

      const result = await getSchedulingDecision('sess-1')

      expect(result).toBeNull()
      expect(redisMock.get).not.toHaveBeenCalled()
    })

    it('returns null on Redis error', async () => {
      redisMock.get.mockRejectedValue(new Error('connection lost'))

      const result = await getSchedulingDecision('sess-1')

      expect(result).toBeNull()
    })
  })

  // -----------------------------------------------------------------------
  // getRecentDecisions
  // -----------------------------------------------------------------------

  describe('getRecentDecisions', () => {
    it('retrieves recent decisions with default limit of 50', async () => {
      const ids = ['id-1', 'id-2']
      redisMock.lrange.mockResolvedValue(ids)

      const stored1: StoredSchedulingDecision = {
        ...makeDecision({ workSessionId: 'sess-1' }),
        id: 'id-1',
        timestamp: 1700000001000,
      }
      const stored2: StoredSchedulingDecision = {
        ...makeDecision({ workSessionId: 'sess-2' }),
        id: 'id-2',
        timestamp: 1700000002000,
      }

      const pipelineMock = {
        get: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([
          [null, JSON.stringify(stored1)],
          [null, JSON.stringify(stored2)],
        ]),
      }
      redisMock.pipeline.mockReturnValue(pipelineMock as never)

      const result = await getRecentDecisions()

      expect(result).toHaveLength(2)
      expect(result[0].id).toBe('id-1')
      expect(result[1].id).toBe('id-2')

      // Default limit of 50: lrange 0 to 49
      expect(redisMock.lrange).toHaveBeenCalledWith(
        'scheduling:decisions:recent',
        0,
        49,
      )

      // Pipeline should fetch by log key
      expect(pipelineMock.get).toHaveBeenCalledWith(
        'scheduling:decisions:log:id-1',
      )
      expect(pipelineMock.get).toHaveBeenCalledWith(
        'scheduling:decisions:log:id-2',
      )
    })

    it('respects custom limit parameter', async () => {
      redisMock.lrange.mockResolvedValue([])

      await getRecentDecisions(10)

      expect(redisMock.lrange).toHaveBeenCalledWith(
        'scheduling:decisions:recent',
        0,
        9,
      )
    })

    it('returns empty array when Redis is not configured', async () => {
      mockIsRedisConfigured.mockReturnValue(false)

      const result = await getRecentDecisions()

      expect(result).toEqual([])
      expect(redisMock.lrange).not.toHaveBeenCalled()
    })

    it('returns empty array when no recent decisions exist', async () => {
      redisMock.lrange.mockResolvedValue([])

      const result = await getRecentDecisions()

      expect(result).toEqual([])
    })

    it('skips expired/missing records gracefully', async () => {
      redisMock.lrange.mockResolvedValue(['id-1', 'id-expired', 'id-3'])

      const stored1: StoredSchedulingDecision = {
        ...makeDecision({ workSessionId: 'sess-1' }),
        id: 'id-1',
        timestamp: 1700000001000,
      }
      const stored3: StoredSchedulingDecision = {
        ...makeDecision({ workSessionId: 'sess-3' }),
        id: 'id-3',
        timestamp: 1700000003000,
      }

      const pipelineMock = {
        get: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([
          [null, JSON.stringify(stored1)],
          [null, null], // expired record
          [null, JSON.stringify(stored3)],
        ]),
      }
      redisMock.pipeline.mockReturnValue(pipelineMock as never)

      const result = await getRecentDecisions()

      expect(result).toHaveLength(2)
      expect(result[0].id).toBe('id-1')
      expect(result[1].id).toBe('id-3')
    })

    it('returns empty array on Redis error', async () => {
      redisMock.lrange.mockRejectedValue(new Error('connection lost'))

      const result = await getRecentDecisions()

      expect(result).toEqual([])
    })

    it('handles pipeline execution errors for individual records', async () => {
      redisMock.lrange.mockResolvedValue(['id-1', 'id-2'])

      const stored2: StoredSchedulingDecision = {
        ...makeDecision({ workSessionId: 'sess-2' }),
        id: 'id-2',
        timestamp: 1700000002000,
      }

      const pipelineMock = {
        get: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([
          [new Error('fetch error'), null], // error for id-1
          [null, JSON.stringify(stored2)],  // success for id-2
        ]),
      }
      redisMock.pipeline.mockReturnValue(pipelineMock as never)

      const result = await getRecentDecisions()

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('id-2')
    })
  })

  // -----------------------------------------------------------------------
  // Round-trip: record then retrieve
  // -----------------------------------------------------------------------

  describe('round-trip', () => {
    it('can record and retrieve a decision', async () => {
      const decision = makeDecision({ workSessionId: 'sess-roundtrip' })

      // Record: capture what was stored
      let storedJson = ''
      redisMock.setex.mockImplementation(
        async (key: string, _ttl: number, value: string) => {
          if (key === 'scheduling:decisions:sess-roundtrip') {
            storedJson = value
          }
          return 'OK'
        },
      )

      const id = await recordSchedulingDecision(decision)
      expect(id).toBeTruthy()

      // Retrieve: return what was stored
      redisMock.get.mockResolvedValue(storedJson)

      const retrieved = await getSchedulingDecision('sess-roundtrip')

      expect(retrieved).not.toBeNull()
      expect(retrieved!.workSessionId).toBe('sess-roundtrip')
      expect(retrieved!.outcome).toBe('assigned')
      expect(retrieved!.assignedWorkerId).toBe('wkr_abc')
      expect(retrieved!.id).toBe(id)
      expect(retrieved!.timestamp).toBeGreaterThan(0)
    })
  })
})
