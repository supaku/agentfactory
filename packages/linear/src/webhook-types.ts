/**
 * Linear Webhook Payload Types
 *
 * Types for processing Linear webhook events, including:
 * - AgentSession events (created, prompted, updated, removed)
 * - Issue update events
 *
 * @see https://linear.app/developers/webhooks
 * @see https://linear.app/developers/agent-interaction
 */

import type { AgentActivitySignal } from './types.js'

// ============================================================================
// Common Webhook Types
// ============================================================================

/**
 * Standard webhook action types for most Linear resources
 */
export type WebhookAction = 'create' | 'update' | 'remove'

/**
 * AgentSession-specific webhook action types
 * Note: Linear sends past-tense actions (created, updated, removed)
 * - created: New session initiated by user mention or delegation
 * - prompted: User sent a follow-up message to an existing session
 * - updated: Session state changed
 * - removed: Session was deleted
 */
export type AgentSessionAction = 'created' | 'prompted' | 'updated' | 'removed'

/**
 * User who initiated or is responsible for the session
 */
export interface WebhookUser {
  id: string
  name: string
  email?: string
  displayName?: string
  avatarUrl?: string
}

/**
 * Comment data included in webhook payloads
 */
export interface WebhookComment {
  id: string
  body: string
  createdAt: string
  user?: WebhookUser
  parentId?: string
}

/**
 * Issue data included in webhook payloads
 */
export interface WebhookIssue {
  id: string
  identifier: string
  title: string
  description?: string
  url: string
  state?: {
    id: string
    name: string
    type: string
  }
  team?: {
    id: string
    name: string
    key: string
  }
  labels?: Array<{
    id: string
    name: string
    color?: string
  }>
  project?: {
    id: string
    name: string
  }
  parent?: {
    id: string
    identifier: string
    title: string
  }
}

/**
 * Base Linear webhook payload
 * All webhook events contain these common fields
 */
export interface LinearWebhookPayload {
  /** The action that triggered this webhook */
  action: WebhookAction | AgentSessionAction
  /** The type of resource this webhook is for */
  type: string
  /** The resource data */
  data: Record<string, unknown>
  /** URL to the resource in Linear */
  url?: string
  /** ISO timestamp when the event occurred */
  createdAt: string
  /** ID of the organization this webhook belongs to */
  organizationId?: string
  /** Unix timestamp when the webhook was sent */
  webhookTimestamp?: number
  /** Unique ID for this webhook delivery */
  webhookId?: string
}

// ============================================================================
// AgentSession Webhook Types
// ============================================================================

/**
 * AgentSession state values in webhook payloads.
 *
 * Named `LinearSessionState` to distinguish from:
 * - `AgentSessionState` (Linear Agent SDK states: pending, active, error, awaitingInput, complete)
 * - `AgentSessionStatus` (Redis session tracking states)
 */
export type LinearSessionState = 'created' | 'running' | 'completed' | 'failed'

/**
 * Base AgentSession data common to all session events
 */
export interface AgentSessionData {
  /** Unique session ID */
  id: string
  /** ID of the issue this session is working on */
  issueId: string
  /** ID of the agent assigned to this session */
  agentId: string
  /** Current state of the session */
  state: LinearSessionState
  /** External URL for the agent's work (e.g., PR link) */
  externalUrl?: string
  /** Allow additional unknown fields from webhook payload */
  [key: string]: unknown
}

/**
 * Extended AgentSession data for 'create' events
 * Includes context needed to start working on an issue
 */
export interface AgentSessionCreatedData extends AgentSessionData {
  /**
   * Formatted prompt string containing relevant context for the agent session.
   * Includes issue details, comments, and guidance.
   * Present only for 'create' events.
   */
  promptContext?: string

  /**
   * Previous comments in the thread before this agent was mentioned.
   * Present only for 'create' events where the session was initiated
   * by mentioning the agent in a child comment of a thread.
   */
  previousComments?: WebhookComment[]

  /**
   * Guidance to inform the agent's behavior.
   * Comes from configuration at workspace, parent teams, and/or current team.
   * The nearest team-specific guidance takes highest precedence.
   */
  guidance?: string

  /**
   * The human user responsible for initiating this session.
   * Unset if the session was initiated via automation or by an agent user.
   */
  user?: WebhookUser

  /**
   * Full issue data for the session
   */
  issue?: WebhookIssue

  /**
   * The comment that triggered this session (if initiated via comment mention)
   */
  comment?: WebhookComment
}

/**
 * Agent activity included in prompted webhooks
 * This can indicate special signals like 'stop' from the user
 */
export interface WebhookAgentActivity {
  /** The type of activity */
  type?: string
  /** Signal modifier for the activity */
  signal?: AgentActivitySignal
  /** Activity content/body */
  body?: string
}

