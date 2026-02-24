import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventDrivenGovernor, type EventDrivenGovernorConfig } from './event-driven-governor.js'
import type { GovernorDependencies } from './governor.js'
import type { GovernorIssue } from './governor-types.js'
import { DEFAULT_GOVERNOR_CONFIG } from './governor-types.js'
import { InMemoryEventBus } from './in-memory-event-bus.js'
import { InMemoryEventDeduplicator } from './event-deduplicator.js'
import type {
  GovernorEvent,
  IssueStatusChangedEvent,
  CommentAddedEvent,
  SessionCompletedEvent,
  PollSnapshotEvent,
} from './event-types.js'
import {
  initTouchpointStorage,
  InMemoryOverrideStorage,
  getOverrideState,
} from './human-touchpoints.js'

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

function makeMockDeps(overrides: Partial<GovernorDependencies> = {}): GovernorDependencies {
  return {
    listIssues: vi.fn().mockResolvedValue([]),
    hasActiveSession: vi.fn().mockResolvedValue(false),
    isWithinCooldown: vi.fn().mockResolvedValue(false),
    isParentIssue: vi.fn().mockResolvedValue(false),
    isHeld: vi.fn().mockResolvedValue(false),
    getOverridePriority: vi.fn().mockResolvedValue(null),
    getWorkflowStrategy: vi.fn().mockResolvedValue(undefined),
    isResearchCompleted: vi.fn().mockResolvedValue(false),
    isBacklogCreationCompleted: vi.fn().mockResolvedValue(false),
    dispatchWork: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function makeConfig(
  eventBus: InMemoryEventBus,
  overrides: Partial<EventDrivenGovernorConfig> = {},
): EventDrivenGovernorConfig {
  return {
    ...DEFAULT_GOVERNOR_CONFIG,
    projects: ['TestProject'],
    eventBus,
    enablePolling: false, // Disable polling by default in tests
    ...overrides,
  }
}

function makeStatusChangedEvent(
  issue: GovernorIssue,
  newStatus: string,
  previousStatus?: string,
): IssueStatusChangedEvent {
  return {
    type: 'issue-status-changed',
    issueId: issue.id,
    issue: { ...issue, status: newStatus },
    previousStatus,
    newStatus,
    timestamp: new Date().toISOString(),
    source: 'webhook',
  }
}

function makeCommentEvent(
  issue: GovernorIssue,
  commentBody: string,
  commentId = 'comment-1',
): CommentAddedEvent {
  return {
    type: 'comment-added',
    issueId: issue.id,
    issue,
    commentId,
    commentBody,
    userId: 'user-1',
    userName: 'Test User',
    timestamp: new Date().toISOString(),
    source: 'webhook',
  }
}

function makeSessionCompletedEvent(
  issue: GovernorIssue,
  outcome: 'success' | 'failure' = 'success',
): SessionCompletedEvent {
  return {
    type: 'session-completed',
    issueId: issue.id,
    issue,
    sessionId: 'session-1',
    outcome,
    timestamp: new Date().toISOString(),
    source: 'webhook',
  }
}

function makePollSnapshotEvent(issue: GovernorIssue, project = 'TestProject'): PollSnapshotEvent {
  return {
    type: 'poll-snapshot',
    issueId: issue.id,
    issue,
    project,
    timestamp: new Date().toISOString(),
    source: 'poll',
  }
}

/**
 * Helper to wait for events to be processed.
 * Publishes events, then gives the event loop time to consume them.
 */
async function waitForProcessing(ms = 50): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let overrideStorage: InMemoryOverrideStorage

beforeEach(() => {
  overrideStorage = new InMemoryOverrideStorage()
  initTouchpointStorage(overrideStorage)
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('EventDrivenGovernor — lifecycle', () => {
  it('isRunning returns false before start', () => {
    const bus = new InMemoryEventBus()
    const deps = makeMockDeps()
    const governor = new EventDrivenGovernor(makeConfig(bus), deps)
    expect(governor.isRunning()).toBe(false)
  })

  it('isRunning returns true after start', async () => {
    const bus = new InMemoryEventBus()
    const deps = makeMockDeps()
    const governor = new EventDrivenGovernor(makeConfig(bus), deps)

    await governor.start()
    expect(governor.isRunning()).toBe(true)

    await governor.stop()
  })

  it('isRunning returns false after stop', async () => {
    const bus = new InMemoryEventBus()
    const deps = makeMockDeps()
    const governor = new EventDrivenGovernor(makeConfig(bus), deps)

    await governor.start()
    await governor.stop()
    expect(governor.isRunning()).toBe(false)
  })

  it('calling start twice is idempotent', async () => {
    const bus = new InMemoryEventBus()
    const deps = makeMockDeps()
    const governor = new EventDrivenGovernor(makeConfig(bus), deps)

    await governor.start()
    await governor.start() // should not throw or create duplicates
    expect(governor.isRunning()).toBe(true)

    await governor.stop()
  })

  it('calling stop when not running is safe', async () => {
    const bus = new InMemoryEventBus()
    const deps = makeMockDeps()
    const governor = new EventDrivenGovernor(makeConfig(bus), deps)

    // Should not throw
    await governor.stop()
  })
})

// ---------------------------------------------------------------------------
// Event processing — issue-status-changed
// ---------------------------------------------------------------------------

describe('EventDrivenGovernor — issue-status-changed events', () => {
  it('dispatches development for Backlog issue', async () => {
    const bus = new InMemoryEventBus()
    const deps = makeMockDeps()
    const governor = new EventDrivenGovernor(makeConfig(bus), deps)

    await governor.start()

    const issue = makeIssue({ status: 'Backlog' })
    const event = makeStatusChangedEvent(issue, 'Backlog', 'Icebox')
    await bus.publish(event)
    await waitForProcessing()

    expect(deps.dispatchWork).toHaveBeenCalledWith(expect.objectContaining({ id: 'issue-1' }), 'trigger-development')

    await governor.stop()
  })

  it('dispatches QA for Finished issue', async () => {
    const bus = new InMemoryEventBus()
    const deps = makeMockDeps()
    const governor = new EventDrivenGovernor(makeConfig(bus), deps)

    await governor.start()

    const issue = makeIssue({ status: 'Finished' })
    const event = makeStatusChangedEvent(issue, 'Finished', 'Started')
    await bus.publish(event)
    await waitForProcessing()

    expect(deps.dispatchWork).toHaveBeenCalledWith(expect.objectContaining({ id: 'issue-1' }), 'trigger-qa')

    await governor.stop()
  })

  it('dispatches acceptance for Delivered issue', async () => {
    const bus = new InMemoryEventBus()
    const deps = makeMockDeps()
    const governor = new EventDrivenGovernor(makeConfig(bus), deps)

    await governor.start()

    const issue = makeIssue({ status: 'Delivered' })
    const event = makeStatusChangedEvent(issue, 'Delivered', 'Finished')
    await bus.publish(event)
    await waitForProcessing()

    expect(deps.dispatchWork).toHaveBeenCalledWith(expect.objectContaining({ id: 'issue-1' }), 'trigger-acceptance')

    await governor.stop()
  })

  it('dispatches refinement for Rejected issue', async () => {
    const bus = new InMemoryEventBus()
    const deps = makeMockDeps()
    const governor = new EventDrivenGovernor(makeConfig(bus), deps)

    await governor.start()

    const issue = makeIssue({ status: 'Rejected' })
    const event = makeStatusChangedEvent(issue, 'Rejected', 'Finished')
    await bus.publish(event)
    await waitForProcessing()

    expect(deps.dispatchWork).toHaveBeenCalledWith(expect.objectContaining({ id: 'issue-1' }), 'trigger-refinement')

    await governor.stop()
  })

  it('does not dispatch for terminal status', async () => {
    const bus = new InMemoryEventBus()
    const deps = makeMockDeps()
    const governor = new EventDrivenGovernor(makeConfig(bus), deps)

    await governor.start()

    const issue = makeIssue({ status: 'Accepted' })
    const event = makeStatusChangedEvent(issue, 'Accepted', 'Delivered')
    await bus.publish(event)
    await waitForProcessing()

    expect(deps.dispatchWork).not.toHaveBeenCalled()

    await governor.stop()
  })

  it('skips issues with active sessions', async () => {
    const bus = new InMemoryEventBus()
    const deps = makeMockDeps({
      hasActiveSession: vi.fn().mockResolvedValue(true),
    })
    const governor = new EventDrivenGovernor(makeConfig(bus), deps)

    await governor.start()

    const issue = makeIssue({ status: 'Backlog' })
    const event = makeStatusChangedEvent(issue, 'Backlog')
    await bus.publish(event)
    await waitForProcessing()

    expect(deps.dispatchWork).not.toHaveBeenCalled()

    await governor.stop()
  })

  it('skips held issues', async () => {
    const bus = new InMemoryEventBus()
    const deps = makeMockDeps({
      isHeld: vi.fn().mockResolvedValue(true),
    })
    const governor = new EventDrivenGovernor(makeConfig(bus), deps)

    await governor.start()

    const issue = makeIssue({ status: 'Backlog' })
    const event = makeStatusChangedEvent(issue, 'Backlog')
    await bus.publish(event)
    await waitForProcessing()

    expect(deps.dispatchWork).not.toHaveBeenCalled()

    await governor.stop()
  })
})

// ---------------------------------------------------------------------------
// Event processing — session-completed
// ---------------------------------------------------------------------------

describe('EventDrivenGovernor — session-completed events', () => {
  it('evaluates the issue after session completion', async () => {
    const bus = new InMemoryEventBus()
    const deps = makeMockDeps()
    const governor = new EventDrivenGovernor(makeConfig(bus), deps)

    await governor.start()

    const issue = makeIssue({ status: 'Finished' })
    const event = makeSessionCompletedEvent(issue, 'success')
    await bus.publish(event)
    await waitForProcessing()

    expect(deps.dispatchWork).toHaveBeenCalledWith(expect.objectContaining({ id: 'issue-1' }), 'trigger-qa')

    await governor.stop()
  })
})

// ---------------------------------------------------------------------------
// Event processing — poll-snapshot
// ---------------------------------------------------------------------------

describe('EventDrivenGovernor — poll-snapshot events', () => {
  it('evaluates the issue from a poll snapshot', async () => {
    const bus = new InMemoryEventBus()
    const deps = makeMockDeps()
    const governor = new EventDrivenGovernor(makeConfig(bus), deps)

    await governor.start()

    const issue = makeIssue({ status: 'Backlog' })
    const event = makePollSnapshotEvent(issue)
    await bus.publish(event)
    await waitForProcessing()

    expect(deps.dispatchWork).toHaveBeenCalledWith(expect.objectContaining({ id: 'issue-1' }), 'trigger-development')

    await governor.stop()
  })
})

// ---------------------------------------------------------------------------
// Event processing — comment-added (override directives)
// ---------------------------------------------------------------------------

describe('EventDrivenGovernor — comment-added events', () => {
  it('sets hold override when HOLD comment is received', async () => {
    const bus = new InMemoryEventBus()
    const deps = makeMockDeps()
    const governor = new EventDrivenGovernor(makeConfig(bus), deps)

    await governor.start()

    const issue = makeIssue({ status: 'Backlog' })
    const event = makeCommentEvent(issue, 'HOLD')
    await bus.publish(event)
    await waitForProcessing()

    const state = await getOverrideState(issue.id)
    expect(state).not.toBeNull()
    expect(state!.directive.type).toBe('hold')

    // HOLD should not trigger dispatch
    expect(deps.dispatchWork).not.toHaveBeenCalled()

    await governor.stop()
  })

  it('sets hold override with reason', async () => {
    const bus = new InMemoryEventBus()
    const deps = makeMockDeps()
    const governor = new EventDrivenGovernor(makeConfig(bus), deps)

    await governor.start()

    const issue = makeIssue({ status: 'Backlog' })
    const event = makeCommentEvent(issue, 'HOLD - waiting for design review')
    await bus.publish(event)
    await waitForProcessing()

    const state = await getOverrideState(issue.id)
    expect(state).not.toBeNull()
    expect(state!.directive.type).toBe('hold')
    expect(state!.directive.reason).toBe('waiting for design review')

    await governor.stop()
  })

  it('clears override and re-evaluates on RESUME', async () => {
    const bus = new InMemoryEventBus()
    const deps = makeMockDeps()
    const governor = new EventDrivenGovernor(makeConfig(bus), deps)

    await governor.start()

    const issue = makeIssue({ status: 'Backlog' })

    // First, set a HOLD
    const holdEvent = makeCommentEvent(issue, 'HOLD', 'comment-hold')
    await bus.publish(holdEvent)
    await waitForProcessing()

    // Verify hold is set
    let state = await getOverrideState(issue.id)
    expect(state).not.toBeNull()
    expect(state!.directive.type).toBe('hold')

    // Now RESUME
    const resumeEvent = makeCommentEvent(issue, 'RESUME', 'comment-resume')
    await bus.publish(resumeEvent)
    await waitForProcessing()

    // Override should be cleared
    state = await getOverrideState(issue.id)
    expect(state).toBeNull()

    // Issue should have been re-evaluated and dispatched
    expect(deps.dispatchWork).toHaveBeenCalledWith(expect.objectContaining({ id: 'issue-1' }), 'trigger-development')

    await governor.stop()
  })

  it('sets priority override when PRIORITY comment is received', async () => {
    const bus = new InMemoryEventBus()
    const deps = makeMockDeps()
    const governor = new EventDrivenGovernor(makeConfig(bus), deps)

    await governor.start()

    const issue = makeIssue({ status: 'Backlog' })
    const event = makeCommentEvent(issue, 'PRIORITY: high')
    await bus.publish(event)
    await waitForProcessing()

    const state = await getOverrideState(issue.id)
    expect(state).not.toBeNull()
    expect(state!.directive.type).toBe('priority')
    expect(state!.directive.priority).toBe('high')

    await governor.stop()
  })

  it('evaluates issue when comment has no directive', async () => {
    const bus = new InMemoryEventBus()
    const deps = makeMockDeps()
    const governor = new EventDrivenGovernor(makeConfig(bus), deps)

    await governor.start()

    const issue = makeIssue({ status: 'Backlog' })
    const event = makeCommentEvent(issue, 'Just a regular comment with no directive')
    await bus.publish(event)
    await waitForProcessing()

    // Should still evaluate the issue
    expect(deps.dispatchWork).toHaveBeenCalledWith(expect.objectContaining({ id: 'issue-1' }), 'trigger-development')

    await governor.stop()
  })

  it('handles SKIP QA directive', async () => {
    const bus = new InMemoryEventBus()
    const deps = makeMockDeps()
    const governor = new EventDrivenGovernor(makeConfig(bus), deps)

    await governor.start()

    const issue = makeIssue({ status: 'Finished' })
    const event = makeCommentEvent(issue, 'SKIP QA')
    await bus.publish(event)
    await waitForProcessing()

    const state = await getOverrideState(issue.id)
    expect(state).not.toBeNull()
    expect(state!.directive.type).toBe('skip-qa')

    await governor.stop()
  })

  it('handles DECOMPOSE directive', async () => {
    const bus = new InMemoryEventBus()
    const deps = makeMockDeps()
    const governor = new EventDrivenGovernor(makeConfig(bus), deps)

    await governor.start()

    const issue = makeIssue({ status: 'Rejected' })
    const event = makeCommentEvent(issue, 'DECOMPOSE')
    await bus.publish(event)
    await waitForProcessing()

    const state = await getOverrideState(issue.id)
    expect(state).not.toBeNull()
    expect(state!.directive.type).toBe('decompose')

    await governor.stop()
  })
})

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe('EventDrivenGovernor — deduplication', () => {
  it('skips duplicate events when deduplicator is configured', async () => {
    const bus = new InMemoryEventBus()
    const deduplicator = new InMemoryEventDeduplicator()
    const deps = makeMockDeps()
    const governor = new EventDrivenGovernor(
      makeConfig(bus, { deduplicator }),
      deps,
    )

    await governor.start()

    const issue = makeIssue({ status: 'Backlog' })
    const event = makeStatusChangedEvent(issue, 'Backlog')

    // Publish the same event twice
    await bus.publish(event)
    await bus.publish(event)
    await waitForProcessing()

    // Only dispatched once due to deduplication
    expect(deps.dispatchWork).toHaveBeenCalledTimes(1)

    await governor.stop()
  })

  it('processes all events when no deduplicator is configured', async () => {
    const bus = new InMemoryEventBus()
    const deps = makeMockDeps()
    const governor = new EventDrivenGovernor(
      makeConfig(bus), // no deduplicator
      deps,
    )

    await governor.start()

    const issue = makeIssue({ status: 'Backlog' })
    const event = makeStatusChangedEvent(issue, 'Backlog')

    // Publish the same event twice
    await bus.publish(event)
    await bus.publish(event)
    await waitForProcessing()

    // Both are processed since there is no deduplicator
    expect(deps.dispatchWork).toHaveBeenCalledTimes(2)

    await governor.stop()
  })

  it('acknowledges duplicate events on the bus', async () => {
    const bus = new InMemoryEventBus()
    const deduplicator = new InMemoryEventDeduplicator()
    const deps = makeMockDeps()
    const governor = new EventDrivenGovernor(
      makeConfig(bus, { deduplicator }),
      deps,
    )

    await governor.start()

    const issue = makeIssue({ status: 'Backlog' })
    const event = makeStatusChangedEvent(issue, 'Backlog')

    const id1 = await bus.publish(event)
    const id2 = await bus.publish(event)
    await waitForProcessing()

    // Both events should be acked (even the duplicate)
    expect(bus.isAcked(id1)).toBe(true)
    expect(bus.isAcked(id2)).toBe(true)

    await governor.stop()
  })
})

// ---------------------------------------------------------------------------
// Event acknowledgement
// ---------------------------------------------------------------------------

describe('EventDrivenGovernor — event acknowledgement', () => {
  it('acknowledges processed events', async () => {
    const bus = new InMemoryEventBus()
    const deps = makeMockDeps()
    const governor = new EventDrivenGovernor(makeConfig(bus), deps)

    await governor.start()

    const issue = makeIssue({ status: 'Backlog' })
    const event = makeStatusChangedEvent(issue, 'Backlog')
    const eventId = await bus.publish(event)
    await waitForProcessing()

    expect(bus.isAcked(eventId)).toBe(true)

    await governor.stop()
  })
})

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('EventDrivenGovernor — error handling', () => {
  it('continues processing after a dispatch error', async () => {
    const bus = new InMemoryEventBus()
    const dispatchWork = vi.fn()
      .mockRejectedValueOnce(new Error('Dispatch failed'))
      .mockResolvedValueOnce(undefined)
    const deps = makeMockDeps({ dispatchWork })
    const governor = new EventDrivenGovernor(makeConfig(bus), deps)

    await governor.start()

    const issue1 = makeIssue({ id: 'issue-1', identifier: 'SUP-1', status: 'Backlog' })
    const issue2 = makeIssue({ id: 'issue-2', identifier: 'SUP-2', status: 'Backlog' })

    await bus.publish(makeStatusChangedEvent(issue1, 'Backlog'))
    await bus.publish(makeStatusChangedEvent(issue2, 'Backlog'))
    await waitForProcessing()

    // Both events attempted, second one succeeded
    expect(dispatchWork).toHaveBeenCalledTimes(2)

    await governor.stop()
  })

  it('continues processing after a context-gathering error', async () => {
    const bus = new InMemoryEventBus()
    const hasActiveSession = vi.fn()
      .mockRejectedValueOnce(new Error('Redis down'))
      .mockResolvedValueOnce(false)
    const deps = makeMockDeps({ hasActiveSession })
    const governor = new EventDrivenGovernor(makeConfig(bus), deps)

    await governor.start()

    const issue1 = makeIssue({ id: 'issue-1', identifier: 'SUP-1', status: 'Backlog' })
    const issue2 = makeIssue({ id: 'issue-2', identifier: 'SUP-2', status: 'Backlog' })

    await bus.publish(makeStatusChangedEvent(issue1, 'Backlog'))
    await bus.publish(makeStatusChangedEvent(issue2, 'Backlog'))
    await waitForProcessing()

    // First event failed during context gathering, second event dispatched
    expect(deps.dispatchWork).toHaveBeenCalledTimes(1)
    expect(deps.dispatchWork).toHaveBeenCalledWith(expect.objectContaining({ id: 'issue-2' }), 'trigger-development')

    await governor.stop()
  })
})

// ---------------------------------------------------------------------------
// Multiple events in sequence
// ---------------------------------------------------------------------------

describe('EventDrivenGovernor — sequential event processing', () => {
  it('processes multiple different events in order', async () => {
    const bus = new InMemoryEventBus()
    const deps = makeMockDeps()
    const governor = new EventDrivenGovernor(makeConfig(bus), deps)

    await governor.start()

    const issue1 = makeIssue({ id: 'issue-1', identifier: 'SUP-1', status: 'Backlog' })
    const issue2 = makeIssue({ id: 'issue-2', identifier: 'SUP-2', status: 'Finished' })
    const issue3 = makeIssue({ id: 'issue-3', identifier: 'SUP-3', status: 'Delivered' })

    await bus.publish(makeStatusChangedEvent(issue1, 'Backlog'))
    await bus.publish(makeStatusChangedEvent(issue2, 'Finished'))
    await bus.publish(makeStatusChangedEvent(issue3, 'Delivered'))
    await waitForProcessing()

    expect(deps.dispatchWork).toHaveBeenCalledTimes(3)
    expect(deps.dispatchWork).toHaveBeenCalledWith(expect.objectContaining({ id: 'issue-1' }), 'trigger-development')
    expect(deps.dispatchWork).toHaveBeenCalledWith(expect.objectContaining({ id: 'issue-2' }), 'trigger-qa')
    expect(deps.dispatchWork).toHaveBeenCalledWith(expect.objectContaining({ id: 'issue-3' }), 'trigger-acceptance')

    await governor.stop()
  })
})

// ---------------------------------------------------------------------------
// Poll sweep
// ---------------------------------------------------------------------------

describe('EventDrivenGovernor — pollSweep', () => {
  it('publishes poll-snapshot events for all issues in all projects', async () => {
    const bus = new InMemoryEventBus()
    const issues = [
      makeIssue({ id: 'issue-1', identifier: 'SUP-1', status: 'Backlog' }),
      makeIssue({ id: 'issue-2', identifier: 'SUP-2', status: 'Finished' }),
    ]
    const deps = makeMockDeps({
      listIssues: vi.fn().mockResolvedValue(issues),
    })
    const governor = new EventDrivenGovernor(
      makeConfig(bus, { projects: ['ProjectA'] }),
      deps,
    )

    await governor.start()
    await governor.pollSweep()
    await waitForProcessing()

    // The poll sweep publishes events that get processed by the event loop
    expect(deps.listIssues).toHaveBeenCalledWith('ProjectA')
    expect(deps.dispatchWork).toHaveBeenCalledWith(expect.objectContaining({ id: 'issue-1' }), 'trigger-development')
    expect(deps.dispatchWork).toHaveBeenCalledWith(expect.objectContaining({ id: 'issue-2' }), 'trigger-qa')

    await governor.stop()
  })

  it('polls multiple projects', async () => {
    const bus = new InMemoryEventBus()
    const listIssues = vi.fn().mockImplementation((project: string) => {
      if (project === 'ProjectA') {
        return Promise.resolve([makeIssue({ id: 'a-1', identifier: 'A-1', status: 'Backlog' })])
      }
      if (project === 'ProjectB') {
        return Promise.resolve([makeIssue({ id: 'b-1', identifier: 'B-1', status: 'Finished' })])
      }
      return Promise.resolve([])
    })
    const deps = makeMockDeps({ listIssues })
    const governor = new EventDrivenGovernor(
      makeConfig(bus, { projects: ['ProjectA', 'ProjectB'] }),
      deps,
    )

    await governor.start()
    await governor.pollSweep()
    await waitForProcessing()

    expect(listIssues).toHaveBeenCalledWith('ProjectA')
    expect(listIssues).toHaveBeenCalledWith('ProjectB')
    expect(deps.dispatchWork).toHaveBeenCalledWith(expect.objectContaining({ id: 'a-1' }), 'trigger-development')
    expect(deps.dispatchWork).toHaveBeenCalledWith(expect.objectContaining({ id: 'b-1' }), 'trigger-qa')

    await governor.stop()
  })

  it('handles errors in poll sweep for individual projects', async () => {
    const bus = new InMemoryEventBus()
    const listIssues = vi.fn()
      .mockRejectedValueOnce(new Error('API timeout'))
      .mockResolvedValueOnce([makeIssue({ id: 'b-1', status: 'Backlog' })])
    const deps = makeMockDeps({ listIssues })
    const governor = new EventDrivenGovernor(
      makeConfig(bus, { projects: ['ProjectA', 'ProjectB'] }),
      deps,
    )

    await governor.start()
    // Should not throw even though ProjectA fails
    await governor.pollSweep()
    await waitForProcessing()

    // ProjectB's issue should still be published and processed
    expect(deps.dispatchWork).toHaveBeenCalledWith(expect.objectContaining({ id: 'b-1' }), 'trigger-development')

    await governor.stop()
  })

  it('poll sweep events are deduplicated', async () => {
    const bus = new InMemoryEventBus()
    const deduplicator = new InMemoryEventDeduplicator()
    const issues = [makeIssue({ id: 'issue-1', status: 'Backlog' })]
    const deps = makeMockDeps({
      listIssues: vi.fn().mockResolvedValue(issues),
    })
    const governor = new EventDrivenGovernor(
      makeConfig(bus, { deduplicator, projects: ['ProjectA'] }),
      deps,
    )

    await governor.start()

    // First sweep
    await governor.pollSweep()
    await waitForProcessing()

    // Second sweep immediately — same issue+status should be deduped
    await governor.pollSweep()
    await waitForProcessing()

    // Only dispatched once due to deduplication
    expect(deps.dispatchWork).toHaveBeenCalledTimes(1)

    await governor.stop()
  })
})

// ---------------------------------------------------------------------------
// Polling timer
// ---------------------------------------------------------------------------

describe('EventDrivenGovernor — poll timer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts poll timer when enablePolling is true', async () => {
    const bus = new InMemoryEventBus()
    const deps = makeMockDeps({
      listIssues: vi.fn().mockResolvedValue([]),
    })
    const governor = new EventDrivenGovernor(
      makeConfig(bus, { enablePolling: true, pollIntervalMs: 5000 }),
      deps,
    )

    await governor.start()

    // Advance past the poll interval
    await vi.advanceTimersByTimeAsync(5000)

    expect(deps.listIssues).toHaveBeenCalled()

    await governor.stop()
  })

  it('does not start poll timer when enablePolling is false', async () => {
    const bus = new InMemoryEventBus()
    const deps = makeMockDeps()
    const governor = new EventDrivenGovernor(
      makeConfig(bus, { enablePolling: false }),
      deps,
    )

    await governor.start()

    await vi.advanceTimersByTimeAsync(600_000) // 10 minutes

    // listIssues is only called by pollSweep, which should not have fired
    expect(deps.listIssues).not.toHaveBeenCalled()

    await governor.stop()
  })

  it('stop clears the poll timer', async () => {
    const bus = new InMemoryEventBus()
    const deps = makeMockDeps({
      listIssues: vi.fn().mockResolvedValue([]),
    })
    const governor = new EventDrivenGovernor(
      makeConfig(bus, { enablePolling: true, pollIntervalMs: 5000 }),
      deps,
    )

    await governor.start()
    await governor.stop()

    // Advance well past the poll interval — no sweep should fire
    await vi.advanceTimersByTimeAsync(30_000)

    expect(deps.listIssues).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Context gathering
// ---------------------------------------------------------------------------

describe('EventDrivenGovernor — context gathering', () => {
  it('calls all dependency checks for an issue', async () => {
    const bus = new InMemoryEventBus()
    const deps = makeMockDeps()
    const governor = new EventDrivenGovernor(makeConfig(bus), deps)

    await governor.start()

    const issue = makeIssue({ id: 'issue-1', status: 'Backlog' })
    await bus.publish(makeStatusChangedEvent(issue, 'Backlog'))
    await waitForProcessing()

    expect(deps.hasActiveSession).toHaveBeenCalledWith('issue-1')
    expect(deps.isWithinCooldown).toHaveBeenCalledWith('issue-1')
    expect(deps.isParentIssue).toHaveBeenCalledWith('issue-1')
    expect(deps.isHeld).toHaveBeenCalledWith('issue-1')
    expect(deps.getWorkflowStrategy).toHaveBeenCalledWith('issue-1')
    expect(deps.isResearchCompleted).toHaveBeenCalledWith('issue-1')
    expect(deps.isBacklogCreationCompleted).toHaveBeenCalledWith('issue-1')

    await governor.stop()
  })
})
