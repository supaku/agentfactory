/**
 * GET /api/workers/[id]/poll
 *
 * Poll for pending work items and inbox messages.
 * Reads from agent inbox streams (urgent-first) instead of pending-prompts Lists.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireWorkerAuth } from '../../middleware/worker-auth.js'
import {
  getWorker,
  peekWork,
  getSessionState,
  readInbox,
  type InboxMessage,
  maybeCleanupOrphans,
  createLogger,
  getSchedulerMode,
  filterByQuota,
} from '@renseiai/agentfactory-server'

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

      // Use activeSessions.length (authoritative Redis set) instead of
      // activeCount (heartbeat-reported, can be stale after re-registration)
      const availableCapacity = worker.capacity - worker.activeSessions.length
      let work: Awaited<ReturnType<typeof peekWork>> = []

      // TODO(SUP-1292): When SCHEDULER_MODE=pipeline, use scheduler orchestrator here
      // For now, legacy inline dispatch is used regardless of mode
      if (availableCapacity > 0) {
        const desiredCount = Math.min(availableCapacity, 5)
        const workerProjects = worker.projects
        const hasProjectFilter = workerProjects && workerProjects.length > 0

        // Over-fetch when filtering, since some items may not match
        const fetchLimit = hasProjectFilter ? Math.min(desiredCount * 4, 50) : desiredCount
        const allWork = await peekWork(fetchLimit)

        if (hasProjectFilter) {
          // Only accept work tagged with a project this worker serves.
          // Untagged work is excluded — it should only be picked up by
          // workers with no project filter, preventing cross-repo execution.
          work = allWork
            .filter(w => w.projectName && workerProjects.includes(w.projectName))
            .slice(0, desiredCount)
        } else {
          work = allWork.slice(0, desiredCount)
        }

        // QuotaFilter: exclude work from over-quota projects
        const quotaResult = await filterByQuota(work)
        work = quotaResult.allowed
        if (quotaResult.rejected.length > 0) {
          log.info('Quota filter rejected work items', {
            workerId,
            rejected: quotaResult.rejected.map(r => ({
              sessionId: r.work.sessionId,
              project: r.work.projectName,
              reason: r.reason,
            })),
          })
        }
      }

      // Read inbox messages for active sessions (urgent-first via streams)
      const inboxMessages: Record<string, InboxMessage[]> = {}
      let totalInboxMessages = 0

      if (worker.activeSessions.length > 0) {
        await Promise.all(
          worker.activeSessions.map(async (sessionId) => {
            try {
              const session = await getSessionState(sessionId)
              const agentId = session?.agentId
              if (!agentId) return

              const messages = await readInbox(agentId, workerId)
              if (messages.length > 0) {
                inboxMessages[sessionId] = messages
                totalInboxMessages += messages.length
              }
            } catch (err) {
              log.warn('Failed to read inbox for session', {
                sessionId,
                error: err,
              })
            }
          })
        )
      }

      if (work.length > 0 || totalInboxMessages > 0) {
        log.info('Poll result with items', {
          workerId,
          availableCapacity,
          workCount: work.length,
          workItems: work.map((w) => ({
            sessionId: w.sessionId,
            issueIdentifier: w.issueIdentifier,
            workType: w.workType,
            projectName: w.projectName,
          })),
          activeSessionCount: worker.activeSessions.length,
          inboxMessageCount: totalInboxMessages,
          inboxMessagesBySession: Object.entries(inboxMessages).map(
            ([sessionId, messages]) => ({
              sessionId,
              count: messages.length,
              messageIds: messages.map((m) => m.id),
              types: messages.map((m) => m.type),
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
        inboxMessages,
        hasInboxMessages: totalInboxMessages > 0,
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
