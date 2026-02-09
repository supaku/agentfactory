/**
 * Agent Provider Factory
 *
 * Creates provider instances based on name.
 * Supports provider selection via env vars:
 *   AGENT_PROVIDER=claude            (global default)
 *   AGENT_PROVIDER_SOCIAL=codex      (per-project override)
 *   AGENT_PROVIDER_QA=amp            (per-work-type override)
 *
 * Resolution order: work-type → project → env default → 'claude'
 */

export type { AgentProviderName, AgentProvider, AgentSpawnConfig, AgentHandle, AgentEvent } from './types'
export type {
  AgentInitEvent,
  AgentSystemEvent,
  AgentAssistantTextEvent,
  AgentToolUseEvent,
  AgentToolResultEvent,
  AgentToolProgressEvent,
  AgentResultEvent,
  AgentErrorEvent,
  AgentCostData,
} from './types'

export { ClaudeProvider, createClaudeProvider } from './claude-provider'
export { CodexProvider, createCodexProvider } from './codex-provider'
export { AmpProvider, createAmpProvider } from './amp-provider'

import type { AgentProvider, AgentProviderName } from './types'
import { ClaudeProvider } from './claude-provider'
import { CodexProvider } from './codex-provider'
import { AmpProvider } from './amp-provider'

/**
 * Create a provider instance by name.
 *
 * @param name - Provider name ('claude', 'codex', 'amp')
 * @returns AgentProvider instance
 * @throws Error if provider name is unknown
 */
export function createProvider(name: AgentProviderName): AgentProvider {
  switch (name) {
    case 'claude':
      return new ClaudeProvider()
    case 'codex':
      return new CodexProvider()
    case 'amp':
      return new AmpProvider()
    default:
      throw new Error(`Unknown agent provider: ${name}. Supported: claude, codex, amp`)
  }
}

/**
 * Resolve which provider to use based on env vars, project, and work type.
 *
 * Resolution order (highest priority first):
 * 1. AGENT_PROVIDER_{WORKTYPE} (e.g., AGENT_PROVIDER_QA=amp)
 * 2. AGENT_PROVIDER_{PROJECT} (e.g., AGENT_PROVIDER_SOCIAL=codex)
 * 3. AGENT_PROVIDER (global default)
 * 4. 'claude' (fallback)
 *
 * @param options - Project and work type context for resolution
 * @returns The resolved provider name
 */
export function resolveProviderName(options?: {
  project?: string
  workType?: string
}): AgentProviderName {
  // Check work-type-specific override
  if (options?.workType) {
    const workTypeKey = `AGENT_PROVIDER_${options.workType.toUpperCase().replace(/-/g, '_')}`
    const workTypeProvider = process.env[workTypeKey]
    if (workTypeProvider && isValidProviderName(workTypeProvider)) {
      return workTypeProvider
    }
  }

  // Check project-specific override
  if (options?.project) {
    const projectKey = `AGENT_PROVIDER_${options.project.toUpperCase()}`
    const projectProvider = process.env[projectKey]
    if (projectProvider && isValidProviderName(projectProvider)) {
      return projectProvider
    }
  }

  // Check global default
  const globalProvider = process.env.AGENT_PROVIDER
  if (globalProvider && isValidProviderName(globalProvider)) {
    return globalProvider
  }

  // Fallback
  return 'claude'
}

const VALID_PROVIDER_NAMES: AgentProviderName[] = ['claude', 'codex', 'amp']

function isValidProviderName(name: string): name is AgentProviderName {
  return VALID_PROVIDER_NAMES.includes(name as AgentProviderName)
}
