/**
 * Rebase Merge Strategy
 *
 * Rebases the source branch onto the target branch, then fast-forward updates
 * the target on the remote. Produces a linear commit history without merge
 * commits.
 *
 * ## Detached-HEAD checkouts
 *
 * Every checkout this strategy performs uses `--detach` against a remote
 * tracking ref (`origin/<branch>`) rather than the local branch name. Git
 * enforces per-branch exclusivity across worktrees: if another worktree (for
 * example, the acceptance agent's `<ISSUE>-AC` worktree that still exists
 * during the acceptance→merge-queue handoff) holds `<branch>`, a plain
 * `git checkout <branch>` fails with:
 *
 *   fatal: '<branch>' is already used by worktree at '<path>'
 *
 * Detached checkouts are not subject to that lock — the merge worker can
 * rebase and push without coordinating with whoever else may still have the
 * branch checked out. Updates to remote refs go through refspec pushes
 * (`HEAD:<branch>`) so we never need a local branch ref.
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import type { MergeStrategy, MergeContext, PrepareResult, MergeResult } from './types.js'
import { isBranchConflictError } from '../branch-conflict.js'

const execAsync = promisify(exec)

/**
 * Tracks the SHA captured during prepare() and updated by execute(). finalize()
 * uses this to push without needing a local branch ref.
 */
interface RebaseState {
  preparedSha?: string
  rebasedSha?: string
}

const stateByContext = new WeakMap<MergeContext, RebaseState>()

function getState(ctx: MergeContext): RebaseState {
  let s = stateByContext.get(ctx)
  if (!s) {
    s = {}
    stateByContext.set(ctx, s)
  }
  return s
}

export class RebaseStrategy implements MergeStrategy {
  readonly name = 'rebase' as const

  async prepare(ctx: MergeContext): Promise<PrepareResult> {
    try {
      await execAsync(
        `git fetch ${ctx.remote} ${ctx.targetBranch} ${ctx.sourceBranch}`,
        { cwd: ctx.worktreePath },
      )
      // Detached checkout at the source tip — bypasses the per-branch
      // worktree lock. See the module-level comment for the full rationale.
      await execAsync(
        `git checkout --detach ${ctx.remote}/${ctx.sourceBranch}`,
        { cwd: ctx.worktreePath },
      )
      const { stdout } = await execAsync('git rev-parse HEAD', { cwd: ctx.worktreePath })
      const headSha = stdout.trim()
      getState(ctx).preparedSha = headSha
      return { success: true, headSha }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (isBranchConflictError(message)) {
        return { success: false, error: message, retryable: true }
      }
      return { success: false, error: message }
    }
  }

  async execute(ctx: MergeContext): Promise<MergeResult> {
    try {
      await execAsync(`git rebase ${ctx.remote}/${ctx.targetBranch}`, { cwd: ctx.worktreePath })
      const { stdout } = await execAsync('git rev-parse HEAD', { cwd: ctx.worktreePath })
      const mergedSha = stdout.trim()
      getState(ctx).rebasedSha = mergedSha
      return { status: 'success', mergedSha }
    } catch (err) {
      // Check if this is a conflict
      try {
        const { stdout: conflictOutput } = await execAsync(
          'git diff --name-only --diff-filter=U',
          { cwd: ctx.worktreePath },
        )
        const conflictFiles = conflictOutput.trim().split('\n').filter(Boolean)
        if (conflictFiles.length > 0) {
          await execAsync('git rebase --abort', { cwd: ctx.worktreePath })
          return {
            status: 'conflict',
            conflictFiles,
            conflictDetails: `Rebase conflict in ${conflictFiles.length} file(s)`,
          }
        }
      } catch {
        // Could not detect conflicts; fall through to error
      }

      // Not a conflict — abort rebase and return error
      try {
        await execAsync('git rebase --abort', { cwd: ctx.worktreePath })
      } catch {
        // Abort may fail if rebase was not in progress
      }
      return { status: 'error', error: err instanceof Error ? err.message : String(err) }
    }
  }

  async finalize(ctx: MergeContext): Promise<void> {
    const state = getState(ctx)
    const rebasedSha = state.rebasedSha
      ?? (await execAsync('git rev-parse HEAD', { cwd: ctx.worktreePath })).stdout.trim()

    // Push the rebased commits back to the source branch on the remote. Using
    // an explicit refspec (HEAD:<source>) means we don't need a local branch
    // ref — important because we're operating from a detached HEAD.
    //
    // --force-with-lease=<ref> uses our local remote-tracking ref as the lease
    // value, so the push fails if someone else advanced the source branch on
    // the remote since our `git fetch` in prepare(). That preserves the safety
    // property of --force-with-lease without needing a local branch.
    await execAsync(
      `git push ${ctx.remote} HEAD:${ctx.sourceBranch} --force-with-lease=${ctx.sourceBranch}`,
      { cwd: ctx.worktreePath },
    )

    // Fast-forward the target on the remote to the rebased SHA. Because we
    // rebased onto the latest origin/<target>, the rebased SHA is a direct
    // descendant of the remote target — this is a pure fast-forward push.
    await execAsync(
      `git push ${ctx.remote} ${rebasedSha}:${ctx.targetBranch}`,
      { cwd: ctx.worktreePath },
    )
  }
}
