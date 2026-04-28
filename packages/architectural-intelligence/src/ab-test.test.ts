/**
 * A/B testing harness tests
 *
 * REN-1325: Tests compareABPrompts and formatABReport.
 * No live LLM calls — uses createFixedAdapter / createStubAdapter.
 *
 * Coverage:
 * - A wins when B returns empty, A returns golden
 * - B wins when A returns empty, B returns golden
 * - Tie when both return identical outputs
 * - Multi-input: aggregate summary fields
 * - formatABReport: contains key fields
 * - Error handling: inputs/goldenOutputs length mismatch
 * - Error handling: empty inputs
 */

import { describe, it, expect } from 'vitest'
import { compareABPrompts, formatABReport } from './ab-test.js'
import { createFixedAdapter } from './eval.js'
import { promptRegistry } from './prompts/index.js'
import {
  FIXTURE_AUTH_STREAM_INPUT,
  FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS,
  FIXTURE_RESULT_STREAM_INPUT,
  FIXTURE_RESULT_STREAM_GOLDEN_CONVENTIONS,
} from './__fixtures__/observation-streams.js'

const promptA = promptRegistry.patternExtraction.v1
// Simulate a "v2" by reusing the same prompt module — differences come from adapter responses
const promptB = promptRegistry.patternExtraction.v1

// ---------------------------------------------------------------------------
// Basic A vs B
// ---------------------------------------------------------------------------

describe('compareABPrompts — basic comparison', () => {
  it('A wins when B returns empty output, A returns golden', async () => {
    const adapterA = createFixedAdapter(JSON.stringify(FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS))
    const adapterB = createFixedAdapter('[]')

    const result = await compareABPrompts(
      promptA,
      promptB,
      [{ observations: FIXTURE_AUTH_STREAM_INPUT }],
      [FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS],
      adapterA,
      adapterB,
    )

    expect(result.summary.winner).toBe('A')
    expect(result.summary.aWins).toBe(1)
    expect(result.summary.bWins).toBe(0)
    expect(result.summary.avgScoreA).toBeGreaterThan(result.summary.avgScoreB)
  })

  it('B wins when A returns empty output, B returns golden', async () => {
    const adapterA = createFixedAdapter('[]')
    const adapterB = createFixedAdapter(JSON.stringify(FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS))

    const result = await compareABPrompts(
      promptA,
      promptB,
      [{ observations: FIXTURE_AUTH_STREAM_INPUT }],
      [FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS],
      adapterA,
      adapterB,
    )

    expect(result.summary.winner).toBe('B')
    expect(result.summary.bWins).toBe(1)
    expect(result.summary.aWins).toBe(0)
    expect(result.summary.avgScoreB).toBeGreaterThan(result.summary.avgScoreA)
  })

  it('tie when both adapters return identical outputs', async () => {
    const sameOutput = JSON.stringify(FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS)
    const adapterA = createFixedAdapter(sameOutput)
    const adapterB = createFixedAdapter(sameOutput)

    const result = await compareABPrompts(
      promptA,
      promptB,
      [{ observations: FIXTURE_AUTH_STREAM_INPUT }],
      [FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS],
      adapterA,
      adapterB,
    )

    expect(result.summary.ties).toBe(1)
    expect(result.summary.winner).toBe('tie')
    expect(result.summary.avgDelta).toBeCloseTo(0, 5)
  })
})

// ---------------------------------------------------------------------------
// Multi-input
// ---------------------------------------------------------------------------

describe('compareABPrompts — multi-input', () => {
  it('processes multiple inputs and returns per-run results', async () => {
    // A wins on input 0, B wins on input 1
    const adapterA = createFixedAdapter('[]')
    const adapterB = createFixedAdapter(JSON.stringify(FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS))

    const result = await compareABPrompts(
      promptA,
      promptB,
      [
        { observations: FIXTURE_AUTH_STREAM_INPUT },
        { observations: FIXTURE_AUTH_STREAM_INPUT },
      ],
      [
        FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS,
        FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS,
      ],
      adapterA,
      adapterB,
    )

    expect(result.runs).toHaveLength(2)
    expect(result.runs[0]!.inputIndex).toBe(0)
    expect(result.runs[1]!.inputIndex).toBe(1)
    expect(result.summary.totalInputs).toBe(2)
  })

  it('summary averages scores correctly', async () => {
    const goldenOutput = JSON.stringify(FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS)
    const adapterA = createFixedAdapter(goldenOutput)
    const adapterB = createFixedAdapter(goldenOutput)

    const result = await compareABPrompts(
      promptA,
      promptB,
      [
        { observations: FIXTURE_AUTH_STREAM_INPUT },
        { observations: FIXTURE_AUTH_STREAM_INPUT },
      ],
      [FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS, FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS],
      adapterA,
      adapterB,
    )

    // Both runs return same output → avg scores should be equal
    expect(result.summary.avgScoreA).toBeCloseTo(result.summary.avgScoreB, 5)
  })
})

// ---------------------------------------------------------------------------
// Result structure
// ---------------------------------------------------------------------------

