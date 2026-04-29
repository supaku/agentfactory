import { describe, it, expect, vi } from 'vitest'

import {
  SessionEventBus,
  sessionEventBus,
  type SessionLifecycleEvent,
} from './session-event-bus.js'

describe('SessionEventBus', () => {
  it('delivers heartbeats to matching subscribers', async () => {
    const bus = new SessionEventBus()
    const handler = vi.fn()
    bus.subscribe({ kinds: ['session.heartbeat'] }, handler)

    const event: SessionLifecycleEvent = {
      kind: 'session.heartbeat',
      sessionId: 's1',
      workerId: 'w1',
      emittedAt: 1_000,
    }
    await bus.emit(event)

    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith(event)
  })

  it('skips subscribers whose kind filter does not match', async () => {
    const bus = new SessionEventBus()
    const heartbeatHandler = vi.fn()
    const denyHandler = vi.fn()
    bus.subscribe({ kinds: ['session.heartbeat'] }, heartbeatHandler)
    bus.subscribe({ kinds: ['session.permission-denied'] }, denyHandler)

    await bus.emit({
      kind: 'session.heartbeat',
      sessionId: 's1',
      workerId: 'w1',
      emittedAt: 1_000,
    })

    expect(heartbeatHandler).toHaveBeenCalledOnce()
    expect(denyHandler).not.toHaveBeenCalled()
  })

  it('isolates a crashing subscriber so siblings still run', async () => {
    const bus = new SessionEventBus()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = vi.fn(() => {
      throw new Error('boom')
    })
    const sibling = vi.fn()

    bus.subscribe({}, broken)
    bus.subscribe({}, sibling)

    await bus.emit({
      kind: 'session.heartbeat',
      sessionId: 's1',
      workerId: 'w1',
      emittedAt: 1_000,
    })

    expect(broken).toHaveBeenCalledOnce()
    expect(sibling).toHaveBeenCalledOnce()
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('returns a working unsubscribe disposer', async () => {
    const bus = new SessionEventBus()
    const handler = vi.fn()
    const dispose = bus.subscribe({}, handler)
    dispose()

    await bus.emit({
      kind: 'session.heartbeat',
      sessionId: 's1',
      workerId: 'w1',
      emittedAt: 1_000,
    })

    expect(handler).not.toHaveBeenCalled()
    expect(bus.subscriberCount).toBe(0)
  })

  it('exposes a process-global bus instance', () => {
    expect(sessionEventBus).toBeInstanceOf(SessionEventBus)
  })
})
