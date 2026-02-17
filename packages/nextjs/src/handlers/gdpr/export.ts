/**
 * POST /api/gdpr/export
 *
 * Triggers a full data export for the authenticated user.
 * Returns export files as a JSON map (filename -> content).
 *
 * For ZIP packaging, consumers should wrap this handler to stream
 * the response as a ZIP archive.
 *
 * GET /api/gdpr/export
 * Returns available export formats and options.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  buildExportFiles,
  exportContacts,
  exportActivities,
  exportGifts,
  logAuditEvent,
  createLogger,
} from '@supaku/agentfactory-server'
import type { DataExportProvider, ExportFormat } from '@supaku/agentfactory-server'

const log = createLogger('api:gdpr:export')

export interface GdprExportConfig {
  /** Provider that supplies user data for export */
  exportProvider: DataExportProvider
  /** Extract user ID from the request (e.g., from auth session) */
  getUserId: (request: NextRequest) => Promise<string | null>
}

export function createGdprExportHandler(config: GdprExportConfig) {
  const GET = async function GET() {
    return NextResponse.json({
      formats: {
        contacts: ['vcard', 'csv', 'json'],
        activities: ['json', 'csv'],
        gifts: ['json', 'csv'],
        all: ['zip'],
      },
      description: 'POST to this endpoint to trigger a data export.',
    })
  }

  const POST = async function POST(request: NextRequest) {
    try {
      const userId = await config.getUserId(request)
      if (!userId) {
        return NextResponse.json(
          { error: 'Unauthorized', message: 'Authentication required' },
          { status: 401 }
        )
      }

      const body = await request.json().catch(() => ({}))
      const format = (body as Record<string, unknown>).format as string | undefined
      const entityType = (body as Record<string, unknown>).entityType as string | undefined

      const userData = await config.exportProvider.getUserData(userId)

      await logAuditEvent({
        userId,
        action: 'export.request',
        entityType: entityType ?? 'all',
        details: { format: format ?? 'zip' },
      })

      // Selective export by entity type
      if (entityType && format) {
        let content: string | null = null

        switch (entityType) {
          case 'contacts':
            content = exportContacts(userData.contacts, format as ExportFormat)
            break
          case 'activities':
            content = exportActivities(userData.activities, format as 'json' | 'csv')
            break
          case 'gifts':
            content = exportGifts(userData.gifts, format as 'json' | 'csv')
            break
        }

        if (content === null) {
          return NextResponse.json(
            { error: 'Bad Request', message: `Unsupported entity type or format: ${entityType}/${format}` },
            { status: 400 }
          )
        }

        await logAuditEvent({
          userId,
          action: 'export.complete',
          entityType,
          details: { format, recordCount: content.split('\n').length },
        })

        const contentType = format === 'csv' ? 'text/csv'
          : format === 'vcard' ? 'text/vcard'
          : 'application/json'

        const extension = format === 'vcard' ? 'vcf' : format

        return new NextResponse(content, {
          headers: {
            'Content-Type': contentType,
            'Content-Disposition': `attachment; filename="${entityType}.${extension}"`,
          },
        })
      }

      // Full export (ZIP-ready file map)
      const files = buildExportFiles(userData)
      const filesObj = Object.fromEntries(files)

      await logAuditEvent({
        userId,
        action: 'export.complete',
        entityType: 'all',
        details: {
          fileCount: files.size,
          contactCount: userData.contacts.length,
          activityCount: userData.activities.length,
          giftCount: userData.gifts.length,
        },
      })

      return NextResponse.json({
        message: 'Export ready',
        exportedAt: userData.exportedAt,
        files: filesObj,
      })
    } catch (error) {
      log.error('Export failed', { error })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Export failed' },
        { status: 500 }
      )
    }
  }

  return { GET, POST }
}
