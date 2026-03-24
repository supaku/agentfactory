/**
 * Signal Gate Executor
 *
 * Evaluates whether comments or directives satisfy a signal gate.
 * Signal gates pause workflow execution until a matching comment or
 * directive is detected. This module is backward compatible with
 * existing HOLD/RESUME directives from the override-parser system.
 *
 * All evaluator functions are pure (no I/O) — they take inputs and
 * return results without side effects.
 */

import type { GateDefinition, WorkflowDefinition } from '../workflow-types.js'

const log = {
  info: (msg: string, data?: Record<string, unknown>) => console.log(`[signal-gate] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) => console.warn(`[signal-gate] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) => console.error(`[signal-gate] ${msg}`, data ? JSON.stringify(data) : ''),
  debug: (_msg: string, _data?: Record<string, unknown>) => {},
}

// ============================================
// Types
// ============================================

/**
 * Trigger configuration for a signal gate.
 * Defines how incoming comments are matched against the gate condition.
 */
export interface SignalGateTrigger {
  /** Whether to match against the full comment text or the first-line directive only */
  source: 'comment' | 'directive'
  /** String to match — can be an exact string or a regex pattern */
  match: string
}

/**
 * Result of evaluating a comment against a signal gate
 */
export interface SignalGateResult {
  /** Whether the comment matched the signal gate trigger */
  matched: boolean
  /** The content that matched (the full comment or directive line) */
  source?: string
}

// ============================================
// Type Guards
// ============================================

/**
 * Type guard to validate that a trigger object has the correct shape
 * for a signal gate trigger.
 *
 * A valid SignalGateTrigger must have:
 * - `source`: either 'comment' or 'directive'
 * - `match`: a non-empty string
 *
 * @param trigger - The trigger record to validate
 * @returns True if the trigger is a valid SignalGateTrigger
 */
export function isSignalGateTrigger(trigger: Record<string, unknown>): trigger is Record<string, unknown> & SignalGateTrigger {
  if (typeof trigger.source !== 'string') return false
  if (trigger.source !== 'comment' && trigger.source !== 'directive') return false
  if (typeof trigger.match !== 'string') return false
  if (trigger.match.length === 0) return false
  return true
}

// ============================================
// Signal Gate Evaluator
// ============================================

/**
 * Extract the first non-empty line from a comment body.
 * Mirrors the directive extraction logic in override-parser.ts.
 *
 * @param body - The full comment body text
 * @returns The trimmed first non-empty line, or empty string if none
 */
function extractDirectiveLine(body: string): string {
  const lines = body.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length > 0) {
      return trimmed
    }
  }
  return ''
}

/**
 * Evaluate whether a comment satisfies a signal gate trigger.
 *
 * This is a pure function (no I/O) that checks if a comment matches
 * the signal gate's trigger configuration.
 *
 * Matching rules:
 * - Bot comments are always skipped (returns { matched: false })
 * - When `trigger.source` is 'directive', only the first non-empty line
 *   of the comment is checked (consistent with override-parser.ts)
 * - When `trigger.source` is 'comment', the full trimmed comment text is checked
 * - The `trigger.match` string is first tried as an exact case-insensitive match,
 *   then as a regex pattern (case-insensitive)
 *
 * @param gate - The gate definition containing a signal trigger
 * @param comment - The full comment body text
 * @param isBot - Whether the comment was authored by a bot
 * @returns A SignalGateResult indicating whether the comment matched
 */
