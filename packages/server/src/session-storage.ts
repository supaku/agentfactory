import { isRedisConfigured, redisSet, redisGet, redisDel, redisKeys } from './redis.js'
import type { AgentWorkType } from './types.js'

const log = {
  info: (msg: string, data?: Record<string, unknown>) => console.log(`[session] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) => console.warn(`[session] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) => console.error(`[session] ${msg}`, data ? JSON.stringify(data) : ''),
  debug: (_msg: string, _data?: Record<string, unknown>) => {},
}

/**
 * Agent session status
 * - pending: Queued, waiting for a worker to claim
 * - claimed: Worker has claimed but not yet started
 * - running: Agent is actively processing
 * - finalizing: Agent work done, cleanup in progress (worktree removal, orchestrator teardown)
 * - completed: Agent finished successfully (all cleanup done)
 * - failed: Agent encountered an error
 * - stopped: Agent was stopped by user
 */
export type AgentSessionStatus =
  | 'pending'
  | 'claimed'
  | 'running'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'stopped'

/**
 * Agent session state stored in Redis for distributed access
 */
export interface AgentSessionState {
  /** Linear session ID (from webhook) */
  linearSessionId: string
  /** Linear issue ID */
  issueId: string
  /** Issue identifier (e.g., SUP-123) */
  issueIdentifier?: string
  /** Provider CLI session ID for resuming with --resume */
  providerSessionId: string | null
  /** Git worktree path */
  worktreePath: string
  /** Current agent status */
  status: AgentSessionStatus
  /** Unix timestamp when session was created */
  createdAt: number
  /** Unix timestamp of last update */
  updatedAt: number

  // Worker pool fields
  /** Worker ID handling this session (null if pending) */
  workerId?: string | null
  /** Unix timestamp when added to work queue */
  queuedAt?: number | null
  /** Unix timestamp when claimed by worker */
  claimedAt?: number | null
  /** Priority in queue (1-5, lower is higher priority) */
  priority?: number
  /** Prompt context for the session */
  promptContext?: string

  // OAuth context for Linear Agent API
  /** Linear organization ID for OAuth token lookup */
  organizationId?: string

  // Work type for status-based routing
  /** Type of work: research, development, inflight, qa, acceptance, refinement (defaults to 'development') */
  workType?: AgentWorkType

  // Agent identification (from Linear webhook)
  /** Linear Agent ID handling this session */
  agentId?: string

  /** Linear project name (for routing and dashboard visibility) */
  projectName?: string

  /** Agent provider name (claude, codex, amp) — set by worker on claim */
  provider?: string

  // Cost tracking (populated from provider result events)
  /** Total cost in USD for this session */
  totalCostUsd?: number
  /** Total input tokens consumed */
  inputTokens?: number
  /** Total output tokens consumed */
  outputTokens?: number
}

/**
 * Key prefix for session state in KV
 */
const SESSION_KEY_PREFIX = 'agent:session:'

/**
 * Session state TTL in seconds (24 hours)
 * Sessions older than this are automatically cleaned up by KV
 */
const SESSION_TTL_SECONDS = 24 * 60 * 60

/**
 * Build the KV key for a session
 */
function buildSessionKey(linearSessionId: string): string {
  return `${SESSION_KEY_PREFIX}${linearSessionId}`
}

/**
 * Store agent session state in Redis
 *
 * @param linearSessionId - The Linear session ID from webhook
 * @param state - The session state to store
 */
export async function storeSessionState(
  linearSessionId: string,
  state: Omit<AgentSessionState, 'linearSessionId' | 'createdAt' | 'updatedAt'>
): Promise<AgentSessionState> {
  if (!isRedisConfigured()) {
    log.warn('Redis not configured, session state will not be persisted')
    const now = Math.floor(Date.now() / 1000)
    return {
      ...state,
      linearSessionId,
      createdAt: now,
      updatedAt: now,
    }
  }

  const now = Math.floor(Date.now() / 1000)
  const key = buildSessionKey(linearSessionId)

  // Check for existing session to preserve createdAt
  const existing = await redisGet<AgentSessionState>(key)

  const sessionState: AgentSessionState = {
    ...state,
    linearSessionId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }

  await redisSet(key, sessionState, SESSION_TTL_SECONDS)

  log.info('Stored session state', {
    linearSessionId,
    issueId: state.issueId,
    status: state.status,
    hasProviderSessionId: !!state.providerSessionId,
  })

  return sessionState
}

/**
 * Retrieve agent session state from Redis
 *
 * @param linearSessionId - The Linear session ID
 * @returns The session state or null if not found
 */
export async function getSessionState(
  linearSessionId: string
): Promise<AgentSessionState | null> {
  if (!isRedisConfigured()) {
    log.debug('Redis not configured, cannot retrieve session state')
    return null
  }

  const key = buildSessionKey(linearSessionId)
  const state = await redisGet<AgentSessionState>(key)

  if (state) {
    log.debug('Retrieved session state', {
      linearSessionId,
      issueId: state.issueId,
      status: state.status,
    })
  }

  return state
}

