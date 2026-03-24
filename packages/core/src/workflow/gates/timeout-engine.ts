/**
 * Gate Timeout Engine
 *
 * Cross-cutting timeout engine that monitors active gates and determines
 * what action to take when deadlines expire. Every gate type (signal, timer,
 * webhook) can have an optional timeout with an action of 'escalate', 'skip',
 * or 'fail'. This engine is the shared component that checks deadlines and
 * returns the action to take.
 *
 * The main entry point is `processGateTimeouts()`, which is called by the
 * governor on each poll cycle. The lower-level functions (`checkGateTimeout`,
 * `checkAllGateTimeouts`, `resolveTimeoutAction`) are pure and exported for
 * direct use and testability.
 */

import type { GateState, GateStorage } from '../gate-state.js'
import { timeoutGate } from '../gate-state.js'

// ============================================
// Logger
// ============================================

const log = {
  info: (msg: string, data?: Record<string, unknown>) =>
    console.log(`[timeout-engine] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) =>
    console.warn(`[timeout-engine] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) =>
    console.error(`[timeout-engine] ${msg}`, data ? JSON.stringify(data) : ''),
  debug: (_msg: string, _data?: Record<string, unknown>) => {},
}

// ============================================
// Types
// ============================================

/**
 * Result of checking a single gate for timeout.
 * If `timedOut` is false, no action field is present.
 * If `timedOut` is true, `action` indicates what should happen.
 */
export interface TimeoutCheckResult {
  timedOut: boolean
  action?: 'escalate' | 'skip' | 'fail'
}

/**
 * A gate that has been determined to have timed out, paired with
 * the action that should be taken.
 */
export interface TimedOutGate {
  gateState: GateState
  action: 'escalate' | 'skip' | 'fail'
}

/**
 * The resolution produced for a timed-out gate, containing all the
 * information the governor needs to act on the timeout.
 */
export interface TimeoutResolution {
  type: 'escalate' | 'skip' | 'fail'
  issueId: string
  gateName: string
  reason: string
}

// ============================================
// Pure Functions
// ============================================

/**
 * Check whether a single gate has timed out.
 *
 * Pure function that compares the current time against the gate's
 * `timeoutDeadline`. Returns `{ timedOut: false }` if no deadline
 * exists or the deadline has not yet passed.
 *
 * @param gateState - The gate state to check
 * @param now - Current time in epoch ms (defaults to Date.now() for testability)
 * @returns The timeout check result
 */
export function checkGateTimeout(gateState: GateState, now?: number): TimeoutCheckResult {
  const currentTime = now ?? Date.now()

  // No deadline configured — cannot time out
  if (gateState.timeoutDeadline == null) {
    return { timedOut: false }
  }

  // Deadline has not passed yet
  if (currentTime < gateState.timeoutDeadline) {
    return { timedOut: false }
  }

  // Deadline has expired — return the configured action (default to 'fail')
  return {
    timedOut: true,
    action: gateState.timeoutAction ?? 'fail',
  }
}

/**
 * Check multiple gates for timeouts.
 *
 * Pure function that filters a list of gate states down to only those
 * that have timed out, returning each with its configured timeout action.
 *
 * @param gates - Array of gate states to check
 * @param now - Current time in epoch ms (defaults to Date.now() for testability)
 * @returns Array of gates that have timed out, with their actions
 */
export function checkAllGateTimeouts(gates: GateState[], now?: number): TimedOutGate[] {
  const currentTime = now ?? Date.now()
  const timedOut: TimedOutGate[] = []

  for (const gateState of gates) {
    const result = checkGateTimeout(gateState, currentTime)
    if (result.timedOut && result.action) {
      timedOut.push({ gateState, action: result.action })
    }
  }

  return timedOut
}

/**
 * Determine the resolution for a timeout action.
 *
 * Pure function that maps a timeout action to a structured resolution
 * containing the action type, issue context, and a human-readable reason.
 *
 * - `escalate` - The governor should advance the escalation strategy
 * - `skip` - The governor should skip the gate and continue the workflow
 * - `fail` - The governor should fail the workflow
 *
 * @param action - The timeout action to resolve
 * @param issueId - The issue identifier associated with the gate
 * @param gateName - The name of the gate that timed out
 * @returns The structured timeout resolution
 */
export function resolveTimeoutAction(
  action: 'escalate' | 'skip' | 'fail',
  issueId: string,
  gateName: string,
): TimeoutResolution {
  switch (action) {
    case 'escalate':
      return {
        type: 'escalate',
        issueId,
        gateName,
        reason: `Gate ${gateName} timed out — escalating`,
      }
    case 'skip':
      return {
        type: 'skip',
        issueId,
        gateName,
        reason: `Gate ${gateName} timed out — skipping gate`,
      }
    case 'fail':
      return {
        type: 'fail',
        issueId,
        gateName,
        reason: `Gate ${gateName} timed out — failing workflow`,
      }
  }
}

// ============================================
// I/O Function
// ============================================

/**
 * Process gate timeouts for a set of active gates.
 *
 * This is the main entry point called by the governor on each poll cycle.
 * It checks all provided gates for timeouts, marks timed-out gates via
 * the storage adapter (using `timeoutGate()` from gate-state.ts), and
 * returns an array of timeout resolutions for the caller to act on.
 *
 * @param activeGates - Array of currently active gate states to check
 * @param storage - The gate storage adapter for persisting state changes
 * @param now - Current time in epoch ms (defaults to Date.now() for testability)
 * @returns Array of timeout resolutions for the governor to process
 */
export async function processGateTimeouts(
  activeGates: GateState[],
  storage: GateStorage,
  now?: number,
): Promise<TimeoutResolution[]> {
  const timedOutGates = checkAllGateTimeouts(activeGates, now)

  if (timedOutGates.length === 0) {
    return []
  }

  log.info('Processing gate timeouts', {
    count: timedOutGates.length,
    gates: timedOutGates.map(g => g.gateState.gateName),
  })

  const resolutions: TimeoutResolution[] = []

  for (const { gateState, action } of timedOutGates) {
    // Mark the gate as timed-out in storage
    const updated = await timeoutGate(gateState.issueId, gateState.gateName, storage)

    if (!updated) {
      log.warn('Failed to mark gate as timed-out (gate not found or not active)', {
        issueId: gateState.issueId,
        gateName: gateState.gateName,
      })
      continue
    }

    const resolution = resolveTimeoutAction(action, gateState.issueId, gateState.gateName)
    resolutions.push(resolution)

    log.info('Gate timeout resolved', {
      issueId: gateState.issueId,
      gateName: gateState.gateName,
      action,
      reason: resolution.reason,
    })
  }

  return resolutions
}
