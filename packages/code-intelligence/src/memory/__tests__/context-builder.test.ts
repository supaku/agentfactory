import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ObservationStore } from '../observation-store.js'
import { InMemoryStore } from '../memory-store.js'
import {
  buildSessionMemoryContext,
  DEFAULT_CONTEXT_BUDGET,
} from '../context-builder.js'
import type {
  ContextInjectionLog,
  ContextBuilderOptions,
  ContextBuildRequest,
} from '../context-builder.js'
import type { Observation } from '../observations.js'

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: `obs_${Math.random().toString(36).slice(2, 8)}`,
    type: 'file_operation',
    content: 'read /src/index.ts: Read file',
    sessionId: 'session-old',
    projectScope: 'project-a',
    timestamp: Date.now(),
    source: 'auto_capture',
    weight: 1.0,
    ...overrides,
  }
}

describe('buildSessionMemoryContext', () => {
  let store: ObservationStore
  let logEntries: ContextInjectionLog[]

  beforeEach(() => {
    store = new ObservationStore(new InMemoryStore())
    logEntries = []
  })

  function makeOptions(overrides: Partial<ContextBuilderOptions> = {}): ContextBuilderOptions {
    return {
      store,
      onLog: (log) => logEntries.push(log),
      ...overrides,
    }
  }

  function makeRequest(overrides: Partial<ContextBuildRequest> = {}): ContextBuildRequest {
    return {
      sessionId: 'session-new',
      projectScope: 'project-a',
      workType: 'feature',
      issueContext: 'Add authentication to the API',
      ...overrides,
    }
  }

  // ── Context Building ─────────────────────────────────────────

  it('constructs search query from work item context', async () => {
    await store.store(makeObservation({
      content: 'implemented JWT authentication middleware for express routes',
    }))

    const context = await buildSessionMemoryContext(
      makeOptions(),
      makeRequest({ issueContext: 'authentication JWT implementation' }),
    )

    expect(context).toContain('JWT')
  })

  it('formats observations as structured markdown with provenance', async () => {
    await store.store(makeObservation({
      content: 'edited /src/auth.ts to add token validation',
      sessionId: 'session-abc123',
      timestamp: new Date('2026-01-15').getTime(),
    }))

    const context = await buildSessionMemoryContext(
      makeOptions(),
      makeRequest({ issueContext: 'auth token validation' }),
    )

    // Should contain date and session ID prefix
    expect(context).toContain('2026-01-15')
    expect(context).toContain('session-') // session ID is truncated for display
  })

  it('session summaries rank above individual observations', async () => {
    await store.store(makeObservation({
      id: 'obs_individual',
      type: 'file_operation',
      content: 'edited auth middleware to check tokens',
      timestamp: Date.now(),
    }))
    await store.store(makeObservation({
      id: 'obs_summary',
      type: 'session_summary',
      content: 'Session summary: implemented auth middleware with token checking and validation',
      weight: 2.0,
      timestamp: Date.now(),
    }))

    const context = await buildSessionMemoryContext(
      makeOptions(),
      makeRequest({ issueContext: 'auth middleware token' }),
    )

    // Session summary should appear first in output
    const summaryPos = context.indexOf('Session Summary')
    const fileOpPos = context.indexOf('File Operation')
    expect(summaryPos).toBeLessThan(fileOpPos)
  })

  it('drops lower-ranked observations when token limit exceeded', async () => {
    // Store many observations
    for (let i = 0; i < 50; i++) {
      await store.store(makeObservation({
        id: `obs_${i}`,
        content: `observation number ${i} about authentication patterns and security configuration with lots of detail about implementation specifics and coding conventions`,
      }))
    }

    const context = await buildSessionMemoryContext(
      makeOptions({ budgetConfig: { default: 200, perWorkType: {}, maxObservations: 50 } }),
      makeRequest({ issueContext: 'authentication patterns' }),
    )

    // Context should be limited (not include all 50 observations)
    const observationCount = (context.match(/\*\*File Operation\*\*/g) ?? []).length
    expect(observationCount).toBeLessThan(50)
    expect(observationCount).toBeGreaterThan(0)
  })

  it('zero observations → empty string', async () => {
    const context = await buildSessionMemoryContext(
      makeOptions(),
      makeRequest(),
    )
    expect(context).toBe('')
  })

  it('deduplicates observations in output', async () => {
    await store.store(makeObservation({
      id: 'obs_1',
      type: 'session_summary',
      content: 'summary of authentication work done in previous session',
    }))

    const context = await buildSessionMemoryContext(
      makeOptions(),
      makeRequest({ issueContext: 'authentication' }),
    )

    // Should only appear once
    const matches = context.match(/summary of authentication/g) ?? []
    expect(matches.length).toBe(1)
  })

  // ── Budget Configuration ───────────────────────────────────────

  it('default budget of 500 tokens applied when no work-type-specific config', async () => {
    await store.store(makeObservation({
      content: 'important observation about API design patterns',
    }))

    await buildSessionMemoryContext(
      makeOptions(),
      makeRequest({ workType: 'unknown_type' }),
    )

    expect(logEntries.length).toBe(1)
    expect(logEntries[0].budgetTokens).toBe(500)
  })

  it('work-type-specific budget overrides default', async () => {
    await store.store(makeObservation({
      content: 'bug fix related observation about error handling',
    }))

    await buildSessionMemoryContext(
      makeOptions(),
      makeRequest({ workType: 'bug_fix', issueContext: 'error handling' }),
    )

    expect(logEntries.length).toBe(1)
    expect(logEntries[0].budgetTokens).toBe(750)
  })

  it('org-level config overrides system defaults', async () => {
    await store.store(makeObservation({
      content: 'observation about database migration patterns',
    }))

    await buildSessionMemoryContext(
      makeOptions({
        budgetConfig: {
          default: 1000,
          perWorkType: { feature: 800 },
          maxObservations: 10,
        },
      }),
      makeRequest({ workType: 'feature', issueContext: 'database migration' }),
    )

    expect(logEntries.length).toBe(1)
    expect(logEntries[0].budgetTokens).toBe(800)
  })

  it('maxObservations cap is enforced', async () => {
    for (let i = 0; i < 30; i++) {
      await store.store(makeObservation({
        id: `obs_${i}`,
        content: `unique observation ${i} about testing patterns and code quality metrics analysis`,
      }))
    }

    await buildSessionMemoryContext(
      makeOptions({
        budgetConfig: { default: 10000, perWorkType: {}, maxObservations: 5 },
      }),
      makeRequest({ issueContext: 'testing patterns' }),
    )

    expect(logEntries.length).toBe(1)
    // Should have at most 5 observations
    expect(logEntries[0].observationIds.length).toBeLessThanOrEqual(5)
  })

  it('budget of 0 → no observations injected', async () => {
    await store.store(makeObservation({
      content: 'this should not appear in context output',
    }))

    const context = await buildSessionMemoryContext(
      makeOptions({
        budgetConfig: { default: 0, perWorkType: {}, maxObservations: 20 },
      }),
      makeRequest(),
    )

    expect(context).toBe('')
    expect(logEntries.length).toBe(1)
    expect(logEntries[0].actualTokens).toBe(0)
  })

  // ── Injection Logging ──────────────────────────────────────────

  it('ContextInjectionLog includes all required fields', async () => {
    await store.store(makeObservation({
      content: 'observation for logging test about deployment configuration',
    }))

    await buildSessionMemoryContext(
      makeOptions(),
      makeRequest({ issueContext: 'deployment configuration' }),
    )

    expect(logEntries.length).toBe(1)
    const log = logEntries[0]
    expect(log.sessionId).toBe('session-new')
    expect(log.workType).toBe('feature')
    expect(typeof log.budgetTokens).toBe('number')
    expect(typeof log.actualTokens).toBe('number')
    expect(Array.isArray(log.observationIds)).toBe(true)
    expect(Array.isArray(log.sessionSummaryIds)).toBe(true)
    expect(typeof log.queryText).toBe('string')
    expect(log.timestamp).toBeTruthy()
  })

  it('actualTokens reflects actual injected content', async () => {
    await store.store(makeObservation({
      content: 'short observation about testing',
    }))

    await buildSessionMemoryContext(
      makeOptions(),
      makeRequest({ issueContext: 'testing' }),
    )

    const log = logEntries[0]
    expect(log.actualTokens).toBeGreaterThan(0)
    expect(log.actualTokens).toBeLessThanOrEqual(log.budgetTokens)
  })

  it('observationIds matches actually included observations', async () => {
    await store.store(makeObservation({
      id: 'obs_included',
      content: 'observation about API endpoint design',
    }))

    await buildSessionMemoryContext(
      makeOptions(),
      makeRequest({ issueContext: 'API endpoint' }),
    )

    const log = logEntries[0]
    expect(log.observationIds).toContain('obs_included')
  })

  it('log is emitted even when zero observations injected', async () => {
    await buildSessionMemoryContext(
      makeOptions(),
      makeRequest(),
    )

    expect(logEntries.length).toBe(1)
    expect(logEntries[0].observationIds).toHaveLength(0)
    expect(logEntries[0].actualTokens).toBe(0)
  })

  // ── Project Scope Isolation ────────────────────────────────────

  it('observations from different project are NOT injected', async () => {
    await store.store(makeObservation({
      content: 'observation from project B about deployment pipeline configuration',
      projectScope: 'project-b',
    }))

    const context = await buildSessionMemoryContext(
      makeOptions(),
      makeRequest({ projectScope: 'project-a', issueContext: 'deployment' }),
    )

    expect(context).toBe('')
  })
})