/**
 * Update the provider session ID for a session
 * Called when the Claude init event is received with the session ID
 *
 * @param linearSessionId - The Linear session ID
 * @param providerSessionId - The Provider CLI session ID
 */
export async function updateProviderSessionId(
  linearSessionId: string,
  providerSessionId: string
): Promise<boolean> {
  if (!isRedisConfigured()) {
    log.warn('Redis not configured, cannot update provider session ID')
    return false
  }

  const existing = await getSessionState(linearSessionId)
  if (!existing) {
    log.warn('Session not found for provider session ID update', { linearSessionId })
    return false
  }

  const key = buildSessionKey(linearSessionId)
  const now = Math.floor(Date.now() / 1000)

  const updated: AgentSessionState = {
    ...existing,
    providerSessionId,
    updatedAt: now,
  }

  await redisSet(key, updated, SESSION_TTL_SECONDS)

  log.info('Updated provider session ID', { linearSessionId, providerSessionId })

  return true
}

/**
 * Update session status
 *
 * @param linearSessionId - The Linear session ID
 * @param status - The new status
 */
export async function updateSessionStatus(
  linearSessionId: string,
  status: AgentSessionState['status']
): Promise<boolean> {
  if (!isRedisConfigured()) {
    log.warn('Redis not configured, cannot update session status')
    return false
  }

  const existing = await getSessionState(linearSessionId)
  if (!existing) {
    log.warn('Session not found for status update', { linearSessionId })
    return false
  }

  const key = buildSessionKey(linearSessionId)
  const now = Math.floor(Date.now() / 1000)

  const updated: AgentSessionState = {
    ...existing,
    status,
    updatedAt: now,
  }

  await redisSet(key, updated, SESSION_TTL_SECONDS)

  log.info('Updated session status', { linearSessionId, status })

  return true
}

/**
 * Update session cost data (tokens and USD)
 *
 * @param linearSessionId - The Linear session ID
 * @param costData - Cost fields to persist
 */
export async function updateSessionCostData(
  linearSessionId: string,
  costData: { totalCostUsd?: number; inputTokens?: number; outputTokens?: number }
): Promise<boolean> {
  if (!isRedisConfigured()) {
    log.warn('Redis not configured, cannot update session cost data')
    return false
  }

  const existing = await getSessionState(linearSessionId)
  if (!existing) {
    log.warn('Session not found for cost update', { linearSessionId })
    return false
  }

  const key = buildSessionKey(linearSessionId)
  const now = Math.floor(Date.now() / 1000)

  const updated: AgentSessionState = {
    ...existing,
    totalCostUsd: costData.totalCostUsd ?? existing.totalCostUsd,
    inputTokens: costData.inputTokens ?? existing.inputTokens,
    outputTokens: costData.outputTokens ?? existing.outputTokens,
    updatedAt: now,
  }

  await redisSet(key, updated, SESSION_TTL_SECONDS)

  log.info('Updated session cost data', {
    linearSessionId,
    totalCostUsd: updated.totalCostUsd,
  })

  return true
}

/**
 * Reset a session for re-queuing after orphan cleanup
 * Clears workerId and resets status to pending so a new worker can claim it
 *
 * @param linearSessionId - The Linear session ID
 */
export async function resetSessionForRequeue(
  linearSessionId: string
): Promise<boolean> {
  if (!isRedisConfigured()) {
    log.warn('Redis not configured, cannot reset session')
    return false
  }

  const existing = await getSessionState(linearSessionId)
  if (!existing) {
    log.warn('Session not found for reset', { linearSessionId })
    return false
  }

  const key = buildSessionKey(linearSessionId)
  const now = Math.floor(Date.now() / 1000)

  const updated: AgentSessionState = {
    ...existing,
    status: 'pending',
    workerId: undefined, // Clear workerId so new worker can claim
    claimedAt: undefined,
    updatedAt: now,
  }

  await redisSet(key, updated, SESSION_TTL_SECONDS)

  log.info('Reset session for requeue', {
    linearSessionId,
    previousWorkerId: existing.workerId,
  })

  return true
}

/**
 * Delete session state from KV
 *
 * @param linearSessionId - The Linear session ID
 * @returns Whether the deletion was successful
 */
export async function deleteSessionState(linearSessionId: string): Promise<boolean> {
  if (!isRedisConfigured()) {
    return false
  }

  const key = buildSessionKey(linearSessionId)
  const result = await redisDel(key)

  log.info('Deleted session state', { linearSessionId })

  return result > 0
}

/**
 * Get session state by issue ID
 * Useful when we have the issue but not the session ID
 *
 * @param issueId - The Linear issue ID
 * @returns The most recent session state for this issue or null
 */
