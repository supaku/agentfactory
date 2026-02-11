/**
 * Edge Runtime-safe middleware exports.
 *
 * This barrel ONLY re-exports modules that are compatible with Next.js
 * Edge Runtime. It deliberately excludes worker-auth and cron-auth
 * which depend on @supaku/agentfactory-server (Node.js crypto/ioredis).
 *
 * Use this subpath import in middleware.ts:
 *   import { createAgentFactoryMiddleware } from '@supaku/agentfactory-nextjs/middleware'
 *
 * Do NOT import from the main barrel ('@supaku/agentfactory-nextjs')
 * in Edge Runtime — it pulls in Node.js-only modules.
 */

export { createAgentFactoryMiddleware } from './factory.js'
export type { MiddlewareConfig } from './types.js'
