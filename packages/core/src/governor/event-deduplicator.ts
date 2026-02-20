/**
 * Event Deduplicator
 *
 * Prevents duplicate processing of events within a configurable time window.
 * Dedup key is typically `${issueId}:${status}` — same issue at the same
 * status within the window is a duplicate.
 *
 * Two implementations:
 * - InMemoryEventDeduplicator: for testing and single-process CLI
 * - RedisEventDeduplicator: for production (in packages/server)
 */

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * Deduplicator contract. `isDuplicate` checks and marks atomically.
 */
export interface EventDeduplicator {
  /**
   * Check if a key has been seen within the dedup window.
   * If not seen, marks it and returns `false` (not a duplicate).
   * If seen, returns `true` (is a duplicate, skip processing).
   */
  isDuplicate(key: string): Promise<boolean>

  /**
   * Clear all dedup state. Primarily for testing.
   */
  clear(): Promise<void>
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface EventDeduplicatorConfig {
  /** Time window in milliseconds. Events with the same key within this window are considered duplicates. */
  windowMs: number
}

export const DEFAULT_DEDUP_CONFIG: EventDeduplicatorConfig = {
  windowMs: 10_000, // 10 seconds
}

// ---------------------------------------------------------------------------
// In-Memory Implementation
// ---------------------------------------------------------------------------

export class InMemoryEventDeduplicator implements EventDeduplicator {
  private seen = new Map<string, number>() // key → expiresAt
  private readonly windowMs: number

  constructor(config: Partial<EventDeduplicatorConfig> = {}) {
    this.windowMs = config.windowMs ?? DEFAULT_DEDUP_CONFIG.windowMs
  }

  async isDuplicate(key: string): Promise<boolean> {
    const now = Date.now()

    // Clean expired entries on each check (cheap for in-memory)
    this.cleanup(now)

    const expiresAt = this.seen.get(key)
    if (expiresAt !== undefined && now < expiresAt) {
      return true // duplicate
    }

    // Mark as seen
    this.seen.set(key, now + this.windowMs)
    return false
  }

  async clear(): Promise<void> {
    this.seen.clear()
  }

  /** Remove expired entries */
  private cleanup(now: number): void {
    for (const [key, expiresAt] of this.seen) {
      if (now >= expiresAt) {
        this.seen.delete(key)
      }
    }
  }

  // ---- Test helpers ----

  /** Get the number of active dedup entries */
  get size(): number {
    this.cleanup(Date.now())
    return this.seen.size
  }
}
