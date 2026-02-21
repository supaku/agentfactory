/**
 * Linear API Quota Tracker
 *
 * Stores Linear's rate limit response headers in Redis so any component
 * can check the remaining budget before making a call.
 *
 * Redis keys:
 * - `linear:quota:{workspaceId}:requests_remaining`
 * - `linear:quota:{workspaceId}:complexity_remaining`
 * - `linear:quota:{workspaceId}:requests_reset`  (timestamp)
 * - `linear:quota:{workspaceId}:updated_at`       (timestamp)
 *
 * Usage:
 * - After every Linear API call, call `recordQuota()` with response headers
 * - Before making a call, check `getQuota()` to see remaining budget
 * - If `requestsRemaining < LOW_QUOTA_THRESHOLD`, the rate limiter
 *   should proactively throttle
 */

import { getRedisClient } from './redis.js'
import { createLogger } from './logger.js'

const log = createLogger('quota-tracker')

/** Threshold below which we should proactively throttle */
export const LOW_QUOTA_THRESHOLD = 500

/** Default quota TTL in Redis (2 hours, matching Linear's hourly reset) */
const QUOTA_TTL_SECONDS = 7200

export interface LinearQuotaSnapshot {
  /** Remaining request quota (from X-RateLimit-Requests-Remaining) */
  requestsRemaining: number | null
  /** Remaining complexity quota (from X-RateLimit-Complexity-Remaining) */
  complexityRemaining: number | null
  /** Timestamp when request quota resets (from X-RateLimit-Requests-Reset) */
  requestsReset: number | null
  /** When this snapshot was last updated */
  updatedAt: number
}

/**
 * Record quota information from Linear API response headers.
 *
 * Call this after every successful Linear API response.
 */
export async function recordQuota(
  workspaceId: string,
  headers: {
    requestsRemaining?: string | number | null
    complexityRemaining?: string | number | null
    requestsReset?: string | number | null
  }
): Promise<void> {
  try {
    const redis = getRedisClient()
    const prefix = `linear:quota:${workspaceId}`
    const pipeline = redis.pipeline()
    const now = Date.now()

    if (headers.requestsRemaining != null) {
      const value = String(headers.requestsRemaining)
      pipeline.set(`${prefix}:requests_remaining`, value, 'EX', QUOTA_TTL_SECONDS)

      const remaining = parseInt(value, 10)
      if (!isNaN(remaining) && remaining < LOW_QUOTA_THRESHOLD) {
        log.warn('Linear quota running low', {
          workspaceId,
          requestsRemaining: remaining,
        })
      }
    }

    if (headers.complexityRemaining != null) {
      pipeline.set(
        `${prefix}:complexity_remaining`,
        String(headers.complexityRemaining),
        'EX',
        QUOTA_TTL_SECONDS
      )
    }

    if (headers.requestsReset != null) {
      pipeline.set(
        `${prefix}:requests_reset`,
        String(headers.requestsReset),
        'EX',
        QUOTA_TTL_SECONDS
      )
    }

    pipeline.set(`${prefix}:updated_at`, String(now), 'EX', QUOTA_TTL_SECONDS)

    await pipeline.exec()
  } catch (err) {
    // Non-critical — log and continue
    log.error('Failed to record quota', {
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Get the current quota snapshot for a workspace.
 */
export async function getQuota(workspaceId: string): Promise<LinearQuotaSnapshot> {
  try {
    const redis = getRedisClient()
    const prefix = `linear:quota:${workspaceId}`

    const [requestsRemaining, complexityRemaining, requestsReset, updatedAt] =
      await Promise.all([
        redis.get(`${prefix}:requests_remaining`),
        redis.get(`${prefix}:complexity_remaining`),
        redis.get(`${prefix}:requests_reset`),
        redis.get(`${prefix}:updated_at`),
      ])

    return {
      requestsRemaining: requestsRemaining ? parseInt(requestsRemaining, 10) : null,
      complexityRemaining: complexityRemaining
        ? parseInt(complexityRemaining, 10)
        : null,
      requestsReset: requestsReset ? parseInt(requestsReset, 10) : null,
      updatedAt: updatedAt ? parseInt(updatedAt, 10) : 0,
    }
  } catch (err) {
    log.error('Failed to get quota', {
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    })
    return {
      requestsRemaining: null,
      complexityRemaining: null,
      requestsReset: null,
      updatedAt: 0,
    }
  }
}

/**
 * Check if quota is critically low for a workspace.
 *
 * Returns true if we know the quota is below the threshold.
 * Returns false if quota is healthy or unknown (fail open).
 */
export async function isQuotaLow(workspaceId: string): Promise<boolean> {
  const quota = await getQuota(workspaceId)

  if (quota.requestsRemaining === null) return false // unknown = allow

  // Check staleness — if data is older than 5 minutes, don't trust it
  const staleThreshold = 5 * 60 * 1000
  if (Date.now() - quota.updatedAt > staleThreshold) return false

  return quota.requestsRemaining < LOW_QUOTA_THRESHOLD
}

/**
 * Extract quota headers from a Linear API response.
 *
 * Works with both fetch Response objects and plain header objects.
 */
export function extractQuotaHeaders(response: unknown): {
  requestsRemaining?: string
  complexityRemaining?: string
  requestsReset?: string
} {
  const result: {
    requestsRemaining?: string
    complexityRemaining?: string
    requestsReset?: string
  } = {}

  if (typeof response !== 'object' || response === null) return result

  const resp = response as Record<string, unknown>

  // Try fetch-style Response with .headers.get()
  const headers = resp.headers as Record<string, unknown> | undefined
  if (headers) {
    if (typeof (headers as { get?: unknown }).get === 'function') {
      const getHeader = (headers as { get: (name: string) => string | null }).get
      const rr = getHeader.call(headers, 'x-ratelimit-requests-remaining')
      const cr = getHeader.call(headers, 'x-ratelimit-complexity-remaining')
      const rs = getHeader.call(headers, 'x-ratelimit-requests-reset')
      if (rr) result.requestsRemaining = rr
      if (cr) result.complexityRemaining = cr
      if (rs) result.requestsReset = rs
    } else {
      // Plain object headers
      const rr = headers['x-ratelimit-requests-remaining'] as string | undefined
      const cr = headers['x-ratelimit-complexity-remaining'] as string | undefined
      const rs = headers['x-ratelimit-requests-reset'] as string | undefined
      if (rr) result.requestsRemaining = rr
      if (cr) result.complexityRemaining = cr
      if (rs) result.requestsReset = rs
    }
  }

  return result
}
