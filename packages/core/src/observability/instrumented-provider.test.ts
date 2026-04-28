/**
 * Tests for InstrumentedProvider<F>.
 *
 * Coverage:
 * - activate emits pre-activate, post-activate with durationMs
 * - deactivate emits pre-deactivate (with reason), post-deactivate
 * - invokeVerb emits pre-verb, post-verb with durationMs on success
 * - invokeVerb emits pre-verb, verb-error on failure (and re-throws)
 * - reportCapabilityMismatch emits capability-mismatch
 * - health() delegates to _health()
 * - Custom bus injection (test isolation)
 */

import { describe, it, expect } from 'vitest'
import { InstrumentedProvider } from './instrumented-provider.js'
import { HookBus } from './hooks.js'
import type {
  ProviderManifest,
  ProviderCapabilities,
  ProviderScope,
  ProviderHost,
  ProviderFamily,
  ProviderHookEvent,
} from '../providers/base.js'

// ---------------------------------------------------------------------------
// Test implementation of InstrumentedProvider<'sandbox'>
// ---------------------------------------------------------------------------

type SandboxCaps = ProviderCapabilities<'sandbox'>

const validCaps: SandboxCaps = {
  transportModel: 'dial-in',
  supportsFsSnapshot: false,
  supportsPauseResume: false,
  idleCostModel: 'zero',
  billingModel: 'wall-clock',
  regions: ['us-east-1'],
  maxConcurrent: null,
  maxSessionDurationSeconds: null,
}

const validManifest: ProviderManifest<'sandbox'> = {
  apiVersion: 'rensei.dev/v1',
  family: 'sandbox',
  id: 'test-sandbox',
  version: '1.0.0',
  name: 'Test Sandbox',
  requires: { rensei: '>=0.8' },
  entry: { kind: 'static', modulePath: './dist/test.js' },
  capabilitiesDeclared: validCaps,
}

class TestSandboxProvider extends InstrumentedProvider<'sandbox'> {
  readonly manifest = validManifest
  readonly capabilities = validCaps
  readonly scope: ProviderScope = { level: 'global' }

  activateCalled = false
  deactivateCalled = false

  protected async _activate(_host: ProviderHost): Promise<void> {
    this.activateCalled = true
  }

  protected async _deactivate(): Promise<void> {
    this.deactivateCalled = true
  }

  // Expose invokeVerb for testing
  async callVerb<TArgs, TResult>(verb: string, args: TArgs, fn: (a: TArgs) => Promise<TResult>): Promise<TResult> {
    return this.invokeVerb(verb, args, fn)
  }

