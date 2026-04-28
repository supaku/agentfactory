/**
 * Operational Scanner — CI template tests (REN-1328)
 *
 * Verifies that the operational-scanner-ci YAML template:
 *   1. Loads and renders correctly via the TemplateRegistry.
 *   2. Carries the correct tool allow/disallow configuration
 *      (Principle 1: --parentId is disallowed).
 *   3. Instructs the agent to detect flaky tests, slow steps, and
 *      optimization opportunities across CI runs.
 *   4. Instructs the agent to dedupe against existing issues before authoring.
 *   5. Instructs to tag bug issues with source:ci and improvement issues
 *      with chore label.
 *
 * All tests are fixture-driven; no LLM calls are made.
 */

import { describe, it, expect } from 'vitest'
import { TemplateRegistry } from '../../templates/registry.js'

// ---------------------------------------------------------------------------
// Fixtures — mock CI run data
// ---------------------------------------------------------------------------

/** A CI run step result. */
interface CiStepResult {
  runId: string
  workflowName: string
  stepName: string
  status: 'success' | 'failure' | 'skipped'
  durationMs: number
  retryCount: number
  timestamp: string
}

/** A CI test result for a specific test case across runs. */
interface CiTestResult {
  runId: string
  workflowName: string
  testName: string
  filePath: string
  status: 'passed' | 'failed' | 'skipped'
  durationMs: number
}

/**
 * Fixture: flaky test — passes in some runs, fails in others
 * for the same test name.
 */
const FIXTURE_FLAKY_TEST_RESULTS: CiTestResult[] = [
  { runId: 'run_001', workflowName: 'ci', testName: 'AuthService > login should succeed', filePath: 'src/auth.test.ts', status: 'passed', durationMs: 120 },
  { runId: 'run_002', workflowName: 'ci', testName: 'AuthService > login should succeed', filePath: 'src/auth.test.ts', status: 'failed', durationMs: 5000 },
  { runId: 'run_003', workflowName: 'ci', testName: 'AuthService > login should succeed', filePath: 'src/auth.test.ts', status: 'passed', durationMs: 110 },
  { runId: 'run_004', workflowName: 'ci', testName: 'AuthService > login should succeed', filePath: 'src/auth.test.ts', status: 'failed', durationMs: 5000 },
  { runId: 'run_005', workflowName: 'ci', testName: 'AuthService > login should succeed', filePath: 'src/auth.test.ts', status: 'passed', durationMs: 130 },
]

/**
 * Fixture: consistently passing test — should NOT be flagged as flaky.
 */
const FIXTURE_STABLE_TEST_RESULTS: CiTestResult[] = Array.from({ length: 5 }, (_, i) => ({
  runId: `run_0${i + 10}`,
  workflowName: 'ci',
  testName: 'UserService > getUser should return user',
  filePath: 'src/user.test.ts',
  status: 'passed' as const,
  durationMs: 80 + i * 5,
}))

/**
 * Fixture: slow step — significantly above baseline duration.
 */
const FIXTURE_SLOW_STEP_RESULTS: CiStepResult[] = Array.from({ length: 5 }, (_, i) => ({
  runId: `run_${100 + i}`,
  workflowName: 'ci',
  stepName: 'Install dependencies',
  status: 'success' as const,
  durationMs: 320_000 + i * 10_000, // 5.3–5.7 minutes
  retryCount: 0,
  timestamp: `2026-04-26T10:0${i}:00Z`,
}))

/**
 * Fixture: optimization opportunity — install step with no cache key.
 */
const FIXTURE_UNCACHED_INSTALL: CiStepResult = {
  runId: 'run_200',
  workflowName: 'nightly',
  stepName: 'install',
  status: 'success',
  durationMs: 180_000, // 3 minutes
  retryCount: 0,
  timestamp: '2026-04-26T02:00:00Z',
}

