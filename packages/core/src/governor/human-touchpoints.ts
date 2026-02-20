/**
 * Human Touchpoint Manager
 *
 * Manages human override state and generates review request notifications.
 * Uses a storage adapter pattern so that packages/core does not depend on
 * packages/server (Redis) directly.
 */

import type { OverrideDirective, OverridePriority } from './override-parser.js'

const log = {
  info: (msg: string, data?: Record<string, unknown>) => console.log(`[touchpoints] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) => console.warn(`[touchpoints] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) => console.error(`[touchpoints] ${msg}`, data ? JSON.stringify(data) : ''),
  debug: (_msg: string, _data?: Record<string, unknown>) => {},
}

// ============================================
// Types
// ============================================

/**
 * Persisted override state for an issue
 */
export interface OverrideState {
  issueId: string
  directive: OverrideDirective
  isActive: boolean
  expiresAt?: number
}

/**
 * Configuration for touchpoint timeouts
 */
export interface TouchpointConfig {
  /** Timeout for review requests (default: 4 hours) */
  reviewRequestTimeoutMs: number
  /** Timeout for decomposition proposals (default: 2 hours) */
  decompositionProposalTimeoutMs: number
  /** Timeout for escalation alerts (default: Infinity — requires human response) */
  escalationTimeoutMs: number
}

/**
 * Default touchpoint configuration
 */
export const DEFAULT_TOUCHPOINT_CONFIG: TouchpointConfig = {
  reviewRequestTimeoutMs: 4 * 60 * 60 * 1000,        // 4 hours
  decompositionProposalTimeoutMs: 2 * 60 * 60 * 1000, // 2 hours
  escalationTimeoutMs: Infinity,                        // Requires human
}

/**
 * Types of human touchpoint notifications
 */
export type TouchpointType = 'review-request' | 'decomposition-proposal' | 'escalation-alert'

/**
 * A notification posted to an issue requesting human attention
 */
export interface TouchpointNotification {
  type: TouchpointType
  issueId: string
  body: string
  postedAt: number
  timeoutMs: number
  respondedAt?: number
}

// ============================================
// Storage Adapter Interface
// ============================================

/**
 * Storage adapter for override state persistence.
 * Implementations can back this with Redis, in-memory maps, etc.
 */
export interface OverrideStorage {
  get(issueId: string): Promise<OverrideState | null>
  set(issueId: string, state: OverrideState): Promise<void>
  clear(issueId: string): Promise<void>
}

/**
 * In-memory override storage for testing and local development
 */
export class InMemoryOverrideStorage implements OverrideStorage {
  private store = new Map<string, OverrideState>()

  async get(issueId: string): Promise<OverrideState | null> {
    return this.store.get(issueId) ?? null
  }

  async set(issueId: string, state: OverrideState): Promise<void> {
    this.store.set(issueId, state)
  }

  async clear(issueId: string): Promise<void> {
    this.store.delete(issueId)
  }
}

// ============================================
// Module-level storage reference
// ============================================

let _storage: OverrideStorage | null = null

/**
 * Initialize the touchpoint manager with a storage adapter.
 * Must be called before using state management functions.
 */
export function initTouchpointStorage(storage: OverrideStorage): void {
  _storage = storage
  log.info('Touchpoint storage initialized')
}

/**
 * Get the current storage adapter, throwing if not initialized
 */
function getStorage(): OverrideStorage {
  if (!_storage) {
    throw new Error('Touchpoint storage not initialized. Call initTouchpointStorage() first.')
  }
  return _storage
}

// ============================================
// Override State Management
// ============================================

/**
 * Get the current override state for an issue
 */
export async function getOverrideState(issueId: string): Promise<OverrideState | null> {
  const storage = getStorage()
  const state = await storage.get(issueId)

  // Check if the override has expired
  if (state && state.expiresAt && Date.now() > state.expiresAt) {
    log.info('Override expired', { issueId, type: state.directive.type })
    await storage.clear(issueId)
    return null
  }

  return state
}

/**
 * Set an override directive for an issue
 */
export async function setOverrideState(issueId: string, directive: OverrideDirective): Promise<void> {
  const storage = getStorage()
  const state: OverrideState = {
    issueId,
    directive,
    isActive: true,
  }

  await storage.set(issueId, state)
  log.info('Override state set', { issueId, type: directive.type })
}

/**
 * Clear the override state for an issue (e.g., on RESUME)
 */
export async function clearOverrideState(issueId: string): Promise<void> {
  const storage = getStorage()
  await storage.clear(issueId)
  log.info('Override state cleared', { issueId })
}

/**
 * Check if an issue is currently held (HOLD directive active)
 */
export async function isHeld(issueId: string): Promise<boolean> {
  const state = await getOverrideState(issueId)
  return state !== null && state.isActive && state.directive.type === 'hold'
}

/**
 * Get the PRIORITY override for an issue, if one is active.
 * Returns the priority level ('high' | 'medium' | 'low') or null if no priority override.
 */
export async function getOverridePriority(issueId: string): Promise<OverridePriority | null> {
  const state = await getOverrideState(issueId)
  if (state && state.isActive && state.directive.type === 'priority' && state.directive.priority) {
    return state.directive.priority
  }
  return null
}

// ============================================
// Notification Generation
// ============================================

/**
 * Format a cost string for display in notifications.
 * Returns empty string if no cost is provided.
 */
