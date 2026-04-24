import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  captureQualityBaseline,
  computeQualityDelta,
  formatQualityReport,
  parseVitestJson,
  parseTestTextOutput,
  countTypescriptErrors,
  loadBaseline,
  saveBaseline,
  type QualityBaseline,
} from './quality-baseline.js'

// Mock child_process and fs
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}))

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
}))

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const mockExecSync = vi.mocked(execSync)
const mockReadFileSync = vi.mocked(readFileSync)
const mockWriteFileSync = vi.mocked(writeFileSync)
const mockExistsSync = vi.mocked(existsSync)

beforeEach(() => {
  vi.resetAllMocks()
})

// ---------------------------------------------------------------------------
// captureQualityBaseline
// ---------------------------------------------------------------------------

describe('captureQualityBaseline', () => {
  it('captures test counts from vitest JSON output', () => {
    // git rev-parse HEAD
    mockExecSync.mockReturnValueOnce('abc123\n')
    // test command with --reporter=json
    mockExecSync.mockReturnValueOnce(JSON.stringify({
      numTotalTests: 100,
      numPassedTests: 98,
      numFailedTests: 2,
    }))
    // typecheck command
    mockExecSync.mockReturnValueOnce('')
    // no lint command configured → skipped

    const baseline = captureQualityBaseline('/work', {
      testCommand: 'pnpm test',
      validateCommand: 'pnpm typecheck',
    })

    expect(baseline.commitSha).toBe('abc123')
    expect(baseline.tests.total).toBe(100)
    expect(baseline.tests.passed).toBe(98)
    expect(baseline.tests.failed).toBe(2)
    expect(baseline.typecheck.errorCount).toBe(0)
    expect(baseline.typecheck.exitCode).toBe(0)
  })

  it('falls back to text parsing when JSON reporter fails', () => {
    // git rev-parse HEAD
    mockExecSync.mockReturnValueOnce('abc123\n')
    // JSON reporter fails
    mockExecSync.mockImplementationOnce(() => { throw new Error('json reporter not found') })
    // text output fallback
    mockExecSync.mockReturnValueOnce('Tests  42 passed | 3 failed | 45 total')
    // typecheck
    mockExecSync.mockReturnValueOnce('')

    const baseline = captureQualityBaseline('/work', {})

    expect(baseline.tests.total).toBe(45)
    expect(baseline.tests.passed).toBe(42)
    expect(baseline.tests.failed).toBe(3)
  })

  it('captures typecheck errors from stderr', () => {
    // git rev-parse HEAD
    mockExecSync.mockReturnValueOnce('abc123\n')
    // test JSON reporter
    mockExecSync.mockReturnValueOnce(JSON.stringify({ numTotalTests: 10, numPassedTests: 10, numFailedTests: 0 }))
    // typecheck fails
    const tscError = new Error('tsc failed') as Error & { stdout: string; stderr: string; status: number }
    tscError.stdout = ''
    tscError.stderr = 'src/a.ts(1,1): error TS2304: Cannot find name\nsrc/b.ts(5,3): error TS2345: Argument of type'
    tscError.status = 2
    mockExecSync.mockImplementationOnce(() => { throw tscError })

    const baseline = captureQualityBaseline('/work', {})

    expect(baseline.typecheck.errorCount).toBe(2)
    expect(baseline.typecheck.exitCode).toBe(2)
  })

  it('handles complete test failure gracefully', () => {
    // git rev-parse HEAD
    mockExecSync.mockReturnValueOnce('abc123\n')
    // JSON reporter fails
    mockExecSync.mockImplementationOnce(() => { throw new Error('crash') })
    // text fallback also fails
    mockExecSync.mockImplementationOnce(() => { throw new Error('crash') })
    // typecheck passes
    mockExecSync.mockReturnValueOnce('')

    const baseline = captureQualityBaseline('/work', {})

    // Should record at least 1 failure, not throw
    expect(baseline.tests.failed).toBeGreaterThanOrEqual(1)
    // And flag the output as unparseable so downstream consumers (quality
    // ratchet in particular) can tell "we don't know" from "zero tests".
    expect(baseline.tests.parseError).toBeTruthy()
  })

  it('sets parseError when command succeeds but output format is unrecognised', () => {
    // git rev-parse HEAD
    mockExecSync.mockReturnValueOnce('abc123\n')
    // JSON reporter returns something that isn't valid vitest JSON
    mockExecSync.mockReturnValueOnce('not-json-output')
    // text fallback also returns output the text parser can't make sense of
    mockExecSync.mockReturnValueOnce('Some other tool\nFinished successfully.\n')
    // typecheck
    mockExecSync.mockReturnValueOnce('')

    const baseline = captureQualityBaseline('/work', {})

    // The critical invariant: a `total: 0` must never masquerade as a
    // real measurement. REN-1253 follow-up: silent fallback to 0 was
    // failing the merge queue's ratchet check on every PR.
    expect(baseline.tests.parseError).toBeTruthy()
    expect(baseline.tests.total).toBe(0)
    expect(baseline.tests.parseError).toMatch(/parser/i)
  })

  it('does not set parseError when the JSON reporter parses cleanly', () => {
    mockExecSync.mockReturnValueOnce('abc123\n')
    mockExecSync.mockReturnValueOnce(JSON.stringify({ numTotalTests: 42, numPassedTests: 42, numFailedTests: 0 }))
    mockExecSync.mockReturnValueOnce('')

    const baseline = captureQualityBaseline('/work', {})

    expect(baseline.tests.parseError).toBeUndefined()
    expect(baseline.tests.total).toBe(42)
  })

  it('does not set parseError when the text parser recognises the summary', () => {
    mockExecSync.mockReturnValueOnce('abc123\n')
    mockExecSync.mockImplementationOnce(() => { throw new Error('json reporter unavailable') })
    mockExecSync.mockReturnValueOnce('Tests  1309 passed | 0 failed | 1309 total')
    mockExecSync.mockReturnValueOnce('')

    const baseline = captureQualityBaseline('/work', {})

    expect(baseline.tests.parseError).toBeUndefined()
    expect(baseline.tests.total).toBe(1309)
  })

  it('redirects stderr into the captured output (2>&1)', () => {
    // Production regression: vitest 4+ writes its summary to stderr, and
    // execSync's default return captures stdout only. Without 2>&1, the
    // text parser sees an empty string on success and falls back to
    // `total: 0`, failing the ratchet check.
    mockExecSync.mockReturnValueOnce('abc123\n')
    mockExecSync.mockReturnValueOnce('{"numTotalTests":5,"numPassedTests":5,"numFailedTests":0}')
    mockExecSync.mockReturnValueOnce('')

    captureQualityBaseline('/work', { testCommand: 'pnpm test' })

    // The JSON test command call is the 2nd execSync call (git rev-parse is first).
    const testCall = mockExecSync.mock.calls[1]
    expect(testCall[0]).toContain('2>&1')
  })

  it('passes --reporter=json without the `--` delimiter (pnpm 10 compat)', () => {
    // REN-1262 regression: under pnpm 10, `--` is no longer stripped from
    // forwarded args, so `pnpm test -- --reporter=json` delivers the
    // literal `--` to vitest, which treats `-- --reporter=json` as a
    // positional filter and exits with "No test files found". Must use
    // `pnpm test --reporter=json` (no `--`) so the flag reaches vitest.
    mockExecSync.mockReturnValueOnce('abc123\n')
    mockExecSync.mockReturnValueOnce('{"numTotalTests":5,"numPassedTests":5,"numFailedTests":0}')
    mockExecSync.mockReturnValueOnce('')

    captureQualityBaseline('/work', { testCommand: 'pnpm test' })

    const jsonTestCall = mockExecSync.mock.calls[1][0] as string
    expect(jsonTestCall).toContain('--reporter=json')
    expect(jsonTestCall).not.toMatch(/\s--\s+--reporter=json/)
  })

  it('returns unknown commit SHA when git fails', () => {
    mockExecSync.mockImplementationOnce(() => { throw new Error('not a git repo') })
    // JSON reporter
    mockExecSync.mockReturnValueOnce(JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0 }))
    // typecheck
    mockExecSync.mockReturnValueOnce('')

    const baseline = captureQualityBaseline('/work', {})

    expect(baseline.commitSha).toBe('unknown')
  })

  it('captures lint metrics when lintCommand is provided', () => {
    mockExecSync.mockReturnValueOnce('abc123\n')
    mockExecSync.mockReturnValueOnce(JSON.stringify({ numTotalTests: 5, numPassedTests: 5, numFailedTests: 0 }))
    mockExecSync.mockReturnValueOnce('')
    // lint command output
    mockExecSync.mockReturnValueOnce('\n✖ 10 problems (6 errors, 4 warnings)\n')

    const baseline = captureQualityBaseline('/work', {
      lintCommand: 'pnpm lint',
    })

    expect(baseline.lint.errorCount).toBe(6)
    expect(baseline.lint.warningCount).toBe(4)
  })

  it('returns zero lint counts when no lintCommand is configured', () => {
    mockExecSync.mockReturnValueOnce('abc123\n')
    mockExecSync.mockReturnValueOnce(JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0 }))
    mockExecSync.mockReturnValueOnce('')

    const baseline = captureQualityBaseline('/work', {})

    expect(baseline.lint.errorCount).toBe(0)
    expect(baseline.lint.warningCount).toBe(0)
  })

  it('returns errorCount=1 when typecheck exits non-zero but has no parseable errors', () => {
    mockExecSync.mockReturnValueOnce('abc123\n')
    mockExecSync.mockReturnValueOnce(JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0 }))
    const tscError = new Error('tsc failed') as Error & { stdout: string; stderr: string; status: number }
    tscError.stdout = ''
    tscError.stderr = 'Some unparseable error output'
    tscError.status = 1
    mockExecSync.mockImplementationOnce(() => { throw tscError })

    const baseline = captureQualityBaseline('/work', {})

    expect(baseline.typecheck.errorCount).toBe(1)
    expect(baseline.typecheck.exitCode).toBe(1)
  })

  it('uses custom packageManager for default commands', () => {
    mockExecSync.mockReturnValueOnce('abc123\n')
    // JSON reporter with npm
    mockExecSync.mockReturnValueOnce(JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0 }))
    // typecheck
    mockExecSync.mockReturnValueOnce('')

    captureQualityBaseline('/work', { packageManager: 'npm' })

    // First call after git rev-parse should use npm for test command
    const testCall = mockExecSync.mock.calls[1]
    expect(testCall[0]).toContain('npm test')
  })

  it('captures lint errors from failing lint command', () => {
    mockExecSync.mockReturnValueOnce('abc123\n')
    mockExecSync.mockReturnValueOnce(JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0 }))
    mockExecSync.mockReturnValueOnce('')
    // lint command fails
    const lintError = new Error('lint failed') as Error & { stdout: string; stderr: string }
    lintError.stdout = '\n✖ 3 problems (3 errors, 0 warnings)\n'
    lintError.stderr = ''
    mockExecSync.mockImplementationOnce(() => { throw lintError })

    const baseline = captureQualityBaseline('/work', { lintCommand: 'pnpm lint' })

    expect(baseline.lint.errorCount).toBe(3)
    expect(baseline.lint.warningCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// computeQualityDelta
// ---------------------------------------------------------------------------

describe('computeQualityDelta', () => {
  const makeBaseline = (overrides?: Partial<QualityBaseline>): QualityBaseline => ({
    timestamp: '2026-01-01T00:00:00Z',
    commitSha: 'base',
    tests: { total: 100, passed: 95, failed: 5, skipped: 0 },
    typecheck: { errorCount: 3, exitCode: 0 },
    lint: { errorCount: 2, warningCount: 10 },
    ...overrides,
  })

  it('passes when agent improves all metrics', () => {
    const baseline = makeBaseline()
    const current = makeBaseline({
      tests: { total: 105, passed: 102, failed: 3, skipped: 0 },
      typecheck: { errorCount: 1, exitCode: 0 },
      lint: { errorCount: 0, warningCount: 5 },
    })

    const delta = computeQualityDelta(baseline, current)

    expect(delta.passed).toBe(true)
    expect(delta.testFailuresDelta).toBe(-2)
    expect(delta.typeErrorsDelta).toBe(-2)
    expect(delta.lintErrorsDelta).toBe(-2)
    expect(delta.testCountDelta).toBe(5)
  })

  it('fails when agent introduces new test failures', () => {
    const baseline = makeBaseline()
    const current = makeBaseline({
      tests: { total: 100, passed: 92, failed: 8, skipped: 0 },
    })

    const delta = computeQualityDelta(baseline, current)

    expect(delta.passed).toBe(false)
    expect(delta.testFailuresDelta).toBe(3)
  })

  it('fails when agent introduces new typecheck errors', () => {
    const baseline = makeBaseline()
    const current = makeBaseline({
      typecheck: { errorCount: 5, exitCode: 1 },
    })

    const delta = computeQualityDelta(baseline, current)

    expect(delta.passed).toBe(false)
    expect(delta.typeErrorsDelta).toBe(2)
  })

  it('fails when agent introduces new lint errors', () => {
    const baseline = makeBaseline()
    const current = makeBaseline({
      lint: { errorCount: 4, warningCount: 10 },
    })

    const delta = computeQualityDelta(baseline, current)

    expect(delta.passed).toBe(false)
    expect(delta.lintErrorsDelta).toBe(2)
  })

  it('passes when baseline and current are identical', () => {
    const baseline = makeBaseline()
    const current = makeBaseline()

    const delta = computeQualityDelta(baseline, current)

    expect(delta.passed).toBe(true)
    expect(delta.testFailuresDelta).toBe(0)
    expect(delta.typeErrorsDelta).toBe(0)
    expect(delta.lintErrorsDelta).toBe(0)
    expect(delta.testCountDelta).toBe(0)
  })

  it('tracks test removal as negative testCountDelta', () => {
    const baseline = makeBaseline()
    const current = makeBaseline({
      tests: { total: 90, passed: 90, failed: 0, skipped: 0 },
    })

    const delta = computeQualityDelta(baseline, current)

    expect(delta.passed).toBe(true) // fewer failures is good
    expect(delta.testCountDelta).toBe(-10) // but removing tests is a warning
  })
})

// ---------------------------------------------------------------------------
// formatQualityReport
// ---------------------------------------------------------------------------

describe('formatQualityReport', () => {
  const makeBaseline = (): QualityBaseline => ({
    timestamp: '2026-01-01T00:00:00Z',
    commitSha: 'base',
    tests: { total: 100, passed: 95, failed: 5, skipped: 0 },
    typecheck: { errorCount: 3, exitCode: 0 },
    lint: { errorCount: 2, warningCount: 10 },
  })

  it('formats a passing report', () => {
    const baseline = makeBaseline()
    const current = { ...makeBaseline(), tests: { total: 100, passed: 98, failed: 2, skipped: 0 } }
    const delta = computeQualityDelta(baseline, current)

    const report = formatQualityReport(baseline, current, delta)

    expect(report).toContain('**PASSED**')
    expect(report).toContain('Test failures')
    expect(report).toContain('Typecheck errors')
  })

  it('formats a failing report', () => {
    const baseline = makeBaseline()
    const current = { ...makeBaseline(), tests: { total: 100, passed: 90, failed: 10, skipped: 0 } }
    const delta = computeQualityDelta(baseline, current)

    const report = formatQualityReport(baseline, current, delta)

    expect(report).toContain('**FAILED**')
    expect(report).toContain('+5')
  })

  it('warns about removed tests', () => {
    const baseline = makeBaseline()
    const current = { ...makeBaseline(), tests: { total: 80, passed: 80, failed: 0, skipped: 0 } }
    const delta = computeQualityDelta(baseline, current)

    const report = formatQualityReport(baseline, current, delta)

    expect(report).toContain('20 test(s) were removed')
  })
})

// ---------------------------------------------------------------------------
// parseVitestJson
// ---------------------------------------------------------------------------

describe('parseVitestJson', () => {
  it('parses standard vitest JSON output', () => {
    const json = JSON.stringify({
      numTotalTests: 50,
      numPassedTests: 48,
      numFailedTests: 2,
    })

    const result = parseVitestJson(json)

    expect(result).toEqual({ total: 50, passed: 48, failed: 2, skipped: 0 })
  })

  it('handles JSON with non-JSON prefix', () => {
    const output = 'Some vitest output\n' + JSON.stringify({
      numTotalTests: 10,
      numPassedTests: 10,
      numFailedTests: 0,
    })

    const result = parseVitestJson(output)

    expect(result?.total).toBe(10)
  })

  it('returns null for non-JSON output', () => {
    expect(parseVitestJson('not json at all')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseVitestJson('')).toBeNull()
  })

  it('parses vitest v2+ format with testResults array', () => {
    const output = JSON.stringify({
      testResults: [
        {
          assertionResults: [
            { status: 'passed' },
            { status: 'passed' },
            { status: 'failed' },
          ],
        },
        {
          assertionResults: [
            { status: 'passed' },
          ],
        },
      ],
    })

    const result = parseVitestJson(output)

    expect(result).toEqual({ total: 4, passed: 3, failed: 1, skipped: 0 })
  })

  it('returns null for JSON without recognized fields', () => {
    const output = JSON.stringify({ unrelated: 'data' })

    expect(parseVitestJson(output)).toBeNull()
  })

  it('computes skipped count correctly', () => {
    const json = JSON.stringify({
      numTotalTests: 20,
      numPassedTests: 15,
      numFailedTests: 2,
    })

    const result = parseVitestJson(json)

    expect(result?.skipped).toBe(3) // 20 - 15 - 2
  })
})

// ---------------------------------------------------------------------------
// parseTestTextOutput
// ---------------------------------------------------------------------------

describe('parseTestTextOutput', () => {
  it('parses clean vitest summary with pipe-separated counts', () => {
    expect(parseTestTextOutput('Tests  42 passed | 2 failed | 44 total')).toEqual({
      total: 44,
      passed: 42,
      failed: 2,
      skipped: 0,
    })
  })

  it('parses vitest summary with parenthesised total', () => {
    expect(parseTestTextOutput('Tests  2817 passed | 1 skipped (2818)')).toEqual({
      total: 2818,
      passed: 2817,
      failed: 0,
      skipped: 1,
    })
  })

  it('parses vitest output with inline ANSI colour escapes (REN-1262)', () => {
    // vitest 4+ emits colour codes even when writing to a non-TTY pipe.
    // Without stripAnsi, `\s+` in the regex can't cross the escapes and
    // the parser returns null → parseError → ratchet silently unenforced.
    const ansiOutput = 'Tests\x1b[22m\x1b[1m\x1b[32m  2836 passed\x1b[39m\x1b[22m\x1b[2m \x1b[22m | \x1b[1m0 failed\x1b[22m \x1b[90m(2836)\x1b[39m'
    expect(parseTestTextOutput(ansiOutput)).toEqual({
      total: 2836,
      passed: 2836,
      failed: 0,
      skipped: 0,
    })
  })

  it('parses vitest output with ANSI colours in the skipped branch too', () => {
    const ansiOutput = '\x1b[32mTests\x1b[39m  \x1b[32m42 passed\x1b[39m | \x1b[33m3 skipped\x1b[39m | 45 total'
    expect(parseTestTextOutput(ansiOutput)).toEqual({
      total: 45,
      passed: 42,
      failed: 0,
      skipped: 3,
    })
  })

  it('parses jest summary', () => {
    expect(parseTestTextOutput('Tests:       2 failed, 42 passed, 44 total')).toEqual({
      total: 44,
      passed: 42,
      failed: 2,
      skipped: 0,
    })
  })

  it('parses jest summary with ANSI escapes', () => {
    const ansiJest = '\x1b[1mTests:\x1b[22m       \x1b[31m2 failed\x1b[39m, \x1b[32m42 passed\x1b[39m, 44 total'
    expect(parseTestTextOutput(ansiJest)).toEqual({
      total: 44,
      passed: 42,
      failed: 2,
      skipped: 0,
    })
  })

  it('returns null for unrelated output', () => {
    expect(parseTestTextOutput('Finished build.')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseTestTextOutput('')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// countTypescriptErrors
// ---------------------------------------------------------------------------

describe('countTypescriptErrors', () => {
  it('counts TypeScript errors in tsc output', () => {
    const output = [
      'src/a.ts(1,1): error TS2304: Cannot find name',
      'src/b.ts(5,3): error TS2345: Argument of type',
      'src/c.ts(10,1): error TS2322: Type is not assignable',
    ].join('\n')

    expect(countTypescriptErrors(output)).toBe(3)
  })

  it('returns 0 for clean output', () => {
    expect(countTypescriptErrors('')).toBe(0)
    expect(countTypescriptErrors('All good')).toBe(0)
  })

  it('handles mixed output with errors and warnings', () => {
    const output = [
      'warning TS6059: File not under rootDir',
      'src/a.ts(1,1): error TS2304: Cannot find name',
      'Found 1 error.',
    ].join('\n')

    expect(countTypescriptErrors(output)).toBe(1) // only counts error TS, not warnings
  })
})

// ---------------------------------------------------------------------------
// Text output parsing (tested via captureQualityBaseline fallback)
// ---------------------------------------------------------------------------

describe('test text output parsing', () => {
  it('parses vitest text with skipped tests', () => {
    mockExecSync.mockReturnValueOnce('abc\n')
    mockExecSync.mockImplementationOnce(() => { throw new Error('no json') })
    mockExecSync.mockReturnValueOnce('Tests  10 passed | 2 failed | 1 skipped | 13 total')
    mockExecSync.mockReturnValueOnce('')

    const baseline = captureQualityBaseline('/work', {})

    expect(baseline.tests.total).toBe(13)
    expect(baseline.tests.passed).toBe(10)
    expect(baseline.tests.failed).toBe(2)
    expect(baseline.tests.skipped).toBe(1)
  })

  it('parses jest text format', () => {
    mockExecSync.mockReturnValueOnce('abc\n')
    mockExecSync.mockImplementationOnce(() => { throw new Error('no json') })
    mockExecSync.mockReturnValueOnce('Tests:       2 failed, 42 passed, 44 total')
    mockExecSync.mockReturnValueOnce('')

    const baseline = captureQualityBaseline('/work', {})

    expect(baseline.tests.total).toBe(44)
    expect(baseline.tests.passed).toBe(42)
    expect(baseline.tests.failed).toBe(2)
  })

  it('parses jest text format with no failures', () => {
    mockExecSync.mockReturnValueOnce('abc\n')
    mockExecSync.mockImplementationOnce(() => { throw new Error('no json') })
    mockExecSync.mockReturnValueOnce('Tests:       42 passed, 42 total')
    mockExecSync.mockReturnValueOnce('')

    const baseline = captureQualityBaseline('/work', {})

    expect(baseline.tests.total).toBe(42)
    expect(baseline.tests.passed).toBe(42)
    expect(baseline.tests.failed).toBe(0)
  })

  it('parses vitest compact format "Tests  42 passed (44)"', () => {
    mockExecSync.mockReturnValueOnce('abc\n')
    mockExecSync.mockImplementationOnce(() => { throw new Error('no json') })
    mockExecSync.mockReturnValueOnce('Tests  42 passed (44)')
    mockExecSync.mockReturnValueOnce('')

    const baseline = captureQualityBaseline('/work', {})

    expect(baseline.tests.total).toBe(44)
    expect(baseline.tests.passed).toBe(42)
  })

  it('parses test counts from error output when command fails', () => {
    mockExecSync.mockReturnValueOnce('abc\n')
    mockExecSync.mockImplementationOnce(() => { throw new Error('no json') })
    const testError = new Error('tests failed') as Error & { stdout: string; stderr: string }
    testError.stdout = 'Tests  8 passed | 2 failed | 10 total'
    testError.stderr = ''
    mockExecSync.mockImplementationOnce(() => { throw testError })
    mockExecSync.mockReturnValueOnce('')

    const baseline = captureQualityBaseline('/work', {})

    expect(baseline.tests.total).toBe(10)
    expect(baseline.tests.failed).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// saveBaseline / loadBaseline
// ---------------------------------------------------------------------------

describe('saveBaseline', () => {
  it('writes baseline JSON to .agent/ directory', () => {
    const baseline: QualityBaseline = {
      timestamp: '2026-01-01T00:00:00Z',
      commitSha: 'abc',
      tests: { total: 10, passed: 10, failed: 0, skipped: 0 },
      typecheck: { errorCount: 0, exitCode: 0 },
      lint: { errorCount: 0, warningCount: 0 },
    }

    saveBaseline('/work', baseline)

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('quality-baseline.json'),
      expect.stringContaining('"commitSha": "abc"'),
    )
  })
})

describe('loadBaseline', () => {
  it('loads baseline from .agent/ directory', () => {
    const baseline: QualityBaseline = {
      timestamp: '2026-01-01T00:00:00Z',
      commitSha: 'abc',
      tests: { total: 10, passed: 10, failed: 0, skipped: 0 },
      typecheck: { errorCount: 0, exitCode: 0 },
      lint: { errorCount: 0, warningCount: 0 },
    }

    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify(baseline))

    const loaded = loadBaseline('/work')

    expect(loaded).toEqual(baseline)
  })

  it('returns null when no baseline exists', () => {
    mockExistsSync.mockReturnValue(false)

    expect(loadBaseline('/work')).toBeNull()
  })

  it('returns null on parse error', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('not json')

    expect(loadBaseline('/work')).toBeNull()
  })
})
