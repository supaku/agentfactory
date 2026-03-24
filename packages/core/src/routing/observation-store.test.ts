import { describe, it, expect } from 'vitest'
import type { ObservationStore } from './observation-store.js'
import type { RoutingObservation } from './types.js'

/**
 * Type-level tests for ObservationStore interface.
 *
 * These verify that the interface is well-defined and that a conforming
 * implementation can be constructed without type errors.
 */

function makeObservation(overrides?: Partial<RoutingObservation>): RoutingObservation {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    provider: 'claude',
    workType: 'development',
    issueIdentifier: 'SUP-100',
    sessionId: 'session-abc-123',
    reward: 0.85,
    taskCompleted: true,
    prCreated: true,
    qaResult: 'passed',
    totalCostUsd: 0.42,
    wallClockMs: 120000,
    timestamp: 1700000000,
    confidence: 0.9,
    ...overrides,
  }
}

/** In-memory ObservationStore for type conformance testing */
function createInMemoryStore(): ObservationStore {
  const observations: RoutingObservation[] = []

  return {
    async recordObservation(obs) {
      observations.push(obs)
    },
    async getObservations(opts) {
      let result = [...observations]
      if (opts.provider) {
        result = result.filter((o) => o.provider === opts.provider)
      }
      if (opts.workType) {
        result = result.filter((o) => o.workType === opts.workType)
      }
      if (opts.since) {
        result = result.filter((o) => o.timestamp >= opts.since!)
      }
      if (opts.limit) {
        result = result.slice(0, opts.limit)
      }
      return result
    },
    async getRecentObservations(provider, workType, windowSize) {
      return observations
        .filter((o) => o.provider === provider && o.workType === workType)
        .reverse()
        .slice(0, windowSize)
    },
  }
}

describe('ObservationStore interface', () => {
  it('accepts a conforming in-memory implementation', () => {
    const store: ObservationStore = createInMemoryStore()
    expect(store).toBeDefined()
    expect(typeof store.recordObservation).toBe('function')
    expect(typeof store.getObservations).toBe('function')
    expect(typeof store.getRecentObservations).toBe('function')
  })

  it('recordObservation stores an observation', async () => {
    const store = createInMemoryStore()
    const obs = makeObservation()
    await store.recordObservation(obs)

    const all = await store.getObservations({})
    expect(all).toHaveLength(1)
    expect(all[0]).toEqual(obs)
  })

  it('getObservations filters by provider', async () => {
    const store = createInMemoryStore()
    await store.recordObservation(makeObservation({ provider: 'claude' }))
    await store.recordObservation(makeObservation({ provider: 'codex' }))
    await store.recordObservation(makeObservation({ provider: 'claude' }))

    const result = await store.getObservations({ provider: 'claude' })
    expect(result).toHaveLength(2)
    expect(result.every((o) => o.provider === 'claude')).toBe(true)
  })

  it('getObservations filters by workType', async () => {
    const store = createInMemoryStore()
    await store.recordObservation(makeObservation({ workType: 'development' }))
    await store.recordObservation(makeObservation({ workType: 'qa' }))

    const result = await store.getObservations({ workType: 'qa' })
    expect(result).toHaveLength(1)
    expect(result[0]!.workType).toBe('qa')
  })

  it('getObservations filters by since', async () => {
    const store = createInMemoryStore()
    await store.recordObservation(makeObservation({ timestamp: 1000 }))
    await store.recordObservation(makeObservation({ timestamp: 2000 }))
    await store.recordObservation(makeObservation({ timestamp: 3000 }))

    const result = await store.getObservations({ since: 2000 })
    expect(result).toHaveLength(2)
    expect(result.every((o) => o.timestamp >= 2000)).toBe(true)
  })

  it('getObservations respects limit', async () => {
    const store = createInMemoryStore()
    for (let i = 0; i < 10; i++) {
      await store.recordObservation(makeObservation({ timestamp: i }))
    }

    const result = await store.getObservations({ limit: 3 })
    expect(result).toHaveLength(3)
  })

  it('getRecentObservations returns newest-first for a provider+workType pair', async () => {
    const store = createInMemoryStore()
    await store.recordObservation(makeObservation({ provider: 'claude', workType: 'development', timestamp: 1000 }))
    await store.recordObservation(makeObservation({ provider: 'codex', workType: 'development', timestamp: 2000 }))
    await store.recordObservation(makeObservation({ provider: 'claude', workType: 'development', timestamp: 3000 }))
    await store.recordObservation(makeObservation({ provider: 'claude', workType: 'qa', timestamp: 4000 }))

    const result = await store.getRecentObservations('claude', 'development', 10)
    expect(result).toHaveLength(2)
    // Newest first
    expect(result[0]!.timestamp).toBe(3000)
    expect(result[1]!.timestamp).toBe(1000)
  })

  it('getRecentObservations respects windowSize', async () => {
    const store = createInMemoryStore()
    for (let i = 0; i < 10; i++) {
      await store.recordObservation(makeObservation({ provider: 'amp', workType: 'research', timestamp: i }))
    }

    const result = await store.getRecentObservations('amp', 'research', 3)
    expect(result).toHaveLength(3)
  })

  it('getObservations returns empty array when no observations match', async () => {
    const store = createInMemoryStore()
    await store.recordObservation(makeObservation({ provider: 'claude' }))

    const result = await store.getObservations({ provider: 'codex' })
    expect(result).toEqual([])
  })

  it('getRecentObservations returns empty array when no observations match', async () => {
    const store = createInMemoryStore()
    const result = await store.getRecentObservations('claude', 'development', 10)
    expect(result).toEqual([])
  })
})
