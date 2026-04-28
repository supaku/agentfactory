/**
 * Session Steering
 *
 * When an agent session ends but the completion contract is not met — e.g., the
 * agent exited without committing or pushing its code — the orchestrator can
 * steer the session via `provider.resume()` with a focused follow-up prompt
 * before falling through to the deterministic `session-backstop`.
 *
 * Why this exists:
 * The backstop's auto-commit path produces generic commit messages and blindly
 * stages whatever is in the worktree, which is low-quality and tends to pick up
 * build cache that slipped past the exclusion patterns. Steering preserves the
 * agent's judgement: it writes its own commit message, respects its own
 * validation gates, and leaves the worktree clean.
 *
 * Flow:
 *   runBackstop (existing)  ←─ final safety net, always runs
 *      ↑
 *   attemptSteering (this module) ←─ tried FIRST when provider supports resume
 *      ↑
 *   agent session ends without expected outputs
 */

import { execSync } from 'node:child_process'
import type { AgentEvent, AgentHandle, AgentProvider, AgentSpawnConfig } from '../providers/types.js'
import type { AgentProcess } from './types.js'
import type { AgentWorkType } from './work-types.js'

/**
 * Code-producing work types that are candidates for commit-steering.
 * QA/research/refinement don't modify source files, so steering doesn't apply.
 */
const CODE_PRODUCING_WORK_TYPES: ReadonlySet<AgentWorkType> = new Set([
  'development',
  'inflight',
])

/** Git state relevant to deciding whether steering is warranted */
export interface SteeringGitState {
  /** Count of files with uncommitted changes (modified/untracked) */
  uncommittedFiles: number
  /** Count of local commits ahead of origin/<branch>. Undefined if no upstream. */
  unpushedCommits: number | undefined
  /** True if commits exist ahead of main (there's work on the branch) */
  hasLocalCommits: boolean
  /** Current branch name */
  currentBranch: string | undefined
}

