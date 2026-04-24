/**
 * Worktree State Cleanup
 *
 * Resets the merge worker's worktree to a clean state at the start of every
 * prepare(). Needed because the `__merge-worker__` worktree is reused across
 * PRs and any number of steps between prepare() and finalize() can leave it
 * dirty in ways that block the next PR's `git rebase`/`git merge`:
 *
 *   - `lock-file-regeneration.ts` stages the regenerated lock file but does
 *     not commit it; if the subsequent test step fails, the stage persists.
 *   - `pnpm install` (etc.) can modify other tracked files as a side effect.
 *   - A conflicted rebase that raced cleanup may leave `.git/rebase-apply`.
 *   - The quality-ratchet auto-commit can fail mid-flight, leaving staged
 *     changes or a dirty working tree.
 *
 * Without this reset, the second PR after a test failure hits:
 *
 *   error: cannot rebase: Your index contains uncommitted changes.
 *   error: Please commit or stash them.
 *
 * The cleanup is aggressive but scoped: it aborts in-progress rebase/merge,
 * resets to the current HEAD (enough to clear the index), and cleans
 * untracked files. It does NOT use `git clean -x`, so ignored files (e.g.
 * `node_modules/`) survive — otherwise we'd lose 30s+ on every prepare
 * reinstalling dependencies.
 */

import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

/**
 * Reset a merge-worker worktree to a clean state. Best-effort: every step is
 * individually swallowed because the corresponding precondition may not
 * apply on a given run (no rebase in progress, HEAD not yet set, etc.). The
 * subsequent prepare() checkout will surface any genuine failure.
 */
export async function cleanWorktreeState(worktreePath: string): Promise<void> {
  // Abort anything in-flight so the reset can take effect.
  await execAsync('git rebase --abort', { cwd: worktreePath }).catch(() => { /* no rebase */ })
  await execAsync('git merge --abort', { cwd: worktreePath }).catch(() => { /* no merge */ })
  await execAsync('git cherry-pick --abort', { cwd: worktreePath }).catch(() => { /* no cherry-pick */ })

  // Clear the index and working tree to match HEAD. If HEAD is detached
  // (normal for the merge worktree), this resets to the current commit
  // which is enough to clear staged changes from the previous PR. The
  // detached checkout that follows in prepare() will move HEAD to the
  // correct source tip.
  await execAsync('git reset --hard HEAD', { cwd: worktreePath }).catch(() => { /* HEAD unset */ })

  // Remove untracked files (but not ignored files — keep node_modules).
  await execAsync('git clean -fd', { cwd: worktreePath }).catch(() => { /* nothing to clean */ })
}
