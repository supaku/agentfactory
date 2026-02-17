/**
 * Privacy & GDPR Compliance Module
 *
 * Provides reusable privacy primitives for AgentFactory-powered applications:
 * - Field-level encryption (AES-256-GCM)
 * - Audit event logging
 * - Data export (vCard, CSV, JSON)
 * - Account deletion with grace period
 * - Enrichment tracking and reversal
 * - Consent management
 */

// Encryption
export {
  encryptField,
  decryptField,
  reEncryptField,
  deriveUserKey,
  isEncryptionConfigured,
} from './encryption.js'
export type { EncryptedField } from './encryption.js'

// Audit log
export {
  logAuditEvent,
  getAuditEvents,
  deleteAuditEvents,
  exportAuditEvents,
} from './audit-log.js'
export type { AuditEvent, AuditAction } from './audit-log.js'

// Data export
export {
  contactToVCard,
  contactsToVCard,
  toCSV,
  flattenContactForCSV,
  exportContacts,
  exportActivities,
  exportGifts,
  buildExportFiles,
} from './data-export.js'
export type {
  ExportContact,
  ExportActivity,
  ExportGift,
  ExportUserData,
  ExportManifest,
  ExportFormat,
  DataExportProvider,
} from './data-export.js'

// Account deletion
export {
  requestAccountDeletion,
  cancelAccountDeletion,
  getDeletionStatus,
  isDeletionReady,
  markDeletionExecuted,
  getPendingDeletions,
  executePendingDeletions,
} from './account-deletion.js'
export type {
  AccountDeletionRequest,
  DeletionStatus,
  AccountDataPurger,
} from './account-deletion.js'

// Enrichment log
export {
  logEnrichment,
  getEnrichmentLog,
  getFieldSources,
  reverseEnrichment,
  deleteUserEnrichmentData,
  exportUserEnrichmentData,
} from './enrichment-log.js'
export type {
  EnrichmentEntry,
  ContactEnrichmentLog,
} from './enrichment-log.js'

// Consent
export {
  getConsent,
  updateConsent,
  hasConsent,
} from './consent.js'
export type {
  ConsentRecord,
  ConsentGrant,
  ConsentCategory,
} from './consent.js'
