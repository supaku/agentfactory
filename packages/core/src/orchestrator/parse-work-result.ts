import type { AgentWorkType } from './work-types.js'
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
  // "Already done" patterns — agent recognized prior QA passed, treat as pass
  /\b(?:QA\s+(?:coordination\s+)?)?(?:is\s+)?already\s+(?:done|complete|completed)\b/i,
  // "APPROVED FOR MERGE" — explicit approval language
  /\bAPPROVED\s+FOR\s+MERGE\b/i,
  // "all checks passed" — agent confirmed all checks passed
  /\ball\s+checks\s+passed\b/i,
  // "QA Coordination Complete" / "QA Complete" — inline text (not heading)
  /\bQA\s+(?:Coordination\s+)?Complete\b/i,
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
  // QA coordination report with issues found (agents output "Status: N Issues Found")
  /\bStatus:\s*\d+\s+Issues?\s+Found\b/i,
  // "Must Fix Before Merge" — agents use this heading for blocking findings
  /\bMust\s+Fix\s+Before\s+Merge\b/i,
  // "N Critical Issues (Block Merge)" — coordination QA summary format
  /\d+\s+Critical\s+Issues?\s*\(Block\s+Merge\)/i,
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
  // Coordination-style patterns (agents output reports with "Must Fix" / "Critical Issues")
  /\bMust\s+Fix\s+Before\s+Merge\b/i,
  /\d+\s+Critical\s+Issues?\s*\(Block\s+Merge\)/i,
]

/**
 * Heuristic patterns for detecting coordination pass/fail.
 * These apply to the 'coordination' work type (development coordination).
 */
const COORDINATION_PASS_PATTERNS = [
  // "all 8/8 sub-issues completed" or "all sub-issues completed"
  /\ball\s+(?:\d+\/\d+\s+)?sub-issues?\s+(?:completed|finished)/i,
  // "8/8 sub-issues completed/finished" (without leading "all")
  /\b(\d+)\/\1\b.*\bsub-issues?\s+(?:completed|finished)/i,
  // Explicit result labels
  /\bCoordination\s+(?:Result|Status|Verdict):\s*\*{0,2}Pass(?:ed)?\*{0,2}/i,
  /\bCoordination\s+Complete/i,
  // "Parent issue marked Finished" — coordinator confirms parent status update
  /\bParent\s+issue\s+marked\s+Finished/i,
]

const MERGE_PASS_PATTERNS = [
  /merge.*completed/i,
  /successfully\s+merged/i,
  /fast-forward\s+merge/i,
  /merged\s+to\s+main/i,
  /merge\s+queue.*completed/i,
]

const MERGE_FAIL_PATTERNS = [
  /merge.*failed/i,
  /merge\s+conflict/i,
  /could\s+not\s+merge/i,
  /rebase.*failed/i,
  /test.*failed.*after.*rebase/i,
]

const COORDINATION_FAIL_PATTERNS = [
  // "Must Fix Before Merge" — agents use this heading for blocking issues
  /\bMust\s+Fix\s+Before\s+Merge\b/i,
  // "N Critical Issues (Block Merge)"
  /\d+\s+Critical\s+Issues?\s*\(Block\s+Merge\)/i,
  // "sub-issues need work/attention/fixes"
  /\bsub-issues?\s+(?:need|require)[s]?\s+(?:work|attention|fixes?)\b/i,
  // Explicit result labels
  /\bCoordination\s+(?:Result|Status|Verdict):\s*\*{0,2}Fail(?:ed)?\*{0,2}/i,
  /\bCoordination\s+Failed/i,
  // Early-exit detection — agent reported progress instead of completing coordination
  /\bI'll wait\b.*\bcomplete\b/i,
  /\bagents?\s+(?:are|is)\s+(?:actively\s+)?(?:working|running|in\s+progress)\b/i,
  /\bwork\s+is\s+in\s+progress\b/i,
  /\bwait(?:ing)?\s+for\s+(?:them|sub-?\s*agents?|sub-?\s*issues?)\s+to\s+(?:complete|finish)\b/i,
  /\bbefore\s+proceeding\s+to\s+(?:Layer|Wave|Phase)\s+\d/i,
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

  if (workType === 'coordination' || workType === 'inflight-coordination') {
    if (COORDINATION_FAIL_PATTERNS.some((p) => p.test(resultMessage))) {
      return 'failed'
    }
    if (COORDINATION_PASS_PATTERNS.some((p) => p.test(resultMessage))) {
      return 'passed'
    }
  }

  if (workType === 'merge') {
    if (MERGE_FAIL_PATTERNS.some((p) => p.test(resultMessage))) {
      return 'failed'
    }
    if (MERGE_PASS_PATTERNS.some((p) => p.test(resultMessage))) {
      return 'passed'
    }
  }

  // 3. Unknown — safe default
  return 'unknown'
}
