/**
 * Three-Tier Scheduling Queue
 *
 * K8s-inspired filter/score scheduling pipeline with three queue tiers:
 * - ActiveQueue: Priority-ordered, ready to dispatch (uses existing work:queue keys)
 * - BackoffQueue: Retry-time-ordered, waiting for retry window
 * - SuspendedWork: Indexed map, manually suspended / unschedulable
 *
 * Redis Key Layout:
 * - work:queue        (Sorted Set) — Active queue (backward-compatible with existing work:queue)
 * - work:items        (Hash)       — Active items (backward-compatible with existing work:items)
 * - work:backoff      (Sorted Set) — Backoff queue, scored by backoffUntil timestamp
 * - work:backoff:items (Hash)      — Backoff items (sessionId -> JSON)
 * - work:suspended    (Hash)       — Suspended items (sessionId -> JSON, indexed map)
 */

import {
  isRedisConfigured,
  getRedisClient,
  redisZAdd,
  redisZRem,
  redisZRangeByScore,
  redisZCard,
  redisHSet,
  redisHGet,
  redisHDel,
  redisHGetAll,
  redisHLen,
} from './redis.js'
import { WORK_QUEUE_KEY, WORK_ITEMS_KEY, calculateScore } from './work-queue.js'
import type { QueuedWork } from './work-queue.js'
import { writeJournalEntry } from './journal.js'

// Re-export QueuedWork so downstream consumers can import from this module
export type { QueuedWork }

const log = {
  info: (msg: string, data?: Record<string, unknown>) =>
    console.log(`[scheduling-queue] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) =>
    console.warn(`[scheduling-queue] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) =>
    console.error(`[scheduling-queue] ${msg}`, data ? JSON.stringify(data) : ''),
  debug: (_msg: string, _data?: Record<string, unknown>) => {},
}

// ---------------------------------------------------------------------------
// Redis key constants
// ---------------------------------------------------------------------------

/** Active queue uses existing work:queue sorted set for backward compatibility */
const ACTIVE_QUEUE_KEY = WORK_QUEUE_KEY
/** Active items uses existing work:items hash for backward compatibility */
const ACTIVE_ITEMS_KEY = WORK_ITEMS_KEY
/** Backoff queue sorted set, scored by backoffUntil timestamp */
const BACKOFF_QUEUE_KEY = 'work:backoff'
/** Backoff items hash (sessionId -> JSON) */
const BACKOFF_ITEMS_KEY = 'work:backoff:items'
/** Suspended items hash (sessionId -> JSON, indexed map) */
const SUSPENDED_KEY = 'work:suspended'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackoffEntry extends QueuedWork {
  /** Unix ms -- next eligible dispatch time */
  backoffUntil: number
  /** Retry count (for exponential backoff) */
  backoffAttempt: number
  /** Why it was moved to backoff */
  backoffReason: string
}

export interface SuspendedEntry extends QueuedWork {
  /** Unix ms when suspended */
  suspendedAt: number
  /** e.g. 'no_feasible_worker', 'quota_exceeded' */
  suspendReason: string
  /** When scheduler last checked feasibility */
  lastEvaluatedAt: number
}

export interface SchedulingQueue {
  activeQueue: ActiveQueue
  backoffQueue: BackoffQueue
  suspendedWork: SuspendedWork
}

export interface ActiveQueue {
  key: string
  itemsKey: string
}

export interface BackoffQueue {
  key: string
  itemsKey: string
}

export interface SuspendedWork {
  key: string
}

export interface QueueStats {
  active: number
  backoff: number
  suspended: number
}

// ---------------------------------------------------------------------------
// Backoff strategy
// ---------------------------------------------------------------------------

/**
 * Calculate exponential backoff duration with jitter.
 *
 * @param attempt - Retry count (0-based)
 * @returns Backoff duration in milliseconds
 */
export function calculateBackoff(attempt: number): number {
  const baseMs = 5_000 // 5 seconds
  const maxMs = 300_000 // 5 minutes cap
  const jitter = Math.random() * 1000
  return Math.min(baseMs * Math.pow(2, attempt), maxMs) + jitter
}

// ---------------------------------------------------------------------------
// Queue operations
// ---------------------------------------------------------------------------

/**
 * Add work to the active queue.
 *
 * Wraps the existing queueWork logic -- stores work item in the hash and
 * adds to the priority sorted set using the same Redis keys as work-queue.ts.
 *
 * @param work - Work item to add to active queue
 * @returns true if added successfully
 */
