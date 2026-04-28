/**
 * Eval rubric harness tests
 *
 * REN-1325: Tests the evaluatePrompt harness and stub adapter.
 * No live LLM calls — all tests use createStubAdapter / createFixedAdapter.
 *
 * Coverage:
 * - Perfect match (actual === golden): score = 1.0
 * - Empty golden + empty actual: score = 1.0
 * - Empty golden + non-empty actual: precision = 0 → low score
 * - Non-empty golden + empty actual: recall = 0 → low score
 * - Partial precision/recall: intermediate scores
 * - Confidence out-of-range: calibration penalty
 * - Parse failure (model returns non-JSON): score = 0
 * - createStubAdapter routes correctly
 * - createFixedAdapter always returns the fixed response
 */

import { describe, it, expect } from 'vitest'
import {
  evaluatePrompt,
  createStubAdapter,
  createFixedAdapter,
  type EvalScore,
} from './eval.js'
import { promptRegistry } from './prompts/index.js'
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
  FIXTURE_EMPTY_STREAM_GOLDEN_PATTERNS,
} from './__fixtures__/observation-streams.js'

// ---------------------------------------------------------------------------
// Helper: eval with fixed output
// ---------------------------------------------------------------------------

async function evalWithOutput(
  promptFamily: 'patternExtraction' | 'conventionIdentification' | 'decisionRecording',
  observationsInput: typeof FIXTURE_AUTH_STREAM_INPUT,
  golden: typeof FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS,
  outputJson: string,
): Promise<EvalScore> {
  const adapter = createFixedAdapter(outputJson)
  const prompt = promptRegistry[promptFamily].v1
  return evaluatePrompt(
    prompt,
    { observations: observationsInput },
    golden,
    adapter,
  )
}

// ---------------------------------------------------------------------------
// Pattern extraction eval
// ---------------------------------------------------------------------------

