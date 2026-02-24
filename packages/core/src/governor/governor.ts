/**
 * Workflow Governor
 *
 * Periodically scans Linear projects and dispatches agent work based on
 * issue status and configuration. The Governor is the central scheduler
 * that replaces webhook-driven execution with a polling-based model.
 *
 * The Governor is designed with dependency injection so it can be tested
 * without any external services (Linear, Redis, etc.).
 */

import type {
  GovernorAction,
  GovernorConfig,
  GovernorIssue,
  ScanResult,
} from './governor-types.js'
import { DEFAULT_GOVERNOR_CONFIG } from './governor-types.js'
import { decideAction, type DecisionContext } from './decision-engine.js'
import type { OverridePriority } from './override-parser.js'

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const log = {
  info: (msg: string, data?: Record<string, unknown>) =>
    console.log(`[governor] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) =>
    console.warn(`[governor] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) =>
    console.error(`[governor] ${msg}`, data ? JSON.stringify(data) : ''),
  debug: (_msg: string, _data?: Record<string, unknown>) => {},
}

// ---------------------------------------------------------------------------
// Priority ordering
// ---------------------------------------------------------------------------

/** Map priority to a sort weight (lower = higher priority = dispatched first) */
function priorityWeight(priority: OverridePriority | null): number {
  switch (priority) {
    case 'high':
      return 0
    case 'medium':
      return 1
    case 'low':
      return 2
    default:
      return 3
  }
}

// ---------------------------------------------------------------------------
// Governor Dependencies (callback interface)
// ---------------------------------------------------------------------------

/**
 * Abstract dependencies that the Governor needs to interact with
 * external systems. Callers inject these at construction time.
 *
 * This design keeps the Governor testable and decoupled from
 * concrete implementations (Linear SDK, Redis, etc.).
 */
export interface GovernorDependencies {
  /** List non-terminal issues for a project */
  listIssues: (project: string) => Promise<GovernorIssue[]>
  /** Check if an issue has an active agent session */
  hasActiveSession: (issueId: string) => Promise<boolean>
  /** Check if an issue is within cooldown (e.g., just failed QA) */
  isWithinCooldown: (issueId: string) => Promise<boolean>
  /** Check if an issue is a parent (has sub-issues) */
  isParentIssue: (issueId: string) => Promise<boolean>
  /** Check if an issue has a HOLD override active */
  isHeld: (issueId: string) => Promise<boolean>
  /** Get the PRIORITY override for an issue (high > medium > low) */
  getOverridePriority: (issueId: string) => Promise<OverridePriority | null>
  /** Get the workflow escalation strategy for an issue */
  getWorkflowStrategy: (issueId: string) => Promise<string | undefined>
  /** Check if the research phase has been completed for an issue */
  isResearchCompleted: (issueId: string) => Promise<boolean>
  /** Check if the backlog-creation phase has been completed for an issue */
  isBacklogCreationCompleted: (issueId: string) => Promise<boolean>
  /** Dispatch work for an issue with a specific action */
  dispatchWork: (issue: GovernorIssue, action: GovernorAction) => Promise<void>
}

// ---------------------------------------------------------------------------
// WorkflowGovernor
// ---------------------------------------------------------------------------

/**
 * The Workflow Governor scans projects on a configurable interval,
 * evaluates each issue against the decision engine, and dispatches
 * agent work for actionable issues.
 */
export interface WorkflowGovernorCallbacks {
  onScanComplete?: (results: ScanResult[]) => void
}

export class WorkflowGovernor {
  private readonly config: GovernorConfig
  private readonly deps: GovernorDependencies
  private readonly callbacks: WorkflowGovernorCallbacks
  private intervalHandle: ReturnType<typeof setInterval> | null = null
  private running = false
  private scanning = false

  constructor(config: Partial<GovernorConfig>, deps: GovernorDependencies, callbacks?: WorkflowGovernorCallbacks) {
    this.config = { ...DEFAULT_GOVERNOR_CONFIG, ...config }
    this.deps = deps
    this.callbacks = callbacks ?? {}
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start the scan loop. Runs `scanOnce()` immediately, then repeats
   * on the configured interval.
   */
  start(): void {
    if (this.running) {
      log.warn('Governor is already running')
      return
    }

    this.running = true

    log.info('Governor started', {
      projects: this.config.projects,
      scanIntervalMs: this.config.scanIntervalMs,
      maxConcurrentDispatches: this.config.maxConcurrentDispatches,
    })

    // Run the first scan immediately (fire and forget — errors logged internally)
    void this.scanOnce()

    // Schedule subsequent scans
    this.intervalHandle = setInterval(() => {
      void this.scanOnce()
    }, this.config.scanIntervalMs)
  }

  /**
   * Stop the scan loop gracefully. If a scan is in progress it will
   * finish before the Governor is fully stopped.
   */
  stop(): void {
    if (!this.running) {
      log.warn('Governor is not running')
      return
    }

    this.running = false

    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }

    log.info('Governor stopped')
  }

