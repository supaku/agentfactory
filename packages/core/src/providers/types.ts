/**
 * Agent Provider Interface
 *
 * Abstracts the underlying agent SDK (Claude, Codex, Amp, etc.)
 * so the orchestrator is provider-agnostic.
 *
 * All three providers follow the same pattern:
 * 1. Initialize with config + working directory
 * 2. Send a prompt
 * 3. Iterate over a stream of events
 * 4. Get a final result with cost/token data
 */

/** Supported agent provider names */
export type AgentProviderName = 'claude' | 'codex' | 'amp' | 'spring-ai' | 'a2a'

/**
 * Agent Provider
 *
 * Each provider implements spawn/resume to create an AgentHandle
 * that streams normalized AgentEvents.
 */
/**
 * Provider capability flags.
 *
 * The orchestrator uses these to choose the right exit-gate strategy
 * without try-catching on unsupported operations:
 * - Providers with `supportsMessageInjection` get mid-session stop hooks
 * - All providers get the post-session backstop (provider-agnostic)
 * - Providers with `supportsSessionResume` get stop → resume as fallback
 */
export type ToolPermissionFormat = 'claude' | 'codex' | 'spring-ai'

export interface AgentProviderCapabilities {
  /** Whether injectMessage() works (stateful providers: Claude, A2A) */
  supportsMessageInjection: boolean
  /** Whether resume() can continue a prior session */
  supportsSessionResume: boolean
  /** Provider can use MCP tool plugins delivered via stdio servers (af_linear_*, af_code_*) */
  supportsToolPlugins?: boolean
  /** Provider needs persistent base instructions via AgentSpawnConfig.baseInstructions */
  needsBaseInstructions?: boolean
  /** Provider needs structured permission config via AgentSpawnConfig.permissionConfig */
  needsPermissionConfig?: boolean
  /** Provider supports canUseTool-style code intelligence enforcement */
  supportsCodeIntelligenceEnforcement?: boolean
  /** Tool permission format this provider uses (default: 'claude') */
  toolPermissionFormat?: ToolPermissionFormat
  /**
   * Whether the provider emits Anthropic-style subagent events (e.g. Task tool
   * progress events). Used by the Topology view to decide whether to render
   * the subagent event stream. Only true for the Claude provider because the
   * Anthropic Task tool fires provider-specific sub-agent lifecycle events.
   * Codex and Spring AI have no equivalent emission today.
   */
  emitsSubagentEvents: boolean
  /**
   * Human-readable label for this provider family. Used in UI and log
   * messages where the raw provider name ('spring-ai') is not user-friendly.
   * Companion to the AgentRuntimeProvider alias for corpus documentation.
   */
  humanLabel?: string
}

/**
 * Human-readable label registry for every AgentRuntimeProvider family.
 * Keyed by AgentProviderName. Populated by each provider's declared
 * capabilities.humanLabel; this map is the single source of truth for
 * display names used in the Topology view and log messages.
 */
export const AGENT_RUNTIME_PROVIDER_HUMAN_LABELS: Readonly<Record<AgentProviderName, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  amp: 'Amp',
  'spring-ai': 'Spring AI',
  a2a: 'A2A',
} as const

export interface AgentProvider {
  /** Provider identifier */
  readonly name: AgentProviderName

  /** Provider capability flags for orchestrator routing */
  readonly capabilities: AgentProviderCapabilities

  /** Spawn a new agent session */
  spawn(config: AgentSpawnConfig): AgentHandle

  /** Resume a previously interrupted session */
  resume(sessionId: string, config: AgentSpawnConfig): AgentHandle

  /**
   * Gracefully shut down provider resources (e.g., long-lived child processes).
   * Called by the orchestrator on fleet shutdown. Optional — providers with
   * per-agent child processes (Claude) don't need this.
   */
  shutdown?(): Promise<void>
}

/**
 * AgentRuntimeProvider — corpus alias for AgentProvider.
 *
 * ADR-2026-04-27 introduces "AgentRuntimeProvider" as the 8th plugin-family
 * name in the corpus (documentation, architecture diagrams, Linear labels).
 * The implementation type stays AgentProvider. This alias lets callers use
 * the new corpus name in type annotations without a breaking rename.
 *
 * @example
 *   // Both are equivalent; prefer AgentRuntimeProvider in new code per ADR.
 *   const p: AgentRuntimeProvider = new ClaudeProvider()
 *   const q: AgentProvider        = new ClaudeProvider()
 */
export type AgentRuntimeProvider = AgentProvider

/**
 * Configuration passed to a provider when spawning an agent.
 * Provider implementations translate these to SDK-specific options.
 */
