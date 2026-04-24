/**
 * Merge Worker — Single-Instance Processor
 *
 * Implements the core rebase -> resolve conflicts -> regenerate lock files -> test -> merge loop.
 * Acquires a Redis lock to ensure only one worker processes a given repository's queue at a time.
 * Uses heartbeat to extend the lock TTL while processing, and supports graceful shutdown.
 *
 * All external dependencies (storage, redis) are injected via MergeWorkerDeps for testability.
 */

import { exec as execCb } from 'child_process'
import { promisify } from 'util'
import { createMergeStrategy } from './strategies/index.js'
import { ConflictResolver } from './conflict-resolver.js'
import { LockFileRegeneration } from './lock-file-regeneration.js'
import type { MergeContext } from './strategies/types.js'
import type { ConflictResolverConfig } from './conflict-resolver.js'
import type { PackageManager } from './lock-file-regeneration.js'
import type { IssueTrackerClient } from '../orchestrator/issue-tracker-client.js'
import {
  loadQualityRatchet,
  checkQualityRatchet,
  updateQualityRatchet,
  formatRatchetResult,
} from '../orchestrator/quality-ratchet.js'
import { captureQualityBaseline, type QualityConfig } from '../orchestrator/quality-baseline.js'

const exec = promisify(execCb)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MergeWorkerConfig {
  repoId: string
  repoPath: string
  strategy: 'rebase' | 'merge' | 'squash'
  testCommand: string
  testTimeout: number
  lockFileRegenerate: boolean
  mergiraf: boolean
  pollInterval: number
  maxRetries: number
  escalation: {
    onConflict: 'reassign' | 'notify' | 'park'
    onTestFailure: 'notify' | 'park' | 'retry'
  }
  deleteBranchOnMerge: boolean
  packageManager: PackageManager
  remote: string // default 'origin'
  targetBranch: string // default 'main'
  /**
   * Status names the worker uses when bubbling merge results back to the
   * issue tracker. Defaults match Linear conventions ('Accepted'/'Rejected')
   * and only matter when `deps.issueTracker` is supplied.
   */
  acceptedStatus?: string
  rejectedStatus?: string
  /**
   * In-process backoffs (ms) used when a strategy's prepare() returns
   * `retryable: true`. The worker sleeps each value in order, retrying
   * prepare() between sleeps; if all retries are exhausted the PR falls
   * through to the normal error path.
   *
   * This path is defense-in-depth — the strategies use detached checkouts
   * so the branch-conflict error that originally motivated this retry loop
   * shouldn't surface in the first place. Kept here so any future transient
   * condition (including the same conflict reappearing through a different
   * codepath) degrades gracefully.
   *
   * Default: [5000, 15000, 30000] — ~50s total budget, tuned so the worker
   * doesn't stall the rest of the queue too long on a pathological case.
   */
  retryablePrepareBackoffsMs?: number[]
}

/** Default in-process backoffs for retryable prepare failures. */
export const DEFAULT_RETRYABLE_PREPARE_BACKOFFS_MS = [5_000, 15_000, 30_000] as const

export interface MergeWorkerDeps {
  storage: {
    dequeue(repoId: string): Promise<any | null>
    markCompleted(repoId: string, prNumber: number): Promise<void>
    markFailed(repoId: string, prNumber: number, reason: string): Promise<void>
    markBlocked(repoId: string, prNumber: number, reason: string): Promise<void>
    /** Peek all queued entries without removing (used by MergePool) */
    peekAll(repoId: string): Promise<Array<{ prNumber: number; sourceBranch: string }>>
    /** Atomically dequeue multiple PRs for parallel processing (used by MergePool) */
    dequeueBatch(repoId: string, prNumbers: number[]): Promise<Array<{ prNumber: number }>>
  }
  redis: {
    setNX(key: string, value: string, ttlSeconds?: number): Promise<boolean>
    del(key: string): Promise<void>
    get(key: string): Promise<string | null>
    set(key: string, value: string): Promise<void>
    expire(key: string, seconds: number): Promise<void>
  }
  /** Optional file reservation checker for pre-merge conflict detection */
  fileReservation?: {
    checkFileConflicts(
      repoId: string,
      sessionId: string,
      filePaths: string[],
    ): Promise<Array<{ filePath: string; heldBy: { sessionId: string } }>>
  }
  /**
   * Optional issue tracker. When supplied, merge results bubble back to the
   * originating issue: success posts a comment + transitions to Accepted;
   * conflict / test-failure / error posts a comment + transitions to
   * Rejected (which triggers the existing refinement flow).
   *
   * When absent, the worker behaves as before — failure reasons land in
   * Redis and a human running `af merge-queue status` is the only consumer.
   * This keeps the worker usable in non-Linear contexts and makes tests
   * trivial to set up.
   */
  issueTracker?: IssueTrackerClient
  /**
   * Optional PR labeler. When supplied, the worker removes the
   * `approved-for-merge` label from PRs that reach a terminal failure
   * state (conflict / test-failure / error). Without this, the sidecar's
   * label poller sees the label on the next tick and re-enqueues the same
   * PR, producing a `markFailed → poller re-enqueues → dequeue → markFailed`
   * hot loop that burns Redis traffic and hammers GitHub.
   *
   * Implementations are best-effort; failures are logged but do not crash
   * the worker loop. The refinement cycle is expected to re-add the label
   * when a subsequent acceptance run passes.
   */
  prLabeler?: {
    removeApprovedForMergeLabel(prNumber: number): Promise<void>
  }
}

