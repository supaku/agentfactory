import { describe, it, expect } from 'vitest'
import { SummaryBuilder } from './summary-builder.js'
import type { AgentEvent, AgentToolUseEvent, AgentAssistantTextEvent } from '../providers/types.js'
import type { StructuredSummary } from './state-types.js'
import { SUMMARY_SCHEMA_VERSION } from './state-types.js'
import type { ArtifactIndex } from './artifact-tracker.js'

function makeToolUse(toolName: string, input: Record<string, unknown>): AgentToolUseEvent {
  return { type: 'tool_use', toolName, input, raw: {} }
}

function makeAssistantText(text: string): AgentAssistantTextEvent {
  return { type: 'assistant_text', text, raw: {} }
}

function makeEmptyArtifacts(): ArtifactIndex {
  return { files: {}, totalReads: 0, totalWrites: 0, lastUpdatedAt: 0 }
}

function makeSummary(overrides: Partial<StructuredSummary> = {}): StructuredSummary {
  return {
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    sessionIntent: 'Test session intent',
    fileModifications: [],
    decisionsMade: [],
    nextSteps: [],
    compactionCount: 1,
    lastCompactedAt: 1000,
    tokenEstimate: 100,
    ...overrides,
  }
}

describe('SummaryBuilder — summarizeSpan', () => {
  it('extracts file modifications from tool_use events', () => {
    const builder = new SummaryBuilder()
    const events: AgentEvent[] = [
      makeToolUse('Read', { file_path: '/src/foo.ts' }),
      makeToolUse('Edit', { file_path: '/src/bar.ts' }),
      makeToolUse('Write', { file_path: '/src/new.ts' }),
    ]

    const summary = builder.summarizeSpan(events, null, makeEmptyArtifacts())
    expect(summary.fileModifications).toHaveLength(3)
    expect(summary.fileModifications.map(m => m.action)).toEqual(['read', 'modified', 'created'])
  })

  it('extracts session intent from assistant text', () => {
    const builder = new SummaryBuilder()
    const events: AgentEvent[] = [
      makeAssistantText('I will implement the authentication system for the admin dashboard. This involves creating JWT tokens and middleware.'),
    ]

    const summary = builder.summarizeSpan(events, null, makeEmptyArtifacts())
    expect(summary.sessionIntent).toContain('authentication system')
  })

  it('preserves existing session intent when no new intent found', () => {
    const builder = new SummaryBuilder()
    const existing = makeSummary({ sessionIntent: 'Original intent' })
    const events: AgentEvent[] = [
      makeToolUse('Read', { file_path: '/src/foo.ts' }),
    ]

    const summary = builder.summarizeSpan(events, existing, makeEmptyArtifacts())
    expect(summary.sessionIntent).toBe('Original intent')
  })

  it('increments compaction count from existing summary', () => {
    const builder = new SummaryBuilder()
    const existing = makeSummary({ compactionCount: 2 })

    const summary = builder.summarizeSpan([], existing, makeEmptyArtifacts())
    expect(summary.compactionCount).toBe(3)
  })

  it('starts compaction count at 1 when no existing summary', () => {
    const builder = new SummaryBuilder()
    const summary = builder.summarizeSpan([], null, makeEmptyArtifacts())
    expect(summary.compactionCount).toBe(1)
  })

  it('estimates token count', () => {
    const builder = new SummaryBuilder()
    const summary = builder.summarizeSpan([], null, makeEmptyArtifacts())
    expect(summary.tokenEstimate).toBeGreaterThan(0)
  })

  it('deduplicates file modifications for same path', () => {
    const builder = new SummaryBuilder()
    const events: AgentEvent[] = [
      makeToolUse('Read', { file_path: '/src/foo.ts' }),
      makeToolUse('Edit', { file_path: '/src/foo.ts' }),
    ]

    const summary = builder.summarizeSpan(events, null, makeEmptyArtifacts())
    expect(summary.fileModifications).toHaveLength(1)
    expect(summary.fileModifications[0].action).toBe('modified') // Latest action wins
  })
})

