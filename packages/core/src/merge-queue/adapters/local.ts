/**
 * Local Merge Queue Adapter
 *
 * Self-hosted merge queue that uses the built-in merge worker + Redis storage
 * instead of an external service like GitHub's merge queue. This is the default
 * provider — it works with any GitHub repository without requiring GitHub's
 * paid merge queue feature.
 *
 * The adapter handles queue management (enqueue/dequeue/status). The merge worker
 * (merge-worker.ts) handles the actual rebase → resolve → test → merge pipeline.
 *
 * PR eligibility is checked via `gh pr view` CLI (no GraphQL needed).
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import type { MergeQueueAdapter, MergeQueueStatus } from '../types.js'

const execAsync = promisify(exec)

/** Timeout for gh CLI calls */
const GH_CLI_TIMEOUT = 15_000

// ---------------------------------------------------------------------------
// Storage interface (injected to avoid coupling to server package)
// ---------------------------------------------------------------------------

export interface LocalMergeQueueStorage {
  enqueue(entry: {
    repoId: string
    prNumber: number
    prUrl: string
    issueIdentifier: string
    priority: number
    sourceBranch: string
    targetBranch: string
  }): Promise<void>

  dequeue(repoId: string): Promise<{ prNumber: number } | null>

  /** Get queue depth for a repo */
  getQueueDepth(repoId: string): Promise<number>

  /** Check if a PR is already in the queue */
  isEnqueued(repoId: string, prNumber: number): Promise<boolean>

  /** Get position of a PR in the queue (1-based), or null if not queued */
  getPosition(repoId: string, prNumber: number): Promise<number | null>

  /** Remove a specific PR from the queue */
  remove(repoId: string, prNumber: number): Promise<void>

  /** Get failed/blocked status for a PR */
  getFailedReason(repoId: string, prNumber: number): Promise<string | null>
  getBlockedReason(repoId: string, prNumber: number): Promise<string | null>
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class LocalMergeQueueAdapter implements MergeQueueAdapter {
  readonly name = 'local' as const

  constructor(private storage: LocalMergeQueueStorage) {}

  /**
   * Check if a PR is eligible for the local merge queue.
   * Uses `gh pr view` to verify PR is open. Does NOT require the PR to be
   * conflict-free — the merge worker handles rebasing.
   */
  async canEnqueue(owner: string, repo: string, prNumber: number): Promise<boolean> {
    try {
      const { stdout } = await execAsync(
        `gh pr view ${prNumber} --repo ${owner}/${repo} --json state,headRefName`,
        { timeout: GH_CLI_TIMEOUT },
      )
      const pr = JSON.parse(stdout)
      // PR must be open
      return pr.state === 'OPEN'
    } catch {
      return false
    }
  }

  /**
   * Add a PR to the local merge queue.
   * The merge worker will pick it up and process it (rebase, test, merge).
   */
  async enqueue(owner: string, repo: string, prNumber: number): Promise<MergeQueueStatus> {
    const repoId = `${owner}/${repo}`

    // Check if already enqueued
    const alreadyQueued = await this.storage.isEnqueued(repoId, prNumber)
    if (alreadyQueued) {
      return this.getStatus(owner, repo, prNumber)
    }

    // Fetch PR details for the queue entry
    let sourceBranch = `pr-${prNumber}`
    let prUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`
    try {
      const { stdout } = await execAsync(
        `gh pr view ${prNumber} --repo ${owner}/${repo} --json headRefName,url`,
        { timeout: GH_CLI_TIMEOUT },
      )
      const pr = JSON.parse(stdout)
      sourceBranch = pr.headRefName ?? sourceBranch
      prUrl = pr.url ?? prUrl
    } catch {
      // Fall back to defaults
    }

    await this.storage.enqueue({
      repoId,
      prNumber,
      prUrl,
      issueIdentifier: `PR-${prNumber}`,
      priority: 3, // Default priority; orchestrator can override
      sourceBranch,
      targetBranch: 'main',
    })

    return this.getStatus(owner, repo, prNumber)
  }

  /**
   * Get the status of a PR in the local merge queue.
   */
  async getStatus(owner: string, repo: string, prNumber: number): Promise<MergeQueueStatus> {
    const repoId = `${owner}/${repo}`

    // Check if in queue
    const position = await this.storage.getPosition(repoId, prNumber)
    if (position !== null) {
      return {
        state: position === 1 ? 'merging' : 'queued',
        position,
        checksStatus: [],
      }
    }

    // Check if failed
    const failedReason = await this.storage.getFailedReason(repoId, prNumber)
    if (failedReason) {
      return {
        state: 'failed',
        failureReason: failedReason,
        checksStatus: [],
      }
    }

    // Check if blocked (conflict)
    const blockedReason = await this.storage.getBlockedReason(repoId, prNumber)
    if (blockedReason) {
      return {
        state: 'blocked',
        failureReason: blockedReason,
        checksStatus: [],
      }
    }

    // Check if PR was already merged
    try {
      const { stdout } = await execAsync(
        `gh pr view ${prNumber} --repo ${owner}/${repo} --json state`,
        { timeout: GH_CLI_TIMEOUT },
      )
      const pr = JSON.parse(stdout)
      if (pr.state === 'MERGED') {
        return { state: 'merged', checksStatus: [] }
      }
    } catch {
      // Fall through to not-queued
    }

    return { state: 'not-queued', checksStatus: [] }
  }

  /**
   * Remove a PR from the local merge queue.
   */
  async dequeue(owner: string, repo: string, prNumber: number): Promise<void> {
    const repoId = `${owner}/${repo}`
    await this.storage.remove(repoId, prNumber)
  }

  /**
   * Local merge queue is always available (no external service dependency).
   */
  async isEnabled(_owner: string, _repo: string): Promise<boolean> {
    return true
  }
}
