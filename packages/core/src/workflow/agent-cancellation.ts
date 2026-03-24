/**
 * Agent Cancellation
 *
 * Utility for signaling and tracking cancellation of parallel agent tasks.
 * Used by the RaceStrategy to cancel remaining agents when one wins.
 */

export interface AgentCancellation {
  /** Signal cancellation for an agent/task */
  cancel(taskId: string): Promise<boolean>
  /** Check if a task has been cancelled */
  isCancelled(taskId: string): boolean
}

/**
 * In-memory cancellation tracker.
 * In production, this would be backed by a shared state store (Redis, etc.)
 * to coordinate cancellation across processes.
 */
export class InMemoryAgentCancellation implements AgentCancellation {
  private readonly cancelled = new Set<string>()

  async cancel(taskId: string): Promise<boolean> {
    if (this.cancelled.has(taskId)) {
      return false // already cancelled
    }
    this.cancelled.add(taskId)
    return true
  }

  isCancelled(taskId: string): boolean {
    return this.cancelled.has(taskId)
  }

  /** Get all cancelled task IDs */
  getCancelledIds(): string[] {
    return [...this.cancelled]
  }

  /** Reset all cancellation state */
  reset(): void {
    this.cancelled.clear()
  }
}