export async function getSessionStateByIssue(
  issueId: string
): Promise<AgentSessionState | null> {
  if (!isRedisConfigured()) {
    return null
  }

  // Scan for sessions with this issue ID
  // Note: This is less efficient than direct lookup, use sparingly
  const keys = await redisKeys(`${SESSION_KEY_PREFIX}*`)

  for (const key of keys) {
    const state = await redisGet<AgentSessionState>(key)
    if (state?.issueId === issueId) {
      return state
    }
  }

  return null
}

// ============================================
// Worker Pool Operations
// ============================================

/**
 * Mark a session as claimed by a worker
 *
 * @param linearSessionId - The Linear session ID
 * @param workerId - The worker claiming the session
 */
export async function claimSession(
  linearSessionId: string,
  workerId: string
): Promise<boolean> {
  if (!isRedisConfigured()) {
    return false
  }

  const existing = await getSessionState(linearSessionId)
  if (!existing) {
    log.warn('Session not found for claim', { linearSessionId })
    return false
  }

  if (existing.status !== 'pending') {
    log.warn('Session not in pending status', {
      linearSessionId,
      status: existing.status,
    })
    return false
  }

  const key = buildSessionKey(linearSessionId)
  const now = Math.floor(Date.now() / 1000)

  const updated: AgentSessionState = {
    ...existing,
    status: 'claimed',
    workerId,
    claimedAt: now,
    updatedAt: now,
  }

  await redisSet(key, updated, SESSION_TTL_SECONDS)

  log.info('Session claimed', { linearSessionId, workerId })

  return true
}

/**
 * Update session with worker info when work starts
 *
 * @param linearSessionId - The Linear session ID
 * @param workerId - The worker processing the session
 * @param worktreePath - Path to the git worktree
 */
export async function startSession(
  linearSessionId: string,
  workerId: string,
  worktreePath: string
): Promise<boolean> {
  if (!isRedisConfigured()) {
    return false
  }

  const existing = await getSessionState(linearSessionId)
  if (!existing) {
    log.warn('Session not found for start', { linearSessionId })
    return false
  }

  const key = buildSessionKey(linearSessionId)
  const now = Math.floor(Date.now() / 1000)

  const updated: AgentSessionState = {
    ...existing,
    status: 'running',
    workerId,
    worktreePath,
    updatedAt: now,
  }

  await redisSet(key, updated, SESSION_TTL_SECONDS)

  log.info('Session started', { linearSessionId, workerId, worktreePath })

  return true
}

/**
 * Get all sessions from Redis
 * For dashboard display
 */
export async function getAllSessions(): Promise<AgentSessionState[]> {
  if (!isRedisConfigured()) {
    return []
  }

  try {
    const keys = await redisKeys(`${SESSION_KEY_PREFIX}*`)
    const sessions: AgentSessionState[] = []

    for (const key of keys) {
      const state = await redisGet<AgentSessionState>(key)
      if (state) {
        sessions.push(state)
      }
    }

    // Sort by updatedAt descending (most recent first)
    sessions.sort((a, b) => b.updatedAt - a.updatedAt)

    return sessions
  } catch (error) {
    log.error('Failed to get all sessions', { error })
    return []
  }
}

/**
 * Get sessions by status
 */
export async function getSessionsByStatus(
  status: AgentSessionStatus | AgentSessionStatus[]
): Promise<AgentSessionState[]> {
  const allSessions = await getAllSessions()
  const statusArray = Array.isArray(status) ? status : [status]
  return allSessions.filter((s) => statusArray.includes(s.status))
}

/**
 * Transfer session ownership to a new worker
 * Used when a worker re-registers after disconnection and gets a new ID
 *
 * @param linearSessionId - The Linear session ID
 * @param newWorkerId - The new worker ID to assign
 * @param oldWorkerId - The previous worker ID (for validation)
 * @returns Whether the transfer was successful
 */
export async function transferSessionOwnership(
  linearSessionId: string,
  newWorkerId: string,
  oldWorkerId: string
): Promise<{ transferred: boolean; reason?: string }> {
  if (!isRedisConfigured()) {
    return { transferred: false, reason: 'Redis not configured' }
  }

  const existing = await getSessionState(linearSessionId)
  if (!existing) {
    return { transferred: false, reason: 'Session not found' }
  }

  // Validate that the old worker ID matches (security check)
  if (existing.workerId && existing.workerId !== oldWorkerId) {
    log.warn('Session ownership transfer rejected - worker ID mismatch', {
      linearSessionId,
      expectedWorkerId: oldWorkerId,
      actualWorkerId: existing.workerId,
    })
    return {
      transferred: false,
      reason: `Session owned by different worker: ${existing.workerId}`,
    }
  }

  const key = buildSessionKey(linearSessionId)
  const now = Math.floor(Date.now() / 1000)

  const updated: AgentSessionState = {
    ...existing,
    workerId: newWorkerId,
    updatedAt: now,
  }

  await redisSet(key, updated, SESSION_TTL_SECONDS)

  log.info('Session ownership transferred', {
    linearSessionId,
    oldWorkerId,
    newWorkerId,
  })

  return { transferred: true }
}
