import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock redis before importing module under test
vi.mock('./redis.js', () => ({
  isRedisConfigured: vi.fn(() => true),
  redisSet: vi.fn(),
  redisGet: vi.fn(() => null),
  redisDel: vi.fn(() => 1),
}))

import {
  getSupervisorState,
  setSupervisorState,
  getRemediationRecord,
  setRemediationRecord,
  recordRemediationAction,
  clearRemediationRecord,
  getWorkerHealthSnapshot,
  setWorkerHealthSnapshot,
} from './supervisor-storage.js'
import { isRedisConfigured, redisSet, redisGet, redisDel } from './redis.js'
import type {
  SupervisorState,
  RemediationRecord,
  WorkerHealthStatus,
} from './fleet-supervisor-types.js'

const mockIsRedisConfigured = vi.mocked(isRedisConfigured)
const mockRedisSet = vi.mocked(redisSet)
const mockRedisGet = vi.mocked(redisGet)
const mockRedisDel = vi.mocked(redisDel)

function makeSupervisorState(
  overrides: Partial<SupervisorState> = {}
): SupervisorState {
  return {
    supervisorId: 'fleet-test',
    restartStrategy: 'one-for-one',
    workerIds: ['wkr_abc', 'wkr_def'],
    lastPatrolAt: 1000000,
    patrolIntervalMs: 30000,
    totalPatrols: 5,
    totalRemediations: 1,
    startedAt: 900000,
    updatedAt: 1000000,
    ...overrides,
  }
}

function makeRemediationRecord(
  overrides: Partial<RemediationRecord> = {}
): RemediationRecord {
  return {
    sessionId: 'sess-1',
    issueId: 'issue-1',
    issueIdentifier: 'SUP-100',
    nudgeCount: 0,
    nudgeTimestamps: [],
    restartCount: 0,
    restartTimestamps: [],
    reassignCount: 0,
    reassignTimestamps: [],
    escalated: false,
    firstDetectedAt: 1000000,
    lastActionAt: 1000000,
    updatedAt: 1000000,
    ...overrides,
  }
}

function makeHealthStatus(
  overrides: Partial<WorkerHealthStatus> = {}
): WorkerHealthStatus {
  return {
    workerId: 'wkr_abc',
    liveness: { ok: true, checkedAt: 1000000 },
    readiness: { ok: true, checkedAt: 1000000 },
    startup: { ok: true, checkedAt: 1000000 },
    healthy: true,
    grade: 'green',
    ...overrides,
  }
}

