/**
 * Gate State Persistence Layer
 *
 * Manages gate lifecycle state for workflow execution gates (signal, timer, webhook).
 * Uses a storage adapter pattern so that packages/core does not depend on
 * packages/server (Redis) directly.
 *
 * Gates are external conditions that can pause workflow phase transitions until
 * a condition is met (e.g., human approval signal, timer expiration, webhook callback).
 */

import type { GateDefinition } from './workflow-types.js'

const log = {
  info: (msg: string, data?: Record<string, unknown>) => console.log(`[gate-state] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) => console.warn(`[gate-state] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) => console.error(`[gate-state] ${msg}`, data ? JSON.stringify(data) : ''),
  debug: (_msg: string, _data?: Record<string, unknown>) => {},
}

// ============================================
// Types
// ============================================

/**
 * Persisted state for a single gate instance tied to an issue
 */
export interface GateState {
  /** The issue this gate is associated with */
  issueId: string
  /** Unique gate name (from GateDefinition) */
  gateName: string
  /** Gate type: signal (external event), timer (time-based), webhook (HTTP callback) */
  gateType: 'signal' | 'timer' | 'webhook'
  /** Current gate status */
  status: 'pending' | 'active' | 'satisfied' | 'timed-out'
  /** When the gate was triggered (phase entered), epoch ms */
  activatedAt: number
  /** When the gate condition was met, epoch ms */
  satisfiedAt?: number
  /** When the timeout fired, epoch ms */
  timedOutAt?: number
  /** Action to take when gate times out */
  timeoutAction?: 'escalate' | 'skip' | 'fail'
  /** What satisfied the gate (comment ID, webhook payload hash, timer ID) */
  signalSource?: string
  /** Authentication token for webhook gates (used to validate incoming callbacks) */
  webhookToken?: string
  /** Duration string from gate definition (e.g., "4h") */
  timeoutDuration?: string
  /** Computed absolute timestamp for timeout deadline, epoch ms */
  timeoutDeadline?: number
}

// ============================================
// Storage Adapter Interface
// ============================================

/**
 * Storage adapter for gate state persistence.
 * Implementations can back this with Redis, in-memory maps, etc.
 */
export interface GateStorage {
  /** Get the state of a specific gate for an issue */
  getGateState(issueId: string, gateName: string): Promise<GateState | null>
  /** Set the state of a specific gate for an issue */
  setGateState(issueId: string, gateName: string, state: GateState): Promise<void>
  /** Get all active (status === 'active') gates for an issue */
  getActiveGates(issueId: string): Promise<GateState[]>
  /** Clear all gate states for an issue */
  clearGateStates(issueId: string): Promise<void>
}

/**
 * In-memory gate storage for testing and local development
 */
export class InMemoryGateStorage implements GateStorage {
  private store = new Map<string, GateState>()

  /** Build a composite key from issueId and gateName */
  private key(issueId: string, gateName: string): string {
    return `${issueId}:${gateName}`
  }

  async getGateState(issueId: string, gateName: string): Promise<GateState | null> {
    return this.store.get(this.key(issueId, gateName)) ?? null
  }

  async setGateState(issueId: string, gateName: string, state: GateState): Promise<void> {
    this.store.set(this.key(issueId, gateName), state)
  }

  async getActiveGates(issueId: string): Promise<GateState[]> {
    const results: GateState[] = []
    for (const [key, state] of this.store) {
      if (key.startsWith(`${issueId}:`) && state.status === 'active') {
        results.push(state)
      }
    }
    return results
  }

  async clearGateStates(issueId: string): Promise<void> {
    const keysToDelete: string[] = []
    for (const key of this.store.keys()) {
      if (key.startsWith(`${issueId}:`)) {
        keysToDelete.push(key)
      }
    }
    for (const key of keysToDelete) {
      this.store.delete(key)
    }
  }
}

// ============================================
// Module-level storage reference
// ============================================

let _storage: GateStorage | null = null

/**
 * Initialize the gate state manager with a storage adapter.
 * Must be called before using gate state management functions.
 */
export function initGateStorage(storage: GateStorage): void {
  _storage = storage
  log.info('Gate storage initialized')
}

/**
 * Get the current storage adapter, throwing if not initialized
 */
