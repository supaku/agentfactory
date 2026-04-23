/**
 * Tests for the merge worker's "bubble result back to the issue" behavior:
 *   - merged → comment + Accepted
 *   - conflict / test-failure / error → comment + Rejected
 *
 * Plus the supporting helpers (extractIssueIdentifier, formatMergeResultComment).
 */
import { describe, it, expect, vi } from 'vitest'
import { MergeWorker, formatMergeResultComment, type MergeWorkerConfig, type MergeWorkerDeps } from './merge-worker.js'
import { extractIssueIdentifier } from './adapters/local.js'
import type { IssueTrackerClient } from '../orchestrator/issue-tracker-client.js'

// ---------------------------------------------------------------------------
// extractIssueIdentifier
// ---------------------------------------------------------------------------

describe('extractIssueIdentifier', () => {
  it('extracts a bare identifier from a branch name', () => {
    expect(extractIssueIdentifier('REN-1153')).toBe('REN-1153')
    expect(extractIssueIdentifier('SUP-42')).toBe('SUP-42')
  })

  it('extracts an identifier prefix from a PR title', () => {
    expect(extractIssueIdentifier('REN-1153: Cedar-Gated A2A Authorization')).toBe('REN-1153')
    expect(extractIssueIdentifier('SUP-42 — fix the bug')).toBe('SUP-42')
  })

  it('extracts an identifier from inside a feature-branch path', () => {
    expect(extractIssueIdentifier('feature/REN-1153-cedar-stuff')).toBe('REN-1153')
    expect(extractIssueIdentifier('mark/ren-1153-cedar-policy')).toBe('REN-1153')
  })

  it('normalizes lowercase to uppercase', () => {
    expect(extractIssueIdentifier('ren-1153')).toBe('REN-1153')
  })

  it('returns null when no identifier is present', () => {
    expect(extractIssueIdentifier('main')).toBeNull()
    expect(extractIssueIdentifier('')).toBeNull()
    expect(extractIssueIdentifier('refactor: cleanup')).toBeNull()
  })

  it('does NOT match numeric-prefix branches like v1.2.3-rc4', () => {
    expect(extractIssueIdentifier('v1.2.3-rc4')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// formatMergeResultComment
// ---------------------------------------------------------------------------

describe('formatMergeResultComment', () => {
  const PR = 'https://github.com/RenseiAI/platform/pull/61'

  it('formats merged with the PR url', () => {
    const body = formatMergeResultComment('merged', PR, 'commit abc123')
    expect(body).toContain('Merged by the merge queue')
    expect(body).toContain(PR)
    expect(body).toContain('commit abc123')
  })

  it('formats conflict with refinement signal', () => {
    const body = formatMergeResultComment('conflict', PR, 'src/auth.ts')
    expect(body).toContain('Merge conflict')
    expect(body).toContain('refinement')
    expect(body).toContain(PR)
    expect(body).toContain('src/auth.ts')
  })

  it('formats test-failure with refinement signal', () => {
    const body = formatMergeResultComment('test-failure', PR, 'TypeError: Cannot read x')
    expect(body).toContain('Tests failed during merge')
    expect(body).toContain('refinement')
    expect(body).toContain('TypeError')
  })

  it('formats error with refinement signal', () => {
    const body = formatMergeResultComment('error', PR, 'Network timeout')
    expect(body).toContain('Merge queue error')
    expect(body).toContain('refinement')
    expect(body).toContain('Network timeout')
  })

  it('truncates very long detail with marker', () => {
    const longDetail = 'x'.repeat(10_000)
    const body = formatMergeResultComment('test-failure', PR, longDetail)
    expect(body.length).toBeLessThan(5_000)
    expect(body).toContain('truncated')
  })
})

// ---------------------------------------------------------------------------
// MergeWorker bubble-up integration
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<MergeWorkerConfig> = {}): MergeWorkerConfig {
  return {
    repoId: 'RenseiAI/platform',
    repoPath: '/tmp/repo',
    strategy: 'rebase',
    testCommand: 'pnpm test',
    testTimeout: 60_000,
    lockFileRegenerate: false,
    mergiraf: false,
    pollInterval: 1000,
    maxRetries: 0,
    escalation: { onConflict: 'notify', onTestFailure: 'notify' },
    deleteBranchOnMerge: false,
    packageManager: 'pnpm',
    remote: 'origin',
    targetBranch: 'main',
    ...overrides,
  }
}

function makeTracker(): IssueTrackerClient & {
  getIssueMock: ReturnType<typeof vi.fn>
  createCommentMock: ReturnType<typeof vi.fn>
  updateIssueStatusMock: ReturnType<typeof vi.fn>
} {
  const getIssueMock = vi.fn(async (id: string) => ({ id: `uuid-${id}`, identifier: id }) as never)
  const createCommentMock = vi.fn(async () => ({ id: 'comment-1' }))
  const updateIssueStatusMock = vi.fn(async () => undefined)
  return {
    getIssue: getIssueMock,
    isParentIssue: vi.fn(),
    isChildIssue: vi.fn(),
    createComment: createCommentMock,
    updateIssueStatus: updateIssueStatusMock,
    unassignIssue: vi.fn(),
    queryIssues: vi.fn(),
    getProjectRepository: vi.fn(),
    getIssueMock,
    createCommentMock,
    updateIssueStatusMock,
  } as never
}

/**
 * Helper to invoke the private bubbleResultToIssue method from outside the
 * class. We test this independently because the full start() loop requires
 * Redis, git, and a real merge strategy — all out of scope for these tests.
 */
type BubbleFn = (
  entry: { issueIdentifier?: string; prUrl?: string; prNumber: number },
  result: { prNumber: number; status: 'merged' | 'conflict' | 'test-failure' | 'error'; message?: string },
  kind: 'merged' | 'conflict' | 'test-failure' | 'error',
) => Promise<void>

function callBubble(
  worker: MergeWorker,
  entry: { issueIdentifier?: string; prUrl?: string; prNumber: number },
  result: { prNumber: number; status: 'merged' | 'conflict' | 'test-failure' | 'error'; message?: string },
  kind: 'merged' | 'conflict' | 'test-failure' | 'error',
): Promise<void> {
  const fn = (worker as unknown as { bubbleResultToIssue: BubbleFn }).bubbleResultToIssue.bind(worker)
  return fn(entry, result, kind)
}

describe('MergeWorker.bubbleResultToIssue', () => {
  const baseDeps: MergeWorkerDeps = {
    storage: {
      dequeue: vi.fn(),
      markCompleted: vi.fn(),
      markFailed: vi.fn(),
      markBlocked: vi.fn(),
      peekAll: vi.fn(),
      dequeueBatch: vi.fn(),
    },
    redis: {
      setNX: vi.fn(async () => true),
      del: vi.fn(),
      get: vi.fn(),
      set: vi.fn(),
      expire: vi.fn(),
    },
  }

  it('posts comment and transitions to Accepted on merged', async () => {
    const tracker = makeTracker()
    const worker = new MergeWorker(makeConfig(), { ...baseDeps, issueTracker: tracker })
    await callBubble(
      worker,
      { issueIdentifier: 'REN-1153', prUrl: 'https://github.com/RenseiAI/platform/pull/61', prNumber: 61 },
      { prNumber: 61, status: 'merged', message: 'commit abc123' },
      'merged',
    )
    expect(tracker.getIssueMock).toHaveBeenCalledWith('REN-1153')
    expect(tracker.createCommentMock).toHaveBeenCalledOnce()
    const [, body] = tracker.createCommentMock.mock.calls[0]
    expect(body).toContain('Merged by the merge queue')
    expect(tracker.updateIssueStatusMock).toHaveBeenCalledWith('uuid-REN-1153', 'Accepted')
  })

  it.each([
    ['conflict', 'Merge conflict'],
    ['test-failure', 'Tests failed during merge'],
    ['error', 'Merge queue error'],
  ] as const)('posts comment and transitions to Rejected on %s', async (kind, expectedTitle) => {
    const tracker = makeTracker()
    const worker = new MergeWorker(makeConfig(), { ...baseDeps, issueTracker: tracker })
    await callBubble(
      worker,
      { issueIdentifier: 'REN-1153', prUrl: 'https://github.com/RenseiAI/platform/pull/61', prNumber: 61 },
      { prNumber: 61, status: kind, message: 'detail' },
      kind,
    )
    expect(tracker.createCommentMock).toHaveBeenCalledOnce()
    const [, body] = tracker.createCommentMock.mock.calls[0]
    expect(body).toContain(expectedTitle)
    expect(tracker.updateIssueStatusMock).toHaveBeenCalledWith('uuid-REN-1153', 'Rejected')
  })

  it('uses configured acceptedStatus / rejectedStatus when overridden', async () => {
    const tracker = makeTracker()
    const worker = new MergeWorker(
      makeConfig({ acceptedStatus: 'Released', rejectedStatus: 'Needs Work' }),
      { ...baseDeps, issueTracker: tracker },
    )
    await callBubble(
      worker, { issueIdentifier: 'REN-1153', prNumber: 61 },
      { prNumber: 61, status: 'merged' }, 'merged',
    )
    expect(tracker.updateIssueStatusMock).toHaveBeenCalledWith('uuid-REN-1153', 'Released')

    await callBubble(
      worker, { issueIdentifier: 'REN-1153', prNumber: 61 },
      { prNumber: 61, status: 'conflict' }, 'conflict',
    )
    expect(tracker.updateIssueStatusMock).toHaveBeenCalledWith('uuid-REN-1153', 'Needs Work')
  })

  it('is a no-op when no issue tracker is configured', async () => {
    const worker = new MergeWorker(makeConfig(), baseDeps) // no tracker
    await expect(callBubble(
      worker, { issueIdentifier: 'REN-1153', prNumber: 61 },
      { prNumber: 61, status: 'merged' }, 'merged',
    )).resolves.toBeUndefined()
  })

  it('is a no-op when issueIdentifier is the PR-N placeholder', async () => {
    const tracker = makeTracker()
    const worker = new MergeWorker(makeConfig(), { ...baseDeps, issueTracker: tracker })
    await callBubble(
      worker, { issueIdentifier: 'PR-61', prNumber: 61 }, // placeholder
      { prNumber: 61, status: 'merged' }, 'merged',
    )
    expect(tracker.getIssueMock).not.toHaveBeenCalled()
    expect(tracker.createCommentMock).not.toHaveBeenCalled()
    expect(tracker.updateIssueStatusMock).not.toHaveBeenCalled()
  })

  it('is a no-op when issueIdentifier is missing', async () => {
    const tracker = makeTracker()
    const worker = new MergeWorker(makeConfig(), { ...baseDeps, issueTracker: tracker })
    await callBubble(
      worker, { prNumber: 61 } as never,
      { prNumber: 61, status: 'merged' }, 'merged',
    )
    expect(tracker.getIssueMock).not.toHaveBeenCalled()
  })

  it('handles getIssue failure without throwing', async () => {
    const tracker = makeTracker()
    tracker.getIssueMock.mockRejectedValueOnce(new Error('Issue archived'))
    const worker = new MergeWorker(makeConfig(), { ...baseDeps, issueTracker: tracker })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(callBubble(
      worker, { issueIdentifier: 'REN-1153', prNumber: 61 },
      { prNumber: 61, status: 'merged' }, 'merged',
    )).resolves.toBeUndefined()

    expect(tracker.createCommentMock).not.toHaveBeenCalled()
    expect(tracker.updateIssueStatusMock).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('still transitions status when comment posting fails', async () => {
    const tracker = makeTracker()
    tracker.createCommentMock.mockRejectedValueOnce(new Error('Linear 500'))
    const worker = new MergeWorker(makeConfig(), { ...baseDeps, issueTracker: tracker })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await callBubble(
      worker, { issueIdentifier: 'REN-1153', prNumber: 61 },
      { prNumber: 61, status: 'merged' }, 'merged',
    )

    // Comment failed, but status transition still happened — status is the
    // source of truth.
    expect(tracker.updateIssueStatusMock).toHaveBeenCalledWith('uuid-REN-1153', 'Accepted')
    errSpy.mockRestore()
  })

  it('does not throw when status transition fails', async () => {
    const tracker = makeTracker()
    tracker.updateIssueStatusMock.mockRejectedValueOnce(new Error('Linear unavailable'))
    const worker = new MergeWorker(makeConfig(), { ...baseDeps, issueTracker: tracker })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(callBubble(
      worker, { issueIdentifier: 'REN-1153', prNumber: 61 },
      { prNumber: 61, status: 'merged' }, 'merged',
    )).resolves.toBeUndefined()

    errSpy.mockRestore()
  })
})
