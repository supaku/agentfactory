/**
 * Agent Tracking Module
 *
 * Tracks which issues the agent has worked on to enable automated QA pickup.
 * Also tracks QA attempts to prevent infinite loops.
 */

import { redisSet, redisGet, redisExists, redisDel } from './redis.js'

const log = {
  info: (msg: string, data?: Record<string, unknown>) => console.log(`[tracking] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) => console.warn(`[tracking] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) => console.error(`[tracking] ${msg}`, data ? JSON.stringify(data) : ''),
  debug: (_msg: string, _data?: Record<string, unknown>) => {},
}

// Redis key prefixes
const AGENT_WORKED_PREFIX = 'agent:worked:'
const QA_ATTEMPT_PREFIX = 'qa:attempt:'
const QA_FAILED_PREFIX = 'qa:failed:'
const DEV_QUEUED_PREFIX = 'agent:dev-queued:'
const ACCEPTANCE_QUEUED_PREFIX = 'agent:acceptance-queued:'
const WORKFLOW_STATE_PREFIX = 'workflow:state:'

// TTLs in seconds
const AGENT_WORKED_TTL = 7 * 24 * 60 * 60 // 7 days
const QA_ATTEMPT_TTL = 24 * 60 * 60 // 24 hours
const QA_FAILED_TTL = 60 * 60 // 1 hour
const DEV_QUEUED_TTL = 10 // 10 seconds - just enough to prevent duplicate webhooks
const ACCEPTANCE_QUEUED_TTL = 10 // 10 seconds - just enough to prevent duplicate webhooks
const WORKFLOW_STATE_TTL = 30 * 24 * 60 * 60 // 30 days

/**
 * Record of an issue that was worked on by an agent
 */
export interface AgentWorkRecord {
  issueId: string
  issueIdentifier: string
  completedAt: number
  sessionId: string
  prUrl?: string
}

/**
 * Record of QA attempts for an issue
 */
export interface QAAttemptRecord {
  issueId: string
  attemptNumber: number
  startedAt: number
  sessionId: string
  previousAttempts: Array<{
    sessionId: string
    failedAt: number
    reason?: string
  }>
}

/**
 * Escalation strategy computed deterministically from cycleCount.
 * No LLM in the decision loop — pure function.
 */
export type EscalationStrategy = 'normal' | 'context-enriched' | 'decompose' | 'escalate-human'

/**
 * Workflow phase types
 */
export type WorkflowPhase = 'development' | 'qa' | 'refinement' | 'acceptance'

/**
 * Record of a single phase attempt within a workflow cycle
 */
export interface PhaseRecord {
  attempt: number
  sessionId?: string
  startedAt: number
  completedAt?: number
  result?: 'passed' | 'failed' | 'unknown'
  failureReason?: string
  costUsd?: number
}

/**
 * Cross-phase workflow state for an issue.
 * Tracks the full dev-QA-rejected cycle count and accumulated failure context.
 * Higher-level overlay on top of the existing QAAttemptRecord.
 */
export interface WorkflowState {
  issueId: string
  issueIdentifier: string
  cycleCount: number
  phases: {
    development: PhaseRecord[]
    qa: PhaseRecord[]
    refinement: PhaseRecord[]
    acceptance: PhaseRecord[]
  }
  strategy: EscalationStrategy
  failureSummary: string | null
  createdAt: number
  updatedAt: number
}

/**
 * Compute escalation strategy deterministically from cycle count.
 * Pure function — no side effects, no LLM.
 */
export function computeStrategy(cycleCount: number): EscalationStrategy {
  if (cycleCount <= 1) return 'normal'
  if (cycleCount === 2) return 'context-enriched'
  if (cycleCount === 3) return 'decompose'
  return 'escalate-human'
}

/**
 * Get the workflow state for an issue
 */
export async function getWorkflowState(issueId: string): Promise<WorkflowState | null> {
  const key = `${WORKFLOW_STATE_PREFIX}${issueId}`
  return redisGet<WorkflowState>(key)
}

/**
 * Update (partial merge) the workflow state for an issue.
 * Creates the state if it doesn't exist.
 */
export async function updateWorkflowState(
  issueId: string,
  partial: Partial<Omit<WorkflowState, 'issueId'>> & { issueIdentifier?: string }
): Promise<WorkflowState> {
  const key = `${WORKFLOW_STATE_PREFIX}${issueId}`
  const existing = await redisGet<WorkflowState>(key)

  const state: WorkflowState = {
    issueId,
    issueIdentifier: partial.issueIdentifier ?? existing?.issueIdentifier ?? '',
    cycleCount: partial.cycleCount ?? existing?.cycleCount ?? 0,
    phases: {
      development: partial.phases?.development ?? existing?.phases?.development ?? [],
      qa: partial.phases?.qa ?? existing?.phases?.qa ?? [],
      refinement: partial.phases?.refinement ?? existing?.phases?.refinement ?? [],
      acceptance: partial.phases?.acceptance ?? existing?.phases?.acceptance ?? [],
    },
    strategy: partial.strategy ?? existing?.strategy ?? 'normal',
    failureSummary: partial.failureSummary !== undefined ? partial.failureSummary : (existing?.failureSummary ?? null),
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  }

  await redisSet(key, state, WORKFLOW_STATE_TTL)
  return state
}

