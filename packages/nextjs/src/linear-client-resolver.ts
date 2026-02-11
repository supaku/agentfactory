/**
 * Default Linear Client Resolver
 *
 * Provides a generic LinearClientResolver that uses:
 * 1. Workspace-specific OAuth tokens from Redis (if configured)
 * 2. Falls back to a global API key from environment
 *
 * This is the pattern every consumer needs — extracted from Supaku's
 * linear.ts for reuse.
 */

import {
  createLinearAgentClient,
  type LinearAgentClient,
} from '@supaku/agentfactory-linear'
import {
  getAccessToken,
  isRedisConfigured,
  createLogger,
} from '@supaku/agentfactory-server'
import type { LinearClientResolver } from './types.js'

const log = createLogger('linear-client-resolver')

/**
 * Configuration for the default Linear client resolver.
 */
export interface DefaultLinearClientResolverConfig {
  /** Environment variable name for the API key (default: 'LINEAR_ACCESS_TOKEN') */
  apiKeyEnvVar?: string
}

/**
 * Create a default Linear client resolver.
 *
 * Resolves Linear clients with workspace-aware OAuth token support:
 * - If an organizationId is provided and Redis is configured, attempts to
 *   fetch a workspace-specific OAuth token.
 * - Falls back to a global API key from the environment.
 *
 * @example
 * ```typescript
 * import { createDefaultLinearClientResolver } from '@supaku/agentfactory-nextjs'
 *
 * const resolver = createDefaultLinearClientResolver()
 * // Use in route config:
 * const routes = createAllRoutes({ linearClient: resolver, ... })
 * ```
 */
export function createDefaultLinearClientResolver(
  config?: DefaultLinearClientResolverConfig
): LinearClientResolver {
  const apiKeyEnvVar = config?.apiKeyEnvVar ?? 'LINEAR_ACCESS_TOKEN'
  let _globalClient: LinearAgentClient | null = null

  function getGlobalClient(): LinearAgentClient {
    if (!_globalClient) {
      const apiKey = process.env[apiKeyEnvVar]
      if (!apiKey) {
        throw new Error(
          `${apiKeyEnvVar} not set - Linear API operations will fail`
        )
      }
      _globalClient = createLinearAgentClient({ apiKey })
    }
    return _globalClient
  }

  async function getClientForWorkspace(
    workspaceId: string
  ): Promise<LinearAgentClient> {
    if (isRedisConfigured()) {
      const accessToken = await getAccessToken(workspaceId)

      if (accessToken) {
        log.debug('Using OAuth token from Redis', { workspaceId })
        return createLinearAgentClient({ apiKey: accessToken })
      }

      log.debug('No OAuth token in Redis, falling back to env var', { workspaceId })
    }

    return getGlobalClient()
  }

  return {
    getClient: async (organizationId?: string) =>
      organizationId
        ? await getClientForWorkspace(organizationId)
        : getGlobalClient(),
  }
}
