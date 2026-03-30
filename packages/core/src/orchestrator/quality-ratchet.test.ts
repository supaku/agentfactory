import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  loadQualityRatchet,
  checkQualityRatchet,
  updateQualityRatchet,
  initializeQualityRatchet,
  formatRatchetResult,
  type QualityRatchet,
} from './quality-ratchet.js'
import type { QualityBaseline } from './quality-baseline.js'

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
}))

import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const mockReadFileSync = vi.mocked(readFileSync)
const mockWriteFileSync = vi.mocked(writeFileSync)
const mockExistsSync = vi.mocked(existsSync)

beforeEach(() => {
  vi.resetAllMocks()
})

function makeRatchet(overrides?: Partial<QualityRatchet>): QualityRatchet {
  return {
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    updatedBy: 'SUP-100',
    thresholds: {
      testCount: { min: 100 },
      testFailures: { max: 0 },
      typecheckErrors: { max: 5 },
      lintErrors: { max: 10 },
    },
    ...overrides,
  }
}

function makeBaseline(overrides?: Partial<QualityBaseline>): QualityBaseline {
  return {
    timestamp: '2026-03-30T00:00:00Z',
    commitSha: 'abc123',
    tests: { total: 100, passed: 100, failed: 0, skipped: 0 },
    typecheck: { errorCount: 5, exitCode: 0 },
    lint: { errorCount: 10, warningCount: 20 },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// loadQualityRatchet
// ---------------------------------------------------------------------------

describe('loadQualityRatchet', () => {
  it('loads and parses a valid ratchet file', () => {
    const ratchet = makeRatchet()
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify(ratchet))

    const result = loadQualityRatchet('/repo')

    expect(result).toEqual(ratchet)
  })

  it('returns null when file does not exist', () => {
    mockExistsSync.mockReturnValue(false)

    expect(loadQualityRatchet('/repo')).toBeNull()
  })

  it('throws on invalid JSON', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('not json')

    expect(() => loadQualityRatchet('/repo')).toThrow()
  })

  it('throws on missing version', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify({ thresholds: {} }))

    expect(() => loadQualityRatchet('/repo')).toThrow('Invalid quality ratchet')
  })

  it('throws on missing thresholds', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: 1 }))

    expect(() => loadQualityRatchet('/repo')).toThrow('Invalid quality ratchet')
  })
})

// ---------------------------------------------------------------------------
// checkQualityRatchet
// ---------------------------------------------------------------------------

