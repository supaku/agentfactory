/**
 * GET /api/workers/[id]/poll
 *
 * Poll for pending work items and follow-up prompts.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireWorkerAuth } from '../../middleware/worker-auth.js'
import {
  getWorker,
  peekWork,
  getPendingPrompts,
  type PendingPrompt,
  maybeCleanupOrphans,
  createLogger,
} from '@supaku/agentfactory-server'

const log = createLogger('api:workers:poll')

interface RouteParams {
  params: Promise<{ id: string }>
}

export function createWorkerPollHandler() {
  return async function GET(request: NextRequest, { params }: RouteParams) {
    const authError = requireWorkerAuth(request)
    if (authError) return authError

    const { id: workerId } = await params

    try {
      maybeCleanupOrphans().catch((err) => {
        log.error('Background orphan cleanup failed', { error: err })
      })

      const worker = await getWorker(workerId)
      if (!worker) {
        return NextResponse.json(
          { error: 'Not Found', message: 'Worker not found' },
          { status: 404 }
        )
      }

      const availableCapacity = worker.capacity - worker.activeCount
      let work: Awaited<ReturnType<typeof peekWork>> = []

      if (availableCapacity > 0) {
        const limit = Math.min(availableCapacity, 5)
        work = await peekWork(limit)
      }

      const pendingPrompts: Record<string, PendingPrompt[]> = {}
      let totalPendingPrompts = 0

      if (worker.activeSessions.length > 0) {
        await Promise.all(
          worker.activeSessions.map(async (sessionId) => {
            const prompts = await getPendingPrompts(sessionId)
            if (prompts.length > 0) {
              pendingPrompts[sessionId] = prompts
              totalPendingPrompts += prompts.length
            }
          })
        )
      }

      if (work.length > 0 || totalPendingPrompts > 0) {
        log.info('Poll result with items', {
          workerId,
          availableCapacity,
          workCount: work.length,
          workItems: work.map((w) => ({
            sessionId: w.sessionId,
            issueIdentifier: w.issueIdentifier,
            workType: w.workType,
          })),
          activeSessionCount: worker.activeSessions.length,
          pendingPromptsCount: totalPendingPrompts,
          pendingPromptsBySession: Object.entries(pendingPrompts).map(
            ([sessionId, prompts]) => ({
              sessionId,
              count: prompts.length,
              promptIds: prompts.map((p) => p.id),
            })
          ),
        })
      } else {
        log.debug('Poll result (empty)', {
          workerId,
          availableCapacity,
          activeSessionCount: worker.activeSessions.length,
        })
      }

      return NextResponse.json({
        work,
        pendingPrompts,
        hasPendingPrompts: totalPendingPrompts > 0,
      })
    } catch (error) {
      log.error('Failed to poll for work', { error, workerId })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to poll for work' },
        { status: 500 }
      )
    }
  }
}
