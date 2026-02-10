/**
 * Factory — @supaku/agentfactory-nextjs
 *
 * Wires all handlers together from a single configuration object.
 * Consumers call `createAllRoutes(config)` and get back a nested
 * route tree that maps 1:1 onto Next.js App Router exports.
 */

import type { RouteHandler, RouteConfig, WebhookConfig, CronConfig } from './types'

// Worker handlers
import { createWorkerRegisterHandler } from './handlers/workers/register'
import { createWorkerListHandler } from './handlers/workers/list'
import { createWorkerGetHandler, createWorkerDeleteHandler } from './handlers/workers/get-delete'
import { createWorkerHeartbeatHandler } from './handlers/workers/heartbeat'
import { createWorkerPollHandler } from './handlers/workers/poll'

// Session handlers (no Linear)
import { createSessionListHandler } from './handlers/sessions/list'
import { createSessionGetHandler } from './handlers/sessions/get'
import { createSessionClaimHandler } from './handlers/sessions/claim'
import { createSessionStatusPostHandler, createSessionStatusGetHandler } from './handlers/sessions/status'
import { createSessionLockRefreshHandler } from './handlers/sessions/lock-refresh'
import { createSessionPromptsGetHandler, createSessionPromptsPostHandler } from './handlers/sessions/prompts'
import { createSessionTransferOwnershipHandler } from './handlers/sessions/transfer-ownership'

// Session handlers (Linear forwarding)
import { createSessionActivityHandler } from './handlers/sessions/activity'
import { createSessionCompletionHandler } from './handlers/sessions/completion'
import { createSessionExternalUrlsHandler } from './handlers/sessions/external-urls'
import { createSessionProgressHandler } from './handlers/sessions/progress'
import { createSessionToolErrorHandler } from './handlers/sessions/tool-error'

// Public handlers
import { createPublicStatsHandler } from './handlers/public/stats'
import { createPublicSessionsListHandler } from './handlers/public/sessions-list'
import { createPublicSessionDetailHandler } from './handlers/public/session-detail'

// Cleanup handler
import { createCleanupHandler } from './handlers/cleanup'

// Webhook processor
import { createWebhookHandler } from './webhook/processor'

export interface AllRoutes {
  workers: {
    register: { POST: RouteHandler }
    list: { GET: RouteHandler }
    detail: { GET: RouteHandler; DELETE: RouteHandler }
    heartbeat: { POST: RouteHandler }
    poll: { GET: RouteHandler }
  }
  sessions: {
    list: { GET: RouteHandler }
    detail: { GET: RouteHandler }
    claim: { POST: RouteHandler }
    status: { GET: RouteHandler; POST: RouteHandler }
    lockRefresh: { POST: RouteHandler }
    prompts: { GET: RouteHandler; POST: RouteHandler }
    transferOwnership: { POST: RouteHandler }
    activity: { POST: RouteHandler }
    completion: { POST: RouteHandler }
    externalUrls: { POST: RouteHandler }
    progress: { POST: RouteHandler }
    toolError: { POST: RouteHandler }
  }
  public: {
    stats: { GET: RouteHandler }
    sessions: { GET: RouteHandler }
    sessionDetail: { GET: RouteHandler }
  }
  cleanup: { POST: RouteHandler; GET: RouteHandler }
  webhook: { POST: RouteHandler; GET: RouteHandler }
}

/**
 * Create all route handlers from a single config object.
 *
 * @example
 * ```typescript
 * import { createAllRoutes } from '@supaku/agentfactory-nextjs'
 *
 * const routes = createAllRoutes({
 *   linearClient: { getClient: async (orgId) => getLinearClient(orgId) },
 *   generatePrompt: (id, workType) => `Work on ${id}`,
 * })
 *
 * // In app/api/workers/register/route.ts:
 * export const POST = routes.workers.register.POST
 * ```
 */
export function createAllRoutes(config: WebhookConfig & CronConfig): AllRoutes {
  const routeConfig: RouteConfig = {
    linearClient: config.linearClient,
    appUrl: config.appUrl,
  }

  const cleanup = createCleanupHandler(config)
  const webhook = createWebhookHandler(config)

  return {
    workers: {
      register: { POST: createWorkerRegisterHandler() },
      list: { GET: createWorkerListHandler() },
      detail: { GET: createWorkerGetHandler(), DELETE: createWorkerDeleteHandler() },
      heartbeat: { POST: createWorkerHeartbeatHandler() },
      poll: { GET: createWorkerPollHandler() },
    },
    sessions: {
      list: { GET: createSessionListHandler() },
      detail: { GET: createSessionGetHandler() },
      claim: { POST: createSessionClaimHandler() },
      status: { GET: createSessionStatusGetHandler(), POST: createSessionStatusPostHandler() },
      lockRefresh: { POST: createSessionLockRefreshHandler() },
      prompts: { GET: createSessionPromptsGetHandler(), POST: createSessionPromptsPostHandler() },
      transferOwnership: { POST: createSessionTransferOwnershipHandler() },
      activity: { POST: createSessionActivityHandler(routeConfig) },
      completion: { POST: createSessionCompletionHandler(routeConfig) },
      externalUrls: { POST: createSessionExternalUrlsHandler(routeConfig) },
      progress: { POST: createSessionProgressHandler(routeConfig) },
      toolError: { POST: createSessionToolErrorHandler(routeConfig) },
    },
    public: {
      stats: { GET: createPublicStatsHandler() },
      sessions: { GET: createPublicSessionsListHandler() },
      sessionDetail: { GET: createPublicSessionDetailHandler() },
    },
    cleanup: { POST: cleanup.POST, GET: cleanup.GET },
    webhook: { POST: webhook.POST, GET: webhook.GET },
  }
}
