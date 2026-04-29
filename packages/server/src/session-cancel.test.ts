/**
 * Tests for the cooperative session-cancel coordinator (REN-1398).
 *
 * Mocks Redis so the test runs deterministically; the cancel record is
 * kept in an in-memory map keyed by Redis key.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const store = new Map<string, unknown>()

vi.mock('./redis.js', () => ({
  isRedisConfigured: vi.fn(() => true),
  redisSet: vi.fn(async (key: string, value: unknown) => {
    store.set(key, value)
  }),
  redisGet: vi.fn(async (key: string) => store.get(key) ?? null),
  redisDel: vi.fn(async (key: string) => {
    const had = store.has(key)
    store.delete(key)
    return had ? 1 : 0
  }),
}))

import {
  cancelKey,
  clearCancel,
  confirmSessionCancelled,
  isCancelRequested,
  readCancelRecord,
  requestSessionCancel,
} from './session-cancel.js'
import { SessionEventBus, type SessionLifecycleEvent } from './session-event-bus.js'

beforeEach(() => {
  store.clear()
  vi.clearAllMocks()
})

describe('cancelKey', () => {
  it('formats key with the documented shape', () => {
    expect(cancelKey('sess-123')).toBe('session:cancel:sess-123')
  })
})

describe('requestSessionCancel', () => {
  it('records the cancel signal and emits session.cancel-requested', async () => {
    const bus = new SessionEventBus()
    const events: SessionLifecycleEvent[] = []
    bus.subscribe({ kinds: ['session.cancel-requested'] }, (e) => {
      events.push(e)
    })

    const ok = await requestSessionCancel('s1', {
      bus,
      requestedBy: 'user@example.com',
      reason: 'pivot to higher-priority work',
    })

    expect(ok).toBe(true)
    expect(events).toHaveLength(1)
    const evt = events[0]!
    if (evt.kind !== 'session.cancel-requested') throw new Error('typed-narrow')
    expect(evt.sessionId).toBe('s1')
    expect(evt.requestedBy).toBe('user@example.com')
    expect(evt.reason).toBe('pivot to higher-priority work')
  })

  it('is idempotent — second call returns false and does not double-emit', async () => {
    const bus = new SessionEventBus()
    const events: SessionLifecycleEvent[] = []
    bus.subscribe({ kinds: ['session.cancel-requested'] }, (e) => {
      events.push(e)
    })

    const a = await requestSessionCancel('s2', { bus })
    const b = await requestSessionCancel('s2', { bus })

    expect(a).toBe(true)
    expect(b).toBe(false)
    expect(events).toHaveLength(1)
  })

  it('persists interrupt preference on the cancel record', async () => {
    await requestSessionCancel('s3', { interrupt: 'unsafe' })
    const record = await readCancelRecord('s3')
    expect(record?.interrupt).toBe('unsafe')
  })
})

describe('isCancelRequested', () => {
  it('returns true once a cancel has been recorded', async () => {
    expect(await isCancelRequested('s4')).toBe(false)
    await requestSessionCancel('s4', {})
    expect(await isCancelRequested('s4')).toBe(true)
  })
})

describe('confirmSessionCancelled', () => {
  it('emits session.cancelled and clears the record by default', async () => {
    const bus = new SessionEventBus()
    const events: SessionLifecycleEvent[] = []
    bus.subscribe({ kinds: ['session.cancelled'] }, (e) => {
      events.push(e)
    })

    await requestSessionCancel('s5', {})
    await confirmSessionCancelled('s5', {
      workerId: 'w1',
      lastCompletedStepId: 'step-3',
      mode: 'cooperative',
      bus,
    })

    expect(events).toHaveLength(1)
    const evt = events[0]!
    if (evt.kind !== 'session.cancelled') throw new Error('typed-narrow')
    expect(evt.sessionId).toBe('s5')
    expect(evt.workerId).toBe('w1')
    expect(evt.lastCompletedStepId).toBe('step-3')
    expect(evt.mode).toBe('cooperative')

    expect(await readCancelRecord('s5')).toBeNull()
  })

  it('retains the record when retainRecord is true', async () => {
    const bus = new SessionEventBus()
    await requestSessionCancel('s6', {})
    await confirmSessionCancelled('s6', {
      workerId: 'w2',
      retainRecord: true,
      bus,
    })
    expect(await readCancelRecord('s6')).not.toBeNull()
  })

  it('isolates subscriber crashes', async () => {
    const bus = new SessionEventBus()
    bus.subscribe({ kinds: ['session.cancelled'] }, () => {
      throw new Error('subscriber crash')
    })
    let callCount = 0
    bus.subscribe({ kinds: ['session.cancelled'] }, () => {
      callCount++
    })

    // Should NOT throw
    await expect(
      confirmSessionCancelled('s7', { workerId: 'w3', bus }),
    ).resolves.toBeUndefined()
    expect(callCount).toBe(1)
  })
})

describe('clearCancel', () => {
  it('removes the record and returns true when one existed', async () => {
    await requestSessionCancel('s8', {})
    expect(await clearCancel('s8')).toBe(true)
    expect(await clearCancel('s8')).toBe(false)
  })
})
