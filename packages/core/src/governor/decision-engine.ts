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
}

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

  // --- Terminal statuses ---

  if (TERMINAL_STATUSES.has(issue.status)) {
    return { action: 'none', reason: `Issue ${issue.identifier} is in terminal status: ${issue.status}` }
  }

  // --- Status-specific decisions ---

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

  // Sub-issues should not be dispatched directly — the coordinator manages them
  // when the parent issue is picked up. This prevents invisible backlog sprawl
  // when sub-issues are in Backlog but their parent is still in Icebox.
  if (issue.parentId !== undefined) {
    return {
      action: 'none',
      reason: `Sub-issue ${issue.identifier} skipped — only parent issues are dispatched directly`,
    }
  }

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
