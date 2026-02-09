import type { AgentWorkType } from '@supaku/agentfactory-linear'
import type { AgentWorkResult } from './types'

/**
 * Structured marker pattern embedded in agent output.
 * Agents are instructed to include this marker in their final output.
 *
 * Format: <!-- WORK_RESULT:passed --> or <!-- WORK_RESULT:failed -->
 */
const STRUCTURED_MARKER_RE = /<!--\s*WORK_RESULT:(passed|failed)\s*-->/i

/**
 * Heuristic patterns for detecting QA pass/fail when structured marker is absent.
 * Patterns are checked case-insensitively against the result message.
 */
const QA_PASS_PATTERNS = [
  /##\s*QA\s+Passed/i,
  /QA\s+Result:\s*Pass/i,
  /QA\s+Status:\s*Passed/i,
]

const QA_FAIL_PATTERNS = [
  /##\s*QA\s+Failed/i,
  /QA\s+Result:\s*Fail/i,
  /QA\s+Status:\s*Failed/i,
]

const ACCEPTANCE_PASS_PATTERNS = [
  /##\s*Acceptance\s+Complete/i,
  /Acceptance\s+Result:\s*Pass/i,
  /PR\s+has\s+been\s+merged\s+successfully/i,
]

const ACCEPTANCE_FAIL_PATTERNS = [
  /##\s*Acceptance\s+(?:Processing\s+)?Failed/i,
  /Acceptance\s+(?:Processing\s+)?Blocked/i,
  /Acceptance\s+Result:\s*Fail/i,
  /Cannot\s+merge\s+PR/i,
]

/**
 * Parse the agent's result message to determine whether the work passed or failed.
 *
 * Detection priority:
 * 1. Structured marker: `<!-- WORK_RESULT:passed/failed -->`
 * 2. Heuristic heading/pattern matching scoped to the work type
 * 3. Returns 'unknown' if nothing matches (safe default: no transition)
 *
 * @param resultMessage - The agent's final output message
 * @param workType - The type of work performed (qa, acceptance, etc.)
 * @returns 'passed', 'failed', or 'unknown'
 */
export function parseWorkResult(
  resultMessage: string | undefined,
  workType: AgentWorkType
): AgentWorkResult {
  if (!resultMessage) {
    return 'unknown'
  }

  // 1. Check for structured marker (highest priority, work-type agnostic)
  const markerMatch = resultMessage.match(STRUCTURED_MARKER_RE)
  if (markerMatch) {
    return markerMatch[1]!.toLowerCase() as 'passed' | 'failed'
  }

  // 2. Fall back to heuristic patterns scoped by work type
  if (workType === 'qa') {
    if (QA_FAIL_PATTERNS.some((p) => p.test(resultMessage))) {
      return 'failed'
    }
    if (QA_PASS_PATTERNS.some((p) => p.test(resultMessage))) {
      return 'passed'
    }
  }

  if (workType === 'acceptance') {
    if (ACCEPTANCE_FAIL_PATTERNS.some((p) => p.test(resultMessage))) {
      return 'failed'
    }
    if (ACCEPTANCE_PASS_PATTERNS.some((p) => p.test(resultMessage))) {
      return 'passed'
    }
  }

  // 3. Unknown — safe default
  return 'unknown'
}