/** Inspect the worktree to decide whether steering should be attempted */
export function inspectGitStateForSteering(worktreePath: string): SteeringGitState {
  const result: SteeringGitState = {
    uncommittedFiles: 0,
    unpushedCommits: undefined,
    hasLocalCommits: false,
    currentBranch: undefined,
  }

  try {
    result.currentBranch = execSync('git branch --show-current', {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim() || undefined
  } catch {
    return result
  }

  try {
    const status = execSync('git status --porcelain', {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim()
    result.uncommittedFiles = status ? status.split('\n').length : 0
  } catch {
    // ignore
  }

  if (result.currentBranch && result.currentBranch !== 'main' && result.currentBranch !== 'master') {
    try {
      const ahead = execSync('git rev-list --count main..HEAD', {
        cwd: worktreePath,
        encoding: 'utf-8',
        timeout: 10_000,
      }).trim()
      result.hasLocalCommits = parseInt(ahead, 10) > 0
    } catch {
      // ignore
    }

    try {
      // Only meaningful if branch tracks an upstream
      execSync('git rev-parse --abbrev-ref @{u}', {
        cwd: worktreePath,
        encoding: 'utf-8',
        timeout: 10_000,
        stdio: 'pipe',
      })
      const unpushed = execSync('git rev-list --count @{u}..HEAD', {
        cwd: worktreePath,
        encoding: 'utf-8',
        timeout: 10_000,
      }).trim()
      result.unpushedCommits = parseInt(unpushed, 10)
    } catch {
      // No upstream configured — unpushedCommits stays undefined
    }
  }

  return result
}

/** Decision inputs for whether to attempt steering */
export interface SteeringDecisionInput {
  agent: AgentProcess
  provider: AgentProvider | undefined
  gitState: SteeringGitState
}

/** Decision outcome with a human-readable reason for logs */
export interface SteeringDecision {
  shouldAttempt: boolean
  reason: string
}

/**
 * Decide whether to attempt a steering retry.
 *
 * Preconditions (all must be true):
 *   1. Agent completed the session (ctx filters status='completed' already; re-checked defensively)
 *   2. Work type is code-producing (development/inflight/coordination)
 *   3. Worktree path is known
 *   4. Provider session ID was captured (otherwise resume is impossible)
 *   5. Provider supports resume
 *   6. There's something to fix: uncommitted changes, unpushed commits, or no PR URL
 *      (with commits present — no PR for a branch with no commits is a different failure mode)
 */
export function decideSteering({ agent, provider, gitState }: SteeringDecisionInput): SteeringDecision {
  if (agent.status !== 'completed') {
    return { shouldAttempt: false, reason: `agent status=${agent.status}` }
  }
  const workType = agent.workType ?? 'development'
  if (!CODE_PRODUCING_WORK_TYPES.has(workType as AgentWorkType)) {
    return { shouldAttempt: false, reason: `work type ${workType} is not code-producing` }
  }
  if (!agent.worktreePath) {
    return { shouldAttempt: false, reason: 'no worktree path' }
  }
  if (!agent.providerSessionId) {
    return { shouldAttempt: false, reason: 'no provider session ID captured — cannot resume' }
  }
  if (!provider) {
    return { shouldAttempt: false, reason: 'provider not available' }
  }
  if (!provider.capabilities.supportsSessionResume) {
    return { shouldAttempt: false, reason: `provider ${provider.name} does not support session resume` }
  }

  const hasUncommitted = gitState.uncommittedFiles > 0
  const hasUnpushed = (gitState.unpushedCommits ?? 0) > 0
  const missingPr = !agent.pullRequestUrl && gitState.hasLocalCommits

  if (!hasUncommitted && !hasUnpushed && !missingPr) {
    return { shouldAttempt: false, reason: 'git state is clean and PR present — nothing to steer' }
  }

  const parts: string[] = []
  if (hasUncommitted) parts.push(`${gitState.uncommittedFiles} uncommitted file(s)`)
  if (hasUnpushed) parts.push(`${gitState.unpushedCommits} unpushed commit(s)`)
  if (missingPr) parts.push('no PR URL')
  return { shouldAttempt: true, reason: `recoverable gaps: ${parts.join(', ')}` }
}

/**
 * Build the focused follow-up prompt for a resumed session.
 *
 * The prompt assumes the agent already has full context from the prior turn;
 * it just names what's still missing and demands the specific commands. It
 * explicitly forbids a final response before the work is actually on the remote.
 */
export function buildSteeringPrompt(args: {
  identifier: string
  gitState: SteeringGitState
  hasPr: boolean
}): string {
  const { identifier, gitState, hasPr } = args
  const hasUncommitted = gitState.uncommittedFiles > 0
  const hasUnpushed = (gitState.unpushedCommits ?? 0) > 0
  const missingPr = !hasPr && gitState.hasLocalCommits

  const stateLines: string[] = []
  if (hasUncommitted) stateLines.push(`- ${gitState.uncommittedFiles} uncommitted file(s) in the worktree`)
  if (hasUnpushed) stateLines.push(`- ${gitState.unpushedCommits} local commit(s) ahead of the remote branch`)
  if (missingPr) stateLines.push('- No pull request has been opened for this branch')

  const steps: string[] = []
  if (hasUncommitted) {
    steps.push(
      'Inspect the diff with `git status` and `git diff` and stage only the files that belong to this work (do NOT stage build caches, coverage files, or agent state). Then `git commit -m "<descriptive message>"` with a message that describes what you built for ' + identifier + '.',
    )
  }
  if (hasUncommitted || hasUnpushed) {
    steps.push('`git push -u origin $(git branch --show-current)` (use `--force-with-lease` only if the branch has diverged after a rebase).')
  }
  if (missingPr || hasUncommitted) {
    steps.push('`gh pr create --title "..." --body "..."` describing the change.')
  }

  return [
    `Your prior turn on ${identifier} ended without completing the required commit/push/PR steps.`,
    '',
    'Current state:',
    ...stateLines,
    '',
    'Finish the job now. Do not exit until all of the following are true:',
    ...steps.map((step, i) => `${i + 1}. ${step}`),
    '',
    'Verify before you emit any final response:',
    '- `git log origin/main..HEAD` must show your commit(s).',
    '- `gh pr view` must print the PR URL.',
    '',
    'Do NOT report completion text until you have observed the PR URL in your own output.',
    'If a command fails, fix the root cause and retry — do not give up or skip steps.',
  ].join('\n')
}

/** Outcome of a steering attempt */
export interface SteeringOutcome {
  attempted: boolean
  /** Reason recorded in logs (always present) */
  reason: string
  /** True if the resumed session reached a 'result' event with success=true */
  succeeded?: boolean
  /** PR URL detected in the resumed session's assistant text, if any */
  detectedPrUrl?: string
  /** Error from the resume call (network / provider failure) */
  error?: string
  /** Total events consumed from the steering stream (diagnostics) */
  eventsConsumed?: number
}

/**
 * Execute the steering retry.
 *
 * Drains the resume stream to completion. Intentionally does NOT emit events
 * to the platform (Linear) — this is an internal recovery step, not a user-
 * visible session. The caller should still invoke the backstop afterwards; if
 * steering succeeded, the backstop will be a no-op, and if it didn't, the
 * backstop's auto-commit path is still there as a safety net.
 *
 * Timeout: hard cap so a broken resume doesn't hang the orchestrator.
 */
export async function runSteeringRetry(args: {
  provider: AgentProvider
  providerSessionId: string
  baseSpawnConfig: AgentSpawnConfig
  steeringPrompt: string
  /** Hard cap in ms. Defaults to 10 minutes. */
  timeoutMs?: number
}): Promise<SteeringOutcome> {
  const timeoutMs = args.timeoutMs ?? 10 * 60_000
  const abortController = new AbortController()
  const spawnConfig: AgentSpawnConfig = {
    ...args.baseSpawnConfig,
    prompt: args.steeringPrompt,
    abortController,
    // Strip onProcessSpawned — the orig callback mutates the completed agent's
    // pid and adds noise to the main session's logs.
    onProcessSpawned: undefined,
  }

  let handle: AgentHandle
  try {
    handle = args.provider.resume(args.providerSessionId, spawnConfig)
  } catch (error) {
    return {
      attempted: true,
      reason: 'provider.resume threw',
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const timer = setTimeout(() => abortController.abort(), timeoutMs)
  let succeeded: boolean | undefined
  let detectedPrUrl: string | undefined
  let eventsConsumed = 0

  try {
    for await (const event of handle.stream) {
      eventsConsumed++
      const url = tryExtractPrUrl(event)
      if (url) detectedPrUrl = url
      if (event.type === 'result') {
        succeeded = event.success
        break
      }
    }
  } catch (error) {
    return {
      attempted: true,
      reason: 'error draining steering stream',
      error: error instanceof Error ? error.message : String(error),
      eventsConsumed,
      detectedPrUrl,
    }
  } finally {
    clearTimeout(timer)
  }

  return {
    attempted: true,
    reason: succeeded === undefined ? 'stream ended without result event' : succeeded ? 'result success' : 'result failure',
    succeeded,
    detectedPrUrl,
    eventsConsumed,
  }
}

/** Regex hoisted to avoid recompiling per event */
const PR_URL_RE = /https:\/\/github\.com\/[^\s"'<>]+\/pull\/\d+/

function tryExtractPrUrl(event: AgentEvent): string | undefined {
  if (event.type === 'assistant_text' && typeof event.text === 'string') {
    const m = event.text.match(PR_URL_RE)
    if (m) return m[0]
  }
  if (event.type === 'tool_result' && typeof event.content === 'string') {
    const m = event.content.match(PR_URL_RE)
    if (m) return m[0]
  }
  return undefined
}