export interface MergeProcessResult {
  prNumber: number
  status: 'merged' | 'conflict' | 'test-failure' | 'error'
  message?: string
}

/**
 * Build the Linear comment body for a merge result. Exported for testing.
 */
export function formatMergeResultComment(
  kind: 'merged' | 'conflict' | 'test-failure' | 'error',
  prUrl: string,
  detail?: string,
): string {
  switch (kind) {
    case 'merged':
      return [
        '## ✅ Merged by the merge queue',
        '',
        `${prUrl}`,
        '',
        detail ? `> ${detail}` : '',
      ].filter(Boolean).join('\n')

    case 'conflict':
      return [
        '## ⛔ Merge conflict — sending to refinement',
        '',
        `${prUrl}`,
        '',
        'The merge queue could not resolve conflicts automatically.',
        detail ? `\n${codeBlock(detail)}` : '',
      ].filter(Boolean).join('\n')

    case 'test-failure':
      return [
        '## ❌ Tests failed during merge — sending to refinement',
        '',
        `${prUrl}`,
        '',
        'The merge queue rebased the branch onto latest main and re-ran the test suite. The tests failed against the rebased code, indicating a real conflict between this PR and changes already on main.',
        detail ? `\n${codeBlock(detail)}` : '',
      ].filter(Boolean).join('\n')

    case 'error':
      return [
        '## ⚠️ Merge queue error — sending to refinement',
        '',
        `${prUrl}`,
        '',
        'An unexpected error occurred while processing this PR through the merge queue.',
        detail ? `\n${codeBlock(detail)}` : '',
      ].filter(Boolean).join('\n')
  }
}

/** Wrap a string in a fenced code block, truncating very long output. */
function codeBlock(s: string): string {
  const MAX = 4000
  const truncated = s.length > MAX ? s.slice(0, MAX) + '\n…(truncated)' : s
  return '```\n' + truncated + '\n```'
}

// ---------------------------------------------------------------------------
// MergeWorker
// ---------------------------------------------------------------------------

