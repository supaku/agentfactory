/**
 * GDPR Account Deletion Endpoints
 *
 * POST /api/gdpr/delete — Request account deletion (30-day grace period)
 * DELETE /api/gdpr/delete — Cancel pending deletion
 * GET /api/gdpr/delete — Check deletion status
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  requestAccountDeletion,
  cancelAccountDeletion,
  getDeletionStatus,
  createLogger,
} from '@supaku/agentfactory-server'

const log = createLogger('api:gdpr:delete')

export interface GdprDeleteConfig {
  /** Extract user ID from the request */
  getUserId: (request: NextRequest) => Promise<string | null>
  /** Extract user email from the request */
  getUserEmail: (request: NextRequest) => Promise<string | null>
  /** Send deletion confirmation email (optional) */
  sendConfirmationEmail?: (email: string, scheduledAt: string) => Promise<void>
  /** Send cancellation confirmation email (optional) */
  sendCancellationEmail?: (email: string) => Promise<void>
}

export function createGdprDeleteHandler(config: GdprDeleteConfig) {
  const GET = async function GET(request: NextRequest) {
    try {
      const userId = await config.getUserId(request)
      if (!userId) {
        return NextResponse.json(
          { error: 'Unauthorized', message: 'Authentication required' },
          { status: 401 }
        )
      }

      const status = await getDeletionStatus(userId)

      if (!status) {
        return NextResponse.json({ status: 'active', message: 'No deletion request pending' })
      }

      return NextResponse.json({
        status: status.status,
        requestedAt: status.requestedAt,
        scheduledDeletionAt: status.scheduledDeletionAt,
        cancelledAt: status.cancelledAt,
        executedAt: status.executedAt,
      })
    } catch (error) {
      log.error('Failed to check deletion status', { error })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to check deletion status' },
        { status: 500 }
      )
    }
  }

  const POST = async function POST(request: NextRequest) {
    try {
      const userId = await config.getUserId(request)
      const email = await config.getUserEmail(request)

      if (!userId || !email) {
        return NextResponse.json(
          { error: 'Unauthorized', message: 'Authentication required' },
          { status: 401 }
        )
      }

      // Check if there's already a pending deletion
      const existing = await getDeletionStatus(userId)
      if (existing && existing.status === 'pending') {
        return NextResponse.json({
          message: 'Deletion already pending',
          scheduledDeletionAt: existing.scheduledDeletionAt,
          requestedAt: existing.requestedAt,
        })
      }

      const body = await request.json().catch(() => ({}))
      const reason = (body as Record<string, unknown>).reason as string | undefined

      const deletion = await requestAccountDeletion(userId, email, reason)

      if (config.sendConfirmationEmail) {
        await config.sendConfirmationEmail(email, deletion.scheduledDeletionAt)
          .catch((err) => log.error('Failed to send deletion confirmation email', { error: err }))
      }

      return NextResponse.json({
        message: 'Account deletion requested',
        scheduledDeletionAt: deletion.scheduledDeletionAt,
        gracePeriodDays: 30,
        recoveryUrl: '/api/gdpr/delete',
      })
    } catch (error) {
      log.error('Failed to request deletion', { error })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to request deletion' },
        { status: 500 }
      )
    }
  }

  const DELETE = async function DELETE(request: NextRequest) {
    try {
      const userId = await config.getUserId(request)
      const email = await config.getUserEmail(request)

      if (!userId) {
        return NextResponse.json(
          { error: 'Unauthorized', message: 'Authentication required' },
          { status: 401 }
        )
      }

      const result = await cancelAccountDeletion(userId)

      if (!result.cancelled) {
        return NextResponse.json(
          { error: 'Bad Request', message: result.reason },
          { status: 400 }
        )
      }

      if (config.sendCancellationEmail && email) {
        await config.sendCancellationEmail(email)
          .catch((err) => log.error('Failed to send cancellation email', { error: err }))
      }

      return NextResponse.json({
        message: 'Account deletion cancelled',
        status: 'active',
      })
    } catch (error) {
      log.error('Failed to cancel deletion', { error })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to cancel deletion' },
        { status: 500 }
      )
    }
  }

  return { GET, POST, DELETE }
}
