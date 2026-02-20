/**
 * Processing State Tracker
 *
 * Tracks which top-of-funnel processing phases have been completed for each
 * issue to prevent re-processing. The core package defines the types and the
 * storage adapter interface; concrete implementations live in packages/server
 * (e.g., RedisProcessingStateStorage).
 */

// ---------------------------------------------------------------------------
// Phase types
// ---------------------------------------------------------------------------

/**
 * Processing phases tracked by the top-of-funnel governor.
 */
export type ProcessingPhase = 'research' | 'backlog-creation'

/**
 * Record of a completed processing phase for an issue.
 */
export interface ProcessingRecord {
  issueId: string
  phase: ProcessingPhase
  completedAt: number
  sessionId?: string
}

// ---------------------------------------------------------------------------
// Storage adapter interface
// ---------------------------------------------------------------------------

/**
 * Storage adapter for persisting processing state.
 *
 * Implementations must be idempotent — calling `markPhaseCompleted` twice
 * for the same issue+phase is a no-op (overwrites with the latest data).
 *
 * See `RedisProcessingStateStorage` in `packages/server` for the Redis-backed
 * implementation.
 */
export interface ProcessingStateStorage {
  /**
   * Check whether a given phase has already been completed for an issue.
   */
  isPhaseCompleted(issueId: string, phase: ProcessingPhase): Promise<boolean>

  /**
   * Mark a phase as completed for an issue.
   * If the phase was already marked, this overwrites the record.
   */
  markPhaseCompleted(
    issueId: string,
    phase: ProcessingPhase,
    sessionId?: string,
  ): Promise<void>

  /**
   * Clear a phase completion record for an issue.
   * Useful when an issue is re-opened or moved back to Icebox.
   */
  clearPhase(issueId: string, phase: ProcessingPhase): Promise<void>

  /**
   * Retrieve the processing record for a phase, if it exists.
   */
  getPhaseRecord(
    issueId: string,
    phase: ProcessingPhase,
  ): Promise<ProcessingRecord | null>
}

// ---------------------------------------------------------------------------
// In-memory implementation (for testing and local development)
// ---------------------------------------------------------------------------

/**
 * Simple in-memory implementation of `ProcessingStateStorage`.
 * Suitable for tests and single-process local development; not shared across
 * processes.
 */
export class InMemoryProcessingStateStorage implements ProcessingStateStorage {
  private store = new Map<string, ProcessingRecord>()

  private key(issueId: string, phase: ProcessingPhase): string {
    return `${issueId}:${phase}`
  }

  async isPhaseCompleted(
    issueId: string,
    phase: ProcessingPhase,
  ): Promise<boolean> {
    return this.store.has(this.key(issueId, phase))
  }

  async markPhaseCompleted(
    issueId: string,
    phase: ProcessingPhase,
    sessionId?: string,
  ): Promise<void> {
    this.store.set(this.key(issueId, phase), {
      issueId,
      phase,
      completedAt: Date.now(),
      sessionId,
    })
  }

  async clearPhase(issueId: string, phase: ProcessingPhase): Promise<void> {
    this.store.delete(this.key(issueId, phase))
  }

  async getPhaseRecord(
    issueId: string,
    phase: ProcessingPhase,
  ): Promise<ProcessingRecord | null> {
    return this.store.get(this.key(issueId, phase)) ?? null
  }

  /** Clear all records (useful in tests). */
  clear(): void {
    this.store.clear()
  }
}
