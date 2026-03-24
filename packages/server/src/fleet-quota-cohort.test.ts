import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./fleet-quota-storage.js', () => ({
  getQuotaConfig: vi.fn(),
  getCohortForProject: vi.fn(),
}))

vi.mock('./fleet-quota-tracker.js', () => ({
  getQuotaUsage: vi.fn(),
}))

import {
  getAvailableBorrowingCapacity,
  checkQuotaWithBorrowing,
} from './fleet-quota-cohort.js'
import { getQuotaConfig, getCohortForProject } from './fleet-quota-storage.js'
import { getQuotaUsage } from './fleet-quota-tracker.js'
import type { FleetQuota, FleetQuotaUsage, CohortConfig } from './fleet-quota-types.js'

const mockGetQuotaConfig = vi.mocked(getQuotaConfig)
const mockGetCohortForProject = vi.mocked(getCohortForProject)
const mockGetQuotaUsage = vi.mocked(getQuotaUsage)

function makeQuota(overrides: Partial<FleetQuota> = {}): FleetQuota {
  return {
    name: 'alpha',
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

describe('getAvailableBorrowingCapacity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 0 when project is not in any cohort', async () => {
    mockGetCohortForProject.mockResolvedValue(null)

    const result = await getAvailableBorrowingCapacity('alpha')

    expect(result.available).toBe(0)
    expect(result.breakdown).toEqual([])
  })

  it('returns 0 when project has no borrowingLimit', async () => {
    mockGetCohortForProject.mockResolvedValue({
      name: 'eng',
      projects: ['alpha', 'beta'],
    })
    mockGetQuotaConfig.mockResolvedValue(
      makeQuota({ name: 'alpha', borrowingLimit: undefined })
    )

    const result = await getAvailableBorrowingCapacity('alpha')
    expect(result.available).toBe(0)
  })

  it('calculates available capacity from idle peer', async () => {
    mockGetCohortForProject.mockResolvedValue({
      name: 'eng',
      projects: ['alpha', 'beta'],
    })
    // alpha: borrower with limit 3
    mockGetQuotaConfig.mockImplementation(async (name: string) => {
      if (name === 'alpha')
        return makeQuota({ name: 'alpha', borrowingLimit: 3, cohort: 'eng' })
      if (name === 'beta')
        return makeQuota({
          name: 'beta',
          maxConcurrentSessions: 5,
          lendingLimit: 2,
        })
      return null
    })
    // beta: 1 of 5 sessions used, lending limit 2
    mockGetQuotaUsage.mockImplementation(async (name: string) => {
      if (name === 'beta') return makeUsage({ currentSessions: 1 })
      return makeUsage()
    })

    const result = await getAvailableBorrowingCapacity('alpha')

    expect(result.available).toBe(2) // min(lendingLimit=2, unused=4) = 2, capped by borrowingLimit=3
    expect(result.breakdown).toHaveLength(1)
    expect(result.breakdown[0]).toEqual({
      project: 'beta',
      maxConcurrent: 5,
      currentSessions: 1,
      lendingLimit: 2,
      availableToLend: 2,
    })
  })

  it('caps by borrowingLimit when peers have more capacity', async () => {
    mockGetCohortForProject.mockResolvedValue({
      name: 'eng',
      projects: ['alpha', 'beta', 'gamma'],
    })
    mockGetQuotaConfig.mockImplementation(async (name: string) => {
      if (name === 'alpha')
        return makeQuota({ name: 'alpha', borrowingLimit: 1, cohort: 'eng' })
      if (name === 'beta')
        return makeQuota({ name: 'beta', maxConcurrentSessions: 10, lendingLimit: 5 })
      if (name === 'gamma')
        return makeQuota({ name: 'gamma', maxConcurrentSessions: 10, lendingLimit: 5 })
      return null
    })
    mockGetQuotaUsage.mockResolvedValue(makeUsage({ currentSessions: 0 }))

    const result = await getAvailableBorrowingCapacity('alpha')

    // Peers have 10 total capacity, but borrowingLimit is 1
    expect(result.available).toBe(1)
  })

  it('returns 0 when all peers are at capacity', async () => {
    mockGetCohortForProject.mockResolvedValue({
      name: 'eng',
      projects: ['alpha', 'beta'],
    })
    mockGetQuotaConfig.mockImplementation(async (name: string) => {
      if (name === 'alpha')
        return makeQuota({ name: 'alpha', borrowingLimit: 3, cohort: 'eng' })
      if (name === 'beta')
        return makeQuota({ name: 'beta', maxConcurrentSessions: 5, lendingLimit: 2 })
      return null
    })
    // beta: full — 5 of 5 sessions used
    mockGetQuotaUsage.mockImplementation(async (name: string) => {
      if (name === 'beta') return makeUsage({ currentSessions: 5 })
      return makeUsage()
    })

    const result = await getAvailableBorrowingCapacity('alpha')

    expect(result.available).toBe(0)
    expect(result.breakdown[0].availableToLend).toBe(0)
  })

  it('excludes peers with no lendingLimit', async () => {
    mockGetCohortForProject.mockResolvedValue({
      name: 'eng',
      projects: ['alpha', 'beta'],
    })
    mockGetQuotaConfig.mockImplementation(async (name: string) => {
      if (name === 'alpha')
        return makeQuota({ name: 'alpha', borrowingLimit: 3, cohort: 'eng' })
      if (name === 'beta')
        return makeQuota({ name: 'beta', maxConcurrentSessions: 10, lendingLimit: 0 })
      return null
    })
    mockGetQuotaUsage.mockResolvedValue(makeUsage({ currentSessions: 0 }))

    const result = await getAvailableBorrowingCapacity('alpha')
    expect(result.available).toBe(0)
    expect(result.breakdown).toHaveLength(0)
  })
})

