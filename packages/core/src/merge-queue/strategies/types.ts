/**
 * Merge Strategy Types
 *
 * Pluggable interface for merge strategies (rebase, merge, squash).
 * Each strategy encapsulates how a PR branch is integrated into the target branch.
 */

/** Context passed to every merge strategy operation */
export interface MergeContext {
  /** Path to the bare repository */
  repoPath: string
  /** Path to the worktree used for merge operations */
  worktreePath: string
  /** Branch being merged (PR branch) */
  sourceBranch: string
  /** Branch being merged into (e.g. main) */
  targetBranch: string
  /** Pull request number */
  prNumber: number
  /** Git remote name (default 'origin') */
  remote: string
}

/** Result of the prepare step */
export interface PrepareResult {
  /** Whether preparation succeeded */
  success: boolean
  /** Error message if preparation failed */
  error?: string
  /** HEAD SHA after preparation */
  headSha?: string
}

/** Result of the execute (merge) step */
export interface MergeResult {
  /** Outcome of the merge attempt */
  status: 'success' | 'conflict' | 'error'
  /** SHA of the merge result commit */
  mergedSha?: string
  /** List of files with conflicts (when status is 'conflict') */
  conflictFiles?: string[]
  /** Human-readable conflict details */
  conflictDetails?: string
  /** Error message (when status is 'error') */
  error?: string
}

/**
 * Pluggable merge strategy interface.
 *
 * Lifecycle:
 *   1. prepare() — fetch latest refs and check out the working branch
 *   2. execute() — perform the merge/rebase/squash operation
 *   3. finalize() — push the result to the remote
 */
export interface MergeStrategy {
  /** Strategy identifier */
  readonly name: 'rebase' | 'merge' | 'squash'
  /** Fetch latest refs and check out the working branch */
  prepare(ctx: MergeContext): Promise<PrepareResult>
  /** Perform the merge operation */
  execute(ctx: MergeContext): Promise<MergeResult>
  /** Push the result to the remote */
  finalize(ctx: MergeContext): Promise<void>
}