export interface AgentSpawnConfig {
  /** The prompt/instruction for the agent */
  prompt: string
  /** Working directory for the agent */
  cwd: string
  /** Environment variables to pass to the agent process */
  env: Record<string, string>
  /** AbortController for cancellation support */
  abortController: AbortController
  /** Whether agent runs in autonomous mode (no user input) */
  autonomous: boolean
  /** Sandbox level for filesystem/network restrictions */
  sandboxEnabled: boolean
  /**
   * Codex-specific sandbox level override. When set, takes precedence over sandboxEnabled.
   * Maps to Codex sandbox policies: readOnly, workspaceWrite, dangerFullAccess.
   */
  sandboxLevel?: 'read-only' | 'workspace-write' | 'full-access'
  /**
   * Tools to auto-allow without prompting for permission.
   * Uses Claude Code permission pattern format: 'Bash(prefix:glob)'.
   * Examples: 'Bash(pnpm:*)', 'Bash(git commit:*)'.
   * When omitted the provider may supply defaults for autonomous agents.
   */
  allowedTools?: string[]
  /**
   * Callback to capture PID when the agent process is spawned.
   * Providers call this once the underlying process is created.
   */
  onProcessSpawned?: (pid: number | undefined) => void
  /**
   * Fully-qualified MCP tool names (e.g. 'mcp__af-code-intelligence__af_code_get_repo_map').
   * Added to the allowedTools list so autonomous agents can use MCP tools.
   */
  mcpToolNames?: string[]
  /**
   * Maximum number of agentic turns (API round-trips) before stopping.
   * Coordinators need more turns than standard agents since they poll sub-agent status.
   * When omitted, the provider's default applies.
   */
  maxTurns?: number
  /**
   * Stdio MCP server configurations for Codex provider (SUP-1744).
   * Created by ToolRegistry.createStdioServerConfigs() from registered plugins.
   * Passed to Codex app-server via config/batchWrite so it can spawn and
   * connect to these tool servers.
   */
  mcpStdioServers?: Array<{
    name: string
    command: string
    args: string[]
    env?: Record<string, string>
  }>
  /**
   * Persistent system instructions for Codex App Server (SUP-1746).
   * Passed via `instructions` on `thread/start`. Contains safety rules,
   * project instructions (AGENTS.md), and work-type context.
   * Separate from `prompt` which contains only the task-specific directive.
   */
  baseInstructions?: string
  /**
   * Structured permission config for Codex approval bridge (SUP-1748).
   * Translates template `tools.allow` / `tools.disallow` into patterns
   * consumed by the approval bridge for runtime tool evaluation.
   */
  permissionConfig?: import('../templates/adapters.js').CodexPermissionConfig
  /**
   * Code intelligence enforcement config.
   * When set, the provider's canUseTool callback redirects Grep/Glob
   * calls to af_code_* tools until the agent has attempted code intelligence.
   */
  codeIntelligenceEnforcement?: {
    enforceUsage: boolean
    fallbackAfterAttempt: boolean
  }
  /**
   * Custom instructions to append to the system prompt.
   * Sourced from RepositoryConfig.systemPrompt (append + byWorkType merged).
   * Appended after standard instruction sections and before AGENTS.md/CLAUDE.md.
   */
  systemPromptAppend?: string
  /**
   * Model identifier to use for the agent session.
   * When omitted, the provider resolves the model from environment variables or defaults.
   */
  model?: string
  /**
   * Normalized effort level for reasoning depth.
   * Providers map this to their specific mechanism:
   * - Claude: effort level string
   * - Codex/OpenAI: reasoning_effort
   * - Gemini: thinkingBudget
   */
  effort?: import('../config/profiles.js').EffortLevel
  /**
   * Provider-specific configuration from the matched profile block.
   * Contains settings like { serviceTier: 'fast' } for OpenAI or
   * { speed: 'fast' } for Anthropic.
   */
  providerConfig?: Record<string, unknown>
  /**
   * Provider name for sub-agents when different from the parent agent's provider.
   * Used by coordination templates to instruct sub-agents.
   */
  subAgentProvider?: import('../providers/index.js').AgentProviderName
}

/**
 * Handle to a running agent session.
 * Returned by AgentProvider.spawn() and AgentProvider.resume().
 */
export interface AgentHandle {
  /** Provider-specific session/thread ID (available after init event) */
  sessionId: string | null
  /** Async iterable stream of normalized events */
  stream: AsyncIterable<AgentEvent>
  /**
   * Inject a follow-up user message into the running session.
   * Used for user prompts without restarting the agent.
   */
  injectMessage(text: string): Promise<void>
  /**
   * Stop the agent. Delegates to the provider's abort mechanism.
   */
  stop(): Promise<void>
}

/**
 * Normalized agent event.
 * Each provider maps its native events to this common format.
 */
export type AgentEvent =
  | AgentInitEvent
  | AgentSystemEvent
  | AgentAssistantTextEvent
  | AgentToolUseEvent
  | AgentToolResultEvent
  | AgentToolProgressEvent
  | AgentResultEvent
  | AgentErrorEvent

/** Agent initialized — contains session ID for resume */
export interface AgentInitEvent {
  type: 'init'
  sessionId: string
  raw: unknown
}

/** System-level event (status changes, compaction, etc.) */
export interface AgentSystemEvent {
  type: 'system'
  subtype: string
  message?: string
  raw: unknown
}

/** Assistant text output */
export interface AgentAssistantTextEvent {
  type: 'assistant_text'
  text: string
  raw: unknown
}

/** Agent is invoking a tool */
export interface AgentToolUseEvent {
  type: 'tool_use'
  toolName: string
  toolUseId?: string
  input: Record<string, unknown>
  toolCategory?: import('../tools/tool-category.js').ToolCategory
  raw: unknown
}

/** Tool execution result */
export interface AgentToolResultEvent {
  type: 'tool_result'
  toolName?: string
  toolUseId?: string
  content: string
  isError: boolean
  raw: unknown
}

/** Tool execution progress update */
export interface AgentToolProgressEvent {
  type: 'tool_progress'
  toolName: string
  elapsedSeconds: number
  raw: unknown
}

/** Final result — agent has finished */
export interface AgentResultEvent {
  type: 'result'
  success: boolean
  /** Completion message (only on success) */
  message?: string
  /** Error messages (only on failure) */
  errors?: string[]
  /** Error subtype from the provider (e.g., 'error_during_execution', 'error_max_turns') */
  errorSubtype?: string
  /** Cost/usage data */
  cost?: AgentCostData
  raw: unknown
}

/** Error event */
export interface AgentErrorEvent {
  type: 'error'
  message: string
  code?: string
  raw: unknown
}

/** Cost and token usage data */
export interface AgentCostData {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  totalCostUsd?: number
  numTurns?: number
}
