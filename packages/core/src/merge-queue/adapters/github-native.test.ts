import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('child_process', () => ({
  exec: vi.fn(),
}))

import { exec } from 'child_process'
import { GitHubNativeMergeQueueAdapter } from './github-native.js'

const mockExec = vi.mocked(exec)

function mockGraphQLResponse(data: unknown) {
  mockExec.mockImplementation((_cmd: string, _opts: unknown, callback?: Function) => {
    // exec with options has callback as 3rd arg
    const cb = typeof _opts === 'function' ? _opts : callback
    cb?.(null, { stdout: JSON.stringify({ data }) })
    return {} as ReturnType<typeof exec>
  })
}

function mockGraphQLError(message: string) {
  mockExec.mockImplementation((_cmd: string, _opts: unknown, callback?: Function) => {
    const cb = typeof _opts === 'function' ? _opts : callback
    cb?.(new Error(message), { stdout: '' })
    return {} as ReturnType<typeof exec>
  })
}

function mockGraphQLErrorResponse(errors: Array<{ message: string }>) {
  mockExec.mockImplementation((_cmd: string, _opts: unknown, callback?: Function) => {
    const cb = typeof _opts === 'function' ? _opts : callback
    cb?.(null, { stdout: JSON.stringify({ errors }) })
    return {} as ReturnType<typeof exec>
  })
}

