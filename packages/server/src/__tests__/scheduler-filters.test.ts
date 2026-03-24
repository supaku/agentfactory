import { describe, it, expect } from 'vitest'
import {
  CapacityFilter,
  ProjectFilter,
  ProviderFilter,
  QuotaFilter,
  StatusFilter,
  runFilters,
  DEFAULT_FILTERS,
} from '../scheduler/filters.js'
import type { WorkerInfo } from '../worker-storage.js'
import type { QueuedWork } from '../work-queue.js'

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeWorkerInfo(overrides: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    id: 'wkr_abc',
    hostname: 'test-host',
    capacity: 3,
    activeCount: 1,
    registeredAt: 900_000,
    lastHeartbeat: 1_000_000,
    status: 'active',
    activeSessions: ['sess-1'],
    ...overrides,
  }
}

function makeWork(overrides: Partial<QueuedWork> = {}): QueuedWork {
  return {
    sessionId: 'sess-100',
    issueId: 'issue-1',
    issueIdentifier: 'ENG-123',
    priority: 3,
    queuedAt: Date.now(),
    projectName: 'my-project',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// CapacityFilter
// ---------------------------------------------------------------------------

describe('CapacityFilter', () => {
  it('passes when worker has remaining capacity', () => {
    const worker = makeWorkerInfo({ activeCount: 1, capacity: 3 })
    const result = CapacityFilter.filter(makeWork(), worker)

    expect(result.pass).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it('fails when worker is at capacity', () => {
    const worker = makeWorkerInfo({ activeCount: 3, capacity: 3 })
    const result = CapacityFilter.filter(makeWork(), worker)

    expect(result.pass).toBe(false)
    expect(result.reason).toBe('worker at capacity (3/3)')
  })

  it('fails when worker exceeds capacity', () => {
    const worker = makeWorkerInfo({ activeCount: 5, capacity: 3 })
    const result = CapacityFilter.filter(makeWork(), worker)

    expect(result.pass).toBe(false)
    expect(result.reason).toBe('worker at capacity (5/3)')
  })

  it('passes when worker has zero active count and positive capacity', () => {
    const worker = makeWorkerInfo({ activeCount: 0, capacity: 1 })
    const result = CapacityFilter.filter(makeWork(), worker)

    expect(result.pass).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ProjectFilter
// ---------------------------------------------------------------------------

describe('ProjectFilter', () => {
  it('passes when worker has no project restriction', () => {
    const worker = makeWorkerInfo({ projects: undefined })
    const work = makeWork({ projectName: 'any-project' })
    const result = ProjectFilter.filter(work, worker)

    expect(result.pass).toBe(true)
  })

  it('passes when worker has empty project list', () => {
    const worker = makeWorkerInfo({ projects: [] })
    const work = makeWork({ projectName: 'any-project' })
    const result = ProjectFilter.filter(work, worker)

    expect(result.pass).toBe(true)
  })

  it('passes when work has no projectName', () => {
    const worker = makeWorkerInfo({ projects: ['alpha', 'beta'] })
    const work = makeWork({ projectName: undefined })
    const result = ProjectFilter.filter(work, worker)

    expect(result.pass).toBe(true)
  })

  it('passes when work projectName is in worker project list', () => {
    const worker = makeWorkerInfo({ projects: ['alpha', 'beta', 'gamma'] })
    const work = makeWork({ projectName: 'beta' })
    const result = ProjectFilter.filter(work, worker)

    expect(result.pass).toBe(true)
  })

  it('fails when work projectName is not in worker project list', () => {
    const worker = makeWorkerInfo({ projects: ['alpha', 'beta'] })
    const work = makeWork({ projectName: 'gamma' })
    const result = ProjectFilter.filter(work, worker)

    expect(result.pass).toBe(false)
    expect(result.reason).toBe("project gamma not in worker's project list")
  })
})

// ---------------------------------------------------------------------------
// ProviderFilter
// ---------------------------------------------------------------------------

describe('ProviderFilter', () => {
  it('passes when worker has no provider restriction', () => {
    const worker = makeWorkerInfo({ providers: undefined })
    const work = { ...makeWork(), provider: 'openai' } as QueuedWork &
      Record<string, unknown>
    const result = ProviderFilter.filter(work, worker)

    expect(result.pass).toBe(true)
  })

  it('passes when worker has empty providers list', () => {
    const worker = makeWorkerInfo({ providers: [] })
    const work = { ...makeWork(), provider: 'openai' } as QueuedWork &
      Record<string, unknown>
    const result = ProviderFilter.filter(work, worker)

    expect(result.pass).toBe(true)
  })

  it('passes when work has no provider field', () => {
    const worker = makeWorkerInfo({ providers: ['anthropic'] })
    const work = makeWork()
    const result = ProviderFilter.filter(work, worker)

    expect(result.pass).toBe(true)
  })

  it('passes when work provider is in worker providers list', () => {
    const worker = makeWorkerInfo({ providers: ['anthropic', 'openai'] })
    const work = { ...makeWork(), provider: 'anthropic' } as QueuedWork &
      Record<string, unknown>
    const result = ProviderFilter.filter(work, worker)

    expect(result.pass).toBe(true)
  })

  it('fails when work provider is not in worker providers list', () => {
    const worker = makeWorkerInfo({ providers: ['anthropic'] })
    const work = { ...makeWork(), provider: 'openai' } as QueuedWork &
      Record<string, unknown>
    const result = ProviderFilter.filter(work, worker)

    expect(result.pass).toBe(false)
    expect(result.reason).toBe('worker does not support provider openai')
  })
})

// ---------------------------------------------------------------------------
// QuotaFilter
// ---------------------------------------------------------------------------

describe('QuotaFilter', () => {
  it('always passes (placeholder until orgId is available)', () => {
    const worker = makeWorkerInfo()
    const work = makeWork()
    const result = QuotaFilter.filter(work, worker)

    expect(result.pass).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// StatusFilter
// ---------------------------------------------------------------------------

describe('StatusFilter', () => {
  it('passes when worker status is active', () => {
    const worker = makeWorkerInfo({ status: 'active' })
    const result = StatusFilter.filter(makeWork(), worker)

    expect(result.pass).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it('fails when worker status is draining', () => {
    const worker = makeWorkerInfo({ status: 'draining' })
    const result = StatusFilter.filter(makeWork(), worker)

    expect(result.pass).toBe(false)
    expect(result.reason).toBe('worker status is draining')
  })

  it('fails when worker status is offline', () => {
    const worker = makeWorkerInfo({ status: 'offline' })
    const result = StatusFilter.filter(makeWork(), worker)

    expect(result.pass).toBe(false)
    expect(result.reason).toBe('worker status is offline')
  })
})

// ---------------------------------------------------------------------------
// runFilters pipeline
// ---------------------------------------------------------------------------

describe('runFilters', () => {
  it('returns all workers as feasible when all pass', () => {
    const workers = [
      makeWorkerInfo({ id: 'wkr_1' }),
      makeWorkerInfo({ id: 'wkr_2' }),
    ]
    const work = makeWork()
    const { feasible, filtered } = runFilters(work, workers)

    expect(feasible).toHaveLength(2)
    expect(feasible.map((w) => w.id)).toEqual(['wkr_1', 'wkr_2'])
    expect(filtered.size).toBe(0)
  })

  it('filters out workers at capacity', () => {
    const workers = [
      makeWorkerInfo({ id: 'wkr_1', activeCount: 3, capacity: 3 }),
      makeWorkerInfo({ id: 'wkr_2', activeCount: 1, capacity: 3 }),
    ]
    const work = makeWork()
    const { feasible, filtered } = runFilters(work, workers)

    expect(feasible).toHaveLength(1)
    expect(feasible[0].id).toBe('wkr_2')
    expect(filtered.get('wkr_1')).toBeDefined()
    expect(filtered.get('wkr_1')!.length).toBeGreaterThan(0)
  })

  it('accumulates multiple failure reasons per worker', () => {
    const workers = [
      makeWorkerInfo({
        id: 'wkr_bad',
        status: 'draining',
        activeCount: 5,
        capacity: 3,
      }),
    ]
    const work = makeWork()
    const { feasible, filtered } = runFilters(work, workers)

    expect(feasible).toHaveLength(0)
    const reasons = filtered.get('wkr_bad')!
    expect(reasons.length).toBeGreaterThanOrEqual(2)
    expect(reasons).toContain('worker status is draining')
    expect(reasons).toContain('worker at capacity (5/3)')
  })

  it('returns empty feasible set when all workers are filtered', () => {
    const workers = [
      makeWorkerInfo({ id: 'wkr_1', status: 'offline' }),
      makeWorkerInfo({ id: 'wkr_2', status: 'draining' }),
    ]
    const work = makeWork()
    const { feasible, filtered } = runFilters(work, workers)

    expect(feasible).toHaveLength(0)
    expect(filtered.size).toBe(2)
  })

  it('handles empty worker list', () => {
    const work = makeWork()
    const { feasible, filtered } = runFilters(work, [])

    expect(feasible).toHaveLength(0)
    expect(filtered.size).toBe(0)
  })

  it('uses DEFAULT_FILTERS when no filters are provided', () => {
    const worker = makeWorkerInfo({ status: 'active', activeCount: 0 })
    const work = makeWork()
    const { feasible } = runFilters(work, [worker])

    expect(feasible).toHaveLength(1)
    expect(DEFAULT_FILTERS.length).toBe(5)
  })

  it('accepts custom filter list', () => {
    const alwaysFail: { name: string; filter: () => { pass: boolean; reason: string } } = {
      name: 'AlwaysFail',
      filter: () => ({ pass: false, reason: 'nope' }),
    }
    const workers = [makeWorkerInfo({ id: 'wkr_1' })]
    const work = makeWork()
    const { feasible, filtered } = runFilters(work, workers, [alwaysFail])

    expect(feasible).toHaveLength(0)
    expect(filtered.get('wkr_1')).toEqual(['nope'])
  })

  it('filters by project restriction correctly in pipeline', () => {
    const workers = [
      makeWorkerInfo({ id: 'wkr_1', projects: ['alpha'] }),
      makeWorkerInfo({ id: 'wkr_2', projects: ['beta'] }),
      makeWorkerInfo({ id: 'wkr_3', projects: undefined }), // accepts all
    ]
    const work = makeWork({ projectName: 'beta' })
    const { feasible, filtered } = runFilters(work, workers)

    expect(feasible.map((w) => w.id)).toEqual(['wkr_2', 'wkr_3'])
    expect(filtered.has('wkr_1')).toBe(true)
  })

  it('filters by provider restriction correctly in pipeline', () => {
    const workers = [
      makeWorkerInfo({ id: 'wkr_1', providers: ['anthropic'] }),
      makeWorkerInfo({ id: 'wkr_2', providers: ['openai'] }),
      makeWorkerInfo({ id: 'wkr_3', providers: undefined }), // accepts all
    ]
    const work = { ...makeWork(), provider: 'openai' } as QueuedWork &
      Record<string, unknown>
    const { feasible, filtered } = runFilters(work, workers)

    expect(feasible.map((w) => w.id)).toEqual(['wkr_2', 'wkr_3'])
    expect(filtered.has('wkr_1')).toBe(true)
  })

  it('combines status + capacity + project filters', () => {
    const workers = [
      makeWorkerInfo({
        id: 'wkr_offline',
        status: 'offline',
        projects: ['alpha'],
      }),
      makeWorkerInfo({
        id: 'wkr_full',
        status: 'active',
        activeCount: 3,
        capacity: 3,
        projects: ['alpha'],
      }),
      makeWorkerInfo({
        id: 'wkr_wrong_project',
        status: 'active',
        activeCount: 0,
        capacity: 3,
        projects: ['beta'],
      }),
      makeWorkerInfo({
        id: 'wkr_good',
        status: 'active',
        activeCount: 1,
        capacity: 3,
        projects: ['alpha'],
      }),
    ]
    const work = makeWork({ projectName: 'alpha' })
    const { feasible, filtered } = runFilters(work, workers)

    expect(feasible).toHaveLength(1)
    expect(feasible[0].id).toBe('wkr_good')
    expect(filtered.size).toBe(3)
  })
})