function getStorage(): GateStorage {
  if (!_storage) {
    throw new Error('Gate storage not initialized. Call initGateStorage() first.')
  }
  return _storage
}

// ============================================
// Duration Parsing
// ============================================

/**
 * Parse a duration string into milliseconds.
 *
 * Supported formats:
 * - "15s" - seconds
 * - "30m" - minutes
 * - "4h"  - hours
 * - "2d"  - days
 *
 * @param duration - Duration string (e.g., "4h", "30m", "2d", "15s")
 * @returns Duration in milliseconds
 * @throws Error if the duration format is invalid
 */
export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)(s|m|h|d)$/)
  if (!match) {
    throw new Error(`Invalid duration format: "${duration}". Expected format like "4h", "30m", "2d", "15s".`)
  }

  const value = parseInt(match[1], 10)
  const unit = match[2]

  switch (unit) {
    case 's': return value * 1000
    case 'm': return value * 60 * 1000
    case 'h': return value * 60 * 60 * 1000
    case 'd': return value * 24 * 60 * 60 * 1000
    default: throw new Error(`Unknown duration unit: "${unit}"`)
  }
}

// ============================================
// Gate Lifecycle Helpers
// ============================================

/**
 * Activate a gate for an issue, creating an active gate state with a computed
 * timeout deadline (if the gate definition includes a timeout).
 *
 * @param issueId - The issue identifier
 * @param gateDef - The gate definition from the workflow
 * @param storage - The gate storage adapter to use
 * @returns The created GateState
 */
export async function activateGate(
  issueId: string,
  gateDef: GateDefinition,
  storage: GateStorage,
): Promise<GateState> {
  const now = Date.now()

  const state: GateState = {
    issueId,
    gateName: gateDef.name,
    gateType: gateDef.type,
    status: 'active',
    activatedAt: now,
  }

  // Compute timeout deadline if gate has a timeout configuration
  if (gateDef.timeout) {
    state.timeoutAction = gateDef.timeout.action
    state.timeoutDuration = gateDef.timeout.duration
    state.timeoutDeadline = now + parseDuration(gateDef.timeout.duration)
  }

  await storage.setGateState(issueId, gateDef.name, state)
  log.info('Gate activated', { issueId, gateName: gateDef.name, gateType: gateDef.type })

  return state
}

/**
 * Mark a gate as satisfied, recording what source satisfied it.
 *
 * @param issueId - The issue identifier
 * @param gateName - The gate name to satisfy
 * @param source - What satisfied the gate (e.g., comment ID, webhook payload hash, timer ID)
 * @param storage - The gate storage adapter to use
 * @returns The updated GateState, or null if the gate was not found
 */
export async function satisfyGate(
  issueId: string,
  gateName: string,
  source: string,
  storage: GateStorage,
): Promise<GateState | null> {
  const state = await storage.getGateState(issueId, gateName)

  if (!state) {
    log.warn('Cannot satisfy gate: not found', { issueId, gateName })
    return null
  }

  if (state.status !== 'active') {
    log.warn('Cannot satisfy gate: not in active status', { issueId, gateName, status: state.status })
    return null
  }

  state.status = 'satisfied'
  state.satisfiedAt = Date.now()
  state.signalSource = source

  await storage.setGateState(issueId, gateName, state)
  log.info('Gate satisfied', { issueId, gateName, source })

  return state
}

/**
 * Mark a gate as timed-out.
 *
 * @param issueId - The issue identifier
 * @param gateName - The gate name to time out
 * @param storage - The gate storage adapter to use
 * @returns The updated GateState, or null if the gate was not found
 */
export async function timeoutGate(
  issueId: string,
  gateName: string,
  storage: GateStorage,
): Promise<GateState | null> {
  const state = await storage.getGateState(issueId, gateName)

  if (!state) {
    log.warn('Cannot timeout gate: not found', { issueId, gateName })
    return null
  }

  if (state.status !== 'active') {
    log.warn('Cannot timeout gate: not in active status', { issueId, gateName, status: state.status })
    return null
  }

  state.status = 'timed-out'
  state.timedOutAt = Date.now()

  await storage.setGateState(issueId, gateName, state)
  log.info('Gate timed out', { issueId, gateName, timeoutAction: state.timeoutAction })

  return state
}