describe('checkQualityRatchet', () => {
  it('passes when all metrics are within thresholds', () => {
    const ratchet = makeRatchet()
    const current = makeBaseline()

    const result = checkQualityRatchet(ratchet, current)

    expect(result.passed).toBe(true)
    expect(result.violations).toHaveLength(0)
  })

  it('fails when test count drops below minimum', () => {
    const ratchet = makeRatchet()
    const current = makeBaseline({ tests: { total: 90, passed: 90, failed: 0, skipped: 0 } })

    const result = checkQualityRatchet(ratchet, current)

    expect(result.passed).toBe(false)
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0].metric).toBe('testCount')
    expect(result.violations[0].direction).toBe('below-min')
  })

  it('fails when test failures exceed maximum', () => {
    const ratchet = makeRatchet()
    const current = makeBaseline({ tests: { total: 100, passed: 97, failed: 3, skipped: 0 } })

    const result = checkQualityRatchet(ratchet, current)

    expect(result.passed).toBe(false)
    expect(result.violations[0].metric).toBe('testFailures')
  })

  it('fails when typecheck errors exceed maximum', () => {
    const ratchet = makeRatchet()
    const current = makeBaseline({ typecheck: { errorCount: 8, exitCode: 1 } })

    const result = checkQualityRatchet(ratchet, current)

    expect(result.passed).toBe(false)
    expect(result.violations[0].metric).toBe('typecheckErrors')
  })

  it('fails when lint errors exceed maximum', () => {
    const ratchet = makeRatchet()
    const current = makeBaseline({ lint: { errorCount: 15, warningCount: 20 } })

    const result = checkQualityRatchet(ratchet, current)

    expect(result.passed).toBe(false)
    expect(result.violations[0].metric).toBe('lintErrors')
  })

  it('reports multiple violations', () => {
    const ratchet = makeRatchet()
    const current = makeBaseline({
      tests: { total: 80, passed: 75, failed: 5, skipped: 0 },
      typecheck: { errorCount: 10, exitCode: 1 },
    })

    const result = checkQualityRatchet(ratchet, current)

    expect(result.passed).toBe(false)
    expect(result.violations.length).toBeGreaterThanOrEqual(3)
  })

  it('passes when metrics exactly equal thresholds (boundary)', () => {
    const ratchet = makeRatchet({
      thresholds: {
        testCount: { min: 100 },
        testFailures: { max: 2 },
        typecheckErrors: { max: 5 },
        lintErrors: { max: 10 },
      },
    })
    const current = makeBaseline({
      tests: { total: 100, passed: 98, failed: 2, skipped: 0 },
      typecheck: { errorCount: 5, exitCode: 0 },
      lint: { errorCount: 10, warningCount: 0 },
    })

    const result = checkQualityRatchet(ratchet, current)

    expect(result.passed).toBe(true)
    expect(result.violations).toHaveLength(0)
  })

  it('fails when metric is one over the max threshold (boundary)', () => {
    const ratchet = makeRatchet({
      thresholds: {
        testCount: { min: 100 },
        testFailures: { max: 0 },
        typecheckErrors: { max: 5 },
        lintErrors: { max: 10 },
      },
    })
    const current = makeBaseline({
      tests: { total: 100, passed: 99, failed: 1, skipped: 0 },
    })

    const result = checkQualityRatchet(ratchet, current)

    expect(result.passed).toBe(false)
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0].metric).toBe('testFailures')
    expect(result.violations[0].actual).toBe(1)
    expect(result.violations[0].threshold).toBe(0)
  })

  it('fails when test count is one below the min threshold (boundary)', () => {
    const ratchet = makeRatchet()
    const current = makeBaseline({
      tests: { total: 99, passed: 99, failed: 0, skipped: 0 },
    })

    const result = checkQualityRatchet(ratchet, current)

    expect(result.passed).toBe(false)
    expect(result.violations[0].metric).toBe('testCount')
    expect(result.violations[0].actual).toBe(99)
  })

  it('passes with zero-threshold ratchet when metrics are zero', () => {
    const ratchet = makeRatchet({
      thresholds: {
        testCount: { min: 0 },
        testFailures: { max: 0 },
        typecheckErrors: { max: 0 },
        lintErrors: { max: 0 },
      },
    })
    const current = makeBaseline({
      tests: { total: 0, passed: 0, failed: 0, skipped: 0 },
      typecheck: { errorCount: 0, exitCode: 0 },
      lint: { errorCount: 0, warningCount: 0 },
    })

    const result = checkQualityRatchet(ratchet, current)

    expect(result.passed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// updateQualityRatchet
// ---------------------------------------------------------------------------

describe('updateQualityRatchet', () => {
  it('tightens thresholds when metrics improve', () => {
    const ratchet = makeRatchet()
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify(ratchet))

    const improved = makeBaseline({
      tests: { total: 110, passed: 110, failed: 0, skipped: 0 },
      typecheck: { errorCount: 2, exitCode: 0 },
      lint: { errorCount: 5, warningCount: 10 },
    })

    const updated = updateQualityRatchet('/repo', improved, 'SUP-200')

    expect(updated).toBe(true)
    expect(mockWriteFileSync).toHaveBeenCalled()

    const written = JSON.parse((mockWriteFileSync.mock.calls[0][1] as string))
    expect(written.thresholds.testCount.min).toBe(110)
    expect(written.thresholds.typecheckErrors.max).toBe(2)
    expect(written.thresholds.lintErrors.max).toBe(5)
    expect(written.updatedBy).toBe('SUP-200')
  })

  it('does not update when metrics are worse or equal', () => {
    const ratchet = makeRatchet()
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify(ratchet))

    const same = makeBaseline()

    const updated = updateQualityRatchet('/repo', same, 'SUP-200')

    expect(updated).toBe(false)
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it('returns false when ratchet file does not exist', () => {
    mockExistsSync.mockReturnValue(false)

    const updated = updateQualityRatchet('/repo', makeBaseline(), 'SUP-200')

    expect(updated).toBe(false)
  })

  it('tightens only the metrics that improved (partial improvement)', () => {
    const ratchet = makeRatchet({
      thresholds: {
        testCount: { min: 100 },
        testFailures: { max: 5 },
        typecheckErrors: { max: 10 },
        lintErrors: { max: 20 },
      },
    })
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify(ratchet))

    // Only typecheck improved, rest is same or worse
    const partial = makeBaseline({
      tests: { total: 100, passed: 95, failed: 5, skipped: 0 },
      typecheck: { errorCount: 3, exitCode: 0 },
      lint: { errorCount: 20, warningCount: 0 },
    })

    const updated = updateQualityRatchet('/repo', partial, 'SUP-300')

    expect(updated).toBe(true)
    const written = JSON.parse((mockWriteFileSync.mock.calls[0][1] as string))
    expect(written.thresholds.testCount.min).toBe(100) // unchanged
    expect(written.thresholds.testFailures.max).toBe(5) // unchanged (equal)
    expect(written.thresholds.typecheckErrors.max).toBe(3) // tightened
    expect(written.thresholds.lintErrors.max).toBe(20) // unchanged (equal)
  })

  it('sets updatedAt to a recent timestamp', () => {
    const ratchet = makeRatchet()
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify(ratchet))

    const improved = makeBaseline({
      tests: { total: 200, passed: 200, failed: 0, skipped: 0 },
    })

    const before = new Date().toISOString()
    updateQualityRatchet('/repo', improved, 'SUP-400')
    const after = new Date().toISOString()

    const written = JSON.parse((mockWriteFileSync.mock.calls[0][1] as string))
    expect(written.updatedAt >= before).toBe(true)
    expect(written.updatedAt <= after).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// initializeQualityRatchet
// ---------------------------------------------------------------------------

describe('initializeQualityRatchet', () => {
  it('creates ratchet file from baseline', () => {
    const baseline = makeBaseline({
      tests: { total: 50, passed: 48, failed: 2, skipped: 0 },
      typecheck: { errorCount: 3, exitCode: 0 },
      lint: { errorCount: 7, warningCount: 15 },
    })

    const ratchet = initializeQualityRatchet('/repo', baseline)

    expect(ratchet.version).toBe(1)
    expect(ratchet.thresholds.testCount.min).toBe(50)
    expect(ratchet.thresholds.testFailures.max).toBe(2)
    expect(ratchet.thresholds.typecheckErrors.max).toBe(3)
    expect(ratchet.thresholds.lintErrors.max).toBe(7)
    expect(mockWriteFileSync).toHaveBeenCalled()
  })

  it('initializes from a zero-metric baseline', () => {
    const baseline = makeBaseline({
      tests: { total: 0, passed: 0, failed: 0, skipped: 0 },
      typecheck: { errorCount: 0, exitCode: 0 },
      lint: { errorCount: 0, warningCount: 0 },
    })

    const ratchet = initializeQualityRatchet('/repo', baseline)

    expect(ratchet.thresholds.testCount.min).toBe(0)
    expect(ratchet.thresholds.testFailures.max).toBe(0)
    expect(ratchet.thresholds.typecheckErrors.max).toBe(0)
    expect(ratchet.thresholds.lintErrors.max).toBe(0)
  })

  it('sets updatedBy to "manual"', () => {
    const ratchet = initializeQualityRatchet('/repo', makeBaseline())

    expect(ratchet.updatedBy).toBe('manual')
  })

  it('writes JSON with trailing newline', () => {
    initializeQualityRatchet('/repo', makeBaseline())

    const written = mockWriteFileSync.mock.calls[0][1] as string
    expect(written.endsWith('\n')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// formatRatchetResult
// ---------------------------------------------------------------------------

describe('formatRatchetResult', () => {
  it('formats a passing result', () => {
    expect(formatRatchetResult({ passed: true, violations: [] })).toContain('passed')
  })

  it('formats a failing result with violations', () => {
    const result = formatRatchetResult({
      passed: false,
      violations: [
        { metric: 'testCount', threshold: 100, actual: 90, direction: 'below-min' },
        { metric: 'typecheckErrors', threshold: 5, actual: 8, direction: 'above-max' },
      ],
    })

    expect(result).toContain('**FAILED**')
    expect(result).toContain('testCount')
    expect(result).toContain('below minimum')
    expect(result).toContain('typecheckErrors')
    expect(result).toContain('exceeds maximum')
  })

  it('formats a single violation', () => {
    const result = formatRatchetResult({
      passed: false,
      violations: [
        { metric: 'lintErrors', threshold: 10, actual: 15, direction: 'above-max' },
      ],
    })

    expect(result).toContain('**FAILED**')
    expect(result).toContain('lintErrors')
    expect(result).toContain('15')
    expect(result).toContain('10')
  })
})
