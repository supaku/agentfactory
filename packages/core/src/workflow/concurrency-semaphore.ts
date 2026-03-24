/**
 * Concurrency Semaphore
 *
 * Limits the number of concurrent operations. When the limit is reached,
 * subsequent acquire() calls wait until a slot is released.
 */
export class ConcurrencySemaphore {
  private current = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly maxConcurrent: number) {
    if (maxConcurrent < 1) {
      throw new Error('maxConcurrent must be at least 1')
    }
  }

  /** Current number of active slots */
  get activeCount(): number {
    return this.current
  }

  /** Number of waiters in the queue */
  get waitingCount(): number {
    return this.waiters.length
  }

  /** Acquire a slot. Resolves when a slot is available. */
  async acquire(): Promise<void> {
    if (this.current < this.maxConcurrent) {
      this.current++
      return
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.current++
        resolve()
      })
    })
  }

  /** Release a slot. Wakes up the next waiter if any. */
  release(): void {
    this.current--
    if (this.waiters.length > 0) {
      const next = this.waiters.shift()!
      next()
    }
  }
}
