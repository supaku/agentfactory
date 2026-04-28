/**
 * Transition Engine
 *
 * Pure function that evaluates the WorkflowDefinition's transition table
 * against the current issue status and context to determine which phase
 * (and therefore which GovernorAction) should fire.
 *
 * This replaces the hard-coded switch statement in decision-engine.ts.
 * Like decideAction(), the transition engine performs no I/O.
 */

import type { GovernorAction, GovernorIssue } from '../governor/governor-types.js'
import type { WorkflowDefinition, TransitionDefinition } from './workflow-types.js'
import type { WorkflowRegistry } from './workflow-registry.js'
import { evaluateCondition, buildEvaluationContext } from './expression/index.js'

// ---------------------------------------------------------------------------
// Transition Context
// ---------------------------------------------------------------------------

/**
 * Runtime context passed to the transition engine alongside the issue
 * and workflow definition. Includes all the external state needed
 * for escalation and conditional routing.
 */
export interface TransitionContext {
  issue: GovernorIssue
  registry: WorkflowRegistry
  /** Current escalation strategy from WorkflowState */
  workflowStrategy?: string
  /** Whether the issue is a parent (has sub-issues) */
  isParentIssue: boolean
  /** Phase completion state for condition evaluation (e.g., { researchCompleted: true }) */
  phaseState?: Record<string, boolean>
}

// ---------------------------------------------------------------------------
// Transition Result
// ---------------------------------------------------------------------------

export interface TransitionResult {
  /** The GovernorAction to take, or 'none' if no transition matched */
  action: GovernorAction
  /** Human-readable reason for the decision */
  reason: string
}

// ---------------------------------------------------------------------------
// Phase-to-action mapping
// ---------------------------------------------------------------------------

/**
 * Map a workflow phase name to a GovernorAction.
 *
 * Phase names in the YAML correspond to work types which have a
 * conventional "trigger-{phase}" action form.
 */
const PHASE_ACTION_MAP: Record<string, GovernorAction> = {
  'research': 'trigger-research',
  'backlog-creation': 'trigger-backlog-creation',
  'development': 'trigger-development',
  'qa': 'trigger-qa',
  'acceptance': 'trigger-acceptance',
  'refinement': 'trigger-refinement',
  'refinement-coordination': 'trigger-refinement',
}

function phaseToAction(phaseName: string): GovernorAction | undefined {
  return PHASE_ACTION_MAP[phaseName]
}

// ---------------------------------------------------------------------------
// Transition Engine
// ---------------------------------------------------------------------------

/**
 * Evaluate the workflow definition's transition table for the given
 * issue and context. Returns the action and reason.
 *
 * The evaluation order is:
 *   1. Filter transitions whose `from` matches the issue status
 *   2. Sort by priority (higher first), then by definition order
 *   3. Pick the first matching transition (unconditional or condition evaluates to true)
 *   4. Check escalation strategy for override actions (decompose, escalate-human)
 *   5. Map the target phase name to a GovernorAction
 */
export function evaluateTransitions(ctx: TransitionContext): TransitionResult {
  const { issue, registry, workflowStrategy, isParentIssue, phaseState } = ctx
  const workflow = registry.getWorkflow()

  if (!workflow) {
    return { action: 'none', reason: 'No workflow definition loaded' }
  }

  // Find transitions matching current status, sorted by priority (desc)
  const candidates = workflow.transitions
    .filter((t: TransitionDefinition) => t.from === issue.status)
    .sort((a: TransitionDefinition, b: TransitionDefinition) =>
      (b.priority ?? 0) - (a.priority ?? 0)
    )

  if (candidates.length === 0) {
    return {
      action: 'none',
      reason: `No transitions defined for status '${issue.status}' in workflow '${workflow.metadata.name}'`,
    }
  }

  // Build evaluation context for condition expressions
  const evalContext = buildEvaluationContext(issue, phaseState, { hasSubIssues: isParentIssue })

  // Pick the first matching transition:
  // - Unconditional transitions always match
  // - Conditional transitions match when their condition evaluates to true
  const match = candidates.find((t: TransitionDefinition) => {
    if (!t.condition) return true // unconditional always matches
    return evaluateCondition(t.condition, evalContext)
  }) ?? null

  if (!match) {
    return {
      action: 'none',
      reason: `No transition conditions satisfied for status '${issue.status}' in workflow '${workflow.metadata.name}'`,
    }
  }

  // Check escalation strategy overrides.
  // When strategy is 'escalate-human' or 'decompose', these take priority
  // over the normal phase transition — matching the current behavior in
  // decideFinished() and decideRejected().
  if (workflowStrategy === 'escalate-human') {
    return {
      action: 'escalate-human',
      reason: `Issue ${issue.identifier} in '${issue.status}' with escalate-human strategy — needs human intervention`,
    }
  }

  if (workflowStrategy === 'decompose') {
    return {
      action: 'decompose',
      reason: `Issue ${issue.identifier} in '${issue.status}' with decompose strategy — triggering decomposition`,
    }
  }

  // Map phase name to action
  const action = phaseToAction(match.to)
  if (!action) {
    return {
      action: 'none',
      reason: `Phase '${match.to}' does not map to a known GovernorAction`,
    }
  }

  // Check if the target phase belongs to a parallelism group.
  // Only parent issues trigger parallel dispatch — sub-issues are dispatched
  // individually by the ParallelismExecutor within the Governor.
  if (isParentIssue) {
    const group = registry.getParallelismGroup(match.to)
    if (group) {
      return {
        action: 'trigger-parallel-group' as GovernorAction,
        reason: `Issue ${issue.identifier} in '${issue.status}' → parallel group '${group.name}' (strategy: ${group.strategy})`,
      }
    }
  }

  const parentSuffix = isParentIssue ? ' (parent — uses coordination template)' : ''
  return {
    action,
    reason: `Issue ${issue.identifier} in '${issue.status}' → phase '${match.to}'${parentSuffix}`,
  }
}
