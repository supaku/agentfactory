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
