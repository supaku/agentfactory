import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentProcess, OrchestratorEvents } from '../orchestrator/types.js'
import type { ObservationStore } from './observation-store.js'
import type { PosteriorStore } from './posterior-store.js'
import type { RoutingObservation, RoutingPosterior } from './types.js'
import { buildObservation, wrapEventsWithRecorder } from './observation-recorder.js'

function makeProcess(overrides: Partial<AgentProcess> = {}): AgentProcess {
  return {
    issueId: 'issue-1',
    identifier: 'SUP-100',
    pid: 1234,
    status: 'running',
    startedAt: new Date('2024-01-01T00:00:00Z'),
    lastActivityAt: new Date('2024-01-01T00:01:00Z'),
    ...overrides,
  }
}

function makeMockStores() {
  const observationStore: ObservationStore = {
    recordObservation: vi.fn<(obs: RoutingObservation) => Promise<void>>().mockResolvedValue(undefined),
    getObservations: vi.fn().mockResolvedValue([]),
    getRecentObservations: vi.fn().mockResolvedValue([]),
  }

  const posteriorStore: PosteriorStore = {
    getPosterior: vi.fn().mockResolvedValue({} as RoutingPosterior),
    updatePosterior: vi.fn<(provider: string, workType: string, reward: number) => Promise<RoutingPosterior>>().mockResolvedValue({} as RoutingPosterior),
    getAllPosteriors: vi.fn().mockResolvedValue([]),
    resetPosterior: vi.fn().mockResolvedValue(undefined),
  }

  return { observationStore, posteriorStore }
}

describe('buildObservation', () => {
  it('returns null when providerName is missing', () => {
    const agent = makeProcess({
      providerName: undefined,
      workType: 'development',
    })
    expect(buildObservation(agent)).toBeNull()
  })

  it('returns null when workType is missing', () => {
    const agent = makeProcess({
      providerName: 'claude',
      workType: undefined,
    })
    expect(buildObservation(agent)).toBeNull()
  })

  it('correctly maps completed agent to observation', () => {
    const agent = makeProcess({
      status: 'completed',
      providerName: 'claude',
      workType: 'development',
      pullRequestUrl: 'https://github.com/org/repo/pull/42',
      workResult: 'passed',
      totalCostUsd: 1.5,
      sessionId: 'session-123',
      startedAt: new Date('2024-01-01T00:00:00Z'),
      completedAt: new Date('2024-01-01T00:05:00Z'),
    })

    const obs = buildObservation(agent)
    expect(obs).not.toBeNull()
    expect(obs!.provider).toBe('claude')
    expect(obs!.workType).toBe('development')
    expect(obs!.issueIdentifier).toBe('SUP-100')
    expect(obs!.sessionId).toBe('session-123')
    expect(obs!.taskCompleted).toBe(true)
    expect(obs!.prCreated).toBe(true)
    expect(obs!.qaResult).toBe('passed')
    expect(obs!.totalCostUsd).toBe(1.5)
    expect(obs!.wallClockMs).toBe(300000) // 5 minutes
    // reward for completed + PR + passed QA with some cost
    expect(obs!.reward).toBeGreaterThan(0)
    expect(obs!.reward).toBeLessThanOrEqual(1)
    expect(obs!.confidence).toBe(0)
    expect(obs!.explorationReason).toBeUndefined()
    expect(obs!.id).toBeDefined()
    expect(obs!.timestamp).toBeGreaterThan(0)
  })

  it('correctly maps failed agent to observation with reward near 0', () => {
    const agent = makeProcess({
      status: 'failed',
      providerName: 'codex',
      workType: 'qa',
      totalCostUsd: 3.0,
    })

    const obs = buildObservation(agent)
    expect(obs).not.toBeNull()
    expect(obs!.taskCompleted).toBe(false)
    expect(obs!.prCreated).toBe(false)
    expect(obs!.qaResult).toBe('unknown')
    // No success signals, only cost penalty => reward should be 0
    expect(obs!.reward).toBe(0)
  })

  it('correctly maps stopped agent to observation', () => {
    const agent = makeProcess({
      status: 'stopped',
      providerName: 'amp',
      workType: 'research',
      stopReason: 'timeout',
      totalCostUsd: 0.5,
      startedAt: new Date('2024-01-01T00:00:00Z'),
      completedAt: new Date('2024-01-01T00:02:00Z'),
    })

    const obs = buildObservation(agent)
    expect(obs).not.toBeNull()
    expect(obs!.provider).toBe('amp')
    expect(obs!.workType).toBe('research')
    expect(obs!.taskCompleted).toBe(false)
    expect(obs!.wallClockMs).toBe(120000) // 2 minutes
  })

  it('correctly maps incomplete agent to observation', () => {
    const agent = makeProcess({
      status: 'incomplete',
      providerName: 'claude',
      workType: 'development',
      incompleteReason: 'no_pr_created',
      totalCostUsd: 2.0,
    })

    const obs = buildObservation(agent)
    expect(obs).not.toBeNull()
    expect(obs!.taskCompleted).toBe(false)
    expect(obs!.prCreated).toBe(false)
  })

  it('handles missing sessionId by defaulting to empty string', () => {
    const agent = makeProcess({
      providerName: 'claude',
      workType: 'development',
      sessionId: undefined,
    })

    const obs = buildObservation(agent)
    expect(obs).not.toBeNull()
    expect(obs!.sessionId).toBe('')
  })

  it('handles missing completedAt by setting wallClockMs to 0', () => {
    const agent = makeProcess({
      providerName: 'claude',
      workType: 'development',
      completedAt: undefined,
    })

    const obs = buildObservation(agent)
    expect(obs).not.toBeNull()
    expect(obs!.wallClockMs).toBe(0)
  })

  it('handles missing totalCostUsd by defaulting to 0', () => {
    const agent = makeProcess({
      providerName: 'claude',
      workType: 'development',
      totalCostUsd: undefined,
    })

    const obs = buildObservation(agent)
    expect(obs).not.toBeNull()
    expect(obs!.totalCostUsd).toBe(0)
  })
})

