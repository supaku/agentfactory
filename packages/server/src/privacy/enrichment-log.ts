/**
 * Enrichment Audit Log
 *
 * Tracks every data enrichment event with source attribution.
 * Supports one-click reversal of enrichment data for transparency.
 *
 * Each enriched field on a contact stores:
 * - What source provided the data (Google Contacts, email signature, People Data Labs, etc.)
 * - When the enrichment occurred
 * - Whether it was user-initiated
 * - The original value before enrichment (for reversal)
 */

import { redisSet, redisGet, redisDel, redisKeys, isRedisConfigured } from '../redis.js'
import { logAuditEvent } from './audit-log.js'
import { createLogger } from '../logger.js'

const log = createLogger('privacy/enrichment-log')

const ENRICHMENT_KEY_PREFIX = 'enrichment:log:'

export interface EnrichmentEntry {
  /** Unique enrichment ID */
  id: string
  /** Contact that was enriched */
  contactId: string
  /** User who owns this contact */
  userId: string
  /** Field that was enriched (e.g., "email", "phone", "organization") */
  field: string
  /** Source of the enrichment data */
  source: string
  /** The enriched value */
  enrichedValue: string
  /** The original value before enrichment (null if field was empty) */
  previousValue: string | null
  /** Whether this enrichment was user-initiated */
  userInitiated: boolean
  /** Unix timestamp of the enrichment */
  timestamp: number
  /** Whether this enrichment has been reversed */
  reversed: boolean
  /** When it was reversed */
  reversedAt?: number
}

/**
 * Enrichment log for a contact (all enrichment entries for one contact)
 */
export interface ContactEnrichmentLog {
  contactId: string
  userId: string
  entries: EnrichmentEntry[]
}

/**
 * Build the Redis key for a contact's enrichment log
 */
function buildEnrichmentKey(userId: string, contactId: string): string {
  return `${ENRICHMENT_KEY_PREFIX}${userId}:${contactId}`
}

/**
 * Build the Redis key for user-level enrichment index
 */
function buildUserEnrichmentIndexKey(userId: string): string {
  return `${ENRICHMENT_KEY_PREFIX}index:${userId}`
}

/**
 * Generate a unique enrichment ID
 */
function generateEnrichmentId(): string {
  return `enr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Log an enrichment event for a contact field
 */
export async function logEnrichment(
  entry: Omit<EnrichmentEntry, 'id' | 'timestamp' | 'reversed'>
): Promise<EnrichmentEntry> {
  const fullEntry: EnrichmentEntry = {
    ...entry,
    id: generateEnrichmentId(),
    timestamp: Math.floor(Date.now() / 1000),
    reversed: false,
  }

  if (isRedisConfigured()) {
    const key = buildEnrichmentKey(entry.userId, entry.contactId)
    const existing = await redisGet<ContactEnrichmentLog>(key)

    const updated: ContactEnrichmentLog = existing
      ? { ...existing, entries: [...existing.entries, fullEntry] }
      : { contactId: entry.contactId, userId: entry.userId, entries: [fullEntry] }

    await redisSet(key, updated)

    // Update user index
    const indexKey = buildUserEnrichmentIndexKey(entry.userId)
    const index = await redisGet<string[]>(indexKey) ?? []
    if (!index.includes(entry.contactId)) {
      index.push(entry.contactId)
      await redisSet(indexKey, index)
    }
  }

  await logAuditEvent({
    userId: entry.userId,
    action: 'enrichment.add',
    entityType: 'contact',
    entityId: entry.contactId,
    details: {
      field: entry.field,
      source: entry.source,
      userInitiated: entry.userInitiated,
    },
  })

  log.info('Enrichment logged', {
    enrichmentId: fullEntry.id,
    contactId: entry.contactId,
    field: entry.field,
    source: entry.source,
  })

  return fullEntry
}

/**
 * Get the enrichment log for a contact
 */
export async function getEnrichmentLog(
  userId: string,
  contactId: string
): Promise<ContactEnrichmentLog | null> {
  if (!isRedisConfigured()) {
    return null
  }

  const key = buildEnrichmentKey(userId, contactId)
  return redisGet<ContactEnrichmentLog>(key)
}

/**
 * Get data source indicators for a contact's fields.
 * Returns a map of field name -> source name for display on the contact detail page.
 */
export async function getFieldSources(
  userId: string,
  contactId: string
): Promise<Record<string, string>> {
  const enrichmentLog = await getEnrichmentLog(userId, contactId)
  if (!enrichmentLog) return {}

  const sources: Record<string, string> = {}
  for (const entry of enrichmentLog.entries) {
    if (!entry.reversed) {
      sources[entry.field] = entry.source
    }
  }
  return sources
}

/**
 * Reverse a specific enrichment entry.
 * Returns the previous value so the consumer can restore it.
 */
export async function reverseEnrichment(
  userId: string,
  contactId: string,
  enrichmentId: string
): Promise<{ reversed: boolean; previousValue: string | null; field: string } | null> {
  if (!isRedisConfigured()) {
    return null
  }

  const key = buildEnrichmentKey(userId, contactId)
  const enrichmentLog = await redisGet<ContactEnrichmentLog>(key)

  if (!enrichmentLog) return null

  const entryIndex = enrichmentLog.entries.findIndex((e) => e.id === enrichmentId)
  if (entryIndex === -1) return null

  const entry = enrichmentLog.entries[entryIndex]
  if (entry.reversed) {
    return { reversed: false, previousValue: entry.previousValue, field: entry.field }
  }

  // Mark as reversed
  enrichmentLog.entries[entryIndex] = {
    ...entry,
    reversed: true,
    reversedAt: Math.floor(Date.now() / 1000),
  }

  await redisSet(key, enrichmentLog)

  await logAuditEvent({
    userId,
    action: 'enrichment.remove',
    entityType: 'contact',
    entityId: contactId,
    details: {
      enrichmentId,
      field: entry.field,
      source: entry.source,
    },
  })

  log.info('Enrichment reversed', {
    enrichmentId,
    contactId,
    field: entry.field,
  })

  return {
    reversed: true,
    previousValue: entry.previousValue,
    field: entry.field,
  }
}

/**
 * Delete all enrichment data for a user (for account deletion)
 */
export async function deleteUserEnrichmentData(userId: string): Promise<number> {
  if (!isRedisConfigured()) {
    return 0
  }

  const indexKey = buildUserEnrichmentIndexKey(userId)
  const contactIds = await redisGet<string[]>(indexKey) ?? []

  let deleted = 0
  for (const contactId of contactIds) {
    const key = buildEnrichmentKey(userId, contactId)
    await redisDel(key)
    deleted++
  }

  await redisDel(indexKey)

  log.info('Deleted enrichment data', { userId, contactsDeleted: deleted })
  return deleted
}

/**
 * Export all enrichment data for a user (for GDPR data access)
 */
export async function exportUserEnrichmentData(
  userId: string
): Promise<EnrichmentEntry[]> {
  if (!isRedisConfigured()) {
    return []
  }

  const indexKey = buildUserEnrichmentIndexKey(userId)
  const contactIds = await redisGet<string[]>(indexKey) ?? []

  const allEntries: EnrichmentEntry[] = []
  for (const contactId of contactIds) {
    const enrichmentLog = await getEnrichmentLog(userId, contactId)
    if (enrichmentLog) {
      allEntries.push(...enrichmentLog.entries)
    }
  }

  return allEntries.sort((a, b) => b.timestamp - a.timestamp)
}
