/**
 * @supaku/agentfactory-nextjs
 *
 * Next.js API route handlers for AgentFactory.
 * Provides webhook processing, worker/session management, and public stats.
 */

// Types
export type {
  LinearClientResolver,
  RouteConfig,
  WebhookConfig,
  AutoTriggerConfig,
  CronConfig,
  RouteHandler,
} from './types'

// Factory
export { createAllRoutes } from './factory'
export type { AllRoutes } from './factory'

// Middleware
export { verifyCronAuth } from './middleware/cron-auth'
export {
  verifyWorkerAuth,
  requireWorkerAuth,
  unauthorizedResponse,
  isWorkerAuthConfigured,
} from './middleware/worker-auth'

// Webhook
export { createWebhookHandler } from './webhook/processor'
export { verifyWebhookSignature } from './webhook/signature'

// Individual handler factories (for custom wiring)

// Worker handlers
export { createWorkerRegisterHandler } from './handlers/workers/register'
export { createWorkerListHandler } from './handlers/workers/list'
export { createWorkerGetHandler, createWorkerDeleteHandler } from './handlers/workers/get-delete'
export { createWorkerHeartbeatHandler } from './handlers/workers/heartbeat'
export { createWorkerPollHandler } from './handlers/workers/poll'

// Session handlers (no Linear dependency)
export { createSessionListHandler } from './handlers/sessions/list'
export { createSessionGetHandler } from './handlers/sessions/get'
export { createSessionClaimHandler } from './handlers/sessions/claim'
export { createSessionStatusPostHandler, createSessionStatusGetHandler } from './handlers/sessions/status'
export { createSessionLockRefreshHandler } from './handlers/sessions/lock-refresh'
export { createSessionPromptsGetHandler, createSessionPromptsPostHandler } from './handlers/sessions/prompts'
export { createSessionTransferOwnershipHandler } from './handlers/sessions/transfer-ownership'

// Session handlers (Linear forwarding)
export { createSessionActivityHandler } from './handlers/sessions/activity'
export { createSessionCompletionHandler } from './handlers/sessions/completion'
export { createSessionExternalUrlsHandler } from './handlers/sessions/external-urls'
export { createSessionProgressHandler } from './handlers/sessions/progress'
export { createSessionToolErrorHandler } from './handlers/sessions/tool-error'

// Public handlers
export { createPublicStatsHandler } from './handlers/public/stats'
export { createPublicSessionsListHandler } from './handlers/public/sessions-list'
export { createPublicSessionDetailHandler } from './handlers/public/session-detail'

// Cleanup handler
export { createCleanupHandler } from './handlers/cleanup'
