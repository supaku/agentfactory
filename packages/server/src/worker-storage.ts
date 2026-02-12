/**
 * Worker Storage Module
 *
 * Manages worker registration and tracking in Redis.
 * Workers register on startup, send periodic heartbeats,
 * and deregister on shutdown.
 */

import crypto from 'crypto'
import {
  redisSet,
  redisGet,
  redisDel,
  redisKeys,
  redisSAdd,
  redisSRem,
  redisSMembers,
  redisExpire,
  isRedisConfigured,
} from './redis.js'

const log = {
  info: (msg: string, data?: Record<string, unknown>) => console.log(`[worker] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) => console.warn(`[worker] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) => console.error(`[worker] ${msg}`, data ? JSON.stringify(data) : ''),
  debug: (_msg: string, _data?: Record<string, unknown>) => {},
}

// Redis key constants
const WORKER_PREFIX = 'work:worker:'
const WORKER_SESSIONS_SUFFIX = ':sessions'

// Default TTL for worker registration (120 seconds)
// Worker must send heartbeat within this time or be considered offline
const WORKER_TTL = parseInt(process.env.WORKER_TTL ?? '120', 10)

// Heartbeat timeout (90 seconds = 3 missed 30-second heartbeats)
const HEARTBEAT_TIMEOUT = parseInt(
  process.env.WORKER_HEARTBEAT_TIMEOUT ?? '90000',
  10
)

// Configurable intervals (in milliseconds)
const HEARTBEAT_INTERVAL = parseInt(
  process.env.WORKER_HEARTBEAT_INTERVAL ?? '30000',
  10
)
const POLL_INTERVAL = parseInt(process.env.WORKER_POLL_INTERVAL ?? '5000', 10)

/**
 * Worker registration data stored in Redis
 */
export interface WorkerData {
  id: string
  hostname: string
  capacity: number
  activeCount: number
  registeredAt: number // Unix timestamp
  lastHeartbeat: number // Unix timestamp
  status: 'active' | 'draining' | 'offline'
  version?: string
  projects?: string[] // Project names this worker accepts (undefined = all)
}

/**
 * Worker info returned to API consumers
 */
export interface WorkerInfo extends WorkerData {
  activeSessions: string[]
}

/**
 * Register a new worker
 *
 * @param hostname - Worker's hostname
 * @param capacity - Maximum concurrent agents the worker can handle
 * @param version - Optional worker software version
 * @returns Worker ID and configuration
 */
