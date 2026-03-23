/**
 * Stuck Worker Decision Tree
 *
 * Determines the next remediation action for a stuck session based on
 * the history of previous attempts and configured budgets.
 *
 * Decision order:
 * 1. NUDGE (max 2): Signal worker to report status. Cheapest action.
 * 2. RESTART (max 3): Deregister worker, re-queue work.
 * 3. REASSIGN (max 1): Move session to a different worker.
 * 4. ESCALATE (terminal): Requires human intervention.
 *
 * Time guard: If total remediation time exceeds maxTotalRemediationMs (~45 min),
 * escalate immediately regardless of remaining budgets.
 *
 * All functions are pure — no I/O.
 */

import type {
  RemediationRecord,
  RemediationDecision,
  StuckSignals,
  StuckDetectionConfig,
} from './fleet-supervisor-types.js'

/**
 * Create an initial remediation record for a newly-detected stuck session.
 */
export function createInitialRemediationRecord(
  sessionId: string,
  issueId: string,
  issueIdentifier: string,
  now: number
): RemediationRecord {
  return {
    sessionId,
    issueId,
    issueIdentifier,
    nudgeCount: 0,
    nudgeTimestamps: [],
    restartCount: 0,
    restartTimestamps: [],
    reassignCount: 0,
    reassignTimestamps: [],
    escalated: false,
    firstDetectedAt: now,
    lastActionAt: now,
    updatedAt: now,
  }
}

/**
 * Determine the next remediation action for a stuck session.
 *
 * Returns null if the cooldown period has not elapsed since the last action
 * (caller should skip this cycle and wait).
 *
 * Returns an escalation decision if the record is already escalated.
 */
export function decideRemediation(
  record: RemediationRecord | null,
  signals: StuckSignals,
  config: StuckDetectionConfig,
  now: number
): RemediationDecision | null {
  // If no signals are active, nothing to do
  if (!signals.isStuck) {
    return null
  }

  // If no record exists, this is first detection — always nudge
  if (!record) {
    return {
      sessionId: '',
      workerId: '',
      action: 'nudge',
      reason: buildReason(signals, 'First detection'),
      attemptNumber: 1,
      maxAttempts: config.maxNudges,
    }
  }

  // Already escalated — nothing more to do
  if (record.escalated) {
    return null
  }

  // Nudge effectiveness check: if a nudge was sent, check if activity resumed within timeout
  if (record.nudgeCount > 0 && record.nudgeTimestamps.length > 0) {
    const lastNudge = record.nudgeTimestamps[record.nudgeTimestamps.length - 1]
    const timeSinceNudge = now - lastNudge

    if (timeSinceNudge >= config.nudgeEffectivenessTimeoutMs) {
      // Check if activity resumed: if the signal says activity resumed, nudge worked
      if (signals.activityResumedAfterNudge) {
        // Nudge succeeded — activity resumed, clear stuck state by returning null
        return null
      }
      // Nudge failed — no activity within timeout, escalate to restart immediately
      // This bypasses the normal cooldown
      return {
        sessionId: record.sessionId,
        workerId: '',
        action: 'restart',
        reason: `Nudge failed: no activity within ${Math.round(config.nudgeEffectivenessTimeoutMs / 60_000)} minutes`,
        attemptNumber: record.restartCount + 1,
        maxAttempts: config.maxRestarts,
      }
    }
  }

  // Time guard: force escalation if total time exceeded
  const totalTime = now - record.firstDetectedAt
  if (totalTime > config.maxTotalRemediationMs) {
    return {
      sessionId: record.sessionId,
      workerId: '',
      action: 'escalate',
      reason: `Total remediation time exceeded (${Math.round(totalTime / 60_000)}min > ${Math.round(config.maxTotalRemediationMs / 60_000)}min)`,
      attemptNumber: 1,
      maxAttempts: 1,
    }
  }

  // Cooldown guard: skip if last action was too recent
  const timeSinceLastAction = now - record.lastActionAt
  if (timeSinceLastAction < config.remediationCooldownMs) {
    return null
  }

  // Decision ladder: nudge → restart → reassign → escalate
  if (record.nudgeCount < config.maxNudges) {
    return {
      sessionId: record.sessionId,
      workerId: '',
      action: 'nudge',
      reason: buildReason(signals, 'Nudge attempt'),
      attemptNumber: record.nudgeCount + 1,
      maxAttempts: config.maxNudges,
    }
  }

  if (record.restartCount < config.maxRestarts) {
    return {
      sessionId: record.sessionId,
      workerId: '',
      action: 'restart',
      reason: buildReason(signals, 'Restart after nudge budget exhausted'),
      attemptNumber: record.restartCount + 1,
      maxAttempts: config.maxRestarts,
    }
  }

  if (record.reassignCount < config.maxReassigns) {
    return {
      sessionId: record.sessionId,
      workerId: '',
      action: 'reassign',
      reason: buildReason(signals, 'Reassign after restart budget exhausted'),
      attemptNumber: record.reassignCount + 1,
      maxAttempts: config.maxReassigns,
    }
  }

  // All budgets exhausted
  return {
    sessionId: record.sessionId,
    workerId: '',
    action: 'escalate',
    reason: buildReason(signals, 'All remediation budgets exhausted'),
    attemptNumber: 1,
    maxAttempts: 1,
  }
}

/**
 * Build a human-readable reason string from active stuck signals.
 */
function buildReason(signals: StuckSignals, prefix: string): string {
  const parts: string[] = [prefix]

  if (signals.sessionRunningTooLong) {
    parts.push('session running too long')
  }
  if (signals.heartbeatStale) {
    parts.push('heartbeat stale')
  }
  if (signals.claimStuck) {
    parts.push('claim stuck')
  }
  if (signals.toolLoopStuck) {
    parts.push('tool loop detected')
  }

  if (signals.stuckDurationMs > 0) {
    parts.push(`stuck for ${Math.round(signals.stuckDurationMs / 1000)}s`)
  }

  return parts.join(': ')
}
