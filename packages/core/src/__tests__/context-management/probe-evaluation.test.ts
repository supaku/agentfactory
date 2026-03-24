import { describe, it, expect } from 'vitest'
import { SummaryBuilder } from '../../orchestrator/summary-builder.js'
import { ArtifactTracker } from '../../orchestrator/artifact-tracker.js'
import { SUMMARY_SCHEMA_VERSION } from '../../orchestrator/state-types.js'
import {
  makeToolUse,
  makeAssistantText,
  makeEmptyArtifacts,
  makeSummary,
  generateSessionEvents,
  generateArtifactIndex,
} from './helpers.js'
import type { AgentEvent } from '../../providers/types.js'

describe('Probe Evaluation — Factual Retention', () => {
  it('retains file modifications through compression', () => {
    const builder = new SummaryBuilder()

    const events: AgentEvent[] = [
      makeAssistantText('I need to implement the login endpoint with JWT authentication.'),
      makeToolUse('Read', { file_path: '/src/auth/login.ts' }),
      makeToolUse('Edit', { file_path: '/src/auth/login.ts' }),
      makeToolUse('Write', { file_path: '/src/auth/middleware.ts' }),
    ]

    const summary = builder.summarizeSpan(events, null, makeEmptyArtifacts())

    // All file operations should be captured
    expect(summary.fileModifications.length).toBeGreaterThanOrEqual(2)
    const paths = summary.fileModifications.map(m => m.path)
    expect(paths).toContain('/src/auth/login.ts')
    expect(paths).toContain('/src/auth/middleware.ts')
  })

  it('preserves session intent through compression', () => {
    const builder = new SummaryBuilder()

    const events: AgentEvent[] = [
      makeAssistantText('I will implement the user authentication system with JWT tokens and role-based access control.'),
      makeToolUse('Read', { file_path: '/src/auth.ts' }),
    ]

    const summary = builder.summarizeSpan(events, null, makeEmptyArtifacts())
    expect(summary.sessionIntent).toContain('authentication')
  })

  it('retains facts across multiple compression rounds', () => {
    const builder = new SummaryBuilder()

    // Round 1
    const events1: AgentEvent[] = [
      makeAssistantText('I will implement the database migration system for PostgreSQL with rollback support.'),
      makeToolUse('Edit', { file_path: '/src/db/migrate.ts' }),
    ]
    const summary1 = builder.summarizeSpan(events1, null, makeEmptyArtifacts())

    // Round 2
    const events2: AgentEvent[] = [
      makeToolUse('Edit', { file_path: '/src/db/rollback.ts' }),
      makeToolUse('Write', { file_path: '/src/db/seeds.ts' }),
    ]
    const summary2 = builder.summarizeSpan(events2, summary1, makeEmptyArtifacts())

    // Merge
    const merged = builder.mergeSummaries(summary1, summary2)

    // Original intent should be preserved
    expect(merged.sessionIntent).toContain('database migration')

    // All files from both rounds should be present
    const paths = merged.fileModifications.map(m => m.path)
    expect(paths).toContain('/src/db/migrate.ts')
    expect(paths).toContain('/src/db/rollback.ts')
    expect(paths).toContain('/src/db/seeds.ts')
  })
})

