import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WorkflowGovernor, type GovernorDependencies } from './governor.js'
import type { GovernorConfig, GovernorIssue } from './governor-types.js'
import { DEFAULT_GOVERNOR_CONFIG } from './governor-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(overrides: Partial<GovernorIssue> = {}): GovernorIssue {
  return {
    id: 'issue-1',
    identifier: 'SUP-100',
    title: 'Test Issue',
    description: undefined,
    status: 'Backlog',
    labels: [],
    createdAt: Date.now() - 2 * 60 * 60 * 1000,
    ...overrides,
  }
}

/**
 * Create mock GovernorDependencies with sensible defaults.
 * All callbacks return "no blockers" so issues are actionable by default.
 */
function makeMockDeps(overrides: Partial<GovernorDependencies> = {}): GovernorDependencies {
  return {
    listIssues: vi.fn().mockResolvedValue([]),
    hasActiveSession: vi.fn().mockResolvedValue(false),
    isWithinCooldown: vi.fn().mockResolvedValue(false),
    isParentIssue: vi.fn().mockResolvedValue(false),
    isHeld: vi.fn().mockResolvedValue(false),
    getWorkflowStrategy: vi.fn().mockResolvedValue(undefined),
    isResearchCompleted: vi.fn().mockResolvedValue(false),
    isBacklogCreationCompleted: vi.fn().mockResolvedValue(false),
    dispatchWork: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function makeConfig(overrides: Partial<GovernorConfig> = {}): Partial<GovernorConfig> {
  return {
    projects: ['TestProject'],
    scanIntervalMs: 60_000,
    maxConcurrentDispatches: 3,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// scanOnce — basic behavior
// ---------------------------------------------------------------------------

describe('WorkflowGovernor.scanOnce', () => {
  it('scans all configured projects', async () => {
    const deps = makeMockDeps()
    const governor = new WorkflowGovernor(
      makeConfig({ projects: ['Project-A', 'Project-B'] }),
      deps,
    )

    const results = await governor.scanOnce()

    expect(results).toHaveLength(2)
    expect(results[0]!.project).toBe('Project-A')
    expect(results[1]!.project).toBe('Project-B')
    expect(deps.listIssues).toHaveBeenCalledWith('Project-A')
    expect(deps.listIssues).toHaveBeenCalledWith('Project-B')
  })

  it('returns empty results for project with no issues', async () => {
    const deps = makeMockDeps({
      listIssues: vi.fn().mockResolvedValue([]),
    })
    const governor = new WorkflowGovernor(makeConfig(), deps)

    const results = await governor.scanOnce()

    expect(results).toHaveLength(1)
    expect(results[0]!.scannedIssues).toBe(0)
    expect(results[0]!.actionsDispatched).toBe(0)
  })

  it('dispatches development for Backlog issues', async () => {
    const issue = makeIssue({ status: 'Backlog' })
    const deps = makeMockDeps({
      listIssues: vi.fn().mockResolvedValue([issue]),
    })
    const governor = new WorkflowGovernor(makeConfig(), deps)

    const results = await governor.scanOnce()

    expect(results[0]!.actionsDispatched).toBe(1)
    expect(deps.dispatchWork).toHaveBeenCalledWith('issue-1', 'trigger-development')
  })

  it('dispatches QA for Finished issues', async () => {
    const issue = makeIssue({ status: 'Finished' })
    const deps = makeMockDeps({
      listIssues: vi.fn().mockResolvedValue([issue]),
    })
    const governor = new WorkflowGovernor(makeConfig(), deps)

    const results = await governor.scanOnce()

    expect(results[0]!.actionsDispatched).toBe(1)
    expect(deps.dispatchWork).toHaveBeenCalledWith('issue-1', 'trigger-qa')
  })

  it('dispatches acceptance for Delivered issues', async () => {
    const issue = makeIssue({ status: 'Delivered' })
    const deps = makeMockDeps({
      listIssues: vi.fn().mockResolvedValue([issue]),
    })
    const governor = new WorkflowGovernor(makeConfig(), deps)

    const results = await governor.scanOnce()

    expect(results[0]!.actionsDispatched).toBe(1)
    expect(deps.dispatchWork).toHaveBeenCalledWith('issue-1', 'trigger-acceptance')
  })

  it('dispatches refinement for Rejected issues', async () => {
    const issue = makeIssue({ status: 'Rejected' })
    const deps = makeMockDeps({
      listIssues: vi.fn().mockResolvedValue([issue]),
    })
    const governor = new WorkflowGovernor(makeConfig(), deps)

    const results = await governor.scanOnce()

    expect(results[0]!.actionsDispatched).toBe(1)
    expect(deps.dispatchWork).toHaveBeenCalledWith('issue-1', 'trigger-refinement')
  })

  it('skips issues with active sessions', async () => {
    const issue = makeIssue({ status: 'Backlog' })
    const deps = makeMockDeps({
      listIssues: vi.fn().mockResolvedValue([issue]),
      hasActiveSession: vi.fn().mockResolvedValue(true),
    })
    const governor = new WorkflowGovernor(makeConfig(), deps)

    const results = await governor.scanOnce()

    expect(results[0]!.actionsDispatched).toBe(0)
    expect(results[0]!.skippedReasons.size).toBe(1)
    expect(deps.dispatchWork).not.toHaveBeenCalled()
  })

  it('skips held issues', async () => {
    const issue = makeIssue({ status: 'Backlog' })
    const deps = makeMockDeps({
      listIssues: vi.fn().mockResolvedValue([issue]),
      isHeld: vi.fn().mockResolvedValue(true),
    })
    const governor = new WorkflowGovernor(makeConfig(), deps)

    const results = await governor.scanOnce()

    expect(results[0]!.actionsDispatched).toBe(0)
    expect(deps.dispatchWork).not.toHaveBeenCalled()
  })

  it('skips issues within cooldown', async () => {
    const issue = makeIssue({ status: 'Backlog' })
    const deps = makeMockDeps({
      listIssues: vi.fn().mockResolvedValue([issue]),
      isWithinCooldown: vi.fn().mockResolvedValue(true),
    })
    const governor = new WorkflowGovernor(makeConfig(), deps)

    const results = await governor.scanOnce()

    expect(results[0]!.actionsDispatched).toBe(0)
    expect(deps.dispatchWork).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// maxConcurrentDispatches limiting
// ---------------------------------------------------------------------------

describe('WorkflowGovernor.scanOnce — dispatch limit', () => {
  it('respects maxConcurrentDispatches limit', async () => {
    const issues = [
      makeIssue({ id: 'issue-1', identifier: 'SUP-1', status: 'Backlog' }),
      makeIssue({ id: 'issue-2', identifier: 'SUP-2', status: 'Backlog' }),
      makeIssue({ id: 'issue-3', identifier: 'SUP-3', status: 'Backlog' }),
      makeIssue({ id: 'issue-4', identifier: 'SUP-4', status: 'Backlog' }),
      makeIssue({ id: 'issue-5', identifier: 'SUP-5', status: 'Backlog' }),
    ]

    const deps = makeMockDeps({
      listIssues: vi.fn().mockResolvedValue(issues),
    })

    const governor = new WorkflowGovernor(
      makeConfig({ maxConcurrentDispatches: 2 }),
      deps,
    )

    const results = await governor.scanOnce()

    expect(results[0]!.actionsDispatched).toBe(2)
    expect(deps.dispatchWork).toHaveBeenCalledTimes(2)
  })

  it('dispatches all when under the limit', async () => {
    const issues = [
      makeIssue({ id: 'issue-1', identifier: 'SUP-1', status: 'Backlog' }),
      makeIssue({ id: 'issue-2', identifier: 'SUP-2', status: 'Finished' }),
    ]

    const deps = makeMockDeps({
      listIssues: vi.fn().mockResolvedValue(issues),
    })

    const governor = new WorkflowGovernor(
      makeConfig({ maxConcurrentDispatches: 5 }),
      deps,
    )

    const results = await governor.scanOnce()

    expect(results[0]!.actionsDispatched).toBe(2)
    expect(deps.dispatchWork).toHaveBeenCalledTimes(2)
  })

  it('counts skipped issues toward scanned but not dispatched', async () => {
    const issues = [
      makeIssue({ id: 'issue-1', identifier: 'SUP-1', status: 'Accepted' }), // terminal
      makeIssue({ id: 'issue-2', identifier: 'SUP-2', status: 'Backlog' }),   // actionable
    ]

    const deps = makeMockDeps({
      listIssues: vi.fn().mockResolvedValue(issues),
    })

    const governor = new WorkflowGovernor(makeConfig(), deps)

    const results = await governor.scanOnce()

    expect(results[0]!.scannedIssues).toBe(2)
    expect(results[0]!.actionsDispatched).toBe(1)
    expect(results[0]!.skippedReasons.size).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('WorkflowGovernor.scanOnce — error handling', () => {
  it('records error when listIssues fails', async () => {
    const deps = makeMockDeps({
      listIssues: vi.fn().mockRejectedValue(new Error('API timeout')),
    })
    const governor = new WorkflowGovernor(makeConfig(), deps)

    const results = await governor.scanOnce()

    expect(results[0]!.errors).toHaveLength(1)
    expect(results[0]!.errors[0]!.error).toContain('API timeout')
  })

  it('single issue failure does not stop scan of remaining issues', async () => {
    const issues = [
      makeIssue({ id: 'issue-1', identifier: 'SUP-1', status: 'Backlog' }),
      makeIssue({ id: 'issue-2', identifier: 'SUP-2', status: 'Backlog' }),
      makeIssue({ id: 'issue-3', identifier: 'SUP-3', status: 'Backlog' }),
    ]

    const dispatchWork = vi.fn()
      .mockResolvedValueOnce(undefined) // issue-1 succeeds
      .mockRejectedValueOnce(new Error('Dispatch failed')) // issue-2 fails
      .mockResolvedValueOnce(undefined) // issue-3 succeeds

    const deps = makeMockDeps({
      listIssues: vi.fn().mockResolvedValue(issues),
      dispatchWork,
    })

    const governor = new WorkflowGovernor(makeConfig(), deps)

    const results = await governor.scanOnce()

    // issue-1 and issue-3 dispatched, issue-2 errored
    expect(results[0]!.actionsDispatched).toBe(2)
    expect(results[0]!.errors).toHaveLength(1)
    expect(results[0]!.errors[0]!.issueId).toBe('SUP-2')
    expect(dispatchWork).toHaveBeenCalledTimes(3)
  })

  it('context gathering failure is caught and recorded', async () => {
    const issue = makeIssue({ status: 'Backlog' })
    const deps = makeMockDeps({
      listIssues: vi.fn().mockResolvedValue([issue]),
      hasActiveSession: vi.fn().mockRejectedValue(new Error('Redis down')),
    })

    const governor = new WorkflowGovernor(makeConfig(), deps)

    const results = await governor.scanOnce()

    expect(results[0]!.errors).toHaveLength(1)
    expect(results[0]!.errors[0]!.error).toContain('Redis down')
    expect(results[0]!.actionsDispatched).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Gathers context in parallel
// ---------------------------------------------------------------------------

describe('WorkflowGovernor.scanOnce — context gathering', () => {
  it('calls all dependency checks for each issue', async () => {
    const issue = makeIssue({ id: 'issue-1', status: 'Backlog' })
    const deps = makeMockDeps({
      listIssues: vi.fn().mockResolvedValue([issue]),
    })

    const governor = new WorkflowGovernor(makeConfig(), deps)
    await governor.scanOnce()

    expect(deps.hasActiveSession).toHaveBeenCalledWith('issue-1')
    expect(deps.isWithinCooldown).toHaveBeenCalledWith('issue-1')
    expect(deps.isParentIssue).toHaveBeenCalledWith('issue-1')
    expect(deps.isHeld).toHaveBeenCalledWith('issue-1')
    expect(deps.getWorkflowStrategy).toHaveBeenCalledWith('issue-1')
    expect(deps.isResearchCompleted).toHaveBeenCalledWith('issue-1')
    expect(deps.isBacklogCreationCompleted).toHaveBeenCalledWith('issue-1')
  })
})

// ---------------------------------------------------------------------------
// start / stop lifecycle
// ---------------------------------------------------------------------------

describe('WorkflowGovernor — start/stop lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('isRunning returns false before start', () => {
    const deps = makeMockDeps()
    const governor = new WorkflowGovernor(makeConfig(), deps)
    expect(governor.isRunning()).toBe(false)
  })

  it('isRunning returns true after start', () => {
    const deps = makeMockDeps()
    const governor = new WorkflowGovernor(makeConfig(), deps)
    governor.start()
    expect(governor.isRunning()).toBe(true)
    governor.stop()
  })

  it('isRunning returns false after stop', () => {
    const deps = makeMockDeps()
    const governor = new WorkflowGovernor(makeConfig(), deps)
    governor.start()
    governor.stop()
    expect(governor.isRunning()).toBe(false)
  })

  it('start triggers an immediate scan', async () => {
    const deps = makeMockDeps()
    const governor = new WorkflowGovernor(makeConfig(), deps)
    governor.start()

    // Flush the fire-and-forget scanOnce by allowing the promise microtask to resolve
    await vi.advanceTimersByTimeAsync(1)

    expect(deps.listIssues).toHaveBeenCalledTimes(1)
    governor.stop()
  })

  it('subsequent scans run on the configured interval', async () => {
    const deps = makeMockDeps()
    const governor = new WorkflowGovernor(
      makeConfig({ scanIntervalMs: 5000 }),
      deps,
    )
    governor.start()

    // First immediate scan
    await vi.advanceTimersByTimeAsync(1)
    expect(deps.listIssues).toHaveBeenCalledTimes(1)

    // Advance by one interval
    await vi.advanceTimersByTimeAsync(5000)
    expect(deps.listIssues).toHaveBeenCalledTimes(2)

    // Advance by another interval
    await vi.advanceTimersByTimeAsync(5000)
    expect(deps.listIssues).toHaveBeenCalledTimes(3)

    governor.stop()
  })

  it('stop prevents further scans', async () => {
    const deps = makeMockDeps()
    const governor = new WorkflowGovernor(
      makeConfig({ scanIntervalMs: 5000 }),
      deps,
    )
    governor.start()

    await vi.advanceTimersByTimeAsync(1)
    expect(deps.listIssues).toHaveBeenCalledTimes(1)

    governor.stop()

    await vi.advanceTimersByTimeAsync(10000)
    // No additional calls after stop
    expect(deps.listIssues).toHaveBeenCalledTimes(1)
  })

  it('calling start twice does not create duplicate intervals', async () => {
    const deps = makeMockDeps()
    const governor = new WorkflowGovernor(
      makeConfig({ scanIntervalMs: 5000 }),
      deps,
    )

    governor.start()
    governor.start() // second call should be a no-op

    await vi.advanceTimersByTimeAsync(1)
    expect(deps.listIssues).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5000)
    // Only 1 interval fires, not 2
    expect(deps.listIssues).toHaveBeenCalledTimes(2)

    governor.stop()
  })

  it('calling stop when not running is safe', () => {
    const deps = makeMockDeps()
    const governor = new WorkflowGovernor(makeConfig(), deps)
    // Should not throw
    expect(() => governor.stop()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Multiple projects
// ---------------------------------------------------------------------------

describe('WorkflowGovernor.scanOnce — multiple projects', () => {
  it('scans each project independently', async () => {
    const projectAIssues = [
      makeIssue({ id: 'a-1', identifier: 'A-1', status: 'Backlog', project: 'Project-A' }),
    ]
    const projectBIssues = [
      makeIssue({ id: 'b-1', identifier: 'B-1', status: 'Finished', project: 'Project-B' }),
      makeIssue({ id: 'b-2', identifier: 'B-2', status: 'Delivered', project: 'Project-B' }),
    ]

    const listIssues = vi.fn()
      .mockImplementation((project: string) => {
        if (project === 'Project-A') return Promise.resolve(projectAIssues)
        if (project === 'Project-B') return Promise.resolve(projectBIssues)
        return Promise.resolve([])
      })

    const deps = makeMockDeps({ listIssues })
    const governor = new WorkflowGovernor(
      makeConfig({ projects: ['Project-A', 'Project-B'] }),
      deps,
    )

    const results = await governor.scanOnce()

    expect(results).toHaveLength(2)
    expect(results[0]!.project).toBe('Project-A')
    expect(results[0]!.actionsDispatched).toBe(1)
    expect(results[1]!.project).toBe('Project-B')
    expect(results[1]!.actionsDispatched).toBe(2)
  })

  it('dispatch limit is per-project', async () => {
    const issues = [
      makeIssue({ id: 'issue-1', identifier: 'SUP-1', status: 'Backlog' }),
      makeIssue({ id: 'issue-2', identifier: 'SUP-2', status: 'Backlog' }),
      makeIssue({ id: 'issue-3', identifier: 'SUP-3', status: 'Backlog' }),
    ]

    const deps = makeMockDeps({
      listIssues: vi.fn().mockResolvedValue(issues),
    })

    const governor = new WorkflowGovernor(
      makeConfig({
        projects: ['Project-A', 'Project-B'],
        maxConcurrentDispatches: 1,
      }),
      deps,
    )

    const results = await governor.scanOnce()

    // Each project dispatches 1 (the limit), total 2
    expect(results[0]!.actionsDispatched).toBe(1)
    expect(results[1]!.actionsDispatched).toBe(1)
    expect(deps.dispatchWork).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// Mixed statuses in a single scan
// ---------------------------------------------------------------------------

describe('WorkflowGovernor.scanOnce — mixed statuses', () => {
  it('handles a mix of actionable and non-actionable issues', async () => {
    const issues = [
      makeIssue({ id: 'i-1', identifier: 'SUP-1', status: 'Accepted' }), // terminal
      makeIssue({ id: 'i-2', identifier: 'SUP-2', status: 'Backlog' }),   // actionable
      makeIssue({ id: 'i-3', identifier: 'SUP-3', status: 'Started' }),   // not actionable (already working)
      makeIssue({ id: 'i-4', identifier: 'SUP-4', status: 'Finished' }),  // actionable
      makeIssue({ id: 'i-5', identifier: 'SUP-5', status: 'Canceled' }), // terminal
    ]

    const deps = makeMockDeps({
      listIssues: vi.fn().mockResolvedValue(issues),
    })

    const governor = new WorkflowGovernor(makeConfig(), deps)
    const results = await governor.scanOnce()

    expect(results[0]!.scannedIssues).toBe(5)
    expect(results[0]!.actionsDispatched).toBe(2) // Backlog + Finished
    expect(results[0]!.skippedReasons.size).toBe(3) // Accepted + Started + Canceled
  })
})
