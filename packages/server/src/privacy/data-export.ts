/**
 * Data Export Module
 *
 * Provides full data export in standard formats for GDPR compliance:
 * - Contacts: vCard 3.0, CSV, JSON
 * - Activities/interactions: JSON, CSV
 * - All data: ZIP archive
 *
 * Consumers provide their data through the DataExportProvider interface.
 * This module handles serialization to standard formats.
 */

import { createLogger } from '../logger.js'

const log = createLogger('privacy/data-export')

/**
 * Contact record for export
 */
export interface ExportContact {
  id: string
  firstName?: string
  lastName?: string
  email?: string
  phone?: string
  organization?: string
  title?: string
  birthday?: string
  address?: {
    street?: string
    city?: string
    state?: string
    postalCode?: string
    country?: string
  }
  notes?: string
  tags?: string[]
  createdAt: string
  updatedAt: string
  /** Data source for each field (for transparency) */
  dataSources?: Record<string, string>
}

/**
 * Activity/interaction record for export
 */
export interface ExportActivity {
  id: string
  contactId?: string
  type: string
  title: string
  description?: string
  date: string
  metadata?: Record<string, unknown>
  createdAt: string
}

/**
 * Gift list entry for export
 */
export interface ExportGift {
  id: string
  contactId?: string
  contactName?: string
  title: string
  description?: string
  occasion?: string
  date?: string
  status: string
  createdAt: string
}

/**
 * Full user data for export
 */
export interface ExportUserData {
  user: {
    id: string
    email: string
    name?: string
    createdAt: string
  }
  contacts: ExportContact[]
  activities: ExportActivity[]
  gifts: ExportGift[]
  auditLog: Array<Record<string, unknown>>
  exportedAt: string
}

/**
 * Interface that consumers implement to provide export data.
 * The server package handles format conversion; the consumer provides data.
 */
export interface DataExportProvider {
  getUserData(userId: string): Promise<ExportUserData>
}

/**
 * Convert a contact to vCard 3.0 format
 * @see https://www.rfc-editor.org/rfc/rfc2426
 */
export function contactToVCard(contact: ExportContact): string {
  const lines: string[] = [
    'BEGIN:VCARD',
    'VERSION:3.0',
  ]

  const fn = [contact.firstName, contact.lastName].filter(Boolean).join(' ')
  if (fn) {
    lines.push(`FN:${escapeVCardValue(fn)}`)
    lines.push(`N:${escapeVCardValue(contact.lastName ?? '')};${escapeVCardValue(contact.firstName ?? '')};;;`)
  }

  if (contact.email) {
    lines.push(`EMAIL;TYPE=INTERNET:${escapeVCardValue(contact.email)}`)
  }

  if (contact.phone) {
    lines.push(`TEL;TYPE=CELL:${escapeVCardValue(contact.phone)}`)
  }

  if (contact.organization) {
    lines.push(`ORG:${escapeVCardValue(contact.organization)}`)
  }

  if (contact.title) {
    lines.push(`TITLE:${escapeVCardValue(contact.title)}`)
  }

  if (contact.birthday) {
    lines.push(`BDAY:${contact.birthday}`)
  }

  if (contact.address) {
    const addr = contact.address
    lines.push(
      `ADR;TYPE=HOME:;;${escapeVCardValue(addr.street ?? '')};${escapeVCardValue(addr.city ?? '')};${escapeVCardValue(addr.state ?? '')};${escapeVCardValue(addr.postalCode ?? '')};${escapeVCardValue(addr.country ?? '')}`
    )
  }

  if (contact.notes) {
    lines.push(`NOTE:${escapeVCardValue(contact.notes)}`)
  }

  if (contact.tags && contact.tags.length > 0) {
    lines.push(`CATEGORIES:${contact.tags.map(escapeVCardValue).join(',')}`)
  }

  lines.push(`REV:${contact.updatedAt}`)
  lines.push(`UID:${contact.id}`)
  lines.push('END:VCARD')

  return lines.join('\r\n')
}

/**
 * Escape special characters in vCard values
 */
function escapeVCardValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
}

/**
 * Convert contacts to vCard format (multiple contacts in one file)
 */
export function contactsToVCard(contacts: ExportContact[]): string {
  return contacts.map(contactToVCard).join('\r\n')
}

/**
 * Convert an array of objects to CSV format
 */
export function toCSV(records: Record<string, unknown>[], columns?: string[]): string {
  if (records.length === 0) return ''

  const cols = columns ?? Object.keys(records[0])
  const header = cols.map(escapeCSVField).join(',')

  const rows = records.map((record) =>
    cols.map((col) => {
      const value = record[col]
      if (value === null || value === undefined) return ''
      if (typeof value === 'object') return escapeCSVField(JSON.stringify(value))
      return escapeCSVField(String(value))
    }).join(',')
  )

  return [header, ...rows].join('\n')
}

/**
 * Escape a CSV field value
 */
function escapeCSVField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

/**
 * Flatten a contact record for CSV export
 */
