/**
 * Quality Baseline — Capture & Compare
 *
 * Captures quality metrics (test counts, typecheck errors, lint errors) from a
 * worktree at a point in time. The orchestrator captures a baseline on main
 * before the agent starts, then compares after the agent finishes. If the agent
 * made quality worse (delta > 0 for any failure metric), promotion is blocked.
 *
 * This module is standalone — no orchestrator or template dependencies.
 */

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QualityBaseline {
  timestamp: string
  commitSha: string
  tests: {
    total: number
    passed: number
    failed: number
    skipped: number
    /**
     * Set when both the JSON and text parsers failed to extract a count
     * from the test output. The `total/passed/failed/skipped` fields are
     * unreliable in that case — callers (e.g. quality-ratchet) must not
     * treat a `total: 0` as "no tests" when this field is set.
     *
     * Typical cause: the test runner wrote its summary only to stderr and
     * the runner's output capture missed it, or the runner uses a format
     * the parsers don't recognize.
     */
    parseError?: string
  }
  typecheck: {
    errorCount: number
    exitCode: number
  }
  lint: {
    errorCount: number
    warningCount: number
  }
}

export interface QualityDelta {
  /** Positive = worse (more failures) */
  testFailuresDelta: number
  /** Positive = worse (more errors) */
  typeErrorsDelta: number
  /** Positive = worse (more errors) */
  lintErrorsDelta: number
  /** Negative = tests removed (warning, not a gate failure) */
  testCountDelta: number
  /** True if no metric got worse */
  passed: boolean
}

export interface QualityConfig {
  testCommand?: string
  validateCommand?: string
  lintCommand?: string
  packageManager?: string
  timeoutMs?: number
}

// ---------------------------------------------------------------------------
// Baseline capture
// ---------------------------------------------------------------------------

/**
 * Capture quality metrics from a worktree. Runs test, typecheck, and lint
 * commands, parsing their output for structured counts.
 *
 * Each command is independent — a failure in one does not prevent capturing the others.
 */
export function captureQualityBaseline(
  worktreePath: string,
  config: QualityConfig = {},
): QualityBaseline {
  const pm = config.packageManager ?? 'pnpm'
  const timeout = config.timeoutMs ?? 120_000

  const commitSha = getCommitSha(worktreePath)

  const tests = captureTestMetrics(worktreePath, config.testCommand ?? `${pm} test`, timeout)
  const typecheck = captureTypecheckMetrics(worktreePath, config.validateCommand ?? `${pm} typecheck`, timeout)
  const lint = captureLintMetrics(worktreePath, config.lintCommand, timeout)

  return {
    timestamp: new Date().toISOString(),
    commitSha,
    tests,
    typecheck,
    lint,
  }
}

// ---------------------------------------------------------------------------
// Delta computation
// ---------------------------------------------------------------------------

/**
 * Compute the quality delta between a baseline and current snapshot.
 * Pure arithmetic — no side effects.
 */
