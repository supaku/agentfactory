import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  parseCronField,
  parseCronExpression,
  computeNextCronFireTime,
  evaluateTimerGate,
  getApplicableTimerGates,
} from './timer-gate.js'
import type { GateDefinition, WorkflowDefinition } from '../workflow-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGateDefinition(overrides: Partial<GateDefinition> = {}): GateDefinition {
  return {
    name: 'test-gate',
    type: 'timer',
    trigger: { cron: '0 9 * * *' },
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
// parseCronField
// ---------------------------------------------------------------------------

describe('parseCronField', () => {
  it('parses wildcard (*)', () => {
    const result = parseCronField('*', 0, 5)
    expect(result).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('parses exact value', () => {
    const result = parseCronField('5', 0, 59)
    expect(result).toEqual([5])
  })

  it('parses range (1-5)', () => {
    const result = parseCronField('1-5', 0, 59)
    expect(result).toEqual([1, 2, 3, 4, 5])
  })

  it('parses step value (*/15)', () => {
    const result = parseCronField('*/15', 0, 59)
    expect(result).toEqual([0, 15, 30, 45])
  })

  it('parses step within range (1-30/5)', () => {
    const result = parseCronField('1-30/5', 0, 59)
    expect(result).toEqual([1, 6, 11, 16, 21, 26])
  })

  it('parses list (1,3,5)', () => {
    const result = parseCronField('1,3,5', 0, 59)
    expect(result).toEqual([1, 3, 5])
  })

  it('throws for out-of-bounds value', () => {
    expect(() => parseCronField('60', 0, 59)).toThrow('out of bounds')
  })

  it('throws for out-of-bounds range', () => {
    expect(() => parseCronField('0-60', 0, 59)).toThrow('out of bounds')
  })

  it('throws for invalid value', () => {
    expect(() => parseCronField('abc', 0, 59)).toThrow('Invalid cron value')
  })

  it('throws for empty segment in list', () => {
    expect(() => parseCronField('1,,3', 0, 59)).toThrow('empty segment')
  })

  it('throws for multiple slashes', () => {
    expect(() => parseCronField('*/5/2', 0, 59)).toThrow("multiple '/'")
  })
})

// ---------------------------------------------------------------------------
// parseCronExpression
// ---------------------------------------------------------------------------

describe('parseCronExpression', () => {
  it('parses valid 5-field cron expression', () => {
    const result = parseCronExpression('0 9 * * *')
    expect(result.minutes).toEqual([0])
    expect(result.hours).toEqual([9])
    expect(result.daysOfMonth).toHaveLength(31)
    expect(result.months).toHaveLength(12)
    expect(result.daysOfWeek).toHaveLength(7)
  })

  it('throws for invalid field count (3 fields)', () => {
    expect(() => parseCronExpression('0 9 *')).toThrow('expected 5 fields')
  })

  it('throws for invalid field count (6 fields)', () => {
    expect(() => parseCronExpression('0 9 * * * *')).toThrow('expected 5 fields')
  })

  it('normalizes day-of-week 7 to 0 (Sunday)', () => {
    const result = parseCronExpression('0 0 * * 7')
    expect(result.daysOfWeek).toContain(0)
    expect(result.daysOfWeek).not.toContain(7)
  })

  it('deduplicates when both 0 and 7 are present', () => {
    const result = parseCronExpression('0 0 * * 0,7')
    expect(result.daysOfWeek).toEqual([0])
  })
})

// ---------------------------------------------------------------------------
// computeNextCronFireTime
// ---------------------------------------------------------------------------

describe('computeNextCronFireTime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('computes next fire time for "0 9 * * *" (daily at 9am)', () => {
    // Set time to June 1, 2025, 08:00 UTC
    const baseTime = new Date('2025-06-01T08:00:00Z').getTime()
    const nextFire = computeNextCronFireTime('0 9 * * *', baseTime)
    const fireDate = new Date(nextFire)

    // Should fire at 9:00 on the same day (local time)
    expect(fireDate.getHours()).toBe(9)
    expect(fireDate.getMinutes()).toBe(0)
  })

  it('computes next fire time for weekday-only "0 9 * * 1-5"', () => {
    // June 1, 2025 is a Sunday (day 0)
    // Set to Sunday 10:00 — next weekday 9:00 should be Monday
    const sunday = new Date(2025, 5, 1, 10, 0, 0, 0) // June 1, 2025, Sunday
    vi.setSystemTime(sunday)
    const nextFire = computeNextCronFireTime('0 9 * * 1-5', sunday.getTime())
    const fireDate = new Date(nextFire)

    // Next valid fire should be Monday (day 1) at 9:00
    expect(fireDate.getDay()).toBeGreaterThanOrEqual(1)
    expect(fireDate.getDay()).toBeLessThanOrEqual(5)
    expect(fireDate.getHours()).toBe(9)
    expect(fireDate.getMinutes()).toBe(0)
  })

  it('computes next fire time for "*/15 * * * *" (every 15 minutes)', () => {
    const baseTime = new Date(2025, 5, 1, 10, 3, 0, 0).getTime() // 10:03
    const nextFire = computeNextCronFireTime('*/15 * * * *', baseTime)
    const fireDate = new Date(nextFire)

    // Next 15-minute mark after 10:03 should be 10:15
    expect(fireDate.getMinutes()).toBe(15)
    expect(fireDate.getHours()).toBe(10)
  })

  it('returns a time strictly after the given timestamp', () => {
    const baseTime = new Date(2025, 5, 1, 9, 0, 0, 0).getTime() // exactly 9:00
    const nextFire = computeNextCronFireTime('0 9 * * *', baseTime)

    expect(nextFire).toBeGreaterThan(baseTime)
  })
})

