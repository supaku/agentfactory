/**
 * Evaluation Context
 *
 * Defines the sandboxed context in which expression ASTs are evaluated.
 * The context provides variable bindings and registered helper functions,
 * with no access to globals, prototypes, or dynamic code execution.
 */

import type { GovernorIssue } from '../../governor/governor-types.js'
import { createBuiltinHelpers } from './helpers.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The sandboxed evaluation context passed to the expression evaluator.
 *
 * - `variables` holds named values that `VariableRef` nodes resolve against.
 * - `functions` holds callable helpers that `FunctionCall` nodes invoke.
 */
export interface EvaluationContext {
  /** Variable bindings — e.g., { isParentIssue: true, priority: 3 } */
  readonly variables: Record<string, unknown>
  /** Registered helper functions */
  readonly functions: Record<string, (...args: unknown[]) => unknown>
}

// ---------------------------------------------------------------------------
// Context Builder
// ---------------------------------------------------------------------------

export interface BuildContextOptions {
  /** Whether the issue has sub-issues (i.e., it is a parent issue) */
  hasSubIssues?: boolean
  /** Whether the issue is assigned to a human user (vs unassigned or bot) */
  isAssignedToHuman?: boolean
  /** Whether the issue has incomplete blocking relations */
  hasBlockingIncomplete?: boolean
}

/**
 * Build an EvaluationContext from a GovernorIssue and optional phase state.
 *
 * This is the primary way to create contexts for condition evaluation
 * during workflow transitions. It:
 *   1. Extracts well-known variables from the issue (status, labels, etc.)
 *   2. Merges in phase-state booleans (researchCompleted, etc.)
 *   3. Registers all built-in helper functions
 *
 * @param issue      - The issue being evaluated.
 * @param phaseState - Optional map of phase completion flags.
 * @param opts       - Additional context not on the issue itself.
 * @returns A fully populated EvaluationContext.
 */
export function buildEvaluationContext(
  issue: GovernorIssue,
  phaseState?: Record<string, boolean>,
  opts?: BuildContextOptions,
): EvaluationContext {
  const hasSubIssues = opts?.hasSubIssues ?? false

  const variables: Record<string, unknown> = {
    // Issue-derived variables
    isParentIssue: hasSubIssues,
    labels: issue.labels,
    status: issue.status,
    priority: 0, // GovernorIssue doesn't carry priority; default to 0

    // Spread phase-state booleans so expressions like
    // `researchCompleted and not backlogCreationCompleted` work directly.
    ...phaseState,
  }

  const functions = createBuiltinHelpers(issue, {
    hasSubIssues,
    isAssignedToHuman: opts?.isAssignedToHuman ?? false,
    hasBlockingIncomplete: opts?.hasBlockingIncomplete ?? false,
  })

  return { variables, functions }
}
