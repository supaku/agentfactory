/**
 * GitHub Native Merge Queue Adapter
 *
 * Implements MergeQueueAdapter for GitHub's built-in merge queue feature.
 * Uses `gh api graphql` CLI for all GitHub API interactions.
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import type { MergeQueueAdapter, MergeQueueStatus } from '../types.js'

const execAsync = promisify(exec)

/** Timeout for GitHub API calls (30s) */
const GH_API_TIMEOUT = 30000

/** Maximum retries for transient failures */
const MAX_RETRIES = 2

/** Backoff delay between retries (ms) */
const RETRY_DELAY = 1000

export class GitHubNativeMergeQueueAdapter implements MergeQueueAdapter {
  readonly name = 'github-native' as const

  async canEnqueue(owner: string, repo: string, prNumber: number): Promise<boolean> {
    try {
      const query = `
        query($owner: String!, $repo: String!, $prNumber: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $prNumber) {
              mergeable
              reviewDecision
              mergeQueueEntry { state }
            }
          }
        }
      `
      const result = await this.graphql<{
        repository: {
          pullRequest: {
            mergeable: string
            reviewDecision: string | null
            mergeQueueEntry: { state: string } | null
          }
        }
      }>(query, { owner, repo, prNumber })

      const pr = result.repository.pullRequest
      // Already in queue
      if (pr.mergeQueueEntry) return false
      // Must be mergeable
      if (pr.mergeable !== 'MERGEABLE') return false
      // Must be approved (if reviews are required)
      if (pr.reviewDecision && pr.reviewDecision !== 'APPROVED') return false

      return true
    } catch {
      return false
    }
  }

  async enqueue(owner: string, repo: string, prNumber: number): Promise<MergeQueueStatus> {
    // First get the PR's node ID
    const prId = await this.getPRNodeId(owner, repo, prNumber)

    const mutation = `
      mutation($prId: ID!) {
        enqueuePullRequest(input: { pullRequestId: $prId }) {
          mergeQueueEntry {
            state
            position
            headCommit { oid }
            enqueuedAt
          }
        }
      }
    `

    try {
      const result = await this.graphql<{
        enqueuePullRequest: {
          mergeQueueEntry: {
            state: string
            position: number
            headCommit: { oid: string }
            enqueuedAt: string
          }
        }
      }>(mutation, { prId })

      const entry = result.enqueuePullRequest.mergeQueueEntry
      return this.mapEntryToStatus(entry)
    } catch (error) {
      return {
        state: 'failed',
        failureReason: error instanceof Error ? error.message : String(error),
        checksStatus: [],
      }
    }
  }

  async getStatus(owner: string, repo: string, prNumber: number): Promise<MergeQueueStatus> {
    const query = `
      query($owner: String!, $repo: String!, $prNumber: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $prNumber) {
            mergeQueueEntry {
              state
              position
              headCommit { oid }
              enqueuedAt
            }
            commits(last: 1) {
              nodes {
                commit {
                  statusCheckRollup {
                    contexts(first: 50) {
                      nodes {
                        ... on CheckRun {
                          name
                          conclusion
                          status
                        }
                        ... on StatusContext {
                          context
                          state
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `

    const result = await this.graphql<{
      repository: {
        pullRequest: {
          mergeQueueEntry: {
            state: string
            position: number
            headCommit: { oid: string }
            enqueuedAt: string
          } | null
          commits: {
            nodes: Array<{
              commit: {
                statusCheckRollup: {
                  contexts: {
                    nodes: Array<
                      | { name: string; conclusion: string | null; status: string }
                      | { context: string; state: string }
                    >
                  }
                } | null
              }
            }>
          }
        }
      }
    }>(query, { owner, repo, prNumber })

    const pr = result.repository.pullRequest
    if (!pr.mergeQueueEntry) {
      return { state: 'not-queued', checksStatus: [] }
    }

    const status = this.mapEntryToStatus(pr.mergeQueueEntry)

    // Map check statuses
    const commitNode = pr.commits.nodes[0]
    if (commitNode?.commit.statusCheckRollup) {
      status.checksStatus = commitNode.commit.statusCheckRollup.contexts.nodes.map((node) => {
        if ('name' in node) {
          return {
            name: node.name,
            status: node.conclusion === 'SUCCESS' ? 'pass' as const
              : node.status === 'COMPLETED' ? 'fail' as const
              : 'pending' as const,
          }
        }
        return {
          name: node.context,
          status: node.state === 'SUCCESS' ? 'pass' as const
            : node.state === 'PENDING' ? 'pending' as const
            : 'fail' as const,
        }
      })
    }

    return status
  }

