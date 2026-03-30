/**
 * Decision Engine
 *
 * Pure function that determines what action the Governor should take for a
 * given issue. No side effects, no I/O — just decision logic.
 *
 * The decision tree evaluates issues based on their current status, override
 * state, active sessions, cooldowns, and configuration flags.
 */

import type { GovernorAction, GovernorConfig, GovernorIssue } from './governor-types.js'
import {
  determineTopOfFunnelAction,
  DEFAULT_TOP_OF_FUNNEL_CONFIG,
  type TopOfFunnelConfig,
} from './top-of-funnel.js'
import type { WorkflowRegistry } from '../workflow/workflow-registry.js'
import { evaluateTransitions } from '../workflow/transition-engine.js'
import type { GateEvaluationResult } from '../workflow/gates/gate-evaluator.js'

// ---------------------------------------------------------------------------
// Decision Context
// ---------------------------------------------------------------------------

/**
 * All external state the Governor gathers before asking the decision engine
 * what to do. Callers are responsible for populating this context; the
 * decision engine itself never performs I/O.
 */
export interface DecisionContext {
  issue: GovernorIssue
  config: GovernorConfig
  hasActiveSession: boolean
  isHeld: boolean
  isWithinCooldown: boolean
  isParentIssue: boolean
  workflowStrategy?: string
  researchCompleted: boolean
  backlogCreationCompleted: boolean
  /** Number of completed agent sessions for this issue (for circuit breaker) */
  completedSessionCount: number
  /**
   * Optional workflow registry for declarative transition routing.
   * When present, the transition engine is used instead of the hard-coded
   * switch statement. Falls back to the switch statement when absent.
   */
  workflowRegistry?: WorkflowRegistry
  /** Gate evaluation result from the gate system (Phase 4) */
  gateEvaluation?: GateEvaluationResult
  /** Whether the merge queue is enabled for this repository */
  mergeQueueEnabled?: boolean
}

/** Max agent sessions before the circuit breaker trips and the issue is held */
export const MAX_SESSION_ATTEMPTS = 3

// ---------------------------------------------------------------------------
// Decision Result
// ---------------------------------------------------------------------------

export interface DecisionResult {
  action: GovernorAction
  reason: string
}

// ---------------------------------------------------------------------------
// Terminal statuses
// ---------------------------------------------------------------------------

/** Statuses where no further agent work is required */
const TERMINAL_STATUSES = new Set(['Accepted', 'Canceled', 'Duplicate'])

// ---------------------------------------------------------------------------
// Decision Function
// ---------------------------------------------------------------------------

/**
 * Determine what action the Governor should take for a single issue.
 *
 * Decision rules (evaluated in order):
 *
 * 1. Skip if active session exists
 * 2. Skip if within cooldown
 * 3. Skip if HOLD override is active
 * 4. Terminal status (Accepted, Canceled, Duplicate) -> none
 * 5. Icebox -> delegate to top-of-funnel (research / backlog-creation)
 * 6. Backlog -> trigger-development (if enabled)
 * 7. Finished -> trigger-qa (if enabled; check escalation)
 * 8. Delivered -> trigger-acceptance (if enabled)
 * 9. Rejected -> trigger-refinement (check strategy for escalation)
 * 10. Unknown status -> none
 */
