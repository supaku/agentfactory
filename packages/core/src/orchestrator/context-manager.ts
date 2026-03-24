import type { AgentEvent } from '../providers/types.js'
import type { StructuredSummary } from './state-types.js'
import { ArtifactTracker } from './artifact-tracker.js'
import type { ArtifactIndex } from './artifact-tracker.js'
import { SummaryBuilder } from './summary-builder.js'
import { readSummary, writeSummary } from './state-recovery.js'

/**
 * Configuration for the ContextManager
 */
export interface ContextManagerConfig {
  /** Root path of the worktree for file resolution and persistence */
  worktreeRoot: string
  /** Maximum events to buffer between compaction boundaries */
  maxEventBufferSize?: number
}

/**
 * Coordinates ArtifactTracker, SummaryBuilder, and StructuredSummary
 * for context window management during an agent session.
 *
 * Processes all agent events, tracks file operations, and handles
 * compaction boundaries by generating incremental summaries.
 */
export class ContextManager {
  private artifactTracker: ArtifactTracker
  private summaryBuilder: SummaryBuilder
  private currentSummary: StructuredSummary | null
  private eventBuffer: AgentEvent[]
  private worktreeRoot: string
  private maxEventBufferSize: number
  private lastPersistAt: number

  constructor(config: ContextManagerConfig) {
    this.worktreeRoot = config.worktreeRoot
    this.maxEventBufferSize = config.maxEventBufferSize ?? 1000
    this.artifactTracker = new ArtifactTracker(config.worktreeRoot)
    this.summaryBuilder = new SummaryBuilder()
    this.currentSummary = null
    this.eventBuffer = []
    this.lastPersistAt = 0
  }

  /**
   * Process an agent event. Called for every event in the stream.
   * Feeds tool events to ArtifactTracker and buffers events for compaction.
   */
  processEvent(event: AgentEvent): void {
    // Feed tool events to artifact tracker
    if (event.type === 'tool_use' || event.type === 'tool_result') {
      this.artifactTracker.trackEvent(event)
    }

    // Buffer events for potential compaction
    this.eventBuffer.push(event)

    // Cap buffer size to prevent memory issues
    if (this.eventBuffer.length > this.maxEventBufferSize) {
      // Remove oldest events (keep the most recent half)
      this.eventBuffer = this.eventBuffer.slice(
        Math.floor(this.maxEventBufferSize / 2)
      )
    }
  }

  /**
   * Handle a compaction boundary event from the provider.
   * Generates an incremental summary from buffered events and merges
   * it with the existing persisted summary.
   */
  handleCompaction(): void {
    // Summarize the buffered span
    const spanSummary = this.summaryBuilder.summarizeSpan(
      this.eventBuffer,
      this.currentSummary,
      this.artifactTracker.getIndex()
    )

    // Merge with existing summary or use as-is
    if (this.currentSummary) {
      this.currentSummary = this.summaryBuilder.mergeSummaries(
        this.currentSummary,
        spanSummary
      )
    } else {
      this.currentSummary = spanSummary
    }

    // Clear event buffer after compaction
    this.eventBuffer = []

    // Persist both summary and artifacts
    this.persist()
  }

  /**
   * Get the current context injection string for the agent prompt.
   * Returns empty string if no summary exists yet.
   */
  getContextSection(): string {
    if (!this.currentSummary) return ''
    return this.summaryBuilder.toPromptSection(
      this.currentSummary,
      this.artifactTracker.getIndex()
    )
  }

  /**
   * Get the current structured summary (if any)
   */
  getSummary(): StructuredSummary | null {
    return this.currentSummary
  }

  /**
   * Get the current artifact index
   */
  getArtifactIndex(): ArtifactIndex {
    return this.artifactTracker.getIndex()
  }

  /**
   * Persist all state (summary + artifacts) to disk.
   * Uses atomic writes to survive crashes.
   */
  persist(): void {
    if (this.currentSummary) {
      writeSummary(this.worktreeRoot, this.currentSummary)
    }
    this.artifactTracker.persist()
    this.lastPersistAt = Date.now()
  }

  /**
   * Persist if enough time has passed since last persist (debounced).
   * Call this periodically (e.g., on every tool event) to ensure
   * state is saved without excessive I/O.
   *
   * @param intervalMs - Minimum interval between persists (default: 30000ms)
   */
  persistIfStale(intervalMs: number = 30000): void {
    const now = Date.now()
    if (now - this.lastPersistAt >= intervalMs) {
      this.persist()
    }
  }

  /**
   * Load a ContextManager from persisted state (for session resume).
   * Loads both summary.json and artifacts.json from the .agent/ directory.
   */
  static load(worktreeRoot: string): ContextManager {
    const manager = new ContextManager({ worktreeRoot })
    manager.currentSummary = readSummary(worktreeRoot)
    manager.artifactTracker = ArtifactTracker.load(worktreeRoot)
    return manager
  }
}
