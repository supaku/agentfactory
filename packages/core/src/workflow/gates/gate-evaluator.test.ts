import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  evaluateGatesForPhase,
  activateGatesForPhase,
  clearGatesForIssue,
  getApplicableGates,
} from './gate-evaluator.js'
import { InMemoryGateStorage } from '../gate-state.js'
import type { GateDefinition, WorkflowDefinition } from '../workflow-types.js'

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

function makeWorkflow(gates: GateDefinition[] = []): WorkflowDefinition {
  return {
    apiVersion: 'v1.1',
    kind: 'WorkflowDefinition',
    metadata: { name: 'test-workflow' },
    phases: [{ name: 'development', template: 'dev' }],
    transitions: [{ from: 'Backlog', to: 'development' }],
    gates,
  }
}

// ---------------------------------------------------------------------------
// evaluateGatesForPhase
// ---------------------------------------------------------------------------

describe('evaluateGatesForPhase', () => {
  let storage: InMemoryGateStorage

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-06-01T12:00:00Z'))
    storage = new InMemoryGateStorage()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns all satisfied when no gates apply', async () => {
    const workflow = makeWorkflow([])
    const result = await evaluateGatesForPhase({
      issueId: 'issue-1',
      phase: 'development',
      workflow,
      storage,
    })

    expect(result.allSatisfied).toBe(true)
    expect(result.activeGates).toEqual([])
    expect(result.newlySatisfied).toEqual([])
    expect(result.timeoutResolutions).toEqual([])
    expect(result.reason).toContain('No gates apply')
  })

  it('satisfies active signal gate when a matching comment is provided', async () => {
    const gate = makeGateDefinition({
      name: 'approval',
      type: 'signal',
      trigger: { source: 'comment', match: 'APPROVE' },
      appliesTo: ['development'],
    })
    const workflow = makeWorkflow([gate])

    // Activate the gate first
    await activateGatesForPhase('issue-1', 'development', workflow, storage)

    // Evaluate with a matching comment
    const result = await evaluateGatesForPhase({
      issueId: 'issue-1',
      phase: 'development',
      workflow,
      storage,
      comments: [{ text: 'APPROVE', isBot: false }],
    })

    expect(result.allSatisfied).toBe(true)
    expect(result.newlySatisfied).toHaveLength(1)
    expect(result.newlySatisfied[0].gateName).toBe('approval')
  })

  it('timer gate fires at correct time', async () => {
    const gate = makeGateDefinition({
      name: 'scheduled',
      type: 'timer',
      trigger: { cron: '0 12 * * *' }, // fires at 12:00
      appliesTo: ['development'],
    })
    const workflow = makeWorkflow([gate])

    // Activate the gate
    await activateGatesForPhase('issue-1', 'development', workflow, storage)

    // Evaluate at 12:00:30 (should fire since current minute matches)
    const now = new Date(2025, 5, 1, 12, 0, 30, 0).getTime()
    const result = await evaluateGatesForPhase({
      issueId: 'issue-1',
      phase: 'development',
      workflow,
      storage,
      now,
    })

    expect(result.allSatisfied).toBe(true)
    expect(result.newlySatisfied).toHaveLength(1)
    expect(result.newlySatisfied[0].gateName).toBe('scheduled')
  })

  it('unsatisfied gates block (allSatisfied is false)', async () => {
    const gate = makeGateDefinition({
      name: 'approval',
      type: 'signal',
      trigger: { source: 'comment', match: 'APPROVE' },
      appliesTo: ['development'],
    })
    const workflow = makeWorkflow([gate])

    // Activate the gate
    await activateGatesForPhase('issue-1', 'development', workflow, storage)

    // Evaluate without matching comments
    const result = await evaluateGatesForPhase({
      issueId: 'issue-1',
      phase: 'development',
      workflow,
      storage,
      comments: [{ text: 'not a match', isBot: false }],
    })

    expect(result.allSatisfied).toBe(false)
    expect(result.activeGates).toHaveLength(1)
    expect(result.activeGates[0].gateName).toBe('approval')
    expect(result.reason).toContain('Unsatisfied gates')
  })

  it('processes timeouts for active gates', async () => {
    const gate = makeGateDefinition({
      name: 'timed-gate',
      type: 'signal',
      trigger: { source: 'comment', match: 'APPROVE' },
      timeout: { duration: '1h', action: 'fail' },
      appliesTo: ['development'],
    })
    const workflow = makeWorkflow([gate])

    // Activate the gate
    await activateGatesForPhase('issue-1', 'development', workflow, storage)

    // Advance time past the timeout
    vi.advanceTimersByTime(2 * 60 * 60 * 1000) // 2 hours

    const result = await evaluateGatesForPhase({
      issueId: 'issue-1',
      phase: 'development',
      workflow,
      storage,
    })

    expect(result.timeoutResolutions).toHaveLength(1)
    expect(result.timeoutResolutions[0].type).toBe('fail')
    expect(result.timeoutResolutions[0].gateName).toBe('timed-gate')
  })
})