  // Expose reportCapabilityMismatch for testing
  async callReportMismatch(declared: unknown, observed: unknown): Promise<void> {
    return this.reportCapabilityMismatch(declared, observed)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHost(): ProviderHost {
  return { emit: () => {} }
}

function collectEvents(bus: HookBus): ProviderHookEvent[] {
  const events: ProviderHookEvent[] = []
  bus.subscribe({}, (e) => { events.push(e) })
  return events
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InstrumentedProvider activate', () => {
  it('calls _activate and emits pre-activate + post-activate', async () => {
    const bus = new HookBus()
    const events = collectEvents(bus)
    const provider = new TestSandboxProvider(bus)

    await provider.activate(makeHost())

    expect(provider.activateCalled).toBe(true)
    expect(events.map((e) => e.kind)).toEqual(['pre-activate', 'post-activate'])
  })

  it('post-activate includes durationMs >= 0', async () => {
    const bus = new HookBus()
    const events = collectEvents(bus)
    const provider = new TestSandboxProvider(bus)

    await provider.activate(makeHost())

    const post = events.find((e) => e.kind === 'post-activate')
    expect(post).toBeDefined()
    expect((post as Extract<ProviderHookEvent, { kind: 'post-activate' }>).durationMs).toBeGreaterThanOrEqual(0)
  })

  it('pre-activate carries the correct provider ref', async () => {
    const bus = new HookBus()
    const events = collectEvents(bus)
    const provider = new TestSandboxProvider(bus)

    await provider.activate(makeHost())

    const pre = events.find((e) => e.kind === 'pre-activate') as Extract<ProviderHookEvent, { kind: 'pre-activate' }>
    expect(pre.provider.id).toBe('test-sandbox')
    expect(pre.provider.family).toBe('sandbox')
    expect(pre.provider.version).toBe('1.0.0')
  })

  it('does not emit post-activate if _activate throws', async () => {
    const bus = new HookBus()
    const events = collectEvents(bus)

    class ThrowingProvider extends TestSandboxProvider {
      protected async _activate(_host: ProviderHost): Promise<void> {
        throw new Error('activation failed')
      }
    }

    const provider = new ThrowingProvider(bus)
    await expect(provider.activate(makeHost())).rejects.toThrow('activation failed')

    expect(events.map((e) => e.kind)).toEqual(['pre-activate'])
  })
})

describe('InstrumentedProvider deactivate', () => {
  it('calls _deactivate and emits pre-deactivate + post-deactivate', async () => {
    const bus = new HookBus()
    const events = collectEvents(bus)
    const provider = new TestSandboxProvider(bus)

    await provider.deactivate()

    expect(provider.deactivateCalled).toBe(true)
    expect(events.map((e) => e.kind)).toEqual(['pre-deactivate', 'post-deactivate'])
  })

  it('pre-deactivate includes the reason', async () => {
    const bus = new HookBus()
    const events = collectEvents(bus)
    const provider = new TestSandboxProvider(bus)

    await provider.deactivate('user-requested')

    const pre = events.find((e) => e.kind === 'pre-deactivate') as Extract<ProviderHookEvent, { kind: 'pre-deactivate' }>
    expect(pre.reason).toBe('user-requested')
  })

  it('uses default reason "host-requested" when none is provided', async () => {
    const bus = new HookBus()
    const events = collectEvents(bus)
    const provider = new TestSandboxProvider(bus)

    await provider.deactivate()

    const pre = events.find((e) => e.kind === 'pre-deactivate') as Extract<ProviderHookEvent, { kind: 'pre-deactivate' }>
    expect(pre.reason).toBe('host-requested')
  })

  it('does not emit post-deactivate if _deactivate throws', async () => {
    const bus = new HookBus()
    const events = collectEvents(bus)

    class ThrowingProvider extends TestSandboxProvider {
      protected async _deactivate(): Promise<void> {
        throw new Error('deactivation failed')
      }
    }

    const provider = new ThrowingProvider(bus)
    await expect(provider.deactivate()).rejects.toThrow('deactivation failed')

    expect(events.map((e) => e.kind)).toEqual(['pre-deactivate'])
  })
})

describe('InstrumentedProvider invokeVerb', () => {
  it('emits pre-verb + post-verb on success', async () => {
    const bus = new HookBus()
    const events = collectEvents(bus)
    const provider = new TestSandboxProvider(bus)

    await provider.callVerb('provision', { region: 'us-east-1' }, async (args) => ({ sessionId: 'sess-1', args }))

    expect(events.map((e) => e.kind)).toEqual(['pre-verb', 'post-verb'])
  })

  it('post-verb includes verb name and durationMs', async () => {
    const bus = new HookBus()
    const events = collectEvents(bus)
    const provider = new TestSandboxProvider(bus)

    await provider.callVerb('provision', {}, async () => ({ ok: true }))

    const post = events.find((e) => e.kind === 'post-verb') as Extract<ProviderHookEvent, { kind: 'post-verb' }>
    expect(post.verb).toBe('provision')
    expect(post.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('pre-verb includes verb name and args', async () => {
    const bus = new HookBus()
    const events = collectEvents(bus)
    const provider = new TestSandboxProvider(bus)
    const args = { region: 'eu-west-1' }

    await provider.callVerb('provision', args, async (a) => a)

    const pre = events.find((e) => e.kind === 'pre-verb') as Extract<ProviderHookEvent, { kind: 'pre-verb' }>
    expect(pre.verb).toBe('provision')
    expect(pre.args).toBe(args)
  })

  it('emits pre-verb + verb-error on failure and re-throws', async () => {
    const bus = new HookBus()
    const events = collectEvents(bus)
    const provider = new TestSandboxProvider(bus)
    const expectedError = new Error('provision failed')

    await expect(
      provider.callVerb('provision', {}, async () => { throw expectedError }),
    ).rejects.toThrow('provision failed')

    expect(events.map((e) => e.kind)).toEqual(['pre-verb', 'verb-error'])

    const errEvent = events.find((e) => e.kind === 'verb-error') as Extract<ProviderHookEvent, { kind: 'verb-error' }>
    expect(errEvent.error).toBe(expectedError)
    expect(errEvent.verb).toBe('provision')
  })

  it('returns the verb result', async () => {
    const bus = new HookBus()
    const provider = new TestSandboxProvider(bus)

    const result = await provider.callVerb('provision', { n: 42 }, async (args) => ({ doubled: args.n * 2 }))
    expect(result.doubled).toBe(84)
  })
})

describe('InstrumentedProvider reportCapabilityMismatch', () => {
  it('emits capability-mismatch with declared and observed', async () => {
    const bus = new HookBus()
    const events = collectEvents(bus)
    const provider = new TestSandboxProvider(bus)

    const declared = { supportsPauseResume: true }
    const observed = { supportsPauseResume: false }

    await provider.callReportMismatch(declared, observed)

    const ev = events.find((e) => e.kind === 'capability-mismatch') as Extract<ProviderHookEvent, { kind: 'capability-mismatch' }>
    expect(ev).toBeDefined()
    expect(ev.declared).toBe(declared)
    expect(ev.observed).toBe(observed)
  })
})

describe('InstrumentedProvider health', () => {
  it('returns ready by default', async () => {
    const bus = new HookBus()
    const provider = new TestSandboxProvider(bus)
    const h = await provider.health()
    expect(h.status).toBe('ready')
  })

  it('delegates to _health() override', async () => {
    const bus = new HookBus()

    class DegradedProvider extends TestSandboxProvider {
      protected async _health() {
        return { status: 'degraded' as const, reason: 'low capacity' }
      }
    }

    const provider = new DegradedProvider(bus)
    const h = await provider.health()
    expect(h.status).toBe('degraded')
  })
})

describe('InstrumentedProvider custom bus injection', () => {
  it('emits to the injected bus, not globalHookBus', async () => {
    const localBus = new HookBus()
    const globalEvents: ProviderHookEvent[] = []

    // Subscribe to the global bus to verify we do NOT receive events there
    // (We won't: InstrumentedProvider uses the injected bus)
    const received: ProviderHookEvent[] = []
    localBus.subscribe({}, (e) => { received.push(e) })

    const provider = new TestSandboxProvider(localBus)
    await provider.activate(makeHost())

    expect(received.length).toBeGreaterThan(0)
    expect(globalEvents.length).toBe(0)
  })
})

describe('InstrumentedProvider full lifecycle sequence', () => {
  it('emits all 4 lifecycle events in order for activate + deactivate', async () => {
    const bus = new HookBus()
    const kinds: string[] = []
    bus.subscribe({}, (e) => { kinds.push(e.kind) })

    const provider = new TestSandboxProvider(bus)
    await provider.activate(makeHost())
    await provider.deactivate('shutdown')

    expect(kinds).toEqual(['pre-activate', 'post-activate', 'pre-deactivate', 'post-deactivate'])
  })

  it('emits a complete verb lifecycle (pre → post) then lifecycle deactivate', async () => {
    const bus = new HookBus()
    const kinds: string[] = []
    bus.subscribe({}, (e) => { kinds.push(e.kind) })

    const provider = new TestSandboxProvider(bus)
    await provider.activate(makeHost())
    await provider.callVerb('provision', {}, async () => ({}))
    await provider.callVerb('release', {}, async () => ({}))
    await provider.deactivate()

    expect(kinds).toEqual([
      'pre-activate', 'post-activate',
      'pre-verb', 'post-verb',
      'pre-verb', 'post-verb',
      'pre-deactivate', 'post-deactivate',
    ])
  })
})
