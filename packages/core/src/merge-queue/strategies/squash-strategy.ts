/**
 * Squash Merge Strategy
 *
 * Squash-merges all commits from the source branch into a single commit on the target.
 * Produces a clean, linear history with one commit per PR.
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import type { MergeStrategy, MergeContext, PrepareResult, MergeResult } from './types.js'

const execAsync = promisify(exec)

export class SquashStrategy implements MergeStrategy {
  readonly name = 'squash' as const

  async prepare(ctx: MergeContext): Promise<PrepareResult> {
    try {
      await execAsync(`git fetch ${ctx.remote} ${ctx.targetBranch}`, { cwd: ctx.worktreePath })
      await execAsync(`git checkout ${ctx.targetBranch}`, { cwd: ctx.worktreePath })
      const { stdout } = await execAsync('git rev-parse HEAD', { cwd: ctx.worktreePath })
      return { success: true, headSha: stdout.trim() }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
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
    await execAsync(`git push ${ctx.remote} ${ctx.targetBranch}`, { cwd: ctx.worktreePath })
  }
}
