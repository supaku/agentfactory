/**
 * Factory — @supaku/agentfactory-nextjs
 *
 * Wires all handlers together from a single configuration object.
 * Consumers call `createAllRoutes(config)` and get back a nested
 * route tree that maps 1:1 onto Next.js App Router exports.
 *
 * When optional config fields are omitted, sensible defaults from
 * @supaku/agentfactory-linear are used (defaultGeneratePrompt, etc.).
 */

import type { RouteHandler, RouteConfig, WebhookConfig, ResolvedWebhookConfig, CronConfig } from './types.js'
import {
  defaultGeneratePrompt,
  defaultDetectWorkTypeFromPrompt,
  defaultGetPriority,
  defaultBuildParentQAContext,
  defaultBuildParentAcceptanceContext,
} from '@supaku/agentfactory-linear'

// Worker handlers
import { createWorkerRegisterHandler } from './handlers/workers/register.js'
import { createWorkerListHandler } from './handlers/workers/list.js'
import { createWorkerGetHandler, createWorkerDeleteHandler } from './handlers/workers/get-delete.js'
import { createWorkerHeartbeatHandler } from './handlers/workers/heartbeat.js'
import { createWorkerPollHandler } from './handlers/workers/poll.js'

// Session handlers (no Linear)
import { createSessionListHandler } from './handlers/sessions/list.js'
import { createSessionGetHandler } from './handlers/sessions/get.js'
import { createSessionClaimHandler } from './handlers/sessions/claim.js'
import { createSessionStatusPostHandler, createSessionStatusGetHandler } from './handlers/sessions/status.js'
import { createSessionLockRefreshHandler } from './handlers/sessions/lock-refresh.js'
import { createSessionPromptsGetHandler, createSessionPromptsPostHandler } from './handlers/sessions/prompts.js'
import { createSessionTransferOwnershipHandler } from './handlers/sessions/transfer-ownership.js'

// Session handlers (Linear forwarding)
import { createSessionActivityHandler } from './handlers/sessions/activity.js'
import { createSessionCompletionHandler } from './handlers/sessions/completion.js'
import { createSessionExternalUrlsHandler } from './handlers/sessions/external-urls.js'
import { createSessionProgressHandler } from './handlers/sessions/progress.js'
import { createSessionToolErrorHandler } from './handlers/sessions/tool-error.js'

// Public handlers
import { createPublicStatsHandler } from './handlers/public/stats.js'
import { createPublicSessionsListHandler } from './handlers/public/sessions-list.js'
import { createPublicSessionDetailHandler } from './handlers/public/session-detail.js'

// Cleanup handler
import { createCleanupHandler } from './handlers/cleanup.js'

// Webhook processor
import { createWebhookHandler } from './webhook/processor.js'

// OAuth handler
import { createOAuthCallbackHandler, type OAuthConfig } from './handlers/oauth/callback.js'

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
  oauth: {
    callback: { GET: RouteHandler }
  }
}

/**
 * Configuration for createAllRoutes.
 * Extends WebhookConfig & CronConfig with optional OAuth config.
 */
export interface AllRoutesConfig extends WebhookConfig, CronConfig {
  /** OAuth configuration for the callback handler */
  oauth?: OAuthConfig
}

/**
 * Create all route handlers from a single config object.
 *
 * Optional fields fall back to sensible defaults from @supaku/agentfactory-linear:
 * - `generatePrompt` → `defaultGeneratePrompt`
 * - `detectWorkTypeFromPrompt` → `defaultDetectWorkTypeFromPrompt`
 * - `getPriority` → `defaultGetPriority`
 * - `buildParentQAContext` → `defaultBuildParentQAContext`
 * - `buildParentAcceptanceContext` → `defaultBuildParentAcceptanceContext`
 *
 * @example
 * ```typescript
 * import { createAllRoutes, createDefaultLinearClientResolver } from '@supaku/agentfactory-nextjs'
 *
 * // Minimal — everything uses defaults
 * const routes = createAllRoutes({
 *   linearClient: createDefaultLinearClientResolver(),
 * })
 *
 * // Custom — override specific callbacks
 * const routes = createAllRoutes({
 *   linearClient: createDefaultLinearClientResolver(),
 *   generatePrompt: myCustomPromptFn,
 *   oauth: { clientId: '...', clientSecret: '...' },
 * })
 * ```
 */
export function createAllRoutes(config: AllRoutesConfig): AllRoutes {
  // Apply defaults for optional webhook config fields
  const webhookConfig: ResolvedWebhookConfig & CronConfig = {
    ...config,
    generatePrompt: config.generatePrompt ?? defaultGeneratePrompt,
    detectWorkTypeFromPrompt: config.detectWorkTypeFromPrompt ?? defaultDetectWorkTypeFromPrompt,
    getPriority: config.getPriority ?? defaultGetPriority,
    buildParentQAContext: config.buildParentQAContext ?? defaultBuildParentQAContext,
    buildParentAcceptanceContext: config.buildParentAcceptanceContext ?? defaultBuildParentAcceptanceContext,
  }

  const routeConfig: RouteConfig = {
    linearClient: config.linearClient,
    appUrl: config.appUrl,
  }

  const cleanup = createCleanupHandler(webhookConfig)
  const webhook = createWebhookHandler(webhookConfig)
  const oauth = createOAuthCallbackHandler(config.oauth)

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
    oauth: {
      callback: { GET: oauth.GET },
    },
  }
}