// ---------------------------------------------------------------------------
// evaluateTimerGate
// ---------------------------------------------------------------------------

describe('evaluateTimerGate', () => {
  it('fires when the current time matches the cron schedule', () => {
    // Set now to 9:00, and use a cron that fires at 9:00 every day
    const now = new Date(2025, 5, 1, 9, 0, 30, 0).getTime() // 9:00:30
    const gate = makeGateDefinition({ trigger: { cron: '0 9 * * *' } })
    const result = evaluateTimerGate(gate, now)
    expect(result.fired).toBe(true)
  })

  it('does not fire before the scheduled time', () => {
    const now = new Date(2025, 5, 1, 8, 30, 0, 0).getTime() // 8:30
    const gate = makeGateDefinition({ trigger: { cron: '0 9 * * *' } })
    const result = evaluateTimerGate(gate, now)
    expect(result.fired).toBe(false)
  })

  it('throws for non-timer gate', () => {
    const gate = makeGateDefinition({ type: 'signal' })
    expect(() => evaluateTimerGate(gate)).toThrow('non-timer gate')
  })

  it('throws for timer gate with missing cron field', () => {
    const gate = makeGateDefinition({ trigger: {} })
    expect(() => evaluateTimerGate(gate)).toThrow('missing or empty "cron" field')
  })

  it('returns a nextFireTime property', () => {
    const now = new Date(2025, 5, 1, 8, 30, 0, 0).getTime()
    const gate = makeGateDefinition({ trigger: { cron: '0 9 * * *' } })
    const result = evaluateTimerGate(gate, now)
    expect(result.nextFireTime).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// getApplicableTimerGates
// ---------------------------------------------------------------------------

describe('getApplicableTimerGates', () => {
  it('filters by type=timer and appliesTo', () => {
    const gates: GateDefinition[] = [
      makeGateDefinition({ name: 'timer-1', type: 'timer', appliesTo: ['development'] }),
      makeGateDefinition({ name: 'signal-1', type: 'signal', appliesTo: ['development'] }),
      makeGateDefinition({ name: 'timer-2', type: 'timer', appliesTo: ['qa'] }),
    ]
    const workflow = makeWorkflow(gates)
    const result = getApplicableTimerGates(workflow, 'development')
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('timer-1')
  })

  it('returns gates with no appliesTo restriction', () => {
    const gates: GateDefinition[] = [
      makeGateDefinition({ name: 'global-timer', type: 'timer' }),
    ]
    const workflow = makeWorkflow(gates)
    const result = getApplicableTimerGates(workflow, 'any-phase')
    expect(result).toHaveLength(1)
  })

  it('returns empty array when no gates defined', () => {
    const workflow = makeWorkflow()
    delete workflow.gates
    const result = getApplicableTimerGates(workflow, 'development')
    expect(result).toEqual([])
  })

  it('returns empty array when no timer gates match phase', () => {
    const gates: GateDefinition[] = [
      makeGateDefinition({ name: 'timer-qa', type: 'timer', appliesTo: ['qa'] }),
    ]
    const workflow = makeWorkflow(gates)
    const result = getApplicableTimerGates(workflow, 'development')
    expect(result).toEqual([])
  })
})