export function decideAction(ctx: DecisionContext): DecisionResult {
  const { issue, config } = ctx

  // --- Universal skip conditions ---

  if (ctx.hasActiveSession) {
    return { action: 'none', reason: `Issue ${issue.identifier} already has an active agent session` }
  }

  if (ctx.isWithinCooldown) {
    return { action: 'none', reason: `Issue ${issue.identifier} is within cooldown period` }
  }

  if (ctx.isHeld) {
    return { action: 'none', reason: `Issue ${issue.identifier} is held (HOLD override active)` }
  }

  // --- Gate check (Phase 4) ---
  // When the governor has evaluated gates for the current phase and any are
  // unsatisfied, block the transition. The governor populates gateEvaluation
  // via the gate evaluator before calling decideAction().
  if (ctx.gateEvaluation && !ctx.gateEvaluation.allSatisfied) {
    const activeNames = ctx.gateEvaluation.activeGates.map(g => g.gateName).join(', ')
    return {
      action: 'none',
      reason: `Issue ${issue.identifier} has unsatisfied gates: ${activeNames}`,
    }
  }

  // --- Circuit breaker ---
  // Prevent issues from cycling through agents indefinitely.
  // If an issue has had too many sessions without reaching a terminal status,
  // stop dispatching and require manual intervention.
  if (ctx.completedSessionCount >= MAX_SESSION_ATTEMPTS) {
    return {
      action: 'none',
      reason: `Issue ${issue.identifier} has had ${ctx.completedSessionCount} agent sessions without progressing — circuit breaker tripped (max ${MAX_SESSION_ATTEMPTS})`,
    }
  }

  // --- Terminal statuses ---

  if (TERMINAL_STATUSES.has(issue.status)) {
    return { action: 'none', reason: `Issue ${issue.identifier} is in terminal status: ${issue.status}` }
  }

  // --- Sub-issue guard ---
  // Sub-issues are managed exclusively by the coordinator (or qa-coordinator /
  // acceptance-coordinator) via the parent issue. The governor must never
  // dispatch workflows on sub-issues directly, regardless of their status,
  // to prevent duplicate work.
  if (issue.parentId !== undefined) {
    return {
      action: 'none',
      reason: `Sub-issue ${issue.identifier} skipped — coordinator manages sub-issues via parent`,
    }
  }

  // --- Declarative transition routing (v1.1) ---
  // When a WorkflowRegistry is present, delegate to the transition engine
  // for status→phase routing. This reads from the WorkflowDefinition YAML
  // instead of the hard-coded switch statement below.
  //
  // Icebox is excluded: top-of-funnel heuristics (description quality, delay
  // thresholds, label checks) are too nuanced for simple status→phase mapping
  // and remain in the dedicated decideIcebox() path until Phase 3 conditions
  // can express them declaratively.

  if (ctx.workflowRegistry && issue.status !== 'Icebox') {
    // "Started" is a no-op in the current workflow — agent is already working.
    if (issue.status === 'Started') {
      return { action: 'none', reason: `Issue ${issue.identifier} is in Started status (agent already working)` }
    }

    // Check governor enable flags before delegating to the transition engine.
    // These are configuration guards, not workflow graph concerns.
    const enableCheck = checkEnableFlag(issue.status, config, issue.identifier)
    if (enableCheck) return enableCheck

    const result = evaluateTransitions({
      issue,
      registry: ctx.workflowRegistry,
      workflowStrategy: ctx.workflowStrategy,
      isParentIssue: ctx.isParentIssue,
    })

    return result
  }

  // --- Fallback: hard-coded status-specific decisions ---
  // Used when no WorkflowRegistry is available (backward compatibility).

  switch (issue.status) {
    case 'Icebox':
      return decideIcebox(ctx)

    case 'Backlog':
      return decideBacklog(ctx)

    case 'Started':
      return { action: 'none', reason: `Issue ${issue.identifier} is in Started status (agent already working)` }

    case 'Finished':
      return decideFinished(ctx)

    case 'Delivered':
      return decideDelivered(ctx)

    case 'Rejected':
      return decideRejected(ctx)

    default:
      return { action: 'none', reason: `Issue ${issue.identifier} has unrecognized status: ${issue.status}` }
  }
}

// ---------------------------------------------------------------------------
// Enable-flag guard (shared between declarative and legacy paths)
// ---------------------------------------------------------------------------

/**
 * Check whether the governor enable flag for a given status allows dispatch.
 * Returns a DecisionResult to skip if disabled, or null to proceed.
 */
function checkEnableFlag(
  status: string,
  config: GovernorConfig,
  issueIdentifier: string,
): DecisionResult | null {
  switch (status) {
    case 'Backlog':
      if (!config.enableAutoDevelopment) {
        return { action: 'none', reason: `Auto-development is disabled for ${issueIdentifier}` }
      }
      break
    case 'Finished':
      if (!config.enableAutoQA) {
        return { action: 'none', reason: `Auto-QA is disabled for ${issueIdentifier}` }
      }
      break
    case 'Delivered':
      if (!config.enableAutoAcceptance) {
        return { action: 'none', reason: `Auto-acceptance is disabled for ${issueIdentifier}` }
      }
      break
    // Rejected has no enable flag — refinement always triggers.
    // Icebox is handled separately via top-of-funnel.
  }
  return null
}

// ---------------------------------------------------------------------------
// Per-status decision helpers
// ---------------------------------------------------------------------------

/**
 * Handle Icebox issues by delegating to the top-of-funnel logic.
 */
