/**
 * Merge Queue Storage Module
 *
 * Redis-backed merge queue with sorted set ordering and state tracking.
 * Manages the lifecycle of PRs through the merge queue: enqueue, dequeue,
 * processing, completed, failed, and blocked states.
 *
 * Data Structures:
 * - merge:queue:{repoId} (Sorted Set): score = priority * 1e13 + timestamp, member = prNumber
 * - merge:items:{repoId} (Hash): prNumber -> JSON entry details
 * - merge:processing:{repoId} (String): currently-processing PR JSON (with TTL)
 * - merge:failed:{repoId} (Hash): prNumber -> JSON { entry, reason }
 * - merge:blocked:{repoId} (Hash): prNumber -> JSON { entry, reason }
 * - merge:history:{repoId} (List): recent merge results (capped at 100)
 */

import {
  isRedisConfigured,
  redisZAdd,
  redisZRem,
  redisZRangeByScore,
  redisZCard,
  redisZPopMin,
  redisHSet,
  redisHGet,
  redisHDel,
  redisHGetAll,
  redisHLen,
  redisSet,
  redisGet,
  redisDel,
  redisExpire,
  redisRPush,
  redisEval,
} from './redis.js'

const log = {
  info: (msg: string, data?: Record<string, unknown>) =>
    console.log(`[merge-queue-storage] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) =>
    console.warn(`[merge-queue-storage] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) =>
    console.error(`[merge-queue-storage] ${msg}`, data ? JSON.stringify(data) : ''),
  debug: (_msg: string, _data?: Record<string, unknown>) => {},
}

// ============================================
// Types
// ============================================

export interface MergeQueueEntry {
  repoId: string
  prNumber: number
  prUrl: string
  issueIdentifier: string
  priority: number       // 1-5
  enqueuedAt: number     // Unix timestamp
  sourceBranch: string
  targetBranch: string
}

export interface MergeQueueStatus {
  depth: number
  processing: MergeQueueEntry | null
  failedCount: number
  blockedCount: number
}

// ============================================
// Key Helpers
// ============================================

const QUEUE_PREFIX = 'merge:queue:'
const ITEMS_PREFIX = 'merge:items:'
const PROCESSING_PREFIX = 'merge:processing:'
const FAILED_PREFIX = 'merge:failed:'
const BLOCKED_PREFIX = 'merge:blocked:'
const HISTORY_PREFIX = 'merge:history:'

function queueKey(repoId: string): string {
  return `${QUEUE_PREFIX}${repoId}`
}

function itemsKey(repoId: string): string {
  return `${ITEMS_PREFIX}${repoId}`
}

function processingKey(repoId: string): string {
  return `${PROCESSING_PREFIX}${repoId}`
}

function failedKey(repoId: string): string {
  return `${FAILED_PREFIX}${repoId}`
}

function blockedKey(repoId: string): string {
  return `${BLOCKED_PREFIX}${repoId}`
}

function historyKey(repoId: string): string {
  return `${HISTORY_PREFIX}${repoId}`
}

// Default processing TTL: 30 minutes (crash recovery)
const DEFAULT_PROCESSING_TTL = 30 * 60

// History list cap
const HISTORY_CAP = 100

// ============================================
// Score Calculation
// ============================================

/**
 * Calculate priority score for sorted set.
 * Lower scores = higher priority (processed first).
 * Score = (priority * 1e13) + timestamp
 */
export function calculateMergeScore(priority: number, enqueuedAt: number): number {
  const clampedPriority = Math.max(1, Math.min(5, priority))
  return clampedPriority * 1e13 + enqueuedAt
}

// ============================================
// Lua Scripts
// ============================================

/**
 * Lua script for atomic RPUSH + LTRIM to cap history list.
 * KEYS[1] = history list key
 * ARGV[1] = value to push
 * ARGV[2] = max length (cap)
 */
const RPUSH_AND_TRIM_SCRIPT = `
redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('LTRIM', KEYS[1], -tonumber(ARGV[2]), -1)
return 1
`

// ============================================
// MergeQueueStorage Class
// ============================================

