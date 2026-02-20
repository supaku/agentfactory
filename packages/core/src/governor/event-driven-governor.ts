/**
 * Event-Driven Governor
 *
 * Wraps the existing decision engine with an event-driven processing loop
 * and a periodic poll safety net. This is a hybrid model: real-time events
 * (from webhooks) trigger immediate evaluation, while a configurable poll
 * sweep ensures nothing is missed even if an event is lost.
 *
 * The EventDrivenGovernor does NOT replace WorkflowGovernor. Instead, it
 * provides an alternative execution model that can react to events in
 * real time while still benefiting from periodic full scans.
 */

import type { GovernorEventBus } from './event-bus.js'
import type { EventDeduplicator } from './event-deduplicator.js'
import type {
  GovernorEvent,
  CommentAddedEvent,
  PollSnapshotEvent,
} from './event-types.js'
import { eventDedupKey, eventTimestamp } from './event-types.js'
import type { GovernorConfig, GovernorIssue } from './governor-types.js'
import { DEFAULT_GOVERNOR_CONFIG } from './governor-types.js'
import { decideAction, type DecisionContext } from './decision-engine.js'
import type { GovernorDependencies } from './governor.js'
import { parseOverrideDirective, type CommentInfo } from './override-parser.js'
import { setOverrideState, clearOverrideState } from './human-touchpoints.js'

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const log = {
  info: (msg: string, data?: Record<string, unknown>) =>
    console.log(`[event-governor] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) =>
    console.warn(`[event-governor] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) =>
    console.error(`[event-governor] ${msg}`, data ? JSON.stringify(data) : ''),
  debug: (_msg: string, _data?: Record<string, unknown>) => {},
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default poll interval for the safety-net sweep (5 minutes) */
const DEFAULT_POLL_INTERVAL_MS = 300_000

/**
 * Configuration for the EventDrivenGovernor.
 * Extends the base GovernorConfig with event-bus-specific options.
 */
export interface EventDrivenGovernorConfig extends GovernorConfig {
  /** The event bus used to receive and publish events */
  eventBus: GovernorEventBus
  /** Optional deduplicator to prevent processing the same event twice */
  deduplicator?: EventDeduplicator
  /** Poll interval for the safety-net sweep in milliseconds (default: 300000 = 5 min) */
  pollIntervalMs?: number
  /** Enable periodic poll sweep (default: true) */
  enablePolling?: boolean
}

// ---------------------------------------------------------------------------
// EventDrivenGovernor
// ---------------------------------------------------------------------------

/**
 * Hybrid event-driven + poll-based governor.
 *
 * Listens for events on the GovernorEventBus and processes them through the
 * decision engine. Optionally runs a periodic poll sweep that publishes
 * PollSnapshotEvents for every issue, ensuring eventual consistency even
 * if a webhook event is lost.
 *
 * Usage:
 * ```ts
 * const governor = new EventDrivenGovernor(config, deps)
 * await governor.start()
 * // ... governor processes events until stopped
 * await governor.stop()
 * ```
 */
export class EventDrivenGovernor {
  private readonly config: EventDrivenGovernorConfig
  private readonly deps: GovernorDependencies
  private readonly eventBus: GovernorEventBus
  private readonly deduplicator: EventDeduplicator | null
  private running = false
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private eventLoopPromise: Promise<void> | null = null

  constructor(config: EventDrivenGovernorConfig, deps: GovernorDependencies) {
    this.config = { ...DEFAULT_GOVERNOR_CONFIG, ...config }
    this.deps = deps
    this.eventBus = config.eventBus
    this.deduplicator = config.deduplicator ?? null
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start the event-driven governor.
   *
   * Begins consuming events from the event bus and optionally starts a
   * periodic poll sweep timer. The event loop runs until `stop()` is called.
   */
  async start(): Promise<void> {
    if (this.running) {
      log.warn('Event-driven governor is already running')
      return
    }

    this.running = true

    log.info('Event-driven governor started', {
      projects: this.config.projects,
      enablePolling: this.config.enablePolling !== false,
      pollIntervalMs: this.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      hasDeduplicator: this.deduplicator !== null,
    })

    // Start the event processing loop (runs in background)
    this.eventLoopPromise = this.runEventLoop()

    // Start the poll safety net if enabled (default: true)
    if (this.config.enablePolling !== false) {
      const intervalMs = this.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
      this.pollTimer = setInterval(() => {
        void this.pollSweep()
      }, intervalMs)
    }
  }

  /**
   * Stop the event-driven governor.
   *
   * Clears the poll timer, closes the event bus (which ends the event loop),
   * and waits for the event loop to finish processing.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      log.warn('Event-driven governor is not running')
      return
    }

    this.running = false

    // Clear the poll timer
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }

    // Close the event bus, which will end the subscribe() async iterable
    await this.eventBus.close()

    // Wait for the event loop to finish
    if (this.eventLoopPromise) {
      await this.eventLoopPromise
      this.eventLoopPromise = null
    }

    log.info('Event-driven governor stopped')
  }

  /**
   * Check if the governor is currently running.
   */
  isRunning(): boolean {
    return this.running
  }

  // -------------------------------------------------------------------------
  // Event Loop
  // -------------------------------------------------------------------------

  /**
   * Main event processing loop. Consumes events from the event bus,
   * deduplicates them, and routes to the appropriate handler.
   *
   * This runs until the event bus is closed (via `stop()`).
   */
  private async runEventLoop(): Promise<void> {
    try {
      for await (const { id, event } of this.eventBus.subscribe()) {
        if (!this.running) {
          break
        }

        try {
          await this.processEvent(id, event)
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err)
          log.error('Error processing event', {
            eventId: id,
            eventType: event.type,
            issueId: event.issueId,
            error: errorMsg,
          })
        }
      }
    } catch (err) {
      // The subscribe() iterable may throw if the bus encounters a fatal error
      if (this.running) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        log.error('Event loop terminated unexpectedly', { error: errorMsg })
      }
    }
  }

  // -------------------------------------------------------------------------
  // Event Processing
  // -------------------------------------------------------------------------

  /**
   * Process a single event from the event bus.
   *
   * Steps:
   * 1. Check for duplicates using the deduplicator (if configured)
   * 2. Route the event to the appropriate handler based on type
   * 3. Acknowledge the event on the bus
   *
   * @param eventId - Transport-assigned event ID for acknowledgement
   * @param event - The governor event to process
   */
  private async processEvent(eventId: string, event: GovernorEvent): Promise<void> {
    // Step 1: Deduplication
    if (this.deduplicator) {
      const dedupKey = eventDedupKey(event)
      const isDuplicate = await this.deduplicator.isDuplicate(dedupKey)
      if (isDuplicate) {
        log.debug('Skipping duplicate event', {
          eventId,
          eventType: event.type,
          issueId: event.issueId,
          dedupKey,
        })
        await this.eventBus.ack(eventId)
        return
      }
    }

    // Step 2: Route by event type
    log.info('Processing event', {
      eventId,
      eventType: event.type,
      issueId: event.issueId,
    })

    switch (event.type) {
      case 'comment-added':
        await this.handleComment(event)
        break

      case 'issue-status-changed':
      case 'session-completed':
      case 'poll-snapshot':
        await this.evaluateAndDispatch(event.issue)
        break
    }

    // Step 3: Acknowledge
    await this.eventBus.ack(eventId)
  }

  // -------------------------------------------------------------------------
  // Comment Handling
  // -------------------------------------------------------------------------

  /**
   * Handle a comment-added event by parsing it for override directives.
   *
   * If a directive is found:
   * - `hold`: Persist the hold state via `setOverrideState`
   * - `resume`: Clear override state and re-evaluate the issue immediately
   * - `priority`: Persist the priority override via `setOverrideState`
   * - Other directives: Persist via `setOverrideState`
   *
   * If no directive is found, the issue is still evaluated (the comment
   * may contain context that affects the decision).
   *
   * @param event - The comment-added event to handle
   */
  private async handleComment(event: CommentAddedEvent): Promise<void> {
    const commentInfo: CommentInfo = {
      id: event.commentId,
      body: event.commentBody,
      userId: event.userId ?? '',
      isBot: false, // Events from the bus are pre-filtered; bot comments are not published
      createdAt: new Date(event.timestamp).getTime(),
    }

    const directive = parseOverrideDirective(commentInfo)

    if (directive) {
      log.info('Override directive found in comment', {
        issueId: event.issueId,
        directiveType: directive.type,
        commentId: event.commentId,
      })

      switch (directive.type) {
        case 'hold':
          await setOverrideState(event.issueId, directive)
          break

        case 'resume':
          await clearOverrideState(event.issueId)
          // Re-evaluate immediately after resuming
          await this.evaluateAndDispatch(event.issue)
          break

        case 'priority':
          await setOverrideState(event.issueId, directive)
          break

        default:
          // skip-qa, decompose, reassign, etc.
          await setOverrideState(event.issueId, directive)
          break
      }
    } else {
      // No directive found, but the comment may contain useful context.
      // Evaluate the issue so the governor can react to any state changes.
      log.debug('No directive in comment, evaluating issue', {
        issueId: event.issueId,
        commentId: event.commentId,
      })
      await this.evaluateAndDispatch(event.issue)
    }
  }

  // -------------------------------------------------------------------------
  // Issue Evaluation
  // -------------------------------------------------------------------------

  /**
   * Evaluate a single issue and dispatch work if the decision engine
   * determines an action is needed.
   *
   * Gathers all context in parallel (same approach as WorkflowGovernor),
   * runs the decision engine, and dispatches if the action is not 'none'.
   *
   * @param issue - The issue to evaluate
   */
  private async evaluateAndDispatch(issue: GovernorIssue): Promise<void> {
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

    const decision = decideAction(ctx)

    if (decision.action === 'none') {
      log.debug('No action for issue', {
        issueId: issue.id,
        identifier: issue.identifier,
        reason: decision.reason,
      })
      return
    }

    log.info('Dispatching action', {
      issueId: issue.id,
      identifier: issue.identifier,
      action: decision.action,
      reason: decision.reason,
    })

    await this.deps.dispatchWork(issue.id, decision.action)
  }

  // -------------------------------------------------------------------------
  // Poll Sweep
  // -------------------------------------------------------------------------

  /**
   * Run a full poll sweep across all configured projects.
   *
   * For each project, lists all issues and publishes a PollSnapshotEvent
   * for each one. These events flow through the normal event loop and
   * are subject to deduplication, ensuring that issues already processed
   * via webhook events are not re-evaluated unnecessarily.
   *
   * This method is called periodically by the poll timer and can also
   * be invoked manually for testing.
   */
  async pollSweep(): Promise<void> {
    log.info('Starting poll sweep', {
      projects: this.config.projects,
    })

    let totalIssues = 0

    for (const project of this.config.projects) {
      try {
        const issues = await this.deps.listIssues(project)
        totalIssues += issues.length

        for (const issue of issues) {
          const event: PollSnapshotEvent = {
            type: 'poll-snapshot',
            issueId: issue.id,
            issue,
            project,
            timestamp: eventTimestamp(),
            source: 'poll',
          }

          await this.eventBus.publish(event)
        }

        log.debug('Poll sweep published events for project', {
          project,
          issueCount: issues.length,
        })
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        log.error('Poll sweep failed for project', {
          project,
          error: errorMsg,
        })
      }
    }

    log.info('Poll sweep complete', {
      projects: this.config.projects,
      totalIssues,
    })
  }
}
