/**
 * Webhook Idempotency Module
 *
 * Prevents duplicate webhook processing using a two-layer approach:
 * 1. In-memory Set for fast local checks (avoids network latency)
 * 2. Redis for distributed/persistent storage (survives restarts)
 *
 * Uses webhookId (unique per delivery) as the primary key, falling back
 * to sessionId if webhookId is not available.
 */

import { isRedisConfigured, redisSet, redisExists, redisDel } from './redis'

const log = {
  info: (msg: string, data?: Record<string, unknown>) => console.log(`[idempotency] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) => console.warn(`[idempotency] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) => console.error(`[idempotency] ${msg}`, data ? JSON.stringify(data) : ''),
  debug: (_msg: string, _data?: Record<string, unknown>) => {},
}

/**
 * Key prefix for webhook idempotency keys in KV
 */
const WEBHOOK_KEY_PREFIX = 'webhook:processed:'

/**
 * Time window for deduplication (24 hours)
 * Linear's retry window is typically 24-48 hours
 */
const DEDUP_WINDOW_SECONDS = 24 * 60 * 60

/**
 * In-memory expiry for local cache (5 minutes)
 * Shorter than KV to prevent memory growth
 */
const MEMORY_EXPIRY_MS = 5 * 60 * 1000

/**
 * In-memory cache for fast local checks
 * Maps idempotency key to timestamp when it was added
 */
const processedWebhooks = new Map<string, number>()

/**
 * Build the KV key for a webhook idempotency entry
 */
function buildWebhookKey(idempotencyKey: string): string {
  return `${WEBHOOK_KEY_PREFIX}${idempotencyKey}`
}

/**
 * Generate an idempotency key from webhook data
 * Prefers webhookId (unique per delivery), falls back to sessionId
 */
export function generateIdempotencyKey(
  webhookId: string | undefined,
  sessionId: string
): string {
  // webhookId is unique per delivery attempt - best for idempotency
  if (webhookId) {
    return `wh:${webhookId}`
  }
  // Fallback to sessionId if webhookId not available
  return `session:${sessionId}`
}

/**
 * Check if a webhook has already been processed
 * First checks in-memory cache, then falls back to KV
 *
 * @param idempotencyKey - The key generated from generateIdempotencyKey
 * @returns Whether the webhook was already processed
 */
export async function isWebhookProcessed(
  idempotencyKey: string
): Promise<boolean> {
  // Fast path: check in-memory cache first
  if (processedWebhooks.has(idempotencyKey)) {
    log.info(`Cache hit (memory): ${idempotencyKey}`)
    return true
  }

  // Slow path: check Redis for distributed/persistent state
  if (isRedisConfigured()) {
    try {
      const key = buildWebhookKey(idempotencyKey)
      const exists = await redisExists(key)

      if (exists) {
        log.info(`Cache hit (Redis): ${idempotencyKey}`)
        // Warm up memory cache for subsequent checks
        processedWebhooks.set(idempotencyKey, Date.now())
        scheduleMemoryCleanup(idempotencyKey)
        return true
      }
    } catch (err) {
      // Log but don't fail - better to potentially double-process
      // than to block legitimate webhooks
      log.error('KV check failed', { error: err })
    }
  }

  return false
}

/**
 * Mark a webhook as processed in both memory and KV
 *
 * @param idempotencyKey - The key generated from generateIdempotencyKey
 */
export async function markWebhookProcessed(
  idempotencyKey: string
): Promise<void> {
  // Always update memory cache
  processedWebhooks.set(idempotencyKey, Date.now())
  scheduleMemoryCleanup(idempotencyKey)

  // Persist to Redis for distributed state
  if (isRedisConfigured()) {
    try {
      const key = buildWebhookKey(idempotencyKey)
      await redisSet(key, Date.now(), DEDUP_WINDOW_SECONDS)
      log.info(`Marked processed in Redis: ${idempotencyKey}`)
    } catch (err) {
      // Log but don't fail - memory cache provides some protection
      log.error('Redis write failed', { error: err })
    }
  }
}

/**
 * Remove a webhook from processed state (for cleanup after failed spawn)
 *
 * @param idempotencyKey - The key generated from generateIdempotencyKey
 */
export async function unmarkWebhookProcessed(
  idempotencyKey: string
): Promise<void> {
  // Remove from memory
  processedWebhooks.delete(idempotencyKey)

  // Remove from Redis
  if (isRedisConfigured()) {
    try {
      const key = buildWebhookKey(idempotencyKey)
      await redisDel(key)
      log.info(`Removed from Redis: ${idempotencyKey}`)
    } catch (err) {
      log.error('Redis delete failed', { error: err })
    }
  }
}

/**
 * Schedule cleanup of memory cache entry after expiry
 */
function scheduleMemoryCleanup(idempotencyKey: string): void {
  setTimeout(() => {
    processedWebhooks.delete(idempotencyKey)
  }, MEMORY_EXPIRY_MS)
}

/**
 * Get current cache statistics (for monitoring)
 */
export function getCacheStats(): {
  memorySize: number
  memoryExpiryMs: number
  kvExpirySeconds: number
} {
  return {
    memorySize: processedWebhooks.size,
    memoryExpiryMs: MEMORY_EXPIRY_MS,
    kvExpirySeconds: DEDUP_WINDOW_SECONDS,
  }
}
