/**
 * Real Governor Dependencies
 *
 * Maps each GovernorDependencies callback to its real implementation
 * using the Linear SDK (via LinearAgentClient) and Redis storage
 * (from @supaku/agentfactory-server).
 */

import type { LinearAgentClient } from '@supaku/agentfactory-linear'
import type {
  GovernorDependencies,
  GovernorIssue,
  GovernorAction,
} from '@supaku/agentfactory'
import {
  isHeld as checkIsHeld,
  getOverridePriority as checkOverridePriority,
} from '@supaku/agentfactory'
import {
  getSessionStateByIssue,
  didJustFailQA,
  getWorkflowState,
  RedisProcessingStateStorage,
  queueWork,
} from '@supaku/agentfactory-server'
import type { QueuedWork } from '@supaku/agentfactory-server'

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const log = {
  info: (msg: string, data?: Record<string, unknown>) =>
    console.log(`[governor-deps] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) =>
    console.warn(`[governor-deps] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) =>
    console.error(`[governor-deps] ${msg}`, data ? JSON.stringify(data) : ''),
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface RealDependenciesConfig {
  linearClient: LinearAgentClient
}

// ---------------------------------------------------------------------------
// Action-to-WorkType mapping
// ---------------------------------------------------------------------------

function actionToWorkType(action: GovernorAction): string {
  switch (action) {
    case 'trigger-research':
      return 'research'
    case 'trigger-backlog-creation':
      return 'backlog-creation'
    case 'trigger-development':
      return 'development'
    case 'trigger-qa':
      return 'qa'
    case 'trigger-acceptance':
      return 'acceptance'
    case 'trigger-refinement':
      return 'refinement'
    case 'decompose':
      return 'coordination'
    case 'escalate-human':
      return 'escalation'
    default:
      return 'development'
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Terminal statuses (issues in these states are excluded from scans)
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = ['Accepted', 'Canceled', 'Duplicate'] as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Linear SDK Issue to a GovernorIssue.
 * Resolves lazy-loaded relations (state, labels, parent, project).
 *
 * Uses `unknown` + explicit casts to avoid importing `Issue` from
 * `@linear/sdk`, keeping the CLI package dependency graph clean.
 */
async function sdkIssueToGovernorIssue(issue: unknown): Promise<GovernorIssue> {
  // The Linear SDK Issue type uses LinearFetch (thenable) for lazy-loaded relations.
  // We cast to `any` to access these properties without importing the SDK types.
  const i = issue as {
    id: string
    identifier: string
    title: string
    description?: string | null
    createdAt: Date
    state: PromiseLike<{ name: string } | undefined>
    labels: () => PromiseLike<{ nodes: Array<{ name: string }> }>
    parent: PromiseLike<{ id: string } | undefined | null>
    project: PromiseLike<{ name: string } | undefined | null>
  }

  const state = await i.state
  const labels = await i.labels()
  const parent = await i.parent
  const project = await i.project

  return {
    id: i.id,
    identifier: i.identifier,
    title: i.title,
    description: i.description ?? undefined,
    status: state?.name ?? 'Backlog',
    labels: labels.nodes.map((l) => l.name),
    createdAt: i.createdAt.getTime(),
    parentId: parent?.id,
    project: project?.name,
  }
}

/**
 * Create real GovernorDependencies backed by the Linear SDK and Redis.
 *
 * Each callback wraps its implementation in a try/catch so that a single
 * failing dependency does not crash the entire governor scan loop.
 */
export function createRealDependencies(
  config: RealDependenciesConfig,
): GovernorDependencies {
  const processingState = new RedisProcessingStateStorage()

  return {
    // -----------------------------------------------------------------------
    // 1. listIssues -- scan Linear project for non-terminal issues
    // -----------------------------------------------------------------------
    listIssues: async (project: string): Promise<GovernorIssue[]> => {
      try {
        const linearClient = config.linearClient.linearClient

        const issueConnection = await linearClient.issues({
          filter: {
            project: { name: { eq: project } },
            state: { name: { nin: [...TERMINAL_STATUSES] } },
          },
        })

        const results: GovernorIssue[] = []
        for (const issue of issueConnection.nodes) {
          results.push(await sdkIssueToGovernorIssue(issue))
        }
        return results
      } catch (err) {
        log.error('listIssues failed', {
          project,
          error: err instanceof Error ? err.message : String(err),
        })
        return []
      }
    },

    // -----------------------------------------------------------------------
    // 2. hasActiveSession -- check Redis session storage
    // -----------------------------------------------------------------------
    hasActiveSession: async (issueId: string): Promise<boolean> => {
      try {
        const session = await getSessionStateByIssue(issueId)
        if (!session) return false
        const activeStatuses = ['running', 'claimed', 'pending']
        return activeStatuses.includes(session.status)
      } catch (err) {
        log.error('hasActiveSession failed', {
          issueId,
          error: err instanceof Error ? err.message : String(err),
        })
        return false
      }
    },

    // -----------------------------------------------------------------------
    // 3. isWithinCooldown -- check if QA just failed for this issue
    // -----------------------------------------------------------------------
    isWithinCooldown: async (issueId: string): Promise<boolean> => {
      try {
        return await didJustFailQA(issueId)
      } catch (err) {
        log.error('isWithinCooldown failed', {
          issueId,
          error: err instanceof Error ? err.message : String(err),
        })
        return false
      }
    },

    // -----------------------------------------------------------------------
    // 4. isParentIssue -- check via Linear API
    // -----------------------------------------------------------------------
    isParentIssue: async (issueId: string): Promise<boolean> => {
      try {
        return await config.linearClient.isParentIssue(issueId)
      } catch (err) {
        log.error('isParentIssue failed', {
          issueId,
          error: err instanceof Error ? err.message : String(err),
        })
        return false
      }
    },

    // -----------------------------------------------------------------------
    // 5. isHeld -- check touchpoint override storage
    // -----------------------------------------------------------------------
    isHeld: async (issueId: string): Promise<boolean> => {
      try {
        return await checkIsHeld(issueId)
      } catch (err) {
        log.error('isHeld failed', {
          issueId,
          error: err instanceof Error ? err.message : String(err),
        })
        return false
      }
    },

    // -----------------------------------------------------------------------
    // 6. getOverridePriority -- check touchpoint override storage
    // -----------------------------------------------------------------------
    getOverridePriority: async (issueId: string) => {
      try {
        return await checkOverridePriority(issueId)
      } catch (err) {
        log.error('getOverridePriority failed', {
          issueId,
          error: err instanceof Error ? err.message : String(err),
        })
        return null
      }
    },

    // -----------------------------------------------------------------------
    // 7. getWorkflowStrategy -- check Redis workflow state
    // -----------------------------------------------------------------------
    getWorkflowStrategy: async (issueId: string): Promise<string | undefined> => {
      try {
        const workflowState = await getWorkflowState(issueId)
        return workflowState?.strategy
      } catch (err) {
        log.error('getWorkflowStrategy failed', {
          issueId,
          error: err instanceof Error ? err.message : String(err),
        })
        return undefined
      }
    },

    // -----------------------------------------------------------------------
    // 8. isResearchCompleted -- check Redis processing state
    // -----------------------------------------------------------------------
    isResearchCompleted: async (issueId: string): Promise<boolean> => {
      try {
        return await processingState.isPhaseCompleted(issueId, 'research')
      } catch (err) {
        log.error('isResearchCompleted failed', {
          issueId,
          error: err instanceof Error ? err.message : String(err),
        })
        return false
      }
    },

    // -----------------------------------------------------------------------
    // 9. isBacklogCreationCompleted -- check Redis processing state
    // -----------------------------------------------------------------------
    isBacklogCreationCompleted: async (issueId: string): Promise<boolean> => {
      try {
        return await processingState.isPhaseCompleted(issueId, 'backlog-creation')
      } catch (err) {
        log.error('isBacklogCreationCompleted failed', {
          issueId,
          error: err instanceof Error ? err.message : String(err),
        })
        return false
      }
    },

    // -----------------------------------------------------------------------
    // 10. dispatchWork -- create Linear session and queue work
    // -----------------------------------------------------------------------
    dispatchWork: async (issueId: string, action: GovernorAction): Promise<void> => {
      try {
        const workType = actionToWorkType(action)

        log.info('Dispatching work', { issueId, action, workType })

        // Fetch the issue to get its identifier for the queue entry
        let issueIdentifier = issueId
        try {
          const issue = await config.linearClient.getIssue(issueId)
          issueIdentifier = issue.identifier
        } catch {
          log.warn('Could not fetch issue identifier, using issueId', { issueId })
        }

        // Create a Linear Agent Session on the issue so the UI shows activity
        let sessionId: string | undefined
        try {
          const sessionResult = await config.linearClient.createAgentSessionOnIssue({
            issueId,
          })
          sessionId = sessionResult.sessionId
        } catch (err) {
          log.warn('Could not create agent session, will queue without sessionId', {
            issueId,
            error: err instanceof Error ? err.message : String(err),
          })
        }

        // Queue the work item for a worker to pick up
        const queuedWork: QueuedWork = {
          sessionId: sessionId ?? `governor-${issueId}-${Date.now()}`,
          issueId,
          issueIdentifier,
          priority: 3, // Default priority; PRIORITY overrides are handled by the governor sort
          queuedAt: Date.now(),
          workType: workType as QueuedWork['workType'],
        }

        const queued = await queueWork(queuedWork)
        if (!queued) {
          log.warn('Failed to queue work (Redis may not be configured)', {
            issueId,
            action,
          })
        } else {
          log.info('Work queued successfully', {
            issueId,
            issueIdentifier,
            action,
            workType,
            sessionId: queuedWork.sessionId,
          })
        }
      } catch (err) {
        log.error('dispatchWork failed', {
          issueId,
          action,
          error: err instanceof Error ? err.message : String(err),
        })
        throw err // Re-throw so the governor can record the error
      }
    },
  }
}
