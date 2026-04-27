/**
 * Branch Conflict Detection
 *
 * Shared helpers for detecting the two git error phrasings that indicate a
 * branch is held by another worktree:
 *
 *   fatal: '<branch>' is already checked out at '<path>'
 *   fatal: '<branch>' is already used by worktree at '<path>'
 *
 * Both map to the same operational condition and are produced by different git
 * versions / codepaths (checkout vs. worktree add). The merge queue uses these
 * helpers as a defense-in-depth check — the strategies' primary guard against
 * the conflict is to issue detached-HEAD checkouts, which bypass the
 * branch-exclusivity lock entirely.
 *
 * Originally extracted from orchestrator.ts so the merge queue can reuse the
 * same detection logic without depending on the orchestrator module graph.
 */

/**
 * Returns true when the given git error message indicates the branch is
 * already associated with another worktree. Matches both "is already checked
 * out at" and "is already used by worktree at" phrasings.
 */
export function isBranchConflictError(errorMessage: string): boolean {
  return (
    errorMessage.includes('is already checked out at') ||
    errorMessage.includes('is already used by worktree at')
  )
}

/**
 * Parses the conflicting worktree path out of a git branch-conflict error.
 * Returns null when the message doesn't match the expected format.
 */
export function parseConflictingWorktreePath(errorMessage: string): string | null {
  const match = errorMessage.match(
    /(?:already checked out at|already used by worktree at)\s+'([^']+)'/,
  )
  return match?.[1] ?? null
}

/**
 * Returns true when a git error message indicates the requested remote ref
 * is missing — i.e., `git fetch <remote> <ref>` printed
 *   fatal: couldn't find remote ref <ref>
 *
 * In merge-queue context this only happens after the source branch was
 * deleted on the remote (typically by a previous successful merge that
 * removed it). The pre-flight `getPRState` check is supposed to catch
 * stale duplicate entries before we get here, but it relies on GitHub's
 * PR-state propagation — which lags the actual merge by a few seconds.
 * When the propagation hasn't landed, the duplicate falls through and
 * `prepare()` fails on the missing branch. Treating that specific error
 * as "already merged" turns the second processing attempt into a `noop`
 * instead of bubbling a spurious Rejected status to the issue.
 *
 * The caller passes the expected source branch so a missing-target-branch
 * error (which would be a real configuration problem worth surfacing) is
 * not silently swallowed.
 */
export function isMissingRemoteRefError(errorMessage: string, sourceBranch: string): boolean {
  if (!errorMessage.includes("couldn't find remote ref")) return false
  return errorMessage.includes(`couldn't find remote ref ${sourceBranch}`)
}
