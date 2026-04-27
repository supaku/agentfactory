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
  /**
   * When true, the failure is transient and the merge worker should requeue
   * the PR with backoff instead of surfacing a hard failure to the issue.
   *
   * Currently set when prepare detects a branch-conflict error — the branch
   * is held by another worktree (typically the acceptance agent's `-AC`
   * worktree whose teardown races with merge-queue handoff). The detached
   * checkouts used by the strategies bypass this lock, but this field lets
   * any lingering cases degrade gracefully rather than dead-end the PR.
   */
  retryable?: boolean
  /**
   * When true, the failure indicates the source branch no longer exists on
   * the remote — almost always because a previous successful merge for the
   * same PR already deleted it. The merge worker treats this as `noop` so
   * the queue advances without bubbling a spurious Rejected status to the
   * originating issue.
   *
   * Closes the residual race left by the `getPRState` pre-flight check:
   * GitHub's PR-state transition can lag the actual merge by a few seconds,
   * so a duplicate dequeue that fires inside that window passes pre-flight
   * (state still OPEN) and then fails here on the missing branch.
   */
  alreadyMerged?: boolean
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
