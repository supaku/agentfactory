/**
 * GDPR Route Factory — @supaku/agentfactory-nextjs
 *
 * Creates GDPR/privacy compliance route handlers from a single config.
 * Separate from the main factory because these routes require consumer-specific
 * configuration (auth extraction, data providers, email hooks).
 *
 * @example
 * ```typescript
 * import { createGdprRoutes } from '@supaku/agentfactory-nextjs'
 *
 * const gdpr = createGdprRoutes({
 *   getUserId: async (req) => getSession(req)?.userId ?? null,
 *   getUserEmail: async (req) => getSession(req)?.email ?? null,
 *   exportProvider: myExportProvider,
 *   privacyPolicy: {
 *     appName: 'Family',
 *     companyName: 'Supaku',
 *     privacyEmail: 'privacy@supaku.com',
 *     appUrl: 'https://family.supaku.com',
 *   },
 * })
 *
 * // Wire into Next.js App Router:
 * // app/api/gdpr/export/route.ts → { GET: gdpr.export.GET, POST: gdpr.export.POST }
 * // app/api/gdpr/delete/route.ts → { GET: gdpr.delete.GET, POST: gdpr.delete.POST, DELETE: gdpr.delete.DELETE }
 * // app/api/gdpr/access-log/route.ts → { GET: gdpr.accessLog.GET }
 * // app/api/gdpr/consent/route.ts → { GET: gdpr.consent.GET, POST: gdpr.consent.POST }
 * // app/api/gdpr/enrichment/[contactId]/route.ts → { GET: gdpr.enrichment.GET }
 * // app/api/gdpr/enrichment/[contactId]/[enrichmentId]/route.ts → { DELETE: gdpr.enrichmentReversal.DELETE }
 * // app/api/gdpr/privacy-policy/route.ts → { GET: gdpr.privacyPolicy.GET }
 * // app/api/gdpr/tos/route.ts → { GET: gdpr.tos.GET }
 * ```
 */

import { NextRequest } from 'next/server'
import type { RouteHandler } from './types.js'
import type { DataExportProvider } from '@supaku/agentfactory-server'

import { createGdprExportHandler, type GdprExportConfig } from './handlers/gdpr/export.js'
import { createGdprDeleteHandler, type GdprDeleteConfig } from './handlers/gdpr/delete.js'
import { createGdprAccessLogHandler } from './handlers/gdpr/access-log.js'
import { createGdprConsentHandler } from './handlers/gdpr/consent.js'
import { createGdprEnrichmentGetHandler, createGdprEnrichmentDeleteHandler, type GdprEnrichmentConfig } from './handlers/gdpr/enrichment.js'
import { createPrivacyPolicyHandler, createTosHandler, type PrivacyPolicyConfig } from './handlers/gdpr/privacy-policy.js'

export interface GdprRoutes {
  export: { GET: RouteHandler; POST: RouteHandler }
  delete: { GET: RouteHandler; POST: RouteHandler; DELETE: RouteHandler }
  accessLog: { GET: RouteHandler }
  consent: { GET: RouteHandler; POST: RouteHandler }
  enrichment: { GET: RouteHandler }
  enrichmentReversal: { DELETE: RouteHandler }
  privacyPolicy: { GET: RouteHandler }
  tos: { GET: RouteHandler }
}

export interface GdprRoutesConfig {
  /** Extract user ID from request (e.g., from auth session) */
  getUserId: (request: NextRequest) => Promise<string | null>
  /** Extract user email from request */
  getUserEmail: (request: NextRequest) => Promise<string | null>
  /** Provider that supplies user data for export */
  exportProvider: DataExportProvider
  /** Privacy policy configuration */
  privacyPolicy: PrivacyPolicyConfig
  /** Send deletion confirmation email */
  sendDeletionConfirmationEmail?: (email: string, scheduledAt: string) => Promise<void>
  /** Send cancellation confirmation email */
  sendCancellationEmail?: (email: string) => Promise<void>
  /** Callback when an enrichment is reversed */
  onEnrichmentReversed?: (
    userId: string,
    contactId: string,
    field: string,
    previousValue: string | null
  ) => Promise<void>
}

/**
 * Create all GDPR/privacy route handlers.
 */
export function createGdprRoutes(config: GdprRoutesConfig): GdprRoutes {
  const exportHandlers = createGdprExportHandler({
    exportProvider: config.exportProvider,
    getUserId: config.getUserId,
  })

  const deleteHandlers = createGdprDeleteHandler({
    getUserId: config.getUserId,
    getUserEmail: config.getUserEmail,
    sendConfirmationEmail: config.sendDeletionConfirmationEmail,
    sendCancellationEmail: config.sendCancellationEmail,
  })

  const accessLogHandler = createGdprAccessLogHandler({
    getUserId: config.getUserId,
  })

  const consentHandlers = createGdprConsentHandler({
    getUserId: config.getUserId,
  })

  const enrichmentGetHandler = createGdprEnrichmentGetHandler({
    getUserId: config.getUserId,
    onEnrichmentReversed: config.onEnrichmentReversed,
  })

  const enrichmentDeleteHandler = createGdprEnrichmentDeleteHandler({
    getUserId: config.getUserId,
    onEnrichmentReversed: config.onEnrichmentReversed,
  })

  const privacyPolicyHandler = createPrivacyPolicyHandler(config.privacyPolicy)
  const tosHandler = createTosHandler(config.privacyPolicy)

  return {
    export: { GET: exportHandlers.GET, POST: exportHandlers.POST },
    delete: { GET: deleteHandlers.GET, POST: deleteHandlers.POST, DELETE: deleteHandlers.DELETE },
    accessLog: { GET: accessLogHandler },
    consent: { GET: consentHandlers.GET, POST: consentHandlers.POST },
    enrichment: { GET: enrichmentGetHandler },
    enrichmentReversal: { DELETE: enrichmentDeleteHandler },
    privacyPolicy: { GET: privacyPolicyHandler },
    tos: { GET: tosHandler },
  }
}
