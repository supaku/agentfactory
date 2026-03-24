import type { AgentProviderName } from '../providers/types.js'
import type { AgentWorkType } from '../orchestrator/work-types.js'
import type { RoutingDecision, RoutingConfig } from './types.js'
import type { PosteriorStore } from './posterior-store.js'

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  enabled: false,
  explorationRate: 0.1,
  windowSize: 100,
  discountFactor: 0.99,
  minObservationsForExploit: 5,
  changeDetectionThreshold: 0.2,
}

// Beta distribution utilities - pure math, no external dependencies
export function betaMean(alpha: number, beta: number): number {
  return alpha / (alpha + beta)
}

export function betaVariance(alpha: number, beta: number): number {
  const ab = alpha + beta
  return (alpha * beta) / (ab * ab * (ab + 1))
}

/**
 * Sample from a Beta distribution using the ratio of Gamma variates.
 * If X ~ Gamma(alpha), Y ~ Gamma(beta), then X/(X+Y) ~ Beta(alpha, beta).
 *
 * If a random generator is provided, use it for deterministic testing.
 */
export function betaSample(alpha: number, beta: number, rng?: () => number): number {
  const random = rng ?? Math.random

  const x = gammaSample(alpha, random)
  const y = gammaSample(beta, random)

  if (x + y === 0) return 0.5 // Edge case
  return x / (x + y)
}

/**
 * Sample from a Gamma distribution using Marsaglia and Tsang's method.
 */
function gammaSample(shape: number, random: () => number): number {
  if (shape < 1) {
    // For shape < 1, use the trick: Gamma(shape) = Gamma(shape+1) * U^(1/shape)
    return gammaSample(shape + 1, random) * Math.pow(random(), 1 / shape)
  }

  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)

  while (true) {
    let x: number
    let v: number

    do {
      // Generate standard normal using Box-Muller
      const u1 = random()
      const u2 = random()
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
      v = 1 + c * x
    } while (v <= 0)

    v = v * v * v
    const u = random()

    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}

export interface SelectProviderOptions {
  forcedExploration?: boolean
  rng?: () => number // For deterministic testing
}

export async function selectProvider(
  posteriorStore: PosteriorStore,
  workType: AgentWorkType,
  availableProviders: AgentProviderName[],
  config: RoutingConfig = DEFAULT_ROUTING_CONFIG,
  opts?: SelectProviderOptions,
): Promise<RoutingDecision> {
  const posteriors = await Promise.all(
    availableProviders.map(p => posteriorStore.getPosterior(p, workType)),
  )

  const rng = opts?.rng

  // Forced exploration: random selection
  if (opts?.forcedExploration || (rng ?? Math.random)() < config.explorationRate) {
    const idx = Math.floor((rng ?? Math.random)() * availableProviders.length)
    const chosen = posteriors[idx]!
    const mean = betaMean(chosen.alpha, chosen.beta)
    const confidence = 1 - Math.sqrt(betaVariance(chosen.alpha, chosen.beta))

    const others = posteriors
      .filter((_, i) => i !== idx)
      .map(p => ({
        provider: p.provider,
        expectedReward: betaMean(p.alpha, p.beta),
        confidence: 1 - Math.sqrt(betaVariance(p.alpha, p.beta)),
      }))

    return {
      selectedProvider: chosen.provider,
      confidence,
      expectedReward: mean,
      explorationReason: 'forced',
      source: 'mab-routing',
      alternatives: others,
    }
  }

  // Thompson Sampling: draw from each posterior's Beta distribution
  const samples = posteriors.map(post => ({
    provider: post.provider,
    sample: betaSample(post.alpha, post.beta, rng),
    confidence: 1 - Math.sqrt(betaVariance(post.alpha, post.beta)),
    expectedReward: betaMean(post.alpha, post.beta),
  }))

  // Select highest sample
  samples.sort((a, b) => b.sample - a.sample)
  const selected = samples[0]!

  // Only trust posteriors with enough observations
  const selectedPosterior = posteriors.find(p => p.provider === selected.provider)!
  const isTrusted = selectedPosterior.totalObservations >= config.minObservationsForExploit

  return {
    selectedProvider: selected.provider,
    confidence: selected.confidence,
    expectedReward: selected.expectedReward,
    explorationReason: !isTrusted
      ? 'uncertainty'
      : selected.confidence < 0.3
        ? 'uncertainty'
        : undefined,
    source: 'mab-routing',
    alternatives: samples.slice(1).map(s => ({
      provider: s.provider,
      expectedReward: s.expectedReward,
      confidence: s.confidence,
    })),
  }
}
