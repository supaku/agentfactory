/**
 * Cross-Session Context Builder
 *
 * Queries past observations from the ObservationStore and builds a
 * concise context block for injection into agent system prompts via
 * the template system.
 *
 * Design principles (from Meta-Harness, Stanford 2026):
 * - Context budget is configurable per work type
 * - Context size is logged alongside session outcomes for Pareto analysis
 * - Session summaries are prioritized over individual observations
 * - Lower-ranked observations are dropped (not truncated mid-observation)
 * - Zero observations → empty string (no error, no placeholder)
 */

import type { Observation } from './observations.js'
import type { ObservationStore, ObservationRetrievalResult } from './observation-store.js'

// ── Context Budget Configuration ─────────────────────────────────────

export interface ContextBudgetConfig {
  /** Default budget in tokens (approximate). Default: 500 */
  default: number
  /** Per-work-type budget overrides */
  perWorkType: {
    bug_fix?: number
    feature?: number
    refactor?: number
    chore?: number
    [key: string]: number | undefined
  }
  /** Maximum observations regardless of token budget. Default: 20 */
  maxObservations: number
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudgetConfig = {
  default: 500,
  perWorkType: {
    bug_fix: 750,
    feature: 400,
    refactor: 600,
    chore: 300,
  },
  maxObservations: 20,
}

// ── Context Injection Log ────────────────────────────────────────────

export interface ContextInjectionLog {
  sessionId: string
  workType: string
  budgetTokens: number
  actualTokens: number
  observationIds: string[]
  sessionSummaryIds: string[]
  queryText: string
  timestamp: string
}

// ── Context Builder Options ──────────────────────────────────────────

export interface ContextBuilderOptions {
  /** ObservationStore to query */
  store: ObservationStore
  /** Budget configuration (optional, uses defaults) */
  budgetConfig?: Partial<ContextBudgetConfig>
  /** Callback to receive injection logs */
  onLog?: (log: ContextInjectionLog) => void
}

export interface ContextBuildRequest {
  /** Current session ID */
  sessionId: string
  /** Project scope (repo path or project name) */
  projectScope: string
  /** Work type for budget selection */
  workType: string
  /** Issue title/description for search query */
  issueContext: string
  /** Optional additional file paths for context */
  filePaths?: string[]
}

// ── Context Builder ──────────────────────────────────────────────────

/**
 * Build a context string from past observations for injection into
 * the agent's system prompt.
 */
export async function buildSessionMemoryContext(
  options: ContextBuilderOptions,
  request: ContextBuildRequest,
): Promise<string> {
  const { store, onLog } = options
  const budgetConfig = {
    ...DEFAULT_CONTEXT_BUDGET,
    ...options.budgetConfig,
    perWorkType: {
      ...DEFAULT_CONTEXT_BUDGET.perWorkType,
      ...options.budgetConfig?.perWorkType,
    },
  }

  // Determine token budget for this work type
  const budgetTokens = budgetConfig.perWorkType[request.workType]
    ?? budgetConfig.default

  // Budget of 0 means memory is effectively disabled
  if (budgetTokens === 0) {
    if (onLog) {
      onLog({
        sessionId: request.sessionId,
        workType: request.workType,
        budgetTokens: 0,
        actualTokens: 0,
        observationIds: [],
        sessionSummaryIds: [],
        queryText: '',
        timestamp: new Date().toISOString(),
      })
    }
    return ''
  }

  // Build search query from issue context
  const queryText = buildSearchQuery(request)

  // Retrieve relevant observations
  const results = await store.retrieve({
    query: queryText,
    projectScope: request.projectScope,
    maxResults: budgetConfig.maxObservations,
  })

  if (results.length === 0) {
    if (onLog) {
      onLog({
        sessionId: request.sessionId,
        workType: request.workType,
        budgetTokens,
        actualTokens: 0,
        observationIds: [],
        sessionSummaryIds: [],
        queryText,
        timestamp: new Date().toISOString(),
      })
    }
    return ''
  }

  // Separate session summaries and individual observations
  const summaries = results.filter(r => r.observation.type === 'session_summary')
  const individual = results.filter(r => r.observation.type !== 'session_summary')

  // Prioritize: summaries first, then individual observations
  const ordered = [...summaries, ...individual]

  // Deduplicate
  const seen = new Set<string>()
  const deduped: ObservationRetrievalResult[] = []
  for (const result of ordered) {
    if (!seen.has(result.observation.id)) {
      seen.add(result.observation.id)
      deduped.push(result)
    }
  }

  // Build context block, respecting token budget
  const contextLines: string[] = []
  let tokenEstimate = 0
  const includedIds: string[] = []
  const includedSummaryIds: string[] = []

  for (const result of deduped) {
    const formatted = formatObservation(result.observation)
    const lineTokens = estimateTokens(formatted)

    // Would this exceed the budget?
    if (tokenEstimate + lineTokens > budgetTokens && contextLines.length > 0) {
      break // Drop remaining (don't truncate mid-observation)
    }

    contextLines.push(formatted)
    tokenEstimate += lineTokens
    includedIds.push(result.observation.id)
    if (result.observation.type === 'session_summary') {
      includedSummaryIds.push(result.observation.id)
    }
  }

  // Emit injection log
  if (onLog) {
    onLog({
      sessionId: request.sessionId,
      workType: request.workType,
      budgetTokens,
      actualTokens: tokenEstimate,
      observationIds: includedIds,
      sessionSummaryIds: includedSummaryIds,
      queryText,
      timestamp: new Date().toISOString(),
    })
  }

  if (contextLines.length === 0) return ''

  return contextLines.join('\n\n')
}

// ── Formatting ───────────────────────────────────────────────────────

function formatObservation(observation: Observation): string {
  const date = new Date(observation.timestamp).toISOString().slice(0, 10)
  const sourceTag = observation.source === 'explicit' ? ' [explicit]' : ''
  const typeLabel = formatTypeLabel(observation.type)

  const parts: string[] = [
    `**${typeLabel}** (${date}, session: ${observation.sessionId.slice(0, 8)}${sourceTag})`,
  ]

  // Add content
  parts.push(observation.content)

  return parts.join('\n')
}

function formatTypeLabel(type: string): string {
  switch (type) {
    case 'session_summary': return 'Session Summary'
    case 'file_operation': return 'File Operation'
    case 'error_encountered': return 'Error'
    case 'decision': return 'Decision'
    case 'pattern_discovered': return 'Pattern'
    default: return type
  }
}

// ── Query Building ───────────────────────────────────────────────────

function buildSearchQuery(request: ContextBuildRequest): string {
  const parts: string[] = []
  if (request.issueContext) {
    parts.push(request.issueContext)
  }
  if (request.filePaths && request.filePaths.length > 0) {
    parts.push(request.filePaths.join(' '))
  }
  return parts.join(' ').slice(0, 500) // Limit query length
}

// ── Token Estimation ─────────────────────────────────────────────────

/**
 * Rough token estimation: ~4 chars per token on average.
 * This is approximate but sufficient for budget enforcement.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
