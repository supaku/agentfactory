import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./fleet-quota-storage.js', () => ({
  getQuotaConfig: vi.fn(),
  getCohortConfig: vi.fn(),
}))

vi.mock('./fleet-quota-tracker.js', () => ({
  addConcurrentSession: vi.fn(() => 1),
  removeConcurrentSession: vi.fn(() => 0),
  getConcurrentSessionCount: vi.fn(() => 0),
  addDailyCost: vi.fn(() => 0),
}))

vi.mock('./fleet-quota-cohort.js', () => ({
  tryAtomicBorrow: vi.fn(() => true),
}))

import {
  onSessionClaimed,
  onSessionTerminated,
  onCostUpdated,
} from './fleet-quota-hooks.js'
import { getQuotaConfig, getCohortConfig } from './fleet-quota-storage.js'
import {
  addConcurrentSession,
  removeConcurrentSession,
  getConcurrentSessionCount,
  addDailyCost,
} from './fleet-quota-tracker.js'
import { tryAtomicBorrow } from './fleet-quota-cohort.js'
import type { FleetQuota, CohortConfig } from './fleet-quota-types.js'

const mockGetQuotaConfig = vi.mocked(getQuotaConfig)
const mockGetCohortConfig = vi.mocked(getCohortConfig)
const mockAddConcurrentSession = vi.mocked(addConcurrentSession)
const mockRemoveConcurrentSession = vi.mocked(removeConcurrentSession)
const mockGetConcurrentSessionCount = vi.mocked(getConcurrentSessionCount)
const mockAddDailyCost = vi.mocked(addDailyCost)
const mockTryAtomicBorrow = vi.mocked(tryAtomicBorrow)

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

describe('onSessionClaimed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('increments concurrent session when quota config exists', async () => {
    mockGetQuotaConfig.mockResolvedValue(makeQuota())
    mockAddConcurrentSession.mockResolvedValue(3)

    await onSessionClaimed('team-alpha', 'sess-1')

    expect(mockGetQuotaConfig).toHaveBeenCalledWith('team-alpha')
    expect(mockAddConcurrentSession).toHaveBeenCalledWith('team-alpha', 'sess-1')
  })

  it('is no-op when projectName is undefined', async () => {
    await onSessionClaimed(undefined, 'sess-1')

    expect(mockGetQuotaConfig).not.toHaveBeenCalled()
    expect(mockAddConcurrentSession).not.toHaveBeenCalled()
  })

  it('is no-op when no quota config exists for project', async () => {
    mockGetQuotaConfig.mockResolvedValue(null)

    await onSessionClaimed('untracked-project', 'sess-1')

    expect(mockAddConcurrentSession).not.toHaveBeenCalled()
  })

  it('does not throw on quota tracker error', async () => {
    mockGetQuotaConfig.mockResolvedValue(makeQuota())
    mockAddConcurrentSession.mockRejectedValue(new Error('Redis down'))

    await expect(onSessionClaimed('team-alpha', 'sess-1')).resolves.toBeUndefined()
  })

  it('uses tryAtomicBorrow when over own quota with cohort and borrowingLimit', async () => {
    const borrowerQuota = makeQuota({
      cohort: 'engineering',
      borrowingLimit: 3,
      maxConcurrentSessions: 5,
    })
    const peerQuota = makeQuota({
      name: 'team-beta',
      maxConcurrentSessions: 10,
      lendingLimit: 5,
    })
    mockGetQuotaConfig.mockImplementation(async (name) => {
      if (name === 'team-alpha') return borrowerQuota
      if (name === 'team-beta') return peerQuota
      return null
    })
    mockGetConcurrentSessionCount.mockResolvedValue(5) // at limit
    mockGetCohortConfig.mockResolvedValue({
      name: 'engineering',
      projects: ['team-alpha', 'team-beta'],
    })
    mockTryAtomicBorrow.mockResolvedValue(true)

    await onSessionClaimed('team-alpha', 'sess-1')

    expect(mockTryAtomicBorrow).toHaveBeenCalledWith(
      'team-alpha',
      'sess-1',
      5,
      3,
      [{ quotaName: 'team-beta', maxConcurrentSessions: 10, lendingLimit: 5 }]
    )
    expect(mockAddConcurrentSession).not.toHaveBeenCalled()
  })

  it('falls back to simple SADD when atomic borrow fails', async () => {
    const borrowerQuota = makeQuota({
      cohort: 'engineering',
      borrowingLimit: 3,
      maxConcurrentSessions: 5,
    })
    mockGetQuotaConfig.mockResolvedValue(borrowerQuota)
    mockGetConcurrentSessionCount.mockResolvedValue(5) // at limit
    mockGetCohortConfig.mockResolvedValue({
      name: 'engineering',
      projects: ['team-alpha'],
    })
    mockTryAtomicBorrow.mockResolvedValue(false)

    await onSessionClaimed('team-alpha', 'sess-1')

    expect(mockTryAtomicBorrow).toHaveBeenCalled()
    expect(mockAddConcurrentSession).toHaveBeenCalledWith('team-alpha', 'sess-1')
  })

  it('uses simple add when under own quota even with cohort configured', async () => {
    const quota = makeQuota({
      cohort: 'engineering',
      borrowingLimit: 3,
      maxConcurrentSessions: 5,
    })
    mockGetQuotaConfig.mockResolvedValue(quota)
    mockGetConcurrentSessionCount.mockResolvedValue(3) // under limit
    mockAddConcurrentSession.mockResolvedValue(4)

    await onSessionClaimed('team-alpha', 'sess-1')

    expect(mockTryAtomicBorrow).not.toHaveBeenCalled()
    expect(mockAddConcurrentSession).toHaveBeenCalledWith('team-alpha', 'sess-1')
  })

  it('uses simple add when over quota but no cohort configured', async () => {
    const quota = makeQuota({ maxConcurrentSessions: 5 }) // no cohort
    mockGetQuotaConfig.mockResolvedValue(quota)
    mockGetConcurrentSessionCount.mockResolvedValue(5) // at limit
    mockAddConcurrentSession.mockResolvedValue(6)

    await onSessionClaimed('team-alpha', 'sess-1')

    expect(mockTryAtomicBorrow).not.toHaveBeenCalled()
    expect(mockAddConcurrentSession).toHaveBeenCalledWith('team-alpha', 'sess-1')
  })

  it('uses simple add when over quota but borrowingLimit is 0', async () => {
    const quota = makeQuota({
      cohort: 'engineering',
      borrowingLimit: 0,
      maxConcurrentSessions: 5,
    })
    mockGetQuotaConfig.mockResolvedValue(quota)
    mockGetConcurrentSessionCount.mockResolvedValue(5) // at limit
    mockAddConcurrentSession.mockResolvedValue(6)

    await onSessionClaimed('team-alpha', 'sess-1')

    expect(mockTryAtomicBorrow).not.toHaveBeenCalled()
    expect(mockAddConcurrentSession).toHaveBeenCalledWith('team-alpha', 'sess-1')
  })
})

