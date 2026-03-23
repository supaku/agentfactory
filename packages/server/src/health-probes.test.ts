import { describe, it, expect } from 'vitest'
import {
  evaluateLiveness,
  evaluateReadiness,
  evaluateStartup,
  evaluateWorkerHealth,
  detectStuckSignals,
} from './health-probes.js'
import type { WorkerData, WorkerInfo } from './worker-storage.js'
import type { AgentSessionState } from './session-storage.js'
import type { StuckDetectionConfig } from './fleet-supervisor-types.js'
import { DEFAULT_STUCK_DETECTION_CONFIG } from './fleet-supervisor-types.js'

function makeWorkerData(overrides: Partial<WorkerData> = {}): WorkerData {
  return {
    id: 'wkr_abc',
    hostname: 'test-host',
    capacity: 3,
    activeCount: 1,
    registeredAt: 900_000,
    lastHeartbeat: 1_000_000,
    status: 'active',
    ...overrides,
  }
}

function makeWorkerInfo(overrides: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    ...makeWorkerData(),
    activeSessions: ['sess-1'],
    ...overrides,
  }
}

function makeSession(
  overrides: Partial<AgentSessionState> = {}
): AgentSessionState {
  return {
    linearSessionId: 'sess-1',
    issueId: 'issue-1',
    providerSessionId: null,
    worktreePath: '/tmp/wt',
    status: 'running',
    createdAt: 800_000,
    updatedAt: 950_000,
    workerId: 'wkr_abc',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Liveness Probe
// ---------------------------------------------------------------------------

describe('evaluateLiveness', () => {
  it('returns ok when heartbeat is fresh', () => {
    const worker = makeWorkerData({ lastHeartbeat: 990_000 })
    const result = evaluateLiveness(worker, 1_000_000, 180_000)

    expect(result.ok).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it('returns not ok when heartbeat is stale', () => {
    const worker = makeWorkerData({ lastHeartbeat: 800_000 })
    const result = evaluateLiveness(worker, 1_000_000, 180_000)

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('Heartbeat stale')
  })

  it('returns not ok when worker status is offline', () => {
    const worker = makeWorkerData({ status: 'offline', lastHeartbeat: 999_000 })
    const result = evaluateLiveness(worker, 1_000_000, 180_000)

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('offline')
  })

  it('uses default timeout when not specified', () => {
    const worker = makeWorkerData({ lastHeartbeat: 999_000 })
    const result = evaluateLiveness(worker, 1_000_000)

    expect(result.ok).toBe(true)
  })

  it('returns checkedAt matching the provided now', () => {
    const worker = makeWorkerData()
    const result = evaluateLiveness(worker, 1_234_567)

    expect(result.checkedAt).toBe(1_234_567)
  })
})

// ---------------------------------------------------------------------------
// Readiness Probe
// ---------------------------------------------------------------------------

describe('evaluateReadiness', () => {
  it('returns ok when worker is active with capacity', () => {
    const worker = makeWorkerInfo({ activeSessions: ['s1'], capacity: 3 })
    const result = evaluateReadiness(worker, [], 1_000_000)

    expect(result.ok).toBe(true)
  })

  it('returns not ok when worker is draining', () => {
    const worker = makeWorkerInfo({ status: 'draining' })
    const result = evaluateReadiness(worker, [], 1_000_000)

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('draining')
  })

  it('returns not ok when worker is at capacity', () => {
    const worker = makeWorkerInfo({
      activeSessions: ['s1', 's2', 's3'],
      capacity: 3,
    })
    const result = evaluateReadiness(worker, [], 1_000_000)

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('capacity')
  })

  it('returns not ok when a session is claim-stuck', () => {
    const worker = makeWorkerInfo({ id: 'wkr_abc', capacity: 3, activeSessions: ['sess-stuck'] })
    const sessions = [
      makeSession({
        linearSessionId: 'sess-stuck',
        status: 'claimed',
        workerId: 'wkr_abc',
        claimedAt: 500_000,
        updatedAt: 500_000,
      }),
    ]
    // 500k to 1M = 500s > 300s default
    const result = evaluateReadiness(worker, sessions, 1_000_000, 300_000)

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('stuck in claimed')
  })

  it('returns ok when claimed session is within grace period', () => {
    const worker = makeWorkerInfo({ id: 'wkr_abc', capacity: 3, activeSessions: ['sess-1'] })
    const sessions = [
      makeSession({
        status: 'claimed',
        workerId: 'wkr_abc',
        claimedAt: 999_000,
        updatedAt: 999_000,
      }),
    ]
    // 999k to 1M = 1s < 300s
    const result = evaluateReadiness(worker, sessions, 1_000_000, 300_000)

    expect(result.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Startup Probe
// ---------------------------------------------------------------------------

describe('evaluateStartup', () => {
  it('returns not ok when within startup grace period', () => {
    const worker = makeWorkerData({ registeredAt: 950_000, lastHeartbeat: 960_000 })
    const result = evaluateStartup(worker, 1_000_000, 60_000)

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('starting up')
  })

  it('returns not ok when no heartbeat since registration', () => {
    const worker = makeWorkerData({ registeredAt: 800_000, lastHeartbeat: 800_000 })
    const result = evaluateStartup(worker, 1_000_000, 60_000)

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('No heartbeat')
  })

  it('returns ok when grace period elapsed and heartbeat received', () => {
    const worker = makeWorkerData({ registeredAt: 800_000, lastHeartbeat: 950_000 })
    const result = evaluateStartup(worker, 1_000_000, 60_000)

    expect(result.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Combined Health Assessment
// ---------------------------------------------------------------------------

describe('evaluateWorkerHealth', () => {
  it('returns green grade when all probes pass', () => {
    const now = Date.now()
    const worker = makeWorkerInfo({
      registeredAt: now - 120_000,
      lastHeartbeat: now - 5_000,
      activeSessions: ['s1'],
      capacity: 3,
    })

    const result = evaluateWorkerHealth(worker, [])

    expect(result.healthy).toBe(true)
    expect(result.grade).toBe('green')
    expect(result.liveness.ok).toBe(true)
    expect(result.readiness.ok).toBe(true)
    expect(result.startup.ok).toBe(true)
  })

  it('returns red grade when liveness fails', () => {
    const worker = makeWorkerInfo({
      lastHeartbeat: 100_000, // very old
      registeredAt: 50_000,
    })

    const result = evaluateWorkerHealth(worker, [])

    expect(result.healthy).toBe(false)
    expect(result.grade).toBe('red')
    expect(result.liveness.ok).toBe(false)
  })

  it('returns yellow grade when readiness fails but liveness ok', () => {
    const worker = makeWorkerInfo({
      status: 'draining',
      lastHeartbeat: Date.now(),
      registeredAt: Date.now() - 120_000,
    })

    const result = evaluateWorkerHealth(worker, [])

    expect(result.healthy).toBe(false)
    expect(result.grade).toBe('yellow')
    expect(result.liveness.ok).toBe(true)
    expect(result.readiness.ok).toBe(false)
  })

  it('returns yellow grade when startup fails but liveness ok', () => {
    const now = Date.now()
    const worker = makeWorkerInfo({
      registeredAt: now - 10_000, // just registered
      lastHeartbeat: now,
    })

    const result = evaluateWorkerHealth(worker, [], { startupGraceMs: 60_000 })

    expect(result.healthy).toBe(false)
    expect(result.grade).toBe('yellow')
    expect(result.startup.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Stuck Signal Detection
// ---------------------------------------------------------------------------

describe('detectStuckSignals', () => {
  const config: StuckDetectionConfig = { ...DEFAULT_STUCK_DETECTION_CONFIG }

  it('returns no stuck signals for healthy session', () => {
    const session = makeSession({ status: 'running', updatedAt: 999_000 })
    const worker = makeWorkerData({ lastHeartbeat: 999_000 })

    const result = detectStuckSignals(session, worker, config, 1_000_000)

    expect(result.isStuck).toBe(false)
    expect(result.sessionRunningTooLong).toBe(false)
    expect(result.heartbeatStale).toBe(false)
    expect(result.claimStuck).toBe(false)
  })

  it('detects session running too long', () => {
    const now = 1_000_000
    const session = makeSession({
      status: 'running',
      updatedAt: now - config.maxRunningDurationMs - 60_000,
    })

    const result = detectStuckSignals(session, null, config, now)

    expect(result.isStuck).toBe(true)
    expect(result.sessionRunningTooLong).toBe(true)
    expect(result.stuckDurationMs).toBeGreaterThan(0)
  })

  it('detects stale heartbeat', () => {
    const now = 1_000_000
    const worker = makeWorkerData({
      lastHeartbeat: now - config.heartbeatYellowThresholdMs - 30_000,
    })
    const session = makeSession({ status: 'running', updatedAt: now })

    const result = detectStuckSignals(session, worker, config, now)

    expect(result.isStuck).toBe(true)
    expect(result.heartbeatStale).toBe(true)
  })

  it('does not detect stale heartbeat when worker is null', () => {
    const session = makeSession({ status: 'running', updatedAt: 999_000 })

    const result = detectStuckSignals(session, null, config, 1_000_000)

    expect(result.heartbeatStale).toBe(false)
  })

  it('detects claim-stuck session', () => {
    const now = 1_000_000
    const session = makeSession({
      status: 'claimed',
      claimedAt: now - config.maxClaimDurationMs - 60_000,
      updatedAt: now - config.maxClaimDurationMs - 60_000,
    })

    const result = detectStuckSignals(session, null, config, now)

    expect(result.isStuck).toBe(true)
    expect(result.claimStuck).toBe(true)
  })

  it('uses updatedAt when claimedAt is not set', () => {
    const now = 1_000_000
    const session = makeSession({
      status: 'claimed',
      claimedAt: undefined,
      updatedAt: now - config.maxClaimDurationMs - 60_000,
    })

    const result = detectStuckSignals(session, null, config, now)

    expect(result.claimStuck).toBe(true)
  })

  it('does not flag non-running session for running-too-long', () => {
    const now = 1_000_000
    const session = makeSession({
      status: 'pending',
      updatedAt: now - config.maxRunningDurationMs - 60_000,
    })

    const result = detectStuckSignals(session, null, config, now)

    expect(result.sessionRunningTooLong).toBe(false)
  })

  it('does not flag non-claimed session for claim-stuck', () => {
    const now = 1_000_000
    const session = makeSession({
      status: 'running',
      claimedAt: now - config.maxClaimDurationMs - 60_000,
    })

    const result = detectStuckSignals(session, null, config, now)

    expect(result.claimStuck).toBe(false)
  })

  it('reports max stuckDurationMs across multiple signals', () => {
    const now = 1_000_000
    const session = makeSession({
      status: 'running',
      updatedAt: now - config.maxRunningDurationMs - 120_000,
    })
    const worker = makeWorkerData({
      lastHeartbeat: now - config.heartbeatYellowThresholdMs - 30_000,
    })

    const result = detectStuckSignals(session, worker, config, now)

    expect(result.isStuck).toBe(true)
    expect(result.stuckDurationMs).toBe(120_000) // max of the two
  })
})