export class MergeQueueStorage {
  /**
   * Enqueue: Add PR to sorted set with score = priority * 1e13 + timestamp.
   * Store entry details in hash.
   */
  async enqueue(entry: MergeQueueEntry): Promise<void> {
    if (!isRedisConfigured()) {
      log.warn('Redis not configured, cannot enqueue')
      return
    }

    try {
      const score = calculateMergeScore(entry.priority, entry.enqueuedAt)
      const member = String(entry.prNumber)
      const serialized = JSON.stringify(entry)

      // Store entry details in hash
      await redisHSet(itemsKey(entry.repoId), member, serialized)

      // Add to sorted set for ordering
      await redisZAdd(queueKey(entry.repoId), score, member)

      log.info('PR enqueued', {
        repoId: entry.repoId,
        prNumber: entry.prNumber,
        priority: entry.priority,
        score,
      })
    } catch (error) {
      log.error('Failed to enqueue PR', {
        error: error instanceof Error ? error.message : String(error),
        repoId: entry.repoId,
        prNumber: entry.prNumber,
      })
      throw error
    }
  }

  /**
   * Dequeue: Atomically pop lowest-score item from queue, move to processing.
   * Set processing key with TTL for crash recovery.
   */
  async dequeue(repoId: string, ttlSeconds: number = DEFAULT_PROCESSING_TTL): Promise<MergeQueueEntry | null> {
    if (!isRedisConfigured()) {
      log.warn('Redis not configured, cannot dequeue')
      return null
    }

    try {
      // Pop lowest-score member from sorted set
      const popped = await redisZPopMin(queueKey(repoId))

      if (!popped) {
        return null
      }

      const prNumber = popped.member

      // Get entry details from hash
      const entryJson = await redisHGet(itemsKey(repoId), prNumber)

      if (!entryJson) {
        log.warn('Entry not found in hash after zpopmin', { repoId, prNumber })
        return null
      }

      const entry = JSON.parse(entryJson) as MergeQueueEntry

      // Remove from items hash
      await redisHDel(itemsKey(repoId), prNumber)

      // Set as processing with TTL for crash recovery
      await redisSet(processingKey(repoId), entry, ttlSeconds)

      log.info('PR dequeued for processing', {
        repoId,
        prNumber: entry.prNumber,
      })

      return entry
    } catch (error) {
      log.error('Failed to dequeue', {
        error: error instanceof Error ? error.message : String(error),
        repoId,
      })
      return null
    }
  }

  /**
   * Peek: View next item without removing.
   */
  async peek(repoId: string): Promise<MergeQueueEntry | null> {
    if (!isRedisConfigured()) {
      return null
    }

    try {
      // Get the lowest-score member (limit 1)
      const members = await redisZRangeByScore(queueKey(repoId), '-inf', '+inf', 1)

      if (members.length === 0) {
        return null
      }

      const prNumber = members[0]
      const entryJson = await redisHGet(itemsKey(repoId), prNumber)

      if (!entryJson) {
        return null
      }

      return JSON.parse(entryJson) as MergeQueueEntry
    } catch (error) {
      log.error('Failed to peek', {
        error: error instanceof Error ? error.message : String(error),
        repoId,
      })
      return null
    }
  }

  /**
   * Reorder: Update score for a PR with a new priority.
   */
  async reorder(repoId: string, prNumber: number, newPriority: number): Promise<void> {
    if (!isRedisConfigured()) {
      log.warn('Redis not configured, cannot reorder')
      return
    }

    try {
      const member = String(prNumber)
      const entryJson = await redisHGet(itemsKey(repoId), member)

      if (!entryJson) {
        log.warn('Entry not found for reorder', { repoId, prNumber })
        return
      }

      const entry = JSON.parse(entryJson) as MergeQueueEntry

      // Update priority in stored entry
      entry.priority = newPriority
      await redisHSet(itemsKey(repoId), member, JSON.stringify(entry))

      // Update score in sorted set
      const newScore = calculateMergeScore(newPriority, entry.enqueuedAt)
      await redisZAdd(queueKey(repoId), newScore, member)

      log.info('PR reordered', { repoId, prNumber, newPriority, newScore })
    } catch (error) {
      log.error('Failed to reorder', {
        error: error instanceof Error ? error.message : String(error),
        repoId,
        prNumber,
      })
      throw error
    }
  }