describe('supervisor-storage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
    mockRedisGet.mockResolvedValue(null)
  })

  // -----------------------------------------------------------------------
  // Supervisor State
  // -----------------------------------------------------------------------

  describe('getSupervisorState', () => {
    it('returns null when Redis is not configured', async () => {
      mockIsRedisConfigured.mockReturnValue(false)
      const result = await getSupervisorState('fleet-test')
      expect(result).toBeNull()
    })

    it('returns null when supervisor not found', async () => {
      const result = await getSupervisorState('nonexistent')
      expect(result).toBeNull()
      expect(mockRedisGet).toHaveBeenCalledWith('sup:supervisor:nonexistent')
    })

    it('returns supervisor state from Redis', async () => {
      const state = makeSupervisorState()
      mockRedisGet.mockResolvedValue(state)

      const result = await getSupervisorState('fleet-test')
      expect(result).toEqual(state)
      expect(mockRedisGet).toHaveBeenCalledWith('sup:supervisor:fleet-test')
    })
  })

  describe('setSupervisorState', () => {
    it('does nothing when Redis is not configured', async () => {
      mockIsRedisConfigured.mockReturnValue(false)
      await setSupervisorState(makeSupervisorState())
      expect(mockRedisSet).not.toHaveBeenCalled()
    })

    it('stores supervisor state with 1-hour TTL', async () => {
      const state = makeSupervisorState()
      await setSupervisorState(state)

      expect(mockRedisSet).toHaveBeenCalledWith(
        'sup:supervisor:fleet-test',
        state,
        3600
      )
    })
  })

  // -----------------------------------------------------------------------
  // Remediation Records
  // -----------------------------------------------------------------------

  describe('getRemediationRecord', () => {
    it('returns null when Redis is not configured', async () => {
      mockIsRedisConfigured.mockReturnValue(false)
      const result = await getRemediationRecord('sess-1')
      expect(result).toBeNull()
    })

    it('returns null when record not found', async () => {
      const result = await getRemediationRecord('sess-1')
      expect(result).toBeNull()
      expect(mockRedisGet).toHaveBeenCalledWith('sup:remediation:sess-1')
    })

    it('returns remediation record from Redis', async () => {
      const record = makeRemediationRecord()
      mockRedisGet.mockResolvedValue(record)

      const result = await getRemediationRecord('sess-1')
      expect(result).toEqual(record)
    })
  })

  describe('setRemediationRecord', () => {
    it('stores record with 24-hour TTL', async () => {
      const record = makeRemediationRecord()
      await setRemediationRecord(record)

      expect(mockRedisSet).toHaveBeenCalledWith(
        'sup:remediation:sess-1',
        record,
        86400
      )
    })
  })

  describe('recordRemediationAction', () => {
    it('creates new record and increments nudge count', async () => {
      const now = 2000000
      const result = await recordRemediationAction(
        'sess-1', 'issue-1', 'SUP-100', 'nudge', now
      )

      expect(result.nudgeCount).toBe(1)
      expect(result.nudgeTimestamps).toEqual([now])
      expect(result.firstDetectedAt).toBe(now)
      expect(result.lastActionAt).toBe(now)
      expect(mockRedisSet).toHaveBeenCalledWith(
        'sup:remediation:sess-1',
        expect.objectContaining({ nudgeCount: 1 }),
        86400
      )
    })

    it('increments existing record nudge count', async () => {
      const existing = makeRemediationRecord({
        nudgeCount: 1,
        nudgeTimestamps: [1000000],
        firstDetectedAt: 900000,
      })
      mockRedisGet.mockResolvedValue(existing)

      const now = 2000000
      const result = await recordRemediationAction(
        'sess-1', 'issue-1', 'SUP-100', 'nudge', now
      )

      expect(result.nudgeCount).toBe(2)
      expect(result.nudgeTimestamps).toEqual([1000000, now])
      expect(result.firstDetectedAt).toBe(900000) // preserved
    })

    it('increments restart count', async () => {
      const now = 2000000
      const result = await recordRemediationAction(
        'sess-1', 'issue-1', 'SUP-100', 'restart', now
      )

      expect(result.restartCount).toBe(1)
      expect(result.restartTimestamps).toEqual([now])
    })

    it('increments reassign count', async () => {
      const now = 2000000
      const result = await recordRemediationAction(
        'sess-1', 'issue-1', 'SUP-100', 'reassign', now
      )

      expect(result.reassignCount).toBe(1)
      expect(result.reassignTimestamps).toEqual([now])
    })

    it('marks escalation', async () => {
      const now = 2000000
      const result = await recordRemediationAction(
        'sess-1', 'issue-1', 'SUP-100', 'escalate', now
      )

      expect(result.escalated).toBe(true)
      expect(result.escalatedAt).toBe(now)
    })
  })

  describe('clearRemediationRecord', () => {
    it('does nothing when Redis is not configured', async () => {
      mockIsRedisConfigured.mockReturnValue(false)
      await clearRemediationRecord('sess-1')
      expect(mockRedisDel).not.toHaveBeenCalled()
    })

    it('deletes remediation record', async () => {
      await clearRemediationRecord('sess-1')
      expect(mockRedisDel).toHaveBeenCalledWith('sup:remediation:sess-1')
    })
  })

  // -----------------------------------------------------------------------
  // Worker Health Snapshots
  // -----------------------------------------------------------------------

  describe('getWorkerHealthSnapshot', () => {
    it('returns null when Redis is not configured', async () => {
      mockIsRedisConfigured.mockReturnValue(false)
      const result = await getWorkerHealthSnapshot('wkr_abc')
      expect(result).toBeNull()
    })

    it('returns health snapshot from Redis', async () => {
      const health = makeHealthStatus()
      mockRedisGet.mockResolvedValue(health)

      const result = await getWorkerHealthSnapshot('wkr_abc')
      expect(result).toEqual(health)
      expect(mockRedisGet).toHaveBeenCalledWith('sup:health:wkr_abc')
    })
  })

  describe('setWorkerHealthSnapshot', () => {
    it('stores health snapshot with 5-minute TTL', async () => {
      const health = makeHealthStatus()
      await setWorkerHealthSnapshot(health)

      expect(mockRedisSet).toHaveBeenCalledWith(
        'sup:health:wkr_abc',
        health,
        300
      )
    })
  })
})
