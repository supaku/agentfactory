/**
 * Agent Provider Factory
 *
 * Creates provider instances based on name.
 * Supports provider selection via env vars, config, labels, and mentions.
 *
 * Resolution order (highest → lowest):
 * 1. Issue label override (provider:codex)
 * 2. Mention context override ("use codex", "@codex")
 * 3. Config providers.byWorkType
 * 4. Config providers.byProject
 * 5. Env var AGENT_PROVIDER_{WORKTYPE}
 * 6. Env var AGENT_PROVIDER_{PROJECT}
 * 7. Config providers.default
 * 8. Env var AGENT_PROVIDER
 * 9. Hardcoded 'claude'
 */

export type { AgentProviderName, AgentProvider, AgentSpawnConfig, AgentHandle, AgentEvent } from './types.js'
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
} from './types.js'

export { ClaudeProvider, createClaudeProvider } from './claude-provider.js'
export { CodexProvider, createCodexProvider } from './codex-provider.js'
export { AmpProvider, createAmpProvider } from './amp-provider.js'
export { SpringAiProvider, createSpringAiProvider } from './spring-ai-provider.js'
export { A2aProvider, createA2aProvider } from './a2a-provider.js'

import type { AgentProvider, AgentProviderName } from './types.js'
import { ClaudeProvider } from './claude-provider.js'
import { CodexProvider } from './codex-provider.js'
import { AmpProvider } from './amp-provider.js'
import { SpringAiProvider } from './spring-ai-provider.js'
import { A2aProvider } from './a2a-provider.js'

// ---------------------------------------------------------------------------
// Provider config types (used by .agentfactory/config.yaml)
// ---------------------------------------------------------------------------

/** Provider configuration from .agentfactory/config.yaml */
export interface ProvidersConfig {
  /** Default provider for all agents */
  default?: AgentProviderName
  /** Provider overrides by work type (e.g., { qa: 'codex' }) */
  byWorkType?: Record<string, AgentProviderName>
  /** Provider overrides by project name (e.g., { Social: 'codex' }) */
  byProject?: Record<string, AgentProviderName>
}

/** Context for resolving which provider to use for a specific spawn */
export interface ProviderResolutionContext {
  /** Project name (e.g., "Social") */
  project?: string
  /** Work type (e.g., "qa", "development") */
  workType?: string
  /** Issue labels (scanned for "provider:<name>") */
  labels?: string[]
  /** Mention text (scanned for "use <provider>", "@<provider>", "provider:<provider>") */
  mentionContext?: string
  /** Config-driven provider settings from .agentfactory/config.yaml */
  configProviders?: ProvidersConfig
}

/** Result of provider resolution with source for logging */
export interface ProviderResolutionResult {
  name: AgentProviderName
  source: string
}

// ---------------------------------------------------------------------------
// Aliases — friendly names that map to real provider names
// ---------------------------------------------------------------------------

