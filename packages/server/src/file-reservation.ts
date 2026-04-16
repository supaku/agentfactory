/**
 * File Reservation Module
 *
 * Provides per-file coordination across parallel agent sessions to prevent
 * merge conflicts when multiple agents work in separate git worktrees.
 *
 * - Per-file mutex (Redis SET NX) that gates file modification
 * - Per-session file index (Redis Set) for efficient bulk operations
 * - TTL-based expiration with refresh for crash recovery
 *
 * Redis Keys:
 * - file:reservation:{repoId}:{normalizedPath}  -- String (JSON FileReservation), 1hr TTL
 * - file:session:{repoId}:{sessionId}           -- Set of reserved file paths, 1hr TTL
 */

import {
  redisSetNX,
  redisGet,
  redisDel,
  redisExpire,
  redisSAdd,
  redisSRem,
  redisSMembers,
  isRedisConfigured,
} from './redis.js'

const log = {
  info: (msg: string, data?: Record<string, unknown>) => console.log(`[file-reservation] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) => console.warn(`[file-reservation] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) => console.error(`[file-reservation] ${msg}`, data ? JSON.stringify(data) : ''),
  debug: (_msg: string, _data?: Record<string, unknown>) => {},
}

// Redis key prefixes
const RESERVATION_PREFIX = 'file:reservation:'
const SESSION_FILES_PREFIX = 'file:session:'

// Default reservation TTL: 1 hour
const RESERVATION_TTL_SECONDS = 60 * 60

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Reservation payload stored in Redis
 */
export interface FileReservation {
  sessionId: string
  repoId: string
  filePath: string
  reservedAt: number
  reason?: string
}

/**
 * A file that conflicts with a requested reservation
 */
export interface FileConflict {
  filePath: string
  heldBy: FileReservation
}

/**
 * Result of a reserveFiles call
 */
export interface ReserveFilesResult {
  reserved: string[]
  conflicts: FileConflict[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a file path for consistent Redis key generation.
 * Converts backslashes to forward slashes and strips leading ./
 */
function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '')
}

function reservationKey(repoId: string, filePath: string): string {
  return `${RESERVATION_PREFIX}${repoId}:${normalizePath(filePath)}`
}

