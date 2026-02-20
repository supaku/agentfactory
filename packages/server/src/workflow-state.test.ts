import { describe, it, expect } from 'vitest'
import { computeStrategy, extractFailureReason, type EscalationStrategy } from './agent-tracking.js'

describe('computeStrategy', () => {
  it('returns normal for cycle 0', () => {
    expect(computeStrategy(0)).toBe('normal')
  })

  it('returns normal for cycle 1', () => {
    expect(computeStrategy(1)).toBe('normal')
  })

  it('returns context-enriched for cycle 2', () => {
    expect(computeStrategy(2)).toBe('context-enriched')
  })

  it('returns decompose for cycle 3', () => {
    expect(computeStrategy(3)).toBe('decompose')
  })

  it('returns escalate-human for cycle 4', () => {
    expect(computeStrategy(4)).toBe('escalate-human')
  })

  it('returns escalate-human for cycle 5+', () => {
    expect(computeStrategy(5)).toBe('escalate-human')
    expect(computeStrategy(10)).toBe('escalate-human')
    expect(computeStrategy(100)).toBe('escalate-human')
  })
})

describe('extractFailureReason', () => {
  it('returns default message for undefined input', () => {
    expect(extractFailureReason(undefined)).toBe('No result message provided')
  })

  it('extracts from ## QA Failed section', () => {
    const msg = `## QA Failed

The build is broken because the new function does not handle null inputs correctly.
Tests in packages/core are failing with TypeError.

<!-- WORK_RESULT:failed -->`

    const result = extractFailureReason(msg)
    expect(result).toContain('build is broken')
    expect(result).toContain('null inputs')
  })

  it('extracts from Failure Reason: pattern', () => {
    const msg = `QA Status: Failed

Failure Reason: The API endpoint returns 500 when called with an empty payload. The validation middleware is not catching the missing required field.`

    const result = extractFailureReason(msg)
    expect(result).toContain('API endpoint returns 500')
  })

  it('extracts from Issues Found pattern', () => {
    const msg = `## QA Report

Issues Found:
1. Missing error handling in the login flow
2. CSS layout broken on mobile viewport
3. Unit test for UserService is failing`

    const result = extractFailureReason(msg)
    expect(result).toContain('Missing error handling')
  })

  it('falls back to last paragraph for unstructured messages', () => {
    const msg = `I looked at the code and ran the tests.

Some things worked but others did not.

The main issue is that the database migration was not applied correctly and the new column is missing from the users table, causing all queries to fail with a column not found error.`

    const result = extractFailureReason(msg)
    expect(result).toContain('database migration')
  })

  it('truncates very long failure reasons', () => {
    const longReason = 'x'.repeat(3000)
    const msg = `## QA Failed\n${longReason}`
    const result = extractFailureReason(msg)
    expect(result.length).toBeLessThanOrEqual(2003) // 2000 + '...'
    expect(result.endsWith('...')).toBe(true)
  })

  it('handles short result messages gracefully', () => {
    const msg = 'Failed'
    const result = extractFailureReason(msg)
    expect(result).toBe('Failed')
  })
})

describe('escalation ladder progression', () => {
  it('follows the correct strategy progression through 5 cycles', () => {
    const expected: EscalationStrategy[] = [
      'normal',           // cycle 0 (first attempt)
      'normal',           // cycle 1
      'context-enriched', // cycle 2
      'decompose',        // cycle 3
      'escalate-human',   // cycle 4
    ]

    for (let cycle = 0; cycle < expected.length; cycle++) {
      expect(computeStrategy(cycle)).toBe(expected[cycle])
    }
  })

  it('never returns a strategy weaker than escalate-human once reached', () => {
    // Once at escalate-human, it stays there
    for (let cycle = 4; cycle <= 20; cycle++) {
      expect(computeStrategy(cycle)).toBe('escalate-human')
    }
  })

  it('strategy always increases or stays at ceiling', () => {
    const strategyOrder: Record<EscalationStrategy, number> = {
      'normal': 0,
      'context-enriched': 1,
      'decompose': 2,
      'escalate-human': 3,
    }

    let previousLevel = -1
    for (let cycle = 0; cycle <= 10; cycle++) {
      const strategy = computeStrategy(cycle)
      const level = strategyOrder[strategy]
      expect(level).toBeGreaterThanOrEqual(previousLevel)
      previousLevel = level
    }
  })
})