function decideIcebox(ctx: DecisionContext): DecisionResult {
  const { issue, config } = ctx

  // Build top-of-funnel config by merging defaults with any overrides
  const tofConfig: TopOfFunnelConfig = {
    ...DEFAULT_TOP_OF_FUNNEL_CONFIG,
    enableAutoResearch: config.enableAutoResearch,
    enableAutoBacklogCreation: config.enableAutoBacklogCreation,
    ...(config.topOfFunnel ?? {}),
  }

  const tofAction = determineTopOfFunnelAction(
    {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      status: issue.status,
      labels: issue.labels,
      createdAt: issue.createdAt,
      parentId: issue.parentId,
    },
    tofConfig,
    {
      hasActiveSession: ctx.hasActiveSession,
      isHeld: ctx.isHeld,
      researchCompleted: ctx.researchCompleted,
      backlogCreationCompleted: ctx.backlogCreationCompleted,
      isParentIssue: ctx.isParentIssue,
    },
  )

  switch (tofAction.type) {
    case 'trigger-research':
      return { action: 'trigger-research', reason: tofAction.reason }
    case 'trigger-backlog-creation':
      return { action: 'trigger-backlog-creation', reason: tofAction.reason }
    case 'none':
      return { action: 'none', reason: tofAction.reason }
  }
}

/**
 * Handle Backlog issues — trigger development if enabled.
 * Parent issues use the coordination template.
 * Sub-issues are skipped — only top-level/parent issues are dispatched directly.
 * The coordinator handles sub-issue lifecycle once the parent is being worked.
 */
function decideBacklog(ctx: DecisionContext): DecisionResult {
  const { issue, config } = ctx

  if (!config.enableAutoDevelopment) {
    return { action: 'none', reason: `Auto-development is disabled for ${issue.identifier}` }
  }

  // Parent issues use the coordination template for sub-issue orchestration.
  if (ctx.isParentIssue) {
    return {
      action: 'trigger-development',
      reason: `Parent issue ${issue.identifier} is in Backlog — triggering coordination development`,
    }
  }

  return {
    action: 'trigger-development',
    reason: `Issue ${issue.identifier} is in Backlog — triggering development`,
  }
}

/**
 * Handle Finished issues — trigger QA if enabled.
 * Check workflow strategy for escalation scenarios.
 */
function decideFinished(ctx: DecisionContext): DecisionResult {
  const { issue, config } = ctx

  if (!config.enableAutoQA) {
    return { action: 'none', reason: `Auto-QA is disabled for ${issue.identifier}` }
  }

  // If strategy is escalate-human, the issue needs human attention
  if (ctx.workflowStrategy === 'escalate-human') {
    return {
      action: 'escalate-human',
      reason: `Issue ${issue.identifier} is in Finished with escalate-human strategy — needs human review`,
    }
  }

  // If strategy is decompose, trigger decomposition instead of QA
  if (ctx.workflowStrategy === 'decompose') {
    return {
      action: 'decompose',
      reason: `Issue ${issue.identifier} is in Finished with decompose strategy — triggering decomposition`,
    }
  }

  // Always run QA to validate functional correctness, even when merge queue is
  // enabled. The merge queue handles git mechanics (rebase, conflict resolution)
  // at merge time — it should not bypass implementation validation.
  return {
    action: 'trigger-qa',
    reason: `Issue ${issue.identifier} is in Finished — triggering QA`,
  }
}

/**
 * Handle Delivered issues — trigger acceptance if enabled.
 */
function decideDelivered(ctx: DecisionContext): DecisionResult {
  const { issue, config } = ctx

  if (!config.enableAutoAcceptance) {
    return { action: 'none', reason: `Auto-acceptance is disabled for ${issue.identifier}` }
  }

  return {
    action: 'trigger-acceptance',
    reason: `Issue ${issue.identifier} is in Delivered — triggering acceptance`,
  }
}

/**
 * Handle Rejected issues — trigger refinement.
 * Check strategy for escalation thresholds.
 */
function decideRejected(ctx: DecisionContext): DecisionResult {
  const { issue } = ctx

  // If strategy is escalate-human, the issue needs human attention
  if (ctx.workflowStrategy === 'escalate-human') {
    return {
      action: 'escalate-human',
      reason: `Issue ${issue.identifier} is Rejected with escalate-human strategy — needs human intervention`,
    }
  }

  // If strategy is decompose, trigger decomposition instead of refinement
  if (ctx.workflowStrategy === 'decompose') {
    return {
      action: 'decompose',
      reason: `Issue ${issue.identifier} is Rejected with decompose strategy — triggering decomposition`,
    }
  }

  return {
    action: 'trigger-refinement',
    reason: `Issue ${issue.identifier} is Rejected — triggering refinement`,
  }
}
