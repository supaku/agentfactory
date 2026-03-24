import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  parseDuration,
  InMemoryGateStorage,
  activateGate,
  satisfyGate,
  timeoutGate,
} from './gate-state.js'
import type { GateState, GateStorage } from './gate-state.js'
import type { GateDefinition } from './workflow-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGateDefinition(overrides: Partial<GateDefinition> = {}): GateDefinition {
  return {
    name: 'test-gate',
    type: 'signal',
    trigger: { source: 'comment', match: 'APPROVE' },
    ...overrides,
  }
}

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
// parseDuration
// ---------------------------------------------------------------------------

describe('parseDuration', () => {
  it('parses hours: "4h" → 14400000ms', () => {
    expect(parseDuration('4h')).toBe(14_400_000)
  })

  it('parses minutes: "30m" → 1800000ms', () => {
    expect(parseDuration('30m')).toBe(1_800_000)
  })

  it('parses days: "2d" → 172800000ms', () => {
    expect(parseDuration('2d')).toBe(172_800_000)
  })

  it('parses seconds: "15s" → 15000ms', () => {
    expect(parseDuration('15s')).toBe(15_000)
  })

  it('throws on invalid format (missing unit)', () => {
    expect(() => parseDuration('100')).toThrow('Invalid duration format')
  })

  it('throws on invalid format (unknown unit)', () => {
    expect(() => parseDuration('5w')).toThrow('Invalid duration format')
  })

  it('throws on empty string', () => {
    expect(() => parseDuration('')).toThrow('Invalid duration format')
  })

  it('throws on non-numeric value', () => {
    expect(() => parseDuration('abch')).toThrow('Invalid duration format')
  })
})

// ---------------------------------------------------------------------------
// InMemoryGateStorage
// ---------------------------------------------------------------------------