/**
 * Record a phase attempt in the workflow state
 */
export async function recordPhaseAttempt(
  issueId: string,
  phase: WorkflowPhase,
  record: PhaseRecord
): Promise<WorkflowState> {
  const existing = await getWorkflowState(issueId)
  const phases = existing?.phases ?? { development: [], qa: [], refinement: [], acceptance: [] }
  phases[phase] = [...phases[phase], record]

  return updateWorkflowState(issueId, { phases })
}

/**
 * Increment the dev-QA-rejected cycle count and recompute strategy.
 * Called when QA or acceptance fails and triggers a Rejected transition.
 */
export async function incrementCycleCount(issueId: string): Promise<WorkflowState> {
  const existing = await getWorkflowState(issueId)
  const newCount = (existing?.cycleCount ?? 0) + 1
  const strategy = computeStrategy(newCount)

  log.info('Workflow cycle incremented', { issueId, cycleCount: newCount, strategy })
  return updateWorkflowState(issueId, { cycleCount: newCount, strategy })
}

/**
 * Append a failure reason to the accumulated failure summary.
 * Format: --- Cycle {N}, {phase} Attempt {M} ({timestamp}) ---\n{reason}
 */
export async function appendFailureSummary(
  issueId: string,
  newFailure: string
): Promise<WorkflowState> {
  const existing = await getWorkflowState(issueId)
  const currentSummary = existing?.failureSummary ?? ''
  const updatedSummary = currentSummary
    ? `${currentSummary}\n\n${newFailure}`
    : newFailure

  return updateWorkflowState(issueId, { failureSummary: updatedSummary })
}

/**
 * Clear workflow state for an issue (called on acceptance pass)
 */
export async function clearWorkflowState(issueId: string): Promise<void> {
  const key = `${WORKFLOW_STATE_PREFIX}${issueId}`
  await redisDel(key)
  log.info('Cleared workflow state', { issueId })
}

/**
 * Extract a structured failure reason from an agent's result message.
 * Strips boilerplate and keeps the substantive failure description.
 */
