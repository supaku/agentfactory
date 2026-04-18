/**
 * Session Backstop
 *
 * Deterministic post-session recovery that runs after every agent session.
 * Validates the session's outputs against the work type's completion contract,
 * then takes backstop actions for any recoverable gaps.
 *
 * This is provider-agnostic — it operates on the worktree and GitHub API,
 * not on the agent session. Every provider gets the same backstop.
 *
 * Architecture:
 * 1. Collect session outputs (git state, PR detection, work result markers)
 * 2. Validate against the completion contract
 * 3. Run backstop actions for recoverable fields (push, create PR)
 * 4. Return structured result for the orchestrator to act on
 */

import { execSync } from 'node:child_process'
import type { AgentProcess } from './types.js'
import type { AgentWorkType } from './work-types.js'
import type {
  BackstopAction,
  BackstopResult,
  CompletionContract,
  CompletionValidationResult,
  SessionOutputs,
} from './completion-contracts.js'
import {
  getCompletionContract,
  validateCompletion,
  formatMissingFields,
} from './completion-contracts.js'

// ---------------------------------------------------------------------------
// Session output collection
// ---------------------------------------------------------------------------

/** Context needed to collect session outputs */
export interface SessionContext {
  agent: AgentProcess
  /** Whether the agent posted at least one comment to the issue */
  commentPosted: boolean
  /** Whether the agent updated the issue description */
  issueUpdated: boolean
  /** Whether the agent created sub-issues */
  subIssuesCreated: boolean
}

/**
 * Collect structured outputs from the completed session.
 * Inspects git state, agent process data, and tracked flags.
 */
export function collectSessionOutputs(ctx: SessionContext): SessionOutputs {
  const { agent } = ctx
  const outputs: SessionOutputs = {
    prUrl: agent.pullRequestUrl ?? undefined,
    workResult: agent.workResult ?? 'unknown',
    commentPosted: ctx.commentPosted,
    issueUpdated: ctx.issueUpdated,
    subIssuesCreated: ctx.subIssuesCreated,
  }

  // Inspect git state for code-producing work types
  if (agent.worktreePath) {
    try {
      outputs.commitsPresent = hasCommitsAheadOfMain(agent.worktreePath)
      outputs.branchPushed = isBranchPushed(agent.worktreePath)
    } catch {
      // Git inspection failed — leave as undefined (unknown)
    }
  }

  // If PR URL exists, check merged status
  if (outputs.prUrl) {
    try {
      outputs.prMerged = isPrMerged(outputs.prUrl, agent.worktreePath)
    } catch {
      // GitHub check failed — leave as undefined
    }
  }

  return outputs
}

// ---------------------------------------------------------------------------
// Backstop execution
// ---------------------------------------------------------------------------

/** Options for running the backstop */
export interface BackstopOptions {
  /** Skip destructive backstop actions (push, PR creation) — useful for dry-run */
  dryRun?: boolean
  /** PR title template. {identifier} is replaced with the issue key */
  prTitleTemplate?: string
  /** PR body template. {identifier} is replaced with the issue key */
  prBodyTemplate?: string
}

/**
 * Run the post-session backstop for an agent.
 *
 * 1. Collects session outputs
 * 2. Validates against completion contract
 * 3. Runs backstop actions for recoverable gaps
 * 4. Returns structured result
 *
 * This function is safe to call for any work type — it returns a no-op
 * result for work types without contracts.
 */