describe('wrapEventsWithRecorder', () => {
  let stores: ReturnType<typeof makeMockStores>

  beforeEach(() => {
    stores = makeMockStores()
  })

  it('calls original onAgentComplete and records observation', async () => {
    const originalComplete = vi.fn()
    const events: OrchestratorEvents = { onAgentComplete: originalComplete }

    const wrapped = wrapEventsWithRecorder(events, stores)

    const agent = makeProcess({
      status: 'completed',
      providerName: 'claude',
      workType: 'development',
    })

    wrapped.onAgentComplete!(agent)

    expect(originalComplete).toHaveBeenCalledWith(agent)

    // Allow microtask queue to flush for the void promise
    await vi.waitFor(() => {
      expect(stores.observationStore.recordObservation).toHaveBeenCalled()
    })
    expect(stores.posteriorStore.updatePosterior).toHaveBeenCalled()
  })

  it('calls original onAgentStopped and records observation', async () => {
    const originalStopped = vi.fn()
    const events: OrchestratorEvents = { onAgentStopped: originalStopped }

    const wrapped = wrapEventsWithRecorder(events, stores)

    const agent = makeProcess({
      status: 'stopped',
      providerName: 'claude',
      workType: 'development',
    })

    wrapped.onAgentStopped!(agent)

    expect(originalStopped).toHaveBeenCalledWith(agent)

    await vi.waitFor(() => {
      expect(stores.observationStore.recordObservation).toHaveBeenCalled()
    })
  })

  it('calls original onAgentError and records observation', async () => {
    const originalError = vi.fn()
    const events: OrchestratorEvents = { onAgentError: originalError }

    const wrapped = wrapEventsWithRecorder(events, stores)

    const agent = makeProcess({
      status: 'failed',
      providerName: 'claude',
      workType: 'development',
    })
    const error = new Error('something broke')

    wrapped.onAgentError!(agent, error)

    expect(originalError).toHaveBeenCalledWith(agent, error)

    await vi.waitFor(() => {
      expect(stores.observationStore.recordObservation).toHaveBeenCalled()
    })
  })

  it('calls original onAgentIncomplete and records observation', async () => {
    const originalIncomplete = vi.fn()
    const events: OrchestratorEvents = { onAgentIncomplete: originalIncomplete }

    const wrapped = wrapEventsWithRecorder(events, stores)

    const agent = makeProcess({
      status: 'incomplete',
      providerName: 'claude',
      workType: 'development',
    })

    wrapped.onAgentIncomplete!(agent)

    expect(originalIncomplete).toHaveBeenCalledWith(agent)

    await vi.waitFor(() => {
      expect(stores.observationStore.recordObservation).toHaveBeenCalled()
    })
  })

  it('gracefully handles recording failures (logs error, does not throw)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const recordError = new Error('store down')
    ;(stores.observationStore.recordObservation as ReturnType<typeof vi.fn>).mockRejectedValue(recordError)

    const events: OrchestratorEvents = { onAgentComplete: vi.fn() }
    const wrapped = wrapEventsWithRecorder(events, stores)

    const agent = makeProcess({
      status: 'completed',
      providerName: 'claude',
      workType: 'development',
    })

    // Should not throw
    expect(() => wrapped.onAgentComplete!(agent)).not.toThrow()

    await vi.waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        '[routing] Failed to record observation',
        expect.objectContaining({
          error: 'store down',
          identifier: 'SUP-100',
        }),
      )
    })

    consoleSpy.mockRestore()
  })

  it('passes through non-wrapped events (onAgentStart, onIssueSelected)', () => {
    const originalStart = vi.fn()
    const originalIssueSelected = vi.fn()
    const originalProviderSessionId = vi.fn()
    const originalActivityEmitted = vi.fn()

    const events: OrchestratorEvents = {
      onAgentStart: originalStart,
      onIssueSelected: originalIssueSelected,
      onProviderSessionId: originalProviderSessionId,
      onActivityEmitted: originalActivityEmitted,
    }

    const wrapped = wrapEventsWithRecorder(events, stores)

    // Non-wrapped events should be the original references
    expect(wrapped.onAgentStart).toBe(originalStart)
    expect(wrapped.onIssueSelected).toBe(originalIssueSelected)
    expect(wrapped.onProviderSessionId).toBe(originalProviderSessionId)
    expect(wrapped.onActivityEmitted).toBe(originalActivityEmitted)
  })

  it('handles undefined original callbacks gracefully', async () => {
    const events: OrchestratorEvents = {}
    const wrapped = wrapEventsWithRecorder(events, stores)

    const agent = makeProcess({
      status: 'completed',
      providerName: 'claude',
      workType: 'development',
    })

    // Should not throw even if original callback was undefined
    expect(() => wrapped.onAgentComplete!(agent)).not.toThrow()
    expect(() => wrapped.onAgentStopped!(agent)).not.toThrow()
    expect(() => wrapped.onAgentError!(agent, new Error('test'))).not.toThrow()
    expect(() => wrapped.onAgentIncomplete!(agent)).not.toThrow()

    await vi.waitFor(() => {
      // recordObservation should be called 4 times (once per event)
      expect(stores.observationStore.recordObservation).toHaveBeenCalledTimes(4)
    })
  })

  it('does not record observation when providerName is missing', async () => {
    const events: OrchestratorEvents = { onAgentComplete: vi.fn() }
    const wrapped = wrapEventsWithRecorder(events, stores)

    const agent = makeProcess({
      status: 'completed',
      providerName: undefined,
      workType: 'development',
    })

    wrapped.onAgentComplete!(agent)

    // Give microtasks a chance to run
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(stores.observationStore.recordObservation).not.toHaveBeenCalled()
    expect(stores.posteriorStore.updatePosterior).not.toHaveBeenCalled()
  })

  it('does not record observation when workType is missing', async () => {
    const events: OrchestratorEvents = { onAgentComplete: vi.fn() }
    const wrapped = wrapEventsWithRecorder(events, stores)

    const agent = makeProcess({
      status: 'completed',
      providerName: 'claude',
      workType: undefined,
    })

    wrapped.onAgentComplete!(agent)

    // Give microtasks a chance to run
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(stores.observationStore.recordObservation).not.toHaveBeenCalled()
    expect(stores.posteriorStore.updatePosterior).not.toHaveBeenCalled()
  })

  it('updates posterior with correct provider, workType, and reward', async () => {
    const events: OrchestratorEvents = { onAgentComplete: vi.fn() }
    const wrapped = wrapEventsWithRecorder(events, stores)

    const agent = makeProcess({
      status: 'completed',
      providerName: 'claude',
      workType: 'development',
      pullRequestUrl: 'https://github.com/org/repo/pull/1',
      workResult: 'passed',
      totalCostUsd: 0,
    })

    wrapped.onAgentComplete!(agent)

    await vi.waitFor(() => {
      expect(stores.posteriorStore.updatePosterior).toHaveBeenCalledWith(
        'claude',
        'development',
        expect.any(Number),
      )
    })

    // Verify the reward value is the expected full-success reward (1.0)
    const [, , reward] = (stores.posteriorStore.updatePosterior as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(reward).toBe(1.0)
  })
})