describe('compareABPrompts — result structure', () => {
  it('result contains promptAVersion, promptBVersion, promptAKind, promptBKind', async () => {
    const adapter = createFixedAdapter('[]')
    const result = await compareABPrompts(
      promptA,
      promptB,
      [{ observations: FIXTURE_AUTH_STREAM_INPUT }],
      [FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS],
      adapter,
      adapter,
    )

    expect(result.promptAVersion).toBe('1.0.0')
    expect(result.promptBVersion).toBe('1.0.0')
    expect(result.promptAKind).toBe('pattern-extraction')
    expect(result.promptBKind).toBe('pattern-extraction')
  })

  it('each run result has required fields', async () => {
    const adapter = createFixedAdapter(JSON.stringify(FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS))
    const result = await compareABPrompts(
      promptA,
      promptB,
      [{ observations: FIXTURE_AUTH_STREAM_INPUT }],
      [FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS],
      adapter,
      adapter,
    )

    const run = result.runs[0]!
    expect(typeof run.inputIndex).toBe('number')
    expect(typeof run.delta).toBe('number')
    expect(['A', 'B', 'tie']).toContain(run.winner)
    expect(run.scoreA).toBeDefined()
    expect(run.scoreB).toBeDefined()
  })

  it('summary has all required aggregate fields', async () => {
    const adapter = createFixedAdapter('[]')
    const result = await compareABPrompts(
      promptA,
      promptB,
      [{ observations: FIXTURE_AUTH_STREAM_INPUT }],
      [FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS],
      adapter,
      adapter,
    )

    const s = result.summary
    expect(typeof s.avgScoreA).toBe('number')
    expect(typeof s.avgScoreB).toBe('number')
    expect(typeof s.avgDelta).toBe('number')
    expect(typeof s.avgPrecisionA).toBe('number')
    expect(typeof s.avgPrecisionB).toBe('number')
    expect(typeof s.avgRecallA).toBe('number')
    expect(typeof s.avgRecallB).toBe('number')
    expect(typeof s.avgF1A).toBe('number')
    expect(typeof s.avgF1B).toBe('number')
    expect(typeof s.aWins).toBe('number')
    expect(typeof s.bWins).toBe('number')
    expect(typeof s.ties).toBe('number')
    expect(typeof s.totalInputs).toBe('number')
    expect(['A', 'B', 'tie']).toContain(s.winner)
  })
})

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('compareABPrompts — error handling', () => {
  it('throws when inputs.length !== goldenOutputs.length', async () => {
    const adapter = createFixedAdapter('[]')
    await expect(
      compareABPrompts(
        promptA,
        promptB,
        [{ observations: FIXTURE_AUTH_STREAM_INPUT }],
        [], // mismatch
        adapter,
        adapter,
      ),
    ).rejects.toThrow(/inputs.length.*goldenOutputs.length/)
  })

  it('throws when inputs is empty', async () => {
    const adapter = createFixedAdapter('[]')
    await expect(
      compareABPrompts(promptA, promptB, [], [], adapter, adapter),
    ).rejects.toThrow(/inputs must be non-empty/)
  })
})

// ---------------------------------------------------------------------------
// formatABReport
// ---------------------------------------------------------------------------

describe('formatABReport', () => {
  it('includes version and kind info', async () => {
    const adapter = createFixedAdapter(JSON.stringify(FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS))
    const result = await compareABPrompts(
      promptA,
      promptB,
      [{ observations: FIXTURE_AUTH_STREAM_INPUT }],
      [FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS],
      adapter,
      adapter,
    )
    const report = formatABReport(result)
    expect(report).toContain('pattern-extraction')
    expect(report).toContain('1.0.0')
  })

  it('includes score and winner summary', async () => {
    const adapterA = createFixedAdapter(JSON.stringify(FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS))
    const adapterB = createFixedAdapter('[]')
    const result = await compareABPrompts(
      promptA,
      promptB,
      [{ observations: FIXTURE_AUTH_STREAM_INPUT }],
      [FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS],
      adapterA,
      adapterB,
    )
    const report = formatABReport(result)
    expect(report).toContain('Score')
    expect(report).toContain('winner')
    expect(report).toContain('A')
  })

  it('includes per-run section for multi-input result', async () => {
    const adapter = createFixedAdapter('[]')
    const result = await compareABPrompts(
      promptA,
      promptB,
      [
        { observations: FIXTURE_AUTH_STREAM_INPUT },
        { observations: FIXTURE_AUTH_STREAM_INPUT },
      ],
      [FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS, FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS],
      adapter,
      adapter,
    )
    const report = formatABReport(result)
    expect(report).toContain('Per-run')
    expect(report).toContain('[0]')
    expect(report).toContain('[1]')
  })
})

// ---------------------------------------------------------------------------
// Cross-prompt: convention identification in A/B
// ---------------------------------------------------------------------------

describe('compareABPrompts — convention identification', () => {
  it('runs correctly for convention prompts', async () => {
    const pConvA = promptRegistry.conventionIdentification.v1
    const pConvB = promptRegistry.conventionIdentification.v1

    const adapterA = createFixedAdapter(
      JSON.stringify(FIXTURE_RESULT_STREAM_GOLDEN_CONVENTIONS),
    )
    const adapterB = createFixedAdapter('[]')

    const result = await compareABPrompts(
      pConvA,
      pConvB,
      [{ observations: FIXTURE_RESULT_STREAM_INPUT }],
      [FIXTURE_RESULT_STREAM_GOLDEN_CONVENTIONS],
      adapterA,
      adapterB,
    )

    expect(result.promptAKind).toBe('convention-identification')
    expect(result.summary.winner).toBe('A')
  })
})