describe('evaluatePrompt — pattern extraction', () => {
  it('perfect match returns score close to 1.0', async () => {
    const golden = FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS
    const adapter = createFixedAdapter(JSON.stringify(golden))
    const result = await evaluatePrompt(
      promptRegistry.patternExtraction.v1,
      { observations: FIXTURE_AUTH_STREAM_INPUT },
      golden,
      adapter,
    )
    expect(result.structuralValidity).toBe(1.0)
    expect(result.precision).toBeGreaterThan(0.8)
    expect(result.recall).toBeGreaterThan(0.8)
    expect(result.f1).toBeGreaterThan(0.8)
    expect(result.score).toBeGreaterThan(0.7)
    expect(result.errors).toHaveLength(0)
  })

  it('empty golden + empty actual → score = 1.0', async () => {
    const adapter = createFixedAdapter('[]')
    const result = await evaluatePrompt(
      promptRegistry.patternExtraction.v1,
      { observations: FIXTURE_EMPTY_STREAM_INPUT },
      FIXTURE_EMPTY_STREAM_GOLDEN_PATTERNS,
      adapter,
    )
    expect(result.score).toBe(1.0)
    expect(result.precision).toBe(1.0)
    expect(result.recall).toBe(1.0)
  })

  it('empty golden + non-empty actual → precision = 0', async () => {
    // Model returns output when golden says nothing should be found.
    // Precision = 0 (the key invariant). Score > 0 because other dimensions
    // (recall=1.0 on empty golden, structural validity, kind correctness)
    // still contribute positively — this is expected behavior.
    const adapter = createFixedAdapter(JSON.stringify(FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS))
    const result = await evaluatePrompt(
      promptRegistry.patternExtraction.v1,
      { observations: FIXTURE_AUTH_STREAM_INPUT },
      [], // empty golden
      adapter,
    )
    expect(result.precision).toBe(0.0)
    expect(result.recall).toBe(1.0)  // recall on empty golden is trivially 1.0
    expect(result.goldenCount).toBe(0)
    expect(result.actualCount).toBeGreaterThan(0)
  })

  it('non-empty golden + empty actual → recall = 0', async () => {
    const adapter = createFixedAdapter('[]')
    const result = await evaluatePrompt(
      promptRegistry.patternExtraction.v1,
      { observations: FIXTURE_AUTH_STREAM_INPUT },
      FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS,
      adapter,
    )
    expect(result.recall).toBe(0.0)
    expect(result.actualCount).toBe(0)
    expect(result.goldenCount).toBe(FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS.length)
  })

  it('unparseable model output → score = 0 and errors populated', async () => {
    const adapter = createFixedAdapter('This is not JSON at all!')
    const result = await evaluatePrompt(
      promptRegistry.patternExtraction.v1,
      { observations: FIXTURE_AUTH_STREAM_INPUT },
      FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS,
      adapter,
    )
    expect(result.score).toBe(0)
    expect(result.structuralValidity).toBe(0)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('out-of-range confidence lowers calibration score', async () => {
    // Return observation with confidence > 0.95 to trigger validation error
    const badObs = JSON.stringify([
      { ...FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS[0], confidence: 0.99 },
    ])
    const adapter = createFixedAdapter(badObs)
    const result = await evaluatePrompt(
      promptRegistry.patternExtraction.v1,
      { observations: FIXTURE_AUTH_STREAM_INPUT },
      FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS,
      adapter,
    )
    // parseOutput throws for confidence > 0.95 → structural validity = 0
    expect(result.structuralValidity).toBe(0)
    expect(result.score).toBe(0)
  })

  it('goldenCount and actualCount are correct', async () => {
    const adapter = createFixedAdapter(JSON.stringify(FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS))
    const result = await evaluatePrompt(
      promptRegistry.patternExtraction.v1,
      { observations: FIXTURE_AUTH_STREAM_INPUT },
      FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS,
      adapter,
    )
    expect(result.actualCount).toBe(FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS.length)
    expect(result.goldenCount).toBe(FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS.length)
  })
})

// ---------------------------------------------------------------------------
// Convention identification eval
// ---------------------------------------------------------------------------

describe('evaluatePrompt — convention identification', () => {
  it('golden match returns high score', async () => {
    const adapter = createFixedAdapter(JSON.stringify(FIXTURE_RESULT_STREAM_GOLDEN_CONVENTIONS))
    const result = await evaluatePrompt(
      promptRegistry.conventionIdentification.v1,
      { observations: FIXTURE_RESULT_STREAM_INPUT },
      FIXTURE_RESULT_STREAM_GOLDEN_CONVENTIONS,
      adapter,
    )
    expect(result.score).toBeGreaterThan(0.7)
    expect(result.recall).toBe(1.0)
  })
})

// ---------------------------------------------------------------------------
// Decision recording eval
// ---------------------------------------------------------------------------

describe('evaluatePrompt — decision recording', () => {
  it('golden match returns high score', async () => {
    const adapter = createFixedAdapter(JSON.stringify(FIXTURE_DECISION_STREAM_GOLDEN_DECISIONS))
    const result = await evaluatePrompt(
      promptRegistry.decisionRecording.v1,
      { observations: FIXTURE_DECISION_STREAM_INPUT },
      FIXTURE_DECISION_STREAM_GOLDEN_DECISIONS,
      adapter,
    )
    expect(result.score).toBeGreaterThan(0.7)
  })
})

// ---------------------------------------------------------------------------
// Deviation detection eval
// ---------------------------------------------------------------------------

describe('evaluatePrompt — deviation detection', () => {
  it('golden match returns high score', async () => {
    const adapter = createFixedAdapter(
      JSON.stringify(FIXTURE_DEVIATION_STREAM_GOLDEN_DEVIATIONS),
    )
    const result = await evaluatePrompt(
      promptRegistry.deviationDetection.v1,
      {
        changeObservations: FIXTURE_DEVIATION_STREAM_INPUT,
        baseline: FIXTURE_DEVIATION_BASELINE,
      },
      FIXTURE_DEVIATION_STREAM_GOLDEN_DEVIATIONS,
      adapter,
    )
    expect(result.score).toBeGreaterThan(0.7)
  })
})

// ---------------------------------------------------------------------------
// createStubAdapter
// ---------------------------------------------------------------------------

describe('createStubAdapter', () => {
  it('routes by system prompt key', async () => {
    const patternResponse = JSON.stringify(FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS)
    const conventionResponse = JSON.stringify(FIXTURE_RESULT_STREAM_GOLDEN_CONVENTIONS)

    const adapter = createStubAdapter({
      'pattern': patternResponse,
      'convention': conventionResponse,
    })

    // Pattern prompt system message contains 'pattern'
    const respPattern = await adapter.complete(
      promptRegistry.patternExtraction.v1.SYSTEM_PROMPT,
      'irrelevant',
    )
    expect(respPattern).toBe(patternResponse)

    // Convention prompt system message contains 'convention'
    const respConvention = await adapter.complete(
      promptRegistry.conventionIdentification.v1.SYSTEM_PROMPT,
      'irrelevant',
    )
    expect(respConvention).toBe(conventionResponse)
  })

  it('returns default response when no key matches', async () => {
    const adapter = createStubAdapter({}, '[]')
    const resp = await adapter.complete('no match here', 'irrelevant')
    expect(resp).toBe('[]')
  })

  it('default response is [] when not provided', async () => {
    const adapter = createStubAdapter()
    const resp = await adapter.complete('anything', 'anything')
    expect(resp).toBe('[]')
  })
})

// ---------------------------------------------------------------------------
// createFixedAdapter
// ---------------------------------------------------------------------------

describe('createFixedAdapter', () => {
  it('always returns the fixed response', async () => {
    const adapter = createFixedAdapter('{"hello":"world"}')
    expect(await adapter.complete('sys', 'user')).toBe('{"hello":"world"}')
    expect(await adapter.complete('different sys', 'different user')).toBe('{"hello":"world"}')
  })
})

// ---------------------------------------------------------------------------
// EvalScore fields
// ---------------------------------------------------------------------------

describe('EvalScore shape', () => {
  it('all EvalScore fields are present on a successful eval', async () => {
    const adapter = createFixedAdapter(JSON.stringify(FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS))
    const result = await evaluatePrompt(
      promptRegistry.patternExtraction.v1,
      { observations: FIXTURE_AUTH_STREAM_INPUT },
      FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS,
      adapter,
    )

    // All fields must be present and numbers in valid ranges
    expect(typeof result.score).toBe('number')
    expect(typeof result.precision).toBe('number')
    expect(typeof result.recall).toBe('number')
    expect(typeof result.f1).toBe('number')
    expect(typeof result.confidenceCalibration).toBe('number')
    expect(typeof result.structuralValidity).toBe('number')
    expect(typeof result.kindCorrectness).toBe('number')
    expect(typeof result.actualCount).toBe('number')
    expect(typeof result.goldenCount).toBe('number')
    expect(Array.isArray(result.errors)).toBe(true)

    expect(result.score).toBeGreaterThanOrEqual(0)
    expect(result.score).toBeLessThanOrEqual(1)
    expect(result.precision).toBeGreaterThanOrEqual(0)
    expect(result.precision).toBeLessThanOrEqual(1)
    expect(result.recall).toBeGreaterThanOrEqual(0)
    expect(result.recall).toBeLessThanOrEqual(1)
  })
})