describe('checkQuotaWithBorrowing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('allows when no quota config exists (opt-in)', async () => {
    mockGetQuotaConfig.mockResolvedValue(null)

    const result = await checkQuotaWithBorrowing('untracked')

    expect(result.allowed).toBe(true)
    expect(result.borrowed).toBe(false)
    expect(result.reason).toBe('ok')
  })

  it('allows when under own concurrent limit (no borrowing needed)', async () => {
    mockGetQuotaConfig.mockResolvedValue(
      makeQuota({ maxConcurrentSessions: 5 })
    )
    mockGetQuotaUsage.mockResolvedValue(makeUsage({ currentSessions: 3 }))

    const result = await checkQuotaWithBorrowing('alpha')

    expect(result.allowed).toBe(true)
    expect(result.borrowed).toBe(false)
  })

  it('rejects when daily budget exceeded', async () => {
    mockGetQuotaConfig.mockResolvedValue(
      makeQuota({ maxDailyCostUsd: 50 })
    )
    mockGetQuotaUsage.mockResolvedValue(makeUsage({ dailyCostUsd: 50 }))

    const result = await checkQuotaWithBorrowing('alpha')

    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('daily_budget')
    expect(result.borrowed).toBe(false)
  })

  it('rejects when over limit and no cohort', async () => {
    mockGetQuotaConfig.mockResolvedValue(
      makeQuota({ maxConcurrentSessions: 3, cohort: undefined })
    )
    mockGetQuotaUsage.mockResolvedValue(makeUsage({ currentSessions: 3 }))

    const result = await checkQuotaWithBorrowing('alpha')

    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('concurrent_limit')
    expect(result.borrowed).toBe(false)
  })

  it('rejects when over limit and borrowingLimit is 0', async () => {
    mockGetQuotaConfig.mockResolvedValue(
      makeQuota({
        maxConcurrentSessions: 3,
        cohort: 'eng',
        borrowingLimit: 0,
      })
    )
    mockGetQuotaUsage.mockResolvedValue(makeUsage({ currentSessions: 3 }))

    const result = await checkQuotaWithBorrowing('alpha')

    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('concurrent_limit')
  })

  it('rejects when borrowing limit already reached', async () => {
    mockGetQuotaConfig.mockResolvedValue(
      makeQuota({
        maxConcurrentSessions: 3,
        cohort: 'eng',
        borrowingLimit: 2,
      })
    )
    // Already 5 sessions (3 own + 2 borrowed = at borrowing limit)
    mockGetQuotaUsage.mockResolvedValue(makeUsage({ currentSessions: 5 }))

    const result = await checkQuotaWithBorrowing('alpha')

    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('concurrent_limit')
  })

  it('allows via borrowing when peers have capacity', async () => {
    mockGetQuotaConfig.mockImplementation(async (name: string) => {
      if (name === 'alpha')
        return makeQuota({
          name: 'alpha',
          maxConcurrentSessions: 3,
          cohort: 'eng',
          borrowingLimit: 2,
        })
      if (name === 'beta')
        return makeQuota({
          name: 'beta',
          maxConcurrentSessions: 5,
          lendingLimit: 3,
        })
      return null
    })
    // alpha: at limit (3/3)
    mockGetQuotaUsage.mockImplementation(async (name: string) => {
      if (name === 'alpha') return makeUsage({ currentSessions: 3 })
      if (name === 'beta') return makeUsage({ currentSessions: 1 })
      return makeUsage()
    })
    mockGetCohortForProject.mockResolvedValue({
      name: 'eng',
      projects: ['alpha', 'beta'],
    })

    const result = await checkQuotaWithBorrowing('alpha')

    expect(result.allowed).toBe(true)
    expect(result.borrowed).toBe(true)
    expect(result.reason).toBe('ok')
  })

  it('rejects when peers have no available capacity', async () => {
    mockGetQuotaConfig.mockImplementation(async (name: string) => {
      if (name === 'alpha')
        return makeQuota({
          name: 'alpha',
          maxConcurrentSessions: 3,
          cohort: 'eng',
          borrowingLimit: 2,
        })
      if (name === 'beta')
        return makeQuota({
          name: 'beta',
          maxConcurrentSessions: 5,
          lendingLimit: 3,
        })
      return null
    })
    mockGetQuotaUsage.mockImplementation(async (name: string) => {
      if (name === 'alpha') return makeUsage({ currentSessions: 3 })
      // beta is full
      if (name === 'beta') return makeUsage({ currentSessions: 5 })
      return makeUsage()
    })
    mockGetCohortForProject.mockResolvedValue({
      name: 'eng',
      projects: ['alpha', 'beta'],
    })

    const result = await checkQuotaWithBorrowing('alpha')

    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('concurrent_limit')
    expect(result.borrowed).toBe(false)
  })

  it('single-project cohort: cannot borrow from self', async () => {
    mockGetQuotaConfig.mockResolvedValue(
      makeQuota({
        name: 'alpha',
        maxConcurrentSessions: 3,
        cohort: 'solo',
        borrowingLimit: 2,
      })
    )
    mockGetQuotaUsage.mockResolvedValue(makeUsage({ currentSessions: 3 }))
    mockGetCohortForProject.mockResolvedValue({
      name: 'solo',
      projects: ['alpha'],
    })

    const result = await checkQuotaWithBorrowing('alpha')

    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('concurrent_limit')
  })
})
