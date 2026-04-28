import { describe, it, expect } from 'vitest'
import { defaultPosterior } from './posterior-store.js'

describe('defaultPosterior', () => {
  it('returns Beta(1,1) with correct provider and workType', () => {
    const posterior = defaultPosterior('claude', 'development')

    expect(posterior.provider).toBe('claude')
    expect(posterior.workType).toBe('development')
    expect(posterior.alpha).toBe(1)
    expect(posterior.beta).toBe(1)
  })

  it('has totalObservations of 0', () => {
    const posterior = defaultPosterior('codex', 'qa')

    expect(posterior.totalObservations).toBe(0)
  })

  it('has avgReward of 0', () => {
    const posterior = defaultPosterior('amp', 'research')

    expect(posterior.avgReward).toBe(0)
  })

  it('has avgCostUsd of 0', () => {
    const posterior = defaultPosterior('claude', 'inflight')

    expect(posterior.avgCostUsd).toBe(0)
  })

  it('has a reasonable lastUpdated timestamp', () => {
    const before = Date.now()
    const posterior = defaultPosterior('claude', 'development')
    const after = Date.now()

    expect(posterior.lastUpdated).toBeGreaterThanOrEqual(before)
    expect(posterior.lastUpdated).toBeLessThanOrEqual(after)
  })

  it('works with refinement-coordination work type', () => {
    const posterior = defaultPosterior('amp', 'refinement-coordination')

    expect(posterior.provider).toBe('amp')
    expect(posterior.workType).toBe('refinement-coordination')
    expect(posterior.alpha).toBe(1)
    expect(posterior.beta).toBe(1)
  })
})
