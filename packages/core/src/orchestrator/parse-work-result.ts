import type { AgentWorkType } from '@supaku/agentfactory-linear'
import type { AgentWorkResult } from './types.js'

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
  // Heading patterns
  /##\s*QA\s+Passed/i,
  /##\s*QA\s+Complete[^]*?\bPASS/i,
  // Explicit label patterns (with optional "QA" prefix, word-bounded to avoid WORK_RESULT)
  /\b(?:QA\s+)?Result:\s*\*{0,2}Pass(?:ed)?\*{0,2}/i,
  /\b(?:QA\s+)?Status:\s*\*{0,2}Pass(?:ed)?\*{0,2}/i,
  /\b(?:QA\s+)?Verdict:\s*\*{0,2}Pass(?:ed)?\*{0,2}/i,
  /\b(?:QA\s+)?(?:Result|Status|Verdict):\s*✅/i,
  /Overall\s+(?:QA\s+)?Result:\s*PASS/i,
  /Roll-?Up\s+Verdict:\s*PASS/i,
  // Bold standalone PASS (agents commonly output **PASS** or **PASS.**)
  /\*\*PASS\.?\*\*/,
]

const QA_FAIL_PATTERNS = [
  // Heading patterns
  /##\s*QA\s+Failed/i,
  /##\s*QA\s+Complete[^]*?\bFAIL/i,
  // Explicit label patterns (with optional "QA" prefix, word-bounded to avoid WORK_RESULT)
  /\b(?:QA\s+)?Result:\s*\*{0,2}Fail(?:ed)?\*{0,2}/i,
  /\b(?:QA\s+)?Status:\s*\*{0,2}Fail(?:ed)?\*{0,2}/i,
  /\b(?:QA\s+)?Verdict:\s*\*{0,2}Fail(?:ed)?\*{0,2}/i,
  /\b(?:QA\s+)?(?:Result|Status|Verdict):\s*❌/i,
  /Overall\s+(?:QA\s+)?Result:\s*FAIL/i,
  /Roll-?Up\s+Verdict:\s*FAIL/i,
  /Parent\s+QA\s+verdict:\s*FAIL/i,
  // Bold standalone FAIL
  /\*\*FAIL\.?\*\*/,
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
  if (workType === 'qa' || workType === 'qa-coordination') {
    if (QA_FAIL_PATTERNS.some((p) => p.test(resultMessage))) {
      return 'failed'
    }
    if (QA_PASS_PATTERNS.some((p) => p.test(resultMessage))) {
      return 'passed'
    }
  }

  if (workType === 'acceptance' || workType === 'acceptance-coordination') {
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