export class MergeWorker {
  private running = false
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private config: MergeWorkerConfig,
    private deps: MergeWorkerDeps,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Start the merge worker. Acquires a lock, then loops processing the queue.
   */
  async start(signal?: AbortSignal): Promise<void> {
    // Acquire single-instance lock
    const lockKey = `merge:lock:${this.config.repoId}`
    const acquired = await this.deps.redis.setNX(lockKey, 'worker', 300) // 5 min TTL
    if (!acquired) {
      throw new Error(`Another merge worker is already running for repo ${this.config.repoId}`)
    }

    this.running = true
    this.startHeartbeat(lockKey)

    try {
      while (this.running && !(signal?.aborted)) {
        // Check if paused
        const paused = await this.deps.redis.get(`merge:paused:${this.config.repoId}`)
        if (paused) {
          await this.sleep(this.config.pollInterval, signal)
          continue
        }

        // Try to dequeue next PR
        const entry = await this.deps.storage.dequeue(this.config.repoId)
        if (!entry) {
          // Queue empty — poll interval wait
          await this.sleep(this.config.pollInterval, signal)
          continue
        }

        // Process the PR
        const result = await this.processEntry(entry)

        // Handle result — Redis storage marking AND issue-tracker bubble-up.
        // The two are independent: storage state is for the CLI; the bubble-up
        // is the source of truth for downstream agents (refinement on Rejected,
        // termination on Accepted). Either side failing must not block the
        // queue from advancing.
        switch (result.status) {
          case 'merged':
            await this.deps.storage.markCompleted(this.config.repoId, result.prNumber)
            await this.bubbleResultToIssue(entry, result, 'merged')
            // Remove the label even on success: GitHub's PR-state update is
            // async, so `gh pr list --state open --label approved-for-merge`
            // can still include the just-merged PR for ~10s afterwards.
            // Without this, the label poller re-enqueues the PR, the worker
            // tries to fetch the already-deleted source branch, and marks
            // it failed — bubbling a spurious Rejected status to Linear for
            // a PR that actually merged cleanly.
            await this.removeApprovedForMergeLabel(result.prNumber)
            break
          case 'conflict':
            await this.deps.storage.markBlocked(this.config.repoId, result.prNumber, result.message ?? 'Merge conflict')
            await this.bubbleResultToIssue(entry, result, 'conflict')
            await this.removeApprovedForMergeLabel(result.prNumber)
            break
          case 'test-failure': {
            const action = this.config.escalation.onTestFailure
            if (action === 'park') {
              await this.deps.storage.markBlocked(this.config.repoId, result.prNumber, result.message ?? 'Tests failed')
            } else {
              await this.deps.storage.markFailed(this.config.repoId, result.prNumber, result.message ?? 'Tests failed')
            }
            // Park demotes the issue too — it's still a "merge didn't happen"
            // signal to refinement, even if we may auto-retry later.
            await this.bubbleResultToIssue(entry, result, 'test-failure')
            await this.removeApprovedForMergeLabel(result.prNumber)
            break
          }
          case 'error':
            await this.deps.storage.markFailed(this.config.repoId, result.prNumber, result.message ?? 'Unknown error')
            await this.bubbleResultToIssue(entry, result, 'error')
            await this.removeApprovedForMergeLabel(result.prNumber)
            break
        }
      }
    } finally {
      // Graceful shutdown — release lock
      this.stopHeartbeat()
      await this.deps.redis.del(lockKey)
      this.running = false
    }
  }

  /**
   * Stop the merge worker gracefully (finishes current merge before stopping).
   */
  stop(): void {
    this.running = false
  }

