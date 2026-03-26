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
  /** Whether the issue is assigned to a human user (vs unassigned or bot) */
  isAssignedToHuman?: boolean
  /** Whether the issue has incomplete blocking relations */
  hasBlockingIncomplete?: boolean
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

    /**
     * Check whether the issue has sub-issues.
     * Alias for `isParentIssue()`.
     *
     * Usage in expressions: `hasSubIssues()`
     */
    hasSubIssues(): boolean {
      return opts.hasSubIssues === true
    },

    /**
     * Check whether the issue is assigned to a human user (vs unassigned or bot).
     *
     * Usage in expressions: `isAssignedToHuman()`
     */
    isAssignedToHuman(): boolean {
      return opts.isAssignedToHuman === true
    },

    /**
     * Check whether the issue has incomplete blocking relations.
     *
     * Usage in expressions: `hasBlockingIncomplete()`
     */
    hasBlockingIncomplete(): boolean {
      return opts.hasBlockingIncomplete === true
    },

    /**
     * Check whether a string starts with a given prefix.
     *
     * Usage in expressions: `startsWith(title, 'fix')`
     */
    startsWith(...args: unknown[]): boolean {
      const str = args[0]
      const prefix = args[1]
      if (typeof str !== 'string' || typeof prefix !== 'string') {
        return false
      }
      return str.startsWith(prefix)
    },

    /**
     * Check whether a string contains a given substring.
     *
     * Usage in expressions: `contains(title, 'hotfix')`
     */
    contains(...args: unknown[]): boolean {
      const str = args[0]
      const substring = args[1]
      if (typeof str !== 'string' || typeof substring !== 'string') {
        return false
      }
      return str.includes(substring)
    },
  }
}
