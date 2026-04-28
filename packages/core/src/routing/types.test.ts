import { describe, it, expect } from 'vitest'
import {
  RoutingObservationSchema,
  RoutingPosteriorSchema,
  RoutingDecisionSchema,
  RoutingConfigSchema,
  ROUTING_KEYS,
} from './types.js'

describe('RoutingObservationSchema', () => {
  const validObservation = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    provider: 'claude',
    workType: 'development',
    project: 'Agent',
    issueIdentifier: 'SUP-100',
    sessionId: 'session-abc-123',
    reward: 0.85,
    taskCompleted: true,
    prCreated: true,
    qaResult: 'passed' as const,
    totalCostUsd: 0.42,
    wallClockMs: 120000,
    timestamp: 1700000000,
    confidence: 0.9,
    explorationReason: 'forced',
  }

  it('parses a valid observation', () => {
    const result = RoutingObservationSchema.parse(validObservation)
    expect(result).toEqual(validObservation)
  })

  it('parses without optional fields', () => {
    const { project, explorationReason, ...required } = validObservation
    const result = RoutingObservationSchema.parse(required)
    expect(result.project).toBeUndefined()
    expect(result.explorationReason).toBeUndefined()
  })

  it('rejects invalid provider', () => {
    expect(() =>
      RoutingObservationSchema.parse({ ...validObservation, provider: 'gpt' }),
    ).toThrow()
  })

  it('rejects invalid workType', () => {
    expect(() =>
      RoutingObservationSchema.parse({ ...validObservation, workType: 'deploy' }),
    ).toThrow()
  })

  it('rejects reward out of range', () => {
    expect(() =>
      RoutingObservationSchema.parse({ ...validObservation, reward: 1.5 }),
    ).toThrow()
    expect(() =>
      RoutingObservationSchema.parse({ ...validObservation, reward: -0.1 }),
    ).toThrow()
  })

  it('rejects invalid qaResult', () => {
    expect(() =>
      RoutingObservationSchema.parse({ ...validObservation, qaResult: 'skipped' }),
    ).toThrow()
  })

  it('rejects negative totalCostUsd', () => {
    expect(() =>
      RoutingObservationSchema.parse({ ...validObservation, totalCostUsd: -1 }),
    ).toThrow()
  })

  it('rejects invalid UUID for id', () => {
    expect(() =>
      RoutingObservationSchema.parse({ ...validObservation, id: 'not-a-uuid' }),
    ).toThrow()
  })

  it('rejects missing required fields', () => {
    expect(() => RoutingObservationSchema.parse({})).toThrow()
  })
})

describe('RoutingPosteriorSchema', () => {
  const validPosterior = {
    provider: 'codex',
    workType: 'qa',
    alpha: 5.2,
    beta: 2.1,
    totalObservations: 10,
    avgReward: 0.72,
    avgCostUsd: 0.35,
    lastUpdated: 1700000000,
  }

  it('parses a valid posterior', () => {
    const result = RoutingPosteriorSchema.parse(validPosterior)
    expect(result).toEqual(validPosterior)
  })

  it('rejects alpha below 1', () => {
    expect(() =>
      RoutingPosteriorSchema.parse({ ...validPosterior, alpha: 0.5 }),
    ).toThrow()
  })

  it('rejects beta below 1', () => {
    expect(() =>
      RoutingPosteriorSchema.parse({ ...validPosterior, beta: 0 }),
    ).toThrow()
  })

  it('rejects negative totalObservations', () => {
    expect(() =>
      RoutingPosteriorSchema.parse({ ...validPosterior, totalObservations: -1 }),
    ).toThrow()
  })

  it('rejects non-integer totalObservations', () => {
    expect(() =>
      RoutingPosteriorSchema.parse({ ...validPosterior, totalObservations: 1.5 }),
    ).toThrow()
  })

  it('rejects avgReward out of range', () => {
    expect(() =>
      RoutingPosteriorSchema.parse({ ...validPosterior, avgReward: 1.1 }),
    ).toThrow()
  })

  it('rejects invalid provider', () => {
    expect(() =>
      RoutingPosteriorSchema.parse({ ...validPosterior, provider: 'openai' }),
    ).toThrow()
  })

  it('rejects missing required fields', () => {
    expect(() => RoutingPosteriorSchema.parse({})).toThrow()
  })
})