  /**
   * Mark completed: Remove from processing, add to history list (capped at 100).
   */
  async markCompleted(repoId: string, prNumber: number): Promise<void> {
    if (!isRedisConfigured()) {
      log.warn('Redis not configured, cannot mark completed')
      return
    }

    try {
      // Remove processing key
      await redisDel(processingKey(repoId))

      // Add to history (RPUSH + LTRIM atomically)
      const historyEntry = JSON.stringify({
        prNumber,
        completedAt: Date.now(),
        status: 'completed',
      })

      await redisEval(RPUSH_AND_TRIM_SCRIPT, [historyKey(repoId)], [historyEntry, HISTORY_CAP])

      log.info('PR marked completed', { repoId, prNumber })
    } catch (error) {
      log.error('Failed to mark completed', {
        error: error instanceof Error ? error.message : String(error),
        repoId,
        prNumber,
      })
      throw error
    }
  }

  /**
   * Mark failed: Move to failed hash with error context.
   */
  async markFailed(repoId: string, prNumber: number, reason: string): Promise<void> {
    if (!isRedisConfigured()) {
      log.warn('Redis not configured, cannot mark failed')
      return
    }

    try {
      // Get current processing entry if it matches
      const processingJson = await redisGet<MergeQueueEntry>(processingKey(repoId))
      let entry: MergeQueueEntry | null = null

      if (processingJson && processingJson.prNumber === prNumber) {
        entry = processingJson
        // Remove from processing
        await redisDel(processingKey(repoId))
      }

      // Store in failed hash
      const failedData = JSON.stringify({ entry, reason })
      await redisHSet(failedKey(repoId), String(prNumber), failedData)

      log.info('PR marked failed', { repoId, prNumber, reason })
    } catch (error) {
      log.error('Failed to mark failed', {
        error: error instanceof Error ? error.message : String(error),
        repoId,
        prNumber,
      })
      throw error
    }
  }

  /**
   * Mark blocked: Move to blocked hash with conflict context.
   */
  async markBlocked(repoId: string, prNumber: number, reason: string): Promise<void> {
    if (!isRedisConfigured()) {
      log.warn('Redis not configured, cannot mark blocked')
      return
    }

    try {
      // Get current processing entry if it matches
      const processingJson = await redisGet<MergeQueueEntry>(processingKey(repoId))
      let entry: MergeQueueEntry | null = null

      if (processingJson && processingJson.prNumber === prNumber) {
        entry = processingJson
        // Remove from processing
        await redisDel(processingKey(repoId))
      }

      // Store in blocked hash
      const blockedData = JSON.stringify({ entry, reason })
      await redisHSet(blockedKey(repoId), String(prNumber), blockedData)

      log.info('PR marked blocked', { repoId, prNumber, reason })
    } catch (error) {
      log.error('Failed to mark blocked', {
        error: error instanceof Error ? error.message : String(error),
        repoId,
        prNumber,
      })
      throw error
    }
  }

  /**
   * Get status: Return queue depth, processing item, failed count, blocked count.
   */
  async getStatus(repoId: string): Promise<MergeQueueStatus> {
    if (!isRedisConfigured()) {
      return { depth: 0, processing: null, failedCount: 0, blockedCount: 0 }
    }

    try {
      const [depth, processingJson, failedCount, blockedCount] = await Promise.all([
        redisZCard(queueKey(repoId)),
        redisGet<MergeQueueEntry>(processingKey(repoId)),
        redisHLen(failedKey(repoId)),
        redisHLen(blockedKey(repoId)),
      ])

      return {
        depth,
        processing: processingJson ?? null,
        failedCount,
        blockedCount,
      }
    } catch (error) {
      log.error('Failed to get status', {
        error: error instanceof Error ? error.message : String(error),
        repoId,
      })
      return { depth: 0, processing: null, failedCount: 0, blockedCount: 0 }
    }
  }

