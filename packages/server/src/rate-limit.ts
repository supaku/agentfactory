/**
 * Rate Limiter with LRU Cache
 *
 * In-memory rate limiting using sliding window algorithm.
 * Uses LRU cache to prevent memory bloat from tracking many IPs.
 */

import { createLogger } from './logger'

const log = createLogger('rate-limit')

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  /** Maximum requests allowed in the window */
  limit: number
  /** Window size in milliseconds */
  windowMs: number
}

/**
 * Rate limit check result
 */
export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean
  /** Remaining requests in current window */
  remaining: number
  /** Time until window resets (milliseconds) */
  resetIn: number
  /** Total limit for this endpoint */
  limit: number
}

/**
 * Entry in the rate limit cache
 */
interface RateLimitEntry {
  /** Request timestamps in the current window */
  timestamps: number[]
  /** When this entry was last accessed */
  lastAccess: number
}

/**
 * Default rate limit configurations by endpoint type
 */
export const RATE_LIMITS = {
  /** Public API endpoints - 60 requests per minute */
  public: { limit: 60, windowMs: 60 * 1000 },
  /** Webhook endpoint - 10 requests per second per IP */
  webhook: { limit: 10, windowMs: 1000 },
  /** Dashboard - 30 requests per minute */
  dashboard: { limit: 30, windowMs: 60 * 1000 },
} as const

/**
 * LRU Rate Limiter
 *
 * Tracks request counts per key (typically IP address) using
 * sliding window algorithm. Old entries are evicted using LRU policy.
 */
export class RateLimiter {
  private cache: Map<string, RateLimitEntry> = new Map()
  private maxEntries: number
  private config: RateLimitConfig

  constructor(config: RateLimitConfig, maxEntries = 10000) {
    this.config = config
    this.maxEntries = maxEntries
  }

  /**
   * Check if a request should be allowed
   *
   * @param key - Unique identifier (usually IP address)
   * @returns Rate limit result
   */
  check(key: string): RateLimitResult {
    const now = Date.now()
    const windowStart = now - this.config.windowMs

    // Get or create entry
    let entry = this.cache.get(key)
    if (!entry) {
      entry = { timestamps: [], lastAccess: now }
    }

    // Filter timestamps to only include those in the current window
    entry.timestamps = entry.timestamps.filter((ts) => ts > windowStart)
    entry.lastAccess = now

    // Calculate remaining requests
    const requestCount = entry.timestamps.length
    const remaining = Math.max(0, this.config.limit - requestCount)
    const allowed = requestCount < this.config.limit

    // Add this request if allowed
    if (allowed) {
      entry.timestamps.push(now)
    }

    // Update cache
    this.cache.set(key, entry)

    // Evict old entries if needed
    this.evictIfNeeded()

    // Calculate reset time
    const oldestTimestamp = entry.timestamps[0]
    const resetIn = oldestTimestamp
      ? Math.max(0, oldestTimestamp + this.config.windowMs - now)
      : 0

    return {
      allowed,
      remaining: allowed ? remaining - 1 : 0,
      resetIn,
      limit: this.config.limit,
    }
  }

  /**
   * Evict least recently used entries if cache is full
   */
  private evictIfNeeded(): void {
    if (this.cache.size <= this.maxEntries) return

    // Find entries to evict (oldest lastAccess)
    const entries = Array.from(this.cache.entries())
    entries.sort((a, b) => a[1].lastAccess - b[1].lastAccess)

    // Remove oldest 10% of entries
    const toRemove = Math.ceil(this.maxEntries * 0.1)
    for (let i = 0; i < toRemove && i < entries.length; i++) {
      this.cache.delete(entries[i][0])
    }

    log.debug('Evicted rate limit entries', { removed: toRemove })
  }

  /**
   * Clear all entries (useful for testing)
   */
  clear(): void {
    this.cache.clear()
  }

  /**
   * Get current cache size
   */
  get size(): number {
    return this.cache.size
  }
}

// Singleton rate limiters for different endpoint types
const limiters: Map<string, RateLimiter> = new Map()

/**
 * Get or create a rate limiter for an endpoint type
 *
 * @param type - Endpoint type ('public', 'webhook', 'dashboard')
 * @returns Rate limiter instance
 */
export function getRateLimiter(
  type: keyof typeof RATE_LIMITS
): RateLimiter {
  let limiter = limiters.get(type)
  if (!limiter) {
    limiter = new RateLimiter(RATE_LIMITS[type])
    limiters.set(type, limiter)
  }
  return limiter
}

/**
 * Check rate limit for a request
 *
 * @param type - Endpoint type
 * @param key - Unique identifier (usually IP)
 * @returns Rate limit result
 */
export function checkRateLimit(
  type: keyof typeof RATE_LIMITS,
  key: string
): RateLimitResult {
  const limiter = getRateLimiter(type)
  return limiter.check(key)
}

/**
 * Extract client IP from request headers
 *
 * Handles various proxy scenarios (Vercel, Cloudflare, etc.)
 *
 * @param headers - Request headers
 * @returns Client IP address
 */
export function getClientIP(headers: Headers): string {
  // Vercel/Cloudflare proxy headers
  const forwardedFor = headers.get('x-forwarded-for')
  if (forwardedFor) {
    // Take first IP (client IP before proxies)
    return forwardedFor.split(',')[0].trim()
  }

  // Cloudflare specific
  const cfConnectingIP = headers.get('cf-connecting-ip')
  if (cfConnectingIP) {
    return cfConnectingIP
  }

  // Vercel specific
  const realIP = headers.get('x-real-ip')
  if (realIP) {
    return realIP
  }

  // Fallback
  return 'unknown'
}

/**
 * Build rate limit headers for response
 *
 * @param result - Rate limit result
 * @returns Headers object
 */
export function buildRateLimitHeaders(
  result: RateLimitResult
): Record<string, string> {
  return {
    'X-RateLimit-Limit': result.limit.toString(),
    'X-RateLimit-Remaining': result.remaining.toString(),
    'X-RateLimit-Reset': Math.ceil(result.resetIn / 1000).toString(),
  }
}
