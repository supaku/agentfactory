/**
 * Consent Tracking
 *
 * Tracks user consent for data processing activities.
 * Implements GDPR Article 7 requirements for consent management.
 *
 * Consent types:
 * - functional: Session cookies, essential functionality (always required)
 * - enrichment: Third-party data enrichment of contacts
 * - analytics: Usage analytics (opt-in)
 * - marketing: Marketing communications (opt-in)
 */

import { redisSet, redisGet, isRedisConfigured } from '../redis.js'
import { logAuditEvent } from './audit-log.js'
import { createLogger } from '../logger.js'

const log = createLogger('privacy/consent')

const CONSENT_KEY_PREFIX = 'privacy:consent:'

export type ConsentCategory = 'functional' | 'enrichment' | 'analytics' | 'marketing'

export interface ConsentRecord {
  /** User ID */
  userId: string
  /** Consent grants by category */
  grants: Record<ConsentCategory, ConsentGrant>
  /** Last updated */
  updatedAt: string
}

export interface ConsentGrant {
  /** Whether consent is granted */
  granted: boolean
  /** When consent was last changed */
  changedAt: string
  /** IP address when consent was recorded */
  ipAddress?: string
}

/**
 * Build the Redis key for user consent
 */
function buildConsentKey(userId: string): string {
  return `${CONSENT_KEY_PREFIX}${userId}`
}

/**
 * Get default consent state (only functional is pre-granted)
 */
function getDefaultConsent(userId: string): ConsentRecord {
  const now = new Date().toISOString()
  return {
    userId,
    grants: {
      functional: { granted: true, changedAt: now },
      enrichment: { granted: false, changedAt: now },
      analytics: { granted: false, changedAt: now },
      marketing: { granted: false, changedAt: now },
    },
    updatedAt: now,
  }
}

/**
 * Get consent state for a user
 */
export async function getConsent(userId: string): Promise<ConsentRecord> {
  if (!isRedisConfigured()) {
    return getDefaultConsent(userId)
  }

  const key = buildConsentKey(userId)
  const consent = await redisGet<ConsentRecord>(key)
  return consent ?? getDefaultConsent(userId)
}

/**
 * Update consent for a specific category
 */
export async function updateConsent(
  userId: string,
  category: ConsentCategory,
  granted: boolean,
  ipAddress?: string
): Promise<ConsentRecord> {
  // Functional consent cannot be revoked
  if (category === 'functional' && !granted) {
    log.warn('Cannot revoke functional consent', { userId })
    return getConsent(userId)
  }

  const current = await getConsent(userId)
  const now = new Date().toISOString()

  const updated: ConsentRecord = {
    ...current,
    grants: {
      ...current.grants,
      [category]: {
        granted,
        changedAt: now,
        ipAddress,
      },
    },
    updatedAt: now,
  }

  if (isRedisConfigured()) {
    const key = buildConsentKey(userId)
    await redisSet(key, updated)
  }

  await logAuditEvent({
    userId,
    action: granted ? 'consent.grant' : 'consent.revoke',
    entityType: 'consent',
    entityId: category,
    details: { category, granted },
    ipAddress,
  })

  log.info('Consent updated', { userId, category, granted })

  return updated
}

/**
 * Check if a user has granted consent for a specific category
 */
export async function hasConsent(
  userId: string,
  category: ConsentCategory
): Promise<boolean> {
  const consent = await getConsent(userId)
  return consent.grants[category]?.granted ?? false
}
