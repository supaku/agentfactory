/**
 * Agent Orchestrator Types
 */

import type { AgentWorkType } from '@supaku/agentfactory-linear'
import type { AgentProvider } from '../providers/types'

/**
 * Result of parsing an agent's output to determine pass/fail
 * Used for QA and acceptance work types to decide status transitions
 */
export type AgentWorkResult = 'passed' | 'failed' | 'unknown'

/**
 * Timeout configuration for a specific work type
 */
export interface WorkTypeTimeoutConfig {
  /** Inactivity timeout in milliseconds for this work type */
  inactivityTimeoutMs?: number
  /** Maximum session duration in milliseconds for this work type */
  maxSessionTimeoutMs?: number
}

export interface OrchestratorConfig {
  /** Agent provider instance. If not provided, resolved via AGENT_PROVIDER env var (default: claude) */
  provider?: AgentProvider
  /** Maximum concurrent agents (default: 3) */
  maxConcurrent?: number
  /** Project name to filter backlog issues */
  project?: string
  /** Base path for git worktrees (default: .worktrees) */
  worktreePath?: string
  /** Linear API key (defaults to LINEAR_API_KEY env var) */
  linearApiKey?: string
  /** Whether to auto-transition issue status (default: true) */
  autoTransition?: boolean
  /**
   * Preserve worktree when PR creation fails for development work types (default: true).
   * When true, worktrees are kept if:
   * - Work type is 'development' or 'inflight' and no PR URL was detected
   * - There are uncommitted changes in the worktree
   * - There are unpushed commits on the branch
   * This prevents data loss when git push or PR creation fails.
   */
  preserveWorkOnPrFailure?: boolean
  /**
   * Enable sandbox mode for spawned agents (default: false).
   *
   * WARNING: Currently defaults to false due to known bugs in Claude Code's sandbox:
   * - https://github.com/anthropics/claude-code/issues/14162 (excludedCommands doesn't bypass network)
   * - https://github.com/anthropics/claude-code/issues/12150 (proxy set for excluded commands)
   *
   * Set to true to re-enable sandbox once these issues are fixed.
   */
  sandboxEnabled?: boolean
  /** Configuration for streaming activities to Linear */
  streamConfig?: OrchestratorStreamConfig
  /**
   * Configuration for proxying activities through the agent API.
   * When set, activities are sent to the API endpoint instead of directly to Linear.
   * This is required for remote workers because Linear's Agent API requires OAuth tokens.
   */
  apiActivityConfig?: {
    /** Base URL of the agent API (e.g., https://agent.supaku.dev) */
    baseUrl: string
    /** API authentication key for the worker */
    apiKey: string
    /** Worker ID for identification */
    workerId: string
  }
  /**
   * Inactivity timeout in milliseconds (default: 300000 = 5 minutes).
   * Agent is stopped if no activity for this duration.
   * Can be overridden per work type via workTypeTimeouts.
   */
  inactivityTimeoutMs?: number
  /**
   * Maximum session duration in milliseconds (default: unlimited).
   * Hard cap on total agent runtime regardless of activity.
   * Can be overridden per work type via workTypeTimeouts.
   */
  maxSessionTimeoutMs?: number
  /**
   * Per-work-type timeout overrides.
   * Different work types (e.g., QA, development) can have different thresholds.
   */
  workTypeTimeouts?: Partial<Record<AgentWorkType, WorkTypeTimeoutConfig>>
}

export interface OrchestratorIssue {
  id: string
  identifier: string
  title: string
  description: string | undefined
  url: string
  priority: number
  labels: string[]
}

