/**
 * In-Memory Event Bus
 *
 * Simple event bus implementation for testing and single-process CLI usage.
 * Events are stored in a queue and delivered via an async generator.
 */

import type { GovernorEvent } from './event-types.js'
import type { GovernorEventBus } from './event-bus.js'

// ---------------------------------------------------------------------------
// InMemoryEventBus
// ---------------------------------------------------------------------------

export class InMemoryEventBus implements GovernorEventBus {
  private queue: Array<{ id: string; event: GovernorEvent }> = []
  private waiters: Array<(item: { id: string; event: GovernorEvent }) => void> = []
  private closed = false
  private idCounter = 0
  private ackedIds = new Set<string>()

  async publish(event: GovernorEvent): Promise<string> {
    if (this.closed) {
      throw new Error('Event bus is closed')
    }

    const id = `mem-${++this.idCounter}`
    const item = { id, event }

    // If a subscriber is waiting, deliver directly
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter(item)
    } else {
      this.queue.push(item)
    }

    return id
  }

  async *subscribe(): AsyncGenerator<{ id: string; event: GovernorEvent }> {
    while (!this.closed) {
      // Try to pull from the queue
      const item = this.queue.shift()
      if (item) {
        yield item
        continue
      }

      // Wait for a new event or close
      const next = await new Promise<{ id: string; event: GovernorEvent } | null>(
        (resolve) => {
          if (this.closed) {
            resolve(null)
            return
          }
          this.waiters.push(resolve as (item: { id: string; event: GovernorEvent }) => void)
        },
      )

      if (next === null) {
        return
      }

      yield next
    }
  }

  async ack(eventId: string): Promise<void> {
    this.ackedIds.add(eventId)
  }

  async close(): Promise<void> {
    this.closed = true
    // Resolve all waiting subscribers with null to end iteration
    for (const waiter of this.waiters) {
      ;(waiter as unknown as (v: null) => void)(null)
    }
    this.waiters = []
  }

  // ---- Test helpers ----

  /** Check if an event ID has been acknowledged */
  isAcked(eventId: string): boolean {
    return this.ackedIds.has(eventId)
  }

  /** Get the number of pending (undelivered) events */
  get pendingCount(): number {
    return this.queue.length
  }

  /** Check if the bus has been closed */
  get isClosed(): boolean {
    return this.closed
  }
}