describe('onSessionTerminated', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('decrements concurrent session and adds cost', async () => {
    mockGetQuotaConfig.mockResolvedValue(makeQuota())
    mockRemoveConcurrentSession.mockResolvedValue(2)
    mockAddDailyCost.mockResolvedValue(15.5)

    await onSessionTerminated('team-alpha', 'sess-1', 15.5)

    expect(mockRemoveConcurrentSession).toHaveBeenCalledWith('team-alpha', 'sess-1')
    expect(mockAddDailyCost).toHaveBeenCalledWith('team-alpha', 15.5)
  })

  it('decrements without adding cost when totalCostUsd is 0', async () => {
    mockGetQuotaConfig.mockResolvedValue(makeQuota())
    mockRemoveConcurrentSession.mockResolvedValue(1)

    await onSessionTerminated('team-alpha', 'sess-1', 0)

    expect(mockRemoveConcurrentSession).toHaveBeenCalled()
    expect(mockAddDailyCost).not.toHaveBeenCalled()
  })

  it('decrements without adding cost when totalCostUsd is undefined', async () => {
    mockGetQuotaConfig.mockResolvedValue(makeQuota())
    mockRemoveConcurrentSession.mockResolvedValue(1)

    await onSessionTerminated('team-alpha', 'sess-1')

    expect(mockRemoveConcurrentSession).toHaveBeenCalled()
    expect(mockAddDailyCost).not.toHaveBeenCalled()
  })

  it('is no-op when projectName is undefined', async () => {
    await onSessionTerminated(undefined, 'sess-1', 10)

    expect(mockGetQuotaConfig).not.toHaveBeenCalled()
  })

  it('is no-op when no quota config exists for project', async () => {
    mockGetQuotaConfig.mockResolvedValue(null)

    await onSessionTerminated('untracked', 'sess-1', 10)

    expect(mockRemoveConcurrentSession).not.toHaveBeenCalled()
  })

  it('does not throw on quota tracker error', async () => {
    mockGetQuotaConfig.mockResolvedValue(makeQuota())
    mockRemoveConcurrentSession.mockRejectedValue(new Error('Redis down'))

    await expect(
      onSessionTerminated('team-alpha', 'sess-1', 10)
    ).resolves.toBeUndefined()
  })
})

describe('onCostUpdated', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('adds incremental cost delta', async () => {
    mockGetQuotaConfig.mockResolvedValue(makeQuota())
    mockAddDailyCost.mockResolvedValue(7.5)

    await onCostUpdated('team-alpha', 5.0, 7.5)

    expect(mockAddDailyCost).toHaveBeenCalledWith('team-alpha', 2.5)
  })

  it('is no-op when delta is zero', async () => {
    await onCostUpdated('team-alpha', 5.0, 5.0)

    expect(mockGetQuotaConfig).not.toHaveBeenCalled()
    expect(mockAddDailyCost).not.toHaveBeenCalled()
  })

  it('is no-op when delta is negative', async () => {
    await onCostUpdated('team-alpha', 5.0, 3.0)

    expect(mockGetQuotaConfig).not.toHaveBeenCalled()
    expect(mockAddDailyCost).not.toHaveBeenCalled()
  })

  it('is no-op when projectName is undefined', async () => {
    await onCostUpdated(undefined, 0, 5.0)

    expect(mockGetQuotaConfig).not.toHaveBeenCalled()
  })

  it('is no-op when no quota config exists', async () => {
    mockGetQuotaConfig.mockResolvedValue(null)

    await onCostUpdated('untracked', 0, 5.0)

    expect(mockAddDailyCost).not.toHaveBeenCalled()
  })

  it('does not throw on error', async () => {
    mockGetQuotaConfig.mockResolvedValue(makeQuota())
    mockAddDailyCost.mockRejectedValue(new Error('Redis down'))

    await expect(
      onCostUpdated('team-alpha', 0, 5.0)
    ).resolves.toBeUndefined()
  })
})
