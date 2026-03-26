/**
 * Rebase Merge Strategy
 *
 * Rebases the source branch onto the target branch, then fast-forward merges.
 * Produces a linear commit history without merge commits.
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import type { MergeStrategy, MergeContext, PrepareResult, MergeResult } from './types.js'

const execAsync = promisify(exec)

export class RebaseStrategy implements MergeStrategy {
  readonly name = 'rebase' as const

  async prepare(ctx: MergeContext): Promise<PrepareResult> {
    try {
      await execAsync(`git fetch ${ctx.remote} ${ctx.targetBranch}`, { cwd: ctx.worktreePath })
      await execAsync(`git checkout ${ctx.sourceBranch}`, { cwd: ctx.worktreePath })
      const { stdout } = await execAsync('git rev-parse HEAD', { cwd: ctx.worktreePath })
      return { success: true, headSha: stdout.trim() }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async execute(ctx: MergeContext): Promise<MergeResult> {
    try {
      await execAsync(`git rebase ${ctx.remote}/${ctx.targetBranch}`, { cwd: ctx.worktreePath })
      const { stdout } = await execAsync('git rev-parse HEAD', { cwd: ctx.worktreePath })
      return { status: 'success', mergedSha: stdout.trim() }
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
    await execAsync(
      `git push ${ctx.remote} ${ctx.sourceBranch} --force-with-lease`,
      { cwd: ctx.worktreePath },
    )
    await execAsync(`git checkout ${ctx.targetBranch}`, { cwd: ctx.worktreePath })
    await execAsync(`git merge --ff-only ${ctx.sourceBranch}`, { cwd: ctx.worktreePath })
    await execAsync(`git push ${ctx.remote} ${ctx.targetBranch}`, { cwd: ctx.worktreePath })
  }
}
