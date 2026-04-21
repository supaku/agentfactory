/**
 * Profile-Based Configuration Types
 *
 * Profiles bundle provider + model + effort + provider-specific config + sub-agent
 * overrides into named units, dispatched by work type and project. This replaces
 * the flat `providers` + `models` config sections that couldn't couple provider
 * and model per work type.
 */

import type { AgentProviderName } from '../providers/index.js'

// ---------------------------------------------------------------------------
// Effort
// ---------------------------------------------------------------------------

/** Normalized effort levels (provider-agnostic) */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh'

// ---------------------------------------------------------------------------
// Profile Config (YAML shape)
// ---------------------------------------------------------------------------

/** Sub-agent configuration within a profile */
export interface SubAgentProfileConfig {
  /** Override provider for sub-agents (defaults to parent profile's provider) */
  provider?: AgentProviderName
  /** Model ID for sub-agents */
  model?: string
  /** Effort level for sub-agents */
  effort?: EffortLevel
}

/** A named profile definition from config.yaml */
export interface ProfileConfig {
  /** Provider to use for this profile */
  provider: AgentProviderName
  /** Model ID (free-form string, e.g., 'gpt-5.4', 'claude-opus-4-7') */
  model?: string
  /** Normalized effort level */
  effort?: EffortLevel
  /** Sub-agent overrides for coordinators */
  subAgent?: SubAgentProfileConfig
  /** OpenAI-specific config (e.g., { serviceTier: 'fast', reasoningSummary: 'concise' }) */
  openai?: Record<string, unknown>
  /** Anthropic-specific config (e.g., { speed: 'fast', contextWindow: 1000000 }) */
  anthropic?: Record<string, unknown>
  /** Codex-specific config (e.g., { useAppServer: true }) */
  codex?: Record<string, unknown>
  /** Gemini-specific config (e.g., { thinkingBudget: 32000, temperature: 0.2 }) */
  gemini?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Dispatch Config (YAML shape)
// ---------------------------------------------------------------------------

/** Maps work types and projects to profile names */
export interface DispatchConfig {
  /** Default profile name (required) */
  default: string
  /** Work-type-specific profile overrides */
  byWorkType?: Record<string, string>
  /** Project-specific profile overrides */
  byProject?: Record<string, string>
}

// ---------------------------------------------------------------------------
// Resolved Profile (output of resolution)
// ---------------------------------------------------------------------------

/** Fully resolved spawn parameters from profile resolution */
export interface ResolvedProfile {
  /** Resolved provider name */
  provider: AgentProviderName
  /** Resolved model ID (undefined = use provider default) */
  model?: string
  /** Resolved effort level */
  effort?: EffortLevel
  /** Provider-specific config extracted from the matching provider block */
  providerConfig?: Record<string, unknown>
  /** Resolved sub-agent configuration */
  subAgent?: SubAgentProfileConfig
  /** Source description for logging (e.g., 'profile:codex-dev via dispatch.byWorkType.qa') */
  source: string
}
