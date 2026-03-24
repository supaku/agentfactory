/**
 * Fleet Quota State Tracking
 *
 * Real-time quota usage tracking: per-project concurrent session counting
 * and daily cost aggregation in Redis. Provides the state that QuotaFilter
 * queries to make admission decisions.
 *
 * Redis key schema:
 *   fleet:quota:concurrent:{name}           — Set of active session IDs (no TTL)
 *   fleet:quota:daily:{name}:{YYYY-MM-DD}   — Cost accumulator string (TTL = 48h)
 */

import {
  redisSAdd,
  redisSRem,
  redisSCard,
  redisSMembers,
  redisIncrByFloat,
  redisGet,
  redisExpire,
  redisExists,
} from './redis.js'
import { createLogger } from './logger.js'
import { getCohortConfig } from './fleet-quota-storage.js'
import type { FleetQuotaUsage } from './fleet-quota-types.js'

const log = createLogger('fleet-quota-tracker')

const CONCURRENT_PREFIX = 'fleet:quota:concurrent:'
const DAILY_PREFIX = 'fleet:quota:daily:'
const DAILY_TTL_SECONDS = 48 * 60 * 60 // 48 hours

// ---------------------------------------------------------------------------
// Concurrent Session Tracking
// ---------------------------------------------------------------------------

/**
 * Add a session to a quota pool's concurrent set.
 * @returns the new concurrent session count
 */
export async function addConcurrentSession(
  quotaName: string,
  sessionId: string
): Promise<number> {
  const key = `${CONCURRENT_PREFIX}${quotaName}`
  await redisSAdd(key, sessionId)
  const count = await redisSCard(key)
  log.debug('Session added to quota pool', { quotaName, sessionId, count })
  return count
}

/**
 * Remove a session from a quota pool's concurrent set.
 * Idempotent — removing a non-member is a no-op.
 * @returns the new concurrent session count
 */
export async function removeConcurrentSession(
  quotaName: string,
  sessionId: string
): Promise<number> {
  const key = `${CONCURRENT_PREFIX}${quotaName}`
  await redisSRem(key, sessionId)
  const count = await redisSCard(key)
  log.debug('Session removed from quota pool', { quotaName, sessionId, count })
  return count
}

/**
 * Get the current concurrent session count for a quota pool.
 */
export async function getConcurrentSessionCount(
  quotaName: string
): Promise<number> {
  const key = `${CONCURRENT_PREFIX}${quotaName}`
  return redisSCard(key)
}

/**
 * Get all session IDs in a quota pool (for debugging/dashboard).
 */
export async function getConcurrentSessionIds(
  quotaName: string
): Promise<string[]> {
  const key = `${CONCURRENT_PREFIX}${quotaName}`
  return redisSMembers(key)
}

// ---------------------------------------------------------------------------
// Daily Cost Tracking
// ---------------------------------------------------------------------------

function todayKey(quotaName: string): string {
  const date = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  return `${DAILY_PREFIX}${quotaName}:${date}`
}

function dateKey(quotaName: string, date: string): string {
  return `${DAILY_PREFIX}${quotaName}:${date}`
}

/**
 * Add cost to today's daily accumulator (atomic increment).
 * Sets 48h TTL on first write to allow late-arriving cost updates.
 * @returns the new daily total
 */
export async function addDailyCost(
  quotaName: string,
  costUsd: number
): Promise<number> {
  const key = todayKey(quotaName)

  // Check if key exists before increment to set TTL on first write
  const existed = await redisExists(key)

  const newTotal = await redisIncrByFloat(key, costUsd)

  if (!existed) {
    await redisExpire(key, DAILY_TTL_SECONDS)
  }

  log.debug('Daily cost updated', { quotaName, costUsd, newTotal })
  return newTotal
}

/**
 * Get current daily cost for a quota.
 */
export async function getDailyCost(quotaName: string): Promise<number> {
  const key = todayKey(quotaName)
  const value = await redisGet<string>(key)
  return value ? parseFloat(String(value)) : 0
}

/**
 * Get daily cost for a specific date (historical).
 */
export async function getDailyCostForDate(
  quotaName: string,
  date: string
): Promise<number> {
  const key = dateKey(quotaName, date)
  const value = await redisGet<string>(key)
  return value ? parseFloat(String(value)) : 0
}

// ---------------------------------------------------------------------------
// Combined Usage Snapshot
// ---------------------------------------------------------------------------

/**
 * Get full usage snapshot for a quota (used by QuotaFilter).
 */
export async function getQuotaUsage(
  quotaName: string
): Promise<FleetQuotaUsage> {
  const [currentSessions, dailyCostUsd] = await Promise.all([
    getConcurrentSessionCount(quotaName),
    getDailyCost(quotaName),
  ])

  return {
    currentSessions,
    dailyCostUsd,
    lastResetAt: 0, // Daily cost resets via key expiry, not explicit reset
  }
}

/**
 * Get usage for all quotas in a cohort (used by borrowing/lending).
 */
export async function getCohortUsage(
  cohortName: string
): Promise<Map<string, FleetQuotaUsage>> {
  const cohort = await getCohortConfig(cohortName)
  const usageMap = new Map<string, FleetQuotaUsage>()

  if (!cohort) return usageMap

  const usages = await Promise.all(
    cohort.projects.map(async (project) => ({
      project,
      usage: await getQuotaUsage(project),
    }))
  )

  for (const { project, usage } of usages) {
    usageMap.set(project, usage)
  }

  return usageMap
}

// ---------------------------------------------------------------------------
// Stale Session Cleanup
// ---------------------------------------------------------------------------

/**
 * Remove sessions from concurrent sets that are no longer active.
 * Called by patrol-loop to handle crashed workers.
 * @returns number of stale sessions removed
 */
export async function cleanupStaleSessions(
  quotaName: string,
  activeSessionIds: Set<string>
): Promise<number> {
  const currentIds = await getConcurrentSessionIds(quotaName)
  let removed = 0

  for (const sessionId of currentIds) {
    if (!activeSessionIds.has(sessionId)) {
      await removeConcurrentSession(quotaName, sessionId)
      removed++
    }
  }

  if (removed > 0) {
    log.info('Cleaned up stale sessions from quota pool', {
      quotaName,
      removed,
    })
  }

  return removed
}