export async function registerWorker(
  hostname: string,
  capacity: number,
  version?: string,
  projects?: string[],
): Promise<{ workerId: string; heartbeatInterval: number; pollInterval: number } | null> {
  if (!isRedisConfigured()) {
    log.warn('Redis not configured, cannot register worker')
    return null
  }

  try {
    const workerId = `wkr_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
    const now = Date.now()

    const workerData: WorkerData = {
      id: workerId,
      hostname,
      capacity,
      activeCount: 0,
      registeredAt: now,
      lastHeartbeat: now,
      status: 'active',
      version,
      projects: projects?.length ? projects : undefined,
    }

    const key = `${WORKER_PREFIX}${workerId}`
    await redisSet(key, workerData, WORKER_TTL)

    log.info('Worker registered', {
      workerId,
      hostname,
      capacity,
      projects: projects?.length ? projects : 'all',
    })

    return {
      workerId,
      heartbeatInterval: HEARTBEAT_INTERVAL,
      pollInterval: POLL_INTERVAL,
    }
  } catch (error) {
    log.error('Failed to register worker', { error, hostname })
    return null
  }
}

/**
 * Update worker heartbeat
 *
 * @param workerId - Worker ID
 * @param activeCount - Current number of active agents
 * @param load - Optional system load metrics
 * @returns Heartbeat acknowledgment or null on failure
 */
export async function updateHeartbeat(
  workerId: string,
  activeCount: number,
  load?: { cpu: number; memory: number }
): Promise<{ acknowledged: boolean; serverTime: string; pendingWorkCount: number } | null> {
  if (!isRedisConfigured()) {
    return null
  }

  try {
    const key = `${WORKER_PREFIX}${workerId}`
    const worker = await redisGet<WorkerData>(key)

    if (!worker) {
      log.warn('Heartbeat for unknown worker', { workerId })
      return null
    }

    // Update worker data
    const updatedWorker: WorkerData = {
      ...worker,
      activeCount,
      lastHeartbeat: Date.now(),
      status: 'active',
    }

    // Reset TTL on heartbeat
    await redisSet(key, updatedWorker, WORKER_TTL)

    // Get pending work count (import dynamically to avoid circular dep)
    const { getQueueLength } = await import('./work-queue')
    const pendingWorkCount = await getQueueLength()

    return {
      acknowledged: true,
      serverTime: new Date().toISOString(),
      pendingWorkCount,
    }
  } catch (error) {
    log.error('Failed to update heartbeat', { error, workerId })
    return null
  }
}

/**
 * Get worker by ID
 */
export async function getWorker(workerId: string): Promise<WorkerInfo | null> {
  if (!isRedisConfigured()) {
    return null
  }

  try {
    const key = `${WORKER_PREFIX}${workerId}`
    const worker = await redisGet<WorkerData>(key)

    if (!worker) {
      return null
    }

    // Get active sessions for this worker
    const sessionsKey = `${key}${WORKER_SESSIONS_SUFFIX}`
    const activeSessions = await redisSMembers(sessionsKey)

    return {
      ...worker,
      activeSessions,
    }
  } catch (error) {
    log.error('Failed to get worker', { error, workerId })
    return null
  }
}

/**
 * Deregister a worker
 *
 * @param workerId - Worker ID to deregister
 * @returns List of session IDs that need to be re-queued
 */
export async function deregisterWorker(
  workerId: string
): Promise<{ deregistered: boolean; unclaimedSessions: string[] }> {
  if (!isRedisConfigured()) {
    return { deregistered: false, unclaimedSessions: [] }
  }

  try {
    const key = `${WORKER_PREFIX}${workerId}`
    const sessionsKey = `${key}${WORKER_SESSIONS_SUFFIX}`

    // Get sessions that need to be re-queued
    const unclaimedSessions = await redisSMembers(sessionsKey)

    // Delete worker registration and sessions set
    await redisDel(key)
    await redisDel(sessionsKey)

    log.info('Worker deregistered', {
      workerId,
      unclaimedSessions: unclaimedSessions.length,
    })

    return {
      deregistered: true,
      unclaimedSessions,
    }
  } catch (error) {
    log.error('Failed to deregister worker', { error, workerId })
    return { deregistered: false, unclaimedSessions: [] }
  }
}

/**
 * List all registered workers
 */
export async function listWorkers(): Promise<WorkerInfo[]> {
  if (!isRedisConfigured()) {
    return []
  }

  try {
    const keys = await redisKeys(`${WORKER_PREFIX}*`)

    // Filter out session keys
    const workerKeys = keys.filter((k) => !k.endsWith(WORKER_SESSIONS_SUFFIX))

    const workers: WorkerInfo[] = []

    for (const key of workerKeys) {
      const worker = await redisGet<WorkerData>(key)
      if (worker) {
        const sessionsKey = `${key}${WORKER_SESSIONS_SUFFIX}`
        const activeSessions = await redisSMembers(sessionsKey)

        // Check if worker is stale
        const isStale = Date.now() - worker.lastHeartbeat > HEARTBEAT_TIMEOUT
        const status = isStale ? 'offline' : worker.status

        workers.push({
          ...worker,
          status,
          activeSessions,
        })
      }
    }

    return workers
  } catch (error) {
    log.error('Failed to list workers', { error })
    return []
  }
}

/**
 * Get workers that have missed heartbeats (stale workers)
 */
export async function getStaleWorkers(): Promise<WorkerInfo[]> {
  if (!isRedisConfigured()) {
    return []
  }

  try {
    const workers = await listWorkers()
    return workers.filter((w) => w.status === 'offline')
  } catch (error) {
    log.error('Failed to get stale workers', { error })
    return []
  }
}

/**
 * Add a session to a worker's active sessions
 *
 * @param workerId - Worker ID
 * @param sessionId - Session ID being processed
 */
export async function addWorkerSession(
  workerId: string,
  sessionId: string
): Promise<boolean> {
  if (!isRedisConfigured()) {
    return false
  }

  try {
    const sessionsKey = `${WORKER_PREFIX}${workerId}${WORKER_SESSIONS_SUFFIX}`
    await redisSAdd(sessionsKey, sessionId)
    return true
  } catch (error) {
    log.error('Failed to add worker session', { error, workerId, sessionId })
    return false
  }
}

/**
 * Remove a session from a worker's active sessions
 *
 * @param workerId - Worker ID
 * @param sessionId - Session ID to remove
 */
export async function removeWorkerSession(
  workerId: string,
  sessionId: string
): Promise<boolean> {
  if (!isRedisConfigured()) {
    return false
  }

  try {
    const sessionsKey = `${WORKER_PREFIX}${workerId}${WORKER_SESSIONS_SUFFIX}`
    await redisSRem(sessionsKey, sessionId)
    return true
  } catch (error) {
    log.error('Failed to remove worker session', { error, workerId, sessionId })
    return false
  }
}

/**
 * Get total capacity across all active workers.
 *
 * Accepts an optional pre-fetched workers list to avoid redundant Redis scans
 * (callers like the stats handler already call listWorkers()).
 *
 * Uses activeSessions.length (authoritative Redis set) instead of the
 * heartbeat-reported activeCount, which can be stale after re-registration
 * or between heartbeat intervals.
 */
export async function getTotalCapacity(prefetchedWorkers?: WorkerInfo[]): Promise<{
  totalCapacity: number
  totalActive: number
  availableCapacity: number
}> {
  if (!isRedisConfigured()) {
    return { totalCapacity: 0, totalActive: 0, availableCapacity: 0 }
  }

  try {
    const workers = prefetchedWorkers ?? await listWorkers()
    const activeWorkers = workers.filter((w) => w.status === 'active')

    const totalCapacity = activeWorkers.reduce((sum, w) => sum + w.capacity, 0)
    const totalActive = activeWorkers.reduce((sum, w) => sum + w.activeSessions.length, 0)

    return {
      totalCapacity,
      totalActive,
      availableCapacity: totalCapacity - totalActive,
    }
  } catch (error) {
    log.error('Failed to get total capacity', { error })
    return { totalCapacity: 0, totalActive: 0, availableCapacity: 0 }
  }
}
