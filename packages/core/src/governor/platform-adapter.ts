/**
 * PlatformAdapter Interface
 *
 * Extends the WorkSchedulingFrontend concept with methods needed by the
 * EventDrivenGovernor to process webhook events and poll project state.
 *
 * Platform adapters (e.g., LinearPlatformAdapter) implement this interface
 * structurally, translating between platform-native concepts and the
 * Governor's abstract event/issue types.
 */

import type { GovernorEvent } from './event-types.js'
import type { GovernorIssue } from './governor-types.js'

// ---------------------------------------------------------------------------
// PlatformAdapter interface
// ---------------------------------------------------------------------------

/**
 * Adapter that bridges a project-management platform (Linear, Jira, etc.)
 * to the Governor's event-driven processing model.
 *
 * Responsibilities:
 * - Convert platform webhook payloads into GovernorEvents
 * - Scan a project for all non-terminal issues (poll sweep)
 * - Convert platform-native issue objects to GovernorIssue
 * - Detect parent/child issue relationships
 */
export interface PlatformAdapter {
  /** Human-readable name of the platform (e.g., 'linear', 'jira'). */
  readonly name: string

  /**
   * Normalize a raw webhook payload from the platform into one or more
   * GovernorEvents.
   *
   * Returns `null` if the payload type is not recognized or not relevant
   * to the Governor (e.g., label-only changes, unrelated resource types).
   *
   * @param payload - Raw webhook payload from the platform
   * @returns Array of GovernorEvents, or null if unrecognized
   */
  normalizeWebhookEvent(payload: unknown): GovernorEvent[] | null

  /**
   * Fetch all non-terminal issues for the given project.
   *
   * Terminal statuses (e.g., Accepted, Canceled, Duplicate) are excluded
   * so the Governor only evaluates issues that may need action.
   *
   * @param project - Project name to scan
   * @returns Array of GovernorIssue representing active issues
   */
  scanProjectIssues(project: string): Promise<GovernorIssue[]>

  /**
   * Convert a platform-native issue object to a GovernorIssue.
   *
   * The `native` parameter is typed as `unknown` to keep the interface
   * platform-agnostic. Implementations should cast to the appropriate
   * platform SDK type internally.
   *
   * @param native - Platform-native issue object
   * @returns GovernorIssue representation
   */
  toGovernorIssue(native: unknown): Promise<GovernorIssue>

  /**
   * Check whether the given issue is a parent issue (has child/sub-issues).
   *
   * Parent issues receive special treatment in the Governor: they are
   * typically managed by a coordinator rather than dispatched directly.
   *
   * @param issueId - Issue ID to check
   * @returns True if the issue has child issues
   */
  isParentIssue(issueId: string): Promise<boolean>
}
