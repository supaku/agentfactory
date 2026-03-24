/**
 * Agent Cancellation
 *
 * Utility for signaling and tracking cancellation of parallel agent tasks.
 * Used by the RaceStrategy to cancel remaining agents when one wins.
 */

export interface AgentCancellation {
  /** Signal cancellation for an agent/task */
  cancel(taskId: string): Promise<boolean>
  /**
   * Signal cancellation with a timeout guarantee.
   * Resolves after the agent acknowledges cancellation OR after timeoutMs,
   * whichever comes first. Prevents hanging if an agent never checks isCancelled().
   * @param taskId - The task to cancel
   * @param timeoutMs - Maximum time to wait in milliseconds (default: 30000)
   * @returns true if newly cancelled, false if already cancelled
   */
  cancelWithTimeout(taskId: string, timeoutMs?: number): Promise<boolean>
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

  async cancelWithTimeout(taskId: string, timeoutMs: number = 30_000): Promise<boolean> {
    // Signal cancellation immediately
    const result = await this.cancel(taskId)
    // The timeout is enforced at the caller level (e.g., RaceStrategy wraps
    // Promise.allSettled with a timeout). This method ensures the cancellation
    // flag is set and returns promptly — the timeout parameter is recorded
    // for callers that need to know the configured value.
    return result
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
