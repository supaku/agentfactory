/**
 * Top-of-Funnel Triggers
 *
 * Heuristics and trigger logic for auto-research and auto-backlog-creation.
 * Issues in "Icebox" are evaluated to determine whether they need research
 * (fleshing out requirements, acceptance criteria, technical approach) or
 * are already well-researched and ready for backlog creation (decomposition
 * into sub-issues, estimation, etc.).
 *
 * All functions are pure — no side effects, no network calls.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the top-of-funnel governor heuristics.
 */
export interface TopOfFunnelConfig {
  /** Minimum time in Icebox before triggering research (ms). Default: 1 hour */
  iceboxResearchDelayMs: number
  /** Minimum description length to consider "well-researched". Default: 200 */
  minResearchedDescriptionLength: number
  /** Headers that indicate a well-researched issue */
  researchedHeaders: string[]
  /** Labels that explicitly request research */
  researchRequestLabels: string[]
  /** Whether auto-research is enabled. Default: true */
  enableAutoResearch: boolean
  /** Whether auto-backlog-creation is enabled. Default: true */
  enableAutoBacklogCreation: boolean
}

/**
 * Sensible defaults for the top-of-funnel configuration.
 */
export const DEFAULT_TOP_OF_FUNNEL_CONFIG: TopOfFunnelConfig = {
  iceboxResearchDelayMs: 60 * 60 * 1000, // 1 hour
  minResearchedDescriptionLength: 200,
  researchedHeaders: [
    '## Acceptance Criteria',
    '## Technical Approach',
    '## Summary',
    '## Design',
    '## Requirements',
  ],
  researchRequestLabels: ['Needs Research'],
  enableAutoResearch: true,
  enableAutoBacklogCreation: true,
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/**
 * Minimal issue information needed by the top-of-funnel evaluator.
 */
export interface IssueInfo {
  id: string
  identifier: string
  title: string
  description?: string
  status: string
  labels: string[]
  createdAt: number
  parentId?: string
}

/**
 * Discriminated union describing the action the governor should take for an
 * Icebox issue.
 */
export type TopOfFunnelAction =
  | { type: 'trigger-research'; issueId: string; reason: string }
  | { type: 'trigger-backlog-creation'; issueId: string; reason: string }
  | { type: 'none'; issueId: string; reason: string }

// ---------------------------------------------------------------------------
// Context for action determination
// ---------------------------------------------------------------------------

/**
 * External state the caller supplies so the evaluator can avoid re-processing.
 */
export interface TopOfFunnelContext {
  /** Whether there is already an active agent session for this issue */
  hasActiveSession: boolean
  /** Whether the issue is held (e.g., awaiting human input) */
  isHeld: boolean
  /** Whether the research phase was already completed */
  researchCompleted: boolean
  /** Whether the backlog-creation phase was already completed */
  backlogCreationCompleted: boolean
  /** Whether the issue is a parent/coordinator issue */
  isParentIssue: boolean
}

// ---------------------------------------------------------------------------
// Pure evaluation helpers
// ---------------------------------------------------------------------------

/**
 * Check whether an issue description appears well-researched.
 *
 * Heuristic:
 *  - The description must meet a minimum character length **and**
 *  - Contain at least one of the recognised structured headers.
 */
export function isWellResearched(
  description: string | undefined,
  config: TopOfFunnelConfig = DEFAULT_TOP_OF_FUNNEL_CONFIG,
): boolean {
  if (!description) return false

  const meetsLengthThreshold =
    description.length >= config.minResearchedDescriptionLength

  const hasStructuredHeader = config.researchedHeaders.some((header) =>
    description.includes(header),
  )

  return meetsLengthThreshold && hasStructuredHeader
}

/**
 * Check whether an issue needs research.
 *
 * Criteria (all must hold):
 *  1. Issue is in "Icebox" status
 *  2. Description is **not** well-researched (short / missing headers) **or**
 *     the issue carries a research-request label
 *  3. The issue has been in Icebox for longer than the configured delay
 *  4. The issue is not a parent/coordinator issue
 *
 * Note: active-session and hold checks are done in `determineTopOfFunnelAction`
 * so that callers who just want the heuristic can use this function standalone.
 */
export function needsResearch(
  issue: IssueInfo,
  config: TopOfFunnelConfig = DEFAULT_TOP_OF_FUNNEL_CONFIG,
): boolean {
  if (issue.status !== 'Icebox') return false

  // Parent issues use coordination, not individual research
  if (issue.parentId !== undefined) return false

  const ageMs = Date.now() - issue.createdAt
  if (ageMs < config.iceboxResearchDelayMs) return false

  // Explicit research-request label always triggers research
  const hasResearchLabel = issue.labels.some((label) =>
    config.researchRequestLabels.includes(label),
  )
  if (hasResearchLabel) return true

  // Otherwise, only if the description is not well-researched
  return !isWellResearched(issue.description, config)
}

/**
 * Check whether an issue is ready for backlog creation.
 *
 * Criteria (all must hold):
 *  1. Issue is in "Icebox" status
 *  2. Description **is** well-researched (meets length + header heuristic)
 *  3. The issue is not a parent/coordinator issue
 *
 * The `researchCompleted` flag is checked in `determineTopOfFunnelAction`.
 */
export function isReadyForBacklogCreation(
  issue: IssueInfo,
  config: TopOfFunnelConfig = DEFAULT_TOP_OF_FUNNEL_CONFIG,
): boolean {
  if (issue.status !== 'Icebox') return false

  // Parent issues use coordination, not individual backlog creation
  if (issue.parentId !== undefined) return false

  return isWellResearched(issue.description, config)
}

// ---------------------------------------------------------------------------
// Main decision function
// ---------------------------------------------------------------------------

/**
 * Determine the top-of-funnel action for an Icebox issue.
 *
 * Uses workflow / processing state to avoid re-processing issues that have
 * already been through research or backlog creation.
 */
export function determineTopOfFunnelAction(
  issue: IssueInfo,
  config: TopOfFunnelConfig,
  context: TopOfFunnelContext,
): TopOfFunnelAction {
  const none = (reason: string): TopOfFunnelAction => ({
    type: 'none',
    issueId: issue.id,
    reason,
  })

  // --- Guard rails ---

  if (issue.status !== 'Icebox') {
    return none('Issue is not in Icebox status')
  }

  if (context.hasActiveSession) {
    return none('Issue already has an active agent session')
  }

  if (context.isHeld) {
    return none('Issue is held (awaiting human input)')
  }

  if (context.isParentIssue) {
    return none('Parent/coordinator issues are handled via coordination workflow')
  }

  // --- Research evaluation ---

  if (config.enableAutoResearch && !context.researchCompleted) {
    const hasResearchLabel = issue.labels.some((label) =>
      config.researchRequestLabels.includes(label),
    )

    const descriptionNeedsResearch = !isWellResearched(
      issue.description,
      config,
    )

    if (hasResearchLabel || descriptionNeedsResearch) {
      const ageMs = Date.now() - issue.createdAt
      if (ageMs >= config.iceboxResearchDelayMs) {
        const reason = hasResearchLabel
          ? `Issue has research-request label: ${issue.labels.filter((l) => config.researchRequestLabels.includes(l)).join(', ')}`
          : 'Issue description lacks sufficient detail or structured headers'
        return {
          type: 'trigger-research',
          issueId: issue.id,
          reason,
        }
      }
      return none(
        `Issue needs research but has not been in Icebox long enough (${Math.round(ageMs / 1000)}s < ${Math.round(config.iceboxResearchDelayMs / 1000)}s)`,
      )
    }
  }

  if (!config.enableAutoResearch && !context.researchCompleted) {
    // Auto-research is disabled; if the description is sparse we still skip
    // backlog creation since research hasn't been done.
    if (!isWellResearched(issue.description, config)) {
      return none('Auto-research is disabled and issue description is not well-researched')
    }
  }

  // --- Backlog-creation evaluation ---

  if (config.enableAutoBacklogCreation && !context.backlogCreationCompleted) {
    if (isWellResearched(issue.description, config)) {
      return {
        type: 'trigger-backlog-creation',
        issueId: issue.id,
        reason: 'Issue is well-researched and ready for backlog creation',
      }
    }
  }

  // --- Fallthrough ---

  if (context.researchCompleted && context.backlogCreationCompleted) {
    return none('Both research and backlog-creation phases already completed')
  }

  if (context.backlogCreationCompleted) {
    return none('Backlog-creation phase already completed')
  }

  if (!config.enableAutoBacklogCreation) {
    return none('Auto-backlog-creation is disabled')
  }

  return none('No top-of-funnel action needed')
}
