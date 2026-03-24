import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  checkGateTimeout,
  checkAllGateTimeouts,
  resolveTimeoutAction,
  processGateTimeouts,
} from './timeout-engine.js'
import { InMemoryGateStorage } from '../gate-state.js'
import type { GateState } from '../gate-state.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGateState(overrides: Partial<GateState> = {}): GateState {
  return {
    issueId: 'issue-1',
    gateName: 'test-gate',
    gateType: 'signal',
    status: 'active',
    activatedAt: Date.now(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// checkGateTimeout
// ---------------------------------------------------------------------------

describe('checkGateTimeout', () => {
  it('returns not timed out when no deadline is set', () => {
    const state = makeGateState({ timeoutDeadline: undefined })
    const result = checkGateTimeout(state, Date.now())
    expect(result.timedOut).toBe(false)
    expect(result.action).toBeUndefined()
  })

  it('returns not timed out when deadline is in the future', () => {
    const now = 1_000_000
    const state = makeGateState({ timeoutDeadline: now + 60_000 })
    const result = checkGateTimeout(state, now)
    expect(result.timedOut).toBe(false)
  })

  it('returns timed out with action when deadline has passed', () => {
    const now = 1_000_000
    const state = makeGateState({
      timeoutDeadline: now - 1000,
      timeoutAction: 'escalate',
    })
    const result = checkGateTimeout(state, now)
    expect(result.timedOut).toBe(true)
    expect(result.action).toBe('escalate')
  })

  it('defaults to fail action when no timeoutAction is set', () => {
    const now = 1_000_000
    const state = makeGateState({
      timeoutDeadline: now - 1000,
      timeoutAction: undefined,
    })
    const result = checkGateTimeout(state, now)
    expect(result.timedOut).toBe(true)
    expect(result.action).toBe('fail')
  })

  it('returns timed out when deadline equals current time', () => {
    const now = 1_000_000
    const state = makeGateState({ timeoutDeadline: now, timeoutAction: 'skip' })
    const result = checkGateTimeout(state, now)
    expect(result.timedOut).toBe(true)
    expect(result.action).toBe('skip')
  })
})

// ---------------------------------------------------------------------------
// checkAllGateTimeouts
// ---------------------------------------------------------------------------

describe('checkAllGateTimeouts', () => {
  it('returns only timed-out gates', () => {
    const now = 1_000_000
    const gates: GateState[] = [
      makeGateState({ gateName: 'gate-a', timeoutDeadline: now - 1000, timeoutAction: 'fail' }),
      makeGateState({ gateName: 'gate-b', timeoutDeadline: now + 60_000, timeoutAction: 'skip' }),
      makeGateState({ gateName: 'gate-c', timeoutDeadline: now - 500, timeoutAction: 'escalate' }),
    ]

    const result = checkAllGateTimeouts(gates, now)
    expect(result).toHaveLength(2)
    expect(result.map(r => r.gateState.gateName)).toContain('gate-a')
    expect(result.map(r => r.gateState.gateName)).toContain('gate-c')
  })

  it('returns empty array when no gates have timed out', () => {
    const now = 1_000_000
    const gates: GateState[] = [
      makeGateState({ gateName: 'gate-a', timeoutDeadline: now + 60_000 }),
      makeGateState({ gateName: 'gate-b' }), // no deadline
    ]

    const result = checkAllGateTimeouts(gates, now)
    expect(result).toEqual([])
  })

  it('returns empty array for empty gate list', () => {
    const result = checkAllGateTimeouts([], Date.now())
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// resolveTimeoutAction
// ---------------------------------------------------------------------------

describe('resolveTimeoutAction', () => {
  it('produces escalate resolution', () => {
    const resolution = resolveTimeoutAction('escalate', 'issue-1', 'review-gate')
    expect(resolution.type).toBe('escalate')
    expect(resolution.issueId).toBe('issue-1')
    expect(resolution.gateName).toBe('review-gate')
    expect(resolution.reason).toContain('review-gate')
    expect(resolution.reason).toContain('escalating')
  })

  it('produces skip resolution', () => {
    const resolution = resolveTimeoutAction('skip', 'issue-1', 'review-gate')
    expect(resolution.type).toBe('skip')
    expect(resolution.reason).toContain('skipping gate')
  })

  it('produces fail resolution', () => {
    const resolution = resolveTimeoutAction('fail', 'issue-1', 'review-gate')
    expect(resolution.type).toBe('fail')
    expect(resolution.reason).toContain('failing workflow')
  })
})

// ---------------------------------------------------------------------------
// processGateTimeouts
// ---------------------------------------------------------------------------

describe('processGateTimeouts', () => {
  let storage: InMemoryGateStorage

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-06-01T12:00:00Z'))
    storage = new InMemoryGateStorage()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('marks timed-out gates in storage and returns resolutions', async () => {
    const now = Date.now()
    const gateState = makeGateState({
      gateName: 'timeout-gate',
      status: 'active',
      timeoutDeadline: now - 1000,
      timeoutAction: 'fail',
    })

    // Store the gate so timeoutGate can find it
    await storage.setGateState('issue-1', 'timeout-gate', gateState)

    const resolutions = await processGateTimeouts([gateState], storage, now)

    expect(resolutions).toHaveLength(1)
    expect(resolutions[0].type).toBe('fail')
    expect(resolutions[0].gateName).toBe('timeout-gate')

    // Verify gate was marked as timed-out in storage
    const updated = await storage.getGateState('issue-1', 'timeout-gate')
    expect(updated?.status).toBe('timed-out')
  })

  it('returns empty array when no gates are timed out', async () => {
    const now = Date.now()
    const gateState = makeGateState({
      timeoutDeadline: now + 60_000, // future deadline
      timeoutAction: 'fail',
    })

    const resolutions = await processGateTimeouts([gateState], storage, now)
    expect(resolutions).toEqual([])
  })

  it('skips gates that fail to mark (not found in storage)', async () => {
    const now = Date.now()
    const gateState = makeGateState({
      gateName: 'phantom-gate',
      timeoutDeadline: now - 1000,
      timeoutAction: 'escalate',
    })

    // Do NOT add to storage — timeoutGate will return null
    const resolutions = await processGateTimeouts([gateState], storage, now)
    expect(resolutions).toEqual([])
  })

  it('processes multiple timed-out gates', async () => {
    const now = Date.now()
    const gate1 = makeGateState({
      gateName: 'gate-1',
      status: 'active',
      timeoutDeadline: now - 1000,
      timeoutAction: 'fail',
    })
    const gate2 = makeGateState({
      gateName: 'gate-2',
      status: 'active',
      timeoutDeadline: now - 500,
      timeoutAction: 'escalate',
    })

    await storage.setGateState('issue-1', 'gate-1', gate1)
    await storage.setGateState('issue-1', 'gate-2', gate2)

    const resolutions = await processGateTimeouts([gate1, gate2], storage, now)
    expect(resolutions).toHaveLength(2)
    expect(resolutions[0].type).toBe('fail')
    expect(resolutions[1].type).toBe('escalate')
  })
})
