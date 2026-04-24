/**
 * Squash Merge Strategy
 *
 * Squash-merges all commits from the source branch into a single commit on
 * the target. Produces a clean, linear history with one commit per PR.
 *
 * All checkouts are detached against `origin/<branch>` refs so the merge
 * worker never takes a local branch ref. See rebase-strategy.ts for the full
 * rationale — the short version is that plain `git checkout <branch>` collides
 * with any concurrent worktree (e.g., an acceptance agent's `<ISSUE>-AC`
 * worktree) that still holds the branch.
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import type { MergeStrategy, MergeContext, PrepareResult, MergeResult } from './types.js'
import { isBranchConflictError } from '../branch-conflict.js'

const execAsync = promisify(exec)

export class SquashStrategy implements MergeStrategy {
  readonly name = 'squash' as const

  async prepare(ctx: MergeContext): Promise<PrepareResult> {
    try {
      await execAsync(
        `git fetch ${ctx.remote} ${ctx.targetBranch} ${ctx.sourceBranch}`,
        { cwd: ctx.worktreePath },
      )
      await execAsync(
        `git checkout --detach ${ctx.remote}/${ctx.targetBranch}`,
        { cwd: ctx.worktreePath },
      )
      const { stdout } = await execAsync('git rev-parse HEAD', { cwd: ctx.worktreePath })
      return { success: true, headSha: stdout.trim() }
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
      await execAsync(
        `git merge --squash ${ctx.remote}/${ctx.sourceBranch}`,
        { cwd: ctx.worktreePath },
      )
      await execAsync(
        `git commit -m "Squash merge PR #${ctx.prNumber} from ${ctx.sourceBranch}"`,
        { cwd: ctx.worktreePath },
      )
      const { stdout } = await execAsync('git rev-parse HEAD', { cwd: ctx.worktreePath })
      return { status: 'success', mergedSha: stdout.trim() }
    } catch (err) {
      // Check for conflicts
      try {
        const { stdout: conflictOutput } = await execAsync(
          'git diff --name-only --diff-filter=U',
          { cwd: ctx.worktreePath },
        )
        const conflictFiles = conflictOutput.trim().split('\n').filter(Boolean)
        if (conflictFiles.length > 0) {
          await execAsync('git merge --abort', { cwd: ctx.worktreePath })
          return {
            status: 'conflict',
            conflictFiles,
            conflictDetails: `Squash merge conflict in ${conflictFiles.length} file(s)`,
          }
        }
      } catch {
        // Could not detect conflicts; fall through to error
      }

      try {
        await execAsync('git merge --abort', { cwd: ctx.worktreePath })
      } catch {
        // Abort may fail if merge was not in progress
      }
      return { status: 'error', error: err instanceof Error ? err.message : String(err) }
    }
  }

  async finalize(ctx: MergeContext): Promise<void> {
    // Push HEAD (the squash commit) to the target branch via explicit refspec
    // so we don't need a local branch ref. Because HEAD descends directly from
    // origin/<target>, this is a fast-forward push.
    await execAsync(
      `git push ${ctx.remote} HEAD:${ctx.targetBranch}`,
      { cwd: ctx.worktreePath },
    )
  }
}
