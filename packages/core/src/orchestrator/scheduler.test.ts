/**
 * Tests for cross-provider sandbox scheduler
 * (packages/core/src/orchestrator/scheduler.ts)
 *
 * Architecture reference: rensei-architecture/004-sandbox-capability-matrix.md
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  pickProvider,
  normalizeCost,
  ProviderBlacklist,
  filterBlacklisted,
  type SchedulerCandidate,
  type SchedulerSandboxSpec,
  type TenantSchedulePolicy,
} from './scheduler.js'
import type { SandboxProviderCapabilities } from '../providers/types.js'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeCapabilities(
  overrides: Partial<SandboxProviderCapabilities> = {},
): SandboxProviderCapabilities {
  return {
    transportModel: 'dial-in',
    supportsFsSnapshot: false,
    supportsPauseResume: false,
    supportsCapacityQuery: false,
    maxConcurrent: null,
    maxSessionDurationSeconds: null,
    regions: ['*'],
    os: ['linux'],
    arch: ['x86_64'],
    idleCostModel: 'zero',
    billingModel: 'wall-clock',
    maxVCpu: null,
    maxMemoryMb: null,
    supportsGpu: false,
    supportsCustomNetworkPolicy: false,
    egressDefault: 'allow-all',
    isA2ARemote: false,
    ...overrides,
  }
}

function makeCandidate(
  providerId: string,
  overrides: Partial<SandboxProviderCapabilities> = {},
  extra: Partial<Omit<SchedulerCandidate, 'providerId' | 'capabilities'>> = {},
): SchedulerCandidate {
  return {
    providerId,
    capabilities: makeCapabilities(overrides),
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// normalizeCost
// ---------------------------------------------------------------------------

describe('normalizeCost', () => {
  it('fixed billing: always 0 regardless of duration', () => {
    const caps = makeCapabilities({ billingModel: 'fixed', idleCostModel: 'zero' })
    expect(normalizeCost(caps, 3600, 0.2)).toBe(0)
  })

  it('wall-clock billing: cost equals duration', () => {
    const caps = makeCapabilities({ billingModel: 'wall-clock', idleCostModel: 'zero' })
    expect(normalizeCost(caps, 1000, 0.2)).toBe(1000)
  })

  it('active-cpu billing: cost equals duration × activeFraction', () => {
    const caps = makeCapabilities({ billingModel: 'active-cpu', idleCostModel: 'zero' })
    expect(normalizeCost(caps, 1000, 0.2)).toBeCloseTo(200)
  })

  it('invocation billing: flat cost of 1.0 regardless of duration', () => {
    const caps = makeCapabilities({ billingModel: 'invocation', idleCostModel: 'zero' })
    expect(normalizeCost(caps, 9999, 0.9)).toBe(1.0)
  })

  it('metered idle adds 0.3 × duration surcharge', () => {
    const caps = makeCapabilities({ billingModel: 'fixed', idleCostModel: 'metered' })
    expect(normalizeCost(caps, 1000, 0.2)).toBeCloseTo(300)
  })

  it('storage-only idle adds 0.05 × duration surcharge', () => {
    const caps = makeCapabilities({ billingModel: 'fixed', idleCostModel: 'storage-only' })
    expect(normalizeCost(caps, 1000, 0.2)).toBeCloseTo(50)
  })

  it('active-cpu + zero idle favors I/O-heavy workloads vs wall-clock', () => {
    const activeCpu = makeCapabilities({ billingModel: 'active-cpu', idleCostModel: 'zero' })
    const wallClock = makeCapabilities({ billingModel: 'wall-clock', idleCostModel: 'zero' })
    // At 20% active CPU, active-cpu should be cheaper than wall-clock
    const dur = 1800
    const frac = 0.2
    expect(normalizeCost(activeCpu, dur, frac)).toBeLessThan(normalizeCost(wallClock, dur, frac))
  })
})

// ---------------------------------------------------------------------------
// pickProvider — capability filter
// ---------------------------------------------------------------------------

describe('pickProvider — capability filter', () => {
  it('eliminates provider whose region does not match', () => {
    const candidates = [makeCandidate('e2b', { regions: ['us-east-1'] })]
    const spec: SchedulerSandboxSpec = { region: 'eu-west-1' }
    const result = pickProvider(spec, candidates)
    expect(result.winner).toBeNull()
    const eliminated = result.eliminationChain.find((e) => e.providerId === 'e2b' && e.step === 'capability-filter')
    expect(eliminated?.reason).toMatch(/region/)
  })

  it('accepts provider with wildcard region', () => {
    const candidates = [makeCandidate('local', { regions: ['*'] })]
    const spec: SchedulerSandboxSpec = { region: 'anywhere' }
    const result = pickProvider(spec, candidates)
    expect(result.winner?.providerId).toBe('local')
  })

  it('eliminates provider when OS does not match', () => {
    const candidates = [makeCandidate('vercel', { os: ['linux'] })]
    const spec: SchedulerSandboxSpec = { os: 'macos' }
    const result = pickProvider(spec, candidates)
    expect(result.winner).toBeNull()
  })

  it('eliminates provider when arch does not match', () => {
    const candidates = [makeCandidate('e2b', { arch: ['x86_64'] })]
    const spec: SchedulerSandboxSpec = { arch: 'arm64' }
    const result = pickProvider(spec, candidates)
    expect(result.winner).toBeNull()
  })

  it('eliminates provider when requested vCPU exceeds maxVCpu', () => {
    const candidates = [makeCandidate('vercel', { maxVCpu: 8 })]
    const spec: SchedulerSandboxSpec = { vCpu: 16 }
    const result = pickProvider(spec, candidates)
    expect(result.winner).toBeNull()
  })

  it('accepts provider when vCPU within maxVCpu', () => {
    const candidates = [makeCandidate('vercel', { maxVCpu: 32 })]
    const spec: SchedulerSandboxSpec = { vCpu: 16 }
    const result = pickProvider(spec, candidates)
    expect(result.winner?.providerId).toBe('vercel')
  })

  it('eliminates provider when requested memory exceeds maxMemoryMb', () => {
    const candidates = [makeCandidate('e2b', { maxMemoryMb: 4096 })]
    const spec: SchedulerSandboxSpec = { memoryMb: 8192 }
    const result = pickProvider(spec, candidates)
    expect(result.winner).toBeNull()
  })

  it('eliminates provider when GPU requested but not supported', () => {
    const candidates = [makeCandidate('e2b', { supportsGpu: false })]
    const spec: SchedulerSandboxSpec = { gpu: true }
    const result = pickProvider(spec, candidates)
    expect(result.winner).toBeNull()
  })

  it('accepts provider when GPU requested and supported', () => {
    const candidates = [makeCandidate('modal', { supportsGpu: true })]
    const spec: SchedulerSandboxSpec = { gpu: true }
    const result = pickProvider(spec, candidates)
    expect(result.winner?.providerId).toBe('modal')
  })

  it('eliminates provider when maxDurationSeconds exceeds maxSessionDurationSeconds', () => {
    const candidates = [makeCandidate('vercel', { maxSessionDurationSeconds: 18000 })]
    const spec: SchedulerSandboxSpec = { maxDurationSeconds: 86400 }
    const result = pickProvider(spec, candidates)
    expect(result.winner).toBeNull()
  })

  it('eliminates provider when pause/resume required but unsupported', () => {
    const candidates = [makeCandidate('docker', { supportsPauseResume: false })]
    const spec: SchedulerSandboxSpec = { requiresPauseResume: true }
    const result = pickProvider(spec, candidates)
    expect(result.winner).toBeNull()
  })

  it('accepts provider when pause/resume required and supported', () => {
    const candidates = [makeCandidate('e2b', { supportsPauseResume: true })]
    const spec: SchedulerSandboxSpec = { requiresPauseResume: true }
    const result = pickProvider(spec, candidates)
    expect(result.winner?.providerId).toBe('e2b')
  })
})

// ---------------------------------------------------------------------------
// pickProvider — policy filter
// ---------------------------------------------------------------------------

describe('pickProvider — policy filter', () => {
  it('eliminates forbidden providers', () => {
    const candidates = [
      makeCandidate('docker'),
      makeCandidate('e2b'),
    ]
    const spec: SchedulerSandboxSpec = {}
    const policy: TenantSchedulePolicy = { forbiddenProviders: ['docker'] }
    const result = pickProvider(spec, candidates, policy)
    expect(result.winner?.providerId).toBe('e2b')
  })

  it('returns null when all candidates are forbidden', () => {
    const candidates = [makeCandidate('docker'), makeCandidate('e2b')]
    const policy: TenantSchedulePolicy = { forbiddenProviders: ['docker', 'e2b'] }
    const result = pickProvider(spec_any, candidates, policy)
    expect(result.winner).toBeNull()
  })
})

const spec_any: SchedulerSandboxSpec = {}

// ---------------------------------------------------------------------------
// pickProvider — capacity filter
// ---------------------------------------------------------------------------

describe('pickProvider — capacity filter', () => {
  it('eliminates unhealthy providers', () => {
    const candidates = [
      makeCandidate('docker', {}, { health: 'unhealthy' }),
      makeCandidate('e2b', {}, { health: 'ready' }),
    ]
    const result = pickProvider(spec_any, candidates)
    expect(result.winner?.providerId).toBe('e2b')
    const eliminated = result.eliminationChain.find(
      (e) => e.providerId === 'docker' && e.step === 'capacity-filter',
    )
    expect(eliminated?.reason).toMatch(/unhealthy/)
  })

  it('eliminates providers above 90% maxConcurrent', () => {
    const candidates = [
      makeCandidate('k8s', {}, {
        capacity: {
          provisionedActive: 91,
          provisionedPaused: 0,
          maxConcurrent: 100,
          estimatedAvailable: 9,
          warmPoolReady: 0,
          capturedAt: new Date(),
        },
      }),
      makeCandidate('docker'),
    ]
    const result = pickProvider(spec_any, candidates)
    expect(result.winner?.providerId).toBe('docker')
  })

  it('accepts provider at 89% capacity (below threshold)', () => {
    const candidates = [
      makeCandidate('k8s', {}, {
        capacity: {
          provisionedActive: 89,
          provisionedPaused: 0,
          maxConcurrent: 100,
          estimatedAvailable: 11,
          warmPoolReady: 0,
          capturedAt: new Date(),
        },
      }),
    ]
    const result = pickProvider(spec_any, candidates)
    expect(result.winner?.providerId).toBe('k8s')
  })

  it('accepts degraded provider (only unhealthy is blocked)', () => {
    const candidates = [makeCandidate('modal', {}, { health: 'degraded' })]
    const result = pickProvider(spec_any, candidates)
    expect(result.winner?.providerId).toBe('modal')
  })
})

// ---------------------------------------------------------------------------
// pickProvider — scoring + tie-breaking
// ---------------------------------------------------------------------------

describe('pickProvider — scoring', () => {
  it('prefers fixed billing (cost=0) over wall-clock', () => {
    const candidates = [
      makeCandidate('e2b', { billingModel: 'wall-clock', idleCostModel: 'zero' }),
      makeCandidate('local', { billingModel: 'fixed', idleCostModel: 'zero' }),
    ]
    const spec: SchedulerSandboxSpec = { estimatedDurationSeconds: 1800 }
    const result = pickProvider(spec, candidates)
    expect(result.winner?.providerId).toBe('local')
  })

  it('prefers active-cpu over wall-clock for I/O-heavy workloads', () => {
    const candidates = [
      makeCandidate('e2b', { billingModel: 'wall-clock', idleCostModel: 'zero' }),
      makeCandidate('vercel', { billingModel: 'active-cpu', idleCostModel: 'zero' }),
    ]
    const spec: SchedulerSandboxSpec = {
      estimatedDurationSeconds: 1800,
      estimatedActiveCpuFraction: 0.15, // I/O-heavy
    }
    const result = pickProvider(spec, candidates)
    expect(result.winner?.providerId).toBe('vercel')
  })

  it('applies preferredProviders as tie-breaker', () => {
    // Both are 'fixed' billing — same cost score
    const candidates = [
      makeCandidate('docker', { billingModel: 'fixed', idleCostModel: 'zero' }),
      makeCandidate('k8s', { billingModel: 'fixed', idleCostModel: 'zero' }),
    ]
    const spec: SchedulerSandboxSpec = {}
    const policy: TenantSchedulePolicy = {
      preferredProviders: ['k8s', 'docker'],
    }
    const result = pickProvider(spec, candidates, policy)
    expect(result.winner?.providerId).toBe('k8s')
  })

  it('falls back to lexicographic providerId as final tie-breaker', () => {
    const candidates = [
      makeCandidate('zzz-provider', { billingModel: 'fixed', idleCostModel: 'zero' }),
      makeCandidate('aaa-provider', { billingModel: 'fixed', idleCostModel: 'zero' }),
    ]
    const result = pickProvider(spec_any, candidates)
    expect(result.winner?.providerId).toBe('aaa-provider')
  })

  it('lower estimatedAcquireMs wins when cost is equal', () => {
    const candidates = [
      makeCandidate('slow-provider', { billingModel: 'fixed', idleCostModel: 'zero' }, { estimatedAcquireMs: 10000 }),
      makeCandidate('fast-provider', { billingModel: 'fixed', idleCostModel: 'zero' }, { estimatedAcquireMs: 100 }),
    ]
    const spec: SchedulerSandboxSpec = {}
    const result = pickProvider(spec, candidates)
    expect(result.winner?.providerId).toBe('fast-provider')
  })

  it('emits elimination chain with scoring steps', () => {
    const candidates = [makeCandidate('e2b'), makeCandidate('modal')]
    const result = pickProvider(spec_any, candidates)
    const scoringSteps = result.eliminationChain.filter((e) => e.step === 'scoring')
    expect(scoringSteps).toHaveLength(2)
    for (const step of scoringSteps) {
      expect(step.score).toBeDefined()
    }
  })

  it('emits winner step with correct providerId', () => {
    const candidates = [makeCandidate('e2b', { billingModel: 'fixed', idleCostModel: 'zero' })]
    const result = pickProvider(spec_any, candidates)
    const winner = result.eliminationChain.find((e) => e.step === 'winner')
    expect(winner?.providerId).toBe('e2b')
  })

  it('custom costWeight shifts preference toward latency', () => {
    // With high latency weight (low costWeight), fast-but-expensive wins over cheap-but-slow
    const candidates = [
      // cheap but slow
      makeCandidate('cheap-slow', { billingModel: 'fixed', idleCostModel: 'zero' }, { estimatedAcquireMs: 30000 }),
      // more expensive but fast
      makeCandidate('expensive-fast', { billingModel: 'wall-clock', idleCostModel: 'zero' }, { estimatedAcquireMs: 100 }),
    ]
    const spec: SchedulerSandboxSpec = { estimatedDurationSeconds: 1800 }
    // Pure latency weight: costWeight=0
    const resultLatency = pickProvider(spec, candidates, { costWeight: 0 })
    expect(resultLatency.winner?.providerId).toBe('expensive-fast')

    // Pure cost weight: costWeight=1
    const resultCost = pickProvider(spec, candidates, { costWeight: 1 })
    expect(resultCost.winner?.providerId).toBe('cheap-slow')
  })
})

// ---------------------------------------------------------------------------
// pickProvider — edge cases
// ---------------------------------------------------------------------------

describe('pickProvider — edge cases', () => {
  it('returns null for empty candidates list', () => {
    const result = pickProvider(spec_any, [])
    expect(result.winner).toBeNull()
    expect(result.eliminationChain).toHaveLength(0)
  })

  it('handles single candidate that passes all filters', () => {
    const candidates = [makeCandidate('docker')]
    const result = pickProvider(spec_any, candidates)
    expect(result.winner?.providerId).toBe('docker')
  })

  it('passes when no spec constraints are set (empty spec)', () => {
    const candidates = [
      makeCandidate('local', { regions: ['home-network'], os: ['macos'], arch: ['arm64'] }),
    ]
    const result = pickProvider({}, candidates)
    expect(result.winner?.providerId).toBe('local')
  })
})

// ---------------------------------------------------------------------------
// ProviderBlacklist
// ---------------------------------------------------------------------------

describe('ProviderBlacklist', () => {
  it('allows provider before any failures', () => {
    const bl = new ProviderBlacklist()
    expect(bl.isAvailable('docker', 'spec-1')).toBe(true)
  })

  it('blacklists provider immediately after failure', () => {
    const bl = new ProviderBlacklist()
    bl.recordFailure('docker', 'spec-1')
    // Should be unavailable right after failure (250ms window)
    expect(bl.isAvailable('docker', 'spec-1')).toBe(false)
  })

  it('back-off doubles on each failure', () => {
    const bl = new ProviderBlacklist()
    bl.recordFailure('docker', 'spec-1')
    const entries = [...bl.getEntries().values()]
    const first = entries.find((e) => e.providerId === 'docker')
    expect(first?.backoffMs).toBe(250)

    bl.recordFailure('docker', 'spec-1')
    const secondEntries = [...bl.getEntries().values()]
    const second = secondEntries.find((e) => e.providerId === 'docker')
    expect(second?.backoffMs).toBe(500)
  })

  it('caps back-off at 5 minutes (300_000ms)', () => {
    const bl = new ProviderBlacklist()
    // 20 failures: 250 × 2^19 = way above 300_000
    for (let i = 0; i < 20; i++) {
      bl.recordFailure('docker', 'spec-1')
    }
    const entry = [...bl.getEntries().values()][0]
    expect(entry?.backoffMs).toBe(300_000)
  })

  it('clears entry on clearEntry()', () => {
    const bl = new ProviderBlacklist()
    bl.recordFailure('docker', 'spec-1')
    bl.clearEntry('docker', 'spec-1')
    expect(bl.isAvailable('docker', 'spec-1')).toBe(true)
  })

  it('is available after back-off window expires', () => {
    vi.useFakeTimers()
    const bl = new ProviderBlacklist()
    bl.recordFailure('docker', 'spec-1')
    expect(bl.isAvailable('docker', 'spec-1')).toBe(false)
    // Advance past 250ms window
    vi.advanceTimersByTime(300)
    expect(bl.isAvailable('docker', 'spec-1')).toBe(true)
    vi.useRealTimers()
  })

  it('blacklists per (provider, specKey) independently', () => {
    const bl = new ProviderBlacklist()
    bl.recordFailure('docker', 'spec-1')
    expect(bl.isAvailable('docker', 'spec-2')).toBe(true)
    expect(bl.isAvailable('e2b', 'spec-1')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// filterBlacklisted
// ---------------------------------------------------------------------------

describe('filterBlacklisted', () => {
  it('removes blacklisted candidates from the list', () => {
    const bl = new ProviderBlacklist()
    bl.recordFailure('docker', 'spec-1')

    const candidates = [makeCandidate('docker'), makeCandidate('e2b')]
    const filtered = filterBlacklisted(candidates, bl, 'spec-1')
    expect(filtered.map((c) => c.providerId)).toEqual(['e2b'])
  })

  it('preserves candidates not in blacklist', () => {
    const bl = new ProviderBlacklist()
    const candidates = [makeCandidate('docker'), makeCandidate('e2b')]
    const filtered = filterBlacklisted(candidates, bl, 'spec-1')
    expect(filtered).toHaveLength(2)
  })
})
