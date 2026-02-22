/**
 * POST /api/sessions/[id]/activity
 *
 * Report agent activity to be forwarded to Linear.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireWorkerAuth } from '../../middleware/worker-auth.js'
import { getSessionState, createLogger } from '@supaku/agentfactory-server'
import { createAgentSession } from '@supaku/agentfactory-linear'
import type { RouteConfig } from '../../types.js'

const log = createLogger('api:sessions:activity')

interface RouteParams {
  params: Promise<{ id: string }>
}

interface AgentActivity {
  type: 'thought' | 'action' | 'response'
  content: string
  toolName?: string
  toolInput?: Record<string, unknown>
  timestamp?: string
}

export function createSessionActivityHandler(config: RouteConfig) {
  return async function POST(request: NextRequest, { params }: RouteParams) {
    const authError = requireWorkerAuth(request)
    if (authError) return authError

    const { id: sessionId } = await params

    try {
      const body = await request.json()
      const { workerId, activity } = body as {
        workerId: string
        activity: AgentActivity
      }

      if (!workerId || typeof workerId !== 'string') {
        return NextResponse.json(
          { error: 'Bad Request', message: 'workerId is required' },
          { status: 400 }
        )
      }

      if (!activity || !activity.type || !activity.content) {
        return NextResponse.json(
          { error: 'Bad Request', message: 'activity with type and content is required' },
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

      // Skip Linear forwarding for governor-generated fake session IDs.
      // When the governor can't create a real agent session on Linear (e.g., OAuth
      // token issue), it generates a local ID prefixed with "governor-". There's no
      // corresponding session on Linear's side, so forwarding would always fail.
      if (sessionId.startsWith('governor-')) {
        log.debug('Skipping Linear forwarding for governor-generated session', {
          sessionId,
          activityType: activity.type,
        })
        return NextResponse.json({
          forwarded: false,
          reason: 'Governor-generated session — no Linear agent session exists',
        })
      }

      try {
        const linearClient = await config.linearClient.getClient(session.organizationId)

        const agentSession = createAgentSession({
          client: linearClient.linearClient,
          issueId: session.issueId,
          sessionId,
          autoTransition: false,
        })

        switch (activity.type) {
          case 'thought':
            await agentSession.emitThought(activity.content)
            break
          case 'action':
            await agentSession.emitAction(
              activity.toolName || 'Tool',
              activity.toolInput || {}
            )
            break
          case 'response':
            await agentSession.emitResponse(activity.content)
            break
        }

        log.debug('Activity forwarded to Linear', {
          sessionId,
          activityType: activity.type,
          issueId: session.issueId,
        })

        return NextResponse.json({
          forwarded: true,
        })
      } catch (linearError) {
        const errorMessage = linearError instanceof Error ? linearError.message : String(linearError)
        log.error('Failed to forward activity to Linear', {
          error: errorMessage,
          sessionId,
          issueId: session.issueId,
        })
        return NextResponse.json({
          forwarded: false,
          reason: `Failed to forward to Linear: ${errorMessage}`,
        })
      }
    } catch (error) {
      log.error('Failed to process activity', { error, sessionId })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to process activity' },
        { status: 500 }
      )
    }
  }
}
