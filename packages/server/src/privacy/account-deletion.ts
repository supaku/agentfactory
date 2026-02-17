/**
 * Account Deletion with 30-Day Grace Period
 *
 * Implements GDPR Article 17 "Right to Erasure":
 * 1. User requests deletion → soft delete with 30-day recovery window
 * 2. During grace period → user can cancel deletion and recover account
 * 3. After grace period → permanent deletion of all data
 *
 * Deletion state is stored in Redis with TTL for automatic cleanup.
 */

import { redisSet, redisGet, redisDel, redisKeys, isRedisConfigured } from '../redis.js'
import { logAuditEvent } from './audit-log.js'
import { createLogger } from '../logger.js'

const log = createLogger('privacy/account-deletion')

const DELETION_KEY_PREFIX = 'account:deletion:'
const GRACE_PERIOD_DAYS = 30
const GRACE_PERIOD_SECONDS = GRACE_PERIOD_DAYS * 24 * 60 * 60

export type DeletionStatus = 'pending' | 'cancelled' | 'executed'

export interface AccountDeletionRequest {
  /** User ID */
  userId: string
  /** Email for recovery notification */
  email: string
  /** When deletion was requested (ISO string) */
  requestedAt: string
  /** When data will be permanently deleted (ISO string) */
  scheduledDeletionAt: string
  /** Current status */
  status: DeletionStatus
  /** Reason for deletion (optional, user-provided) */
  reason?: string
  /** When cancelled (if applicable) */
  cancelledAt?: string
  /** When executed (if applicable) */
  executedAt?: string
}

/**
 * Build the Redis key for a deletion request
 */
function buildDeletionKey(userId: string): string {
  return `${DELETION_KEY_PREFIX}${userId}`
}

/**
 * Request account deletion.
 * Starts the 30-day grace period.
 */
export async function requestAccountDeletion(
  userId: string,
  email: string,
  reason?: string
): Promise<AccountDeletionRequest> {
  const now = new Date()
  const scheduledDeletion = new Date(now.getTime() + GRACE_PERIOD_SECONDS * 1000)

  const request: AccountDeletionRequest = {
    userId,
    email,
    requestedAt: now.toISOString(),
    scheduledDeletionAt: scheduledDeletion.toISOString(),
    status: 'pending',
    reason,
  }

  if (isRedisConfigured()) {
    const key = buildDeletionKey(userId)
    // Store with TTL slightly longer than grace period for cleanup margin
    await redisSet(key, request, GRACE_PERIOD_SECONDS + (7 * 24 * 60 * 60))
  }

  await logAuditEvent({
    userId,
    action: 'account.delete_request',
    entityType: 'account',
    entityId: userId,
    details: { reason, scheduledDeletionAt: request.scheduledDeletionAt },
  })

  log.info('Account deletion requested', {
    userId,
    scheduledDeletionAt: request.scheduledDeletionAt,
  })

  return request
}

/**
 * Cancel a pending account deletion.
 * Only works during the grace period.
 */
export async function cancelAccountDeletion(
  userId: string
): Promise<{ cancelled: boolean; reason?: string }> {
  if (!isRedisConfigured()) {
    return { cancelled: false, reason: 'Storage not configured' }
  }

  const key = buildDeletionKey(userId)
  const request = await redisGet<AccountDeletionRequest>(key)

  if (!request) {
    return { cancelled: false, reason: 'No pending deletion request found' }
  }

  if (request.status !== 'pending') {
    return { cancelled: false, reason: `Deletion is already ${request.status}` }
  }

  const updated: AccountDeletionRequest = {
    ...request,
    status: 'cancelled',
    cancelledAt: new Date().toISOString(),
  }

  await redisSet(key, updated, 7 * 24 * 60 * 60) // Keep record for 7 days

  await logAuditEvent({
    userId,
    action: 'account.delete_cancel',
    entityType: 'account',
    entityId: userId,
  })

  log.info('Account deletion cancelled', { userId })

  return { cancelled: true }
}

/**
 * Get the current deletion request status for a user.
 */
export async function getDeletionStatus(
  userId: string
): Promise<AccountDeletionRequest | null> {
  if (!isRedisConfigured()) {
    return null
  }

  const key = buildDeletionKey(userId)
  return redisGet<AccountDeletionRequest>(key)
}

/**
 * Check if an account deletion is past its grace period and ready for execution.
 */
export function isDeletionReady(request: AccountDeletionRequest): boolean {
  if (request.status !== 'pending') return false
  return new Date() >= new Date(request.scheduledDeletionAt)
}

/**
 * Mark a deletion as executed after all data has been purged.
 */
export async function markDeletionExecuted(userId: string): Promise<boolean> {
  if (!isRedisConfigured()) {
    return false
  }

  const key = buildDeletionKey(userId)
  const request = await redisGet<AccountDeletionRequest>(key)

  if (!request) return false

  const updated: AccountDeletionRequest = {
    ...request,
    status: 'executed',
    executedAt: new Date().toISOString(),
  }

  // Keep the executed record for 7 days for audit purposes
  await redisSet(key, updated, 7 * 24 * 60 * 60)

  await logAuditEvent({
    userId,
    action: 'account.delete_execute',
    entityType: 'account',
    entityId: userId,
  })

  log.info('Account deletion executed', { userId })

  return true
}

/**
 * Get all pending deletion requests that are past their grace period.
 * Used by a cleanup cron job to execute permanent deletions.
 */
export async function getPendingDeletions(): Promise<AccountDeletionRequest[]> {
  if (!isRedisConfigured()) {
    return []
  }

  const keys = await redisKeys(`${DELETION_KEY_PREFIX}*`)
  const pending: AccountDeletionRequest[] = []

  for (const key of keys) {
    const request = await redisGet<AccountDeletionRequest>(key)
    if (request && isDeletionReady(request)) {
      pending.push(request)
    }
  }

  return pending
}

/**
 * Delete all data associated with a user.
 * This is the callback interface — consumers implement the actual data cleanup.
 */
export interface AccountDataPurger {
  /** Delete all user data from the primary database */
  purgeUserData(userId: string): Promise<void>
  /** Send deletion confirmation email */
  sendDeletionConfirmation?(email: string): Promise<void>
}

/**
 * Execute permanent account deletion for all ready requests.
 * Call this from a periodic cron job.
 */
export async function executePendingDeletions(
  purger: AccountDataPurger
): Promise<{ executed: number; failed: number }> {
  const pending = await getPendingDeletions()

  let executed = 0
  let failed = 0

  for (const request of pending) {
    try {
      await purger.purgeUserData(request.userId)
      await markDeletionExecuted(request.userId)
      if (purger.sendDeletionConfirmation) {
        await purger.sendDeletionConfirmation(request.email)
      }
      executed++
    } catch (error) {
      log.error('Failed to execute account deletion', {
        userId: request.userId,
        error,
      })
      failed++
    }
  }

  if (executed > 0 || failed > 0) {
    log.info('Pending deletions processed', { executed, failed })
  }

  return { executed, failed }
}
