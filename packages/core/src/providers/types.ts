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
export type AgentProviderName = 'claude' | 'codex' | 'amp'

/**
 * Agent Provider
 *
 * Each provider implements spawn/resume to create an AgentHandle
 * that streams normalized AgentEvents.
 */
export interface AgentProvider {
  /** Provider identifier */
  readonly name: AgentProviderName

  /** Spawn a new agent session */
  spawn(config: AgentSpawnConfig): AgentHandle

  /** Resume a previously interrupted session */
  resume(sessionId: string, config: AgentSpawnConfig): AgentHandle
}

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
   * Tools to auto-allow without prompting for permission.
   * Supports glob patterns (e.g., 'Bash(pnpm *)').
   * When omitted the provider may supply defaults for autonomous agents.
   */
  allowedTools?: string[]
  /**
   * Callback to capture PID when the agent process is spawned.
   * Providers call this once the underlying process is created.
   */
  onProcessSpawned?: (pid: number | undefined) => void
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
  totalCostUsd?: number
  numTurns?: number
}