export function evaluateSignalGate(gate: GateDefinition, comment: string, isBot: boolean): SignalGateResult {
  // Bot comments are always ignored
  if (isBot) {
    log.debug('Skipping bot comment for signal gate', { gateName: gate.name })
    return { matched: false }
  }

  // Validate trigger shape
  if (!isSignalGateTrigger(gate.trigger)) {
    log.warn('Gate has invalid signal trigger configuration', { gateName: gate.name, trigger: gate.trigger })
    return { matched: false }
  }

  const trigger = gate.trigger

  // Determine the text to match against based on trigger source
  let textToMatch: string
  if (trigger.source === 'directive') {
    textToMatch = extractDirectiveLine(comment)
  } else {
    textToMatch = comment.trim()
  }

  // Empty text cannot match
  if (textToMatch.length === 0) {
    return { matched: false }
  }

  // Try exact case-insensitive match first
  if (textToMatch.toLowerCase() === trigger.match.toLowerCase()) {
    log.debug('Signal gate matched (exact)', { gateName: gate.name, source: textToMatch })
    return { matched: true, source: textToMatch }
  }

  // Try regex match (case-insensitive)
  try {
    const regex = new RegExp(trigger.match, 'i')
    const match = textToMatch.match(regex)
    if (match) {
      log.debug('Signal gate matched (regex)', { gateName: gate.name, source: textToMatch })
      return { matched: true, source: textToMatch }
    }
  } catch {
    // Invalid regex pattern — treat as exact match only (already tried above)
    log.warn('Invalid regex in signal gate trigger match', { gateName: gate.name, match: trigger.match })
  }

  return { matched: false }
}

// ============================================
// Workflow Query Helpers
// ============================================

/**
 * Get all signal gates from a workflow definition that apply to a given phase.
 *
 * Filters gates by:
 * 1. `type === 'signal'`
 * 2. `appliesTo` includes the given phase name, OR `appliesTo` is not defined
 *    (gate applies to all phases)
 *
 * @param workflow - The workflow definition containing gate configurations
 * @param phase - The phase name to filter by
 * @returns Array of GateDefinition objects that are signal gates applicable to the phase
 */
export function getApplicableSignalGates(workflow: WorkflowDefinition, phase: string): GateDefinition[] {
  if (!workflow.gates || workflow.gates.length === 0) {
    return []
  }

  return workflow.gates.filter((gate) => {
    // Must be a signal gate
    if (gate.type !== 'signal') return false

    // If appliesTo is defined, the phase must be in the list
    if (gate.appliesTo && gate.appliesTo.length > 0) {
      return gate.appliesTo.includes(phase)
    }

    // No appliesTo restriction — applies to all phases
    return true
  })
}

// ============================================
// HOLD/RESUME Backward Compatibility
// ============================================

/**
 * Name used for the implicit HOLD gate created for backward compatibility
 */
export const IMPLICIT_HOLD_GATE_NAME = '__implicit-hold'

/**
 * Name used for the implicit RESUME gate created for backward compatibility
 */
export const IMPLICIT_RESUME_GATE_NAME = '__implicit-resume'

/**
 * Create an implicit signal gate definition that matches the HOLD directive.
 *
 * This provides backward compatibility with the existing HOLD/RESUME system.
 * When a HOLD directive is detected and no explicit signal gate is defined,
 * this creates a gate that will pause the workflow until a RESUME directive
 * is received.
 *
 * The created gate matches:
 * - Directive source: first line of comment
 * - Pattern: `^hold(?:\s*[---]\s*(.+))?$` (matches HOLD or HOLD -- reason)
 *
 * @returns A GateDefinition representing the implicit HOLD gate
 */
export function createImplicitHoldGate(): GateDefinition {
  return {
    name: IMPLICIT_HOLD_GATE_NAME,
    description: 'Implicit gate created for backward-compatible HOLD directive',
    type: 'signal',
    trigger: {
      source: 'directive',
      match: '^hold(?:\\s*[\\u2014\\u2013-]\\s*(.+))?$',
    } satisfies SignalGateTrigger as Record<string, unknown>,
  }
}

/**
 * Create an implicit signal gate definition that matches the RESUME directive.
 *
 * This is the counterpart to the implicit HOLD gate. When a workflow is
 * paused by a HOLD directive, this gate defines the condition that will
 * release the hold — receiving a RESUME directive.
 *
 * The created gate matches:
 * - Directive source: first line of comment
 * - Pattern: `^resume$` (exact match for RESUME directive)
 *
 * @returns A GateDefinition representing the implicit RESUME gate
 */
export function createImplicitResumeGate(): GateDefinition {
  return {
    name: IMPLICIT_RESUME_GATE_NAME,
    description: 'Implicit gate created for backward-compatible RESUME directive',
    type: 'signal',
    trigger: {
      source: 'directive',
      match: '^resume$',
    } satisfies SignalGateTrigger as Record<string, unknown>,
  }
}
