/**
 * Fleet Supervisor Types
 *
 * Type definitions for the Erlang-inspired fleet supervision system.
 * Includes supervisor hierarchy, three-probe health model, stuck
 * worker detection, and remediation action types.
 */

import type { AgentSessionState } from './session-storage.js'
import type { WorkerInfo } from './worker-storage.js'

// ---------------------------------------------------------------------------
// Supervisor Hierarchy
// ---------------------------------------------------------------------------

/**
 * Restart strategy for a supervisor (Erlang-inspired).
 *
 * - one-for-one: Only restart the failed worker
 * - one-for-all: Restart all workers when one fails
 * - rest-for-one: Restart the failed worker and all started after it
 */
export type RestartStrategy = 'one-for-one' | 'one-for-all' | 'rest-for-one'

/**
 * Supervisor node state stored in Redis.
 * One per logical fleet instance.
 *
 * Redis key: sup:supervisor:{supervisorId}
 * TTL: 1 hour (refreshed each patrol cycle)
 */
export interface SupervisorState {
  supervisorId: string
  restartStrategy: RestartStrategy
  workerIds: string[]
  lastPatrolAt: number
  patrolIntervalMs: number
  totalPatrols: number
  totalRemediations: number
  startedAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Three-Probe Health Model (K8s-inspired)
// ---------------------------------------------------------------------------

/**
 * Health probe result for a single check.
 */
export interface ProbeResult {
  ok: boolean
  reason?: string
  checkedAt: number
}

/**
 * Combined health status from all three probes.
 *
 * - liveness:  Is the worker process alive? (heartbeat fresh, Redis key exists)
 * - readiness: Can the worker accept new work? (not draining, has capacity)
 * - startup:   Has the worker completed initialization? (registered, first heartbeat received)
 */
export interface WorkerHealthStatus {
  workerId: string
  liveness: ProbeResult
  readiness: ProbeResult
  startup: ProbeResult
  healthy: boolean
  grade: 'green' | 'yellow' | 'red'
}

// ---------------------------------------------------------------------------
// Stuck Worker Detection
// ---------------------------------------------------------------------------

/**
 * Stuck signals detected for a session.
 */
export interface StuckSignals {
  /** Session has been running longer than expected */
  sessionRunningTooLong: boolean
  /** Worker heartbeat is stale but not yet dead */
  heartbeatStale: boolean
  /** Session has been in 'claimed' status too long without transitioning to 'running' */
  claimStuck: boolean
  /** Same tool has been called continuously for too long */
  toolLoopStuck: boolean
  /** Whether activity has resumed after the last nudge */
  activityResumedAfterNudge?: boolean
  /** How long the situation has persisted (ms) */
  stuckDurationMs: number
  /** Whether any signal is active */
  isStuck: boolean
}

/**
 * Remediation actions in the stuck worker decision tree.
 *
 * NUDGE:    Signal worker to report status (max 2)
 * RESTART:  Deregister worker, re-queue work (max 3)
 * REASSIGN: Move session to a different worker (max 1)
 * ESCALATE: Terminal — requires human intervention
 */
export type RemediationAction = 'nudge' | 'restart' | 'reassign' | 'escalate'

/**
 * Full remediation decision for a stuck session.
 */
export interface RemediationDecision {
  sessionId: string
  workerId: string
  action: RemediationAction
  reason: string
  attemptNumber: number
  maxAttempts: number
}

/**
 * Remediation history for a single session, stored in Redis.
 * Tracks all attempted remediation actions.
 *
 * Redis key: sup:remediation:{sessionId}
 * TTL: 24 hours (matches session TTL)
 */
export interface RemediationRecord {
  sessionId: string
  issueId: string
  issueIdentifier: string
  nudgeCount: number
  nudgeTimestamps: number[]
  restartCount: number
  restartTimestamps: number[]
  reassignCount: number
  reassignTimestamps: number[]
  escalated: boolean
  escalatedAt?: number
  firstDetectedAt: number
  lastActionAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Nudge Prompt Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for nudge prompt messages per work type.
 */
export interface NudgePromptConfig {
  /** Default prompt when work type is not configured */
  defaultPrompt: string
  /** Work-type-specific prompts */
  prompts?: Record<string, string>
}

export const DEFAULT_NUDGE_PROMPTS: Record<string, string> = {
  default: 'You appear to be stuck in a loop calling the same tool repeatedly. Please step back, reassess your approach, and try a different strategy to make progress.',
  development: "You've been calling the same tool repeatedly for an extended period. Please pause, review what you've accomplished so far, and consider an alternative approach to complete the task.",
  review: 'You appear stuck reviewing the same area repeatedly. Please summarize your findings so far and move to the next review item.',
}

// ---------------------------------------------------------------------------
// Stuck Worker Decision Tree Configuration
// ---------------------------------------------------------------------------

/**
 * Configurable budgets and timeouts for the stuck worker decision tree.
 */
export interface StuckDetectionConfig {
  /** Max time a session can be in 'running' status before considered stuck (ms) */
  maxRunningDurationMs: number
  /** Max time a session can be in 'claimed' status before considered claim-stuck (ms) */
  maxClaimDurationMs: number
  /** Heartbeat staleness threshold before triggering yellow (ms) */
  heartbeatYellowThresholdMs: number
  /** Maximum nudge attempts before escalating to restart */
  maxNudges: number
  /** Maximum restart attempts before escalating to reassign */
  maxRestarts: number
  /** Maximum reassign attempts before escalating to human */
  maxReassigns: number
  /** Cooldown between remediation attempts of the same type (ms) */
  remediationCooldownMs: number
  /** Total max time before forced escalation regardless of budgets (ms) */
  maxTotalRemediationMs: number
  /** Max time same tool can be called continuously before considered stuck (ms) */
  maxSameToolDurationMs: number
  /** Time to wait after nudge before checking effectiveness (ms) */
  nudgeEffectivenessTimeoutMs: number
  /** Nudge prompt configuration per work type */
  nudgePrompts?: NudgePromptConfig
}

export const DEFAULT_STUCK_DETECTION_CONFIG: StuckDetectionConfig = {
  maxRunningDurationMs: 45 * 60_000,
  maxClaimDurationMs: 5 * 60_000,
  heartbeatYellowThresholdMs: 90_000,
  maxNudges: 2,
  maxRestarts: 3,
  maxReassigns: 1,
  remediationCooldownMs: 5 * 60_000,
  maxTotalRemediationMs: 45 * 60_000,
  maxSameToolDurationMs: 10 * 60_000,  // 10 minutes
  nudgeEffectivenessTimeoutMs: 3 * 60_000,  // 3 minutes
}

// ---------------------------------------------------------------------------
// Patrol Loop Types
// ---------------------------------------------------------------------------

/**
 * Configuration for the unified patrol loop.
 */
export interface PatrolConfig {
  /** Patrol interval in milliseconds */
  intervalMs: number
  /** Stuck detection configuration */
  stuckDetection: StuckDetectionConfig
  /** Whether to run orphan cleanup as part of patrol */
  enableOrphanCleanup: boolean
  /** Whether to run stuck detection */
  enableStuckDetection: boolean
  /** Whether to run health probes */
  enableHealthProbes: boolean
}

export const DEFAULT_PATROL_CONFIG: PatrolConfig = {
  intervalMs: 30_000,
  stuckDetection: DEFAULT_STUCK_DETECTION_CONFIG,
  enableOrphanCleanup: true,
  enableStuckDetection: true,
  enableHealthProbes: true,
}

/**
 * Result of a single patrol pass.
 */
export interface PatrolResult {
  patrolledAt: number
  workersChecked: number
  sessionsChecked: number
  workerHealth: WorkerHealthStatus[]
  stuckSessions: Array<{
    sessionId: string
    workerId: string
    signals: StuckSignals
  }>
  remediations: RemediationDecision[]
  orphanCleanupResult?: {
    orphaned: number
    requeued: number
  }
  errors: Array<{ context: string; error: string }>
}

/**
 * Callbacks for patrol events, enabling external integrations
 * (e.g., Linear comments, Slack notifications, metrics).
 */
export interface PatrolCallbacks {
  onWorkerUnhealthy?: (health: WorkerHealthStatus) => Promise<void>
  onStuckDetected?: (sessionId: string, signals: StuckSignals) => Promise<void>
  onRemediation?: (decision: RemediationDecision) => Promise<void>
  onEscalation?: (decision: RemediationDecision) => Promise<void>
  onPatrolComplete?: (result: PatrolResult) => Promise<void>
}

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export type { AgentSessionState, WorkerInfo }
