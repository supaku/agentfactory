/**
 * Branching Router
 *
 * Evaluates branching blocks from a WorkflowDefinition to conditionally
 * select a template. Each branching block has a condition expression that
 * is evaluated in order; the first matching branch wins (short-circuit).
 *
 * This module is used by the transition engine to support conditional
 * template selection based on issue state, phase completion flags, and
 * other context variables.
 */

import type { BranchingDefinition } from './workflow-types.js'
import type { EvaluationContext } from './expression/index.js'
import { evaluateCondition } from './expression/index.js'

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Result of evaluating branching blocks.
 */
export interface BranchingResult {
  /** Selected template name, or null if no branch matched */
  template: string | null
  /** Human-readable reason for the selection */
  reason: string
}

// ---------------------------------------------------------------------------
// Branching Evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate branching blocks in order and return the first matching template.
 *
 * For each block:
 * - Evaluate condition using evaluateCondition()
 * - If true -> return then.template
 * - If false -> return else.template (if present)
 * First matching branch wins (short-circuit).
 * If no branch matches -> return null (fall through to default).
 *
 * @param branching - The branching definitions to evaluate.
 * @param context   - The sandboxed evaluation context.
 * @returns The branching result with template and reason.
 */
export function evaluateBranching(
  branching: BranchingDefinition[],
  context: EvaluationContext,
): BranchingResult {
  for (const branch of branching) {
    const conditionResult = evaluateCondition(branch.condition, context)

    if (conditionResult) {
      return {
        template: branch.then.template,
        reason: `Branch '${branch.name}' condition met -> template '${branch.then.template}'`,
      }
    }

    // Condition is false — check for else branch
    if (branch.else) {
      return {
        template: branch.else.template,
        reason: `Branch '${branch.name}' condition not met -> else template '${branch.else.template}'`,
      }
    }

    // No else branch — fall through to next branching block
  }

  return {
    template: null,
    reason: 'No branching block matched',
  }
}
