/**
 * Workarea — Structured Result types for git-worktree operations
 *
 * Discriminated unions so callers can handle expected failures without
 * catching exceptions.  The pattern mirrors Rust's Result<T, E>:
 *
 *   const r = addWorktree(repo, 'main', '/tmp/wt')
 *   if (!r.ok) {
 *     // r.error is typed — exhaustive switch possible
 *   }
 */

// ---------------------------------------------------------------------------
// Core Result<T, E>
// ---------------------------------------------------------------------------

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }

// Convenience helpers

export function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

export function err<E>(error: E): { ok: false; error: E } {
  return { ok: false, error }
}

// ---------------------------------------------------------------------------
// addWorktree
// ---------------------------------------------------------------------------

/**
 * Expected failure modes for addWorktree().
 *
 * - `branch-exists`   — the branch already exists; pass an existing branch to
 *                       the underlying add call to check it out instead.
 * - `path-exists`     — the target directory already exists on disk.
 * - `protected-path`  — the path is the main repo root, inside
 *                       `rensei-architecture/`, or under `runs/`.
 * - `git-error`       — git returned a non-zero exit code for another reason.
 */
export type AddWorktreeError =
  | 'branch-exists'
  | 'path-exists'
  | 'protected-path'
  | 'git-error'

export interface AddWorktreeValue {
  /** Absolute, resolved path of the newly-created worktree. */
  path: string
  /** The ref (branch/commit) that was checked out. */
  ref: string
}

export type AddWorktreeResult = Result<AddWorktreeValue, AddWorktreeError>

// ---------------------------------------------------------------------------
// removeWorktree
// ---------------------------------------------------------------------------

/**
 * Expected failure modes for removeWorktree().
 *
 * - `not-found`       — the path does not exist; treated as a no-op by
 *                       callers that want idempotency.
 * - `protected-path`  — same protection as addWorktree.
 * - `git-error`       — git returned a non-zero exit code.
 */
export type RemoveWorktreeError =
  | 'not-found'
  | 'protected-path'
  | 'git-error'

export type RemoveWorktreeResult = Result<void, RemoveWorktreeError>

// ---------------------------------------------------------------------------
// listWorktrees
// ---------------------------------------------------------------------------

export interface WorktreeEntry {
  /** Absolute path to the worktree directory. */
  path: string
  /** HEAD commit hash (40-char SHA). */
  head: string
  /** Checked-out branch name, or null for a detached HEAD. */
  branch: string | null
  /** True when this entry is the main (primary) working tree. */
  isMain: boolean
}

/**
 * Expected failure modes for listWorktrees().
 *
 * - `git-error` — git returned a non-zero exit code.
 */
export type ListWorktreesError = 'git-error'

export type ListWorktreesResult = Result<WorktreeEntry[], ListWorktreesError>

// ---------------------------------------------------------------------------
// cleanWorktree
// ---------------------------------------------------------------------------

/**
 * What cleanWorktree() removed.
 */
export interface CleanWorktreeValue {
  /** Paths deleted during the clean operation. */
  removed: string[]
}

/**
 * Expected failure modes for cleanWorktree().
 *
 * - `not-found`       — path does not exist.
 * - `protected-path`  — path is main repo root, rensei-architecture, or runs/.
 * - `invalid-worktree`— path exists but is not a valid git worktree.
 * - `git-error`       — git clean / checkout returned a non-zero exit code.
 */
export type CleanWorktreeError =
  | 'not-found'
  | 'protected-path'
  | 'invalid-worktree'
  | 'git-error'

export type CleanWorktreeResult = Result<CleanWorktreeValue, CleanWorktreeError>
