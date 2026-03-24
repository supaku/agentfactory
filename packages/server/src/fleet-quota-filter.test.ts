import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./fleet-quota-storage.js', () => ({
  getQuotaConfig: vi.fn(),
}))

vi.mock('./fleet-quota-tracker.js', () => ({
  getQuotaUsage: vi.fn(),
}))

vi.mock('./fleet-quota-cohort.js', () => ({
  checkQuotaWithBorrowing: vi.fn(),
}))

import { filterByQuota } from './fleet-quota-filter.js'
import { getQuotaConfig } from './fleet-quota-storage.js'
import { getQuotaUsage } from './fleet-quota-tracker.js'
import { checkQuotaWithBorrowing } from './fleet-quota-cohort.js'
import type { QueuedWork } from './work-queue.js'
import type { FleetQuota, FleetQuotaUsage } from './fleet-quota-types.js'

const mockGetQuotaConfig = vi.mocked(getQuotaConfig)
const mockGetQuotaUsage = vi.mocked(getQuotaUsage)
const mockCheckQuotaWithBorrowing = vi.mocked(checkQuotaWithBorrowing)

function makeWork(overrides: Partial<QueuedWork> = {}): QueuedWork {
  return {
    sessionId: 'sess-1',
    issueId: 'issue-1',
    issueIdentifier: 'SUP-100',
    priority: 2,
    queuedAt: Date.now(),
    projectName: 'team-alpha',
    ...overrides,
  }
}

function makeQuota(overrides: Partial<FleetQuota> = {}): FleetQuota {
  return {
    name: 'team-alpha',
    scope: 'project',
    maxConcurrentSessions: 5,
    maxDailyCostUsd: 100,
    maxSessionCostUsd: 20,
    ...overrides,
  }
}

function makeUsage(overrides: Partial<FleetQuotaUsage> = {}): FleetQuotaUsage {
  return {
    currentSessions: 0,
    dailyCostUsd: 0,
    lastResetAt: 0,
    ...overrides,
  }
}

