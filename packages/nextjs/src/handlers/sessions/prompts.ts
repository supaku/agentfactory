/**
 * GET, POST /api/sessions/[id]/prompts
 *
 * Get pending prompts or claim a specific prompt.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireWorkerAuth } from '../../middleware/worker-auth.js'
import {
  getSessionState,
  getPendingPrompts,
  popPendingPrompt,
  claimPendingPrompt,
  createLogger,
} from '@supaku/agentfactory-server'

const log = createLogger('api:sessions:prompts')

interface RouteParams {
  params: Promise<{ id: string }>
}

export function createSessionPromptsGetHandler() {
  return async function GET(request: NextRequest, { params }: RouteParams) {
    const authError = requireWorkerAuth(request)
    if (authError) return authError

    const { id: sessionId } = await params
    const url = new URL(request.url)
    const shouldPop = url.searchParams.get('pop') === 'true'

    try {
      const session = await getSessionState(sessionId)
      if (!session) {
        return NextResponse.json(
          { error: 'Not Found', message: 'Session not found' },
          { status: 404 }
        )
      }

      if (shouldPop) {
        const prompt = await popPendingPrompt(sessionId)

        if (prompt) {
          log.info('Prompt popped successfully', {
            sessionId,
            promptId: prompt.id,
            promptLength: prompt.prompt.length,
          })
        }

        return NextResponse.json({
          prompt,
          hasMore: prompt ? true : false,
        })
      }

      const prompts = await getPendingPrompts(sessionId)

      if (prompts.length > 0) {
        log.info('Prompts retrieved', {
          sessionId,
          promptCount: prompts.length,
          promptIds: prompts.map((p) => p.id),
        })
      }

      return NextResponse.json({
        prompts,
        count: prompts.length,
      })
    } catch (error) {
      log.error('Failed to get pending prompts', { error, sessionId })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to get pending prompts' },
        { status: 500 }
      )
    }
  }
}

export function createSessionPromptsPostHandler() {
  return async function POST(request: NextRequest, { params }: RouteParams) {
    const authError = requireWorkerAuth(request)
    if (authError) return authError

    const { id: sessionId } = await params

    try {
      const body = await request.json()
      const { promptId } = body as { promptId: string }

      if (!promptId || typeof promptId !== 'string') {
        return NextResponse.json(
          { error: 'Bad Request', message: 'promptId is required' },
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

      const prompt = await claimPendingPrompt(sessionId, promptId)

      if (!prompt) {
        return NextResponse.json(
          { error: 'Not Found', message: 'Prompt not found or already claimed' },
          { status: 404 }
        )
      }

      log.info('Prompt claimed', {
        sessionId,
        promptId,
        promptLength: prompt.prompt.length,
      })

      return NextResponse.json({
        claimed: true,
        prompt,
      })
    } catch (error) {
      log.error('Failed to claim prompt', { error, sessionId })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to claim prompt' },
        { status: 500 }
      )
    }
  }
}
