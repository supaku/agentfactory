/**
 * Default prompt templates for each work type.
 *
 * These provide sensible defaults that can be overridden by consumers.
 * The Supaku project overrides these with its own prompts.ts.
 */

import type { AgentWorkType, SubIssueStatus } from '../types.js'

const HUMAN_BLOCKER_INSTRUCTION = `

HUMAN-NEEDED BLOCKERS:
If you encounter work that requires human action and cannot be resolved autonomously
(e.g., missing API keys/credentials, infrastructure not provisioned, third-party onboarding,
manual setup steps, policy decisions, access permissions), create a blocker issue:
  pnpm af-linear create-blocker <SOURCE-ISSUE-ID> --title "What human needs to do" --description "Detailed steps"
This creates a tracked issue in Icebox with 'Needs Human' label, linked as blocking the source issue.
Do NOT silently skip human-needed work or bury it in comments.
Only create blockers for things that genuinely require a human — not for things you can retry or work around.`

/**
 * Generate a default prompt for a given work type and issue identifier.
 *
 * @param identifier - The issue identifier (e.g., "PROJ-123")
 * @param workType - The type of work to perform
 * @param mentionContext - Optional additional context from a user mention
 */
export function defaultGeneratePrompt(
  identifier: string,
  workType: AgentWorkType,
  mentionContext?: string
): string {
  let basePrompt: string

  switch (workType) {
    case 'research':
      basePrompt = `Research and flesh out story ${identifier}. Analyze requirements, identify technical approach, estimate complexity, and update the story description with detailed acceptance criteria. Do NOT implement code.`
      break
    case 'backlog-creation':
      basePrompt = `Create backlog issues from the researched story ${identifier}.
Read the issue description, identify distinct work items, classify each as bug/feature/chore,
and create appropriately scoped issues in Backlog status.
Choose the correct issue structure based on the work:
- Sub-issues (--parentId): When work is a single concern with sequential/parallel phases sharing context and dependencies.
- Independent issues (--type related): When items are unrelated work in different codebase areas with no shared context.
- Single issue rewrite: When scope is atomic (single concern, few files, no phases). Rewrite source in-place and move to Backlog.
When creating multiple issues, always add "related" links between them AND blocking relations where one step depends on another.
Do NOT wait for user approval - create issues automatically.`
      break
    case 'development':
      basePrompt = `Start work on ${identifier}. Implement the feature/fix as specified.`
      break
    case 'inflight':
      basePrompt = `Continue work on ${identifier}. Resume where you left off.`
      break
    case 'qa':
      basePrompt = `QA ${identifier}. Validate the implementation against acceptance criteria.`
      break
    case 'acceptance':
      basePrompt = `Process acceptance for ${identifier}. Validate development and QA work is complete, verify PR is ready to merge (CI passing, no conflicts), merge the PR, and clean up local resources.`
      break
    case 'refinement':
      basePrompt = `Refine ${identifier} based on rejection feedback. Read comments, update requirements, then return to Backlog.`
      break
    case 'coordination':
      basePrompt = `Coordinate sub-issue execution for parent issue ${identifier}. Fetch sub-issues with dependency graph, create tasks mapping to each sub-issue, spawn sub-agents for unblocked sub-issues in parallel, monitor completion, and create a single PR with all changes when done.

SUB-ISSUE STATUS MANAGEMENT:
Update sub-issue statuses in Linear as work progresses:
- When starting work on a sub-issue: update status to Started
- When a sub-agent completes a sub-issue: update status to Finished
- If a sub-agent fails: add a comment explaining the failure

COMPLETION VERIFICATION:
Before marking the parent issue as complete, verify ALL sub-issues are in Finished status.
If any sub-issue is not Finished, report the failure and do not mark the parent as complete.`
      break
    case 'qa-coordination':
      basePrompt = `Coordinate QA across sub-issues for parent issue ${identifier}. Fetch sub-issues, spawn QA sub-agents in parallel for each sub-issue, collect pass/fail results, and roll up to parent. ALL sub-issues must pass QA for the parent to pass.`
      break
    case 'acceptance-coordination':
      basePrompt = `Coordinate acceptance across sub-issues for parent issue ${identifier}. Verify all sub-issues are Delivered, validate the PR (CI passing, no conflicts), merge the PR, and bulk-update sub-issues to Accepted.`
      break
  }

  basePrompt += HUMAN_BLOCKER_INSTRUCTION

  if (mentionContext) {
    return `${basePrompt}\n\nAdditional context from the user's mention:\n${mentionContext}`
  }
  return basePrompt
}

/**
 * Build default QA context for parent issues with sub-issues.
 */
export function defaultBuildParentQAContext(
  issueIdentifier: string,
  subIssueStatuses: SubIssueStatus[]
): string {
  const subIssueList = subIssueStatuses
    .map(s => `- ${s.identifier}: ${s.title} (Status: ${s.status})`)
    .join('\n')

  return `QA ${issueIdentifier} (parent issue with ${subIssueStatuses.length} sub-issues).

## Sub-Issues
${subIssueList}

## Holistic QA Instructions
This is a parent issue whose work was coordinated across multiple sub-issues.
Perform holistic validation beyond individual sub-issue checks:

1. **Scope Coverage**: Read each sub-issue description and verify the PR includes implementation for ALL sub-issues.
2. **Integration Validation**: Check that shared types, API contracts, and data flow between sub-issue implementations are consistent and correct.
3. **Cross-Cutting Concerns**: Verify consistent error handling, auth patterns, naming conventions, and no orphaned/dead code across all sub-issue changes.
4. **Sub-Issue Status**: All sub-issues must be in Finished, Delivered, or Accepted status.

Validate the implementation against the parent issue's acceptance criteria as a whole, not just each sub-issue in isolation.`
}

/**
 * Build default acceptance context for parent issues with sub-issues.
 */
export function defaultBuildParentAcceptanceContext(
  issueIdentifier: string,
  subIssueStatuses: SubIssueStatus[]
): string {
  const subIssueList = subIssueStatuses
    .map(s => `- ${s.identifier}: ${s.title} (Status: ${s.status})`)
    .join('\n')

  return `Process acceptance for ${issueIdentifier} (parent issue with ${subIssueStatuses.length} sub-issues).

## Sub-Issues
${subIssueList}

## Parent Issue Acceptance Requirements
This is a parent issue with coordinated sub-issues. Before merging:

1. **Sub-Issue Status**: ALL sub-issues must be in **Delivered** or **Accepted** status.
2. **PR Completeness**: The single PR should contain changes for all sub-issues.
3. **CI/Deployment**: Verify the combined PR passes CI and deploys successfully.

Validate development and QA work is complete, verify PR is ready to merge (CI passing, no conflicts), merge the PR.
After merge succeeds, delete the remote branch.`
}
