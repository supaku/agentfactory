/**
 * Tests for the Layer 6 hook bus.
 *
 * Coverage:
 * - subscribe / emit / unsubscribe
 * - Filtering by kind, providerId, family
 * - Event ordering (insertion order)
 * - Subscriber crash isolation (one crash never breaks siblings)
 * - emitSync
 * - subscriberCount / clear
 * - createProviderHost
 */

import { describe, it, expect, vi } from 'vitest'
import { HookBus, createProviderHost, globalHookBus } from './hooks.js'
import type { ProviderHookEvent, ProviderRef } from '../providers/base.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRef(id = 'test-provider', family: ProviderRef['family'] = 'sandbox'): ProviderRef {
  return { id, family, version: '1.0.0' }
}

function preActivate(id = 'p1', family: ProviderRef['family'] = 'sandbox'): ProviderHookEvent {
  return { kind: 'pre-activate', provider: makeRef(id, family) }
}

function postActivate(id = 'p1', durationMs = 42): ProviderHookEvent {
  return { kind: 'post-activate', provider: makeRef(id), durationMs }
}

function preVerb(verb = 'provision'): ProviderHookEvent {
  return { kind: 'pre-verb', provider: makeRef(), verb, args: { region: 'us-east-1' } }
}

function verbError(verb = 'provision'): ProviderHookEvent {
  return { kind: 'verb-error', provider: makeRef(), verb, error: new Error('test error') }
}

// ---------------------------------------------------------------------------
// 1. Basic subscribe / emit
// ---------------------------------------------------------------------------