describe('SummaryBuilder — mergeSummaries', () => {
  it('keeps existing session intent when incoming is empty', () => {
    const builder = new SummaryBuilder()
    const existing = makeSummary({ sessionIntent: 'Original intent' })
    const incoming = makeSummary({ sessionIntent: '' })

    const merged = builder.mergeSummaries(existing, incoming)
    expect(merged.sessionIntent).toBe('Original intent')
  })

  it('uses incoming session intent when provided', () => {
    const builder = new SummaryBuilder()
    const existing = makeSummary({ sessionIntent: 'Old intent' })
    const incoming = makeSummary({ sessionIntent: 'New intent' })

    const merged = builder.mergeSummaries(existing, incoming)
    expect(merged.sessionIntent).toBe('New intent')
  })

  it('unions file modifications by path', () => {
    const builder = new SummaryBuilder()
    const existing = makeSummary({
      fileModifications: [
        { path: '/src/a.ts', action: 'read', reason: 'Initial read', lastModifiedAt: 1000 },
      ],
    })
    const incoming = makeSummary({
      fileModifications: [
        { path: '/src/a.ts', action: 'modified', reason: 'Updated logic', lastModifiedAt: 2000 },
        { path: '/src/b.ts', action: 'created', reason: 'New file', lastModifiedAt: 2000 },
      ],
    })

    const merged = builder.mergeSummaries(existing, incoming)
    expect(merged.fileModifications).toHaveLength(2)

    const fileA = merged.fileModifications.find(m => m.path === '/src/a.ts')
    expect(fileA?.action).toBe('modified')
    expect(fileA?.reason).toContain('Initial read')
    expect(fileA?.reason).toContain('Updated logic')
    expect(fileA?.lastModifiedAt).toBe(2000)
  })

  it('appends decisions chronologically', () => {
    const builder = new SummaryBuilder()
    const existing = makeSummary({
      decisionsMade: [
        { description: 'First decision', rationale: 'Because', madeAt: 1000 },
      ],
    })
    const incoming = makeSummary({
      decisionsMade: [
        { description: 'Second decision', rationale: 'Also because', madeAt: 2000 },
      ],
    })

    const merged = builder.mergeSummaries(existing, incoming)
    expect(merged.decisionsMade).toHaveLength(2)
    expect(merged.decisionsMade[0].description).toBe('First decision')
    expect(merged.decisionsMade[1].description).toBe('Second decision')
  })

  it('merges next steps, removing duplicates', () => {
    const builder = new SummaryBuilder()
    const existing = makeSummary({ nextSteps: ['Step A', 'Step B'] })
    const incoming = makeSummary({ nextSteps: ['Step C'] })

    const merged = builder.mergeSummaries(existing, incoming)
    expect(merged.nextSteps).toContain('Step A')
    expect(merged.nextSteps).toContain('Step B')
    expect(merged.nextSteps).toContain('Step C')
  })

  it('uses incoming compaction count', () => {
    const builder = new SummaryBuilder()
    const existing = makeSummary({ compactionCount: 2 })
    const incoming = makeSummary({ compactionCount: 3 })

    const merged = builder.mergeSummaries(existing, incoming)
    expect(merged.compactionCount).toBe(3)
  })
})

describe('SummaryBuilder — toPromptSection', () => {
  it('generates context-summary tags', () => {
    const builder = new SummaryBuilder()
    const summary = makeSummary()
    const output = builder.toPromptSection(summary, makeEmptyArtifacts())

    expect(output).toContain('<context-summary>')
    expect(output).toContain('</context-summary>')
  })

  it('includes session intent', () => {
    const builder = new SummaryBuilder()
    const summary = makeSummary({ sessionIntent: 'Implement auth flow' })

    const output = builder.toPromptSection(summary, makeEmptyArtifacts())
    expect(output).toContain('## Session Intent')
    expect(output).toContain('Implement auth flow')
  })

  it('includes file modifications', () => {
    const builder = new SummaryBuilder()
    const summary = makeSummary({
      fileModifications: [
        { path: 'src/auth.ts', action: 'created', reason: 'New auth module', lastModifiedAt: 1000 },
      ],
    })

    const output = builder.toPromptSection(summary, makeEmptyArtifacts())
    expect(output).toContain('## Files Modified')
    expect(output).toContain('src/auth.ts')
    expect(output).toContain('Created')
  })

  it('includes decisions with alternatives', () => {
    const builder = new SummaryBuilder()
    const summary = makeSummary({
      decisionsMade: [
        {
          description: 'Use JWT',
          rationale: 'Stateless API',
          alternatives: ['session cookies'],
          madeAt: 1000,
        },
      ],
    })

    const output = builder.toPromptSection(summary, makeEmptyArtifacts())
    expect(output).toContain('## Key Decisions')
    expect(output).toContain('Use JWT')
    expect(output).toContain('Stateless API')
    expect(output).toContain('rejected: session cookies')
  })

  it('includes next steps as checklist', () => {
    const builder = new SummaryBuilder()
    const summary = makeSummary({ nextSteps: ['Write tests', 'Deploy'] })

    const output = builder.toPromptSection(summary, makeEmptyArtifacts())
    expect(output).toContain('## Next Steps')
    expect(output).toContain('- [ ] Write tests')
    expect(output).toContain('- [ ] Deploy')
  })

  it('includes tracked files from artifact index', () => {
    const builder = new SummaryBuilder()
    const summary = makeSummary()
    const artifacts: ArtifactIndex = {
      files: {
        '/abs/src/foo.ts': {
          path: '/abs/src/foo.ts',
          relativePath: 'src/foo.ts',
          actions: ['modified'],
          firstSeenAt: 1000,
          lastTouchedAt: 2000,
        },
      },
      totalReads: 0,
      totalWrites: 1,
      lastUpdatedAt: 2000,
    }

    const output = builder.toPromptSection(summary, artifacts)
    expect(output).toContain('## Tracked Files')
    expect(output).toContain('src/foo.ts')
  })

  it('does not expose token counts or compaction count (context anxiety prevention)', () => {
    const builder = new SummaryBuilder()
    const summary = makeSummary({ compactionCount: 5, tokenEstimate: 5000 })

    const output = builder.toPromptSection(summary, makeEmptyArtifacts())
    expect(output).not.toContain('5000')
    expect(output).not.toContain('compaction')
    expect(output).not.toContain('token')
    expect(output).not.toContain('compressed')
    expect(output).not.toContain('limit')
  })
})
