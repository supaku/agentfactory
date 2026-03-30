/**
 * Merge Queue Adapter Interface
 *
 * Provider-agnostic abstraction for merge queue operations.
 * Supports GitHub native merge queue, Mergify, and Trunk.
 * Concrete implementations live in adapters/ subdirectory.
 */

/** Supported merge queue provider names */
export type MergeQueueProviderName = 'github-native' | 'local' | 'mergify' | 'trunk'

/** Status of a PR in the merge queue */
export interface MergeQueueStatus {
  /** Current state in the merge queue */
  state: 'queued' | 'merging' | 'merged' | 'failed' | 'blocked' | 'not-queued'
  /** Position in queue (1-based), undefined if not queued */
  position?: number
  /** Estimated time until merge, if available */
  estimatedMergeTime?: Date
  /** Reason for failure, if state is 'failed' or 'blocked' */
  failureReason?: string
  /** Status of required checks */
  checksStatus: { name: string; status: 'pass' | 'fail' | 'pending' }[]
}

/**
 * Provider-agnostic merge queue adapter.
 *
 * Each implementation wraps a specific merge queue provider's API
 * (GitHub native, Mergify, Trunk) behind this common interface.
 * The adapter handles only queue management — conflict resolution
 * is handled at the git level by mergiraf.
 */
export interface MergeQueueAdapter {
  /** Provider name identifier */
  readonly name: MergeQueueProviderName

  /** Check if a PR is eligible for merge queue entry */
  canEnqueue(owner: string, repo: string, prNumber: number): Promise<boolean>

  /** Add a PR to the merge queue */
  enqueue(owner: string, repo: string, prNumber: number): Promise<MergeQueueStatus>

  /** Get current queue status for a PR */
  getStatus(owner: string, repo: string, prNumber: number): Promise<MergeQueueStatus>

  /** Remove a PR from the merge queue */
  dequeue(owner: string, repo: string, prNumber: number): Promise<void>

  /** Check if a repository has merge queue enabled */
  isEnabled(owner: string, repo: string): Promise<boolean>
}
