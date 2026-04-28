/**
 * Prompt template regression tests
 *
 * REN-1325: Tests all four v1 prompt templates against canonical fixture inputs.
 * No live LLM calls — all tests use deterministic in-memory responses.
 *
 * Coverage:
 * - System prompt content (schema instructions present)
 * - buildUserPrompt: correct observation count, context line inclusion
 * - parseOutput: valid JSON → typed ArchObservation[]
 * - parseOutput: invalid JSON → descriptive error
 * - parseOutput: wrong kind → error
 * - parseOutput: confidence > 0.95 → error
 * - parseOutput: missing payload fields → error
 * - Registry: currentPrompt() returns v1; versionedPrompt() resolves correctly
 * - Registry: unknown version → throws
 * - Prompt version metadata is correct
 */

import { describe, it, expect } from 'vitest'
import {
  promptRegistry,
  currentPrompt,
  versionedPrompt,
  CURRENT_PROMPT_VERSION,
} from './index.js'
import {
  FIXTURE_AUTH_STREAM_INPUT,
  FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS,
  FIXTURE_RESULT_STREAM_INPUT,
  FIXTURE_RESULT_STREAM_GOLDEN_CONVENTIONS,
  FIXTURE_DECISION_STREAM_INPUT,
  FIXTURE_DECISION_STREAM_GOLDEN_DECISIONS,
  FIXTURE_DEVIATION_STREAM_INPUT,
  FIXTURE_DEVIATION_STREAM_GOLDEN_DEVIATIONS,
  FIXTURE_DEVIATION_BASELINE,
  FIXTURE_EMPTY_STREAM_INPUT,
} from '../__fixtures__/observation-streams.js'
import type { ArchObservation } from '../types.js'
import { PROJECT_SCOPE_FOR_TEST } from './__test-helpers__.js'

// ---------------------------------------------------------------------------
// Pattern extraction prompt
// ---------------------------------------------------------------------------