function sessionKey(repoId: string, sessionId: string): string {
  return `${SESSION_FILES_PREFIX}${repoId}:${sessionId}`
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reserve files for a session.
 * Uses SET NX per file for atomic acquisition. Files already reserved
 * by the same session are treated as successful (idempotent).
 *
 * @returns Reserved files and any conflicts with other sessions
 */
export async function reserveFiles(
  repoId: string,
  sessionId: string,
  filePaths: string[],
  reason?: string,
): Promise<ReserveFilesResult> {
  if (!isRedisConfigured()) {
    // No Redis = no reservation, report all as reserved (pass through)
    return { reserved: filePaths, conflicts: [] }
  }

  const reserved: string[] = []
  const conflicts: FileConflict[] = []

  try {
    for (const filePath of filePaths) {
      const normalized = normalizePath(filePath)
      const key = reservationKey(repoId, normalized)

      const reservation: FileReservation = {
        sessionId,
        repoId,
        filePath: normalized,
        reservedAt: Date.now(),
        reason,
      }

      const acquired = await redisSetNX(key, JSON.stringify(reservation), RESERVATION_TTL_SECONDS)

      if (acquired) {
        reserved.push(normalized)
        // Add to session's file set
        const sessKey = sessionKey(repoId, sessionId)
        await redisSAdd(sessKey, normalized)
        await redisExpire(sessKey, RESERVATION_TTL_SECONDS)
      } else {
        // Check if we already own it (idempotent re-reservation)
        const existing = await redisGet<FileReservation>(key)
        if (existing && existing.sessionId === sessionId) {
          reserved.push(normalized)
        } else if (existing) {
          conflicts.push({ filePath: normalized, heldBy: existing })
        } else {
          // Key expired between SET NX and GET — retry
          const retryAcquired = await redisSetNX(key, JSON.stringify(reservation), RESERVATION_TTL_SECONDS)
          if (retryAcquired) {
            reserved.push(normalized)
            const sessKey = sessionKey(repoId, sessionId)
            await redisSAdd(sessKey, normalized)
            await redisExpire(sessKey, RESERVATION_TTL_SECONDS)
          }
        }
      }
    }

    if (reserved.length > 0) {
      log.info('Files reserved', {
        repoId,
        sessionId,
        reservedCount: reserved.length,
        conflictCount: conflicts.length,
      })
    }

    if (conflicts.length > 0) {
      log.info('File reservation conflicts', {
        repoId,
        sessionId,
        conflicts: conflicts.map(c => ({
          filePath: c.filePath,
          heldBy: c.heldBy.sessionId,
        })),
      })
    }

    return { reserved, conflicts }
  } catch (error) {
    log.error('Failed to reserve files', { error, repoId, sessionId })
    return { reserved, conflicts }
  }
}

/**
 * Check if files are reserved by other sessions (read-only).
 * Does not acquire anything — purely informational.
 * Files reserved by the requesting session are NOT reported as conflicts.
 */
export async function checkFileConflicts(
  repoId: string,
  sessionId: string,
  filePaths: string[],
): Promise<FileConflict[]> {
  if (!isRedisConfigured()) return []

  const conflicts: FileConflict[] = []

  try {
    for (const filePath of filePaths) {
      const normalized = normalizePath(filePath)
      const key = reservationKey(repoId, normalized)
      const reservation = await redisGet<FileReservation>(key)

      if (reservation && reservation.sessionId !== sessionId) {
        conflicts.push({ filePath: normalized, heldBy: reservation })
      }
    }

    return conflicts
  } catch (error) {
    log.error('Failed to check file conflicts', { error, repoId, sessionId })
    return []
  }
}

/**
 * Release specific file reservations owned by a session.
 * Only releases files owned by the given session — skips files owned by others.
 *
 * @returns Number of files released
 */
export async function releaseFiles(
  repoId: string,
  sessionId: string,
  filePaths: string[],
): Promise<number> {
  if (!isRedisConfigured()) return 0

  let released = 0

  try {
    const sessKey = sessionKey(repoId, sessionId)

    for (const filePath of filePaths) {
      const normalized = normalizePath(filePath)
      const key = reservationKey(repoId, normalized)

      // Verify ownership before releasing
      const reservation = await redisGet<FileReservation>(key)
      if (reservation && reservation.sessionId === sessionId) {
        await redisDel(key)
        await redisSRem(sessKey, normalized)
        released++
      }
    }

    if (released > 0) {
      log.info('Files released', { repoId, sessionId, releasedCount: released })
    }

    return released
  } catch (error) {
    log.error('Failed to release files', { error, repoId, sessionId })
    return released
  }
}

/**
 * Release all file reservations for a session.
 * Reads the session's file set, releases each file, then deletes the set.
 *
 * @returns Number of files released
 */
export async function releaseAllSessionFiles(
  repoId: string,
  sessionId: string,
): Promise<number> {
  if (!isRedisConfigured()) return 0

  try {
    const sessKey = sessionKey(repoId, sessionId)
    const files = await redisSMembers(sessKey)

    if (files.length === 0) return 0

    let released = 0
    for (const filePath of files) {
      const key = reservationKey(repoId, filePath)
      // Verify ownership before releasing
      const reservation = await redisGet<FileReservation>(key)
      if (reservation && reservation.sessionId === sessionId) {
        await redisDel(key)
        released++
      }
    }

    // Delete the session set
    await redisDel(sessKey)

    log.info('All session files released', { repoId, sessionId, releasedCount: released })

    return released
  } catch (error) {
    log.error('Failed to release all session files', { error, repoId, sessionId })
    return 0
  }
}

/**
 * Refresh TTL on all file reservations for a session.
 * Extends both individual file reservation keys and the session's file set.
 */
export async function refreshFileReservationsTTL(
  repoId: string,
  sessionId: string,
  ttlSeconds: number = RESERVATION_TTL_SECONDS,
): Promise<boolean> {
  if (!isRedisConfigured()) return false

  try {
    const sessKey = sessionKey(repoId, sessionId)
    const files = await redisSMembers(sessKey)

    if (files.length === 0) return false

    // Refresh TTL on each reservation key
    for (const filePath of files) {
      const key = reservationKey(repoId, filePath)
      await redisExpire(key, ttlSeconds)
    }

    // Refresh TTL on the session set itself
    await redisExpire(sessKey, ttlSeconds)

    log.debug('Refreshed file reservation TTLs', {
      repoId,
      sessionId,
      fileCount: files.length,
    })

    return true
  } catch (error) {
    log.error('Failed to refresh file reservation TTLs', { error, repoId, sessionId })
    return false
  }
}

/**
 * Get the list of files reserved by a session.
 */
export async function getSessionFiles(
  repoId: string,
  sessionId: string,
): Promise<string[]> {
  if (!isRedisConfigured()) return []

  try {
    const sessKey = sessionKey(repoId, sessionId)
    return await redisSMembers(sessKey)
  } catch (error) {
    log.error('Failed to get session files', { error, repoId, sessionId })
    return []
  }
}

/**
 * Read the reservation for a single file.
 */
export async function getFileReservation(
  repoId: string,
  filePath: string,
): Promise<FileReservation | null> {
  if (!isRedisConfigured()) return null

  try {
    const key = reservationKey(repoId, normalizePath(filePath))
    return await redisGet<FileReservation>(key)
  } catch (error) {
    log.error('Failed to get file reservation', { error, repoId, filePath })
    return null
  }
}