  /**
   * Process a single queue entry: rebase -> resolve conflicts -> regenerate lock files -> test -> merge
   */
  async processEntry(entry: {
    prNumber: number
    sourceBranch: string
    targetBranch?: string
    issueIdentifier?: string
    prUrl?: string
  }): Promise<MergeProcessResult> {
    const strategy = createMergeStrategy(this.config.strategy)
    const conflictResolver = new ConflictResolver({
      mergirafEnabled: this.config.mergiraf,
      escalationStrategy: this.config.escalation.onConflict,
    } satisfies ConflictResolverConfig)
    const lockFileHandler = new LockFileRegeneration()

    const ctx: MergeContext = {
      repoPath: this.config.repoPath,
      worktreePath: this.config.repoPath, // In production, would use a dedicated worktree
      sourceBranch: entry.sourceBranch,
      targetBranch: entry.targetBranch ?? this.config.targetBranch,
      prNumber: entry.prNumber,
      remote: this.config.remote,
    }

    try {
      // 1. Prepare: fetch latest main.
      //
      // Transient prepare failures (strategy returns `retryable: true` — e.g.,
      // an acceptance agent's `<ISSUE>-AC` worktree still holds the branch
      // during handoff) are retried in-process with backoff before surfacing
      // to the issue as a hard failure. The strategies' detached checkouts
      // should prevent this from ever being hit in practice, but we keep the
      // retry loop as defense-in-depth — the alternative (dead-ending every
      // PR that loses the teardown race) is much worse than briefly stalling
      // the queue.
      const backoffs =
        this.config.retryablePrepareBackoffsMs ?? [...DEFAULT_RETRYABLE_PREPARE_BACKOFFS_MS]
      let prepareResult = await strategy.prepare(ctx)
      for (let i = 0; !prepareResult.success && prepareResult.retryable && i < backoffs.length; i++) {
        console.log(
          `[merge-worker] prepare returned retryable error for PR #${entry.prNumber}: ${prepareResult.error}. ` +
          `Retrying in ${backoffs[i]}ms (attempt ${i + 2}/${backoffs.length + 1})`,
        )
        await this.sleep(backoffs[i])
        prepareResult = await strategy.prepare(ctx)
      }
      if (!prepareResult.success) {
        return { prNumber: entry.prNumber, status: 'error', message: `Prepare failed: ${prepareResult.error}` }
      }

      // 1.5 Optional: check if modified files are reserved by active sessions
      if (this.deps.fileReservation) {
        try {
          const { stdout } = await exec(
            `git diff --name-only ${ctx.remote}/${ctx.targetBranch}...${ctx.sourceBranch}`,
            { cwd: ctx.repoPath },
          )
          const modifiedFiles = stdout.trim().split('\n').filter(Boolean)
          if (modifiedFiles.length > 0) {
            const conflicts = await this.deps.fileReservation.checkFileConflicts(
              this.config.repoId,
              `merge-worker-${entry.prNumber}`,
              modifiedFiles,
            )
            if (conflicts.length > 0) {
              const conflictList = conflicts.map(c => `${c.filePath} (held by ${c.heldBy.sessionId})`).join(', ')
              return {
                prNumber: entry.prNumber,
                status: 'conflict',
                message: `Files reserved by active sessions: ${conflictList}`,
              }
            }
          }
        } catch {
          // File reservation check is best-effort; don't block merge on check failure
        }
      }

      // 2. Execute merge strategy (rebase/merge/squash)
      const mergeResult = await strategy.execute(ctx)

      // 3. Handle conflicts
      if (mergeResult.status === 'conflict') {
        const resolution = await conflictResolver.resolve({
          repoPath: ctx.repoPath,
          worktreePath: ctx.worktreePath,
          sourceBranch: ctx.sourceBranch,
          targetBranch: ctx.targetBranch,
          prNumber: ctx.prNumber,
          issueIdentifier: entry.issueIdentifier ?? `PR-${entry.prNumber}`,
          conflictFiles: mergeResult.conflictFiles ?? [],
          conflictDetails: mergeResult.conflictDetails,
        })

        if (resolution.status !== 'resolved') {
          return {
            prNumber: entry.prNumber,
            status: 'conflict',
            message: resolution.message ?? `Unresolved conflicts in: ${(resolution.unresolvedFiles ?? []).join(', ')}`,
          }
        }
      } else if (mergeResult.status === 'error') {
        return { prNumber: entry.prNumber, status: 'error', message: mergeResult.error ?? 'Merge strategy failed' }
      }

      // 4. Regenerate lock files if configured
      if (lockFileHandler.shouldRegenerate(this.config.packageManager, this.config.lockFileRegenerate)) {
        const regenResult = await lockFileHandler.regenerate(ctx.worktreePath, this.config.packageManager)
        if (!regenResult.success) {
          return { prNumber: entry.prNumber, status: 'error', message: `Lock file regeneration failed: ${regenResult.error}` }
        }
      }

      // 5. Run test suite
      const testResult = await this.runTests(ctx.worktreePath)
      if (!testResult.passed) {
        return { prNumber: entry.prNumber, status: 'test-failure', message: testResult.output }
      }

      // 5.5. Quality ratchet check (if ratchet file exists)
      const ratchet = loadQualityRatchet(ctx.worktreePath)
      if (ratchet) {
        const qualityConfig: QualityConfig = {
          testCommand: this.config.testCommand,
          packageManager: this.config.packageManager as string,
        }
        const current = captureQualityBaseline(ctx.worktreePath, qualityConfig)
        if (current.tests.parseError) {
          // Log loudly — the ratchet's testCount threshold is being skipped
          // for this PR. Silent would hide degradations; failing the PR
          // would block merges for reasons orthogonal to code quality.
          console.warn(
            `[merge-worker] Quality baseline could not parse test counts for PR #${entry.prNumber}: ${current.tests.parseError}. Skipping testCount threshold.`,
          )
        }
        const ratchetResult = checkQualityRatchet(ratchet, current)
        if (!ratchetResult.passed) {
          return {
            prNumber: entry.prNumber,
            status: 'test-failure',
            message: `Quality ratchet violated: ${formatRatchetResult(ratchetResult)}`,
          }
        }

        // Tighten ratchet if metrics improved (will be included in the merge)
        const updated = updateQualityRatchet(
          ctx.worktreePath,
          current,
          entry.issueIdentifier ?? `PR-${entry.prNumber}`,
        )
        if (updated) {
          try {
            await exec(
              'git add .agentfactory/quality-ratchet.json && git commit -m "chore: tighten quality ratchet"',
              { cwd: ctx.worktreePath },
            )
          } catch {
            // Ratchet update commit is best-effort
          }
        }
      }

      // 6. Finalize: push and merge
      await strategy.finalize(ctx)

      // 7. Delete branch if configured
      if (this.config.deleteBranchOnMerge) {
        try {
          await exec(`git push ${this.config.remote} --delete ${entry.sourceBranch}`, {
            cwd: ctx.worktreePath,
          })
        } catch {
          // Branch deletion failure is non-fatal
        }
      }

      return { prNumber: entry.prNumber, status: 'merged' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { prNumber: entry.prNumber, status: 'error', message }
    }
  }

  // ---------------------------------------------------------------------------
  // Issue tracker bubble-up
  // ---------------------------------------------------------------------------

  /**
   * Bubble a merge result back to the originating issue: comment + status
   * transition. Best-effort — never throws back to the queue loop. The
   * status transition is the source of truth (comment is for humans).
   *
   * No-op when:
   *   - deps.issueTracker is not configured (worker runs in
   *     non-tracker contexts, e.g., OSS users without Linear)
   *   - the queue entry has no usable issueIdentifier (anonymous PRs
   *     enqueued via CLI rather than from an issue-driven flow)
   *
   * Status mapping:
   *   - 'merged'        → acceptedStatus  (default 'Accepted')
   *   - 'conflict'      → rejectedStatus  (default 'Rejected') — refinement picks up
   *   - 'test-failure'  → rejectedStatus
   *   - 'error'         → rejectedStatus
   */
  private async bubbleResultToIssue(
    entry: { issueIdentifier?: string; prUrl?: string; prNumber: number },
    result: MergeProcessResult,
    kind: 'merged' | 'conflict' | 'test-failure' | 'error',
  ): Promise<void> {
    const tracker = this.deps.issueTracker
    if (!tracker) return

    // Skip anonymous queue entries — `PR-N` placeholder means we never
    // resolved a real issue identifier at enqueue time. Logging the
    // outcome to a fake ticket would be worse than silence.
    const id = entry.issueIdentifier
    if (!id || /^PR-\d+$/.test(id)) return

    const acceptedStatus = this.config.acceptedStatus ?? 'Accepted'
    const rejectedStatus = this.config.rejectedStatus ?? 'Rejected'
    const targetStatus = kind === 'merged' ? acceptedStatus : rejectedStatus

    const prUrl = entry.prUrl ?? `PR #${entry.prNumber}`
    const body = formatMergeResultComment(kind, prUrl, result.message)

    let issueId: string
    try {
      const issue = await tracker.getIssue(id)
      issueId = issue.id
    } catch (err) {
      // Issue may have been archived or the tracker is unreachable.
      // Don't crash the queue — log to stderr and move on.
      console.error(`[merge-worker] Failed to resolve issue ${id} for bubble-up:`, err instanceof Error ? err.message : err)
      return
    }

    // Comment first (best-effort), then status transition. Either failing
    // is logged but not re-thrown — the queue must keep advancing.
    try {
      await tracker.createComment(issueId, body)
    } catch (err) {
      console.error(`[merge-worker] Failed to post merge-result comment to ${id}:`, err instanceof Error ? err.message : err)
    }

    try {
      await tracker.updateIssueStatus(issueId, targetStatus)
    } catch (err) {
      console.error(`[merge-worker] Failed to transition ${id} → ${targetStatus}:`, err instanceof Error ? err.message : err)
    }
  }

  /**
   * Remove the `approved-for-merge` label from a PR that reached a terminal
   * failure state. Without this, the sidecar's label poller re-enqueues the
   * same PR on its next tick and the queue hot-loops between `markFailed`
   * and re-enqueue.
   *
   * No-op when no `prLabeler` is wired (non-GitHub deployments). The
   * refinement cycle re-adds the label when a later acceptance run passes.
   */
  private async removeApprovedForMergeLabel(prNumber: number): Promise<void> {
    if (!this.deps.prLabeler) return
    try {
      await this.deps.prLabeler.removeApprovedForMergeLabel(prNumber)
    } catch (err) {
      console.error(
        `[merge-worker] Failed to remove approved-for-merge label from PR #${prNumber}:`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async runTests(worktreePath: string): Promise<{ passed: boolean; output: string }> {
    try {
      const { stdout, stderr } = await exec(this.config.testCommand, {
        cwd: worktreePath,
        timeout: this.config.testTimeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      })
      return { passed: true, output: stdout + stderr }
    } catch (error) {
      const message = error instanceof Error ? (error as any).stdout ?? error.message : String(error)
      return { passed: false, output: message }
    }
  }

  private startHeartbeat(lockKey: string): void {
    // Extend lock TTL every 60 seconds
    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.deps.redis.expire(lockKey, 300)
      } catch {
        // Heartbeat failure — will be handled by TTL expiry
      }
    }, 60_000)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
    })
  }
}
