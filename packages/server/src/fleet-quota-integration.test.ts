/**
 * Fleet Quota Integration Tests
 *
 * Tests the full lifecycle chain: hooks → tracker → filter → cohort.
 * Uses a shared in-memory Redis mock so all modules see the same state.
 *
 * Covers:
 * - SUP-1332: claim → complete lifecycle with quota counter verification
 * - SUP-1335: over-quota project rejected, under-quota allowed
 * - SUP-1340: project A at quota borrows from idle project B in same cohort
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Shared in-memory store for all Redis operations
const store = new Map<string, string>()
const sets = new Map<string, Set<string>>()

function resetStore() {
  store.clear()
  sets.clear()
}

// Mock Redis at the lowest level — all modules import from ./redis.js
vi.mock('./redis.js', () => ({
  isRedisConfigured: () => true,
  redisSet: vi.fn(async (key: string, value: unknown, _ttl?: number) => {
    store.set(key, JSON.stringify(value))
  }),
  redisGet: vi.fn(async <T>(key: string): Promise<T | null> => {
    const val = store.get(key)
    return val ? JSON.parse(val) : null
  }),
  redisDel: vi.fn(async (key: string): Promise<number> => {
    const existed = store.has(key) || sets.has(key) ? 1 : 0
    store.delete(key)
    sets.delete(key)
    return existed
  }),
  redisKeys: vi.fn(async (pattern: string): Promise<string[]> => {
    const prefix = pattern.replace('*', '')
    const allKeys = [...store.keys(), ...sets.keys()]
    return allKeys.filter((k) => k.startsWith(prefix))
  }),
  redisExists: vi.fn(async (key: string): Promise<boolean> => {
    return store.has(key) || sets.has(key)
  }),
  redisExpire: vi.fn(async () => true),
  redisSAdd: vi.fn(async (key: string, member: string): Promise<number> => {
    if (!sets.has(key)) sets.set(key, new Set())
    const s = sets.get(key)!
    const isNew = !s.has(member)
    s.add(member)
    return isNew ? 1 : 0
  }),
  redisSRem: vi.fn(async (key: string, member: string): Promise<number> => {
    const s = sets.get(key)
    if (!s) return 0
    const existed = s.has(member)
    s.delete(member)
    return existed ? 1 : 0
  }),
  redisSCard: vi.fn(async (key: string): Promise<number> => {
    return sets.get(key)?.size ?? 0
  }),
  redisSMembers: vi.fn(async (key: string): Promise<string[]> => {
    return [...(sets.get(key) ?? [])]
  }),
  redisIncrByFloat: vi.fn(async (key: string, increment: number): Promise<number> => {
    const current = parseFloat(store.get(key) ?? '0')
    const next = current + increment
    store.set(key, String(next))
    return next
  }),
  redisEval: vi.fn(async (script: string, keys: string[], args: (string | number)[]): Promise<unknown> => {
    // Simulate the atomic borrow Lua script in JS
    const borrowerKey = keys[0]
    const sessionId = String(args[0])
    const maxConcurrent = Number(args[1])
    const borrowingLimit = Number(args[2])
    const peerCount = Number(args[3])

    // Get borrower's current session count
    const borrowerSessions = sets.get(borrowerKey)?.size ?? 0

    // If under own limit, just add
    if (borrowerSessions < maxConcurrent) {
      if (!sets.has(borrowerKey)) sets.set(borrowerKey, new Set())
      sets.get(borrowerKey)!.add(sessionId)
      return 1
    }

    // Check borrowing limit
    const alreadyBorrowed = borrowerSessions - maxConcurrent
    if (alreadyBorrowed >= borrowingLimit) return 0

    // Calculate peer lending capacity
    let totalAvailable = 0
    for (let i = 0; i < peerCount; i++) {
      const peerKey = String(args[4 + i])
      const peerMax = Number(args[4 + peerCount + i])
      const peerLendingLimit = Number(args[4 + 2 * peerCount + i])
      const peerSessions = sets.get(peerKey)?.size ?? 0
      const unused = Math.max(0, peerMax - peerSessions)
      const canLend = Math.min(peerLendingLimit, unused)
      totalAvailable += canLend
    }

    const remaining = borrowingLimit - alreadyBorrowed
    const available = Math.min(totalAvailable, remaining)

    if (available > 0) {
      if (!sets.has(borrowerKey)) sets.set(borrowerKey, new Set())
      sets.get(borrowerKey)!.add(sessionId)
      return 1
    }

    return 0
  }),
  redisSetNX: vi.fn(),
  redisHSet: vi.fn(),
  redisHGet: vi.fn(),
  redisHDel: vi.fn(),
  redisHMGet: vi.fn(),
  redisHGetAll: vi.fn(),
  redisHLen: vi.fn(),
  redisZAdd: vi.fn(),
  redisZRem: vi.fn(),
  redisZRangeByScore: vi.fn(),
  redisZCard: vi.fn(),
  redisZPopMin: vi.fn(),
  redisRPush: vi.fn(),
  redisLPop: vi.fn(),
  redisLRange: vi.fn(),
  redisLLen: vi.fn(),
  redisLRem: vi.fn(),
  getRedisClient: vi.fn(),
  disconnectRedis: vi.fn(),
}))

// Now import the modules under test — they all share the mocked Redis
import {
  setQuotaConfig,
  getQuotaConfig,
  setCohortConfig,
} from './fleet-quota-storage.js'
import {
  addConcurrentSession,
  removeConcurrentSession,
  getConcurrentSessionCount,
  getDailyCost,
  getQuotaUsage,
  cleanupStaleSessions,
} from './fleet-quota-tracker.js'
import {
  onSessionClaimed,
  onSessionTerminated,
  onCostUpdated,
} from './fleet-quota-hooks.js'
import { filterByQuota } from './fleet-quota-filter.js'
import {
  checkQuotaWithBorrowing,
  getAvailableBorrowingCapacity,
  tryAtomicBorrow,
} from './fleet-quota-cohort.js'
import type { FleetQuota, CohortConfig } from './fleet-quota-types.js'
import type { QueuedWork } from './work-queue.js'

function makeQuota(overrides: Partial<FleetQuota> = {}): FleetQuota {
  return {
    name: 'alpha',
    scope: 'project',
    maxConcurrentSessions: 3,
    maxDailyCostUsd: 100,
    maxSessionCostUsd: 20,
    ...overrides,
  }
}

function makeWork(overrides: Partial<QueuedWork> = {}): QueuedWork {
  return {
    sessionId: 'sess-1',
    issueId: 'issue-1',
    issueIdentifier: 'PROJ-1',
    priority: 3,
    queuedAt: Date.now(),
    projectName: 'alpha',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// SUP-1332: Session lifecycle integration
// ---------------------------------------------------------------------------

describe('SUP-1332: Session lifecycle hooks integration', () => {
  beforeEach(() => {
    resetStore()
  })

  it('claim increments → filter sees count → termination decrements', async () => {
    // Setup: project "alpha" with max 2 concurrent sessions
    await setQuotaConfig(makeQuota({ name: 'alpha', maxConcurrentSessions: 2 }))

    // Phase 1: Claim two sessions via hooks
    await onSessionClaimed('alpha', 'sess-1')
    await onSessionClaimed('alpha', 'sess-2')

    // Verify tracker state
    const count = await getConcurrentSessionCount('alpha')
    expect(count).toBe(2)

    // Phase 2: Filter should now reject (at limit)
    const work = [makeWork({ sessionId: 'sess-3', projectName: 'alpha' })]
    const result = await filterByQuota(work)
    expect(result.allowed).toHaveLength(0)
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0].reason).toContain('concurrent_limit')

    // Phase 3: Terminate one session
    await onSessionTerminated('alpha', 'sess-1', 10.5)

    // Verify count decremented
    const countAfter = await getConcurrentSessionCount('alpha')
    expect(countAfter).toBe(1)

    // Verify daily cost recorded
    const dailyCost = await getDailyCost('alpha')
    expect(dailyCost).toBe(10.5)

    // Phase 4: Filter should now allow (under limit)
    const result2 = await filterByQuota(work)
    expect(result2.allowed).toHaveLength(1)
    expect(result2.rejected).toHaveLength(0)
  })

  it('cost update hook tracks incremental cost deltas', async () => {
    await setQuotaConfig(makeQuota({ name: 'alpha', maxDailyCostUsd: 50 }))

    // Simulate progressive cost updates mid-session
    await onCostUpdated('alpha', 0, 5.0) // +5
    await onCostUpdated('alpha', 5.0, 12.0) // +7
    await onCostUpdated('alpha', 12.0, 12.0) // +0 (no-op)
    await onCostUpdated('alpha', 12.0, 10.0) // negative delta (no-op)

    const cost = await getDailyCost('alpha')
    expect(cost).toBe(12.0) // 5 + 7
  })

  it('termination is idempotent (double-remove is safe)', async () => {
    await setQuotaConfig(makeQuota({ name: 'alpha' }))

    await onSessionClaimed('alpha', 'sess-1')
    expect(await getConcurrentSessionCount('alpha')).toBe(1)

    await onSessionTerminated('alpha', 'sess-1', 5.0)
    expect(await getConcurrentSessionCount('alpha')).toBe(0)

    // Second termination should not cause negative count
    await onSessionTerminated('alpha', 'sess-1', 5.0)
    expect(await getConcurrentSessionCount('alpha')).toBe(0)
  })

  it('hooks are no-op for projects without quota config', async () => {
    // No quota config set for "untracked"
    await onSessionClaimed('untracked', 'sess-1')
    await onSessionTerminated('untracked', 'sess-1', 10)
    await onCostUpdated('untracked', 0, 10)

    // Should not create any keys
    expect(await getConcurrentSessionCount('untracked')).toBe(0)
    expect(await getDailyCost('untracked')).toBe(0)
  })

  it('cleanupStaleSessions removes entries not in active set', async () => {
    await setQuotaConfig(makeQuota({ name: 'alpha' }))

    // Add some sessions directly to tracker
    await addConcurrentSession('alpha', 'sess-active')
    await addConcurrentSession('alpha', 'sess-stale-1')
    await addConcurrentSession('alpha', 'sess-stale-2')

    expect(await getConcurrentSessionCount('alpha')).toBe(3)

    // Only sess-active is truly active
    const activeIds = new Set(['sess-active'])
    const removed = await cleanupStaleSessions('alpha', activeIds)

    expect(removed).toBe(2)
    expect(await getConcurrentSessionCount('alpha')).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// SUP-1335: QuotaFilter integration
// ---------------------------------------------------------------------------

describe('SUP-1335: QuotaFilter integration', () => {
  beforeEach(() => {
    resetStore()
  })

  it('over-quota project rejected, under-quota allowed', async () => {
    // Setup: alpha has max 1 session, beta has max 5
    await setQuotaConfig(makeQuota({ name: 'alpha', maxConcurrentSessions: 1 }))
    await setQuotaConfig(makeQuota({ name: 'beta', maxConcurrentSessions: 5 }))

    // alpha already has 1 session
    await addConcurrentSession('alpha', 'existing-sess')

    const work = [
      makeWork({ sessionId: 'sess-a', projectName: 'alpha' }),
      makeWork({ sessionId: 'sess-b', projectName: 'beta' }),
      makeWork({ sessionId: 'sess-c', projectName: 'untracked' }), // no config = allow
    ]

    const result = await filterByQuota(work)

    // alpha rejected (at limit), beta + untracked allowed
    expect(result.allowed).toHaveLength(2)
    expect(result.allowed.map((w) => w.sessionId).sort()).toEqual(['sess-b', 'sess-c'])
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0].work.sessionId).toBe('sess-a')
    expect(result.rejected[0].reason).toContain('concurrent_limit')
  })

  it('daily budget exceeded rejects all work for that project', async () => {
    await setQuotaConfig(makeQuota({ name: 'alpha', maxDailyCostUsd: 50, maxConcurrentSessions: 10 }))

    // Spend the full daily budget
    // We need to add cost directly via the tracker since the store mock handles INCRBYFLOAT
    const todayDate = new Date().toISOString().slice(0, 10)
    store.set(`fleet:quota:daily:alpha:${todayDate}`, '50')

    const work = [makeWork({ sessionId: 'sess-1', projectName: 'alpha' })]
    const result = await filterByQuota(work)

    expect(result.allowed).toHaveLength(0)
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0].reason).toContain('daily_budget')
  })

  it('projects without quota config pass through (opt-in)', async () => {
    const work = [
      makeWork({ sessionId: 'sess-1', projectName: 'no-config-project' }),
      makeWork({ sessionId: 'sess-2' }), // no projectName
    ]

    const result = await filterByQuota(work)
    expect(result.allowed).toHaveLength(2)
    expect(result.rejected).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// SUP-1340: Cohort borrowing integration
// ---------------------------------------------------------------------------

describe('SUP-1340: Cohort borrowing integration', () => {
  beforeEach(() => {
    resetStore()
  })

  it('project A at quota borrows from idle project B in same cohort', async () => {
    // Setup: alpha (max 2, borrowingLimit 2) and beta (max 5, lendingLimit 3) in "eng" cohort
    await setQuotaConfig(
      makeQuota({
        name: 'alpha',
        maxConcurrentSessions: 2,
        cohort: 'eng',
        borrowingLimit: 2,
      })
    )
    await setQuotaConfig(
      makeQuota({
        name: 'beta',
        maxConcurrentSessions: 5,
        lendingLimit: 3,
      })
    )
    await setCohortConfig({ name: 'eng', projects: ['alpha', 'beta'] })

    // alpha at capacity (2/2)
    await addConcurrentSession('alpha', 'sess-1')
    await addConcurrentSession('alpha', 'sess-2')

    // beta is idle (0/5)

    // Check borrowing
    const check = await checkQuotaWithBorrowing('alpha')
    expect(check.allowed).toBe(true)
    expect(check.borrowed).toBe(true)
    expect(check.reason).toBe('ok')
  })

  it('rejects borrowing when all peers are at capacity', async () => {
    await setQuotaConfig(
      makeQuota({
        name: 'alpha',
        maxConcurrentSessions: 2,
        cohort: 'eng',
        borrowingLimit: 2,
      })
    )
    await setQuotaConfig(
      makeQuota({
        name: 'beta',
        maxConcurrentSessions: 3,
        lendingLimit: 2,
      })
    )
    await setCohortConfig({ name: 'eng', projects: ['alpha', 'beta'] })

    // alpha at capacity
    await addConcurrentSession('alpha', 'sess-1')
    await addConcurrentSession('alpha', 'sess-2')

    // beta also at capacity (3/3)
    await addConcurrentSession('beta', 'sess-b1')
    await addConcurrentSession('beta', 'sess-b2')
    await addConcurrentSession('beta', 'sess-b3')

    const check = await checkQuotaWithBorrowing('alpha')
    expect(check.allowed).toBe(false)
    expect(check.reason).toBe('concurrent_limit')
    expect(check.borrowed).toBe(false)
  })

  it('filter uses borrowing for over-quota projects in cohort', async () => {
    await setQuotaConfig(
      makeQuota({
        name: 'alpha',
        maxConcurrentSessions: 1,
        cohort: 'eng',
        borrowingLimit: 2,
      })
    )
    await setQuotaConfig(
      makeQuota({
        name: 'beta',
        maxConcurrentSessions: 5,
        lendingLimit: 3,
      })
    )
    await setCohortConfig({ name: 'eng', projects: ['alpha', 'beta'] })

    // alpha at limit (1/1)
    await addConcurrentSession('alpha', 'existing')

    const work = [makeWork({ sessionId: 'new-sess', projectName: 'alpha' })]
    const result = await filterByQuota(work)

    // Should be allowed via borrowing from beta
    expect(result.allowed).toHaveLength(1)
    expect(result.rejected).toHaveLength(0)
  })

  it('tryAtomicBorrow atomically adds session when capacity available', async () => {
    // Setup: alpha at capacity, beta has spare capacity
    await addConcurrentSession('alpha', 'sess-1')
    await addConcurrentSession('alpha', 'sess-2')
    // beta idle

    const borrowed = await tryAtomicBorrow(
      'alpha',
      'sess-3',
      2, // maxConcurrentSessions
      3, // borrowingLimit
      [
        { quotaName: 'beta', maxConcurrentSessions: 5, lendingLimit: 3 },
      ]
    )

    expect(borrowed).toBe(true)
    // Session should be in alpha's concurrent set
    expect(await getConcurrentSessionCount('alpha')).toBe(3)
  })

  it('tryAtomicBorrow rejects when no peer capacity', async () => {
    // alpha at capacity
    await addConcurrentSession('alpha', 'sess-1')
    await addConcurrentSession('alpha', 'sess-2')
    // beta also full
    await addConcurrentSession('beta', 'sess-b1')
    await addConcurrentSession('beta', 'sess-b2')
    await addConcurrentSession('beta', 'sess-b3')

    const borrowed = await tryAtomicBorrow(
      'alpha',
      'sess-3',
      2, // maxConcurrentSessions
      3, // borrowingLimit
      [
        { quotaName: 'beta', maxConcurrentSessions: 3, lendingLimit: 2 },
      ]
    )

    expect(borrowed).toBe(false)
    // Session should NOT be in alpha's concurrent set
    expect(await getConcurrentSessionCount('alpha')).toBe(2)
  })

  it('tryAtomicBorrow respects borrowing limit', async () => {
    // alpha at capacity with 2 already borrowed (at borrowingLimit of 2)
    await addConcurrentSession('alpha', 'sess-1')
    await addConcurrentSession('alpha', 'sess-2')
    await addConcurrentSession('alpha', 'sess-3') // borrowed
    await addConcurrentSession('alpha', 'sess-4') // borrowed

    const borrowed = await tryAtomicBorrow(
      'alpha',
      'sess-5',
      2, // maxConcurrentSessions = 2 (so 4-2 = 2 already borrowed)
      2, // borrowingLimit = 2 (already at limit)
      [
        { quotaName: 'beta', maxConcurrentSessions: 10, lendingLimit: 5 },
      ]
    )

    expect(borrowed).toBe(false)
    expect(await getConcurrentSessionCount('alpha')).toBe(4)
  })

  it('getAvailableBorrowingCapacity aggregates across multiple peers', async () => {
    await setQuotaConfig(
      makeQuota({
        name: 'alpha',
        maxConcurrentSessions: 2,
        cohort: 'eng',
        borrowingLimit: 5,
      })
    )
    await setQuotaConfig(
      makeQuota({ name: 'beta', maxConcurrentSessions: 4, lendingLimit: 2 })
    )
    await setQuotaConfig(
      makeQuota({ name: 'gamma', maxConcurrentSessions: 6, lendingLimit: 3 })
    )
    await setCohortConfig({ name: 'eng', projects: ['alpha', 'beta', 'gamma'] })

    // beta: 1/4 used, gamma: 2/6 used
    await addConcurrentSession('beta', 'b1')
    await addConcurrentSession('gamma', 'g1')
    await addConcurrentSession('gamma', 'g2')

    const { available, breakdown } = await getAvailableBorrowingCapacity('alpha')

    // beta: min(lendingLimit=2, unused=3) = 2
    // gamma: min(lendingLimit=3, unused=4) = 3
    // total = 5, capped by borrowingLimit=5 → 5
    expect(available).toBe(5)
    expect(breakdown).toHaveLength(2)
    expect(breakdown[0].availableToLend).toBe(2) // beta
    expect(breakdown[1].availableToLend).toBe(3) // gamma
  })
})