// ---------------------------------------------------------------------------
// Helpers — minimal CI signal detectors
// ---------------------------------------------------------------------------

interface CiFlakeCluster {
  testName: string
  filePath: string
  failCount: number
  passCount: number
  flakeRate: number // failures / total
}

interface CiSlowStepCluster {
  stepName: string
  workflowName: string
  meanDurationMs: number
  baselineDurationMs: number
  runIds: string[]
}

interface CiOptimizationCluster {
  stepName: string
  workflowName: string
  description: string
}

/**
 * Detect flaky tests.
 * A test is flaky if it fails in ≥2 runs AND passes in ≥2 runs.
 */
function detectFlakyTests(results: CiTestResult[]): CiFlakeCluster[] {
  const map = new Map<string, { passes: number; failures: number; filePath: string }>()

  for (const r of results) {
    const key = `${r.workflowName}::${r.testName}`
    const entry = map.get(key) ?? { passes: 0, failures: 0, filePath: r.filePath }
    if (r.status === 'passed') entry.passes++
    if (r.status === 'failed') entry.failures++
    map.set(key, entry)
  }

  const clusters: CiFlakeCluster[] = []
  for (const [key, { passes, failures, filePath }] of map.entries()) {
    if (failures >= 2 && passes >= 2) {
      const total = passes + failures
      const testName = key.split('::')[1]
      clusters.push({
        testName,
        filePath,
        failCount: failures,
        passCount: passes,
        flakeRate: failures / total,
      })
    }
  }
  return clusters
}

/**
 * Detect slow steps (mean duration > 5 minutes = 300,000ms).
 */
function detectSlowSteps(
  results: CiStepResult[],
  thresholdMs = 300_000
): CiSlowStepCluster[] {
  const map = new Map<string, { durations: number[]; runIds: string[]; workflowName: string }>()

  for (const r of results) {
    const key = `${r.workflowName}::${r.stepName}`
    const entry = map.get(key) ?? { durations: [], runIds: [], workflowName: r.workflowName }
    entry.durations.push(r.durationMs)
    entry.runIds.push(r.runId)
    map.set(key, entry)
  }

  const clusters: CiSlowStepCluster[] = []
  for (const [key, { durations, runIds, workflowName }] of map.entries()) {
    const mean = durations.reduce((a, b) => a + b, 0) / durations.length
    if (mean > thresholdMs) {
      const stepName = key.split('::')[1]
      clusters.push({
        stepName,
        workflowName,
        meanDurationMs: Math.round(mean),
        baselineDurationMs: thresholdMs,
        runIds,
      })
    }
  }
  return clusters
}

/**
 * Detect optimization opportunities — install/build/lint steps that could use caching.
 */
function detectOptimizationOpportunities(results: CiStepResult[]): CiOptimizationCluster[] {
  const CACHEABLE_STEP_NAMES = new Set(['install', 'build', 'lint', 'compile'])
  const seen = new Set<string>()
  const clusters: CiOptimizationCluster[] = []

  for (const r of results) {
    const stepLower = r.stepName.toLowerCase()
    const isCacheable = CACHEABLE_STEP_NAMES.has(stepLower) ||
      stepLower.includes('install') || stepLower.includes('build dependencies')
    const key = `${r.workflowName}::${r.stepName}`
    if (isCacheable && !seen.has(key)) {
      seen.add(key)
      clusters.push({
        stepName: r.stepName,
        workflowName: r.workflowName,
        description: `Step "${r.stepName}" in "${r.workflowName}" could benefit from dependency caching`,
      })
    }
  }
  return clusters
}

/**
 * Build a bug-report issue spec from a flaky-test cluster.
 * Mirrors what the agent prompt instructs — no --parentId.
 */
function buildFlakeBugSpec(cluster: CiFlakeCluster, scanRunId: string): {
  title: string
  state: string
  labels: string[]
  hasParentId: false
} {
  return {
    title: `Flaky test: ${cluster.testName.slice(0, 60)}`,
    state: 'Backlog',
    labels: ['bug', 'source:ci', `provenance:scan-${scanRunId}`],
    hasParentId: false as const,
  }
}

