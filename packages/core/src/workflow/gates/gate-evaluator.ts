/**
 * Gate Evaluator — Decision Engine Integration Layer
 *
 * Unified gate evaluation module that the decision engine calls to check
 * whether workflow phase transitions are blocked by unsatisfied gates.
 * Wires together signal gates, timer gates, webhook gates, and the timeout
 * engine into a single evaluation pipeline.
 *
 * Main entry points:
 * - evaluateGatesForPhase() — called by the governor before decideAction()
 * - activateGatesForPhase() — called when entering a new workflow phase
 * - clearGatesForIssue()    — called when an issue reaches terminal state
 */

import type { GateState, GateStorage } from '../gate-state.js'
import { activateGate, satisfyGate } from '../gate-state.js'
import type { WorkflowDefinition, GateDefinition } from '../workflow-types.js'
import { evaluateSignalGate } from './signal-gate.js'
import { getApplicableSignalGates } from './signal-gate.js'
import { evaluateTimerGate } from './timer-gate.js'
import { getApplicableTimerGates } from './timer-gate.js'
import { evaluateWebhookGate } from './webhook-gate.js'
import { getApplicableWebhookGates } from './webhook-gate.js'
import type { TimeoutResolution } from './timeout-engine.js'
import { processGateTimeouts } from './timeout-engine.js'

// ============================================
// Logger
// ============================================

const log = {
  info: (msg: string, data?: Record<string, unknown>) =>
    console.log(`[gate-evaluator] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) =>
    console.warn(`[gate-evaluator] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) =>
    console.error(`[gate-evaluator] ${msg}`, data ? JSON.stringify(data) : ''),
  debug: (_msg: string, _data?: Record<string, unknown>) => {},
}

// ============================================
// Types
// ============================================

/**
 * Options for evaluating gates applicable to a workflow phase.
 * The governor populates this before calling the decision engine.
 */
export interface GateEvaluationOptions {
  /** The issue identifier */
  issueId: string
  /** The current workflow phase name */
  phase: string
  /** The workflow definition containing gate configurations */
  workflow: WorkflowDefinition
  /** Storage adapter for gate state persistence */
  storage: GateStorage
  /** For signal gates — latest comments to check */
  comments?: Array<{ text: string; isBot: boolean }>
  /** Current time for timer/timeout evaluation (epoch ms, defaults to Date.now()) */
  now?: number
}

/**
 * Result of evaluating all gates for a workflow phase.
 * Consumed by the decision engine to determine if transitions are blocked.
 */
export interface GateEvaluationResult {
  /** Whether all gates for this phase are satisfied (or no gates apply) */
  allSatisfied: boolean
  /** Active unsatisfied gates */
  activeGates: GateState[]
  /** Gates that were satisfied during this evaluation */
  newlySatisfied: GateState[]
  /** Timeout resolutions that need to be acted on */
  timeoutResolutions: TimeoutResolution[]
  /** Reason string for decision engine logging */
  reason: string
}

// ============================================
// Gate Query Helpers
// ============================================

/**
 * Get all gate definitions from a workflow that apply to a given phase,
 * across all gate types (signal, timer, webhook).
 *
 * @param workflow - The workflow definition containing gate configurations
 * @param phase - The phase name to filter by
 * @returns Array of GateDefinition objects applicable to the phase
 */
export function getApplicableGates(workflow: WorkflowDefinition, phase: string): GateDefinition[] {
  return [
    ...getApplicableSignalGates(workflow, phase),
    ...getApplicableTimerGates(workflow, phase),
    ...getApplicableWebhookGates(workflow, phase),
  ]
}

// ============================================
// Main Entry Points
// ============================================

/**
 * Evaluate all gates applicable to a workflow phase.
 *
 * This is the main entry point called by the governor before invoking
 * the decision engine. It evaluates each active gate according to its
 * type and returns an aggregated result indicating whether all gates
 * are satisfied.
 *
 * Evaluation pipeline:
 * 1. Get applicable gates for the phase from the workflow definition
 * 2. For each applicable gate, retrieve its persisted state from storage
 * 3. For each active gate:
 *    - Signal gates: check each comment via evaluateSignalGate(); satisfy on match
 *    - Timer gates: check via evaluateTimerGate(); satisfy if fired
 *    - Webhook gates: check via evaluateWebhookGate() (satisfaction is external)
 * 4. Check timeouts via processGateTimeouts()
 * 5. Return aggregated result
 *
 * @param opts - Gate evaluation options
 * @returns Aggregated gate evaluation result
 */
