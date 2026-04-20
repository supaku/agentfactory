/**
 * Session Summary Capture
 *
 * Captures a structured session-level summary when a session completes.
 * Bridges the gap between per-tool-call observations and useful project
 * knowledge by distilling what was learned during a session.
 *
 * Design:
 * - Fires on session completion (success, failure, or cancellation)
 * - Aggregates observations into a structured summary
 * - LLM-free extraction first (from observation metadata)
 * - Stored as a special observation type with higher retrieval weight
 */

import type {
  Observation,
  ObservationSink,
  SessionSummaryDetail,
} from './observations.js'

// ── Session Summary Types ────────────────────────────────────────────

export type SessionOutcome = 'success' | 'failure' | 'partial' | 'cancelled'

export interface SessionEndEvent {
  /** Session identifier */
  sessionId: string
  /** Project scope */
  projectScope: string
  /** How the session ended */
  outcome: SessionOutcome
  /** Brief description of what happened */
  outcomeDescription?: string
  /** All observations captured during this session */
  observations: Observation[]
}

export interface SessionSummaryHookConfig {
  /** Sink to emit the summary observation to */
  sink: ObservationSink
  /** Default weight for session summaries (default: 2.0) */
  summaryWeight?: number
}

// ── Session Summary Hook ─────────────────────────────────────────────

let summaryIdCounter = 0

function generateSummaryId(sessionId: string): string {
  return `summary_${sessionId}_${Date.now()}_${++summaryIdCounter}`
}

/**
 * Create a session summary hook that fires at session end.
 *
 * @example
 * ```typescript
 * const summarize = createSessionSummaryHook({
 *   sink: observationStore,
 * })
 *
 * // Call when session ends
 * await summarize({
 *   sessionId: 'session-123',
 *   projectScope: 'github.com/org/repo',
 *   outcome: 'success',
 *   observations: collectedObservations,
 * })
 * ```
 */
export function createSessionSummaryHook(
  config: SessionSummaryHookConfig,
): (event: SessionEndEvent) => Promise<Observation | null> {
  const { sink, summaryWeight = 2.0 } = config

  return async (event: SessionEndEvent): Promise<Observation | null> => {
    try {
      const summary = buildSessionSummary(event, summaryWeight)
      await sink.emit(summary)
      return summary
    } catch {
      // Never propagate errors from summary generation
      return null
    }
  }
}

// ── Summary Builder ──────────────────────────────────────────────────

/**
 * Build a session summary observation from the session's observations.
 */
export function buildSessionSummary(
  event: SessionEndEvent,
  weight: number = 2.0,
): Observation {
  const { sessionId, projectScope, outcome, outcomeDescription, observations } = event

  // Extract components from observations
  const filesChanged = extractFilesChanged(observations)
  const keyDecision = extractKeyDecision(observations)
  const keyLearning = extractKeyLearning(observations)
  const pitfalls = extractPitfalls(observations)

  const description = outcomeDescription ?? buildOutcomeDescription(outcome, observations)

  const detail: SessionSummaryDetail = {
    outcome,
    outcomeDescription: description,
    keyDecision: keyDecision ?? undefined,
    keyLearning: keyLearning ?? undefined,
    filesChanged: filesChanged.length > 0 ? filesChanged : undefined,
    pitfalls: pitfalls.length > 0 ? pitfalls : undefined,
  }

  // Build human-readable content for search indexing
  const contentParts: string[] = [
    `Session ${outcome}: ${description}`,
  ]
  if (keyDecision) contentParts.push(`Decision: ${keyDecision}`)
  if (keyLearning) contentParts.push(`Learning: ${keyLearning}`)
  if (filesChanged.length > 0) {
    contentParts.push(`Files: ${filesChanged.map(f => f.filePath).join(', ')}`)
  }
  if (pitfalls.length > 0) {
    contentParts.push(`Pitfalls: ${pitfalls.join('; ')}`)
  }

  return {
    id: generateSummaryId(sessionId),
    type: 'session_summary',
    content: contentParts.join('\n'),
    sessionId,
    projectScope,
    timestamp: Date.now(),
    source: 'auto_capture',
    weight,
    detail,
    tags: ['session_summary', outcome],
  }
}

// ── Extraction Helpers ───────────────────────────────────────────────

function extractFilesChanged(
  observations: Observation[],
): Array<{ filePath: string; changeSummary: string }> {
  const fileMap = new Map<string, string[]>()

  for (const obs of observations) {
    if (obs.type !== 'file_operation' || !obs.detail) continue
    const detail = obs.detail as { filePath?: string; operationType?: string; summary?: string }
    if (!detail.filePath || detail.filePath === '.') continue

    // Only track write/edit operations as "changes"
    if (detail.operationType !== 'write' && detail.operationType !== 'edit') continue

    const existing = fileMap.get(detail.filePath) ?? []
    existing.push(detail.summary ?? detail.operationType ?? 'modified')
    fileMap.set(detail.filePath, existing)
  }

  return Array.from(fileMap.entries()).map(([filePath, summaries]) => ({
    filePath,
    changeSummary: summaries.join('; '),
  }))
}

function extractKeyDecision(observations: Observation[]): string | null {
  // Look for decision-type observations
  const decisions = observations.filter(obs => obs.type === 'decision')
  if (decisions.length > 0) {
    const lastDecision = decisions[decisions.length - 1]
    const detail = lastDecision.detail as { chosen?: string; reason?: string } | undefined
    if (detail?.chosen) {
      return `${detail.chosen}${detail.reason ? ` — ${detail.reason}` : ''}`
    }
    return lastDecision.content
  }
  return null
}

function extractKeyLearning(observations: Observation[]): string | null {
  // Look for pattern_discovered observations
  const patterns = observations.filter(obs => obs.type === 'pattern_discovered')
  if (patterns.length > 0) {
    return patterns[patterns.length - 1].content
  }
  return null
}

function extractPitfalls(observations: Observation[]): string[] {
  return observations
    .filter(obs => obs.type === 'error_encountered')
    .map(obs => {
      const detail = obs.detail as { error?: string; fix?: string } | undefined
      if (detail?.error) {
        return detail.fix ? `${detail.error} (fix: ${detail.fix})` : detail.error
      }
      return obs.content
    })
    .slice(-5) // Keep last 5 errors at most
}

function buildOutcomeDescription(outcome: SessionOutcome, observations: Observation[]): string {
  const fileOps = observations.filter(obs => obs.type === 'file_operation')
  const errors = observations.filter(obs => obs.type === 'error_encountered')
  const writeOps = fileOps.filter(obs => {
    const detail = obs.detail as { operationType?: string } | undefined
    return detail?.operationType === 'write' || detail?.operationType === 'edit'
  })

  switch (outcome) {
    case 'success':
      return `Completed with ${writeOps.length} file changes, ${observations.length} total operations`
    case 'failure':
      return `Failed after ${observations.length} operations with ${errors.length} errors`
    case 'partial':
      return `Partially completed: ${writeOps.length} file changes, ${errors.length} errors`
    case 'cancelled':
      return `Cancelled after ${observations.length} operations`
  }
}

/**
 * Reset the internal ID counter (for testing only).
 */
export function resetSummaryIdCounter(): void {
  summaryIdCounter = 0
}