describe('filterByQuota', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: borrowing not available (existing tests expect rejection at limit)
    mockCheckQuotaWithBorrowing.mockResolvedValue({
      allowed: false,
      reason: 'concurrent_limit',
      borrowed: false,
    })
  })

  it('returns empty results for empty input', async () => {
    const result = await filterByQuota([])
    expect(result.allowed).toEqual([])
    expect(result.rejected).toEqual([])
  })

  it('allows work when under concurrent session limit', async () => {
    mockGetQuotaConfig.mockResolvedValue(makeQuota({ maxConcurrentSessions: 5 }))
    mockGetQuotaUsage.mockResolvedValue(makeUsage({ currentSessions: 2 }))

    const result = await filterByQuota([makeWork()])

    expect(result.allowed).toHaveLength(1)
    expect(result.rejected).toHaveLength(0)
  })

  it('rejects work when at concurrent session limit', async () => {
    mockGetQuotaConfig.mockResolvedValue(makeQuota({ maxConcurrentSessions: 5 }))
    mockGetQuotaUsage.mockResolvedValue(makeUsage({ currentSessions: 5 }))

    const result = await filterByQuota([makeWork()])

    expect(result.allowed).toHaveLength(0)
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0].reason).toContain('concurrent_limit')
  })

  it('rejects work when over concurrent session limit', async () => {
    mockGetQuotaConfig.mockResolvedValue(makeQuota({ maxConcurrentSessions: 3 }))
    mockGetQuotaUsage.mockResolvedValue(makeUsage({ currentSessions: 4 }))

    const result = await filterByQuota([makeWork()])

    expect(result.allowed).toHaveLength(0)
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0].reason).toContain('concurrent_limit')
  })

  it('allows work when under daily budget', async () => {
    mockGetQuotaConfig.mockResolvedValue(makeQuota({ maxDailyCostUsd: 100 }))
    mockGetQuotaUsage.mockResolvedValue(makeUsage({ dailyCostUsd: 50 }))

    const result = await filterByQuota([makeWork()])

    expect(result.allowed).toHaveLength(1)
    expect(result.rejected).toHaveLength(0)
  })

  it('rejects work when daily budget exceeded', async () => {
    mockGetQuotaConfig.mockResolvedValue(makeQuota({ maxDailyCostUsd: 100 }))
    mockGetQuotaUsage.mockResolvedValue(makeUsage({ dailyCostUsd: 100 }))

    const result = await filterByQuota([makeWork()])

    expect(result.allowed).toHaveLength(0)
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0].reason).toContain('daily_budget')
  })

  it('allows work with no projectName (no quota to enforce)', async () => {
    const result = await filterByQuota([makeWork({ projectName: undefined })])

    expect(result.allowed).toHaveLength(1)
    expect(result.rejected).toHaveLength(0)
    expect(mockGetQuotaConfig).not.toHaveBeenCalled()
  })

  it('allows work when project has no quota config (opt-in)', async () => {
    mockGetQuotaConfig.mockResolvedValue(null)

    const result = await filterByQuota([makeWork({ projectName: 'untracked' })])

    expect(result.allowed).toHaveLength(1)
    expect(result.rejected).toHaveLength(0)
  })

  it('batch-fetches configs for unique projects (no N+1)', async () => {
    mockGetQuotaConfig.mockResolvedValue(makeQuota())
    mockGetQuotaUsage.mockResolvedValue(makeUsage())

    await filterByQuota([
      makeWork({ sessionId: 's1', projectName: 'team-alpha' }),
      makeWork({ sessionId: 's2', projectName: 'team-alpha' }),
      makeWork({ sessionId: 's3', projectName: 'team-alpha' }),
    ])

    // Should only fetch config once for team-alpha, not 3 times
    expect(mockGetQuotaConfig).toHaveBeenCalledTimes(1)
    expect(mockGetQuotaUsage).toHaveBeenCalledTimes(1)
  })

  it('handles mixed allowed and rejected work', async () => {
    const alphaQuota = makeQuota({ name: 'alpha', maxConcurrentSessions: 1 })
    const betaQuota = makeQuota({ name: 'beta', maxConcurrentSessions: 10 })

    mockGetQuotaConfig.mockImplementation(async (name: string) => {
      if (name === 'alpha') return alphaQuota
      if (name === 'beta') return betaQuota
      return null
    })
    mockGetQuotaUsage.mockImplementation(async (name: string) => {
      if (name === 'alpha') return makeUsage({ currentSessions: 1 })
      if (name === 'beta') return makeUsage({ currentSessions: 2 })
      return makeUsage()
    })

    const result = await filterByQuota([
      makeWork({ sessionId: 's1', projectName: 'alpha' }),
      makeWork({ sessionId: 's2', projectName: 'beta' }),
      makeWork({ sessionId: 's3', projectName: 'untracked' }),
    ])

    expect(result.allowed).toHaveLength(2)
    expect(result.allowed.map(w => w.sessionId)).toEqual(['s2', 's3'])
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0].work.sessionId).toBe('s1')
  })

  it('checks daily budget before concurrent limit', async () => {
    mockGetQuotaConfig.mockResolvedValue(
      makeQuota({ maxConcurrentSessions: 2, maxDailyCostUsd: 50 })
    )
    mockGetQuotaUsage.mockResolvedValue(
      makeUsage({ currentSessions: 5, dailyCostUsd: 100 })
    )

    const result = await filterByQuota([makeWork()])

    expect(result.rejected).toHaveLength(1)
    // Daily budget is checked first
    expect(result.rejected[0].reason).toContain('daily_budget')
  })

  it('allows over-limit work via cohort borrowing', async () => {
    mockGetQuotaConfig.mockResolvedValue(
      makeQuota({ maxConcurrentSessions: 3 })
    )
    mockGetQuotaUsage.mockResolvedValue(
      makeUsage({ currentSessions: 3 }) // At limit
    )
    // Borrowing available
    mockCheckQuotaWithBorrowing.mockResolvedValue({
      allowed: true,
      reason: 'ok',
      borrowed: true,
    })

    const result = await filterByQuota([makeWork()])

    expect(result.allowed).toHaveLength(1)
    expect(result.rejected).toHaveLength(0)
  })

  it('rejects over-limit work when borrowing unavailable', async () => {
    mockGetQuotaConfig.mockResolvedValue(
      makeQuota({ maxConcurrentSessions: 3 })
    )
    mockGetQuotaUsage.mockResolvedValue(
      makeUsage({ currentSessions: 3 }) // At limit
    )
    // No borrowing available
    mockCheckQuotaWithBorrowing.mockResolvedValue({
      allowed: false,
      reason: 'concurrent_limit',
      borrowed: false,
    })

    const result = await filterByQuota([makeWork()])

    expect(result.allowed).toHaveLength(0)
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0].reason).toContain('concurrent_limit')
  })
})
