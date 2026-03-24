import { describe, it, expect, vi } from 'vitest'

// Mock fs before importing modules that use it
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue('{}'),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

import { SummaryBuilder } from '../../orchestrator/summary-builder.js'
import { ContextManager } from '../../orchestrator/context-manager.js'
import { SUMMARY_SCHEMA_VERSION } from '../../orchestrator/state-types.js'
import {
  makeToolUse,
  makeAssistantText,
  makeEmptyArtifacts,
  makeSummary,
  generateSessionEvents,
} from './helpers.js'
import type { StructuredSummary } from '../../orchestrator/state-types.js'

describe('Regression — Multi-round compression', () => {
  it('maintains data integrity through 3 compression rounds', () => {
    const builder = new SummaryBuilder()

    // Round 1: Initial work
    const events1 = generateSessionEvents({ fileCount: 5, assistantMessages: 2 })
    const summary1 = builder.summarizeSpan(events1, null, makeEmptyArtifacts())

    expect(summary1.compactionCount).toBe(1)
    expect(summary1.fileModifications.length).toBeGreaterThan(0)

    // Round 2: More work
    const events2 = generateSessionEvents({ fileCount: 3, assistantMessages: 1 })
    const summary2 = builder.summarizeSpan(events2, summary1, makeEmptyArtifacts())
    const merged2 = builder.mergeSummaries(summary1, summary2)

    expect(merged2.compactionCount).toBe(2)
    // Should have files from both rounds
    expect(merged2.fileModifications.length).toBeGreaterThanOrEqual(
      summary1.fileModifications.length
    )

    // Round 3: Even more work
    const events3 = generateSessionEvents({ fileCount: 2, assistantMessages: 1 })
    const summary3 = builder.summarizeSpan(events3, merged2, makeEmptyArtifacts())
    const merged3 = builder.mergeSummaries(merged2, summary3)

    expect(merged3.compactionCount).toBe(3)
    // Session intent should still be present from round 1
    expect(merged3.sessionIntent.length).toBeGreaterThan(0)
  })

  it('does not lose decisions through repeated compression', () => {
    const builder = new SummaryBuilder()

    let current: StructuredSummary = makeSummary({
      decisionsMade: [
        { description: 'Initial decision', rationale: 'First reason', madeAt: 1000 },
      ],
      compactionCount: 0,
    })

    // Run 5 compression rounds, each adding a decision
    for (let i = 1; i <= 5; i++) {
      const incoming = makeSummary({
        decisionsMade: [
          { description: `Decision ${i}`, rationale: `Reason ${i}`, madeAt: i * 1000 },
        ],
        compactionCount: i,
      })
      current = builder.mergeSummaries(current, incoming)
    }

    // All 6 decisions should be preserved (1 initial + 5 rounds)
    expect(current.decisionsMade).toHaveLength(6)
    expect(current.decisionsMade[0].description).toBe('Initial decision')
    expect(current.decisionsMade[5].description).toBe('Decision 5')
  })

  it('file deduplication works across many rounds', () => {
    const builder = new SummaryBuilder()

    let current = makeSummary({
      fileModifications: [
        { path: '/src/main.ts', action: 'modified', reason: 'Initial change', lastModifiedAt: 1000 },
      ],
    })

    // Modify the same file across 5 rounds
    for (let i = 1; i <= 5; i++) {
      const incoming = makeSummary({
        fileModifications: [
          { path: '/src/main.ts', action: 'modified', reason: `Change ${i}`, lastModifiedAt: i * 1000 },
        ],
        compactionCount: i,
      })
      current = builder.mergeSummaries(current, incoming)
    }

    // Should have exactly 1 entry for /src/main.ts (deduplicated)
    const mainFiles = current.fileModifications.filter(m => m.path === '/src/main.ts')
    expect(mainFiles).toHaveLength(1)
    // Should have the latest action
    expect(mainFiles[0].lastModifiedAt).toBe(5000)
    // Reason should be merged
    expect(mainFiles[0].reason.length).toBeGreaterThan(10)
  })

  it('compaction count tracks correctly through many rounds', () => {
    const builder = new SummaryBuilder()

    let current = makeSummary({ compactionCount: 0 })

    for (let i = 1; i <= 10; i++) {
      const incoming = makeSummary({ compactionCount: i })
      current = builder.mergeSummaries(current, incoming)
    }

    expect(current.compactionCount).toBe(10)
  })
})

describe('Regression — Context injection format', () => {
  it('prompt section does not contain anxiety-inducing language', () => {
    const builder = new SummaryBuilder()
    const summary = makeSummary({
      sessionIntent: 'Test the feature',
      compactionCount: 5,
      tokenEstimate: 10000,
      fileModifications: [
        { path: '/src/test.ts', action: 'modified', reason: 'Updated', lastModifiedAt: 1000 },
      ],
    })

    const output = builder.toPromptSection(summary, makeEmptyArtifacts())

    // Should NOT contain any anxiety triggers
    const anxietyTerms = [
      'compaction', 'compressed', 'token', 'limit',
      'running out', 'approaching', 'truncated',
    ]
    for (const term of anxietyTerms) {
      expect(output.toLowerCase()).not.toContain(term)
    }
  })

  it('prompt section is well-structured with XML tags', () => {
    const builder = new SummaryBuilder()
    const summary = makeSummary({
      sessionIntent: 'Implement feature',
      fileModifications: [
        { path: '/src/a.ts', action: 'created', reason: 'New file', lastModifiedAt: 1000 },
      ],
      decisionsMade: [
        { description: 'Use TypeScript', rationale: 'Type safety', madeAt: 1000 },
      ],
      nextSteps: ['Write tests'],
    })

    const output = builder.toPromptSection(summary, makeEmptyArtifacts())

    expect(output).toContain('<context-summary>')
    expect(output).toContain('</context-summary>')
    expect(output).toContain('## Session Intent')
    expect(output).toContain('## Files Modified')
    expect(output).toContain('## Key Decisions')
    expect(output).toContain('## Next Steps')
  })
})

describe('Regression — ContextManager end-to-end', () => {
  it('processes events and generates summary on compaction', () => {
    const manager = new ContextManager({ worktreeRoot: '/tmp/test' })

    // Simulate a session
    manager.processEvent(makeAssistantText(
      'I will implement the authentication system with JWT tokens for secure API access.'
    ))
    manager.processEvent(makeToolUse('Read', { file_path: '/tmp/test/src/auth.ts' }))
    manager.processEvent(makeToolUse('Edit', { file_path: '/tmp/test/src/auth.ts' }))
    manager.processEvent(makeToolUse('Write', { file_path: '/tmp/test/src/middleware.ts' }))

    // Trigger compaction
    manager.handleCompaction()

    // Verify summary was generated
    const summary = manager.getSummary()
    expect(summary).not.toBeNull()
    expect(summary!.fileModifications.length).toBeGreaterThan(0)

    // Verify artifact index tracks files
    const index = manager.getArtifactIndex()
    expect(Object.keys(index.files).length).toBeGreaterThan(0)

    // Verify context section is non-empty
    const section = manager.getContextSection()
    expect(section.length).toBeGreaterThan(0)
    expect(section).toContain('<context-summary>')
  })
})
