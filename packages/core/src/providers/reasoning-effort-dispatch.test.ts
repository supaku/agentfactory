/**
 * REN-1245 — Per-step reasoning-effort dispatch tests.
 *
 * Verifies:
 *  1. Capability plumbing — every shipping provider declares
 *     `supportsReasoningEffort` and the value matches the documented matrix.
 *  2. Effort is forwarded to the AgentSpawnConfig when the provider supports
 *     it (no warning, no drop).
 *  3. Effort is dropped + a Layer-6 `capability-mismatch` event is emitted
 *     when the provider does NOT support it.
 *  4. Missing/undefined effort never produces a warning (no-op path).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { ClaudeProvider } from './claude-provider.js'
import { CodexProvider } from './codex-provider.js'
import { CodexAppServerProvider } from './codex-app-server-provider.js'
import { SpringAiProvider } from './spring-ai-provider.js'
import { AmpProvider } from './amp-provider.js'
import { A2aProvider } from './a2a-provider.js'
import { applyReasoningEffort } from './reasoning-effort-dispatch.js'
import { HookBus } from '../observability/hooks.js'
import type { ProviderHookEvent } from './base.js'
import type { AgentProvider } from './types.js'
import type { EffortLevel } from '../config/profiles.js'

// ---------------------------------------------------------------------------
// 1. Capability plumbing
// ---------------------------------------------------------------------------

describe('supportsReasoningEffort capability declarations', () => {
  it('ClaudeProvider declares supportsReasoningEffort: true', () => {
    expect(new ClaudeProvider().capabilities.supportsReasoningEffort).toBe(true)
  })

  it('CodexProvider declares supportsReasoningEffort: true (default exec mode)', () => {
    // Fresh provider — appServerViable undefined, isAppServerEnabled() default false.
    expect(new CodexProvider().capabilities.supportsReasoningEffort).toBe(true)
  })

  it('CodexAppServerProvider declares supportsReasoningEffort: true', () => {
    expect(new CodexAppServerProvider().capabilities.supportsReasoningEffort).toBe(true)
  })

  it('SpringAiProvider declares supportsReasoningEffort: false', () => {
    expect(new SpringAiProvider().capabilities.supportsReasoningEffort).toBe(false)
  })

  it('AmpProvider declares supportsReasoningEffort: false', () => {
    expect(new AmpProvider().capabilities.supportsReasoningEffort).toBe(false)
  })

  it('A2aProvider declares supportsReasoningEffort: false', () => {
    expect(new A2aProvider().capabilities.supportsReasoningEffort).toBe(false)
  })

  it('exactly the supported set matches the documented matrix', () => {
    const supported = [
      new ClaudeProvider(),
      new CodexProvider(),
      new CodexAppServerProvider(),
    ]
    const unsupported = [
      new SpringAiProvider(),
      new AmpProvider(),
      new A2aProvider(),
    ]
    for (const p of supported) {
      expect(p.capabilities.supportsReasoningEffort).toBe(true)
    }
    for (const p of unsupported) {
      expect(p.capabilities.supportsReasoningEffort).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Test helpers — synthesize minimal AgentProvider instances for unit tests
// ---------------------------------------------------------------------------

function makeProvider(opts: {
  name?: AgentProvider['name']
  supports: boolean | undefined
}): AgentProvider {
  const name = opts.name ?? 'claude'
  return {
    name,
    capabilities: {
      supportsMessageInjection: false,
      supportsSessionResume: false,
      emitsSubagentEvents: false,
      ...(opts.supports !== undefined ? { supportsReasoningEffort: opts.supports } : {}),
    },
    spawn: () => {
      throw new Error('not used in test')
    },
    resume: () => {
      throw new Error('not used in test')
    },
  }
}

// ---------------------------------------------------------------------------
// 2. Effort attached when supported
// ---------------------------------------------------------------------------

describe('applyReasoningEffort — supported provider', () => {
  let bus: HookBus
  let events: ProviderHookEvent[]

  beforeEach(() => {
    bus = new HookBus()
    events = []
    bus.subscribe({ kinds: ['capability-mismatch'] }, (e) => {
      events.push(e)
    })
  })

  for (const effort of ['low', 'medium', 'high', 'xhigh'] as EffortLevel[]) {
    it(`forwards effort='${effort}' when provider supports it`, async () => {
      const provider = makeProvider({ supports: true })
      const result = applyReasoningEffort({
        provider,
        requestedEffort: effort,
        bus,
      })
      expect(result.effort).toBe(effort)
      expect(result.dropped).toBe(false)
      // Allow the fire-and-forget bus emit microtask to settle.
      await Promise.resolve()
      expect(events).toHaveLength(0)
    })
  }

  it('returns effort=undefined when no requested effort, no warning', async () => {
    const provider = makeProvider({ supports: true })
    const result = applyReasoningEffort({
      provider,
      requestedEffort: undefined,
      bus,
    })
    expect(result.effort).toBeUndefined()
    expect(result.dropped).toBe(false)
    await Promise.resolve()
    expect(events).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 3. Drop + warn when unsupported
// ---------------------------------------------------------------------------

describe('applyReasoningEffort — unsupported provider', () => {
  let bus: HookBus
  let events: ProviderHookEvent[]

  beforeEach(() => {
    bus = new HookBus()
    events = []
    bus.subscribe({ kinds: ['capability-mismatch'] }, (e) => {
      events.push(e)
    })
  })

  it('drops effort and emits capability-mismatch when supportsReasoningEffort=false', async () => {
    const provider = makeProvider({ name: 'spring-ai', supports: false })
    const result = applyReasoningEffort({
      provider,
      requestedEffort: 'high',
      bus,
    })
    expect(result.effort).toBeUndefined()
    expect(result.dropped).toBe(true)

    // Bus emit is fire-and-forget via void-promise; flush microtasks.
    await new Promise((r) => setImmediate(r))

    expect(events).toHaveLength(1)
    const evt = events[0]
    expect(evt.kind).toBe('capability-mismatch')
    if (evt.kind !== 'capability-mismatch') return // narrow for TS
    expect(evt.provider.id).toBe('spring-ai')
    expect(evt.provider.family).toBe('agent-runtime')
    expect(evt.declared).toEqual({ supportsReasoningEffort: false })
    expect(evt.observed).toMatchObject({
      reasoningEffortRequested: 'high',
    })
    expect((evt.observed as Record<string, unknown>).droppedReason).toContain(
      'spring-ai',
    )
  })

  it('drops effort and emits capability-mismatch when supportsReasoningEffort is omitted', async () => {
    // Capability flag absent — treated as not supported (conservative default).
    const provider = makeProvider({ name: 'amp', supports: undefined })
    const result = applyReasoningEffort({
      provider,
      requestedEffort: 'xhigh',
      bus,
    })
    expect(result.effort).toBeUndefined()
    expect(result.dropped).toBe(true)
    await new Promise((r) => setImmediate(r))
    expect(events).toHaveLength(1)
  })

  it('does NOT warn when no effort is requested (no-op short-circuit)', async () => {
    const provider = makeProvider({ name: 'spring-ai', supports: false })
    const result = applyReasoningEffort({
      provider,
      requestedEffort: undefined,
      bus,
    })
    expect(result.effort).toBeUndefined()
    expect(result.dropped).toBe(false)
    await new Promise((r) => setImmediate(r))
    expect(events).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 4. End-to-end with real providers
// ---------------------------------------------------------------------------

describe('applyReasoningEffort — real provider integration', () => {
  let bus: HookBus
  let events: ProviderHookEvent[]

  beforeEach(() => {
    bus = new HookBus()
    events = []
    bus.subscribe({ kinds: ['capability-mismatch'] }, (e) => {
      events.push(e)
    })
  })

  it('Claude: high → forwarded, no warning', async () => {
    const r = applyReasoningEffort({
      provider: new ClaudeProvider(),
      requestedEffort: 'high',
      bus,
    })
    expect(r).toEqual({ effort: 'high', dropped: false })
    await new Promise((res) => setImmediate(res))
    expect(events).toHaveLength(0)
  })

  it('Codex (default exec mode): xhigh → forwarded, no warning', async () => {
    const r = applyReasoningEffort({
      provider: new CodexProvider(),
      requestedEffort: 'xhigh',
      bus,
    })
    expect(r).toEqual({ effort: 'xhigh', dropped: false })
    await new Promise((res) => setImmediate(res))
    expect(events).toHaveLength(0)
  })

  it('Spring AI: high → dropped + Layer-6 capability-mismatch', async () => {
    const r = applyReasoningEffort({
      provider: new SpringAiProvider(),
      requestedEffort: 'high',
      bus,
    })
    expect(r).toEqual({ effort: undefined, dropped: true })
    await new Promise((res) => setImmediate(res))
    expect(events).toHaveLength(1)
    const evt = events[0]
    if (evt.kind !== 'capability-mismatch') throw new Error('wrong kind')
    expect(evt.provider.id).toBe('spring-ai')
  })

  it('A2A: medium → dropped + Layer-6 capability-mismatch', async () => {
    const r = applyReasoningEffort({
      provider: new A2aProvider(),
      requestedEffort: 'medium',
      bus,
    })
    expect(r).toEqual({ effort: undefined, dropped: true })
    await new Promise((res) => setImmediate(res))
    expect(events).toHaveLength(1)
  })

  it('Amp: low → dropped + Layer-6 capability-mismatch', async () => {
    const r = applyReasoningEffort({
      provider: new AmpProvider(),
      requestedEffort: 'low',
      bus,
    })
    expect(r).toEqual({ effort: undefined, dropped: true })
    await new Promise((res) => setImmediate(res))
    expect(events).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 5. ProviderRef override
// ---------------------------------------------------------------------------

describe('applyReasoningEffort — providerRef override', () => {
  it('uses caller-supplied providerRef on the emitted event', async () => {
    const bus = new HookBus()
    const events: ProviderHookEvent[] = []
    bus.subscribe({ kinds: ['capability-mismatch'] }, (e) => {
      events.push(e)
    })

    const provider = makeProvider({ name: 'spring-ai', supports: false })
    applyReasoningEffort({
      provider,
      requestedEffort: 'high',
      bus,
      providerRef: { family: 'agent-runtime', id: 'custom-id', version: '1.2.3' },
    })

    await new Promise((res) => setImmediate(res))
    expect(events).toHaveLength(1)
    const evt = events[0]
    if (evt.kind !== 'capability-mismatch') throw new Error('wrong kind')
    expect(evt.provider.id).toBe('custom-id')
    expect(evt.provider.version).toBe('1.2.3')
  })
})
