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
import { WorkflowRegistry, type WorkflowRegistryConfig } from '../workflow/workflow-registry.js'
import { ParallelismExecutor } from '../workflow/parallelism-executor.js'
import type { ParallelTask, ParallelismResult } from '../workflow/parallelism-types.js'
import { FanOutStrategy, FanInStrategy, RaceStrategy } from '../workflow/strategies/index.js'
import { evaluateTransitions } from '../workflow/transition-engine.js'

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
  /** Count completed agent sessions for an issue (for circuit breaker) */
  getCompletedSessionCount: (issueId: string) => Promise<number>
  /** Dispatch work for an issue with a specific action */
  dispatchWork: (issue: GovernorIssue, action: GovernorAction) => Promise<void>
  /** Get sub-issues for a parent issue (for parallel dispatch) */
  getSubIssues?: (parentId: string) => Promise<GovernorIssue[]>
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
  onScanComplete?: (results: ScanResult[]) => void | Promise<void>
}

export class WorkflowGovernor {
  private readonly config: GovernorConfig
  private readonly deps: GovernorDependencies
  private readonly callbacks: WorkflowGovernorCallbacks
  private readonly workflowRegistry: WorkflowRegistry
  private readonly parallelismExecutor: ParallelismExecutor
  private intervalHandle: ReturnType<typeof setInterval> | null = null
  private running = false
  private scanning = false

  constructor(
    config: Partial<GovernorConfig> & { workflow?: WorkflowRegistryConfig },
    deps: GovernorDependencies,
    callbacks?: WorkflowGovernorCallbacks,
    parallelismExecutor?: ParallelismExecutor,
  ) {
    const { workflow: workflowConfig, ...governorConfig } = config
    this.config = { ...DEFAULT_GOVERNOR_CONFIG, ...governorConfig }
    this.deps = deps
    this.callbacks = callbacks ?? {}
    this.workflowRegistry = WorkflowRegistry.create(workflowConfig)

    // Use the provided executor or create a default one with all strategies registered
    if (parallelismExecutor) {
      this.parallelismExecutor = parallelismExecutor
    } else {
      this.parallelismExecutor = new ParallelismExecutor()
      this.parallelismExecutor.registerStrategy('fan-out', new FanOutStrategy())
      this.parallelismExecutor.registerStrategy('fan-in', new FanInStrategy())
      this.parallelismExecutor.registerStrategy('race', new RaceStrategy())
    }
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

    await this.callbacks.onScanComplete?.(results)

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
        // Handle parallel group dispatch separately
        if (item.action === 'trigger-parallel-group') {
          await this.handleParallelGroupDispatch(item.issue)
          result.actionsDispatched++

          log.info('Dispatched parallel group action', {
            issueIdentifier: item.issue.identifier,
            action: item.action,
            reason: item.reason,
            priority: item.priority ?? 'none',
          })
          continue
        }

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
      completedSessionCount,
    ] = await Promise.all([
      this.deps.hasActiveSession(issue.id),
      this.deps.isWithinCooldown(issue.id),
      this.deps.isParentIssue(issue.id),
      this.deps.isHeld(issue.id),
      this.deps.getWorkflowStrategy(issue.id),
      this.deps.isResearchCompleted(issue.id),
      this.deps.isBacklogCreationCompleted(issue.id),
      this.deps.getCompletedSessionCount(issue.id),
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
      workflowRegistry: this.workflowRegistry,
      completedSessionCount,
    }

    return decideAction(ctx)
  }

  /**
   * Handle dispatching work for a parallel group.
   *
   * Fetches sub-issues for the parent, finds the applicable parallelism group,
   * and executes the group using the ParallelismExecutor.
   */
  private async handleParallelGroupDispatch(issue: GovernorIssue): Promise<void> {
    if (!this.deps.getSubIssues) {
      log.warn('getSubIssues dependency not provided, falling back to normal dispatch')
      return
    }

    const workflow = this.workflowRegistry.getWorkflow()
    if (!workflow?.parallelism) return

    const subIssues = await this.deps.getSubIssues(issue.id)

    // Find the applicable parallelism group.
    // Use the first group whose phases include a phase that can be
    // resolved from the current workflow transitions.
    const group = workflow.parallelism.find(g => g.phases.length > 0)
    if (!group) return

    const tasks: ParallelTask[] = subIssues.map(sub => ({
      id: sub.id,
      issueId: sub.identifier,
      phaseName: group.phases[0]!,
    }))

    const result = await this.parallelismExecutor.execute(
      group,
      tasks,
      async (task) => {
        await this.deps.dispatchWork(
          subIssues.find(s => s.id === task.id)!,
          `trigger-${task.phaseName}` as GovernorAction,
        )
        return {
          id: task.id,
          issueId: task.issueId,
          success: true,
        }
      },
    )

    log.info('Parallel group dispatched', {
      group: group.name,
      strategy: group.strategy,
      completed: result.completed.length,
      failed: result.failed.length,
      cancelled: result.cancelled.length,
    })

    // Propagate result to advance parent issue if group completed successfully
    await this.handleParallelGroupCompletion(issue, result, group)
  }

  /**
   * Handle post-parallel-group completion: if all tasks succeeded,
   * evaluate transitions to advance the parent issue to the next phase.
   */
  private async handleParallelGroupCompletion(
    parentIssue: GovernorIssue,
    result: ParallelismResult,
    group: { name: string; phases: string[] },
  ): Promise<void> {
    // Only advance if the group completed with no failures
    const allSucceeded = result.failed.length === 0 && result.completed.length > 0
      && result.completed.every(t => t.success)

    if (!allSucceeded) {
      log.info('Parallel group has failures, not advancing parent', {
        group: group.name,
        failedCount: result.failed.length,
      })
      return
    }

    // Evaluate the next transition for the parent issue.
    // After a parallel development group completes, the parent
    // should transition based on its next status mapping.
    const nextPhaseResult = evaluateTransitions({
      issue: { ...parentIssue, status: 'Finished' },
      registry: this.workflowRegistry,
      isParentIssue: true,
    })

    if (nextPhaseResult.action !== 'none') {
      log.info('Advancing parent after parallel group completion', {
        issueIdentifier: parentIssue.identifier,
        nextAction: nextPhaseResult.action,
        reason: nextPhaseResult.reason,
      })

      try {
        await this.deps.dispatchWork(parentIssue, nextPhaseResult.action)
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        log.error('Failed to advance parent after parallel group', {
          issueIdentifier: parentIssue.identifier,
          error: errorMsg,
        })
      }
    }
  }
}
