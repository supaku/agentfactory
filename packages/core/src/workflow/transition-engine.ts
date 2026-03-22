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
  // Coordination phases still map to the same trigger action;
  // the orchestrator resolves the coordination template via isParentIssue.
  'coordination': 'trigger-development',
  'qa-coordination': 'trigger-qa',
  'acceptance-coordination': 'trigger-acceptance',
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
 *   3. Pick the first matching transition (conditions are Phase 3)
 *   4. Check escalation strategy for override actions (decompose, escalate-human)
 *   5. Map the target phase name to a GovernorAction
 */
export function evaluateTransitions(ctx: TransitionContext): TransitionResult {
  const { issue, registry, workflowStrategy, isParentIssue } = ctx
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

  // Phase 2: Pick the first unconditional transition, or the first
  // transition that has a condition (conditions are not evaluated until Phase 3;
  // for now, transitions with conditions are skipped).
  const match = candidates.find((t: TransitionDefinition) => !t.condition) ?? null

  if (!match) {
    return {
      action: 'none',
      reason: `All transitions for status '${issue.status}' have conditions (evaluation deferred to Phase 3)`,
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

  const parentSuffix = isParentIssue ? ' (parent — uses coordination template)' : ''
  return {
    action,
    reason: `Issue ${issue.identifier} in '${issue.status}' → phase '${match.to}'${parentSuffix}`,
  }
}
