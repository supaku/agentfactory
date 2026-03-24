/**
 * Built-in Helper Functions for Expression Evaluation
 *
 * Factory functions that produce helper functions bound to a specific
 * GovernorIssue context. These are registered in the EvaluationContext
 * so expressions like `hasLabel('bug')` resolve correctly.
 */

import type { GovernorIssue } from '../../governor/governor-types.js'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface BuiltinHelperOptions {
  /** Whether the issue has sub-issues (i.e., it is a parent issue) */
  hasSubIssues?: boolean
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the set of built-in helper functions bound to the given issue.
 *
 * @param issue - The GovernorIssue to bind helpers to.
 * @param opts  - Additional context not available on the issue itself.
 * @returns A record of helper functions keyed by name.
 */
export function createBuiltinHelpers(
  issue: GovernorIssue,
  opts: BuiltinHelperOptions = {},
): Record<string, (...args: unknown[]) => unknown> {
  return {
    /**
     * Check whether the issue carries a specific label.
     *
     * Usage in expressions: `hasLabel('bug')`
     */
    hasLabel(...args: unknown[]): boolean {
      const label = args[0]
      if (typeof label !== 'string') {
        return false
      }
      return issue.labels.includes(label)
    },

    /**
     * Check whether the issue description contains a `@directive` mention.
     *
     * Usage in expressions: `hasDirective('hotfix')`
     */
    hasDirective(...args: unknown[]): boolean {
      const directive = args[0]
      if (typeof directive !== 'string') {
        return false
      }
      if (!issue.description) {
        return false
      }
      return issue.description.includes(`@${directive}`)
    },

    /**
     * Check whether the issue is a parent issue (has sub-issues).
     *
     * Usage in expressions: `isParentIssue()`
     */
    isParentIssue(): boolean {
      return opts.hasSubIssues === true
    },
  }
}