export function flattenContactForCSV(contact: ExportContact): Record<string, unknown> {
  return {
    id: contact.id,
    firstName: contact.firstName ?? '',
    lastName: contact.lastName ?? '',
    email: contact.email ?? '',
    phone: contact.phone ?? '',
    organization: contact.organization ?? '',
    title: contact.title ?? '',
    birthday: contact.birthday ?? '',
    street: contact.address?.street ?? '',
    city: contact.address?.city ?? '',
    state: contact.address?.state ?? '',
    postalCode: contact.address?.postalCode ?? '',
    country: contact.address?.country ?? '',
    notes: contact.notes ?? '',
    tags: contact.tags?.join('; ') ?? '',
    createdAt: contact.createdAt,
    updatedAt: contact.updatedAt,
  }
}

/**
 * Export types supported
 */
export type ExportFormat = 'json' | 'csv' | 'vcard'

/**
 * Export contacts in the specified format
 */
export function exportContacts(contacts: ExportContact[], format: ExportFormat): string {
  switch (format) {
    case 'vcard':
      return contactsToVCard(contacts)
    case 'csv':
      return toCSV(contacts.map(flattenContactForCSV))
    case 'json':
      return JSON.stringify(contacts, null, 2)
  }
}

/**
 * Export activities in the specified format
 */
export function exportActivities(activities: ExportActivity[], format: 'json' | 'csv'): string {
  switch (format) {
    case 'csv':
      return toCSV(activities.map((a) => ({
        id: a.id,
        contactId: a.contactId ?? '',
        type: a.type,
        title: a.title,
        description: a.description ?? '',
        date: a.date,
        createdAt: a.createdAt,
      })))
    case 'json':
      return JSON.stringify(activities, null, 2)
  }
}

/**
 * Export gifts in the specified format
 */
export function exportGifts(gifts: ExportGift[], format: 'json' | 'csv'): string {
  switch (format) {
    case 'csv':
      return toCSV(gifts.map((g) => ({
        id: g.id,
        contactId: g.contactId ?? '',
        contactName: g.contactName ?? '',
        title: g.title,
        description: g.description ?? '',
        occasion: g.occasion ?? '',
        date: g.date ?? '',
        status: g.status,
        createdAt: g.createdAt,
      })))
    case 'json':
      return JSON.stringify(gifts, null, 2)
  }
}

/**
 * Manifest file included in ZIP export
 */
export interface ExportManifest {
  version: string
  exportedAt: string
  userId: string
  files: Array<{
    name: string
    format: string
    recordCount: number
  }>
}

/**
 * Build the full export data structure for ZIP packaging.
 * Returns a map of filename -> content for the consumer to package into a ZIP.
 *
 * The actual ZIP creation is left to the handler layer since it may need
 * streaming or a specific ZIP library.
 */
export function buildExportFiles(data: ExportUserData): Map<string, string> {
  const files = new Map<string, string>()

  // Contacts in multiple formats
  if (data.contacts.length > 0) {
    files.set('contacts/contacts.vcf', contactsToVCard(data.contacts))
    files.set('contacts/contacts.csv', toCSV(data.contacts.map(flattenContactForCSV)))
    files.set('contacts/contacts.json', JSON.stringify(data.contacts, null, 2))
  }

  // Activities
  if (data.activities.length > 0) {
    files.set('activities/activities.json', JSON.stringify(data.activities, null, 2))
    files.set('activities/activities.csv', exportActivities(data.activities, 'csv'))
  }

  // Gifts
  if (data.gifts.length > 0) {
    files.set('gifts/gifts.json', JSON.stringify(data.gifts, null, 2))
    files.set('gifts/gifts.csv', exportGifts(data.gifts, 'csv'))
  }

  // Audit log
  if (data.auditLog.length > 0) {
    files.set('audit-log/audit-log.json', JSON.stringify(data.auditLog, null, 2))
  }

  // User profile
  files.set('profile/user.json', JSON.stringify(data.user, null, 2))

  // Manifest
  const manifest: ExportManifest = {
    version: '1.0.0',
    exportedAt: data.exportedAt,
    userId: data.user.id,
    files: Array.from(files.entries()).map(([name, content]) => ({
      name,
      format: name.split('.').pop() ?? 'unknown',
      recordCount: estimateRecordCount(content, name),
    })),
  }

  files.set('manifest.json', JSON.stringify(manifest, null, 2))

  log.info('Built export files', {
    userId: data.user.id,
    fileCount: files.size,
    contactCount: data.contacts.length,
    activityCount: data.activities.length,
    giftCount: data.gifts.length,
  })

  return files
}

/**
 * Estimate record count from export content
 */
function estimateRecordCount(content: string, filename: string): number {
  if (filename.endsWith('.json')) {
    try {
      const parsed = JSON.parse(content)
      return Array.isArray(parsed) ? parsed.length : 1
    } catch {
      return 1
    }
  }
  if (filename.endsWith('.csv')) {
    return Math.max(0, content.split('\n').length - 1) // subtract header
  }
  if (filename.endsWith('.vcf')) {
    return (content.match(/BEGIN:VCARD/g) ?? []).length
  }
  return 1
}
