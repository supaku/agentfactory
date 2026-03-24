/**
 * Retry & Timeout Resolution Logic
 *
 * Resolves per-template retry and timeout configurations with a layered
 * override precedence:
 *
 *   template-level → phase-level → global escalation config → defaults
 *
 * All functions are pure — no side effects.
 */

import type {
  TemplateRetryConfig,
  TemplateTimeoutConfig,
  EscalationConfig,
  EscalationLadderRung,
} from './workflow-types.js'
import { parseDuration } from './duration.js'

// ---------------------------------------------------------------------------
// Resolved Types
// ---------------------------------------------------------------------------

/**
 * Resolved retry configuration with all values filled in.
 */
export interface ResolvedRetryConfig {
  maxAttempts: number
  ladder: EscalationLadderRung[]
}

/**
 * Resolved timeout configuration with duration in milliseconds.
 */
export interface ResolvedTimeoutConfig {
  durationMs: number
  action: 'escalate' | 'skip' | 'fail'
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ATTEMPTS = 3

const DEFAULT_LADDER: EscalationLadderRung[] = [
  { cycle: 1, strategy: 'normal' },
  { cycle: 2, strategy: 'context-enriched' },
  { cycle: 3, strategy: 'decompose' },
]

// ---------------------------------------------------------------------------
// Retry Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve retry configuration with override precedence:
 * template-level retry → phase-level retry → global escalation config → defaults
 *
 * For each field (maxAttempts, ladder), the first defined value wins:
 *   1. templateRetry (from branching block)
 *   2. phaseRetry (from phase definition)
 *   3. globalEscalation (from workflow definition)
 *   4. Built-in defaults
 *
 * @param templateRetry - Per-template retry config (from branching block)
 * @param phaseRetry - Per-phase retry config (from phase definition)
 * @param globalEscalation - Global escalation config (from workflow definition)
 * @returns Fully resolved retry config with fallback defaults
 */
export function resolveRetryConfig(
  templateRetry?: TemplateRetryConfig,
  phaseRetry?: TemplateRetryConfig,
  globalEscalation?: EscalationConfig,
): ResolvedRetryConfig {
  const maxAttempts =
    templateRetry?.maxAttempts
    ?? phaseRetry?.maxAttempts
    ?? globalEscalation?.circuitBreaker.maxSessionsPerPhase
    ?? DEFAULT_MAX_ATTEMPTS

  const ladder =
    templateRetry?.ladder
    ?? phaseRetry?.ladder
    ?? globalEscalation?.ladder
    ?? DEFAULT_LADDER

  return { maxAttempts, ladder }
}

// ---------------------------------------------------------------------------
// Timeout Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve timeout configuration with override precedence:
 * template-level timeout → phase-level timeout → null (no timeout)
 *
 * @param templateTimeout - Per-template timeout config (from branching block)
 * @param phaseTimeout - Per-phase timeout config (from phase definition)
 * @returns Resolved timeout config, or null if no timeout configured
 */
export function resolveTimeoutConfig(
  templateTimeout?: TemplateTimeoutConfig,
  phaseTimeout?: TemplateTimeoutConfig,
): ResolvedTimeoutConfig | null {
  const timeout = templateTimeout ?? phaseTimeout

  if (!timeout) {
    return null
  }

  return {
    durationMs: parseDuration(timeout.duration),
    action: timeout.action,
  }
}