export function runBackstop(
  ctx: SessionContext,
  options?: BackstopOptions,
): BackstopRunResult {
  const workType = ctx.agent.workType ?? 'development'
  const contract = getCompletionContract(workType)

  // No contract for this work type — nothing to validate
  if (!contract) {
    return {
      contract: null,
      outputs: collectSessionOutputs(ctx),
      validation: null,
      backstop: { actions: [], fullyRecovered: true, remainingGaps: [] },
      diagnosticMessage: null,
    }
  }

  // Collect and validate
  const outputs = collectSessionOutputs(ctx)
  const validation = validateCompletion(contract, outputs)

  // Already satisfied — no backstop needed
  if (validation.satisfied) {
    return {
      contract,
      outputs,
      validation,
      backstop: { actions: [], fullyRecovered: true, remainingGaps: [] },
      diagnosticMessage: null,
    }
  }

  // Run backstop actions for recoverable fields
  const actions: BackstopAction[] = []

  for (const fieldType of validation.backstopRecoverable) {
    switch (fieldType) {
      case 'commits_present': {
        // Auto-commit uncommitted changes for code-producing work types only
        if (!ctx.agent.worktreePath) {
          actions.push({
            field: 'commits_present',
            action: 'skipped — no worktree path',
            success: false,
          })
          break
        }
        if (options?.dryRun) {
          actions.push({ field: 'commits_present', action: 'would auto-commit uncommitted changes', success: false, detail: 'dry-run' })
          break
        }
        const commitResult = backstopCommitChanges(ctx.agent.worktreePath, ctx.agent.identifier)
        actions.push(commitResult)
        if (commitResult.success) {
          outputs.commitsPresent = true
        }
        break
      }

      case 'branch_pushed': {
        // Only push if there are actually commits ahead of main
        if (!outputs.commitsPresent) {
          actions.push({
            field: 'branch_pushed',
            action: 'skipped — no commits to push',
            success: false,
            detail: 'Branch has no commits ahead of main',
          })
          break
        }
        if (options?.dryRun) {
          actions.push({ field: 'branch_pushed', action: 'would push branch', success: false, detail: 'dry-run' })
          break
        }
        const pushResult = backstopPushBranch(ctx.agent.worktreePath!)
        actions.push(pushResult)
        if (pushResult.success) {
          outputs.branchPushed = true
        }
        break
      }

      case 'pr_url': {
        // Can only create PR if there are commits AND the branch is pushed
        if (!outputs.commitsPresent) {
          actions.push({
            field: 'pr_url',
            action: 'skipped PR creation — no commits on branch',
            success: false,
            detail: 'No commits ahead of main — nothing to create a PR for',
          })
          break
        }
        if (!outputs.branchPushed) {
          actions.push({
            field: 'pr_url',
            action: 'skipped PR creation — branch not pushed',
            success: false,
            detail: 'Branch must be pushed before PR can be created',
          })
          break
        }
        if (options?.dryRun) {
          actions.push({ field: 'pr_url', action: 'would create PR', success: false, detail: 'dry-run' })
          break
        }
        const prResult = backstopCreatePR(ctx.agent, options)
        actions.push(prResult)
        if (prResult.success && prResult.detail) {
          outputs.prUrl = prResult.detail
          ctx.agent.pullRequestUrl = prResult.detail
        }
        break
      }
    }
  }

  // Re-validate after backstop
  const postBackstopValidation = validateCompletion(contract, outputs)

  const remainingGaps = postBackstopValidation.missingFields
  const fullyRecovered = postBackstopValidation.satisfied

  const backstopResult: BackstopResult = {
    actions,
    fullyRecovered,
    remainingGaps,
  }

  // Build diagnostic message for unrecoverable gaps
  const diagnosticMessage = fullyRecovered
    ? null
    : formatMissingFields(contract, postBackstopValidation)

  return {
    contract,
    outputs,
    validation,
    backstop: backstopResult,
    diagnosticMessage,
  }
}

/** Full result of a backstop run */
export interface BackstopRunResult {
  contract: CompletionContract | null
  outputs: SessionOutputs
  validation: CompletionValidationResult | null
  backstop: BackstopResult
  diagnosticMessage: string | null
}

// ---------------------------------------------------------------------------
// Git inspection helpers
// ---------------------------------------------------------------------------

function hasCommitsAheadOfMain(worktreePath: string): boolean {
  try {
    const currentBranch = execSync('git branch --show-current', {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 10000,
    }).trim()

    if (currentBranch === 'main' || currentBranch === 'master' || !currentBranch) {
      return false
    }

    const aheadOutput = execSync('git rev-list --count main..HEAD', {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 10000,
    }).trim()

    return parseInt(aheadOutput, 10) > 0
  } catch {
    return false
  }
}

function isBranchPushed(worktreePath: string): boolean {
  try {
    const currentBranch = execSync('git branch --show-current', {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 10000,
    }).trim()

    if (!currentBranch || currentBranch === 'main' || currentBranch === 'master') {
      return true // main is always "pushed"
    }

    const remoteRef = execSync(`git ls-remote --heads origin ${currentBranch}`, {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 15000,
    }).trim()

    if (remoteRef.length === 0) {
      return false // remote branch doesn't exist
    }

    // Check if local is ahead of remote (unpushed commits)
    try {
      execSync('git rev-parse --abbrev-ref @{u}', {
        cwd: worktreePath,
        encoding: 'utf-8',
        timeout: 10000,
      })
      const unpushed = execSync('git rev-list --count @{u}..HEAD', {
        cwd: worktreePath,
        encoding: 'utf-8',
        timeout: 10000,
      }).trim()
      return parseInt(unpushed, 10) === 0
    } catch {
      // No tracking branch but remote exists — close enough
      return true
    }
  } catch {
    return false
  }
}

