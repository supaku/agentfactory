/**
 * Enrichment Data Endpoints
 *
 * GET /api/gdpr/enrichment/[contactId] — View enrichment log for a contact
 * DELETE /api/gdpr/enrichment/[contactId]/[enrichmentId] — Reverse an enrichment
 *
 * Shows data source indicators and allows one-click removal of enriched data.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getEnrichmentLog,
  getFieldSources,
  reverseEnrichment,
  createLogger,
} from '@supaku/agentfactory-server'

const log = createLogger('api:gdpr:enrichment')

export interface GdprEnrichmentConfig {
  /** Extract user ID from the request */
  getUserId: (request: NextRequest) => Promise<string | null>
  /** Callback when an enrichment is reversed, so the consumer can update the contact */
  onEnrichmentReversed?: (
    userId: string,
    contactId: string,
    field: string,
    previousValue: string | null
  ) => Promise<void>
}

export function createGdprEnrichmentGetHandler(config: GdprEnrichmentConfig) {
  return async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ contactId: string }> }
  ) {
    try {
      const userId = await config.getUserId(request)
      if (!userId) {
        return NextResponse.json(
          { error: 'Unauthorized', message: 'Authentication required' },
          { status: 401 }
        )
      }

      const { contactId } = await params

      const [enrichmentLog, fieldSources] = await Promise.all([
        getEnrichmentLog(userId, contactId),
        getFieldSources(userId, contactId),
      ])

      return NextResponse.json({
        contactId,
        fieldSources,
        entries: enrichmentLog?.entries ?? [],
        totalEntries: enrichmentLog?.entries.length ?? 0,
      })
    } catch (error) {
      log.error('Failed to get enrichment log', { error })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to get enrichment log' },
        { status: 500 }
      )
    }
  }
}

export function createGdprEnrichmentDeleteHandler(config: GdprEnrichmentConfig) {
  return async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ contactId: string; enrichmentId: string }> }
  ) {
    try {
      const userId = await config.getUserId(request)
      if (!userId) {
        return NextResponse.json(
          { error: 'Unauthorized', message: 'Authentication required' },
          { status: 401 }
        )
      }

      const { contactId, enrichmentId } = await params

      const result = await reverseEnrichment(userId, contactId, enrichmentId)

      if (!result) {
        return NextResponse.json(
          { error: 'Not Found', message: 'Enrichment entry not found' },
          { status: 404 }
        )
      }

      if (!result.reversed) {
        return NextResponse.json({
          message: 'Enrichment was already reversed',
          field: result.field,
        })
      }

      // Notify consumer to update the contact field
      if (config.onEnrichmentReversed) {
        await config.onEnrichmentReversed(userId, contactId, result.field, result.previousValue)
      }

      return NextResponse.json({
        message: 'Enrichment reversed',
        field: result.field,
        previousValue: result.previousValue,
      })
    } catch (error) {
      log.error('Failed to reverse enrichment', { error })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to reverse enrichment' },
        { status: 500 }
      )
    }
  }
}
