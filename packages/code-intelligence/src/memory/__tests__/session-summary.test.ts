import { describe, it, expect, beforeEach } from 'vitest'
import {
  createSessionSummaryHook,
  buildSessionSummary,
  resetSummaryIdCounter,
} from '../session-summary.js'
import { InMemoryObservationSink } from '../observations.js'
import type { Observation } from '../observations.js'
import type { SessionEndEvent } from '../session-summary.js'

function makeFileObs(overrides: Partial<Observation> = {}): Observation {
  return {
    id: `obs_${Math.random().toString(36).slice(2, 8)}`,
    type: 'file_operation',
    content: 'edit /src/app.ts: replaced old code',
    sessionId: 'session-1',
    projectScope: 'project-a',
    timestamp: Date.now(),
    source: 'auto_capture',
    weight: 1.0,
    detail: {
      filePath: '/src/app.ts',
      operationType: 'edit',
      summary: 'replaced old code',
    },
    ...overrides,
  }
}

function makeErrorObs(overrides: Partial<Observation> = {}): Observation {
  return {
    id: `obs_${Math.random().toString(36).slice(2, 8)}`,
    type: 'error_encountered',
    content: 'Error in Bash: test failed',
    sessionId: 'session-1',
    projectScope: 'project-a',
    timestamp: Date.now(),
    source: 'auto_capture',
    weight: 1.5,
    detail: {
      error: 'test failed',
      fix: 'fix the import path',
    },
    ...overrides,
  }
}

function makeDecisionObs(overrides: Partial<Observation> = {}): Observation {
  return {
    id: `obs_${Math.random().toString(36).slice(2, 8)}`,
    type: 'decision',
    content: 'Chose JWT over session cookies',
    sessionId: 'session-1',
    projectScope: 'project-a',
    timestamp: Date.now(),
    source: 'auto_capture',
    weight: 1.0,
    detail: {
      considered: 'JWT vs session cookies',
      chosen: 'JWT',
      reason: 'better for stateless API',
    },
    ...overrides,
  }
}

describe('createSessionSummaryHook', () => {
  let sink: InMemoryObservationSink

  beforeEach(() => {
    sink = new InMemoryObservationSink()
    resetSummaryIdCounter()
  })

  it('fires on session completion with correct outcome status', async () => {
    const hook = createSessionSummaryHook({ sink })
    const result = await hook({
      sessionId: 'session-1',
      projectScope: 'project-a',
      outcome: 'success',
      observations: [],
    })
    expect(result).not.toBeNull()
    expect(result!.type).toBe('session_summary')
    const detail = result!.detail as any
    expect(detail.outcome).toBe('success')
  })

  it('summary aggregates file operations from session observations', async () => {
    const hook = createSessionSummaryHook({ sink })
    const obs = [
      makeFileObs({
        detail: { filePath: '/src/auth.ts', operationType: 'write', summary: 'created auth module' },
      }),
      makeFileObs({
        detail: { filePath: '/src/auth.ts', operationType: 'edit', summary: 'added JWT validation' },
      }),
      makeFileObs({
        detail: { filePath: '/src/types.ts', operationType: 'edit', summary: 'added User type' },
      }),
    ]

    const result = await hook({
      sessionId: 'session-1',
      projectScope: 'project-a',
      outcome: 'success',
      observations: obs,
    })

    const detail = result!.detail as any
    expect(detail.filesChanged).toBeDefined()
    expect(detail.filesChanged.length).toBe(2) // auth.ts and types.ts
    expect(detail.filesChanged.some((f: any) => f.filePath === '/src/auth.ts')).toBe(true)
    expect(detail.filesChanged.some((f: any) => f.filePath === '/src/types.ts')).toBe(true)
  })

  it('summary extracts key decision from decision-type observations', async () => {
    const hook = createSessionSummaryHook({ sink })
    const result = await hook({
      sessionId: 'session-1',
      projectScope: 'project-a',
      outcome: 'success',
      observations: [makeDecisionObs()],
    })

    const detail = result!.detail as any
    expect(detail.keyDecision).toBeDefined()
    expect(detail.keyDecision).toContain('JWT')
  })

  it('summary extracts pitfalls from error-type observations', async () => {
    const hook = createSessionSummaryHook({ sink })
    const result = await hook({
      sessionId: 'session-1',
      projectScope: 'project-a',
      outcome: 'failure',
      observations: [makeErrorObs()],
    })

    const detail = result!.detail as any
    expect(detail.pitfalls).toBeDefined()
    expect(detail.pitfalls.length).toBe(1)
    expect(detail.pitfalls[0]).toContain('test failed')
  })

  it('summary is stored as observation with type session_summary', async () => {
    const hook = createSessionSummaryHook({ sink })
    await hook({
      sessionId: 'session-1',
      projectScope: 'project-a',
      outcome: 'success',
      observations: [],
    })

    expect(sink.observations).toHaveLength(1)
    expect(sink.observations[0].type).toBe('session_summary')
  })

  it('session summary has higher default retrieval weight', async () => {
    const hook = createSessionSummaryHook({ sink })
    const result = await hook({
      sessionId: 'session-1',
      projectScope: 'project-a',
      outcome: 'success',
      observations: [],
    })

    expect(result!.weight).toBe(2.0)
  })

  it('hook fires on failure outcome', async () => {
    const hook = createSessionSummaryHook({ sink })
    const result = await hook({
      sessionId: 'session-1',
      projectScope: 'project-a',
      outcome: 'failure',
      outcomeDescription: 'Tests failed to pass',
      observations: [makeErrorObs()],
    })

    expect(result).not.toBeNull()
    const detail = result!.detail as any
    expect(detail.outcome).toBe('failure')
    expect(detail.outcomeDescription).toBe('Tests failed to pass')
  })

  it('hook fires on cancellation outcome', async () => {
    const hook = createSessionSummaryHook({ sink })
    const result = await hook({
      sessionId: 'session-1',
      projectScope: 'project-a',
      outcome: 'cancelled',
      observations: [],
    })

    expect(result).not.toBeNull()
    const detail = result!.detail as any
    expect(detail.outcome).toBe('cancelled')
  })

  it('summary for session with zero observations produces valid summary', async () => {
    const hook = createSessionSummaryHook({ sink })
    const result = await hook({
      sessionId: 'session-empty',
      projectScope: 'project-a',
      outcome: 'success',
      observations: [],
    })

    expect(result).not.toBeNull()
    expect(result!.type).toBe('session_summary')
    expect(result!.content).toBeTruthy()
    const detail = result!.detail as any
    expect(detail.outcome).toBe('success')
    // No files, no decisions, no pitfalls — but still valid
    expect(detail.filesChanged).toBeUndefined()
    expect(detail.keyDecision).toBeUndefined()
    expect(detail.pitfalls).toBeUndefined()
  })

  it('summary includes correct session ID and project scope', async () => {
    const hook = createSessionSummaryHook({ sink })
    const result = await hook({
      sessionId: 'session-42',
      projectScope: 'github.com/org/repo',
      outcome: 'success',
      observations: [],
    })

    expect(result!.sessionId).toBe('session-42')
    expect(result!.projectScope).toBe('github.com/org/repo')
  })

  it('does not throw on malformed observations', async () => {
    const hook = createSessionSummaryHook({ sink })
    const malformedObs: Observation = {
      id: 'bad',
      type: 'file_operation',
      content: '',
      sessionId: 'session-1',
      projectScope: 'project-a',
      timestamp: Date.now(),
      source: 'auto_capture',
      weight: 1.0,
      detail: undefined,
    }

    const result = await hook({
      sessionId: 'session-1',
      projectScope: 'project-a',
      outcome: 'success',
      observations: [malformedObs],
    })

    expect(result).not.toBeNull()
  })

  it('custom summary weight is applied', async () => {
    const hook = createSessionSummaryHook({ sink, summaryWeight: 5.0 })
    const result = await hook({
      sessionId: 'session-1',
      projectScope: 'project-a',
      outcome: 'success',
      observations: [],
    })

    expect(result!.weight).toBe(5.0)
  })

  it('includes session_summary and outcome tags', async () => {
    const hook = createSessionSummaryHook({ sink })
    const result = await hook({
      sessionId: 'session-1',
      projectScope: 'project-a',
      outcome: 'failure',
      observations: [],
    })

    expect(result!.tags).toContain('session_summary')
    expect(result!.tags).toContain('failure')
  })
})