describe('Probe Evaluation — File Tracking Accuracy', () => {
  it('correctly tracks 20+ file operations through ArtifactTracker', () => {
    const tracker = new ArtifactTracker('/tmp/test')
    const fileCount = 25

    for (let i = 0; i < fileCount; i++) {
      tracker.trackEvent(makeToolUse('Read', { file_path: `/tmp/test/src/file-${i}.ts` }))
      if (i % 2 === 0) {
        tracker.trackEvent(makeToolUse('Edit', { file_path: `/tmp/test/src/file-${i}.ts` }))
      }
    }

    const index = tracker.getIndex()
    expect(Object.keys(index.files).length).toBe(fileCount)

    const modifiedFiles = tracker.getFiles({ action: 'modified' })
    expect(modifiedFiles.length).toBe(Math.ceil(fileCount / 2))
  })

  it('distinguishes read-only from modified files', () => {
    const tracker = new ArtifactTracker('/tmp/test')

    // Read-only files
    tracker.trackEvent(makeToolUse('Read', { file_path: '/tmp/test/src/readonly.ts' }))
    // Modified files
    tracker.trackEvent(makeToolUse('Read', { file_path: '/tmp/test/src/modified.ts' }))
    tracker.trackEvent(makeToolUse('Edit', { file_path: '/tmp/test/src/modified.ts' }))

    const contextString = tracker.toContextString()
    expect(contextString).toContain('Modified (1)')
    expect(contextString).toContain('Read-only (1)')
  })

  it('tracks file operations across compression boundary', () => {
    const builder = new SummaryBuilder()

    const events1: AgentEvent[] = [
      makeToolUse('Read', { file_path: '/src/a.ts' }),
      makeToolUse('Edit', { file_path: '/src/a.ts' }),
    ]
    const summary1 = builder.summarizeSpan(events1, null, makeEmptyArtifacts())

    const events2: AgentEvent[] = [
      makeToolUse('Read', { file_path: '/src/a.ts' }),
      makeToolUse('Edit', { file_path: '/src/a.ts' }),
      makeToolUse('Write', { file_path: '/src/b.ts' }),
    ]
    const summary2 = builder.summarizeSpan(events2, summary1, makeEmptyArtifacts())

    const merged = builder.mergeSummaries(summary1, summary2)

    // File a.ts should appear once (deduplicated), b.ts should also be present
    const paths = merged.fileModifications.map(m => m.path)
    expect(new Set(paths).size).toBe(paths.length) // No duplicates
    expect(paths).toContain('/src/a.ts')
    expect(paths).toContain('/src/b.ts')
  })
})

describe('Probe Evaluation — Task Planning (Next Steps)', () => {
  it('preserves next steps through merge', () => {
    const builder = new SummaryBuilder()
    const existing = makeSummary({
      nextSteps: ['Write unit tests', 'Update documentation', 'Deploy to staging'],
    })
    const incoming = makeSummary({
      nextSteps: ['Run integration tests'],
    })

    const merged = builder.mergeSummaries(existing, incoming)

    expect(merged.nextSteps).toContain('Write unit tests')
    expect(merged.nextSteps).toContain('Update documentation')
    expect(merged.nextSteps).toContain('Deploy to staging')
    expect(merged.nextSteps).toContain('Run integration tests')
  })
})

describe('Probe Evaluation — Decision Preservation', () => {
  it('preserves all decisions through multiple merges', () => {
    const builder = new SummaryBuilder()

    const summary1 = makeSummary({
      decisionsMade: [
        {
          description: 'Use JWT for auth',
          rationale: 'Stateless API architecture',
          alternatives: ['Session cookies'],
          madeAt: 1000,
        },
      ],
    })

    const summary2 = makeSummary({
      decisionsMade: [
        {
          description: 'Use bcrypt for hashing',
          rationale: 'Battle-tested library',
          alternatives: ['argon2'],
          madeAt: 2000,
        },
      ],
    })

    const merged = builder.mergeSummaries(summary1, summary2)

    expect(merged.decisionsMade).toHaveLength(2)
    expect(merged.decisionsMade[0].description).toBe('Use JWT for auth')
    expect(merged.decisionsMade[1].description).toBe('Use bcrypt for hashing')
    // Alternatives should be preserved
    expect(merged.decisionsMade[0].alternatives).toContain('Session cookies')
  })

  it('maintains chronological ordering of decisions', () => {
    const builder = new SummaryBuilder()

    const summary1 = makeSummary({
      decisionsMade: [
        { description: 'Decision 1', rationale: 'R1', madeAt: 1000 },
        { description: 'Decision 2', rationale: 'R2', madeAt: 2000 },
      ],
    })

    const summary2 = makeSummary({
      decisionsMade: [
        { description: 'Decision 3', rationale: 'R3', madeAt: 3000 },
      ],
    })

    const merged = builder.mergeSummaries(summary1, summary2)
    const timestamps = merged.decisionsMade.map(d => d.madeAt)
    expect(timestamps).toEqual([1000, 2000, 3000])
  })
})
