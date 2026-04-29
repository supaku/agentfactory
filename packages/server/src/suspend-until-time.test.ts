/**
 * Tests for the suspend-until-time wake queue + 1Hz sweeper (REN-1398).
 *
 * The Redis ZSET is mocked with an in-memory map keyed by member; score
 * is stored alongside.  This is sufficient for the sweep semantics
 * exercised by the production code (ZRANGEBYSCORE / ZREM / ZADD).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

interface ZEntry {
  score: number
  member: string
}
const zsets = new Map<string, ZEntry[]>()

const mockClient = {
  zrem: vi.fn(async (key: string, member: string) => {
    const set = zsets.get(key) ?? []
    const before = set.length
    const next = set.filter((e) => e.member !== member)
    zsets.set(key, next)
    return before - next.length
  }),
}

vi.mock('./redis.js', () => ({
  isRedisConfigured: vi.fn(() => true),
  getRedisClient: vi.fn(() => mockClient),
  redisZAdd: vi.fn(async (key: string, score: number, member: string) => {
    const set = zsets.get(key) ?? []
    const filtered = set.filter((e) => e.member !== member)
    filtered.push({ score, member })
    zsets.set(key, filtered)
    return 1
  }),
  redisZRem: vi.fn(async (key: string, member: string) => {
    const set = zsets.get(key) ?? []
    const before = set.length
    const next = set.filter((e) => e.member !== member)
    zsets.set(key, next)
    return before - next.length
  }),
  redisZRangeByScore: vi.fn(async (key: string, min: string, max: number) => {
    const set = zsets.get(key) ?? []
    const lo = min === '-inf' ? -Infinity : Number(min)
    return set
      .filter((e) => e.score >= lo && e.score <= max)
      .sort((a, b) => a.score - b.score)
      .map((e) => e.member)
  }),
  redisZCard: vi.fn(async (key: string) => (zsets.get(key) ?? []).length),
}))

vi.mock('./scheduling-queue.js', () => ({
  moveToBackoff: vi.fn(async () => true),
}))

import {
  cancelScheduledWake,
  defaultWakePromoter,
  pendingWakeCount,
  startSuspendSweeper,
  suspendUntil,
  sweepWakeQueue,
  WAKE_QUEUE_KEY,
} from './suspend-until-time.js'
import { moveToBackoff } from './scheduling-queue.js'

beforeEach(() => {
  zsets.clear()
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('suspendUntil', () => {
  it('records the wake-at score in the ZSET', async () => {
    const ok = await suspendUntil('s1', 1700_000_000_000)
    expect(ok).toBe(true)
    expect(zsets.get(WAKE_QUEUE_KEY)).toEqual([
      { score: 1700_000_000_000, member: 's1' },
    ])
  })

  it('upserts on second call (no duplicates)', async () => {
    await suspendUntil('s1', 1700_000_000_000)
    await suspendUntil('s1', 1800_000_000_000)
    const set = zsets.get(WAKE_QUEUE_KEY) ?? []
    expect(set).toHaveLength(1)
    expect(set[0]).toEqual({ score: 1800_000_000_000, member: 's1' })
  })

  it('rejects non-finite wakeAtMs', async () => {
    const ok = await suspendUntil('s1', Number.NaN)
    expect(ok).toBe(false)
  })
})

describe('pendingWakeCount + cancelScheduledWake', () => {
  it('counts and cancels scheduled wakes', async () => {
    await suspendUntil('a', 1)
    await suspendUntil('b', 2)
    expect(await pendingWakeCount()).toBe(2)
    expect(await cancelScheduledWake('a')).toBe(true)
    expect(await pendingWakeCount()).toBe(1)
    expect(await cancelScheduledWake('a')).toBe(false)
  })
})

describe('sweepWakeQueue', () => {
  it('promotes only entries whose score has passed', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000)

    await suspendUntil('past-1', 1_000)
    await suspendUntil('past-2', 4_500)
    await suspendUntil('future', 10_000)

    const result = await sweepWakeQueue()
    expect(result.promoted.sort()).toEqual(['past-1', 'past-2'])
    expect(result.orphaned).toEqual([])
    expect(zsets.get(WAKE_QUEUE_KEY)).toEqual([
      { score: 10_000, member: 'future' },
    ])
  })

  it('invokes the default promoter — moveToBackoff with backoffMs=0', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000)
    await suspendUntil('s1', 1_000)
    await sweepWakeQueue()
    expect(moveToBackoff).toHaveBeenCalledWith('s1', 'wake-from-suspend', 0)
  })

  it('records orphans when the promoter rejects', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000)
    await suspendUntil('orphan', 1_000)
    const result = await sweepWakeQueue(async () => false)
    expect(result.orphaned).toEqual(['orphan'])
    expect(result.promoted).toEqual([])
  })

  it('uses defaultWakePromoter via moveToBackoff path', async () => {
    await defaultWakePromoter('s2')
    expect(moveToBackoff).toHaveBeenCalledWith('s2', 'wake-from-suspend', 0)
  })
})

describe('startSuspendSweeper', () => {
  it('runs the first tick synchronously and at the configured cadence', async () => {
    vi.useFakeTimers()
    const tick0Time = 5_000
    vi.spyOn(Date, 'now').mockReturnValue(tick0Time)

    await suspendUntil('s1', 1_000)
    const onTick = vi.fn()

    const handle = startSuspendSweeper({
      intervalMs: 1_000,
      onTick,
    })

    // First tick fires synchronously (void tick()) — drain microtasks.
    await vi.advanceTimersByTimeAsync(0)
    expect(onTick).toHaveBeenCalledOnce()
    expect(onTick.mock.calls[0][0]).toMatchObject({ promoted: ['s1'] })

    // Schedule a second wake-up that becomes due after the next tick.
    await suspendUntil('s2', 6_000)
    vi.spyOn(Date, 'now').mockReturnValue(7_000)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(onTick).toHaveBeenCalledTimes(2)
    expect(onTick.mock.calls[1][0]).toMatchObject({ promoted: ['s2'] })

    handle.stop()
    expect(handle.stopped).toBe(true)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(onTick).toHaveBeenCalledTimes(2)
  })
})
