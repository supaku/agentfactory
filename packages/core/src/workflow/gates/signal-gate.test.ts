import { describe, it, expect } from 'vitest'
import {
  evaluateSignalGate,
  isSignalGateTrigger,
  getApplicableSignalGates,
  createImplicitHoldGate,
  createImplicitResumeGate,
  IMPLICIT_HOLD_GATE_NAME,
  IMPLICIT_RESUME_GATE_NAME,
} from './signal-gate.js'
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
// evaluateSignalGate
// ---------------------------------------------------------------------------

describe('evaluateSignalGate', () => {
  it('matches exact comment text (case-insensitive)', () => {
    const gate = makeGateDefinition({ trigger: { source: 'comment', match: 'APPROVE' } })
    const result = evaluateSignalGate(gate, 'approve', false)
    expect(result.matched).toBe(true)
    expect(result.source).toBe('approve')
  })

  it('matches exact comment text (exact case)', () => {
    const gate = makeGateDefinition({ trigger: { source: 'comment', match: 'APPROVE' } })
    const result = evaluateSignalGate(gate, 'APPROVE', false)
    expect(result.matched).toBe(true)
    expect(result.source).toBe('APPROVE')
  })

  it('matches regex pattern', () => {
    const gate = makeGateDefinition({ trigger: { source: 'comment', match: '^LGTM.*$' } })
    const result = evaluateSignalGate(gate, 'LGTM looks good', false)
    expect(result.matched).toBe(true)
    expect(result.source).toBe('LGTM looks good')
  })

  it('handles directive-only mode (first non-empty line)', () => {
    const gate = makeGateDefinition({ trigger: { source: 'directive', match: 'APPROVE' } })
    const result = evaluateSignalGate(gate, 'APPROVE\nsome other text', false)
    expect(result.matched).toBe(true)
    expect(result.source).toBe('APPROVE')
  })

  it('skips bot comments', () => {
    const gate = makeGateDefinition({ trigger: { source: 'comment', match: 'APPROVE' } })
    const result = evaluateSignalGate(gate, 'APPROVE', true)
    expect(result.matched).toBe(false)
  })

  it('handles invalid regex gracefully (falls back to exact match only)', () => {
    const gate = makeGateDefinition({ trigger: { source: 'comment', match: '[invalid(' } })
    const result = evaluateSignalGate(gate, 'something else', false)
    expect(result.matched).toBe(false)
  })

  it('is case-insensitive for regex matching', () => {
    const gate = makeGateDefinition({ trigger: { source: 'comment', match: '^approve$' } })
    const result = evaluateSignalGate(gate, 'APPROVE', false)
    expect(result.matched).toBe(true)
  })

  it('returns not matched for empty comment with directive source', () => {
    const gate = makeGateDefinition({ trigger: { source: 'directive', match: 'APPROVE' } })
    const result = evaluateSignalGate(gate, '', false)
    expect(result.matched).toBe(false)
  })

  it('returns not matched for non-matching comment', () => {
    const gate = makeGateDefinition({ trigger: { source: 'comment', match: 'APPROVE' } })
    const result = evaluateSignalGate(gate, 'I reject this', false)
    expect(result.matched).toBe(false)
  })

  it('returns not matched for invalid trigger configuration', () => {
    const gate = makeGateDefinition({ trigger: { invalid: true } })
    const result = evaluateSignalGate(gate, 'APPROVE', false)
    expect(result.matched).toBe(false)
  })

  it('trims whitespace from comment when source is comment', () => {
    const gate = makeGateDefinition({ trigger: { source: 'comment', match: 'APPROVE' } })
    const result = evaluateSignalGate(gate, '  APPROVE  ', false)
    expect(result.matched).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// isSignalGateTrigger
// ---------------------------------------------------------------------------

describe('isSignalGateTrigger', () => {
  it('returns true for valid signal trigger', () => {
    expect(isSignalGateTrigger({ source: 'comment', match: 'APPROVE' })).toBe(true)
  })

  it('returns true for directive source', () => {
    expect(isSignalGateTrigger({ source: 'directive', match: 'HOLD' })).toBe(true)
  })

  it('returns false for missing source', () => {
    expect(isSignalGateTrigger({ match: 'APPROVE' })).toBe(false)
  })

  it('returns false for invalid source type', () => {
    expect(isSignalGateTrigger({ source: 'webhook', match: 'APPROVE' })).toBe(false)
  })

  it('returns false for missing match', () => {
    expect(isSignalGateTrigger({ source: 'comment' })).toBe(false)
  })

  it('returns false for empty match', () => {
    expect(isSignalGateTrigger({ source: 'comment', match: '' })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getApplicableSignalGates
// ---------------------------------------------------------------------------

describe('getApplicableSignalGates', () => {
  it('filters by type=signal and appliesTo', () => {
    const gates: GateDefinition[] = [
      makeGateDefinition({ name: 'signal-1', type: 'signal', appliesTo: ['development'] }),
      makeGateDefinition({ name: 'timer-1', type: 'timer', appliesTo: ['development'] }),
      makeGateDefinition({ name: 'signal-2', type: 'signal', appliesTo: ['qa'] }),
    ]
    const workflow = makeWorkflow(gates)
    const result = getApplicableSignalGates(workflow, 'development')
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('signal-1')
  })

  it('handles no gates', () => {
    const workflow = makeWorkflow([])
    const result = getApplicableSignalGates(workflow, 'development')
    expect(result).toEqual([])
  })

  it('handles undefined gates', () => {
    const workflow = makeWorkflow()
    delete workflow.gates
    const result = getApplicableSignalGates(workflow, 'development')
    expect(result).toEqual([])
  })

  it('returns gates with no appliesTo (applies to all phases)', () => {
    const gates: GateDefinition[] = [
      makeGateDefinition({ name: 'global-gate', type: 'signal' }),
    ]
    const workflow = makeWorkflow(gates)
    const result = getApplicableSignalGates(workflow, 'any-phase')
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('global-gate')
  })

  it('returns gates with empty appliesTo array (applies to all phases)', () => {
    const gates: GateDefinition[] = [
      makeGateDefinition({ name: 'global-gate', type: 'signal', appliesTo: [] }),
    ]
    const workflow = makeWorkflow(gates)
    const result = getApplicableSignalGates(workflow, 'any-phase')
    expect(result).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// createImplicitHoldGate
// ---------------------------------------------------------------------------

describe('createImplicitHoldGate', () => {
  it('creates a gate matching HOLD directive', () => {
    const gate = createImplicitHoldGate()
    expect(gate.name).toBe(IMPLICIT_HOLD_GATE_NAME)
    expect(gate.type).toBe('signal')

    // Should match "HOLD"
    const result = evaluateSignalGate(gate, 'HOLD', false)
    expect(result.matched).toBe(true)
  })

  it('matches HOLD with reason (HOLD -- reason)', () => {
    const gate = createImplicitHoldGate()
    const result = evaluateSignalGate(gate, 'HOLD -- waiting for design review', false)
    expect(result.matched).toBe(true)
  })

  it('matches HOLD with em-dash', () => {
    const gate = createImplicitHoldGate()
    const result = evaluateSignalGate(gate, 'HOLD \u2014 some reason', false)
    expect(result.matched).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// createImplicitResumeGate
// ---------------------------------------------------------------------------

describe('createImplicitResumeGate', () => {
  it('creates a gate matching RESUME directive', () => {
    const gate = createImplicitResumeGate()
    expect(gate.name).toBe(IMPLICIT_RESUME_GATE_NAME)
    expect(gate.type).toBe('signal')

    const result = evaluateSignalGate(gate, 'RESUME', false)
    expect(result.matched).toBe(true)
  })

  it('matches case-insensitively', () => {
    const gate = createImplicitResumeGate()
    const result = evaluateSignalGate(gate, 'resume', false)
    expect(result.matched).toBe(true)
  })

  it('does not match RESUME with extra text', () => {
    const gate = createImplicitResumeGate()
    const result = evaluateSignalGate(gate, 'RESUME now please', false)
    expect(result.matched).toBe(false)
  })
})