describe('RoutingDecisionSchema', () => {
  const validDecision = {
    selectedProvider: 'amp',
    confidence: 0.88,
    expectedReward: 0.75,
    explorationReason: 'uncertainty',
    source: 'mab-routing' as const,
    alternatives: [
      { provider: 'claude', expectedReward: 0.7, confidence: 0.85 },
      { provider: 'codex', expectedReward: 0.65, confidence: 0.8 },
    ],
  }

  it('parses a valid decision', () => {
    const result = RoutingDecisionSchema.parse(validDecision)
    expect(result).toEqual(validDecision)
  })

  it('parses without optional explorationReason', () => {
    const { explorationReason, ...required } = validDecision
    const result = RoutingDecisionSchema.parse(required)
    expect(result.explorationReason).toBeUndefined()
  })

  it('parses with empty alternatives', () => {
    const result = RoutingDecisionSchema.parse({ ...validDecision, alternatives: [] })
    expect(result.alternatives).toEqual([])
  })

  it('rejects invalid source', () => {
    expect(() =>
      RoutingDecisionSchema.parse({ ...validDecision, source: 'manual' }),
    ).toThrow()
  })

  it('rejects invalid provider in alternatives', () => {
    expect(() =>
      RoutingDecisionSchema.parse({
        ...validDecision,
        alternatives: [{ provider: 'gpt', expectedReward: 0.5, confidence: 0.5 }],
      }),
    ).toThrow()
  })

  it('rejects confidence out of range', () => {
    expect(() =>
      RoutingDecisionSchema.parse({ ...validDecision, confidence: 2.0 }),
    ).toThrow()
  })

  it('rejects missing required fields', () => {
    expect(() => RoutingDecisionSchema.parse({})).toThrow()
  })
})

describe('RoutingConfigSchema', () => {
  const validConfig = {
    enabled: true,
    explorationRate: 0.1,
    windowSize: 50,
    discountFactor: 0.95,
    minObservationsForExploit: 5,
    changeDetectionThreshold: 0.3,
  }

  it('parses a valid config', () => {
    const result = RoutingConfigSchema.parse(validConfig)
    expect(result).toEqual(validConfig)
  })

  it('rejects explorationRate out of range', () => {
    expect(() =>
      RoutingConfigSchema.parse({ ...validConfig, explorationRate: 1.5 }),
    ).toThrow()
    expect(() =>
      RoutingConfigSchema.parse({ ...validConfig, explorationRate: -0.1 }),
    ).toThrow()
  })

  it('rejects non-positive windowSize', () => {
    expect(() =>
      RoutingConfigSchema.parse({ ...validConfig, windowSize: 0 }),
    ).toThrow()
  })

  it('rejects non-integer windowSize', () => {
    expect(() =>
      RoutingConfigSchema.parse({ ...validConfig, windowSize: 10.5 }),
    ).toThrow()
  })

  it('rejects discountFactor out of range', () => {
    expect(() =>
      RoutingConfigSchema.parse({ ...validConfig, discountFactor: 1.1 }),
    ).toThrow()
  })

  it('rejects negative minObservationsForExploit', () => {
    expect(() =>
      RoutingConfigSchema.parse({ ...validConfig, minObservationsForExploit: -1 }),
    ).toThrow()
  })

  it('rejects negative changeDetectionThreshold', () => {
    expect(() =>
      RoutingConfigSchema.parse({ ...validConfig, changeDetectionThreshold: -0.5 }),
    ).toThrow()
  })

  it('rejects non-boolean enabled', () => {
    expect(() =>
      RoutingConfigSchema.parse({ ...validConfig, enabled: 'yes' }),
    ).toThrow()
  })

  it('rejects missing required fields', () => {
    expect(() => RoutingConfigSchema.parse({})).toThrow()
  })
})

describe('ROUTING_KEYS', () => {
  it('generates correct posteriors key', () => {
    expect(ROUTING_KEYS.posteriors('claude', 'development')).toBe(
      'routing:posteriors:claude:development',
    )
  })

  it('generates correct posteriors key for refinement-coordination work type', () => {
    expect(ROUTING_KEYS.posteriors('amp', 'refinement-coordination')).toBe(
      'routing:posteriors:amp:refinement-coordination',
    )
  })

  it('has correct observations key', () => {
    expect(ROUTING_KEYS.observations).toBe('routing:observations')
  })

  it('has correct config key', () => {
    expect(ROUTING_KEYS.config).toBe('routing:config')
  })
})
