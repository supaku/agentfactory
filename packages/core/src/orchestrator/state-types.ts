/**
 * Worktree State Types
 *
 * Types for persisting agent state to the .agent/ directory within each worktree.
 * This enables crash recovery, heartbeat monitoring, and progress tracking.
 */

import type { AgentWorkType } from '@supaku/agentfactory-linear'

/**
 * Status of the agent's work in the worktree
 */
export type WorktreeStatus =
  | 'initializing' // Agent is starting up
  | 'running' // Agent is actively working
  | 'completing' // Agent is finishing up (e.g., committing, creating PR)
  | 'completed' // Agent finished successfully
  | 'failed' // Agent encountered an error
  | 'stopped' // Agent was stopped (by user request or timeout)

/**
 * Primary state file for the worktree
 * Stored at: .agent/state.json
 */
export interface WorktreeState {
  /** Linear issue ID (UUID) */
  issueId: string
  /** Human-readable issue identifier (e.g., SUP-123) */
  issueIdentifier: string
  /** Linear AgentSession ID (if available) */
  linearSessionId: string | null
  /** Claude CLI session ID for --resume (if available) */
  claudeSessionId: string | null
  /** Type of work being performed */
  workType: AgentWorkType
  /** The prompt that was given to the agent */
  prompt: string
  /** Unix timestamp when work started */
  startedAt: number
  /** Current status of the work */
  status: WorktreeStatus
  /** Human-readable description of current activity */
  currentPhase: string | null
  /** Unix timestamp of last state update */
  lastUpdatedAt: number
  /** Number of times recovery has been attempted */
  recoveryAttempts: number
  /** Worker ID if running on a remote worker */
  workerId: string | null
  /** Process ID of the agent */
  pid: number | null
  /** Error message if status is 'failed' */
  errorMessage?: string
  /** PR URL if one was created */
  pullRequestUrl?: string
  /**
   * Claude Code Task List ID for intra-session task coordination
   * Format: {issueIdentifier}-{WORKTYPE} (e.g., "SUP-123-DEV")
   * Enables task persistence across crashes and subagent coordination
   */
  taskListId?: string
}

/**
 * Activity type for heartbeat tracking
 */
export type HeartbeatActivityType =
  | 'tool_use' // Agent is using a tool
  | 'thinking' // Agent is processing/generating
  | 'waiting' // Agent is waiting for something (e.g., API response)
  | 'idle' // Agent appears idle (may indicate a problem)

/**
 * Heartbeat state file for liveness detection
 * Stored at: .agent/heartbeat.json
 * Updated every 10 seconds while the agent is running
 */
export interface HeartbeatState {
  /** Unix timestamp of this heartbeat */
  timestamp: number
  /** Process ID of the agent */
  pid: number
  /** Memory usage in megabytes */
  memoryUsageMB: number
  /** Uptime in seconds since agent started */
  uptime: number
  /** Type of last detected activity */
  lastActivityType: HeartbeatActivityType
  /** Unix timestamp of last activity */
  lastActivityTimestamp: number
  /** Total number of tool calls made so far */
  toolCallsCount: number
  /** Current operation being performed (if any) */
  currentOperation: string | null
}

/**
 * Todo item status (mirrors TodoWrite tool)
 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

/**
 * Todo item (mirrors TodoWrite tool structure)
 */
export interface TodoItem {
  /** Task description (imperative form) */
  content: string
  /** Current status */
  status: TodoStatus
  /** Present continuous form for display */
  activeForm: string
}

/**
 * Persisted todo list state
 * Stored at: .agent/todos.json
 * Synced with TodoWrite tool calls
 */
export interface TodosState {
  /** Unix timestamp of last update */
  updatedAt: number
  /** Current todo items */
  items: TodoItem[]
}

/**
 * Progress log entry type
 */
export type ProgressEventType =
  | 'start' // Agent started
  | 'phase' // Phase/activity changed
  | 'tool' // Tool was called
  | 'error' // Error occurred
  | 'recovery' // Recovery attempt
  | 'complete' // Work completed
  | 'stop' // Agent stopped

/**
 * Progress log entry
 * Appended to: .agent/progress.log
 * Format: timestamp|event_type|details
 */
export interface ProgressLogEntry {
  /** Unix timestamp */
  timestamp: number
  /** Type of event */
  eventType: ProgressEventType
  /** Event details (JSON stringified if object) */
  details: string
}

/**
 * Result of checking for recoverable state in a worktree
 */
export interface RecoveryCheckResult {
  /** Whether recovery is possible */
  canRecover: boolean
  /** Whether an agent is currently alive (heartbeat fresh) */
  agentAlive: boolean
  /** The state if found */
  state?: WorktreeState
  /** The heartbeat if found */
  heartbeat?: HeartbeatState
  /** The todos if found */
  todos?: TodosState
  /** Reason why recovery is not possible */
  reason?: 'no_state' | 'agent_alive' | 'max_attempts' | 'invalid_state'
  /** Human-readable message */
  message: string
}

/**
 * Configuration for heartbeat writer
 */
export interface HeartbeatWriterConfig {
  /** Directory path to write heartbeat to */
  agentDir: string
  /** Process ID of the agent */
  pid: number
  /** Interval between heartbeats in milliseconds (default: 10000) */
  intervalMs?: number
  /** Start time of the agent (for uptime calculation) */
  startTime: number
}

/**
 * Configuration for progress logger
 */
export interface ProgressLoggerConfig {
  /** Directory path to write progress log to */
  agentDir: string
  /** Maximum log file size in bytes before rotation (default: 1MB) */
  maxSizeBytes?: number
}