export async function evaluateGatesForPhase(opts: GateEvaluationOptions): Promise<GateEvaluationResult> {
  const { issueId, phase, workflow, storage, comments, now } = opts
  const currentTime = now ?? Date.now()

  // 1. Get applicable gate definitions for this phase
  const applicableGateDefs = getApplicableGates(workflow, phase)

  // If no gates apply, everything is satisfied
  if (applicableGateDefs.length === 0) {
    return {
      allSatisfied: true,
      activeGates: [],
      newlySatisfied: [],
      timeoutResolutions: [],
      reason: `No gates apply to phase "${phase}"`,
    }
  }

  const newlySatisfied: GateState[] = []

  // 2. For each applicable gate, check if it's already activated
  for (const gateDef of applicableGateDefs) {
    const gateState = await storage.getGateState(issueId, gateDef.name)

    // Gate not yet activated — skip evaluation (it will be activated
    // when the phase is entered via activateGatesForPhase)
    if (!gateState || gateState.status !== 'active') {
      continue
    }

    // 3. Evaluate based on gate type
    switch (gateDef.type) {
      case 'signal': {
        // Check each comment against the signal gate
        if (comments && comments.length > 0) {
          for (const comment of comments) {
            const result = evaluateSignalGate(gateDef, comment.text, comment.isBot)
            if (result.matched) {
              const satisfied = await satisfyGate(
                issueId,
                gateDef.name,
                result.source ?? 'signal-match',
                storage,
              )
              if (satisfied) {
                newlySatisfied.push(satisfied)
                log.info('Signal gate satisfied by comment', {
                  issueId,
                  gateName: gateDef.name,
                  source: result.source,
                })
              }
              break // Gate satisfied, no need to check more comments
            }
          }
        }
        break
      }

      case 'timer': {
        const result = evaluateTimerGate(gateDef, currentTime)
        if (result.fired) {
          const satisfied = await satisfyGate(
            issueId,
            gateDef.name,
            `timer-fired:${result.nextFireTime}`,
            storage,
          )
          if (satisfied) {
            newlySatisfied.push(satisfied)
            log.info('Timer gate fired', {
              issueId,
              gateName: gateDef.name,
              nextFireTime: result.nextFireTime,
            })
          }
        }
        break
      }

      case 'webhook': {
        // Webhook gates are satisfied externally via HTTP callback.
        // We just evaluate the current state to check for timeout.
        evaluateWebhookGate(gateDef, gateState)
        break
      }
    }
  }

  // 4. Check timeouts on all active gates
  const activeGates = await storage.getActiveGates(issueId)
  const timeoutResolutions = await processGateTimeouts(activeGates, storage, currentTime)

  // 5. Re-fetch active gates after timeout processing (some may have been timed-out)
  const remainingActiveGates = await storage.getActiveGates(issueId)

  // Filter to only those gates that are relevant to this phase
  const applicableGateNames = new Set(applicableGateDefs.map(g => g.name))
  const phaseActiveGates = remainingActiveGates.filter(g => applicableGateNames.has(g.gateName))

  const allSatisfied = phaseActiveGates.length === 0

  // Build reason string
  let reason: string
  if (allSatisfied) {
    if (newlySatisfied.length > 0) {
      const names = newlySatisfied.map(g => g.gateName).join(', ')
      reason = `All gates satisfied for phase "${phase}" (newly satisfied: ${names})`
    } else {
      reason = `All gates satisfied for phase "${phase}"`
    }
  } else {
    const activeNames = phaseActiveGates.map(g => g.gateName).join(', ')
    reason = `Unsatisfied gates for phase "${phase}": ${activeNames}`
  }

  return {
    allSatisfied,
    activeGates: phaseActiveGates,
    newlySatisfied,
    timeoutResolutions,
    reason,
  }
}

/**
 * Activate all gates applicable to a workflow phase.
 *
 * Called when a workflow transitions to a new phase. Finds all gate
 * definitions that apply to the phase and activates each one via
 * the gate-state module, creating persisted gate state with computed
 * timeout deadlines.
 *
 * Gates that are already activated (i.e., have existing state) are
 * skipped to prevent re-activation on subsequent poll cycles.
 *
 * @param issueId - The issue identifier
 * @param phase - The phase being entered
 * @param workflow - The workflow definition containing gate configurations
 * @param storage - The gate storage adapter for persisting state
 * @returns Array of newly activated gate states
 */
export async function activateGatesForPhase(
  issueId: string,
  phase: string,
  workflow: WorkflowDefinition,
  storage: GateStorage,
): Promise<GateState[]> {
  const applicableGateDefs = getApplicableGates(workflow, phase)

  if (applicableGateDefs.length === 0) {
    log.debug('No gates to activate for phase', { issueId, phase })
    return []
  }

  const activated: GateState[] = []

  for (const gateDef of applicableGateDefs) {
    // Skip if already activated (prevent re-activation on repeated polls)
    const existing = await storage.getGateState(issueId, gateDef.name)
    if (existing) {
      log.debug('Gate already activated, skipping', { issueId, gateName: gateDef.name, status: existing.status })
      continue
    }

    const gateState = await activateGate(issueId, gateDef, storage)
    activated.push(gateState)

    log.info('Gate activated for phase', {
      issueId,
      phase,
      gateName: gateDef.name,
      gateType: gateDef.type,
    })
  }

  return activated
}

/**
 * Clear all gate states for an issue.
 *
 * Called when an issue reaches a terminal state (Accepted, Canceled,
 * Duplicate) to clean up any persisted gate state. Delegates directly
 * to the storage adapter's clearGateStates() method.
 *
 * @param issueId - The issue identifier
 * @param storage - The gate storage adapter
 */
export async function clearGatesForIssue(
  issueId: string,
  storage: GateStorage,
): Promise<void> {
  await storage.clearGateStates(issueId)
  log.info('Cleared all gate states for issue', { issueId })
}