function isPrMerged(prUrl: string, worktreePath?: string): boolean {
  try {
    const prMatch = prUrl.match(/\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
    if (!prMatch) return false

    const [, owner, repo, prNum] = prMatch
    const json = execSync(
      `gh pr view ${prNum} --repo ${owner}/${repo} --json state --jq '.state'`,
      {
        cwd: worktreePath ?? process.cwd(),
        encoding: 'utf-8',
        timeout: 15000,
      },
    ).trim()

    return json === 'MERGED'
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Backstop actions
// ---------------------------------------------------------------------------

function backstopPushBranch(worktreePath: string): BackstopAction {
  try {
    const currentBranch = execSync('git branch --show-current', {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 10000,
    }).trim()

    if (!currentBranch || currentBranch === 'main' || currentBranch === 'master') {
      return {
        field: 'branch_pushed',
        action: 'skipped — on main/master branch',
        success: false,
        detail: 'Cannot push from main branch',
      }
    }

    execSync(`git push -u origin ${currentBranch}`, {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 60000,
    })

    return {
      field: 'branch_pushed',
      action: 'auto-pushed branch to remote',
      success: true,
      detail: currentBranch,
    }
  } catch (error) {
    // If push failed due to diverged history (e.g., agent rewrote commits),
    // retry with --force-with-lease on feature branches. This is safe because
    // force-with-lease won't overwrite commits pushed by others.
    const errorMsg = error instanceof Error ? error.message : String(error)
    if (/non-fast-forward|rejected/.test(errorMsg)) {
      try {
        const currentBranch = execSync('git branch --show-current', {
          cwd: worktreePath,
          encoding: 'utf-8',
          timeout: 10000,
        }).trim()

        // Verify we have local commits ahead of main (genuine rewrite, not empty branch)
        const aheadCount = execSync('git rev-list --count main..HEAD', {
          cwd: worktreePath,
          encoding: 'utf-8',
          timeout: 10000,
        }).trim()

        if (parseInt(aheadCount, 10) > 0 && currentBranch !== 'main' && currentBranch !== 'master') {
          execSync(`git push --force-with-lease -u origin ${currentBranch}`, {
            cwd: worktreePath,
            encoding: 'utf-8',
            timeout: 60000,
          })

          return {
            field: 'branch_pushed',
            action: 'force-pushed branch (diverged history recovered via --force-with-lease)',
            success: true,
            detail: currentBranch,
          }
        }
      } catch (retryError) {
        return {
          field: 'branch_pushed',
          action: 'failed to push branch (force-with-lease retry also failed)',
          success: false,
          detail: retryError instanceof Error ? retryError.message : String(retryError),
        }
      }
    }

    return {
      field: 'branch_pushed',
      action: 'failed to push branch',
      success: false,
      detail: errorMsg,
    }
  }
}

/**
 * Read a git config value, returning undefined if not set.
 */
function getGitConfig(key: string, cwd: string): string | undefined {
  try {
    return execSync(`git config ${key}`, { cwd, encoding: 'utf-8', timeout: 5000 }).trim() || undefined
  } catch {
    return undefined
  }
}

function backstopCommitChanges(worktreePath: string, identifier: string): BackstopAction {
  try {
    // Check if there are actually uncommitted changes
    const status = execSync('git status --porcelain', {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 10000,
    }).trim()

    if (status.length === 0) {
      return {
        field: 'commits_present',
        action: 'skipped — no uncommitted changes to commit',
        success: false,
        detail: 'Worktree is clean',
      }
    }

    // Clear any conflicted index state left by failed stash pop / merge / rebase.
    // Without this, `git add -A` may fail on unmerged entries.
    const hasConflicts = status.split('\n').some(line => line.startsWith('UU') || line.startsWith('AA') || line.startsWith('DD'))
    if (hasConflicts) {
      try {
        // Reset the index to HEAD to clear unmerged entries, then re-detect changes
        execSync('git reset HEAD', {
          cwd: worktreePath,
          encoding: 'utf-8',
          timeout: 10000,
        })
      } catch {
        // If reset fails, proceed anyway — git add -A may still work
      }
    }

    // Resolve git identity: env vars → git config → fallback defaults
    const authorName = process.env.GIT_AUTHOR_NAME
      ?? getGitConfig('user.name', worktreePath)
      ?? 'AgentFactory'
    const authorEmail = process.env.GIT_AUTHOR_EMAIL
      ?? getGitConfig('user.email', worktreePath)
      ?? 'agent@rensei.ai'

    // Stage all changes and commit
    execSync('git add -A', {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 30000,
    })

    execSync(
      `git commit -m "feat: ${identifier} (auto-committed by session backstop)"`,
      {
        cwd: worktreePath,
        encoding: 'utf-8',
        timeout: 30000,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: authorName,
          GIT_AUTHOR_EMAIL: authorEmail,
          GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? authorName,
          GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? authorEmail,
        },
      },
    )

    const changedFiles = status.split('\n').length
    return {
      field: 'commits_present',
      action: `auto-committed ${changedFiles} file(s)${hasConflicts ? ' (resolved conflicted index)' : ''}`,
      success: true,
      detail: `${changedFiles} file(s) committed for ${identifier}`,
    }
  } catch (error) {
    const errorDetail = error instanceof Error ? error.message : String(error)
    // Capture git status for diagnostics so the failure comment has actionable info
    let gitState = ''
    try {
      gitState = execSync('git status --short', {
        cwd: worktreePath,
        encoding: 'utf-8',
        timeout: 5000,
      }).trim()
    } catch {
      // ignore
    }
    return {
      field: 'commits_present',
      action: 'failed to auto-commit changes',
      success: false,
      detail: gitState
        ? `${errorDetail}\nGit state at failure:\n${gitState}`
        : errorDetail,
    }
  }
}

function backstopCreatePR(agent: AgentProcess, options?: BackstopOptions): BackstopAction {
  const worktreePath = agent.worktreePath
  if (!worktreePath) {
    return {
      field: 'pr_url',
      action: 'skipped — no worktree path',
      success: false,
    }
  }

  try {
    const currentBranch = execSync('git branch --show-current', {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 10000,
    }).trim()

    // Check if PR already exists for this branch (might have been missed during output parsing)
    try {
      const existingPr = execSync(`gh pr list --head "${currentBranch}" --json url --limit 1`, {
        cwd: worktreePath,
        encoding: 'utf-8',
        timeout: 15000,
      }).trim()

      const prs = JSON.parse(existingPr) as Array<{ url: string }>
      if (prs.length > 0 && prs[0].url) {
        return {
          field: 'pr_url',
          action: 'found existing PR (missed during session)',
          success: true,
          detail: prs[0].url,
        }
      }
    } catch {
      // PR check failed — proceed with creation
    }

    // Build PR title and body
    const identifier = agent.identifier
    const title = options?.prTitleTemplate
      ? options.prTitleTemplate.replace('{identifier}', identifier)
      : `feat: ${identifier} (auto-recovered by backstop)`

    const body = options?.prBodyTemplate
      ? options.prBodyTemplate.replace('{identifier}', identifier)
      : [
          `## Summary`,
          ``,
          `Auto-created by the session backstop for ${identifier}.`,
          `The agent completed work but did not create a PR.`,
          ``,
          `> This PR was created automatically by the orchestrator backstop to prevent work loss.`,
          `> Please review carefully before merging.`,
        ].join('\n')

    const prOutput = execSync(
      `gh pr create --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}"`,
      {
        cwd: worktreePath,
        encoding: 'utf-8',
        timeout: 30000,
      },
    ).trim()

    // gh pr create outputs the PR URL
    const prUrlMatch = prOutput.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)
    const prUrl = prUrlMatch ? prUrlMatch[0] : prOutput

    return {
      field: 'pr_url',
      action: 'auto-created PR via backstop',
      success: true,
      detail: prUrl,
    }
  } catch (error) {
    return {
      field: 'pr_url',
      action: 'failed to create PR',
      success: false,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

// ---------------------------------------------------------------------------
// Diagnostic formatting
// ---------------------------------------------------------------------------

/**
 * Format a backstop result into a diagnostic comment for the issue tracker.
 */
export function formatBackstopComment(result: BackstopRunResult): string | null {
  // Nothing to report if contract was satisfied or no contract exists
  if (!result.contract || result.backstop.fullyRecovered) {
    // If backstop took actions to recover, report those
    if (result.backstop.actions.length > 0) {
      const lines = [
        `**Session backstop recovered missing outputs for ${result.contract?.workType ?? 'unknown'} work.**`,
        '',
        'Actions taken:',
        ...result.backstop.actions.map(a =>
          `- ${a.field}: ${a.action}${a.success ? ' ✓' : ' ✗'}${a.detail ? ` (${a.detail})` : ''}`
        ),
      ]
      return lines.join('\n')
    }
    return null
  }

  // Contract not satisfied — build diagnostic
  const lines = [
    `⚠️ **Session completion check failed for ${result.contract.workType} work.**`,
    '',
  ]

  if (result.backstop.actions.length > 0) {
    lines.push('**Backstop actions attempted:**')
    for (const action of result.backstop.actions) {
      lines.push(`- ${action.field}: ${action.action}${action.success ? ' ✓' : ' ✗'}`)
      if (action.detail && !action.success) {
        lines.push(`  > ${action.detail}`)
      }
    }
    lines.push('')
  }

  if (result.backstop.remainingGaps.length > 0) {
    lines.push('**Still missing (requires manual action or re-trigger):**')
    for (const gap of result.backstop.remainingGaps) {
      const field = result.contract.required.find(f => f.type === gap)
      lines.push(`- ${field?.label ?? gap}`)
    }
    lines.push('')
    lines.push('**Issue status was NOT updated automatically** to prevent incomplete work from advancing.')
  }

  return lines.join('\n')
}