export function computeQualityDelta(
  baseline: QualityBaseline,
  current: QualityBaseline,
): QualityDelta {
  const testFailuresDelta = current.tests.failed - baseline.tests.failed
  const typeErrorsDelta = current.typecheck.errorCount - baseline.typecheck.errorCount
  const lintErrorsDelta = current.lint.errorCount - baseline.lint.errorCount
  const testCountDelta = current.tests.total - baseline.tests.total

  return {
    testFailuresDelta,
    typeErrorsDelta,
    lintErrorsDelta,
    testCountDelta,
    passed: testFailuresDelta <= 0 && typeErrorsDelta <= 0 && lintErrorsDelta <= 0,
  }
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

/**
 * Format a quality comparison into a markdown table for diagnostic comments.
 */
export function formatQualityReport(
  baseline: QualityBaseline,
  current: QualityBaseline,
  delta: QualityDelta,
): string {
  const badge = delta.passed ? '**PASSED**' : '**FAILED**'
  const lines: string[] = [
    `Quality Gate: ${badge}`,
    '',
    '| Metric | Baseline (main) | Current (branch) | Delta |',
    '|--------|---------------:|----------------:|------:|',
    `| Test failures | ${baseline.tests.failed} | ${current.tests.failed} | ${formatDelta(delta.testFailuresDelta)} |`,
    `| Typecheck errors | ${baseline.typecheck.errorCount} | ${current.typecheck.errorCount} | ${formatDelta(delta.typeErrorsDelta)} |`,
    `| Lint errors | ${baseline.lint.errorCount} | ${current.lint.errorCount} | ${formatDelta(delta.lintErrorsDelta)} |`,
    `| Test count | ${baseline.tests.total} | ${current.tests.total} | ${formatDelta(delta.testCountDelta, true)} |`,
  ]

  if (delta.testCountDelta < 0) {
    lines.push('')
    lines.push(`> Warning: ${Math.abs(delta.testCountDelta)} test(s) were removed.`)
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/**
 * Save a quality baseline to the worktree's .agent/ directory.
 */
export function saveBaseline(worktreePath: string, baseline: QualityBaseline): void {
  const agentDir = resolve(worktreePath, '.agent')
  writeFileSync(
    resolve(agentDir, 'quality-baseline.json'),
    JSON.stringify(baseline, null, 2),
  )
}

/**
 * Load a previously saved quality baseline from the worktree's .agent/ directory.
 * Returns null if no baseline exists.
 */
export function loadBaseline(worktreePath: string): QualityBaseline | null {
  const baselinePath = resolve(worktreePath, '.agent', 'quality-baseline.json')
  if (!existsSync(baselinePath)) return null
  try {
    return JSON.parse(readFileSync(baselinePath, 'utf-8')) as QualityBaseline
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getCommitSha(worktreePath: string): string {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim()
  } catch {
    return 'unknown'
  }
}

/**
 * Run the test command and parse output for test counts.
 *
 * Strategy: run with `--reporter=json` appended. If the output is valid JSON
 * with vitest/jest fields, parse counts from it. Otherwise fall back to
 * counting FAIL lines in text output.
 */
function captureTestMetrics(
  worktreePath: string,
  testCommand: string,
  timeout: number,
): QualityBaseline['tests'] {
  const defaults = { total: 0, passed: 0, failed: 0, skipped: 0 }

  try {
    // Try JSON reporter first for structured output
    const jsonCommand = `${testCommand} -- --reporter=json`
    const output = runCommand(jsonCommand, worktreePath, timeout)
    const parsed = parseVitestJson(output)
    if (parsed) return parsed
  } catch {
    // JSON reporter may not be available or test command may have failed
  }

  // Fall back to running the test command and parsing exit code + text
  try {
    const output = runCommand(testCommand, worktreePath, timeout)
    const parsed = parseTestTextOutput(output)
    if (parsed) return parsed
    // Command succeeded but neither parser recognised the summary format.
    // Report a parseError sentinel instead of silently claiming "0 tests" —
    // see QualityBaseline['tests'].parseError for the rationale.
    return {
      ...defaults,
      parseError: 'Test command exited 0 but neither JSON nor text parser recognised the output summary',
    }
  } catch (error) {
    // Test command failed — try to parse the error output for counts
    const errorOutput = extractErrorOutput(error)
    const parsed = parseTestTextOutput(errorOutput)
    if (parsed) return parsed

    // Complete failure — we genuinely don't know the count. Mark it.
    return {
      ...defaults,
      failed: 1,
      parseError: 'Test command failed and no count could be parsed from its output',
    }
  }
}

/**
 * Run the typecheck command and count errors.
 */
function captureTypecheckMetrics(
  worktreePath: string,
  validateCommand: string,
  timeout: number,
): QualityBaseline['typecheck'] {
  try {
    runCommand(validateCommand, worktreePath, timeout)
    return { errorCount: 0, exitCode: 0 }
  } catch (error) {
    const output = extractErrorOutput(error)
    const errorCount = countTypescriptErrors(output)
    const exitCode = (error as any)?.status ?? 1
    return { errorCount: Math.max(errorCount, exitCode !== 0 ? 1 : 0), exitCode }
  }
}

/**
 * Run the lint command and count errors/warnings.
 * Lint is optional — returns zero counts if no lint command is configured.
 */
function captureLintMetrics(
  worktreePath: string,
  lintCommand: string | undefined,
  timeout: number,
): QualityBaseline['lint'] {
  if (!lintCommand) {
    return { errorCount: 0, warningCount: 0 }
  }

  try {
    const output = runCommand(lintCommand, worktreePath, timeout)
    return parseLintOutput(output)
  } catch (error) {
    const output = extractErrorOutput(error)
    return parseLintOutput(output)
  }
}

function runCommand(command: string, cwd: string, timeout: number): string {
  // Redirect stderr → stdout at the shell level so the returned string includes
  // both streams. Many test runners (vitest 4+ in particular) write their
  // pass/fail summary only to stderr — without this, the text parser sees
  // empty output on success and returns `total: 0`, which then trips the
  // quality ratchet in the merge worker.
  return execSync(`${command} 2>&1`, {
    cwd,
    encoding: 'utf-8',
    timeout,
    maxBuffer: 10 * 1024 * 1024, // 10MB
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

function extractErrorOutput(error: unknown): string {
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>
    const stdout = typeof e.stdout === 'string' ? e.stdout : ''
    const stderr = typeof e.stderr === 'string' ? e.stderr : ''
    return stdout + '\n' + stderr
  }
  return String(error)
}

// ---------------------------------------------------------------------------
// Output parsers
// ---------------------------------------------------------------------------

/**
 * Parse vitest JSON reporter output.
 * Expected fields: numTotalTests, numPassedTests, numFailedTests
 */
export function parseVitestJson(output: string): QualityBaseline['tests'] | null {
  try {
    // vitest JSON output may have non-JSON prefix — find the JSON object
    const jsonStart = output.indexOf('{')
    if (jsonStart === -1) return null
    const json = JSON.parse(output.slice(jsonStart))

    if (typeof json.numTotalTests === 'number') {
      return {
        total: json.numTotalTests,
        passed: json.numPassedTests ?? 0,
        failed: json.numFailedTests ?? 0,
        skipped: (json.numTotalTests - (json.numPassedTests ?? 0) - (json.numFailedTests ?? 0)),
      }
    }

    // vitest v2+ format
    if (json.testResults && Array.isArray(json.testResults)) {
      let total = 0, passed = 0, failed = 0
      for (const suite of json.testResults) {
        if (suite.assertionResults && Array.isArray(suite.assertionResults)) {
          for (const test of suite.assertionResults) {
            total++
            if (test.status === 'passed') passed++
            else if (test.status === 'failed') failed++
          }
        }
      }
      return { total, passed, failed, skipped: total - passed - failed }
    }

    return null
  } catch {
    return null
  }
}

/**
 * Parse test text output for counts using common patterns.
 * Supports vitest and jest text output formats.
 */
function parseTestTextOutput(output: string): QualityBaseline['tests'] | null {
  if (!output) return null

  // Vitest format: "Tests  42 passed | 2 failed | 44 total"
  // Also: "Tests  42 passed (44)"
  const vitestMatch = output.match(
    /Tests\s+(\d+)\s+passed(?:\s*\|\s*(\d+)\s+failed)?(?:\s*\|\s*(\d+)\s+skipped)?(?:\s*\|\s*(\d+)\s+total|\s*\((\d+)\))/,
  )
  if (vitestMatch) {
    const passed = parseInt(vitestMatch[1], 10)
    const failed = parseInt(vitestMatch[2] ?? '0', 10)
    const skipped = parseInt(vitestMatch[3] ?? '0', 10)
    const total = parseInt(vitestMatch[4] ?? vitestMatch[5] ?? String(passed + failed + skipped), 10)
    return { total, passed, failed, skipped }
  }

  // Jest format: "Tests:       2 failed, 42 passed, 44 total"
  const jestMatch = output.match(
    /Tests:\s+(?:(\d+)\s+failed,\s+)?(\d+)\s+passed,\s+(\d+)\s+total/,
  )
  if (jestMatch) {
    const failed = parseInt(jestMatch[1] ?? '0', 10)
    const passed = parseInt(jestMatch[2], 10)
    const total = parseInt(jestMatch[3], 10)
    return { total, passed, failed, skipped: total - passed - failed }
  }

  return null
}

/**
 * Count TypeScript errors in tsc output.
 * Matches lines like: "src/foo.ts(10,5): error TS2304: ..."
 */
export function countTypescriptErrors(output: string): number {
  if (!output) return 0
  const matches = output.match(/error TS\d+/g)
  return matches?.length ?? 0
}

/**
 * Parse eslint output for error/warning counts.
 * Matches: "N problems (N errors, N warnings)"
 */
function parseLintOutput(output: string): QualityBaseline['lint'] {
  if (!output) return { errorCount: 0, warningCount: 0 }

  // ESLint summary: "✖ 10 problems (6 errors, 4 warnings)"
  const eslintMatch = output.match(/(\d+)\s+problems?\s*\((\d+)\s+errors?,\s*(\d+)\s+warnings?\)/)
  if (eslintMatch) {
    return {
      errorCount: parseInt(eslintMatch[2], 10),
      warningCount: parseInt(eslintMatch[3], 10),
    }
  }

  // Simple error line counting as fallback
  const errorLines = (output.match(/\berror\b/gi) ?? []).length
  const warningLines = (output.match(/\bwarning\b/gi) ?? []).length
  return { errorCount: errorLines, warningCount: warningLines }
}

function formatDelta(value: number, invertSign = false): string {
  if (value === 0) return '0'
  const display = invertSign ? value : value
  return display > 0 ? `+${display}` : String(display)
}
