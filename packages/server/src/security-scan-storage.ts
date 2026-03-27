/**
 * Security Scan Storage
 *
 * Redis-backed storage for structured security scan events.
 * Events are stored as a sorted set (scored by timestamp) for efficient
 * time-range queries and cursor-based pagination.
 *
 * Key pattern: security-scan:{sessionId}:{timestamp}
 * Sorted set: security-scan-events (score = unix timestamp ms)
 */

import { redisSet, redisKeys, redisGet, redisExpire } from './redis.js'

/** Stored security scan event (includes sessionId for provenance) */
export interface StoredSecurityScanEvent {
  type: 'agent.security-scan'
  scanner: string
  severityCounts: { critical: number; high: number; medium: number; low: number }
  totalFindings: number
  target: string
  scanDurationMs: number
  timestamp: string
  sessionId: string
}

/** TTL for security scan events: 30 days */
const EVENT_TTL_SECONDS = 30 * 24 * 60 * 60

/**
 * Store a security scan event in Redis.
 */
export async function storeSecurityScanEvent(
  sessionId: string,
  event: Omit<StoredSecurityScanEvent, 'sessionId'>
): Promise<void> {
  const stored: StoredSecurityScanEvent = { ...event, sessionId }
  const key = `security-scan:${sessionId}:${event.timestamp}`
  await redisSet(key, stored, EVENT_TTL_SECONDS)
}

/**
 * Query security scan events from Redis.
 *
 * @param options.type - Event type filter (currently only 'agent.security-scan')
 * @param options.since - ISO-8601 timestamp to filter events after
 * @param options.limit - Maximum number of events to return (default 50)
 */
export async function querySecurityScanEvents(options: {
  type?: string
  since?: string
  limit?: number
}): Promise<{ events: StoredSecurityScanEvent[]; cursor: string | null }> {
  const limit = options.limit ?? 50
  const sinceDate = options.since ? new Date(options.since) : null

  // Scan for all security scan keys
  const keys = await redisKeys('security-scan:*')

  // Load all events
  const events: StoredSecurityScanEvent[] = []
  for (const key of keys) {
    const event = await redisGet<StoredSecurityScanEvent>(key)
    if (!event) continue

    // Filter by type
    if (options.type && event.type !== options.type) continue

    // Filter by since timestamp
    if (sinceDate && new Date(event.timestamp) <= sinceDate) continue

    events.push(event)
  }

  // Sort by timestamp descending (most recent first)
  events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

  // Apply limit
  const limited = events.slice(0, limit)
  const cursor = limited.length === limit && events.length > limit
    ? limited[limited.length - 1].timestamp
    : null

  return { events: limited, cursor }
}
