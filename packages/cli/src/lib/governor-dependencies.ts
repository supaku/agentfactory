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
  storeSessionState,
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
  linearClient: LinearAgentClient          // For read operations (listIssues, isParentIssue, etc.)
  oauthClient?: LinearAgentClient          // For Agent API (createAgentSessionOnIssue) - resolved from Redis
  organizationId?: string                  // Workspace ID for session state storage
  generatePrompt?: (identifier: string, workType: string, mentionContext?: string) => string
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

  // Caches populated by listIssues() single GraphQL query.
  // parentIssueIds: issues with children (isParent = true)
  // scannedIssueIds: all issues returned by the last scan (isParent known definitively)
  // Only issues NOT in scannedIssueIds need an API fallback (e.g., webhook-driven).
  const parentIssueIds = new Set<string>()
  const scannedIssueIds = new Set<string>()

  return {
    // -----------------------------------------------------------------------
    // 1. listIssues -- scan Linear project using single GraphQL query
    // -----------------------------------------------------------------------
    listIssues: async (project: string): Promise<GovernorIssue[]> => {
      try {
        const rawIssues = await config.linearClient.listProjectIssues(project)

        // Cache issue IDs for isParentIssue() lookups — avoids per-issue API calls
        parentIssueIds.clear()
        scannedIssueIds.clear()
        for (const issue of rawIssues) {
          scannedIssueIds.add(issue.id)
          if (issue.childCount > 0) {
            parentIssueIds.add(issue.id)
          }
        }

        return rawIssues.map((issue) => ({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          description: issue.description,
          status: issue.status,
          labels: issue.labels,
          createdAt: issue.createdAt,
          parentId: issue.parentId,
          project: issue.project,
        }))
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
    // 4. isParentIssue -- check cache first, fall back to API
    // -----------------------------------------------------------------------
    isParentIssue: async (issueId: string): Promise<boolean> => {
      // Check cached parent IDs from listIssues (populated by single GraphQL query)
      if (parentIssueIds.has(issueId)) return true

      // If the issue was in the scan, we know definitively it's not a parent
      if (scannedIssueIds.has(issueId)) return false

      // Fall back to API only for issues not in the last scan (e.g., webhook-driven)
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
    //     Accepts GovernorIssue directly (already resolved in the scan),
    //     eliminating 2 redundant API calls per dispatch.
    // -----------------------------------------------------------------------
    dispatchWork: async (issue: GovernorIssue, action: GovernorAction): Promise<void> => {
      const issueId = issue.id
      const issueIdentifier = issue.identifier
      const projectName = issue.project

      try {
        const workType = actionToWorkType(action)

        log.info('Dispatching work', { issueId, issueIdentifier, action, workType })

        // Create a Linear Agent Session on the issue so the UI shows activity
        // Use OAuth client (Agent API) if available, fall back to personal API key
        const sessionClient = config.oauthClient ?? config.linearClient
        let sessionId: string | undefined
        try {
          const sessionResult = await sessionClient.createAgentSessionOnIssue({
            issueId,
          })
          sessionId = sessionResult.sessionId
        } catch (err) {
          log.warn('Could not create agent session, will queue without sessionId', {
            issueId,
            error: err instanceof Error ? err.message : String(err),
          })
        }

        const finalSessionId = sessionId ?? `governor-${issueId}-${Date.now()}`
        const now = Date.now()

        // Generate prompt for the work type
        const prompt = config.generatePrompt?.(issueIdentifier, workType)

        // Register a pending session FIRST so hasActiveSession() returns true
        // immediately, preventing re-dispatch on subsequent poll sweeps.
        await storeSessionState(finalSessionId, {
          issueId,
          issueIdentifier,
          claudeSessionId: null,
          worktreePath: '',
          status: 'pending',
          workerId: null,
          queuedAt: now,
          priority: 3,
          workType: workType as QueuedWork['workType'],
          projectName,
          organizationId: config.organizationId,
          promptContext: prompt,
        })

        // Queue the work item for a worker to pick up
        const queuedWork: QueuedWork = {
          sessionId: finalSessionId,
          issueId,
          issueIdentifier,
          priority: 3,
          queuedAt: now,
          workType: workType as QueuedWork['workType'],
          projectName,
          prompt,
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
            projectName,
            sessionId: finalSessionId,
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