// ---------------------------------------------------------------------------
// activateGatesForPhase
// ---------------------------------------------------------------------------

describe('activateGatesForPhase', () => {
  let storage: InMemoryGateStorage

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-06-01T12:00:00Z'))
    storage = new InMemoryGateStorage()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('activates applicable gates', async () => {
    const gates: GateDefinition[] = [
      makeGateDefinition({ name: 'gate-1', type: 'signal', appliesTo: ['development'] }),
      makeGateDefinition({ name: 'gate-2', type: 'timer', trigger: { cron: '0 9 * * *' }, appliesTo: ['development'] }),
    ]
    const workflow = makeWorkflow(gates)

    const activated = await activateGatesForPhase('issue-1', 'development', workflow, storage)
    expect(activated).toHaveLength(2)
    expect(activated.map(g => g.gateName)).toContain('gate-1')
    expect(activated.map(g => g.gateName)).toContain('gate-2')
  })

  it('skips already-activated gates', async () => {
    const gate = makeGateDefinition({ name: 'gate-1', type: 'signal', appliesTo: ['development'] })
    const workflow = makeWorkflow([gate])

    // Activate once
    const first = await activateGatesForPhase('issue-1', 'development', workflow, storage)
    expect(first).toHaveLength(1)

    // Activate again — should skip
    const second = await activateGatesForPhase('issue-1', 'development', workflow, storage)
    expect(second).toHaveLength(0)
  })

  it('returns empty array when no gates apply', async () => {
    const workflow = makeWorkflow([])
    const activated = await activateGatesForPhase('issue-1', 'development', workflow, storage)
    expect(activated).toEqual([])
  })

  it('does not activate gates for other phases', async () => {
    const gate = makeGateDefinition({ name: 'qa-gate', type: 'signal', appliesTo: ['qa'] })
    const workflow = makeWorkflow([gate])

    const activated = await activateGatesForPhase('issue-1', 'development', workflow, storage)
    expect(activated).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// clearGatesForIssue
// ---------------------------------------------------------------------------

describe('clearGatesForIssue', () => {
  it('delegates to storage.clearGateStates', async () => {
    const storage = new InMemoryGateStorage()

    // Add some gates
    await storage.setGateState('issue-1', 'gate-a', {
      issueId: 'issue-1',
      gateName: 'gate-a',
      gateType: 'signal',
      status: 'active',
      activatedAt: Date.now(),
    })

    await clearGatesForIssue('issue-1', storage)

    const result = await storage.getGateState('issue-1', 'gate-a')
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// getApplicableGates
// ---------------------------------------------------------------------------

describe('getApplicableGates', () => {
  it('aggregates gates across all types', () => {
    const gates: GateDefinition[] = [
      makeGateDefinition({ name: 'signal-1', type: 'signal', appliesTo: ['development'] }),
      makeGateDefinition({ name: 'timer-1', type: 'timer', trigger: { cron: '0 9 * * *' }, appliesTo: ['development'] }),
      makeGateDefinition({ name: 'webhook-1', type: 'webhook', trigger: { endpoint: '/api' }, appliesTo: ['development'] }),
    ]
    const workflow = makeWorkflow(gates)

    const result = getApplicableGates(workflow, 'development')
    expect(result).toHaveLength(3)
    expect(result.map(g => g.name)).toContain('signal-1')
    expect(result.map(g => g.name)).toContain('timer-1')
    expect(result.map(g => g.name)).toContain('webhook-1')
  })

  it('returns empty array when no gates match phase', () => {
    const gates: GateDefinition[] = [
      makeGateDefinition({ name: 'qa-gate', type: 'signal', appliesTo: ['qa'] }),
    ]
    const workflow = makeWorkflow(gates)

    const result = getApplicableGates(workflow, 'development')
    expect(result).toEqual([])
  })

  it('returns empty array when workflow has no gates', () => {
    const workflow = makeWorkflow()
    delete workflow.gates
    const result = getApplicableGates(workflow, 'development')
    expect(result).toEqual([])
  })
})