/**
 * Build a chore issue spec from an optimization cluster.
 * Uses chore label per the CI scanner's labeling convention.
 */
function buildOptimizationSpec(cluster: CiOptimizationCluster, scanRunId: string): {
  title: string
  state: string
  labels: string[]
  hasParentId: false
} {
  return {
    title: `CI optimization: ${cluster.stepName.slice(0, 50)} could use caching [${cluster.workflowName}]`,
    state: 'Backlog',
    labels: ['chore', 'source:ci', `provenance:scan-${scanRunId}`],
    hasParentId: false as const,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRegistry(): TemplateRegistry {
  return TemplateRegistry.create({ useBuiltinDefaults: true })
}

function render(registry: TemplateRegistry, extras: Record<string, unknown> = {}): string {
  const result = registry.renderPrompt('operational-scanner-ci' as never, {
    identifier: 'REN-SCAN-CI',
    ...extras,
  })
  expect(result, 'operational-scanner-ci template must be registered and renderable').not.toBeNull()
  return result as string
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('operational-scanner-ci template (REN-1328)', () => {
  // -------------------------------------------------------------------------
  // 1. Template loading and rendering
  // -------------------------------------------------------------------------
  describe('template loading and rendering', () => {
    it('loads via TemplateRegistry built-in defaults', () => {
      const registry = buildRegistry()
      expect(registry.hasTemplate('operational-scanner-ci' as never)).toBe(true)
    })

    it('renders with identifier variable', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toContain('REN-SCAN-CI')
    })

    it('has a non-empty prompt', () => {
      const registry = buildRegistry()
      const template = registry.getTemplate('operational-scanner-ci' as never)
      expect(template?.prompt.trim().length).toBeGreaterThan(100)
    })

    it('rendered prompt includes mentionContext when provided', () => {
      const registry = buildRegistry()
      const result = render(registry, { mentionContext: 'Focus on nightly builds only' })
      expect(result).toContain('Focus on nightly builds only')
    })

    it('rendered prompt omits mentionContext section when not provided', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).not.toContain('Additional context from the user')
    })
  })

  // -------------------------------------------------------------------------
  // 2. Tool permissions (Principle 1 enforcement)
  // -------------------------------------------------------------------------
  describe('tool permissions (Principle 1 enforcement)', () => {
    it('allows af-linear create-issue (standalone bug-report/improvement issues)', () => {
      const registry = buildRegistry()
      const { allow } = registry.getRawToolPermissions('operational-scanner-ci' as never)
      const shellPatterns = allow
        .filter((p): p is { shell: string } => typeof p === 'object' && 'shell' in p)
        .map(p => p.shell)
      expect(shellPatterns.some(p => p.includes('create-issue'))).toBe(true)
    })

    it('disallows af-linear create-issue --parentId * (no sub-issues per Principle 1)', () => {
      const registry = buildRegistry()
      const { disallow } = registry.getRawToolPermissions('operational-scanner-ci' as never)
      const shellDisallowed = disallow
        .filter((p): p is { shell: string } => typeof p === 'object' && 'shell' in p)
        .map(p => p.shell)
      expect(shellDisallowed.some(p => p.includes('--parentId'))).toBe(true)
    })

    it('disallows user-input (fully autonomous, cron-safe)', () => {
      const registry = buildRegistry()
      const { disallow } = registry.getRawToolPermissions('operational-scanner-ci' as never)
      expect(disallow).toContain('user-input')
    })

    it('allows af-linear list-issues (needed for dedupe check)', () => {
      const registry = buildRegistry()
      const { allow } = registry.getRawToolPermissions('operational-scanner-ci' as never)
      const shellPatterns = allow
        .filter((p): p is { shell: string } => typeof p === 'object' && 'shell' in p)
        .map(p => p.shell)
      expect(shellPatterns.some(p => p.includes('list-issues'))).toBe(true)
    })

    it('allows gh run view (needed to read CI run logs)', () => {
      const registry = buildRegistry()
      const { allow } = registry.getRawToolPermissions('operational-scanner-ci' as never)
      const shellPatterns = allow
        .filter((p): p is { shell: string } => typeof p === 'object' && 'shell' in p)
        .map(p => p.shell)
      expect(shellPatterns.some(p => p.includes('gh run'))).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // 3. Signal types — prompt coverage
  // -------------------------------------------------------------------------
  describe('signal types covered in prompt', () => {
    it('prompt references flaky tests', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toMatch(/flaky.*test|test.*flak/i)
    })

    it('prompt references slow steps', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toMatch(/slow.*step|step.*slow|duration/i)
    })

    it('prompt references optimization opportunities', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toMatch(/optimiz|cache|caching/i)
    })
  })

  // -------------------------------------------------------------------------
  // 4. Label conventions
  // -------------------------------------------------------------------------
  describe('label conventions', () => {
    it('prompt instructs to use bug label for flaky tests and slow steps', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toContain('bug')
    })

    it('prompt instructs to use chore label for optimization opportunities', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toContain('chore')
    })

    it('prompt instructs to tag issues with source:ci', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toContain('source:ci')
    })

    it('prompt instructs to tag issues with provenance:scan-', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toContain('provenance:scan-')
    })
  })

  // -------------------------------------------------------------------------
  // 5. Dedupe instruction
  // -------------------------------------------------------------------------
  describe('dedupe against existing issues', () => {
    it('prompt instructs agent to search Linear before creating', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toContain('list-issues')
      expect(result).toMatch(/source:ci|test.name|step.name/i)
    })
  })

  // -------------------------------------------------------------------------
  // 6. Issue cap
  // -------------------------------------------------------------------------
  describe('issue cap enforcement', () => {
    it('prompt enforces a cap on issues created per scan', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toMatch(/cap|limit|at most|maximum|10 issue/i)
    })
  })

  // -------------------------------------------------------------------------
  // 7. WORK_RESULT markers
  // -------------------------------------------------------------------------
  describe('WORK_RESULT markers', () => {
    it('rendered prompt contains WORK_RESULT:passed marker', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toContain('WORK_RESULT:passed')
    })

    it('rendered prompt contains WORK_RESULT:failed marker', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toContain('WORK_RESULT:failed')
    })
  })

  // -------------------------------------------------------------------------
  // 8. Fixture-driven signal detection tests (no LLM needed)
  // -------------------------------------------------------------------------
  describe('CI fixture: flaky test detection', () => {
    it('detects a flaky test that fails in 2 of 5 runs and passes in 3', () => {
      const clusters = detectFlakyTests(FIXTURE_FLAKY_TEST_RESULTS)
      expect(clusters).toHaveLength(1)
      expect(clusters[0].testName).toContain('AuthService')
      expect(clusters[0].failCount).toBe(2)
      expect(clusters[0].passCount).toBe(3)
      expect(clusters[0].flakeRate).toBeCloseTo(2 / 5)
    })

    it('does not flag a consistently passing test', () => {
      const clusters = detectFlakyTests(FIXTURE_STABLE_TEST_RESULTS)
      expect(clusters).toHaveLength(0)
    })

    it('does not flag a test that only fails (never passes)', () => {
      const alwaysFailing: CiTestResult[] = Array.from({ length: 5 }, (_, i) => ({
        runId: `run_f${i}`,
        workflowName: 'ci',
        testName: 'BrokenTest > always fails',
        filePath: 'src/broken.test.ts',
        status: 'failed' as const,
        durationMs: 500,
      }))
      const clusters = detectFlakyTests(alwaysFailing)
      // Not flaky — consistently failing, not intermittent
      expect(clusters).toHaveLength(0)
    })
  })

  describe('CI fixture: slow step detection', () => {
    it('detects Install step averaging >5 minutes as a slow-step cluster', () => {
      const clusters = detectSlowSteps(FIXTURE_SLOW_STEP_RESULTS)
      expect(clusters).toHaveLength(1)
      expect(clusters[0].stepName).toBe('Install dependencies')
      expect(clusters[0].meanDurationMs).toBeGreaterThan(300_000)
    })

    it('does not flag a step that is under the threshold', () => {
      const fastSteps: CiStepResult[] = Array.from({ length: 3 }, (_, i) => ({
        runId: `run_fast${i}`,
        workflowName: 'ci',
        stepName: 'Run tests',
        status: 'success' as const,
        durationMs: 60_000, // 1 minute — well under 5min threshold
        retryCount: 0,
        timestamp: `2026-04-26T10:0${i}:00Z`,
      }))
      const clusters = detectSlowSteps(fastSteps)
      expect(clusters).toHaveLength(0)
    })
  })

  describe('CI fixture: optimization opportunity detection', () => {
    it('flags an uncached install step as an optimization opportunity', () => {
      const clusters = detectOptimizationOpportunities([FIXTURE_UNCACHED_INSTALL])
      expect(clusters).toHaveLength(1)
      expect(clusters[0].stepName).toBe('install')
      expect(clusters[0].description).toMatch(/cach/i)
    })

    it('does not flag non-cacheable steps', () => {
      const nonCacheable: CiStepResult = {
        ...FIXTURE_UNCACHED_INSTALL,
        stepName: 'Run integration tests',
      }
      const clusters = detectOptimizationOpportunities([nonCacheable])
      expect(clusters).toHaveLength(0)
    })
  })

  describe('CI fixture: issue spec construction', () => {
    it('builds a valid bug-report spec for a flaky-test cluster', () => {
      const clusters = detectFlakyTests(FIXTURE_FLAKY_TEST_RESULTS)
      expect(clusters.length).toBeGreaterThan(0)

      const spec = buildFlakeBugSpec(clusters[0], 'REN-SCAN-CI')

      expect(spec.state).toBe('Backlog')
      expect(spec.labels).toContain('bug')
      expect(spec.labels).toContain('source:ci')
      expect(spec.labels.some(l => l.startsWith('provenance:scan-'))).toBe(true)
      expect(spec.hasParentId).toBe(false)
    })

    it('builds a valid chore spec for an optimization-opportunity cluster', () => {
      const clusters = detectOptimizationOpportunities([FIXTURE_UNCACHED_INSTALL])
      expect(clusters.length).toBeGreaterThan(0)

      const spec = buildOptimizationSpec(clusters[0], 'REN-SCAN-CI')

      expect(spec.state).toBe('Backlog')
      expect(spec.labels).toContain('chore')
      expect(spec.labels).toContain('source:ci')
      expect(spec.labels.some(l => l.startsWith('provenance:scan-'))).toBe(true)
      expect(spec.hasParentId).toBe(false)
    })

    it('issue spec never carries a parentId (Principle 1 hard constraint)', () => {
      const flakeClusters = detectFlakyTests(FIXTURE_FLAKY_TEST_RESULTS)
      const optClusters = detectOptimizationOpportunities([FIXTURE_UNCACHED_INSTALL])

      for (const cluster of flakeClusters) {
        const spec = buildFlakeBugSpec(cluster, 'REN-SCAN-CI')
        expect(spec.hasParentId).toBe(false)
        expect(spec.title).not.toContain('--parentId')
      }
      for (const cluster of optClusters) {
        const spec = buildOptimizationSpec(cluster, 'REN-SCAN-CI')
        expect(spec.hasParentId).toBe(false)
        expect(spec.title).not.toContain('--parentId')
      }
    })
  })
})
