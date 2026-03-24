import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./redis.js', () => ({
  redisSet: vi.fn(),
  redisGet: vi.fn(),
  redisDel: vi.fn(),
  redisKeys: vi.fn(() => []),
}))

import {
  setQuotaConfig,
  getQuotaConfig,
  getAllQuotaConfigs,
  deleteQuotaConfig,
  setCohortConfig,
  getCohortConfig,
  getCohortForProject,
} from './fleet-quota-storage.js'
import type { FleetQuota, CohortConfig } from './fleet-quota-types.js'
import { redisSet, redisGet, redisDel, redisKeys } from './redis.js'

const mockRedisSet = vi.mocked(redisSet)
const mockRedisGet = vi.mocked(redisGet)
const mockRedisDel = vi.mocked(redisDel)
const mockRedisKeys = vi.mocked(redisKeys)

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

function makeCohort(overrides: Partial<CohortConfig> = {}): CohortConfig {
  return {
    name: 'engineering',
    projects: ['team-alpha', 'team-beta'],
    ...overrides,
  }
}

describe('setQuotaConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('stores quota config at the correct key', async () => {
    const quota = makeQuota({ name: 'my-project' })
    await setQuotaConfig(quota)

    expect(mockRedisSet).toHaveBeenCalledWith(
      'fleet:quota:config:my-project',
      quota
    )
  })
})

describe('getQuotaConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns quota config when it exists', async () => {
    const quota = makeQuota()
    mockRedisGet.mockResolvedValue(quota)

    const result = await getQuotaConfig('team-alpha')

    expect(result).toEqual(quota)
    expect(mockRedisGet).toHaveBeenCalledWith('fleet:quota:config:team-alpha')
  })

  it('returns null when config does not exist', async () => {
    mockRedisGet.mockResolvedValue(null)

    const result = await getQuotaConfig('nonexistent')
    expect(result).toBeNull()
  })
})

describe('getAllQuotaConfigs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns all quota configs', async () => {
    const q1 = makeQuota({ name: 'alpha' })
    const q2 = makeQuota({ name: 'beta' })

    mockRedisKeys.mockResolvedValue([
      'fleet:quota:config:alpha',
      'fleet:quota:config:beta',
    ])
    mockRedisGet
      .mockResolvedValueOnce(q1)
      .mockResolvedValueOnce(q2)

    const result = await getAllQuotaConfigs()

    expect(result).toHaveLength(2)
    expect(result).toEqual([q1, q2])
  })

  it('returns empty array when no configs exist', async () => {
    mockRedisKeys.mockResolvedValue([])

    const result = await getAllQuotaConfigs()
    expect(result).toEqual([])
  })

  it('skips null entries from Redis', async () => {
    mockRedisKeys.mockResolvedValue([
      'fleet:quota:config:alpha',
      'fleet:quota:config:gone',
    ])
    mockRedisGet
      .mockResolvedValueOnce(makeQuota({ name: 'alpha' }))
      .mockResolvedValueOnce(null)

    const result = await getAllQuotaConfigs()
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('alpha')
  })
})

describe('deleteQuotaConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns true when config was deleted', async () => {
    mockRedisDel.mockResolvedValue(1)

    const result = await deleteQuotaConfig('team-alpha')

    expect(result).toBe(true)
    expect(mockRedisDel).toHaveBeenCalledWith('fleet:quota:config:team-alpha')
  })

  it('returns false when config did not exist', async () => {
    mockRedisDel.mockResolvedValue(0)

    const result = await deleteQuotaConfig('nonexistent')
    expect(result).toBe(false)
  })
})

describe('setCohortConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('stores cohort config at the correct key', async () => {
    const cohort = makeCohort({ name: 'eng' })
    await setCohortConfig(cohort)

    expect(mockRedisSet).toHaveBeenCalledWith(
      'fleet:quota:cohort:eng',
      cohort
    )
  })
})

describe('getCohortConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns cohort config when it exists', async () => {
    const cohort = makeCohort()
    mockRedisGet.mockResolvedValue(cohort)

    const result = await getCohortConfig('engineering')

    expect(result).toEqual(cohort)
    expect(mockRedisGet).toHaveBeenCalledWith('fleet:quota:cohort:engineering')
  })

  it('returns null when cohort does not exist', async () => {
    mockRedisGet.mockResolvedValue(null)

    const result = await getCohortConfig('nonexistent')
    expect(result).toBeNull()
  })
})

describe('getCohortForProject', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns cohort containing the project', async () => {
    const cohort = makeCohort({ name: 'eng', projects: ['alpha', 'beta'] })

    mockRedisKeys.mockResolvedValue(['fleet:quota:cohort:eng'])
    mockRedisGet.mockResolvedValue(cohort)

    const result = await getCohortForProject('alpha')

    expect(result).toEqual(cohort)
  })

  it('returns null when project is not in any cohort', async () => {
    const cohort = makeCohort({ name: 'eng', projects: ['alpha', 'beta'] })

    mockRedisKeys.mockResolvedValue(['fleet:quota:cohort:eng'])
    mockRedisGet.mockResolvedValue(cohort)

    const result = await getCohortForProject('gamma')
    expect(result).toBeNull()
  })

  it('returns null when no cohorts exist', async () => {
    mockRedisKeys.mockResolvedValue([])

    const result = await getCohortForProject('alpha')
    expect(result).toBeNull()
  })

  it('returns first matching cohort when project is in multiple', async () => {
    const cohort1 = makeCohort({ name: 'eng', projects: ['alpha'] })
    const cohort2 = makeCohort({ name: 'platform', projects: ['alpha'] })

    mockRedisKeys.mockResolvedValue([
      'fleet:quota:cohort:eng',
      'fleet:quota:cohort:platform',
    ])
    mockRedisGet
      .mockResolvedValueOnce(cohort1)
      .mockResolvedValueOnce(cohort2)

    const result = await getCohortForProject('alpha')
    expect(result).toEqual(cohort1)
  })
})