export const PROVIDER_ALIASES: Record<string, AgentProviderName> = {
  opus: 'claude',
  sonnet: 'claude',
  codex: 'codex',
  gemini: 'a2a',
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

/**
 * Create a provider instance by name.
 *
 * @param name - Provider name ('claude', 'codex', 'amp', 'spring-ai', 'a2a')
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
    case 'spring-ai':
      return new SpringAiProvider()
    case 'a2a':
      return new A2aProvider()
    default:
      throw new Error(
        `Unknown agent provider: ${name}. Supported: claude, codex, amp, spring-ai, a2a. ` +
        `If this is a CLI tool, ensure the binary is installed and on your PATH.`
      )
  }
}

// ---------------------------------------------------------------------------
// Label & mention extraction
// ---------------------------------------------------------------------------

/**
 * Extract provider name from issue labels.
 * Looks for labels matching "provider:<name>" pattern.
 */
export function extractProviderFromLabels(labels: string[]): AgentProviderName | null {
  for (const label of labels) {
    const match = label.match(/^provider:(\S+)$/i)
    if (match) {
      const resolved = resolveAlias(match[1])
      if (resolved && isValidProviderName(resolved)) {
        return resolved
      }
    }
  }
  return null
}

/**
 * Extract provider name from mention/prompt context text.
 * Matches: "use <provider>", "@<provider>", "provider:<provider>"
 * Case-insensitive, word-boundary aware.
 */
export function extractProviderFromMention(text: string): AgentProviderName | null {
  // Pattern 1: "use <provider>" (with word boundary to avoid "don't use")
  const useMatch = text.match(/\buse\s+(\w[\w-]*)/i)
  if (useMatch) {
    const resolved = resolveAlias(useMatch[1])
    if (resolved && isValidProviderName(resolved)) {
      return resolved
    }
  }

  // Pattern 2: "@<provider>"
  const atMatch = text.match(/@(\w[\w-]*)/i)
  if (atMatch) {
    const resolved = resolveAlias(atMatch[1])
    if (resolved && isValidProviderName(resolved)) {
      return resolved
    }
  }

  // Pattern 3: "provider:<provider>"
  const providerMatch = text.match(/\bprovider:(\w[\w-]*)/i)
  if (providerMatch) {
    const resolved = resolveAlias(providerMatch[1])
    if (resolved && isValidProviderName(resolved)) {
      return resolved
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

/**
 * Resolve which provider to use with full priority cascade.
 *
 * Resolution order (highest → lowest):
 * 1. Issue label override (provider:codex)
 * 2. Mention context override ("use codex", "@codex")
 * 3. Config providers.byWorkType
 * 4. Config providers.byProject
 * 5. Env var AGENT_PROVIDER_{WORKTYPE}
 * 6. Env var AGENT_PROVIDER_{PROJECT}
 * 7. Config providers.default
 * 8. Env var AGENT_PROVIDER
 * 9. Hardcoded 'claude'
 *
 * @param context - Full resolution context (backwards-compatible with old { project, workType } shape)
 * @returns The resolved provider name and its source
 */
export function resolveProviderWithSource(context?: ProviderResolutionContext): ProviderResolutionResult {
  // 1. Issue label override
  if (context?.labels?.length) {
    const fromLabel = extractProviderFromLabels(context.labels)
    if (fromLabel) {
      return { name: fromLabel, source: `label provider:${fromLabel}` }
    }
  }

  // 2. Mention context override
  if (context?.mentionContext) {
    const fromMention = extractProviderFromMention(context.mentionContext)
    if (fromMention) {
      return { name: fromMention, source: `mention "${context.mentionContext.substring(0, 30)}"` }
    }
  }

  // 3. Config byWorkType
  if (context?.workType && context?.configProviders?.byWorkType) {
    const configWorkType = context.configProviders.byWorkType[context.workType]
    if (configWorkType && isValidProviderName(configWorkType)) {
      return { name: configWorkType, source: `config providers.byWorkType.${context.workType}` }
    }
  }

  // 4. Config byProject
  if (context?.project && context?.configProviders?.byProject) {
    const configProject = context.configProviders.byProject[context.project]
    if (configProject && isValidProviderName(configProject)) {
      return { name: configProject, source: `config providers.byProject.${context.project}` }
    }
  }

  // 5. Env var AGENT_PROVIDER_{WORKTYPE}
  if (context?.workType) {
    const workTypeKey = `AGENT_PROVIDER_${context.workType.toUpperCase().replace(/-/g, '_')}`
    const workTypeProvider = process.env[workTypeKey]
    if (workTypeProvider && isValidProviderName(workTypeProvider)) {
      return { name: workTypeProvider, source: `env ${workTypeKey}` }
    }
  }

  // 6. Env var AGENT_PROVIDER_{PROJECT}
  if (context?.project) {
    const projectKey = `AGENT_PROVIDER_${context.project.toUpperCase()}`
    const projectProvider = process.env[projectKey]
    if (projectProvider && isValidProviderName(projectProvider)) {
      return { name: projectProvider, source: `env ${projectKey}` }
    }
  }

  // 7. Config providers.default
  if (context?.configProviders?.default && isValidProviderName(context.configProviders.default)) {
    return { name: context.configProviders.default, source: 'config providers.default' }
  }

  // 8. Env var AGENT_PROVIDER
  const globalProvider = process.env.AGENT_PROVIDER
  if (globalProvider && isValidProviderName(globalProvider)) {
    return { name: globalProvider, source: 'env AGENT_PROVIDER' }
  }

  // 9. Hardcoded fallback
  return { name: 'claude', source: 'default' }
}

/**
 * Resolve which provider to use based on context.
 * Backwards-compatible wrapper around resolveProviderWithSource().
 *
 * @param options - Project and work type context for resolution
 * @returns The resolved provider name
 */
export function resolveProviderName(options?: ProviderResolutionContext): AgentProviderName {
  return resolveProviderWithSource(options).name
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const VALID_PROVIDER_NAMES: AgentProviderName[] = ['claude', 'codex', 'amp', 'spring-ai', 'a2a']

export function isValidProviderName(name: string): name is AgentProviderName {
  return VALID_PROVIDER_NAMES.includes(name as AgentProviderName)
}

/** Resolve an alias to a canonical provider name, or return the input if not an alias. */
function resolveAlias(name: string): string {
  const lower = name.toLowerCase()
  return PROVIDER_ALIASES[lower] ?? lower
}