export async function addToActive(work: QueuedWork): Promise<boolean> {
  if (!isRedisConfigured()) {
    log.warn('Redis not configured, cannot add to active queue')
    return false
  }

  try {
    const score = calculateScore(work.priority, work.queuedAt)
    const serialized = JSON.stringify(work)

    // Store work item in hash (O(1) lookup)
    await redisHSet(ACTIVE_ITEMS_KEY, work.sessionId, serialized)

    // Add to priority queue (O(log n))
    await redisZAdd(ACTIVE_QUEUE_KEY, score, work.sessionId)

    log.info('Work added to active queue', {
      sessionId: work.sessionId,
      issueIdentifier: work.issueIdentifier,
      priority: work.priority,
      score,
    })

    return true
  } catch (error) {
    log.error('Failed to add to active queue', {
      error: error instanceof Error ? error.message : String(error),
      sessionId: work.sessionId,
    })
    return false
  }
}

/**
 * Atomically move a work item from the active queue to the backoff queue.
 *
 * Uses a Redis pipeline to ensure the remove-from-active + add-to-backoff
 * operations are submitted together.
 *
 * @param sessionId - Session ID of the work item
 * @param reason - Why the item is being moved to backoff
 * @param backoffMs - Optional explicit backoff duration. If omitted, calculated from attempt count.
 * @returns true if moved successfully, false if item not found or error
 */
export async function moveToBackoff(
  sessionId: string,
  reason: string,
  backoffMs?: number
): Promise<boolean> {
  if (!isRedisConfigured()) {
    log.warn('Redis not configured, cannot move to backoff')
    return false
  }

  try {
    // First, get the work item from the active queue
    const itemJson = await redisHGet(ACTIVE_ITEMS_KEY, sessionId)

    if (!itemJson) {
      log.warn('Work item not found in active queue for backoff', { sessionId })
      return false
    }

    const work = JSON.parse(itemJson) as QueuedWork

    // Check if this item was previously in backoff (to increment attempt counter)
    const existingBackoffJson = await redisHGet(BACKOFF_ITEMS_KEY, sessionId)
    let attempt = 0
    if (existingBackoffJson) {
      try {
        const existing = JSON.parse(existingBackoffJson) as BackoffEntry
        attempt = existing.backoffAttempt + 1
      } catch {
        // If parse fails, start fresh
      }
    }

    const effectiveBackoffMs = backoffMs ?? calculateBackoff(attempt)
    const backoffUntil = Date.now() + effectiveBackoffMs

    const backoffEntry: BackoffEntry = {
      ...work,
      backoffUntil,
      backoffAttempt: attempt,
      backoffReason: reason,
    }

    const serialized = JSON.stringify(backoffEntry)

    // Use pipeline for atomicity: remove from active, add to backoff
    const redis = getRedisClient()
    const pipeline = redis.pipeline()
    pipeline.zrem(ACTIVE_QUEUE_KEY, sessionId)
    pipeline.hdel(ACTIVE_ITEMS_KEY, sessionId)
    pipeline.zadd(BACKOFF_QUEUE_KEY, backoffUntil, sessionId)
    pipeline.hset(BACKOFF_ITEMS_KEY, sessionId, serialized)
    await pipeline.exec()

    log.info('Work moved to backoff queue', {
      sessionId,
      reason,
      backoffUntil,
      attempt,
      backoffMs: effectiveBackoffMs,
    })

    return true
  } catch (error) {
    log.error('Failed to move to backoff', {
      error: error instanceof Error ? error.message : String(error),
      sessionId,
    })
    return false
  }
}

/**
 * Atomically move a work item from active or backoff to the suspended map.
 *
 * Checks active queue first, then backoff queue for the item.
 *
 * @param sessionId - Session ID of the work item
 * @param reason - Why the item is being suspended (e.g. 'no_feasible_worker', 'quota_exceeded')
 * @returns true if moved successfully, false if item not found or error
 */
