/**
 * Governor Event Types
 *
 * Discriminated union of events that flow through the GovernorEventBus.
 * Events are produced by webhooks (real-time) and poll sweeps (periodic),
 * then consumed by the EventDrivenGovernor for decision-making.
 */

import type { GovernorIssue } from './governor-types.js'

// ---------------------------------------------------------------------------
// Event types (discriminated union)
// ---------------------------------------------------------------------------

/**
 * Fired when an issue's workflow status changes (e.g., Backlog → Started).
 * Typically produced by webhook `issue-updated` or a poll sweep diff.
 */
export interface IssueStatusChangedEvent {
  type: 'issue-status-changed'
  issueId: string
  issue: GovernorIssue
  previousStatus?: string
  newStatus: string
  /** ISO-8601 timestamp */
  timestamp: string
  /** Where this event originated */
  source: EventSource
}

/**
 * Fired when a comment is added to an issue.
 * Used for parsing human override directives (HOLD, RESUME, PRIORITY, etc.).
 */
export interface CommentAddedEvent {
  type: 'comment-added'
  issueId: string
  issue: GovernorIssue
  commentId: string
  commentBody: string
  userId?: string
  userName?: string
  /** ISO-8601 timestamp */
  timestamp: string
  source: EventSource
}

/**
 * Fired when an agent session completes (success or failure).
 * Allows the Governor to re-evaluate the issue immediately.
 */
export interface SessionCompletedEvent {
  type: 'session-completed'
  issueId: string
  issue: GovernorIssue
  sessionId: string
  outcome: 'success' | 'failure'
  /** ISO-8601 timestamp */
  timestamp: string
  source: EventSource
}

/**
 * Emitted by periodic poll sweeps. Contains a full snapshot of a single
 * issue so the Governor can evaluate it without an extra API call.
 */
export interface PollSnapshotEvent {
  type: 'poll-snapshot'
  issueId: string
  issue: GovernorIssue
  project: string
  /** ISO-8601 timestamp */
  timestamp: string
  source: EventSource
}

// ---------------------------------------------------------------------------
// Event source
// ---------------------------------------------------------------------------

export type EventSource = 'webhook' | 'poll' | 'manual'

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export type GovernorEvent =
  | IssueStatusChangedEvent
  | CommentAddedEvent
  | SessionCompletedEvent
  | PollSnapshotEvent

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a deduplication key for an event.
 * Same issue at the same status = duplicate within the dedup window.
 */
export function eventDedupKey(event: GovernorEvent): string {
  switch (event.type) {
    case 'issue-status-changed':
      return `${event.issueId}:${event.newStatus}`
    case 'comment-added':
      return `${event.issueId}:comment:${event.commentId}`
    case 'session-completed':
      return `${event.issueId}:session:${event.sessionId}`
    case 'poll-snapshot':
      return `${event.issueId}:${event.issue.status}`
  }
}

/**
 * Create a GovernorEvent timestamp (ISO-8601 now).
 */
export function eventTimestamp(): string {
  return new Date().toISOString()
}