describe('GitHubNativeMergeQueueAdapter', () => {
  let adapter: GitHubNativeMergeQueueAdapter

  beforeEach(() => {
    vi.clearAllMocks()
    adapter = new GitHubNativeMergeQueueAdapter()
  })

  it('has name "github-native"', () => {
    expect(adapter.name).toBe('github-native')
  })

  describe('canEnqueue', () => {
    it('returns true when PR is mergeable and approved', async () => {
      mockGraphQLResponse({
        repository: {
          pullRequest: {
            mergeable: 'MERGEABLE',
            reviewDecision: 'APPROVED',
            mergeQueueEntry: null,
          },
        },
      })

      const result = await adapter.canEnqueue('owner', 'repo', 1)
      expect(result).toBe(true)
    })

    it('returns false when PR is already in queue', async () => {
      mockGraphQLResponse({
        repository: {
          pullRequest: {
            mergeable: 'MERGEABLE',
            reviewDecision: 'APPROVED',
            mergeQueueEntry: { state: 'QUEUED' },
          },
        },
      })

      const result = await adapter.canEnqueue('owner', 'repo', 1)
      expect(result).toBe(false)
    })

    it('returns false when PR is not mergeable', async () => {
      mockGraphQLResponse({
        repository: {
          pullRequest: {
            mergeable: 'CONFLICTING',
            reviewDecision: 'APPROVED',
            mergeQueueEntry: null,
          },
        },
      })

      const result = await adapter.canEnqueue('owner', 'repo', 1)
      expect(result).toBe(false)
    })

    it('returns false when PR is not approved', async () => {
      mockGraphQLResponse({
        repository: {
          pullRequest: {
            mergeable: 'MERGEABLE',
            reviewDecision: 'CHANGES_REQUESTED',
            mergeQueueEntry: null,
          },
        },
      })

      const result = await adapter.canEnqueue('owner', 'repo', 1)
      expect(result).toBe(false)
    })

    it('returns true when reviewDecision is null (no reviews required)', async () => {
      mockGraphQLResponse({
        repository: {
          pullRequest: {
            mergeable: 'MERGEABLE',
            reviewDecision: null,
            mergeQueueEntry: null,
          },
        },
      })

      const result = await adapter.canEnqueue('owner', 'repo', 1)
      expect(result).toBe(true)
    })

    it('returns false on API error', async () => {
      mockGraphQLError('API rate limit exceeded')

      const result = await adapter.canEnqueue('owner', 'repo', 1)
      expect(result).toBe(false)
    })
  })

  describe('enqueue', () => {
    it('enqueues a PR and returns status', async () => {
      // First graphql call: getPRNodeId, Second: enqueue mutation
      function mockExecOnce(data: unknown) {
        mockExec.mockImplementationOnce((_cmd: string, _opts: unknown, callback?: Function) => {
          const cb = typeof _opts === 'function' ? _opts : callback
          cb?.(null, { stdout: JSON.stringify({ data }) })
          return {} as ReturnType<typeof exec>
        })
      }
      mockExecOnce({ repository: { pullRequest: { id: 'PR_node_123' } } })
      mockExecOnce({
        enqueuePullRequest: {
          mergeQueueEntry: {
            state: 'QUEUED',
            position: 1,
            headCommit: { oid: 'abc123' },
            enqueuedAt: '2026-03-24T00:00:00Z',
          },
        },
      })

      const result = await adapter.enqueue('owner', 'repo', 1)
      expect(result.state).toBe('queued')
      expect(result.position).toBe(1)
    })

    it('returns failed status when enqueue mutation throws', async () => {
      // getPRNodeId succeeds
      mockExec.mockImplementationOnce((_cmd: string, _opts: unknown, callback?: Function) => {
        const cb = typeof _opts === 'function' ? _opts : callback
        cb?.(null, {
          stdout: JSON.stringify({
            data: { repository: { pullRequest: { id: 'PR_node_123' } } },
          }),
        })
        return {} as ReturnType<typeof exec>
      })
      // enqueue mutation fails (all retries)
      mockExec.mockImplementation((_cmd: string, _opts: unknown, callback?: Function) => {
        const cb = typeof _opts === 'function' ? _opts : callback
        cb?.(new Error('Permission denied'), { stdout: '' })
        return {} as ReturnType<typeof exec>
      })

      const result = await adapter.enqueue('owner', 'repo', 1)
      expect(result.state).toBe('failed')
      expect(result.failureReason).toContain('Permission denied')
    })
  })

  describe('getStatus', () => {
    it('returns queued status with check info', async () => {
      mockGraphQLResponse({
        repository: {
          pullRequest: {
            mergeQueueEntry: {
              state: 'QUEUED',
              position: 2,
              headCommit: { oid: 'abc123' },
              enqueuedAt: '2026-03-24T00:00:00Z',
            },
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: {
                      contexts: {
                        nodes: [
                          { name: 'CI', conclusion: 'SUCCESS', status: 'COMPLETED' },
                          { name: 'lint', conclusion: null, status: 'IN_PROGRESS' },
                        ],
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      })

      const result = await adapter.getStatus('owner', 'repo', 1)
      expect(result.state).toBe('queued')
      expect(result.position).toBe(2)
      expect(result.checksStatus).toHaveLength(2)
      expect(result.checksStatus[0]).toEqual({ name: 'CI', status: 'pass' })
      expect(result.checksStatus[1]).toEqual({ name: 'lint', status: 'pending' })
    })

    it('returns not-queued when no merge queue entry', async () => {
      mockGraphQLResponse({
        repository: {
          pullRequest: {
            mergeQueueEntry: null,
            commits: { nodes: [] },
          },
        },
      })

      const result = await adapter.getStatus('owner', 'repo', 1)
      expect(result.state).toBe('not-queued')
    })

    it('maps MERGEABLE state to merging', async () => {
      mockGraphQLResponse({
        repository: {
          pullRequest: {
            mergeQueueEntry: {
              state: 'MERGEABLE',
              position: 1,
              headCommit: { oid: 'abc123' },
              enqueuedAt: '2026-03-24T00:00:00Z',
            },
            commits: { nodes: [] },
          },
        },
      })

      const result = await adapter.getStatus('owner', 'repo', 1)
      expect(result.state).toBe('merging')
    })

    it('maps StatusContext nodes correctly', async () => {
      mockGraphQLResponse({
        repository: {
          pullRequest: {
            mergeQueueEntry: {
              state: 'QUEUED',
              position: 1,
              headCommit: { oid: 'abc123' },
              enqueuedAt: '2026-03-24T00:00:00Z',
            },
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: {
                      contexts: {
                        nodes: [
                          { context: 'deploy', state: 'SUCCESS' },
                          { context: 'build', state: 'PENDING' },
                          { context: 'test', state: 'FAILURE' },
                        ],
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      })

      const result = await adapter.getStatus('owner', 'repo', 1)
      expect(result.checksStatus).toEqual([
        { name: 'deploy', status: 'pass' },
        { name: 'build', status: 'pending' },
        { name: 'test', status: 'fail' },
      ])
    })
  })

  describe('dequeue', () => {
    it('dequeues a PR successfully', async () => {
      // First call: getPRNodeId
      mockExec.mockImplementationOnce((_cmd: string, _opts: unknown, callback?: Function) => {
        const cb = typeof _opts === 'function' ? _opts : callback
        cb?.(null, {
          stdout: JSON.stringify({
            data: { repository: { pullRequest: { id: 'PR_node_123' } } },
          }),
        })
        return {} as ReturnType<typeof exec>
      })
      // Second call: dequeue mutation
      mockExec.mockImplementationOnce((_cmd: string, _opts: unknown, callback?: Function) => {
        const cb = typeof _opts === 'function' ? _opts : callback
        cb?.(null, {
          stdout: JSON.stringify({
            data: { dequeuePullRequest: { mergeQueueEntry: { state: 'QUEUED' } } },
          }),
        })
        return {} as ReturnType<typeof exec>
      })

      await expect(adapter.dequeue('owner', 'repo', 1)).resolves.toBeUndefined()
    })
  })

  describe('isEnabled', () => {
    it('returns true when merge queue is enabled via rulesets', async () => {
      // First call: rulesets REST API check (returns merge_queue rule count)
      mockExec.mockImplementationOnce((_cmd: string, _opts: unknown, callback?: Function) => {
        const cb = typeof _opts === 'function' ? _opts : callback
        cb?.(null, { stdout: '1\n' })
        return {} as ReturnType<typeof exec>
      })

      const result = await adapter.isEnabled('owner', 'repo')
      expect(result).toBe(true)
    })

    it('falls back to legacy branch protection when rulesets API fails', async () => {
      // First call: rulesets check fails
      mockExec.mockImplementationOnce((_cmd: string, _opts: unknown, callback?: Function) => {
        const cb = typeof _opts === 'function' ? _opts : callback
        cb?.(new Error('Not found'), { stdout: '' })
        return {} as ReturnType<typeof exec>
      })
      // Retry 1 for rulesets
      mockExec.mockImplementationOnce((_cmd: string, _opts: unknown, callback?: Function) => {
        const cb = typeof _opts === 'function' ? _opts : callback
        cb?.(new Error('Not found'), { stdout: '' })
        return {} as ReturnType<typeof exec>
      })
      // Retry 2 for rulesets
      mockExec.mockImplementationOnce((_cmd: string, _opts: unknown, callback?: Function) => {
        const cb = typeof _opts === 'function' ? _opts : callback
        cb?.(new Error('Not found'), { stdout: '' })
        return {} as ReturnType<typeof exec>
      })
      // Legacy GraphQL check succeeds
      mockExec.mockImplementation((_cmd: string, _opts: unknown, callback?: Function) => {
        const cb = typeof _opts === 'function' ? _opts : callback
        cb?.(null, {
          stdout: JSON.stringify({
            data: {
              repository: {
                defaultBranchRef: {
                  branchProtectionRule: { requiresMergeQueue: true },
                },
              },
            },
          }),
        })
        return {} as ReturnType<typeof exec>
      })

      const result = await adapter.isEnabled('owner', 'repo')
      expect(result).toBe(true)
    })

    it('returns false when no rulesets and no legacy branch protection', async () => {
      // Rulesets check returns 0
      mockExec.mockImplementationOnce((_cmd: string, _opts: unknown, callback?: Function) => {
        const cb = typeof _opts === 'function' ? _opts : callback
        cb?.(null, { stdout: '0\n' })
        return {} as ReturnType<typeof exec>
      })
      // Legacy check returns no merge queue
      mockExec.mockImplementation((_cmd: string, _opts: unknown, callback?: Function) => {
        const cb = typeof _opts === 'function' ? _opts : callback
        cb?.(null, {
          stdout: JSON.stringify({
            data: {
              repository: {
                defaultBranchRef: {
                  branchProtectionRule: null,
                },
              },
            },
          }),
        })
        return {} as ReturnType<typeof exec>
      })

      const result = await adapter.isEnabled('owner', 'repo')
      expect(result).toBe(false)
    })

    it('returns false on all API errors', async () => {
      mockGraphQLError('Not found')

      const result = await adapter.isEnabled('owner', 'repo')
      expect(result).toBe(false)
    }, 15000)
  })

  describe('graphql retry logic', () => {
    it('retries on transient failure then succeeds', async () => {
      // Test retry logic via canEnqueue (simpler path — no rulesets fallback)
      let callCount = 0
      mockExec.mockImplementation((_cmd: string, _opts: unknown, callback?: Function) => {
        const cb = typeof _opts === 'function' ? _opts : callback
        callCount++
        if (callCount === 1) {
          cb?.(new Error('ETIMEDOUT'), { stdout: '' })
        } else {
          cb?.(null, {
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    mergeable: 'MERGEABLE',
                    reviewDecision: 'APPROVED',
                    mergeQueueEntry: null,
                  },
                },
              },
            }),
          })
        }
        return {} as ReturnType<typeof exec>
      })

      const result = await adapter.canEnqueue('owner', 'repo', 1)
      expect(result).toBe(true)
      expect(callCount).toBe(2)
    })

    it('throws after exhausting retries', async () => {
      mockGraphQLError('Server error')

      // canEnqueue catches and returns false, but we can test via isEnabled which also catches
      // Let's test directly by triggering a method that propagates errors
      // getStatus does NOT catch errors — it will throw
      await expect(adapter.getStatus('owner', 'repo', 1)).rejects.toThrow('Server error')
      // 1 initial + 2 retries = 3 calls
      expect(mockExec).toHaveBeenCalledTimes(3)
    })

    it('handles GraphQL error responses', async () => {
      mockGraphQLErrorResponse([{ message: 'Resource not found' }])

      await expect(adapter.getStatus('owner', 'repo', 1)).rejects.toThrow('Resource not found')
    })
  })
})
