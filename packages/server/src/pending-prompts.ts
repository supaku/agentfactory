/**
 * Pending Prompts Module
 *
 * Stores follow-up prompts for running agent sessions.
 * Workers poll for pending prompts and forward them to their running Claude processes.
 */

import {
  redisRPush,
  redisLRange,
  redisLRem,
  redisLLen,
  redisDel,
  isRedisConfigured,
} from './redis'
import { createLogger } from './logger'

const log = createLogger('pending-prompts')

// Redis key prefix for pending prompts per session
const PENDING_PROMPTS_PREFIX = 'session:prompts:'

/**
 * A pending prompt waiting to be delivered to a running agent
 */
export interface PendingPrompt {
  id: string // Unique identifier for this prompt
  sessionId: string
  issueId: string
  prompt: string
  userId?: string
  userName?: string
  createdAt: number // Unix timestamp
}

/**
 * Build the Redis key for a session's pending prompts
 */
function buildPromptsKey(sessionId: string): string {
  return `${PENDING_PROMPTS_PREFIX}${sessionId}`
}

/**
 * Generate a unique prompt ID
 */
function generatePromptId(): string {
  return `prm_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
}

/**
 * Store a pending prompt for a session
 *
 * @param sessionId - The Linear session ID
 * @param issueId - The Linear issue ID
 * @param prompt - The prompt text from the user
 * @param user - Optional user info
 * @returns The created prompt or null if storage failed
 */
export async function storePendingPrompt(
  sessionId: string,
  issueId: string,
  prompt: string,
  user?: { id?: string; name?: string }
): Promise<PendingPrompt | null> {
  if (!isRedisConfigured()) {
    log.warn('Redis not configured, cannot store pending prompt')
    return null
  }

  try {
    const pendingPrompt: PendingPrompt = {
      id: generatePromptId(),
      sessionId,
      issueId,
      prompt,
      userId: user?.id,
      userName: user?.name,
      createdAt: Date.now(),
    }

    const key = buildPromptsKey(sessionId)
    const serialized = JSON.stringify(pendingPrompt)
    await redisRPush(key, serialized)

    log.info('Pending prompt stored', {
      promptId: pendingPrompt.id,
      sessionId,
      issueId,
      promptLength: prompt.length,
    })

    return pendingPrompt
  } catch (error) {
    log.error('Failed to store pending prompt', { error, sessionId, issueId })
    return null
  }
}

/**
 * Get all pending prompts for a session
 *
 * @param sessionId - The Linear session ID
 * @returns Array of pending prompts (oldest first)
 */
export async function getPendingPrompts(sessionId: string): Promise<PendingPrompt[]> {
  if (!isRedisConfigured()) {
    return []
  }

  try {
    const key = buildPromptsKey(sessionId)
    const items = await redisLRange(key, 0, -1)
    return items.map((item) => JSON.parse(item) as PendingPrompt)
  } catch (error) {
    log.error('Failed to get pending prompts', { error, sessionId })
    return []
  }
}

/**
 * Get the count of pending prompts for a session
 */
export async function getPendingPromptCount(sessionId: string): Promise<number> {
  if (!isRedisConfigured()) {
    return 0
  }

  try {
    const key = buildPromptsKey(sessionId)
    return await redisLLen(key)
  } catch (error) {
    log.error('Failed to get pending prompt count', { error, sessionId })
    return 0
  }
}

/**
 * Claim and remove a pending prompt by ID
 * Returns the prompt if found and removed, null otherwise
 *
 * @param sessionId - The Linear session ID
 * @param promptId - The prompt ID to claim
 * @returns The claimed prompt or null
 */
export async function claimPendingPrompt(
  sessionId: string,
  promptId: string
): Promise<PendingPrompt | null> {
  if (!isRedisConfigured()) {
    return null
  }

  try {
    const key = buildPromptsKey(sessionId)
    const items = await redisLRange(key, 0, -1)

    for (const item of items) {
      const prompt = JSON.parse(item) as PendingPrompt
      if (prompt.id === promptId) {
        // Remove this specific item from the list
        await redisLRem(key, 1, item)
        log.info('Pending prompt claimed', { promptId, sessionId })
        return prompt
      }
    }

    return null
  } catch (error) {
    log.error('Failed to claim pending prompt', { error, sessionId, promptId })
    return null
  }
}

/**
 * Pop the oldest pending prompt for a session (claim and remove atomically)
 *
 * @param sessionId - The Linear session ID
 * @returns The oldest pending prompt or null if none
 */
export async function popPendingPrompt(sessionId: string): Promise<PendingPrompt | null> {
  if (!isRedisConfigured()) {
    return null
  }

  try {
    const prompts = await getPendingPrompts(sessionId)
    if (prompts.length === 0) {
      return null
    }

    const oldest = prompts[0]
    const claimed = await claimPendingPrompt(sessionId, oldest.id)
    return claimed
  } catch (error) {
    log.error('Failed to pop pending prompt', { error, sessionId })
    return null
  }
}

/**
 * Clear all pending prompts for a session
 * Called when session completes or is stopped
 *
 * @param sessionId - The Linear session ID
 * @returns true if cleared successfully
 */
export async function clearPendingPrompts(sessionId: string): Promise<boolean> {
  if (!isRedisConfigured()) {
    return false
  }

  try {
    const key = buildPromptsKey(sessionId)
    await redisDel(key)
    log.info('Pending prompts cleared', { sessionId })
    return true
  } catch (error) {
    log.error('Failed to clear pending prompts', { error, sessionId })
    return false
  }
}