describe('prompts/v1/pattern-extraction', () => {
  const prompt = promptRegistry.patternExtraction.v1

  it('has correct PROMPT_VERSION and PROMPT_KIND', () => {
    expect(prompt.PROMPT_VERSION).toBe('1.0.0')
    expect(prompt.PROMPT_KIND).toBe('pattern-extraction')
  })

  it('SYSTEM_PROMPT contains schema instructions', () => {
    expect(prompt.SYSTEM_PROMPT).toContain('ArchObservation')
    expect(prompt.SYSTEM_PROMPT).toContain('"kind": "pattern"')
    expect(prompt.SYSTEM_PROMPT).toContain('confidence')
    expect(prompt.SYSTEM_PROMPT).toContain('0.95')
  })

  it('buildUserPrompt includes observation count', () => {
    const userPrompt = prompt.buildUserPrompt({ observations: FIXTURE_AUTH_STREAM_INPUT })
    expect(userPrompt).toContain('3 raw architectural observation')
  })

  it('buildUserPrompt includes projectContext when provided', () => {
    const userPrompt = prompt.buildUserPrompt({
      observations: FIXTURE_AUTH_STREAM_INPUT,
      projectContext: 'Next.js + tRPC + Drizzle',
    })
    expect(userPrompt).toContain('Next.js + tRPC + Drizzle')
  })

  it('buildUserPrompt handles empty stream', () => {
    const userPrompt = prompt.buildUserPrompt({ observations: [] })
    expect(userPrompt).toContain('0 raw architectural observation')
  })

  it('parseOutput accepts golden pattern array', () => {
    const raw = JSON.stringify(FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS)
    const parsed = prompt.parseOutput(raw)
    expect(parsed).toHaveLength(FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS.length)
    expect(parsed[0]!.kind).toBe('pattern')
  })

  it('parseOutput rejects non-JSON', () => {
    expect(() => prompt.parseOutput('not json')).toThrow(/not valid JSON/)
  })

  it('parseOutput rejects non-array JSON', () => {
    expect(() => prompt.parseOutput('{"kind":"pattern"}')).toThrow(/Expected JSON array/)
  })

  it('parseOutput rejects wrong kind', () => {
    const badObs = [{ ...FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS[0], kind: 'convention' }]
    expect(() => prompt.parseOutput(JSON.stringify(badObs))).toThrow(/kind.*must be "pattern"/)
  })

  it('parseOutput rejects confidence > 0.95', () => {
    const badObs: ArchObservation[] = [
      { ...FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS[0]!, confidence: 0.99 },
    ]
    expect(() => prompt.parseOutput(JSON.stringify(badObs))).toThrow(/confidence.*0.95/)
  })

  it('parseOutput rejects missing title', () => {
    const badObs = [
      {
        ...FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS[0],
        payload: { ...FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS[0]!.payload as object, title: '' },
      },
    ]
    expect(() => prompt.parseOutput(JSON.stringify(badObs))).toThrow(/title/)
  })

  it('parseOutput rejects missing locations', () => {
    const badObs = [
      {
        ...FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS[0],
        payload: {
          ...(FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS[0]!.payload as object),
          locations: 'not-array',
        },
      },
    ]
    expect(() => prompt.parseOutput(JSON.stringify(badObs))).toThrow(/locations/)
  })

  it('parseOutput accepts empty array', () => {
    const parsed = prompt.parseOutput('[]')
    expect(parsed).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Convention identification prompt
// ---------------------------------------------------------------------------

describe('prompts/v1/convention-identification', () => {
  const prompt = promptRegistry.conventionIdentification.v1

  it('has correct PROMPT_VERSION and PROMPT_KIND', () => {
    expect(prompt.PROMPT_VERSION).toBe('1.0.0')
    expect(prompt.PROMPT_KIND).toBe('convention-identification')
  })

  it('SYSTEM_PROMPT contains authored field instruction', () => {
    expect(prompt.SYSTEM_PROMPT).toContain('authored')
    expect(prompt.SYSTEM_PROMPT).toContain('CLAUDE.md')
  })

  it('buildUserPrompt includes observation count', () => {
    const userPrompt = prompt.buildUserPrompt({ observations: FIXTURE_RESULT_STREAM_INPUT })
    expect(userPrompt).toContain('2 raw architectural observation')
  })

  it('parseOutput accepts golden convention array', () => {
    const raw = JSON.stringify(FIXTURE_RESULT_STREAM_GOLDEN_CONVENTIONS)
    const parsed = prompt.parseOutput(raw)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.kind).toBe('convention')
  })

  it('parseOutput rejects wrong kind', () => {
    const badObs = [{ ...FIXTURE_RESULT_STREAM_GOLDEN_CONVENTIONS[0], kind: 'pattern' }]
    expect(() => prompt.parseOutput(JSON.stringify(badObs))).toThrow(/kind.*must be "convention"/)
  })

  it('parseOutput rejects missing authored field', () => {
    const badObs = [
      {
        ...FIXTURE_RESULT_STREAM_GOLDEN_CONVENTIONS[0],
        payload: {
          ...(FIXTURE_RESULT_STREAM_GOLDEN_CONVENTIONS[0]!.payload as object),
          authored: 'yes',
        },
      },
    ]
    expect(() => prompt.parseOutput(JSON.stringify(badObs))).toThrow(/authored/)
  })

  it('parseOutput rejects missing examples', () => {
    const badObs = [
      {
        ...FIXTURE_RESULT_STREAM_GOLDEN_CONVENTIONS[0],
        payload: {
          ...(FIXTURE_RESULT_STREAM_GOLDEN_CONVENTIONS[0]!.payload as object),
          examples: 'not-array',
        },
      },
    ]
    expect(() => prompt.parseOutput(JSON.stringify(badObs))).toThrow(/examples/)
  })

  it('parseOutput accepts empty array', () => {
    expect(prompt.parseOutput('[]')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Decision recording prompt
// ---------------------------------------------------------------------------

describe('prompts/v1/decision-recording', () => {
  const prompt = promptRegistry.decisionRecording.v1

  it('has correct PROMPT_VERSION and PROMPT_KIND', () => {
    expect(prompt.PROMPT_VERSION).toBe('1.0.0')
    expect(prompt.PROMPT_KIND).toBe('decision-recording')
  })

  it('SYSTEM_PROMPT contains ADR-style keywords', () => {
    expect(prompt.SYSTEM_PROMPT).toContain('chose X over Y')
    expect(prompt.SYSTEM_PROMPT).toContain('rationale')
    expect(prompt.SYSTEM_PROMPT).toContain('status')
  })

  it('buildUserPrompt includes observation count', () => {
    const userPrompt = prompt.buildUserPrompt({ observations: FIXTURE_DECISION_STREAM_INPUT })
    expect(userPrompt).toContain('1 raw architectural observation')
  })

  it('parseOutput accepts golden decision array', () => {
    const raw = JSON.stringify(FIXTURE_DECISION_STREAM_GOLDEN_DECISIONS)
    const parsed = prompt.parseOutput(raw)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.kind).toBe('decision')
    const payload = parsed[0]!.payload as Record<string, unknown>
    expect(payload['chosen']).toBe('Drizzle ORM')
  })

  it('parseOutput rejects wrong status', () => {
    const badObs = [
      {
        ...FIXTURE_DECISION_STREAM_GOLDEN_DECISIONS[0],
        payload: {
          ...(FIXTURE_DECISION_STREAM_GOLDEN_DECISIONS[0]!.payload as object),
          status: 'pending',
        },
      },
    ]
    expect(() => prompt.parseOutput(JSON.stringify(badObs))).toThrow(/status/)
  })

  it('parseOutput rejects missing rationale', () => {
    const badObs = [
      {
        ...FIXTURE_DECISION_STREAM_GOLDEN_DECISIONS[0],
        payload: {
          ...(FIXTURE_DECISION_STREAM_GOLDEN_DECISIONS[0]!.payload as object),
          rationale: '',
        },
      },
    ]
    expect(() => prompt.parseOutput(JSON.stringify(badObs))).toThrow(/rationale/)
  })

  it('parseOutput rejects missing chosen', () => {
    const badObs = [
      {
        ...FIXTURE_DECISION_STREAM_GOLDEN_DECISIONS[0],
        payload: {
          ...(FIXTURE_DECISION_STREAM_GOLDEN_DECISIONS[0]!.payload as object),
          chosen: '',
        },
      },
    ]
    expect(() => prompt.parseOutput(JSON.stringify(badObs))).toThrow(/chosen/)
  })
})

// ---------------------------------------------------------------------------
// Deviation detection prompt
// ---------------------------------------------------------------------------

describe('prompts/v1/deviation-detection', () => {
  const prompt = promptRegistry.deviationDetection.v1

  it('has correct PROMPT_VERSION and PROMPT_KIND', () => {
    expect(prompt.PROMPT_VERSION).toBe('1.0.0')
    expect(prompt.PROMPT_KIND).toBe('deviation-detection')
  })

  it('SYSTEM_PROMPT contains severity and deviatesFrom instructions', () => {
    expect(prompt.SYSTEM_PROMPT).toContain('severity')
    expect(prompt.SYSTEM_PROMPT).toContain('deviatesFrom')
    expect(prompt.SYSTEM_PROMPT).toContain('BASELINE')
  })

  it('buildUserPrompt includes both baseline and observation counts', () => {
    const userPrompt = prompt.buildUserPrompt({
      changeObservations: FIXTURE_DEVIATION_STREAM_INPUT,
      baseline: FIXTURE_DEVIATION_BASELINE,
    })
    expect(userPrompt).toContain('2 entries') // baseline
    expect(userPrompt).toContain('1 entries') // change observations
  })

  it('parseOutput accepts golden deviation array', () => {
    const raw = JSON.stringify(FIXTURE_DEVIATION_STREAM_GOLDEN_DEVIATIONS)
    const parsed = prompt.parseOutput(raw)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.kind).toBe('deviation')
    const payload = parsed[0]!.payload as Record<string, unknown>
    expect(payload['severity']).toBe('high')
    const deviatesFrom = payload['deviatesFrom'] as Record<string, unknown>
    expect(deviatesFrom['kind']).toBe('pattern')
  })

  it('parseOutput rejects invalid severity', () => {
    const badObs = [
      {
        ...FIXTURE_DEVIATION_STREAM_GOLDEN_DEVIATIONS[0],
        payload: {
          ...(FIXTURE_DEVIATION_STREAM_GOLDEN_DEVIATIONS[0]!.payload as object),
          severity: 'critical',
        },
      },
    ]
    expect(() => prompt.parseOutput(JSON.stringify(badObs))).toThrow(/severity/)
  })

  it('parseOutput rejects missing deviatesFrom.id', () => {
    const badObs = [
      {
        ...FIXTURE_DEVIATION_STREAM_GOLDEN_DEVIATIONS[0],
        payload: {
          ...(FIXTURE_DEVIATION_STREAM_GOLDEN_DEVIATIONS[0]!.payload as object),
          deviatesFrom: { kind: 'pattern', id: '' },
        },
      },
    ]
    expect(() => prompt.parseOutput(JSON.stringify(badObs))).toThrow(/deviatesFrom.id/)
  })

  it('parseOutput rejects invalid deviatesFrom.kind', () => {
    const badObs = [
      {
        ...FIXTURE_DEVIATION_STREAM_GOLDEN_DEVIATIONS[0],
        payload: {
          ...(FIXTURE_DEVIATION_STREAM_GOLDEN_DEVIATIONS[0]!.payload as object),
          deviatesFrom: { kind: 'unknown', id: 'some-id' },
        },
      },
    ]
    expect(() => prompt.parseOutput(JSON.stringify(badObs))).toThrow(/deviatesFrom.kind/)
  })
})

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe('promptRegistry', () => {
  it('CURRENT_PROMPT_VERSION is v1', () => {
    expect(CURRENT_PROMPT_VERSION).toBe('v1')
  })

  it('currentPrompt(patternExtraction) returns v1 module', () => {
    const p = currentPrompt('patternExtraction')
    expect(p.PROMPT_VERSION).toBe('1.0.0')
    expect(p.PROMPT_KIND).toBe('pattern-extraction')
  })

  it('currentPrompt(conventionIdentification) returns v1 module', () => {
    const p = currentPrompt('conventionIdentification')
    expect(p.PROMPT_KIND).toBe('convention-identification')
  })

  it('currentPrompt(decisionRecording) returns v1 module', () => {
    const p = currentPrompt('decisionRecording')
    expect(p.PROMPT_KIND).toBe('decision-recording')
  })

  it('currentPrompt(deviationDetection) returns v1 module', () => {
    const p = currentPrompt('deviationDetection')
    expect(p.PROMPT_KIND).toBe('deviation-detection')
  })

  it('versionedPrompt resolves v1 correctly', () => {
    const p = versionedPrompt('patternExtraction', 'v1')
    expect(p.PROMPT_VERSION).toBe('1.0.0')
  })

  it('versionedPrompt throws for unknown version', () => {
    // @ts-expect-error intentional invalid version
    expect(() => versionedPrompt('patternExtraction', 'v99')).toThrow(/No prompt registered/)
  })

  it('promptRegistry has all four families', () => {
    expect(Object.keys(promptRegistry)).toContain('patternExtraction')
    expect(Object.keys(promptRegistry)).toContain('conventionIdentification')
    expect(Object.keys(promptRegistry)).toContain('decisionRecording')
    expect(Object.keys(promptRegistry)).toContain('deviationDetection')
  })

  it('each family has v1', () => {
    for (const family of Object.values(promptRegistry)) {
      expect(family['v1']).toBeDefined()
    }
  })
})

// ---------------------------------------------------------------------------
// Cross-prompt: empty stream
// ---------------------------------------------------------------------------

describe('all prompts: empty stream', () => {
  it('pattern extraction handles empty stream in userPrompt', () => {
    const p = promptRegistry.patternExtraction.v1
    const up = p.buildUserPrompt({ observations: FIXTURE_EMPTY_STREAM_INPUT })
    expect(up).toContain('0 raw architectural observation')
  })

  it('parseOutput([]) returns [] for all four prompts', () => {
    for (const family of Object.values(promptRegistry)) {
      const p = family['v1']!
      expect(p.parseOutput('[]')).toEqual([])
    }
  })
})
