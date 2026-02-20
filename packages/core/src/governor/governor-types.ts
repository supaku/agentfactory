/**
 * Governor Types
 *
 * Core type definitions for the Workflow Governor scan loop.
 * The Governor periodically scans Linear projects and dispatches
 * agent work based on issue status and configuration.
 */

import type { TopOfFunnelConfig } from './top-of-funnel.js'

// ---------------------------------------------------------------------------
// Governor Actions
// ---------------------------------------------------------------------------

/**
 * Actions the Governor can take for a given issue.
 *
 * Each action maps to an agent work type or special handling:
 * - trigger-research: Dispatch a research agent (Icebox, sparse description)
 * - trigger-backlog-creation: Dispatch a backlog-creation agent (Icebox, well-researched)
 * - trigger-development: Dispatch a development agent (Backlog)
 * - trigger-qa: Dispatch a QA agent (Finished)
 * - trigger-acceptance: Dispatch an acceptance agent (Delivered)
 * - trigger-refinement: Dispatch a refinement agent (Rejected)
 * - decompose: Trigger task decomposition (escalation strategy)
 * - escalate-human: Create a human escalation touchpoint
 * - none: No action needed
 */
export type GovernorAction =
  | 'trigger-research'
  | 'trigger-backlog-creation'
  | 'trigger-development'
  | 'trigger-qa'
  | 'trigger-acceptance'
  | 'trigger-refinement'
  | 'decompose'
  | 'escalate-human'
  | 'none'

// ---------------------------------------------------------------------------
// Governor Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the Workflow Governor scan loop.
 */
export interface GovernorConfig {
  /** Projects to scan */
  projects: string[]
  /** Scan interval in milliseconds (default: 60000) */
  scanIntervalMs: number
  /** Maximum concurrent dispatches per scan (default: 3) */
  maxConcurrentDispatches: number
  /** Enable auto-research from Icebox (default: true) */
  enableAutoResearch: boolean
  /** Enable auto-backlog-creation from Icebox (default: true) */
  enableAutoBacklogCreation: boolean
  /** Enable auto-development from Backlog (default: true) */
  enableAutoDevelopment: boolean
  /** Enable auto-QA from Finished (default: true) */
  enableAutoQA: boolean
  /** Enable auto-acceptance from Delivered (default: true) */
  enableAutoAcceptance: boolean
  /** Human response timeout in milliseconds (default: 4 hours) */
  humanResponseTimeoutMs: number
  /** Top-of-funnel configuration overrides */
  topOfFunnel?: Partial<TopOfFunnelConfig>
}

/**
 * Sensible defaults for the Governor configuration.
 */
export const DEFAULT_GOVERNOR_CONFIG: GovernorConfig = {
  projects: [],
  scanIntervalMs: 60_000,
  maxConcurrentDispatches: 3,
  enableAutoResearch: false,
  enableAutoBacklogCreation: false,
  enableAutoDevelopment: true,
  enableAutoQA: true,
  enableAutoAcceptance: true,
  humanResponseTimeoutMs: 4 * 60 * 60 * 1000, // 4 hours
}

// ---------------------------------------------------------------------------
// Scan Result
// ---------------------------------------------------------------------------

/**
 * Result of a single project scan pass.
 */
export interface ScanResult {
  project: string
  scannedIssues: number
  actionsDispatched: number
  skippedReasons: Map<string, string>
  errors: Array<{ issueId: string; error: string }>
}

// ---------------------------------------------------------------------------
// Governor Issue
// ---------------------------------------------------------------------------

/**
 * Minimal issue representation used by the Governor.
 * Intentionally decoupled from the Linear SDK types so the Governor
 * can be tested and used with any issue source.
 */
export interface GovernorIssue {
  id: string
  identifier: string
  title: string
  description?: string
  status: string
  labels: string[]
  createdAt: number
  parentId?: string
  project?: string
}