  /**
   * Check if the Governor is running.
   */
  isRunning(): boolean {
    return this.running
  }

  // -------------------------------------------------------------------------
  // Scan
  // -------------------------------------------------------------------------

  /**
   * Run a single scan pass across all configured projects.
   *
   * For each project:
   * 1. List all non-terminal issues
   * 2. Gather context for each issue (active session, cooldown, etc.)
   * 3. Run the decision engine
   * 4. Dispatch actions up to `maxConcurrentDispatches`
   *
   * Returns an array of ScanResult (one per project).
   */
  async scanOnce(): Promise<ScanResult[]> {
    // Guard against overlapping scans
    if (this.scanning) {
      log.debug('Scan already in progress, skipping')
      return []
    }

    this.scanning = true
    const results: ScanResult[] = []

    try {
      for (const project of this.config.projects) {
        const result = await this.scanProject(project)
        results.push(result)
      }
    } finally {
      this.scanning = false
    }

    this.callbacks.onScanComplete?.(results)

    return results
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /**
   * Scan a single project and dispatch actions.
   *
   * Issues are evaluated in two passes:
   * 1. Evaluate all issues to determine actions and gather priority overrides
   * 2. Sort actionable issues by PRIORITY override (high > medium > low > none)
   *    and dispatch up to `maxConcurrentDispatches`
   */
  private async scanProject(project: string): Promise<ScanResult> {
    const result: ScanResult = {
      project,
      scannedIssues: 0,
      actionsDispatched: 0,
      skippedReasons: new Map<string, string>(),
      errors: [],
    }

    let issues: GovernorIssue[]
    try {
      issues = await this.deps.listIssues(project)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      log.error('Failed to list issues for project', { project, error: errorMsg })
      result.errors.push({ issueId: `project:${project}`, error: errorMsg })
      return result
    }

    result.scannedIssues = issues.length

    log.info('Scanning project', {
      project,
      issueCount: issues.length,
    })

    // Pass 1: Evaluate all issues and gather priority overrides
    const actionable: Array<{
      issue: GovernorIssue
      action: GovernorAction
      reason: string
      priority: OverridePriority | null
    }> = []

    for (const issue of issues) {
      try {
        const [decision, priority] = await Promise.all([
          this.evaluateIssue(issue),
          this.deps.getOverridePriority(issue.id),
        ])

        if (decision.action === 'none') {
          result.skippedReasons.set(issue.identifier, decision.reason)
          continue
        }

        actionable.push({
          issue,
          action: decision.action,
          reason: decision.reason,
          priority,
        })
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        log.error('Error evaluating issue', {
          issueIdentifier: issue.identifier,
          error: errorMsg,
        })
        result.errors.push({ issueId: issue.identifier, error: errorMsg })
      }
    }

    // Pass 2: Sort by priority override (high > medium > low > none)
    actionable.sort((a, b) => priorityWeight(a.priority) - priorityWeight(b.priority))

    // Pass 3: Dispatch up to the limit
    for (const item of actionable) {
      if (result.actionsDispatched >= this.config.maxConcurrentDispatches) {
        log.info('Dispatch limit reached', {
          project,
          limit: this.config.maxConcurrentDispatches,
          dispatched: result.actionsDispatched,
        })
        break
      }

      try {
        await this.deps.dispatchWork(item.issue, item.action)
        result.actionsDispatched++

        log.info('Dispatched action', {
          issueIdentifier: item.issue.identifier,
          action: item.action,
          reason: item.reason,
          priority: item.priority ?? 'none',
        })
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        log.error('Error dispatching issue', {
          issueIdentifier: item.issue.identifier,
          error: errorMsg,
        })
        result.errors.push({ issueId: item.issue.identifier, error: errorMsg })
      }
    }

    log.info('Project scan complete', {
      project,
      scanned: result.scannedIssues,
      dispatched: result.actionsDispatched,
      skipped: result.skippedReasons.size,
      errors: result.errors.length,
    })

    return result
  }

  /**
   * Gather context for a single issue and run it through the decision engine.
   */
  private async evaluateIssue(issue: GovernorIssue): Promise<{ action: GovernorAction; reason: string }> {
    // Gather all context in parallel for efficiency
    const [
      hasActiveSession,
      isWithinCooldown,
      isParentIssue,
      isHeld,
      workflowStrategy,
      researchCompleted,
      backlogCreationCompleted,
    ] = await Promise.all([
      this.deps.hasActiveSession(issue.id),
      this.deps.isWithinCooldown(issue.id),
      this.deps.isParentIssue(issue.id),
      this.deps.isHeld(issue.id),
      this.deps.getWorkflowStrategy(issue.id),
      this.deps.isResearchCompleted(issue.id),
      this.deps.isBacklogCreationCompleted(issue.id),
    ])

    const ctx: DecisionContext = {
      issue,
      config: this.config,
      hasActiveSession,
      isHeld,
      isWithinCooldown,
      isParentIssue,
      workflowStrategy,
      researchCompleted,
      backlogCreationCompleted,
    }

    return decideAction(ctx)
  }
}
