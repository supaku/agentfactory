/**
 * POST /api/sessions/[id]/external-urls
 *
 * Update external URLs for an agent session.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireWorkerAuth } from '../../middleware/worker-auth'
import { getSessionState, createLogger } from '@supaku/agentfactory-server'
import type { RouteConfig } from '../../types'

const log = createLogger('api:sessions:external-urls')

interface RouteParams {
  params: Promise<{ id: string }>
}

interface ExternalUrl {
  label: string
  url: string
}

export function createSessionExternalUrlsHandler(config: RouteConfig) {
  return async function POST(request: NextRequest, { params }: RouteParams) {
    const authError = requireWorkerAuth(request)
    if (authError) return authError

    const { id: sessionId } = await params

    try {
      const body = await request.json()
      const { externalUrls, workspaceId } = body as {
        externalUrls: ExternalUrl[]
        workspaceId?: string
      }

      if (!externalUrls || !Array.isArray(externalUrls)) {
        return NextResponse.json(
          { error: 'Bad Request', message: 'externalUrls array is required' },
          { status: 400 }
        )
      }

      for (const extUrl of externalUrls) {
        if (!extUrl.label || !extUrl.url) {
          return NextResponse.json(
            { error: 'Bad Request', message: 'Each external URL must have label and url' },
            { status: 400 }
          )
        }
      }

      const session = await getSessionState(sessionId)
      if (!session) {
        return NextResponse.json(
          { error: 'Not Found', message: 'Session not found' },
          { status: 404 }
        )
      }

      const effectiveWorkspaceId = workspaceId || session.organizationId

      if (!effectiveWorkspaceId) {
        log.warn('No workspace ID available, falling back to default client', {
          sessionId,
          hasWorkspaceIdInRequest: !!workspaceId,
          hasOrganizationIdInSession: !!session.organizationId,
        })
      }

      const linearClient = await config.linearClient.getClient(effectiveWorkspaceId)

      await linearClient.updateAgentSession({
        sessionId,
        externalUrls,
      })

      log.info('External URLs updated', {
        sessionId,
        urlCount: externalUrls.length,
        labels: externalUrls.map((u) => u.label),
      })

      return NextResponse.json({
        updated: true,
        externalUrls,
      })
    } catch (error) {
      log.error('Failed to update external URLs', { error, sessionId })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to update external URLs' },
        { status: 500 }
      )
    }
  }
}
