/**
 * Merge Commit Strategy
 *
 * Performs a standard merge commit (--no-ff) from the source branch into the target.
 * Preserves full branch history with an explicit merge commit.
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import type { MergeStrategy, MergeContext, PrepareResult, MergeResult } from './types.js'

const execAsync = promisify(exec)

export class MergeCommitStrategy implements MergeStrategy {
  readonly name = 'merge' as const

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
        `git merge --no-ff ${ctx.remote}/${ctx.sourceBranch} -m "Merge PR #${ctx.prNumber} from ${ctx.sourceBranch}"`,
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
            conflictDetails: `Merge conflict in ${conflictFiles.length} file(s)`,
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
