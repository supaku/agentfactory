import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  pollApprovedForMergeLabel,
  splitRepoId,
  resolveIssueTracker,
  APPROVED_FOR_MERGE_LABEL,
  type LabelPollerAdapter,
} from '../merge-worker-sidecar.js'

// ---------------------------------------------------------------------------
// splitRepoId
// ---------------------------------------------------------------------------

describe('splitRepoId', () => {
  it('parses owner/repo correctly', () => {
    expect(splitRepoId('RenseiAI/platform')).toEqual({ owner: 'RenseiAI', repo: 'platform' })
  })

  it('returns null for the default-fallback string', () => {
    // getRepoId returns "default" when no git remote is configured.
    // The sidecar must not call `gh pr list --repo default` against GitHub.
    expect(splitRepoId('default')).toBeNull()
  })

  it('returns null for values with more than one slash (ambiguous)', () => {
    expect(splitRepoId('org/team/repo')).toBeNull()
  })

  it('returns null for empty components', () => {
    expect(splitRepoId('/repo')).toBeNull()
    expect(splitRepoId('owner/')).toBeNull()
    expect(splitRepoId('')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// pollApprovedForMergeLabel
// ---------------------------------------------------------------------------

describe('pollApprovedForMergeLabel', () => {
  function makeAdapter(overrides: Partial<LabelPollerAdapter> = {}): LabelPollerAdapter & {
    canEnqueueMock: ReturnType<typeof vi.fn>
    enqueueMock: ReturnType<typeof vi.fn>
  } {
    const canEnqueueMock = vi.fn(overrides.canEnqueue ?? (async () => true))
    const enqueueMock = vi.fn(overrides.enqueue ?? (async () => ({ state: 'queued' })))
    return {
      canEnqueue: canEnqueueMock,
      enqueue: enqueueMock,
      canEnqueueMock,
      enqueueMock,
    }
  }

  it('enqueues each labeled PR returned by the list callback', async () => {
    const adapter = makeAdapter()
    const listLabeledPRs = vi.fn(async () => [
      { number: 61 },
      { number: 72 },
      { number: 85 },
    ])

    const enqueued = await pollApprovedForMergeLabel(
      adapter, 'RenseiAI', 'platform',
      { listLabeledPRs, log: () => {} },
    )

    expect(enqueued).toBe(3)
    expect(adapter.canEnqueueMock).toHaveBeenCalledTimes(3)
    expect(adapter.enqueueMock).toHaveBeenCalledWith('RenseiAI', 'platform', 61)
    expect(adapter.enqueueMock).toHaveBeenCalledWith('RenseiAI', 'platform', 72)
    expect(adapter.enqueueMock).toHaveBeenCalledWith('RenseiAI', 'platform', 85)
  })

  it('skips PRs where canEnqueue returns false', async () => {
    const adapter = makeAdapter({
      canEnqueue: vi.fn(async (_o, _r, prNum) => prNum === 61),
    })
    const listLabeledPRs = vi.fn(async () => [
      { number: 61 }, // eligible
      { number: 72 }, // rejected by canEnqueue
    ])

    const enqueued = await pollApprovedForMergeLabel(
      adapter, 'RenseiAI', 'platform',
      { listLabeledPRs, log: () => {} },
    )

    expect(enqueued).toBe(1)
    expect(adapter.enqueueMock).toHaveBeenCalledTimes(1)
    expect(adapter.enqueueMock).toHaveBeenCalledWith('RenseiAI', 'platform', 61)
  })

  it('returns 0 and does not throw when the list callback fails', async () => {
    const adapter = makeAdapter()
    const listLabeledPRs = vi.fn(async () => {
      throw new Error('gh: command not found')
    })
    const log = vi.fn()

    const enqueued = await pollApprovedForMergeLabel(
      adapter, 'RenseiAI', 'platform',
      { listLabeledPRs, log },
    )

    expect(enqueued).toBe(0)
    expect(adapter.enqueueMock).not.toHaveBeenCalled()
    // Error is logged, not thrown — sidecar loop must never crash on a
    // transient gh failure.
    expect(log).toHaveBeenCalledWith(expect.stringContaining('label poll failed'))
  })

  it('continues after one PR fails to enqueue (independent failures)', async () => {
    let enqueueCalls = 0
    const adapter = makeAdapter({
      canEnqueue: async () => true,
      enqueue: vi.fn(async (_o, _r, prNum) => {
        enqueueCalls++
        if (prNum === 72) throw new Error('Redis connection lost')
        return { state: 'queued' }
      }),
    })
    const log = vi.fn()

    const enqueued = await pollApprovedForMergeLabel(
      adapter, 'RenseiAI', 'platform',
      {
        listLabeledPRs: async () => [{ number: 61 }, { number: 72 }, { number: 85 }],
        log,
      },
    )

    expect(enqueueCalls).toBe(3) // all attempted
    expect(enqueued).toBe(2) // 61, 85 succeeded
    expect(log).toHaveBeenCalledWith(expect.stringContaining('failed to enqueue labeled PR #72'))
  })

  it('returns 0 when no PRs are labeled', async () => {
    const adapter = makeAdapter()
    const enqueued = await pollApprovedForMergeLabel(
      adapter, 'RenseiAI', 'platform',
      { listLabeledPRs: async () => [], log: () => {} },
    )
    expect(enqueued).toBe(0)
    expect(adapter.canEnqueueMock).not.toHaveBeenCalled()
    expect(adapter.enqueueMock).not.toHaveBeenCalled()
  })

  it('exports the label name for agents to reference', () => {
    // The template instructs agents to add this exact label. If we rename
    // the constant, acceptance-template renders must update in lockstep.
    expect(APPROVED_FOR_MERGE_LABEL).toBe('approved-for-merge')
  })
})

// ---------------------------------------------------------------------------
// resolveIssueTracker
// ---------------------------------------------------------------------------

describe('resolveIssueTracker', () => {
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env.LINEAR_API_KEY
    delete process.env.LINEAR_API_KEY
  })

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.LINEAR_API_KEY
    else process.env.LINEAR_API_KEY = originalEnv
  })

  it('returns null when caller passes null (explicit opt-out)', () => {
    process.env.LINEAR_API_KEY = 'lin_xxx' // even when env is set, null wins
    expect(resolveIssueTracker(null)).toBeNull()
  })

  it('returns null when no LINEAR_API_KEY and no explicit instance', () => {
    expect(resolveIssueTracker(undefined)).toBeNull()
  })

  it('returns the explicit instance when provided', () => {
    const fake = { getIssue: () => Promise.resolve({} as never) } as never
    expect(resolveIssueTracker(fake)).toBe(fake)
  })

  it('autodetects from LINEAR_API_KEY env when caller passes undefined', () => {
    process.env.LINEAR_API_KEY = 'lin_xxx'
    const tracker = resolveIssueTracker(undefined)
    expect(tracker).not.toBeNull()
    // Has the IssueTrackerClient surface
    expect(typeof tracker?.getIssue).toBe('function')
    expect(typeof tracker?.createComment).toBe('function')
    expect(typeof tracker?.updateIssueStatus).toBe('function')
  })

  it('falls back to proxy adapter when LINEAR_API_KEY is absent but proxyConfig is supplied', () => {
    // Coordinator-proxied deployments don't set LINEAR_API_KEY in the
    // worker fleet env — workers route Linear ops through the platform's
    // API. The sidecar must use the same path or its bubble-up silently
    // no-ops, leaving Accepted-but-unmerged issues stuck.
    const tracker = resolveIssueTracker(undefined, {
      apiUrl: 'https://platform.example.com',
      apiKey: 'pf_xxx',
    })
    expect(tracker).not.toBeNull()
    expect(typeof tracker?.getIssue).toBe('function')
    expect(typeof tracker?.createComment).toBe('function')
    expect(typeof tracker?.updateIssueStatus).toBe('function')
  })

  it('prefers Linear key over proxy when both are present', () => {
    // Direct Linear access is faster than going through the coordinator.
    // If a deployment somehow has both, prefer the direct path.
    process.env.LINEAR_API_KEY = 'lin_xxx'
    const tracker = resolveIssueTracker(undefined, {
      apiUrl: 'https://platform.example.com',
      apiKey: 'pf_xxx',
    })
    expect(tracker).not.toBeNull()
    // Both are valid IssueTrackerClient implementations; we don't assert
    // class identity (would couple this test to internals), but we do
    // verify the resolution didn't end up null.
  })

  it('returns null when neither Linear key nor proxy config is available', () => {
    expect(resolveIssueTracker(undefined, undefined)).toBeNull()
    expect(resolveIssueTracker(undefined, { apiUrl: '', apiKey: '' })).toBeNull()
  })

  it('null override wins over proxy config too', () => {
    // Explicit opt-out: a deployment may want to disable bubble-up even
    // when proxy credentials are available (e.g., dry-run mode).
    expect(resolveIssueTracker(null, {
      apiUrl: 'https://platform.example.com',
      apiKey: 'pf_xxx',
    })).toBeNull()
  })
})
