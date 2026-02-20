/**
 * Governor Event Bus Interface
 *
 * Defines the contract for event transport between producers (webhooks, poll
 * sweeps) and consumers (EventDrivenGovernor). Implementations include
 * InMemoryEventBus (testing/single-process) and RedisEventBus (production).
 */

import type { GovernorEvent } from './event-types.js'

// ---------------------------------------------------------------------------
// Event Bus Interface
// ---------------------------------------------------------------------------

/**
 * Transport layer for GovernorEvents.
 *
 * - `publish`: Enqueue an event for processing.
 * - `subscribe`: Returns an AsyncIterable that yields events one at a time.
 * - `ack`: Acknowledge successful processing (allows the bus to remove it).
 * - `close`: Gracefully shut down the bus.
 */
export interface GovernorEventBus {
  /**
   * Publish an event to the bus.
   * Returns the event ID assigned by the transport.
   */
  publish(event: GovernorEvent): Promise<string>

  /**
   * Subscribe to events. Returns an AsyncIterable that yields events
   * as they become available. The iterable ends when `close()` is called.
   *
   * Each yielded item includes the transport-assigned event ID for acking.
   */
  subscribe(): AsyncIterable<{ id: string; event: GovernorEvent }>

  /**
   * Acknowledge that an event has been successfully processed.
   * The bus may use this to remove the event from pending state.
   */
  ack(eventId: string): Promise<void>

  /**
   * Gracefully close the bus, ending any active subscriptions.
   */
  close(): Promise<void>
}
