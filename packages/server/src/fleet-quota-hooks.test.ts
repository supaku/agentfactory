import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./fleet-quota-storage.js', () => ({
  getQuotaConfig: vi.fn(),
}))

vi.mock('./fleet-quota-tracker.js', () => ({
  addConcurrentSession: vi.fn(() => 1),
  removeConcurrentSession: vi.fn(() => 0),
  addDailyCost: vi.fn(() => 0),
}))

import {
  onSessionClaimed,
  onSessionTerminated,
  onCostUpdated,
} from './fleet-quota-hooks.js'
import { getQuotaConfig } from './fleet-quota-storage.js'
import {
  addConcurrentSession,
  removeConcurrentSession,
  addDailyCost,
} from './fleet-quota-tracker.js'
import type { FleetQuota } from './fleet-quota-types.js'

const mockGetQuotaConfig = vi.mocked(getQuotaConfig)
const mockAddConcurrentSession = vi.mocked(addConcurrentSession)
const mockRemoveConcurrentSession = vi.mocked(removeConcurrentSession)
const mockAddDailyCost = vi.mocked(addDailyCost)

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
