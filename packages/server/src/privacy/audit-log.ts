/**
 * Audit Event Logging
 *
 * Tracks data access and modification events for GDPR compliance.
 * Stores events in Redis with configurable retention.
 *
 * Events are stored per-user for efficient export and deletion.
 */

import { redisRPush, redisLRange, redisLLen, redisDel, redisKeys, isRedisConfigured } from '../redis.js'
import { createLogger } from '../logger.js'

const log = createLogger('privacy/audit-log')

const AUDIT_KEY_PREFIX = 'audit:events:'
const AUDIT_TTL_DAYS = 90

export type AuditAction =
  | 'data.access'
  | 'data.export'
  | 'data.delete'
  | 'data.modify'
  | 'data.encrypt'
  | 'data.decrypt'
  | 'enrichment.add'
  | 'enrichment.remove'
  | 'account.login'
  | 'account.logout'
  | 'account.delete_request'
  | 'account.delete_cancel'
  | 'account.delete_execute'
  | 'consent.grant'
  | 'consent.revoke'
  | 'export.request'
  | 'export.complete'

export interface AuditEvent {
  /** Unique event ID */
  id: string
  /** User who performed the action */
  userId: string
  /** What action was taken */
  action: AuditAction
  /** Type of entity affected */
  entityType: string
  /** ID of the entity affected */
  entityId?: string
  /** Additional context about the event */
  details?: Record<string, unknown>
  /** IP address of the request */
  ipAddress?: string
  /** User agent string */
  userAgent?: string
  /** Unix timestamp */
  timestamp: number
}

/**
 * Build the Redis key for a user's audit events
 */
function buildAuditKey(userId: string): string {
  return `${AUDIT_KEY_PREFIX}${userId}`
}

/**
 * Generate a unique audit event ID
 */
function generateEventId(): string {
  return `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Log an audit event for a user
 */
export async function logAuditEvent(
  event: Omit<AuditEvent, 'id' | 'timestamp'>
): Promise<AuditEvent> {
  const fullEvent: AuditEvent = {
    ...event,
    id: generateEventId(),
    timestamp: Math.floor(Date.now() / 1000),
  }

  if (!isRedisConfigured()) {
    log.warn('Redis not configured, audit event not persisted', {
      action: event.action,
      userId: event.userId,
    })
    return fullEvent
  }

  const key = buildAuditKey(event.userId)
  await redisRPush(key, JSON.stringify(fullEvent))

  log.info('Audit event logged', {
    eventId: fullEvent.id,
    action: fullEvent.action,
    userId: fullEvent.userId,
    entityType: fullEvent.entityType,
  })

  return fullEvent
}

/**
 * Get audit events for a user with pagination
 */
export async function getAuditEvents(
  userId: string,
  options: { offset?: number; limit?: number; action?: AuditAction } = {}
): Promise<{ events: AuditEvent[]; total: number }> {
  if (!isRedisConfigured()) {
    return { events: [], total: 0 }
  }

  const key = buildAuditKey(userId)
  const total = await redisLLen(key)

  const offset = options.offset ?? 0
  const limit = options.limit ?? 50
  const end = offset + limit - 1

  const rawEvents = await redisLRange(key, offset, end)
  let events = rawEvents.map((raw) => JSON.parse(raw) as AuditEvent)

  if (options.action) {
    events = events.filter((e) => e.action === options.action)
  }

  return { events, total }
}

/**
 * Delete all audit events for a user (for account deletion)
 */
export async function deleteAuditEvents(userId: string): Promise<boolean> {
  if (!isRedisConfigured()) {
    return false
  }

  const key = buildAuditKey(userId)
  const result = await redisDel(key)

  log.info('Deleted audit events', { userId, deleted: result > 0 })
  return result > 0
}

/**
 * Export all audit events for a user (for GDPR data access request)
 */
export async function exportAuditEvents(userId: string): Promise<AuditEvent[]> {
  if (!isRedisConfigured()) {
    return []
  }

  const key = buildAuditKey(userId)
  const rawEvents = await redisLRange(key, 0, -1)
  return rawEvents.map((raw) => JSON.parse(raw) as AuditEvent)
}
