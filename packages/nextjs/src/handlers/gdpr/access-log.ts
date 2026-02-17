/**
 * GDPR Data Access Log
 *
 * GET /api/gdpr/access-log — View audit trail of data access and processing
 *
 * Implements GDPR Article 15 "Right of Access" — users can see
 * what processing has been done on their data.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getAuditEvents,
  exportAuditEvents,
  createLogger,
} from '@supaku/agentfactory-server'
import type { AuditAction } from '@supaku/agentfactory-server'

const log = createLogger('api:gdpr:access-log')

export interface GdprAccessLogConfig {
  /** Extract user ID from the request */
  getUserId: (request: NextRequest) => Promise<string | null>
}

export function createGdprAccessLogHandler(config: GdprAccessLogConfig) {
  return async function GET(request: NextRequest) {
    try {
      const userId = await config.getUserId(request)
      if (!userId) {
        return NextResponse.json(
          { error: 'Unauthorized', message: 'Authentication required' },
          { status: 401 }
        )
      }

      const url = new URL(request.url)
      const offset = parseInt(url.searchParams.get('offset') ?? '0', 10)
      const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 100)
      const action = url.searchParams.get('action') as AuditAction | null
      const exportAll = url.searchParams.get('export') === 'true'

      if (exportAll) {
        const allEvents = await exportAuditEvents(userId)
        return NextResponse.json({
          events: allEvents,
          total: allEvents.length,
          exportedAt: new Date().toISOString(),
        })
      }

      const result = await getAuditEvents(userId, {
        offset,
        limit,
        action: action ?? undefined,
      })

      return NextResponse.json({
        events: result.events,
        total: result.total,
        offset,
        limit,
      })
    } catch (error) {
      log.error('Failed to get access log', { error })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to get access log' },
        { status: 500 }
      )
    }
  }
}