function formatCost(totalCostUsd?: number): string {
  if (totalCostUsd === undefined || totalCostUsd === null) {
    return ''
  }
  return `\n- **Total cost so far:** $${totalCostUsd.toFixed(2)}`
}

/**
 * Generate a review request notification.
 * Typically posted at cycle 2 when the context-enriched strategy kicks in.
 */
export function generateReviewRequest(
  context: {
    issueIdentifier: string
    cycleCount: number
    failureSummary: string
    strategy: string
    totalCostUsd?: number
  },
  config: TouchpointConfig = DEFAULT_TOUCHPOINT_CONFIG,
): TouchpointNotification {
  const body = `## Review Request

**${context.issueIdentifier}** has failed **${context.cycleCount}** dev-QA cycle(s).

- **Current strategy:** ${context.strategy}${formatCost(context.totalCostUsd)}

### Failure Summary

${context.failureSummary || '_No failure details available._'}

### Actions

Reply with one of the following directives:
- **HOLD** — Pause autonomous processing
- **SKIP QA** — Skip QA and proceed to acceptance
- **DECOMPOSE** — Trigger task decomposition
- **REASSIGN** — Stop agent work, assign to a human
- **PRIORITY: high|medium|low** — Adjust scheduling priority
- **RESUME** — Continue with current strategy

_This request will auto-proceed in ${Math.round(config.reviewRequestTimeoutMs / (60 * 60 * 1000))} hour(s) if no response is received._`

  return {
    type: 'review-request',
    issueId: context.issueIdentifier,
    body,
    postedAt: Date.now(),
    timeoutMs: config.reviewRequestTimeoutMs,
  }
}

/**
 * Generate a decomposition proposal notification.
 * Typically posted at cycle 3 when the decompose strategy kicks in.
 */
export function generateDecompositionProposal(
  context: {
    issueIdentifier: string
    cycleCount: number
    failureSummary: string
    totalCostUsd?: number
  },
  config: TouchpointConfig = DEFAULT_TOUCHPOINT_CONFIG,
): TouchpointNotification {
  const body = `## Decomposition Proposal

**${context.issueIdentifier}** has failed **${context.cycleCount}** dev-QA cycle(s) and is being considered for decomposition into smaller sub-issues.

${formatCost(context.totalCostUsd) ? `- ${formatCost(context.totalCostUsd).trim()}` : ''}

### Failure Summary

${context.failureSummary || '_No failure details available._'}

### Recommended Action

The agent will attempt to decompose this issue into smaller, independently solvable sub-issues.

Reply with a directive to override:
- **HOLD** — Pause and review manually
- **SKIP QA** — Skip QA and proceed to acceptance
- **REASSIGN** — Stop agent work entirely
- **PRIORITY: high|medium|low** — Adjust scheduling priority
- **RESUME** — Proceed with decomposition (default)

_Decomposition will auto-proceed in ${Math.round(config.decompositionProposalTimeoutMs / (60 * 60 * 1000))} hour(s) if no response is received._`

  return {
    type: 'decomposition-proposal',
    issueId: context.issueIdentifier,
    body,
    postedAt: Date.now(),
    timeoutMs: config.decompositionProposalTimeoutMs,
  }
}

/**
 * Generate an escalation alert notification.
 * Posted at cycle 4+ when human intervention is required.
 */
export function generateEscalationAlert(
  context: {
    issueIdentifier: string
    cycleCount: number
    failureSummary: string
    totalCostUsd?: number
    blockerIdentifier?: string
  },
  config: TouchpointConfig = DEFAULT_TOUCHPOINT_CONFIG,
): TouchpointNotification {
  const blockerLine = context.blockerIdentifier
    ? `\n- **Blocker issue:** ${context.blockerIdentifier}`
    : ''

  const body = `## Escalation Alert

**${context.issueIdentifier}** has failed **${context.cycleCount}** dev-QA cycle(s) and requires human intervention.

- **Strategy:** escalate-human${blockerLine}${formatCost(context.totalCostUsd)}

### Failure Summary

${context.failureSummary || '_No failure details available._'}

### Required Action

This issue has exhausted automated resolution strategies. A human must review and take action:
- **HOLD** — Keep paused (current state)
- **DECOMPOSE** — Request agent decomposition
- **REASSIGN** — Assign to a specific person
- **PRIORITY: high|medium|low** — Adjust scheduling priority
- **RESUME** — Retry with normal strategy (resets cycle count)

_This issue will remain paused until a human responds._`

  return {
    type: 'escalation-alert',
    issueId: context.issueIdentifier,
    body,
    postedAt: Date.now(),
    timeoutMs: config.escalationTimeoutMs,
  }
}

// ============================================
// Timeout Checking
// ============================================

/**
 * Check if a touchpoint notification has timed out (human did not respond in time).
 *
 * A touchpoint with Infinity timeout never times out (always returns false).
 * A touchpoint that has been responded to (respondedAt is set) never times out.
 */
export function hasTouchpointTimedOut(notification: TouchpointNotification): boolean {
  // Already responded — not timed out
  if (notification.respondedAt !== undefined) {
    return false
  }

  // Infinite timeout — never times out
  if (!isFinite(notification.timeoutMs)) {
    return false
  }

  return Date.now() > notification.postedAt + notification.timeoutMs
}