describe('buildSessionSummary', () => {
  beforeEach(() => {
    resetSummaryIdCounter()
  })

  it('builds a complete summary with all components', () => {
    const event: SessionEndEvent = {
      sessionId: 'session-1',
      projectScope: 'project-a',
      outcome: 'success',
      observations: [
        makeFileObs({
          detail: { filePath: '/src/main.ts', operationType: 'edit', summary: 'updated imports' },
        }),
        makeDecisionObs(),
        makeErrorObs(),
      ],
    }

    const summary = buildSessionSummary(event)
    expect(summary.type).toBe('session_summary')
    expect(summary.content).toContain('Session success')
    expect(summary.content).toContain('/src/main.ts')
    expect(summary.content).toContain('Decision')

    const detail = summary.detail as SessionSummaryDetail
    expect(detail.outcome).toBe('success')
    expect(detail.filesChanged).toBeDefined()
    expect(detail.keyDecision).toBeDefined()
    expect(detail.pitfalls).toBeDefined()
  })

  it('only includes write/edit operations as file changes', () => {
    const event: SessionEndEvent = {
      sessionId: 'session-1',
      projectScope: 'project-a',
      outcome: 'success',
      observations: [
        makeFileObs({
          detail: { filePath: '/src/read.ts', operationType: 'read', summary: 'Read file' },
        }),
        makeFileObs({
          detail: { filePath: '/src/edited.ts', operationType: 'edit', summary: 'Fixed bug' },
        }),
        makeFileObs({
          detail: { filePath: '/src/search.ts', operationType: 'grep', summary: 'Searched' },
        }),
      ],
    }

    const summary = buildSessionSummary(event)
    const detail = summary.detail as SessionSummaryDetail
    expect(detail.filesChanged).toHaveLength(1)
    expect(detail.filesChanged![0].filePath).toBe('/src/edited.ts')
  })

  it('generates auto description for success', () => {
    const event: SessionEndEvent = {
      sessionId: 'session-1',
      projectScope: 'project-a',
      outcome: 'success',
      observations: [
        makeFileObs({
          detail: { filePath: '/a.ts', operationType: 'write', summary: 'created' },
        }),
        makeFileObs({
          detail: { filePath: '/b.ts', operationType: 'edit', summary: 'updated' },
        }),
      ],
    }

    const summary = buildSessionSummary(event)
    const detail = summary.detail as SessionSummaryDetail
    expect(detail.outcomeDescription).toContain('2 file changes')
  })

  it('generates auto description for failure', () => {
    const event: SessionEndEvent = {
      sessionId: 'session-1',
      projectScope: 'project-a',
      outcome: 'failure',
      observations: [makeErrorObs(), makeErrorObs()],
    }

    const summary = buildSessionSummary(event)
    const detail = summary.detail as SessionSummaryDetail
    expect(detail.outcomeDescription).toContain('2 errors')
  })
})
