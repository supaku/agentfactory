/**
 * Deployment Provider Factory
 *
 * Creates deployment providers based on repository configuration.
 * Follows the createProvider pattern from providers/index.ts.
 */

import type { DeployProvider } from './types.js'
import { VercelDeployProvider } from './vercel-provider.js'

export interface DeploymentConfig {
  provider?: string
  options?: Record<string, unknown>
}

/**
 * Create a deployment provider based on configuration.
 * Returns null when provider is 'none' (deployment checking disabled).
 */
export function createDeployProvider(config?: DeploymentConfig): DeployProvider | null {
  const providerName = config?.provider ?? 'vercel'

  switch (providerName) {
    case 'vercel':
      return new VercelDeployProvider(config?.options)
    case 'none':
      return null
    default:
      return new VercelDeployProvider(config?.options)
  }
}