describe('HookBus subscribe / emit', () => {
  it('delivers an event to a subscriber with no filter', async () => {
    const bus = new HookBus()
    const received: ProviderHookEvent[] = []
    bus.subscribe({}, (event) => { received.push(event) })

    const ev = preActivate()
    await bus.emit(ev)
    expect(received).toHaveLength(1)
    expect(received[0]).toBe(ev)
  })

  it('delivers an event to multiple subscribers', async () => {
    const bus = new HookBus()
    const a: ProviderHookEvent[] = []
    const b: ProviderHookEvent[] = []
    bus.subscribe({}, (e) => { a.push(e) })
    bus.subscribe({}, (e) => { b.push(e) })

    await bus.emit(preActivate())
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
  })

  it('unsubscribe stops delivery', async () => {
    const bus = new HookBus()
    const received: ProviderHookEvent[] = []
    const unsubscribe = bus.subscribe({}, (e) => { received.push(e) })

    await bus.emit(preActivate())
    unsubscribe()
    await bus.emit(preActivate())

    expect(received).toHaveLength(1)
  })

  it('subscriberCount reflects registered subscribers', () => {
    const bus = new HookBus()
    expect(bus.subscriberCount).toBe(0)
    const u1 = bus.subscribe({}, () => {})
    const u2 = bus.subscribe({}, () => {})
    expect(bus.subscriberCount).toBe(2)
    u1()
    expect(bus.subscriberCount).toBe(1)
    u2()
    expect(bus.subscriberCount).toBe(0)
  })

  it('clear() removes all subscribers', async () => {
    const bus = new HookBus()
    const received: ProviderHookEvent[] = []
    bus.subscribe({}, (e) => { received.push(e) })
    bus.subscribe({}, (e) => { received.push(e) })
    bus.clear()
    await bus.emit(preActivate())
    expect(received).toHaveLength(0)
    expect(bus.subscriberCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 2. Event ordering
// ---------------------------------------------------------------------------

describe('HookBus event ordering', () => {
  it('delivers events in insertion order', async () => {
    const bus = new HookBus()
    const order: number[] = []
    bus.subscribe({}, () => { order.push(1) })
    bus.subscribe({}, () => { order.push(2) })
    bus.subscribe({}, () => { order.push(3) })

    await bus.emit(preActivate())
    expect(order).toEqual([1, 2, 3])
  })

  it('awaits async subscribers in order', async () => {
    const bus = new HookBus()
    const order: number[] = []

    bus.subscribe({}, async () => {
      await new Promise<void>((r) => setTimeout(r, 5))
      order.push(1)
    })
    bus.subscribe({}, async () => {
      order.push(2)
    })

    await bus.emit(preActivate())
    expect(order).toEqual([1, 2])
  })
})

// ---------------------------------------------------------------------------
// 3. Filtering
// ---------------------------------------------------------------------------

describe('HookBus filtering', () => {
  it('kind filter — only delivers matching kinds', async () => {
    const bus = new HookBus()
    const received: ProviderHookEvent[] = []
    bus.subscribe({ kinds: ['pre-activate'] }, (e) => { received.push(e) })

    await bus.emit(preActivate())
    await bus.emit(postActivate())
    await bus.emit(preVerb())

    expect(received).toHaveLength(1)
    expect(received[0].kind).toBe('pre-activate')
  })

  it('kind filter — multiple kinds', async () => {
    const bus = new HookBus()
    const received: ProviderHookEvent[] = []
    bus.subscribe({ kinds: ['pre-activate', 'post-activate'] }, (e) => { received.push(e) })

    await bus.emit(preActivate())
    await bus.emit(postActivate())
    await bus.emit(preVerb())

    expect(received).toHaveLength(2)
  })

  it('providerId filter — only delivers for matching provider', async () => {
    const bus = new HookBus()
    const received: ProviderHookEvent[] = []
    bus.subscribe({ providerId: 'provider-a' }, (e) => { received.push(e) })

    await bus.emit({ kind: 'pre-activate', provider: makeRef('provider-a') })
    await bus.emit({ kind: 'pre-activate', provider: makeRef('provider-b') })

    expect(received).toHaveLength(1)
    expect((received[0] as { provider: ProviderRef }).provider.id).toBe('provider-a')
  })

  it('providerId filter — array of ids', async () => {
    const bus = new HookBus()
    const received: ProviderHookEvent[] = []
    bus.subscribe({ providerId: ['a', 'c'] }, (e) => { received.push(e) })

    await bus.emit({ kind: 'pre-activate', provider: makeRef('a') })
    await bus.emit({ kind: 'pre-activate', provider: makeRef('b') })
    await bus.emit({ kind: 'pre-activate', provider: makeRef('c') })

    expect(received).toHaveLength(2)
  })

  it('family filter — only delivers for matching family', async () => {
    const bus = new HookBus()
    const received: ProviderHookEvent[] = []
    bus.subscribe({ family: 'sandbox' }, (e) => { received.push(e) })

    await bus.emit(preActivate('p1', 'sandbox'))
    await bus.emit(preActivate('p2', 'vcs'))

    expect(received).toHaveLength(1)
    expect((received[0] as { provider: ProviderRef }).provider.family).toBe('sandbox')
  })

  it('family filter — array of families', async () => {
    const bus = new HookBus()
    const received: ProviderHookEvent[] = []
    bus.subscribe({ family: ['sandbox', 'kit'] }, (e) => { received.push(e) })

    await bus.emit(preActivate('p1', 'sandbox'))
    await bus.emit(preActivate('p2', 'vcs'))
    await bus.emit(preActivate('p3', 'kit'))

    expect(received).toHaveLength(2)
  })

  it('combined kind + providerId filter', async () => {
    const bus = new HookBus()
    const received: ProviderHookEvent[] = []
    bus.subscribe({ kinds: ['post-activate'], providerId: 'target' }, (e) => { received.push(e) })

    await bus.emit({ kind: 'pre-activate', provider: makeRef('target') })
    await bus.emit({ kind: 'post-activate', provider: makeRef('target'), durationMs: 10 })
    await bus.emit({ kind: 'post-activate', provider: makeRef('other'), durationMs: 10 })

    expect(received).toHaveLength(1)
  })

  it('scope-resolved events pass family filter (no single provider ref)', async () => {
    const bus = new HookBus()
    const received: ProviderHookEvent[] = []
    bus.subscribe({ family: 'sandbox' }, (e) => { received.push(e) })

    const scopeEv: ProviderHookEvent = {
      kind: 'scope-resolved',
      chosen: [makeRef('p1')],
      rejected: [],
    }
    await bus.emit(scopeEv)
    // scope-resolved has no single provider ref — family filter passes through
    expect(received).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 4. Subscriber crash isolation
// ---------------------------------------------------------------------------

describe('HookBus subscriber crash isolation', () => {
  it('a throwing subscriber does not prevent sibling subscribers from running', async () => {
    const bus = new HookBus()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const receivedByB: ProviderHookEvent[] = []

    // Subscriber A throws
    bus.subscribe({}, () => {
      throw new Error('Subscriber A crashed')
    })
    // Subscriber B should still receive the event
    bus.subscribe({}, (e) => { receivedByB.push(e) })

    await bus.emit(preActivate())

    expect(receivedByB).toHaveLength(1)
    errorSpy.mockRestore()
  })

  it('an async-throwing subscriber does not prevent subsequent subscribers', async () => {
    const bus = new HookBus()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const receivedByC: ProviderHookEvent[] = []

    bus.subscribe({}, async () => { throw new Error('async crash') })
    bus.subscribe({}, () => { receivedByC.push({} as ProviderHookEvent) })

    await bus.emit(preActivate())

    expect(receivedByC).toHaveLength(1)
    errorSpy.mockRestore()
  })

  it('crash isolation logs the error to console.error', async () => {
    const bus = new HookBus()
    const errors: string[] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((msg: string) => {
      errors.push(String(msg))
    })

    bus.subscribe({}, () => { throw new Error('intentional crash') })
    await bus.emit(preActivate())

    expect(errors.some((m) => m.includes('intentional crash') || m.includes('HookBus'))).toBe(true)
    errorSpy.mockRestore()
  })

  it('multiple crashing subscribers do not affect non-crashing ones', async () => {
    const bus = new HookBus()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const good: ProviderHookEvent[] = []

    bus.subscribe({}, () => { throw new Error('crash 1') })
    bus.subscribe({}, (e) => { good.push(e) })
    bus.subscribe({}, () => { throw new Error('crash 2') })
    bus.subscribe({}, (e) => { good.push(e) })

    await bus.emit(preActivate())

    expect(good).toHaveLength(2)
    errorSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 5. emitSync
// ---------------------------------------------------------------------------

describe('HookBus emitSync', () => {
  it('delivers events synchronously', () => {
    const bus = new HookBus()
    const received: ProviderHookEvent[] = []
    bus.subscribe({}, (e) => { received.push(e) })
    bus.emitSync(preActivate())
    expect(received).toHaveLength(1)
  })

  it('crash isolation works in emitSync', () => {
    const bus = new HookBus()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const good: ProviderHookEvent[] = []

    bus.subscribe({}, () => { throw new Error('sync crash') })
    bus.subscribe({}, (e) => { good.push(e) })

    bus.emitSync(preActivate())
    expect(good).toHaveLength(1)
    errorSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 6. createProviderHost
// ---------------------------------------------------------------------------

describe('createProviderHost', () => {
  it('returns a ProviderHost that emits events to the given bus', async () => {
    const bus = new HookBus()
    const received: ProviderHookEvent[] = []
    bus.subscribe({}, (e) => { received.push(e) })

    const host = createProviderHost(bus)
    const ev = preActivate()
    host.emit(ev)

    // emit is fire-and-forget — give microtasks a tick to settle
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(received).toHaveLength(1)
    expect(received[0]).toBe(ev)
  })

  it('defaults to globalHookBus when no bus is passed', () => {
    const host = createProviderHost()
    // Just verifies it returns a ProviderHost with an emit method
    expect(typeof host.emit).toBe('function')
  })

  it('globalHookBus is a HookBus instance', () => {
    expect(globalHookBus).toBeInstanceOf(HookBus)
  })
})

// ---------------------------------------------------------------------------
// 7. All nine event kinds fire correctly
// ---------------------------------------------------------------------------

describe('HookBus all event kinds', () => {
  const allEvents: ProviderHookEvent[] = [
    { kind: 'pre-activate', provider: makeRef() },
    { kind: 'post-activate', provider: makeRef(), durationMs: 50 },
    { kind: 'pre-deactivate', provider: makeRef(), reason: 'shutdown' },
    { kind: 'post-deactivate', provider: makeRef() },
    { kind: 'pre-verb', provider: makeRef(), verb: 'provision', args: {} },
    { kind: 'post-verb', provider: makeRef(), verb: 'provision', result: {}, durationMs: 100 },
    { kind: 'verb-error', provider: makeRef(), verb: 'provision', error: new Error('fail') },
    { kind: 'capability-mismatch', provider: makeRef(), declared: { foo: true }, observed: { foo: false } },
    { kind: 'scope-resolved', chosen: [makeRef()], rejected: [{ provider: makeRef('other'), reason: 'shadowed' }] },
  ]

  it('emits and receives all 9 event kinds', async () => {
    const bus = new HookBus()
    const received: string[] = []
    bus.subscribe({}, (e) => { received.push(e.kind) })

    for (const ev of allEvents) {
      await bus.emit(ev)
    }

    expect(received).toHaveLength(9)
    expect(received).toContain('pre-activate')
    expect(received).toContain('post-activate')
    expect(received).toContain('pre-deactivate')
    expect(received).toContain('post-deactivate')
    expect(received).toContain('pre-verb')
    expect(received).toContain('post-verb')
    expect(received).toContain('verb-error')
    expect(received).toContain('capability-mismatch')
    expect(received).toContain('scope-resolved')
  })
})