  async dequeue(owner: string, repo: string, prNumber: number): Promise<void> {
    const prId = await this.getPRNodeId(owner, repo, prNumber)

    const mutation = `
      mutation($prId: ID!) {
        dequeuePullRequest(input: { pullRequestId: $prId }) {
          mergeQueueEntry {
            state
          }
        }
      }
    `

    await this.graphql(mutation, { prId })
  }

  async isEnabled(owner: string, repo: string): Promise<boolean> {
    // Check rulesets first (modern path), then fall back to legacy branch protection.
    // GitHub is deprecating legacy branch protection rules in favor of rulesets.

    // 1. Check rulesets via REST API — look for merge_queue rule on the default branch
    try {
      const rulesEnabled = await this.checkRulesetsMergeQueue(owner, repo)
      if (rulesEnabled) return true
    } catch {
      // Rulesets API may not be available (older GHES), fall through to legacy
    }

    // 2. Fall back to legacy branch protection GraphQL query
    try {
      const query = `
        query($owner: String!, $repo: String!) {
          repository(owner: $owner, name: $repo) {
            defaultBranchRef {
              branchProtectionRule {
                requiresMergeQueue
              }
            }
          }
        }
      `
      const result = await this.graphql<{
        repository: {
          defaultBranchRef: {
            branchProtectionRule: {
              requiresMergeQueue: boolean
            } | null
          } | null
        }
      }>(query, { owner, repo })

      return result.repository.defaultBranchRef?.branchProtectionRule?.requiresMergeQueue ?? false
    } catch {
      return false
    }
  }

  /**
   * Check if merge queue is enabled via GitHub Rulesets (the modern replacement
   * for legacy branch protection rules).
   *
   * Queries the REST API for active rules on the default branch and checks
   * for a 'merge_queue' rule type.
   */
  private async checkRulesetsMergeQueue(owner: string, repo: string): Promise<boolean> {
    const command = `gh api repos/${owner}/${repo}/rules/branches/main --jq '[.[] | select(.type == "merge_queue")] | length'`

    let lastError: Error | null = null
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const { stdout } = await execAsync(command, { timeout: GH_API_TIMEOUT })
        const count = parseInt(stdout.trim(), 10)
        return count > 0
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if (attempt < MAX_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY * (attempt + 1)))
        }
      }
    }

    throw lastError!
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Get the GraphQL node ID for a PR */
  private async getPRNodeId(owner: string, repo: string, prNumber: number): Promise<string> {
    const query = `
      query($owner: String!, $repo: String!, $prNumber: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $prNumber) {
            id
          }
        }
      }
    `
    const result = await this.graphql<{
      repository: { pullRequest: { id: string } }
    }>(query, { owner, repo, prNumber })

    return result.repository.pullRequest.id
  }

  /** Execute a GraphQL query/mutation via gh CLI with retry */
  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const varsArgs = Object.entries(variables)
      .map(([key, value]) => {
        if (typeof value === 'number') {
          return `-F ${key}=${value}`
        }
        return `-f ${key}=${String(value)}`
      })
      .join(' ')

    const command = `gh api graphql -f query='${query.replace(/'/g, "'\\''")}' ${varsArgs}`

    let lastError: Error | null = null
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const { stdout } = await execAsync(command, { timeout: GH_API_TIMEOUT })
        const response = JSON.parse(stdout)
        if (response.errors?.length) {
          throw new Error(response.errors.map((e: { message: string }) => e.message).join('; '))
        }
        return response.data as T
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if (attempt < MAX_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY * (attempt + 1)))
        }
      }
    }

    throw lastError!
  }

  /** Map GitHub merge queue entry to our MergeQueueStatus */
  private mapEntryToStatus(entry: { state: string; position?: number; enqueuedAt?: string }): MergeQueueStatus {
    const stateMap: Record<string, MergeQueueStatus['state']> = {
      QUEUED: 'queued',
      AWAITING_CHECKS: 'queued',
      MERGEABLE: 'merging',
      MERGED: 'merged',
      UNMERGEABLE: 'failed',
      LOCKED: 'blocked',
    }

    return {
      state: stateMap[entry.state] ?? 'not-queued',
      position: entry.position,
      checksStatus: [],
    }
  }
}
