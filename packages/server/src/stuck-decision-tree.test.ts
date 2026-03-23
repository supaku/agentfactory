import { describe, it, expect } from 'vitest'
import {
  decideRemediation,
  createInitialRemediationRecord,
} from './stuck-decision-tree.js'
import type {
  RemediationRecord,
  StuckSignals,
  StuckDetectionConfig,
} from './fleet-supervisor-types.js'
import { DEFAULT_STUCK_DETECTION_CONFIG } from './fleet-supervisor-types.js'

const config: StuckDetectionConfig = { ...DEFAULT_STUCK_DETECTION_CONFIG }

function makeSignals(overrides: Partial<StuckSignals> = {}): StuckSignals {
  return {
    sessionRunningTooLong: true,
    heartbeatStale: false,
    claimStuck: false,
    stuckDurationMs: 60_000,
    isStuck: true,
    ...overrides,
  }
}

function makeRecord(
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
    firstDetectedAt: 1_000_000,
    lastActionAt: 1_000_000,
    updatedAt: 1_000_000,
    ...overrides,
  }
}

describe('createInitialRemediationRecord', () => {
  it('creates a record with all counts at zero', () => {
    const record = createInitialRemediationRecord(
      'sess-1', 'issue-1', 'SUP-100', 1_000_000
    )

    expect(record.sessionId).toBe('sess-1')
    expect(record.issueId).toBe('issue-1')
    expect(record.issueIdentifier).toBe('SUP-100')
    expect(record.nudgeCount).toBe(0)
    expect(record.restartCount).toBe(0)
    expect(record.reassignCount).toBe(0)
    expect(record.escalated).toBe(false)
    expect(record.firstDetectedAt).toBe(1_000_000)
  })
})

describe('decideRemediation', () => {
  it('returns null when signals indicate not stuck', () => {
    const signals = makeSignals({ isStuck: false })
    const result = decideRemediation(null, signals, config, 2_000_000)

    expect(result).toBeNull()
  })

  it('returns nudge on first detection (no record)', () => {
    const signals = makeSignals()
    const result = decideRemediation(null, signals, config, 2_000_000)

    expect(result).not.toBeNull()
    expect(result!.action).toBe('nudge')
    expect(result!.attemptNumber).toBe(1)
    expect(result!.maxAttempts).toBe(config.maxNudges)
  })

  it('returns nudge when nudge budget not exhausted', () => {
    const record = makeRecord({
      nudgeCount: 1,
      // lastActionAt old enough to clear cooldown
      lastActionAt: 1_000_000,
    })
    const signals = makeSignals()
    const now = 1_000_000 + config.remediationCooldownMs + 1

    const result = decideRemediation(record, signals, config, now)

    expect(result!.action).toBe('nudge')
    expect(result!.attemptNumber).toBe(2)
  })

  it('returns restart after nudge budget exhausted', () => {
    const record = makeRecord({
      nudgeCount: config.maxNudges, // 2
      lastActionAt: 1_000_000,
    })
    const signals = makeSignals()
    const now = 1_000_000 + config.remediationCooldownMs + 1

    const result = decideRemediation(record, signals, config, now)

    expect(result!.action).toBe('restart')
    expect(result!.attemptNumber).toBe(1)
    expect(result!.maxAttempts).toBe(config.maxRestarts)
  })

  it('returns restart when restart budget not exhausted', () => {
    const record = makeRecord({
      nudgeCount: config.maxNudges,
      restartCount: 2,
      lastActionAt: 1_000_000,
    })
    const signals = makeSignals()
    const now = 1_000_000 + config.remediationCooldownMs + 1

    const result = decideRemediation(record, signals, config, now)

    expect(result!.action).toBe('restart')
    expect(result!.attemptNumber).toBe(3)
  })

  it('returns reassign after restart budget exhausted', () => {
    const record = makeRecord({
      nudgeCount: config.maxNudges,   // 2
      restartCount: config.maxRestarts, // 3
      lastActionAt: 1_000_000,
    })
    const signals = makeSignals()
    const now = 1_000_000 + config.remediationCooldownMs + 1

    const result = decideRemediation(record, signals, config, now)

    expect(result!.action).toBe('reassign')
    expect(result!.attemptNumber).toBe(1)
    expect(result!.maxAttempts).toBe(config.maxReassigns)
  })

  it('returns escalate after all budgets exhausted', () => {
    const record = makeRecord({
      nudgeCount: config.maxNudges,     // 2
      restartCount: config.maxRestarts,  // 3
      reassignCount: config.maxReassigns, // 1
      lastActionAt: 1_000_000,
    })
    const signals = makeSignals()
    const now = 1_000_000 + config.remediationCooldownMs + 1

    const result = decideRemediation(record, signals, config, now)

    expect(result!.action).toBe('escalate')
    expect(result!.reason).toContain('budgets exhausted')
  })

  it('returns escalate when total remediation time exceeded', () => {
    const record = makeRecord({
      firstDetectedAt: 1_000_000,
      nudgeCount: 1, // budgets still available
      lastActionAt: 1_000_000,
    })
    const signals = makeSignals()
    const now = 1_000_000 + config.maxTotalRemediationMs + 1

    const result = decideRemediation(record, signals, config, now)

    expect(result!.action).toBe('escalate')
    expect(result!.reason).toContain('Total remediation time exceeded')
  })

  it('returns null during cooldown period', () => {
    const record = makeRecord({
      lastActionAt: 1_000_000,
    })
    const signals = makeSignals()
    // Within cooldown window
    const now = 1_000_000 + config.remediationCooldownMs - 1000

    const result = decideRemediation(record, signals, config, now)

    expect(result).toBeNull()
  })

  it('returns null when already escalated', () => {
    const record = makeRecord({
      escalated: true,
      escalatedAt: 1_000_000,
      lastActionAt: 1_000_000,
    })
    const signals = makeSignals()
    const now = 1_000_000 + config.remediationCooldownMs + 1

    const result = decideRemediation(record, signals, config, now)

    expect(result).toBeNull()
  })

  it('includes signal details in reason', () => {
    const signals = makeSignals({
      sessionRunningTooLong: true,
      heartbeatStale: true,
    })
    const result = decideRemediation(null, signals, config, 2_000_000)

    expect(result!.reason).toContain('session running too long')
    expect(result!.reason).toContain('heartbeat stale')
  })

  it('time guard takes priority over cooldown', () => {
    const record = makeRecord({
      firstDetectedAt: 1_000_000,
      lastActionAt: 1_000_000 + config.maxTotalRemediationMs, // very recent
    })
    const signals = makeSignals()
    // Past total limit but within cooldown
    const now = 1_000_000 + config.maxTotalRemediationMs + 1

    const result = decideRemediation(record, signals, config, now)

    expect(result!.action).toBe('escalate')
  })
})
