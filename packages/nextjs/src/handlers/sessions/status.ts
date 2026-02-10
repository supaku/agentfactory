/**
 * GET, POST /api/sessions/[id]/status
 *
 * Report status update from worker or get current status.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireWorkerAuth } from '../../middleware/worker-auth'
import {
  getSessionState,
  updateSessionStatus,
  updateClaudeSessionId,
  startSession,
  type AgentSessionStatus,
  removeWorkerSession,
  releaseClaim,
  markAgentWorked,
  releaseIssueLock,
  promoteNextPendingWork,
  createLogger,
} from '@supaku/agentfactory-server'

const log = createLogger('api:sessions:status')

interface RouteParams {
  params: Promise<{ id: string }>
}

const VALID_STATUSES: AgentSessionStatus[] = [
  'running',
  'finalizing',
  'completed',
  'failed',
  'stopped',
]

const TERMINAL_STATUSES: AgentSessionStatus[] = ['completed', 'failed', 'stopped']

export function createSessionStatusPostHandler() {
  return async function POST(request: NextRequest, { params }: RouteParams) {
    const authError = requireWorkerAuth(request)
    if (authError) return authError

    const { id: sessionId } = await params

    try {
      const body = await request.json()
      const { workerId, status, claudeSessionId, worktreePath, error: errorInfo } = body as {
        workerId: string
        status: AgentSessionStatus
        claudeSessionId?: string
        worktreePath?: string
        error?: unknown
      }

      if (!workerId || typeof workerId !== 'string') {
        return NextResponse.json(
          { error: 'Bad Request', message: 'workerId is required' },
          { status: 400 }
        )
      }

      if (!status || !VALID_STATUSES.includes(status)) {
        return NextResponse.json(
          {
            error: 'Bad Request',
            message: `status must be one of: ${VALID_STATUSES.join(', ')}`,
          },
          { status: 400 }
        )
      }

      const session = await getSessionState(sessionId)
      if (!session) {
        return NextResponse.json(
          { error: 'Not Found', message: 'Session not found' },
          { status: 404 }
        )
      }

      if (session.workerId && session.workerId !== workerId) {
        return NextResponse.json(
          { error: 'Forbidden', message: 'Session is owned by another worker' },
          { status: 403 }
        )
      }

      if (status === 'running') {
        if (worktreePath) {
          await startSession(sessionId, workerId, worktreePath)
        } else {
          await updateSessionStatus(sessionId, 'running')
        }

        if (claudeSessionId) {
          await updateClaudeSessionId(sessionId, claudeSessionId)
        }
      } else if (status === 'finalizing') {
        await updateSessionStatus(sessionId, 'finalizing')
      } else if (TERMINAL_STATUSES.includes(status)) {
        await updateSessionStatus(sessionId, status)

        if (status === 'completed' && session.issueId) {
          try {
            await markAgentWorked(session.issueId, {
              issueIdentifier: session.issueIdentifier || 'unknown',
              sessionId: sessionId,
            })
            log.info('Issue marked as agent-worked', {
              issueId: session.issueId,
              sessionId,
            })
          } catch (err) {
            log.error('Failed to mark agent-worked', { sessionId, error: err })
          }
        }

        await releaseClaim(sessionId)
        await removeWorkerSession(workerId, sessionId)

        if (session.issueId) {
          try {
            await releaseIssueLock(session.issueId)
            const promoted = await promoteNextPendingWork(session.issueId)
            if (promoted) {
              log.info('Promoted pending work after lock release', {
                issueId: session.issueId,
                promotedSessionId: promoted.sessionId,
                promotedWorkType: promoted.workType,
              })
            }
          } catch (err) {
            log.error('Failed to release issue lock or promote pending work', {
              sessionId,
              issueId: session.issueId,
              error: err,
            })
          }
        }
      }

      log.info('Session status updated', {
        sessionId,
        workerId,
        status,
        hasClaudeSessionId: !!claudeSessionId,
        hasError: !!errorInfo,
      })

      const updatedSession = await getSessionState(sessionId)

      return NextResponse.json({
        updated: true,
        session: updatedSession,
      })
    } catch (error) {
      log.error('Failed to update session status', { error, sessionId })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to update session status' },
        { status: 500 }
      )
    }
  }
}

export function createSessionStatusGetHandler() {
  return async function GET(request: NextRequest, { params }: RouteParams) {
    const { id: sessionId } = await params

    try {
      const session = await getSessionState(sessionId)

      if (!session) {
        return NextResponse.json(
          { error: 'Not Found', message: 'Session not found' },
          { status: 404 }
        )
      }

      return NextResponse.json(session)
    } catch (error) {
      log.error('Failed to get session status', { error, sessionId })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to get session status' },
        { status: 500 }
      )
    }
  }
}
