/**
 * Supervisor Storage Module
 *
 * Redis-backed persistence for fleet supervision state:
 * - SupervisorState: per-supervisor metadata and patrol counters
 * - RemediationRecord: per-session stuck remediation history
 * - WorkerHealthStatus: periodic health snapshots
 *
 * Redis Key Patterns:
 * - sup:supervisor:{supervisorId}  — SupervisorState (1h TTL, refreshed each patrol)
 * - sup:remediation:{sessionId}    — RemediationRecord (24h TTL)
 * - sup:health:{workerId}          — WorkerHealthStatus snapshot (5 min TTL)
 */

import { isRedisConfigured, redisSet, redisGet, redisDel } from './redis.js'
import type {
  SupervisorState,
  RemediationRecord,
  RemediationAction,
  WorkerHealthStatus,
} from './fleet-supervisor-types.js'

const log = {
  info: (msg: string, data?: Record<string, unknown>) => console.log(`[supervisor-storage] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) => console.warn(`[supervisor-storage] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) => console.error(`[supervisor-storage] ${msg}`, data ? JSON.stringify(data) : ''),
  debug: (_msg: string, _data?: Record<string, unknown>) => {},
}

// Redis key prefixes
const SUPERVISOR_PREFIX = 'sup:supervisor:'
const REMEDIATION_PREFIX = 'sup:remediation:'
const HEALTH_PREFIX = 'sup:health:'

// TTLs in seconds
const SUPERVISOR_TTL = 3600        // 1 hour
const REMEDIATION_TTL = 86400      // 24 hours (matches session TTL)
const HEALTH_SNAPSHOT_TTL = 300    // 5 minutes

// ---------------------------------------------------------------------------
// Supervisor State
// ---------------------------------------------------------------------------

export async function getSupervisorState(
  supervisorId: string
): Promise<SupervisorState | null> {
  if (!isRedisConfigured()) return null
  try {
    return await redisGet<SupervisorState>(`${SUPERVISOR_PREFIX}${supervisorId}`)
  } catch (error) {
    log.error('Failed to get supervisor state', { error, supervisorId })
    return null
  }
}

export async function setSupervisorState(
  state: SupervisorState
): Promise<void> {
  if (!isRedisConfigured()) return
  try {
    await redisSet(`${SUPERVISOR_PREFIX}${state.supervisorId}`, state, SUPERVISOR_TTL)
  } catch (error) {
    log.error('Failed to set supervisor state', { error, supervisorId: state.supervisorId })
  }
}

// ---------------------------------------------------------------------------
// Remediation Records
// ---------------------------------------------------------------------------

export async function getRemediationRecord(
  sessionId: string
): Promise<RemediationRecord | null> {
  if (!isRedisConfigured()) return null
  try {
    return await redisGet<RemediationRecord>(`${REMEDIATION_PREFIX}${sessionId}`)
  } catch (error) {
    log.error('Failed to get remediation record', { error, sessionId })
    return null
  }
}

export async function setRemediationRecord(
  record: RemediationRecord
): Promise<void> {
  if (!isRedisConfigured()) return
  try {
    await redisSet(`${REMEDIATION_PREFIX}${record.sessionId}`, record, REMEDIATION_TTL)
  } catch (error) {
    log.error('Failed to set remediation record', { error, sessionId: record.sessionId })
  }
}

/**
 * Record a remediation action by incrementing the appropriate counter
 * and appending a timestamp. Creates the record if it doesn't exist.
 */
export async function recordRemediationAction(
  sessionId: string,
  issueId: string,
  issueIdentifier: string,
  action: RemediationAction,
  now: number = Date.now()
): Promise<RemediationRecord> {
  const existing = await getRemediationRecord(sessionId)
  const record: RemediationRecord = existing ?? {
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

  record.lastActionAt = now
  record.updatedAt = now

  switch (action) {
    case 'nudge':
      record.nudgeCount++
      record.nudgeTimestamps.push(now)
      break
    case 'restart':
      record.restartCount++
      record.restartTimestamps.push(now)
      break
    case 'reassign':
      record.reassignCount++
      record.reassignTimestamps.push(now)
      break
    case 'escalate':
      record.escalated = true
      record.escalatedAt = now
      break
  }

  await setRemediationRecord(record)

  log.info('Recorded remediation action', {
    sessionId,
    action,
    nudgeCount: record.nudgeCount,
    restartCount: record.restartCount,
    reassignCount: record.reassignCount,
    escalated: record.escalated,
  })

  return record
}

export async function clearRemediationRecord(
  sessionId: string
): Promise<void> {
  if (!isRedisConfigured()) return
  try {
    await redisDel(`${REMEDIATION_PREFIX}${sessionId}`)
    log.debug('Cleared remediation record', { sessionId })
  } catch (error) {
    log.error('Failed to clear remediation record', { error, sessionId })
  }
}

// ---------------------------------------------------------------------------
// Worker Health Snapshots
// ---------------------------------------------------------------------------

export async function getWorkerHealthSnapshot(
  workerId: string
): Promise<WorkerHealthStatus | null> {
  if (!isRedisConfigured()) return null
  try {
    return await redisGet<WorkerHealthStatus>(`${HEALTH_PREFIX}${workerId}`)
  } catch (error) {
    log.error('Failed to get worker health snapshot', { error, workerId })
    return null
  }
}

export async function setWorkerHealthSnapshot(
  health: WorkerHealthStatus
): Promise<void> {
  if (!isRedisConfigured()) return
  try {
    await redisSet(`${HEALTH_PREFIX}${health.workerId}`, health, HEALTH_SNAPSHOT_TTL)
  } catch (error) {
    log.error('Failed to set worker health snapshot', { error, workerId: health.workerId })
  }
}
