/**
 * Tests for the per-step journal primitive (REN-1397).
 *
 * Reference: rensei-architecture/ADR-2026-04-29-long-running-runtime-substrate.md
 * (commit 56f2bc6) — Decisions 2 (journal schema), 3 (idempotency hash).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// In-memory Redis substitute for the journal hot-path. Lives at module scope
// so the mock factory and tests share it.
const fakeStore = new Map<string, Record<string, string>>()

function clearStore(): void {
  fakeStore.clear()
}

vi.mock('./redis.js', () => {
  const isRedisConfigured = vi.fn(() => true)
  const getRedisClient = vi.fn(() => ({
    hset: vi.fn(async (key: string, ...args: string[]) => {
      const existing = fakeStore.get(key) ?? {}
      for (let i = 0; i < args.length; i += 2) {
        existing[args[i]] = String(args[i + 1])
      }
      fakeStore.set(key, existing)
      return 1
    }),
    hgetall: vi.fn(async (key: string) => {
      return { ...(fakeStore.get(key) ?? {}) }
    }),
    pipeline: vi.fn(() => ({
      zrem: vi.fn().mockReturnThis(),
      hdel: vi.fn().mockReturnThis(),
      zadd: vi.fn().mockReturnThis(),
      hset: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    })),
  }))
  const redisHGetAll = vi.fn(async (key: string) => {
    return { ...(fakeStore.get(key) ?? {}) }
  })
  const redisKeys = vi.fn(async (pattern: string) => {
    // Translate `journal:{sid}:*` -> filter by prefix.
    const prefix = pattern.replace(/\*$/, '')
    return Array.from(fakeStore.keys()).filter((k) => k.startsWith(prefix))
  })
  return {
    isRedisConfigured,
    getRedisClient,
    redisHGetAll,
    redisKeys,
  }
})

import {
  canonicalJSON,
  computeIdempotencyHash,
  writeJournalEntry,
  readJournalEntry,
  listSessionJournal,
  detectIdempotencyCollision,
  journalEventBus,
  type SessionJournalEvent,
  journalKey,
} from './journal.js'

beforeEach(() => {
  clearStore()
  journalEventBus.clear()
})

// ---------------------------------------------------------------------------
// canonicalJSON — serializer stability
// ---------------------------------------------------------------------------

describe('canonicalJSON', () => {
  it('serializes primitives the same as JSON.stringify', () => {
    expect(canonicalJSON('hello')).toBe('"hello"')
    expect(canonicalJSON(42)).toBe('42')
    expect(canonicalJSON(0)).toBe('0')
    expect(canonicalJSON(-3.14)).toBe('-3.14')
    expect(canonicalJSON(true)).toBe('true')
    expect(canonicalJSON(false)).toBe('false')
    expect(canonicalJSON(null)).toBe('null')
    expect(canonicalJSON(undefined)).toBe('null')
  })

  it('coerces non-finite numbers to null', () => {
    expect(canonicalJSON(NaN)).toBe('null')
    expect(canonicalJSON(Infinity)).toBe('null')
    expect(canonicalJSON(-Infinity)).toBe('null')
  })

  it('produces identical output regardless of object key insertion order', () => {
    const a = { z: 1, a: 2, m: 3 }
    const b = { m: 3, a: 2, z: 1 }
    const c = { a: 2, m: 3, z: 1 }
    expect(canonicalJSON(a)).toBe(canonicalJSON(b))
    expect(canonicalJSON(b)).toBe(canonicalJSON(c))
    expect(canonicalJSON(a)).toBe('{"a":2,"m":3,"z":1}')
  })

  it('recursively sorts nested object keys', () => {
    const a = { outer: { z: 1, a: 2 }, top: 'x' }
    const b = { top: 'x', outer: { a: 2, z: 1 } }
    expect(canonicalJSON(a)).toBe(canonicalJSON(b))
    expect(canonicalJSON(a)).toBe('{"outer":{"a":2,"z":1},"top":"x"}')
  })

  it('preserves array order (semantic ordering)', () => {
    expect(canonicalJSON([3, 1, 2])).toBe('[3,1,2]')
    expect(canonicalJSON([{ b: 2 }, { a: 1 }])).toBe('[{"b":2},{"a":1}]')
    expect(canonicalJSON([3, 1, 2])).not.toBe(canonicalJSON([1, 2, 3]))
  })

  it('omits undefined-valued object fields (matches JSON.stringify)', () => {
    expect(canonicalJSON({ a: 1, b: undefined })).toBe('{"a":1}')
    expect(canonicalJSON({ a: undefined, b: undefined })).toBe('{}')
  })

  it('preserves null-valued object fields', () => {
    expect(canonicalJSON({ a: null, b: 1 })).toBe('{"a":null,"b":1}')
  })

  it('coerces bigint to string for stability', () => {
    expect(canonicalJSON(123n)).toBe('"123"')
  })

  it('handles deeply nested mixed structures stably', () => {
    const a = {
      payload: {
        list: [
          { z: 1, a: 2 },
          { y: undefined, b: null },
        ],
        meta: { ts: 1700000000000, src: 'test' },
      },
      step: 'compute',
    }
    const b = {
      step: 'compute',
      payload: {
        meta: { src: 'test', ts: 1700000000000 },
        list: [
          { a: 2, z: 1 },
          { b: null, y: undefined },
        ],
      },
    }
    expect(canonicalJSON(a)).toBe(canonicalJSON(b))
  })
})

// ---------------------------------------------------------------------------
// computeIdempotencyHash — determinism + collision shape
// ---------------------------------------------------------------------------

describe('computeIdempotencyHash', () => {
  it('returns a 64-char hex sha256', () => {
    const hash = computeIdempotencyHash('step-1', { x: 1 }, 'v1')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic for equivalent inputs (key reordering)', () => {
    const a = computeIdempotencyHash('step-1', { z: 1, a: 2 }, 'v1')
    const b = computeIdempotencyHash('step-1', { a: 2, z: 1 }, 'v1')
    expect(a).toBe(b)
  })

  it('changes when stepId changes', () => {
    const a = computeIdempotencyHash('step-1', { x: 1 }, 'v1')
    const b = computeIdempotencyHash('step-2', { x: 1 }, 'v1')
    expect(a).not.toBe(b)
  })

  it('changes when nodeVersion changes (workflow bump invalidates key)', () => {
    const a = computeIdempotencyHash('step-1', { x: 1 }, 'v1')
    const b = computeIdempotencyHash('step-1', { x: 1 }, 'v2')
    expect(a).not.toBe(b)
  })

  it('changes when input value changes', () => {
    const a = computeIdempotencyHash('step-1', { x: 1 }, 'v1')
    const b = computeIdempotencyHash('step-1', { x: 2 }, 'v1')
    expect(a).not.toBe(b)
  })

  it('treats null and undefined input fields equivalently to JSON.stringify', () => {
    // undefined-valued fields are dropped, null-valued are kept.
    const a = computeIdempotencyHash('s', { x: undefined, y: 1 }, 'v')
    const b = computeIdempotencyHash('s', { y: 1 }, 'v')
    expect(a).toBe(b)

    const c = computeIdempotencyHash('s', { x: null, y: 1 }, 'v')
    expect(c).not.toBe(b)
  })

  it('is stable across repeated calls in the same process', () => {
    const inputs: unknown[] = [
      { a: 1, b: [2, 3], c: { d: 'x' } },
      [1, 2, { z: null }],
      'plain string',
      42,
    ]
    for (const input of inputs) {
      const h1 = computeIdempotencyHash('s', input, 'v')
      const h2 = computeIdempotencyHash('s', input, 'v')
      expect(h1).toBe(h2)
    }
  })
})

// ---------------------------------------------------------------------------
// CRUD APIs
// ---------------------------------------------------------------------------

describe('writeJournalEntry / readJournalEntry', () => {
  it('writes and reads back a running entry', async () => {
    const inputHash = computeIdempotencyHash('step-1', { x: 1 }, 'v1')
    const ok = await writeJournalEntry({
      sessionId: 'sess-1',
      stepId: 'step-1',
      status: 'running',
      inputHash,
      attempt: 0,
      startedAt: 1700000000000,
    })
    expect(ok).toBe(true)

    const read = await readJournalEntry('sess-1', 'step-1')
    expect(read).not.toBeNull()
    expect(read?.status).toBe('running')
    expect(read?.inputHash).toBe(inputHash)
    expect(read?.attempt).toBe(0)
    expect(read?.startedAt).toBe(1700000000000)
    expect(read?.completedAt).toBe(0)
  })

  it('upserts on subsequent writes (running -> completed)', async () => {
    const inputHash = computeIdempotencyHash('step-1', { x: 1 }, 'v1')

    await writeJournalEntry({
      sessionId: 'sess-2',
      stepId: 'step-1',
      status: 'running',
      inputHash,
      startedAt: 100,
    })

    await writeJournalEntry({
      sessionId: 'sess-2',
      stepId: 'step-1',
      status: 'completed',
      inputHash,
      startedAt: 100,
      completedAt: 250,
      outputCAS: 'cas://abc',
    })

    const read = await readJournalEntry('sess-2', 'step-1')
    expect(read?.status).toBe('completed')
    expect(read?.outputCAS).toBe('cas://abc')
    expect(read?.completedAt).toBe(250)
  })

  it('persists error string on failed entries', async () => {
    await writeJournalEntry({
      sessionId: 'sess-3',
      stepId: 'step-1',
      status: 'failed',
      inputHash: 'h',
      attempt: 2,
      startedAt: 10,
      completedAt: 20,
      error: 'timeout',
    })
    const read = await readJournalEntry('sess-3', 'step-1')
    expect(read?.status).toBe('failed')
    expect(read?.error).toBe('timeout')
    expect(read?.attempt).toBe(2)
  })

  it('returns null when the entry is missing', async () => {
    const read = await readJournalEntry('missing', 'step-x')
    expect(read).toBeNull()
  })

  it('uses the documented Redis key shape', () => {
    expect(journalKey('s1', 'step-a')).toBe('journal:s1:step-a')
  })
})

describe('listSessionJournal', () => {
  it('returns all entries for a session sorted by startedAt', async () => {
    const h = (s: string) => computeIdempotencyHash(s, {}, 'v')
    await writeJournalEntry({
      sessionId: 'multi',
      stepId: 'b',
      status: 'completed',
      inputHash: h('b'),
      startedAt: 200,
      completedAt: 250,
    })
    await writeJournalEntry({
      sessionId: 'multi',
      stepId: 'a',
      status: 'completed',
      inputHash: h('a'),
      startedAt: 100,
      completedAt: 150,
    })
    await writeJournalEntry({
      sessionId: 'multi',
      stepId: 'c',
      status: 'running',
      inputHash: h('c'),
      startedAt: 300,
    })

    // A different session's entry should NOT appear.
    await writeJournalEntry({
      sessionId: 'other',
      stepId: 'z',
      status: 'running',
      inputHash: h('z'),
      startedAt: 999,
    })

    const list = await listSessionJournal('multi')
    expect(list.map((e) => e.stepId)).toEqual(['a', 'b', 'c'])
    expect(list.every((e) => e.sessionId === 'multi')).toBe(true)
  })

  it('returns [] when the session has no entries', async () => {
    const list = await listSessionJournal('empty')
    expect(list).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Idempotency-collision detection
// ---------------------------------------------------------------------------

describe('detectIdempotencyCollision', () => {
  it('returns false when no prior entry exists', async () => {
    const collided = await detectIdempotencyCollision('s', 'step-x', 'h1')
    expect(collided).toBe(false)
  })

  it('returns false when prior entry has the same hash', async () => {
    await writeJournalEntry({
      sessionId: 's',
      stepId: 'step-x',
      status: 'running',
      inputHash: 'h1',
    })
    const collided = await detectIdempotencyCollision('s', 'step-x', 'h1')
    expect(collided).toBe(false)
  })

  it('returns true and warns when prior entry has a different hash', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await writeJournalEntry({
      sessionId: 's',
      stepId: 'step-x',
      status: 'running',
      inputHash: 'h-old',
    })
    const collided = await detectIdempotencyCollision('s', 'step-x', 'h-new')
    expect(collided).toBe(true)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// Hook event emission (Layer 6 surface)
// ---------------------------------------------------------------------------

describe('journalEventBus', () => {
  it('emits session.step-started on a running write', async () => {
    const events: SessionJournalEvent[] = []
    journalEventBus.subscribe({}, (e) => {
      events.push(e)
    })

    await writeJournalEntry({
      sessionId: 's-start',
      stepId: 'step-1',
      status: 'running',
      inputHash: 'h',
      startedAt: 10,
      attempt: 0,
    })

    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('session.step-started')
    if (events[0].kind === 'session.step-started') {
      expect(events[0].sessionId).toBe('s-start')
      expect(events[0].stepId).toBe('step-1')
      expect(events[0].inputHash).toBe('h')
      expect(events[0].startedAt).toBe(10)
    }
  })

  it('emits session.step-completed on a completed write', async () => {
    const events: SessionJournalEvent[] = []
    journalEventBus.subscribe({ kinds: ['session.step-completed'] }, (e) => {
      events.push(e)
    })

    await writeJournalEntry({
      sessionId: 's-done',
      stepId: 'step-1',
      status: 'completed',
      inputHash: 'h',
      startedAt: 10,
      completedAt: 20,
      outputCAS: 'cas://x',
    })

    expect(events).toHaveLength(1)
    if (events[0].kind === 'session.step-completed') {
      expect(events[0].outputCAS).toBe('cas://x')
      expect(events[0].completedAt).toBe(20)
    }
  })

  it('emits session.step-failed on a failed write with error string', async () => {
    const events: SessionJournalEvent[] = []
    journalEventBus.subscribe({ kinds: ['session.step-failed'] }, (e) => {
      events.push(e)
    })

    await writeJournalEntry({
      sessionId: 's-err',
      stepId: 'step-1',
      status: 'failed',
      inputHash: 'h',
      startedAt: 10,
      completedAt: 30,
      error: 'boom',
    })

    expect(events).toHaveLength(1)
    if (events[0].kind === 'session.step-failed') {
      expect(events[0].error).toBe('boom')
    }
  })

  it('does not emit on pending writes', async () => {
    const events: SessionJournalEvent[] = []
    journalEventBus.subscribe({}, (e) => {
      events.push(e)
    })

    await writeJournalEntry({
      sessionId: 's-pending',
      stepId: 'step-1',
      status: 'pending',
      inputHash: 'h',
    })

    expect(events).toHaveLength(0)
  })

  it('isolates subscriber crashes — failures do not propagate', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    journalEventBus.subscribe({}, () => {
      throw new Error('subscriber boom')
    })

    const ok = await writeJournalEntry({
      sessionId: 's-iso',
      stepId: 'step-1',
      status: 'running',
      inputHash: 'h',
    })

    // Journal write must succeed even when a subscriber throws.
    expect(ok).toBe(true)
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('isolates async subscriber rejections', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    journalEventBus.subscribe({}, async () => {
      throw new Error('async boom')
    })

    const ok = await writeJournalEntry({
      sessionId: 's-async',
      stepId: 'step-1',
      status: 'completed',
      inputHash: 'h',
      startedAt: 1,
      completedAt: 2,
      outputCAS: 'x',
    })

    // Allow the microtask for the async rejection to run.
    await new Promise((r) => setTimeout(r, 0))
    expect(ok).toBe(true)
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('honours unsubscribe', async () => {
    const events: SessionJournalEvent[] = []
    const unsub = journalEventBus.subscribe({}, (e) => {
      events.push(e)
    })
    unsub()
    expect(journalEventBus.subscriberCount).toBe(0)

    await writeJournalEntry({
      sessionId: 's-unsub',
      stepId: 'step-1',
      status: 'running',
      inputHash: 'h',
    })

    expect(events).toHaveLength(0)
  })
})
