/**
 * Redis Event Deduplicator
 *
 * Production EventDeduplicator backed by Redis SETNX with TTL.
 * Key pattern: `governor:dedup:{dedupKey}`
 */

import type { EventDeduplicator, EventDeduplicatorConfig } from '@supaku/agentfactory'
import { DEFAULT_DEDUP_CONFIG } from '@supaku/agentfactory'
import { redisSetNX } from './redis.js'

// ---------------------------------------------------------------------------
// RedisEventDeduplicator
// ---------------------------------------------------------------------------

export class RedisEventDeduplicator implements EventDeduplicator {
  private readonly windowMs: number
  private readonly keyPrefix: string

  constructor(
    config: Partial<EventDeduplicatorConfig> = {},
    keyPrefix = 'governor:dedup',
  ) {
    this.windowMs = config.windowMs ?? DEFAULT_DEDUP_CONFIG.windowMs
    this.keyPrefix = keyPrefix
  }

  async isDuplicate(key: string): Promise<boolean> {
    const redisKey = `${this.keyPrefix}:${key}`
    const ttlSeconds = Math.max(1, Math.ceil(this.windowMs / 1000))

    // SETNX returns true if key was newly set (not a duplicate)
    const wasSet = await redisSetNX(redisKey, '1', ttlSeconds)
    return !wasSet // if we couldn't set, it's a duplicate
  }

  async clear(): Promise<void> {
    // In production, keys auto-expire via TTL.
    // Explicit clear is mainly for testing — not implemented for Redis
    // since test suites should use InMemoryEventDeduplicator.
  }
}