/**
 * Extended AgentSession data for 'prompted' events
 * Includes the follow-up message from the user
 */
export interface AgentSessionPromptedData extends AgentSessionData {
  /**
   * The follow-up prompt/message from the user.
   * Present when user sends a message to an existing session.
   */
  promptContext?: string

  /**
   * The user who sent the follow-up message
   */
  user?: WebhookUser

  /**
   * The comment containing the follow-up message
   */
  comment?: WebhookComment

  /**
   * Agent activity associated with this prompt.
   * May contain a 'stop' signal if the user clicked Stop.
   * @see https://linear.app/developers/agent-signals
   */
  agentActivity?: WebhookAgentActivity
}

/**
 * AgentSession data for 'update' events
 */
export interface AgentSessionUpdatedData extends AgentSessionData {
  /** Previous values before the update */
  updatedFrom?: {
    state?: LinearSessionState
    externalUrl?: string
  }
}

/**
 * Webhook payload for AgentSession 'created' events
 * Triggered when a new agent session is initiated by mention or delegation
 */
export interface AgentSessionCreatedPayload extends LinearWebhookPayload {
  type: 'AgentSessionEvent'
  action: 'created'
  data: AgentSessionCreatedData
}

/**
 * Webhook payload for AgentSession 'prompted' events
 * Triggered when a user sends a follow-up message to an existing session
 */
export interface AgentSessionPromptedPayload extends LinearWebhookPayload {
  type: 'AgentSessionEvent'
  action: 'prompted'
  data: AgentSessionPromptedData
}

/**
 * Webhook payload for AgentSession 'updated' events
 * Triggered when session state changes
 */
export interface AgentSessionUpdatedPayload extends LinearWebhookPayload {
  type: 'AgentSessionEvent'
  action: 'updated'
  data: AgentSessionUpdatedData
}

/**
 * Webhook payload for AgentSession 'removed' events
 * Triggered when a session is deleted
 */
export interface AgentSessionRemovedPayload extends LinearWebhookPayload {
  type: 'AgentSessionEvent'
  action: 'removed'
  data: AgentSessionData
}

/**
 * Union type for all AgentSession webhook payloads
 */
export type AgentSessionPayload =
  | AgentSessionCreatedPayload
  | AgentSessionPromptedPayload
  | AgentSessionUpdatedPayload
  | AgentSessionRemovedPayload

/**
 * Type guard to check if a payload is an AgentSession event
 */
export function isAgentSessionPayload(
  payload: LinearWebhookPayload
): payload is AgentSessionPayload {
  return payload.type === 'AgentSessionEvent'
}

/**
 * Type guard for AgentSession 'created' events
 */
export function isAgentSessionCreated(
  payload: LinearWebhookPayload
): payload is AgentSessionCreatedPayload {
  return payload.type === 'AgentSessionEvent' && payload.action === 'created'
}

/**
 * Type guard for AgentSession 'prompted' events (follow-up messages)
 */
export function isAgentSessionPrompted(
  payload: LinearWebhookPayload
): payload is AgentSessionPromptedPayload {
  return payload.type === 'AgentSessionEvent' && payload.action === 'prompted'
}

/**
 * Type guard for AgentSession 'updated' events
 */
export function isAgentSessionUpdated(
  payload: LinearWebhookPayload
): payload is AgentSessionUpdatedPayload {
  return payload.type === 'AgentSessionEvent' && payload.action === 'updated'
}

/**
 * Type guard for AgentSession 'removed' events
 */
export function isAgentSessionRemoved(
  payload: LinearWebhookPayload
): payload is AgentSessionRemovedPayload {
  return payload.type === 'AgentSessionEvent' && payload.action === 'removed'
}

// ============================================================================
// Issue Webhook Types
// ============================================================================

/**
 * Issue state information in webhook payloads
 */
export interface WebhookIssueState {
  id: string
  name: string
  type: string // 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled'
}

/**
 * Extended issue data for Issue update webhooks
 */
export interface IssueUpdateData extends WebhookIssue {
  state: WebhookIssueState
  assignee?: WebhookUser
  /** Allow additional unknown fields */
  [key: string]: unknown
}

/**
 * Webhook payload for Issue update events
 * @see https://linear.app/developers/webhooks
 */
export interface IssueUpdatePayload extends LinearWebhookPayload {
  type: 'Issue'
  action: 'update'
  data: IssueUpdateData
  /** Previous values before the update */
  updatedFrom: {
    stateId?: string
    assigneeId?: string
    [key: string]: unknown
  }
  /** The actor who made the change */
  actor?: WebhookUser
}

/**
 * Type guard for Issue update events
 */
export function isIssueUpdate(
  payload: LinearWebhookPayload
): payload is IssueUpdatePayload {
  return payload.type === 'Issue' && payload.action === 'update'
}
