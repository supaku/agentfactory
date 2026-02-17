/**
 * Consent Management Endpoints
 *
 * GET /api/gdpr/consent — Get current consent state
 * POST /api/gdpr/consent — Update consent preferences
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getConsent,
  updateConsent,
  createLogger,
} from '@supaku/agentfactory-server'
import type { ConsentCategory } from '@supaku/agentfactory-server'

const log = createLogger('api:gdpr:consent')

const VALID_CATEGORIES: ConsentCategory[] = ['functional', 'enrichment', 'analytics', 'marketing']

export interface GdprConsentConfig {
  /** Extract user ID from the request */
  getUserId: (request: NextRequest) => Promise<string | null>
}

export function createGdprConsentHandler(config: GdprConsentConfig) {
  const GET = async function GET(request: NextRequest) {
    try {
      const userId = await config.getUserId(request)
      if (!userId) {
        return NextResponse.json(
          { error: 'Unauthorized', message: 'Authentication required' },
          { status: 401 }
        )
      }

      const consent = await getConsent(userId)

      return NextResponse.json({
        consent: consent.grants,
        updatedAt: consent.updatedAt,
      })
    } catch (error) {
      log.error('Failed to get consent', { error })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to get consent' },
        { status: 500 }
      )
    }
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

      const body = await request.json()
      const { category, granted } = body as { category: string; granted: boolean }

      if (!category || typeof granted !== 'boolean') {
        return NextResponse.json(
          { error: 'Bad Request', message: 'category (string) and granted (boolean) are required' },
          { status: 400 }
        )
      }

      if (!VALID_CATEGORIES.includes(category as ConsentCategory)) {
        return NextResponse.json(
          { error: 'Bad Request', message: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` },
          { status: 400 }
        )
      }

      if (category === 'functional' && !granted) {
        return NextResponse.json(
          { error: 'Bad Request', message: 'Functional consent cannot be revoked' },
          { status: 400 }
        )
      }

      const ipAddress = request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip') ?? undefined

      const consent = await updateConsent(
        userId,
        category as ConsentCategory,
        granted,
        ipAddress
      )

      return NextResponse.json({
        message: `Consent ${granted ? 'granted' : 'revoked'} for ${category}`,
        consent: consent.grants,
        updatedAt: consent.updatedAt,
      })
    } catch (error) {
      log.error('Failed to update consent', { error })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to update consent' },
        { status: 500 }
      )
    }
  }

  return { GET, POST }
}