  /**
   * Retry: Move from failed/blocked back to queue.
   */
  async retry(repoId: string, prNumber: number): Promise<void> {
    if (!isRedisConfigured()) {
      log.warn('Redis not configured, cannot retry')
      return
    }

    try {
      const member = String(prNumber)
      let entry: MergeQueueEntry | null = null

      // Check failed hash first
      const failedJson = await redisHGet(failedKey(repoId), member)
      if (failedJson) {
        const failedData = JSON.parse(failedJson) as { entry: MergeQueueEntry; reason: string }
        entry = failedData.entry
        await redisHDel(failedKey(repoId), member)
      }

      // Check blocked hash
      if (!entry) {
        const blockedJson = await redisHGet(blockedKey(repoId), member)
        if (blockedJson) {
          const blockedData = JSON.parse(blockedJson) as { entry: MergeQueueEntry; reason: string }
          entry = blockedData.entry
          await redisHDel(blockedKey(repoId), member)
        }
      }

      if (!entry) {
        log.warn('Entry not found in failed or blocked for retry', { repoId, prNumber })
        return
      }

      // Re-enqueue with updated timestamp
      entry.enqueuedAt = Date.now()
      await this.enqueue(entry)

      log.info('PR retried', { repoId, prNumber })
    } catch (error) {
      log.error('Failed to retry', {
        error: error instanceof Error ? error.message : String(error),
        repoId,
        prNumber,
      })
      throw error
    }
  }

  /**
   * Skip: Remove from queue entirely.
   */
  async skip(repoId: string, prNumber: number): Promise<void> {
    if (!isRedisConfigured()) {
      log.warn('Redis not configured, cannot skip')
      return
    }

    try {
      const member = String(prNumber)

      // Remove from sorted set
      await redisZRem(queueKey(repoId), member)

      // Remove from items hash
      await redisHDel(itemsKey(repoId), member)

      log.info('PR skipped', { repoId, prNumber })
    } catch (error) {
      log.error('Failed to skip', {
        error: error instanceof Error ? error.message : String(error),
        repoId,
        prNumber,
      })
      throw error
    }
  }

  /**
   * List: Return all queued entries ordered by score.
   */
  async list(repoId: string): Promise<MergeQueueEntry[]> {
    if (!isRedisConfigured()) {
      return []
    }

    try {
      // Get all members from sorted set in priority order
      const members = await redisZRangeByScore(queueKey(repoId), '-inf', '+inf')

      if (members.length === 0) {
        return []
      }

      const entries: MergeQueueEntry[] = []

      for (const member of members) {
        const entryJson = await redisHGet(itemsKey(repoId), member)
        if (entryJson) {
          try {
            entries.push(JSON.parse(entryJson) as MergeQueueEntry)
          } catch {
            log.warn('Failed to parse entry in list', { repoId, member })
          }
        }
      }

      return entries
    } catch (error) {
      log.error('Failed to list queue', {
        error: error instanceof Error ? error.message : String(error),
        repoId,
      })
      return []
    }
  }

  /**
   * List failed: Return all failed entries with failure reasons.
   */
  async listFailed(repoId: string): Promise<Array<MergeQueueEntry & { failureReason: string }>> {
    if (!isRedisConfigured()) {
      return []
    }

    try {
      const allFailed = await redisHGetAll(failedKey(repoId))
      const entries: Array<MergeQueueEntry & { failureReason: string }> = []

      for (const [, value] of Object.entries(allFailed)) {
        try {
          const data = JSON.parse(value) as { entry: MergeQueueEntry; reason: string }
          if (data.entry) {
            entries.push({ ...data.entry, failureReason: data.reason })
          }
        } catch {
          log.warn('Failed to parse failed entry', { repoId })
        }
      }

      return entries
    } catch (error) {
      log.error('Failed to list failed', {
        error: error instanceof Error ? error.message : String(error),
        repoId,
      })
      return []
    }
  }

  /**
   * List blocked: Return all blocked entries with block reasons.
   */
  async listBlocked(repoId: string): Promise<Array<MergeQueueEntry & { blockReason: string }>> {
    if (!isRedisConfigured()) {
      return []
    }

    try {
      const allBlocked = await redisHGetAll(blockedKey(repoId))
      const entries: Array<MergeQueueEntry & { blockReason: string }> = []

      for (const [, value] of Object.entries(allBlocked)) {
        try {
          const data = JSON.parse(value) as { entry: MergeQueueEntry; reason: string }
          if (data.entry) {
            entries.push({ ...data.entry, blockReason: data.reason })
          }
        } catch {
          log.warn('Failed to parse blocked entry', { repoId })
        }
      }

      return entries
    } catch (error) {
      log.error('Failed to list blocked', {
        error: error instanceof Error ? error.message : String(error),
        repoId,
      })
      return []
    }
  }
}
