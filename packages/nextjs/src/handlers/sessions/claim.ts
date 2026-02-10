/**
 * POST /api/sessions/[id]/claim
 *
 * Claim a session for processing.
 * Uses atomic operations to prevent race conditions.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireWorkerAuth } from '../../middleware/worker-auth'
import {
  claimWork,
  requeueWork,
  releaseClaim,
  claimSession,
  getSessionState,
  addWorkerSession,
  createLogger,
} from '@supaku/agentfactory-server'

const log = createLogger('api:sessions:claim')

interface RouteParams {
  params: Promise<{ id: string }>
}

export function createSessionClaimHandler() {
  return async function POST(request: NextRequest, { params }: RouteParams) {
    const authError = requireWorkerAuth(request)
    if (authError) return authError

    const { id: sessionId } = await params

    try {
      const body = await request.json()
      const { workerId } = body as { workerId: string }

      if (!workerId || typeof workerId !== 'string') {
        return NextResponse.json(
          { error: 'Bad Request', message: 'workerId is required' },
          { status: 400 }
        )
      }

      const work = await claimWork(sessionId, workerId)

      if (!work) {
        log.debug('Failed to claim work from queue', { sessionId, workerId })
        return NextResponse.json({
          claimed: false,
          reason: 'Work item not available or already claimed',
        })
      }

      const claimed = await claimSession(sessionId, workerId)

      if (!claimed) {
        const sessionState = await getSessionState(sessionId)

        if (!sessionState) {
          log.warn('Session state expired, dropping orphaned work item', {
            sessionId,
            workerId,
            issueIdentifier: work.issueIdentifier,
          })
          await releaseClaim(sessionId)
          return NextResponse.json({
            claimed: false,
            reason: 'Session state expired, work item dropped',
          })
        }

        if (sessionState.status !== 'pending') {
          log.warn('Session not in pending status, dropping work item', {
            sessionId,
            workerId,
            issueIdentifier: work.issueIdentifier,
            sessionStatus: sessionState.status,
          })
          await releaseClaim(sessionId)
          return NextResponse.json({
            claimed: false,
            reason: `Session in ${sessionState.status} status, work item dropped`,
          })
        }

        log.warn('Transient failure updating session state, re-queuing', {
          sessionId,
          workerId,
        })
        await requeueWork(work)
        return NextResponse.json({
          claimed: false,
          reason: 'Session state update failed, work re-queued',
        })
      }

      await addWorkerSession(workerId, sessionId)

      const session = await getSessionState(sessionId)

      log.info('Session claimed', {
        sessionId,
        workerId,
        issueIdentifier: work.issueIdentifier,
      })

      return NextResponse.json({
        claimed: true,
        session,
        work,
      })
    } catch (error) {
      log.error('Failed to claim session', { error, sessionId })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to claim session' },
        { status: 500 }
      )
    }
  }
}
