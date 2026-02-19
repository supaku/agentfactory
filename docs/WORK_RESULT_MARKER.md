# Work Result Markers

## Overview

The orchestrator uses structured HTML comment markers to detect agent outcomes and automatically transition Linear issue statuses. Without these markers, issues can silently stall with no visible explanation.

## Marker Format

Agents must include exactly one of these HTML comments in their final output:

```
<!-- WORK_RESULT:passed -->
<!-- WORK_RESULT:failed -->
```

## Detection Priority

1. **Structured marker** (highest priority): Regex matches `<!-- WORK_RESULT:(passed|failed) -->`
2. **Heuristic patterns** (fallback): Heading patterns like `## QA Passed` (scoped by work type)
3. **Unknown** (default): No marker or pattern found — NO status transition occurs

## Why This Matters

When the orchestrator gets an `unknown` result:
- It logs a warning and skips the status transition
- A diagnostic comment is posted to the Linear issue
- The issue stays in its current status (e.g., Finished) requiring manual intervention

This is the #1 cause of stalled issues in automated workflows.

## Rules for Agent Authors

1. **ALWAYS** include a marker in your final output
2. Even on errors, emit `<!-- WORK_RESULT:failed -->`
3. Place the marker in the final message/comment posted to Linear
4. Do not emit both markers — use exactly one
5. The marker is detected case-insensitively and with flexible whitespace

## Work Type to Status Mapping

| Work Type | Pass Effect | Fail Effect |
|---|---|---|
| qa | Finished → Delivered | Stays Finished |
| acceptance | Delivered → Accepted | Stays Delivered |
| qa-coordination | Finished → Delivered (parent) | Stays Finished |
| acceptance-coordination | Delivered → Accepted (parent) | Stays Delivered |
| development | Finished (auto, no marker needed) | N/A |

Development work types auto-promote on completion and do not require markers.

## Heuristic Patterns (Fallback)

These patterns are checked only if no structured marker is found. They are scoped by work type.

### QA Patterns
- Pass: `## QA Passed`, `## QA Complete...PASS`, `QA Result: Pass`, `QA Status: Passed`
- Fail: `## QA Failed`, `## QA Complete...FAIL`, `QA Result: Fail`, `QA Status: Failed`

### Acceptance Patterns
- Pass: `## Acceptance Complete`, `Acceptance Result: Pass`, `PR has been merged successfully`
- Fail: `## Acceptance Failed`, `Acceptance Processing Blocked`, `Cannot merge PR`

**Structured markers are always preferred over heuristics.** Heuristics exist for backward compatibility.

## PR Selection Guidance

QA and acceptance agents must handle issues with multiple PRs:

1. Check linked PRs in the issue (the orchestrator pre-fetches these when available)
2. Filter by state: prefer OPEN over MERGED over CLOSED
3. If multiple OPEN PRs exist, pick the most recently created one
4. Fallback: search by branch name or issue identifier
5. If no PR is found, emit `<!-- WORK_RESULT:failed -->` with explanation

## Troubleshooting

**Issue stuck in Finished/Delivered with no explanation:**
- The agent likely completed without emitting a marker
- Check the agent's completion comment on the Linear issue
- Look for the diagnostic warning: "Agent completed but no structured result marker was detected"
- Re-trigger the agent or manually update the status

**Agent picked the wrong PR:**
- Check if multiple PRs exist for the issue
- The orchestrator now includes linked PR info in the agent prompt
- Verify the agent is following PR selection guidance (preferring OPEN PRs)