export function extractFailureReason(resultMessage: string | undefined): string {
  if (!resultMessage) return 'No result message provided'

  // Try to extract from structured sections
  const failurePatterns = [
    /##\s*(?:QA\s+)?(?:Failed|Failure|Issues?\s+Found)[^\n]*\n([\s\S]*?)(?=\n##|\n<!--|\Z)/i,
    /(?:Fail(?:ure|ed)\s+(?:Reason|Details?|Summary)):?\s*([\s\S]*?)(?=\n##|\n<!--|\Z)/i,
    /(?:Issues?\s+Found|Problems?\s+Found):?\s*([\s\S]*?)(?=\n##|\n<!--|\Z)/i,
  ]

  for (const pattern of failurePatterns) {
    const match = resultMessage.match(pattern)
    if (match?.[1]) {
      const extracted = match[1].trim()
      if (extracted.length > 20) {
        // Truncate if excessively long
        return extracted.length > 2000 ? extracted.slice(0, 2000) + '...' : extracted
      }
    }
  }

  // Fallback: take the last meaningful paragraph (often the conclusion)
  const paragraphs = resultMessage.split(/\n\n+/).filter(p => p.trim().length > 20)
  if (paragraphs.length > 0) {
    const last = paragraphs[paragraphs.length - 1]!.trim()
    return last.length > 2000 ? last.slice(0, 2000) + '...' : last
  }

  return resultMessage.slice(0, 500)
}

/**
 * Mark an issue as having been worked on by the agent
 */
export async function markAgentWorked(
  issueId: string,
  data: Omit<AgentWorkRecord, 'issueId' | 'completedAt'>
): Promise<void> {
  const key = `${AGENT_WORKED_PREFIX}${issueId}`
  const record: AgentWorkRecord = {
    ...data,
    issueId,
    completedAt: Date.now(),
  }
  await redisSet(key, record, AGENT_WORKED_TTL)
  log.info('Marked agent worked', {
    issueId,
    issueIdentifier: data.issueIdentifier,
  })
}

/**
 * Check if an issue was worked on by the agent
 */
export async function wasAgentWorked(
  issueId: string
): Promise<AgentWorkRecord | null> {
  const key = `${AGENT_WORKED_PREFIX}${issueId}`
  return redisGet<AgentWorkRecord>(key)
}

/**
 * Record a QA attempt for an issue
 */
export async function recordQAAttempt(
  issueId: string,
  sessionId: string
): Promise<QAAttemptRecord> {
  const key = `${QA_ATTEMPT_PREFIX}${issueId}`
  const existing = await redisGet<QAAttemptRecord>(key)

  const record: QAAttemptRecord = {
    issueId,
    attemptNumber: (existing?.attemptNumber ?? 0) + 1,
    startedAt: Date.now(),
    sessionId,
    previousAttempts: existing?.previousAttempts ?? [],
  }

  // Add current attempt to history if this is a retry
  if (existing) {
    record.previousAttempts.push({
      sessionId: existing.sessionId,
      failedAt: Date.now(),
    })
  }

  await redisSet(key, record, QA_ATTEMPT_TTL)
  log.info('Recorded QA attempt', {
    issueId,
    attemptNumber: record.attemptNumber,
  })

  return record
}

/**
 * Get QA attempt count for an issue
 */
export async function getQAAttemptCount(issueId: string): Promise<number> {
  const key = `${QA_ATTEMPT_PREFIX}${issueId}`
  const record = await redisGet<QAAttemptRecord>(key)
  return record?.attemptNumber ?? 0
}

/**
 * Mark an issue as having just failed QA (prevents immediate re-trigger)
 */
export async function markQAFailed(
  issueId: string,
  reason?: string
): Promise<void> {
  const key = `${QA_FAILED_PREFIX}${issueId}`
  await redisSet(key, { failedAt: Date.now(), reason }, QA_FAILED_TTL)
  log.info('Marked QA failed', { issueId, reason })
}

/**
 * Check if an issue just failed QA (within cooldown period)
 */
export async function didJustFailQA(issueId: string): Promise<boolean> {
  const key = `${QA_FAILED_PREFIX}${issueId}`
  return redisExists(key)
}

/**
 * Clear QA failed marker (when issue is fixed and moves to Finished again)
 */
export async function clearQAFailed(issueId: string): Promise<void> {
  const key = `${QA_FAILED_PREFIX}${issueId}`
  await redisDel(key)
  log.debug('Cleared QA failed marker', { issueId })
}

/**
 * Clear agent worked record (e.g., when issue is moved back to Backlog)
 */
export async function clearAgentWorked(issueId: string): Promise<void> {
  const key = `${AGENT_WORKED_PREFIX}${issueId}`
  await redisDel(key)
  log.debug('Cleared agent worked marker', { issueId })
}

/**
 * Clear QA attempt record (e.g., after successful QA)
 */
export async function clearQAAttempts(issueId: string): Promise<void> {
  const key = `${QA_ATTEMPT_PREFIX}${issueId}`
  await redisDel(key)
  log.debug('Cleared QA attempts', { issueId })
}

/**
 * Mark an issue as having development work just queued
 * Prevents rapid re-queuing if status is toggled back and forth
 */
export async function markDevelopmentQueued(issueId: string): Promise<void> {
  const key = `${DEV_QUEUED_PREFIX}${issueId}`
  await redisSet(key, { queuedAt: Date.now() }, DEV_QUEUED_TTL)
  log.info('Marked development queued', { issueId })
}

/**
 * Check if development work was just queued for an issue (within cooldown period)
 */
export async function didJustQueueDevelopment(issueId: string): Promise<boolean> {
  const key = `${DEV_QUEUED_PREFIX}${issueId}`
  return redisExists(key)
}

/**
 * Clear development queued marker
 */
export async function clearDevelopmentQueued(issueId: string): Promise<void> {
  const key = `${DEV_QUEUED_PREFIX}${issueId}`
  await redisDel(key)
  log.debug('Cleared development queued marker', { issueId })
}

/**
 * Mark an issue as having acceptance work just queued
 * Prevents rapid re-queuing if status is toggled back and forth
 */
export async function markAcceptanceQueued(issueId: string): Promise<void> {
  const key = `${ACCEPTANCE_QUEUED_PREFIX}${issueId}`
  await redisSet(key, { queuedAt: Date.now() }, ACCEPTANCE_QUEUED_TTL)
  log.info('Marked acceptance queued', { issueId })
}

/**
 * Check if acceptance work was just queued for an issue (within cooldown period)
 */
export async function didJustQueueAcceptance(issueId: string): Promise<boolean> {
  const key = `${ACCEPTANCE_QUEUED_PREFIX}${issueId}`
  return redisExists(key)
}

/**
 * Clear acceptance queued marker
 */
export async function clearAcceptanceQueued(issueId: string): Promise<void> {
  const key = `${ACCEPTANCE_QUEUED_PREFIX}${issueId}`
  await redisDel(key)
  log.debug('Cleared acceptance queued marker', { issueId })
}

/**
 * Clean up all tracking data for an accepted issue
 * Called after successful acceptance processing to remove all Redis state
 */
export async function cleanupAcceptedIssue(issueId: string): Promise<void> {
  const keysToDelete = [
    `${AGENT_WORKED_PREFIX}${issueId}`,
    `${QA_ATTEMPT_PREFIX}${issueId}`,
    `${QA_FAILED_PREFIX}${issueId}`,
    `${DEV_QUEUED_PREFIX}${issueId}`,
    `${ACCEPTANCE_QUEUED_PREFIX}${issueId}`,
    `${WORKFLOW_STATE_PREFIX}${issueId}`,
  ]

  await Promise.all(keysToDelete.map((key) => redisDel(key)))
  log.info('Cleaned up all tracking data for accepted issue', { issueId })
}