export interface AgentProcess {
  issueId: string
  identifier: string
  /** Worktree identifier includes work type suffix (e.g., "SUP-294-QA") */
  worktreeIdentifier: string
  sessionId?: string
  /** Claude CLI session ID for resuming sessions with --resume */
  claudeSessionId?: string
  worktreePath: string
  pid: number | undefined
  status: 'starting' | 'running' | 'completed' | 'failed' | 'stopped' | 'incomplete'
  startedAt: Date
  completedAt?: Date
  exitCode?: number
  error?: Error
  /** Type of work: 'development' or 'qa' */
  workType?: AgentWorkType
  /** GitHub PR URL if a pull request was created */
  pullRequestUrl?: string
  /** Full completion message from Claude (stored for comment posting) */
  resultMessage?: string
  /** Reason why work was marked incomplete (only set when status is 'incomplete') */
  incompleteReason?: 'no_pr_created' | 'uncommitted_changes' | 'unpushed_commits'
  /** Result of work for QA/acceptance agents (passed/failed/unknown) */
  workResult?: AgentWorkResult
  /** Reason why agent was stopped (only set when status is 'stopped') */
  stopReason?: 'user_request' | 'timeout'
  /** Last activity timestamp for inactivity timeout tracking */
  lastActivityAt: Date
  /** Total cost in USD (accumulated from provider result events) */
  totalCostUsd?: number
  /** Total input tokens used */
  inputTokens?: number
  /** Total output tokens used */
  outputTokens?: number
}

export interface OrchestratorEvents {
  onAgentStart?: (agent: AgentProcess) => void
  onAgentComplete?: (agent: AgentProcess) => void
  onAgentError?: (agent: AgentProcess, error: Error) => void
  onAgentStopped?: (agent: AgentProcess) => void
  /** Called when agent work is incomplete (no PR, uncommitted changes, etc.) */
  onAgentIncomplete?: (agent: AgentProcess) => void
  onIssueSelected?: (issue: OrchestratorIssue) => void
  /** Called when Claude session ID is captured from init event */
  onClaudeSessionId?: (linearSessionId: string, claudeSessionId: string) => void | Promise<void>
  /** Called when an activity is emitted for an agent (used for timeout tracking) */
  onActivityEmitted?: (agent: AgentProcess, activityType: string) => void
}

export interface SpawnAgentOptions {
  issueId: string
  identifier: string
  /** Worktree identifier with work type suffix (e.g., "SUP-294-QA") */
  worktreeIdentifier: string
  sessionId?: string
  worktreePath: string
  /** Enable streaming activities to Linear (default: true when sessionId is provided) */
  streamActivities?: boolean
  /** Type of work: determines prompt and agent routing (defaults to 'development') */
  workType?: AgentWorkType
  /** Custom prompt override. If not provided, generates prompt based on workType */
  prompt?: string
}

export interface OrchestratorStreamConfig {
  /** Minimum interval between activities in ms (default: 500ms) */
  minInterval?: number
  /** Maximum length for tool outputs before truncation (default: 2000) */
  maxOutputLength?: number
  /** Whether to include timestamps in activities (default: false) */
  includeTimestamps?: boolean
}

export interface OrchestratorResult {
  success: boolean
  agents: AgentProcess[]
  errors: Array<{ issueId: string; error: Error }>
}

export interface StopAgentResult {
  stopped: boolean
  reason?: 'not_found' | 'already_stopped' | 'signal_failed'
  agent?: AgentProcess
}

export interface ForwardPromptResult {
  forwarded: boolean
  resumed: boolean
  /** True if message was injected into running session (no restart needed) */
  injected?: boolean
  reason?: 'not_found' | 'spawn_failed' | 'no_worktree'
  agent?: AgentProcess
  error?: Error
}

export interface InjectMessageResult {
  /** True if message was successfully injected into running session */
  injected: boolean
  reason?: 'not_running' | 'no_query' | 'injection_failed'
  error?: Error
}

export interface SpawnAgentWithResumeOptions {
  issueId: string
  identifier: string
  /** Worktree identifier with work type suffix (e.g., "SUP-294-QA") */
  worktreeIdentifier: string
  sessionId: string
  worktreePath: string
  prompt: string
  claudeSessionId?: string
  /** Type of work: determines transitions and agent behavior (defaults to 'development') */
  workType?: AgentWorkType
}
