/**
 * Platform-Agnostic Work Types
 *
 * Core-owned types for agent work type routing, status mappings,
 * and environment issue tracking. These replace direct imports from
 * the Linear package, enabling core to remain platform-independent.
 */

/**
 * Agent work type — determines prompt template, status transitions,
 * and whether a git worktree is needed.
 */
export type AgentWorkType =
  | 'research'
  | 'backlog-creation'
  | 'backlog-groomer'       // PM agent: scan icebox, decide discard/refine/escalate-human
  | 'development'
  | 'inflight'
  | 'qa'
  | 'acceptance'
  | 'refinement'
  | 'refinement-coordination'
  | 'merge'                 // Merge queue: handle PR merge operations
  | 'security'              // Security scanning: SAST, dependency audit
  | 'improvement-loop'      // PM Agent: identify systemic patterns, author meta-issues (REN-1299)
  | 'outcome-auditor'       // PM agent: audit accepted issues for delivery gaps, author follow-up issues (REN-1297)
  | 'ga-readiness'          // PM agent: assess feature GA readiness before production promotion (REN-1327)

/**
 * Workflow status — platform-agnostic string (e.g., 'Started', 'Finished').
 * Concrete values are defined by the issue tracker plugin.
 */
export type WorkflowStatus = string

/**
 * Status mapping configuration injected by the issue tracker plugin.
 * Maps between issue statuses and agent work types.
 */
export interface WorkTypeStatusMappings {
  /** Map issue status name → work type (e.g., 'Backlog' → 'development') */
  statusToWorkType: Record<string, AgentWorkType>
  /** Map work type → status to set when agent starts (null = no transition) */
  workTypeStartStatus: Record<AgentWorkType, string | null>
  /** Map work type → status to set when agent completes successfully */
  workTypeCompleteStatus: Record<AgentWorkType, string | null>
  /** Map work type → status to set when agent fails */
  workTypeFailStatus: Record<AgentWorkType, string | null>
  /** Statuses that indicate an issue is terminal (no further work) */
  terminalStatuses: readonly string[]
  /** Work types that require a git worktree */
  workTypesRequiringWorktree: ReadonlySet<AgentWorkType>
}

/**
 * Environment issue type constants for categorizing agent environment problems.
 */
export const ENVIRONMENT_ISSUE_TYPES = {
  PERMISSION: 'permission',
  NETWORK: 'network',
  SANDBOX: 'sandbox',
  LINEAR_CLI: 'linear-cli',
  DEPENDENCY: 'dependency',
  TIMEOUT: 'timeout',
  TOOL: 'tool',
  HUMAN_BLOCKER: 'human-blocker',
} as const

export type EnvironmentIssueType =
  (typeof ENVIRONMENT_ISSUE_TYPES)[keyof typeof ENVIRONMENT_ISSUE_TYPES]