describe('InMemoryGateStorage', () => {
  let storage: InMemoryGateStorage

  beforeEach(() => {
    storage = new InMemoryGateStorage()
  })

  describe('getGateState', () => {
    it('returns null for non-existent gate', async () => {
      const result = await storage.getGateState('issue-1', 'missing-gate')
      expect(result).toBeNull()
    })

    it('returns stored gate state', async () => {
      const state = makeGateState()
      await storage.setGateState('issue-1', 'test-gate', state)
      const result = await storage.getGateState('issue-1', 'test-gate')
      expect(result).toEqual(state)
    })
  })

  describe('setGateState', () => {
    it('stores and retrieves gate state', async () => {
      const state = makeGateState({ gateName: 'my-gate' })
      await storage.setGateState('issue-1', 'my-gate', state)
      const result = await storage.getGateState('issue-1', 'my-gate')
      expect(result).toEqual(state)
    })

    it('overwrites existing gate state', async () => {
      const state1 = makeGateState({ status: 'active' })
      const state2 = makeGateState({ status: 'satisfied', satisfiedAt: Date.now() })
      await storage.setGateState('issue-1', 'test-gate', state1)
      await storage.setGateState('issue-1', 'test-gate', state2)
      const result = await storage.getGateState('issue-1', 'test-gate')
      expect(result?.status).toBe('satisfied')
    })
  })

  describe('getActiveGates', () => {
    it('returns empty array when no gates exist', async () => {
      const result = await storage.getActiveGates('issue-1')
      expect(result).toEqual([])
    })

    it('returns only active gates for the given issue', async () => {
      const active1 = makeGateState({ gateName: 'gate-a', status: 'active' })
      const satisfied = makeGateState({ gateName: 'gate-b', status: 'satisfied' })
      const active2 = makeGateState({ gateName: 'gate-c', status: 'active' })

      await storage.setGateState('issue-1', 'gate-a', active1)
      await storage.setGateState('issue-1', 'gate-b', satisfied)
      await storage.setGateState('issue-1', 'gate-c', active2)

      const result = await storage.getActiveGates('issue-1')
      expect(result).toHaveLength(2)
      expect(result.map(g => g.gateName)).toContain('gate-a')
      expect(result.map(g => g.gateName)).toContain('gate-c')
    })

    it('does not return gates from other issues', async () => {
      const state = makeGateState({ issueId: 'issue-2', gateName: 'gate-a', status: 'active' })
      await storage.setGateState('issue-2', 'gate-a', state)

      const result = await storage.getActiveGates('issue-1')
      expect(result).toEqual([])
    })
  })

  describe('clearGateStates', () => {
    it('clears all gates for an issue', async () => {
      await storage.setGateState('issue-1', 'gate-a', makeGateState({ gateName: 'gate-a' }))
      await storage.setGateState('issue-1', 'gate-b', makeGateState({ gateName: 'gate-b' }))

      await storage.clearGateStates('issue-1')

      expect(await storage.getGateState('issue-1', 'gate-a')).toBeNull()
      expect(await storage.getGateState('issue-1', 'gate-b')).toBeNull()
    })

    it('does not affect other issues', async () => {
      await storage.setGateState('issue-1', 'gate-a', makeGateState({ issueId: 'issue-1', gateName: 'gate-a' }))
      await storage.setGateState('issue-2', 'gate-b', makeGateState({ issueId: 'issue-2', gateName: 'gate-b' }))

      await storage.clearGateStates('issue-1')

      expect(await storage.getGateState('issue-1', 'gate-a')).toBeNull()
      expect(await storage.getGateState('issue-2', 'gate-b')).not.toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------
// activateGate
// ---------------------------------------------------------------------------

describe('activateGate', () => {
  let storage: InMemoryGateStorage

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-06-01T12:00:00Z'))
    storage = new InMemoryGateStorage()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('creates an active gate state', async () => {
    const gateDef = makeGateDefinition()
    const state = await activateGate('issue-1', gateDef, storage)

    expect(state.issueId).toBe('issue-1')
    expect(state.gateName).toBe('test-gate')
    expect(state.gateType).toBe('signal')
    expect(state.status).toBe('active')
    expect(state.activatedAt).toBe(Date.now())
  })

  it('computes timeout deadline from gate definition', async () => {
    const gateDef = makeGateDefinition({
      timeout: { duration: '4h', action: 'escalate' },
    })
    const state = await activateGate('issue-1', gateDef, storage)

    expect(state.timeoutDeadline).toBe(Date.now() + 14_400_000)
    expect(state.timeoutAction).toBe('escalate')
    expect(state.timeoutDuration).toBe('4h')
  })

  it('does not set timeout fields when gate has no timeout', async () => {
    const gateDef = makeGateDefinition()
    const state = await activateGate('issue-1', gateDef, storage)

    expect(state.timeoutDeadline).toBeUndefined()
    expect(state.timeoutAction).toBeUndefined()
    expect(state.timeoutDuration).toBeUndefined()
  })

  it('persists gate state in storage', async () => {
    const gateDef = makeGateDefinition()
    await activateGate('issue-1', gateDef, storage)

    const stored = await storage.getGateState('issue-1', 'test-gate')
    expect(stored).not.toBeNull()
    expect(stored?.status).toBe('active')
  })
})

// ---------------------------------------------------------------------------
// satisfyGate
// ---------------------------------------------------------------------------

describe('satisfyGate', () => {
  let storage: InMemoryGateStorage

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-06-01T12:00:00Z'))
    storage = new InMemoryGateStorage()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('marks an active gate as satisfied with source', async () => {
    await storage.setGateState('issue-1', 'test-gate', makeGateState({ status: 'active' }))

    const result = await satisfyGate('issue-1', 'test-gate', 'comment-123', storage)

    expect(result).not.toBeNull()
    expect(result?.status).toBe('satisfied')
    expect(result?.signalSource).toBe('comment-123')
    expect(result?.satisfiedAt).toBe(Date.now())
  })

  it('returns null for non-existent gate', async () => {
    const result = await satisfyGate('issue-1', 'missing-gate', 'source', storage)
    expect(result).toBeNull()
  })

  it('returns null for non-active gate', async () => {
    await storage.setGateState('issue-1', 'test-gate', makeGateState({ status: 'satisfied' }))

    const result = await satisfyGate('issue-1', 'test-gate', 'source', storage)
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// timeoutGate
// ---------------------------------------------------------------------------

describe('timeoutGate', () => {
  let storage: InMemoryGateStorage

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-06-01T12:00:00Z'))
    storage = new InMemoryGateStorage()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('marks an active gate as timed-out', async () => {
    await storage.setGateState('issue-1', 'test-gate', makeGateState({ status: 'active' }))

    const result = await timeoutGate('issue-1', 'test-gate', storage)

    expect(result).not.toBeNull()
    expect(result?.status).toBe('timed-out')
    expect(result?.timedOutAt).toBe(Date.now())
  })

  it('returns null for non-existent gate', async () => {
    const result = await timeoutGate('issue-1', 'missing-gate', storage)
    expect(result).toBeNull()
  })

  it('returns null for non-active gate', async () => {
    await storage.setGateState('issue-1', 'test-gate', makeGateState({ status: 'timed-out' }))

    const result = await timeoutGate('issue-1', 'test-gate', storage)
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// getActiveGates (functional)
// ---------------------------------------------------------------------------

describe('getActiveGates returns only active gates', () => {
  it('filters by status correctly', async () => {
    const storage = new InMemoryGateStorage()

    await storage.setGateState('issue-1', 'gate-active', makeGateState({ gateName: 'gate-active', status: 'active' }))
    await storage.setGateState('issue-1', 'gate-satisfied', makeGateState({ gateName: 'gate-satisfied', status: 'satisfied' }))
    await storage.setGateState('issue-1', 'gate-timed-out', makeGateState({ gateName: 'gate-timed-out', status: 'timed-out' }))
    await storage.setGateState('issue-1', 'gate-pending', makeGateState({ gateName: 'gate-pending', status: 'pending' }))

    const active = await storage.getActiveGates('issue-1')
    expect(active).toHaveLength(1)
    expect(active[0].gateName).toBe('gate-active')
  })
})