export async function moveToSuspended(
  sessionId: string,
  reason: string
): Promise<boolean> {
  if (!isRedisConfigured()) {
    log.warn('Redis not configured, cannot move to suspended')
    return false
  }

  try {
    // Try to find the item in active queue first
    let itemJson = await redisHGet(ACTIVE_ITEMS_KEY, sessionId)
    let sourceQueue: 'active' | 'backoff' | null = null

    if (itemJson) {
      sourceQueue = 'active'
    } else {
      // Try backoff queue
      itemJson = await redisHGet(BACKOFF_ITEMS_KEY, sessionId)
      if (itemJson) {
        sourceQueue = 'backoff'
      }
    }

    if (!itemJson || !sourceQueue) {
      log.warn('Work item not found in active or backoff for suspension', { sessionId })
      return false
    }

    const work = JSON.parse(itemJson) as QueuedWork

    const now = Date.now()
    const suspendedEntry: SuspendedEntry = {
      ...work,
      // Strip backoff-specific fields if coming from backoff
      ...('backoffUntil' in work ? {} : {}),
      suspendedAt: now,
      suspendReason: reason,
      lastEvaluatedAt: now,
    }

    // Clean up backoff-specific fields that may be on the parsed object
    delete (suspendedEntry as unknown as Record<string, unknown>)['backoffUntil']
    delete (suspendedEntry as unknown as Record<string, unknown>)['backoffAttempt']
    delete (suspendedEntry as unknown as Record<string, unknown>)['backoffReason']

    const serialized = JSON.stringify(suspendedEntry)

    // Use pipeline for atomicity
    const redis = getRedisClient()
    const pipeline = redis.pipeline()

    if (sourceQueue === 'active') {
      pipeline.zrem(ACTIVE_QUEUE_KEY, sessionId)
      pipeline.hdel(ACTIVE_ITEMS_KEY, sessionId)
    } else {
      pipeline.zrem(BACKOFF_QUEUE_KEY, sessionId)
      pipeline.hdel(BACKOFF_ITEMS_KEY, sessionId)
    }

    pipeline.hset(SUSPENDED_KEY, sessionId, serialized)
    await pipeline.exec()

    log.info('Work moved to suspended', {
      sessionId,
      reason,
      sourceQueue,
    })

    return true
  } catch (error) {
    log.error('Failed to move to suspended', {
      error: error instanceof Error ? error.message : String(error),
      sessionId,
    })
    return false
  }
}

/**
 * Atomically remove a work item from the active queue and write its journal
 * completion entry. Per ADR-2026-04-29 §Implementation notes:
 *
 * > `scheduling-queue.moveToBackoff` extension in agentfactory-server: add
 * > `journal_id` field on the queue entry; `moveToCompleted(journal_id, result)`
 * > writes to journal hash before unblocking next step.
 *
 * The Redis-side dequeue (ZREM/HDEL on the active queue) is pipelined together
 * for atomicity; the journal write happens BEFORE the dequeue so a
 * subsequent step that depends on the completion record sees a consistent
 * view (journal-first, then unblock).
 *
 * @param sessionId - Session id (used as the active-queue work key).
 * @param stepId - Workflow step id whose completion we are journaling.
 * @param result - Completion descriptor: input hash + CAS pointer + timing
 *                 metadata for the journal entry.
 * @returns true if the journal entry was written and the work item dequeued
 *          (or was already absent); false on Redis errors.
 */
export async function moveToCompleted(
  sessionId: string,
  stepId: string,
  result: {
    inputHash: string
    outputCAS: string
    startedAt: number
    completedAt?: number
    attempt?: number
  }
): Promise<boolean> {
  if (!isRedisConfigured()) {
    log.warn('Redis not configured, cannot move to completed')
    return false
  }

  try {
    // 1. Journal first — record the terminal state before unblocking the
    //    next step so dependants observe a consistent view.
    const journalOk = await writeJournalEntry({
      sessionId,
      stepId,
      status: 'completed',
      inputHash: result.inputHash,
      outputCAS: result.outputCAS,
      startedAt: result.startedAt,
      completedAt: result.completedAt ?? Date.now(),
      attempt: result.attempt ?? 0,
    })

    if (!journalOk) {
      log.error('Failed to write journal completion before dequeue', {
        sessionId,
        stepId,
      })
      return false
    }

    // 2. Pipeline the dequeue. Idempotent — ZREM/HDEL on a missing key are no-ops.
    const redis = getRedisClient()
    const pipeline = redis.pipeline()
    pipeline.zrem(ACTIVE_QUEUE_KEY, sessionId)
    pipeline.hdel(ACTIVE_ITEMS_KEY, sessionId)
    await pipeline.exec()

    log.info('Work moved to completed (journal written, dequeued)', {
      sessionId,
      stepId,
    })

    return true
  } catch (error) {
    log.error('Failed to move to completed', {
      error: error instanceof Error ? error.message : String(error),
      sessionId,
      stepId,
    })
    return false
  }
}

/**
 * Scan the backoff queue and promote eligible items to the active queue.
 *
 * Items whose backoffUntil timestamp has passed are moved back to active.
 *
 * @returns Number of items promoted
 */
export async function promoteFromBackoff(): Promise<number> {
  if (!isRedisConfigured()) {
    return 0
  }

  try {
    const now = Date.now()

    // Get all backoff items with score (backoffUntil) <= now
    const eligibleSessionIds = await redisZRangeByScore(
      BACKOFF_QUEUE_KEY,
      '-inf',
      now
    )

    if (eligibleSessionIds.length === 0) {
      return 0
    }

    let promoted = 0

    for (const sessionId of eligibleSessionIds) {
      try {
        const itemJson = await redisHGet(BACKOFF_ITEMS_KEY, sessionId)

        if (!itemJson) {
          // Orphaned sorted set member -- remove it
          await redisZRem(BACKOFF_QUEUE_KEY, sessionId)
          continue
        }

        const backoffEntry = JSON.parse(itemJson) as BackoffEntry

        // Reconstruct clean QueuedWork (strip backoff fields)
        const work: QueuedWork = {
          sessionId: backoffEntry.sessionId,
          issueId: backoffEntry.issueId,
          issueIdentifier: backoffEntry.issueIdentifier,
          priority: backoffEntry.priority,
          queuedAt: backoffEntry.queuedAt,
          ...(backoffEntry.prompt !== undefined && { prompt: backoffEntry.prompt }),
          ...(backoffEntry.providerSessionId !== undefined && {
            providerSessionId: backoffEntry.providerSessionId,
          }),
          ...(backoffEntry.workType !== undefined && { workType: backoffEntry.workType }),
          ...(backoffEntry.sourceSessionId !== undefined && {
            sourceSessionId: backoffEntry.sourceSessionId,
          }),
          ...(backoffEntry.projectName !== undefined && {
            projectName: backoffEntry.projectName,
          }),
        }

        const score = calculateScore(work.priority, work.queuedAt)
        const serialized = JSON.stringify(work)

        // Pipeline: remove from backoff, add to active
        const redis = getRedisClient()
        const pipeline = redis.pipeline()
        pipeline.zrem(BACKOFF_QUEUE_KEY, sessionId)
        pipeline.hdel(BACKOFF_ITEMS_KEY, sessionId)
        pipeline.zadd(ACTIVE_QUEUE_KEY, score, sessionId)
        pipeline.hset(ACTIVE_ITEMS_KEY, sessionId, serialized)
        await pipeline.exec()

        promoted++
      } catch (itemError) {
        log.warn('Failed to promote individual backoff item', {
          sessionId,
          error: itemError instanceof Error ? itemError.message : String(itemError),
        })
      }
    }

    if (promoted > 0) {
      log.info('Promoted items from backoff to active', { promoted })
    }

    return promoted
  } catch (error) {
    log.error('Failed to promote from backoff', {
      error: error instanceof Error ? error.message : String(error),
    })
    return 0
  }
}

/**
 * Update lastEvaluatedAt on all suspended items.
 *
 * Returns the list of suspended entries so the caller can re-evaluate
 * feasibility and decide whether to move items back to active.
 *
 * @returns Array of suspended entries with updated lastEvaluatedAt
 */
export async function reevaluateSuspended(): Promise<SuspendedEntry[]> {
  if (!isRedisConfigured()) {
    return []
  }

  try {
    const allItems = await redisHGetAll(SUSPENDED_KEY)
    const entries: SuspendedEntry[] = []
    const now = Date.now()

    for (const [sessionId, json] of Object.entries(allItems)) {
      try {
        const entry = JSON.parse(json) as SuspendedEntry
        entry.lastEvaluatedAt = now

        // Update the entry in Redis with new lastEvaluatedAt
        await redisHSet(SUSPENDED_KEY, sessionId, JSON.stringify(entry))

        entries.push(entry)
      } catch {
        log.warn('Failed to parse suspended entry', { sessionId })
      }
    }

    if (entries.length > 0) {
      log.info('Re-evaluated suspended items', { count: entries.length })
    }

    return entries
  } catch (error) {
    log.error('Failed to re-evaluate suspended items', {
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}

/**
 * Get counts for all three queue tiers.
 *
 * @returns Object with active, backoff, and suspended counts
 */
export async function getQueueStats(): Promise<QueueStats> {
  if (!isRedisConfigured()) {
    return { active: 0, backoff: 0, suspended: 0 }
  }

  try {
    const [active, backoff, suspended] = await Promise.all([
      redisZCard(ACTIVE_QUEUE_KEY),
      redisZCard(BACKOFF_QUEUE_KEY),
      redisHLen(SUSPENDED_KEY),
    ])

    return { active, backoff, suspended }
  } catch (error) {
    log.error('Failed to get queue stats', {
      error: error instanceof Error ? error.message : String(error),
    })
    return { active: 0, backoff: 0, suspended: 0 }
  }
}
