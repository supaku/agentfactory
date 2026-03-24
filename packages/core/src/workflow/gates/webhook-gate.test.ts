import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  generateWebhookToken,
  buildCallbackUrl,
  validateWebhookCallback,
  evaluateWebhookGate,
  createWebhookGateActivation,
} from './webhook-gate.js'
import type { GateState } from '../gate-state.js'
import type { GateDefinition } from '../workflow-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGateDefinition(overrides: Partial<GateDefinition> = {}): GateDefinition {
  return {
    name: 'test-webhook',
    type: 'webhook',
    trigger: { endpoint: '/api/gates' },
    ...overrides,
  }
}

function makeGateState(overrides: Partial<GateState> = {}): GateState {
  return {
    issueId: 'issue-1',
    gateName: 'test-webhook',
    gateType: 'webhook',
    status: 'active',
    activatedAt: Date.now(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// generateWebhookToken
// ---------------------------------------------------------------------------

describe('generateWebhookToken', () => {
  it('returns a 64-character hex string', () => {
    const token = generateWebhookToken()
    expect(token).toHaveLength(64)
    expect(token).toMatch(/^[a-f0-9]{64}$/)
  })

  it('generates unique tokens', () => {
    const token1 = generateWebhookToken()
    const token2 = generateWebhookToken()
    expect(token1).not.toBe(token2)
  })
})

// ---------------------------------------------------------------------------
// buildCallbackUrl
// ---------------------------------------------------------------------------

describe('buildCallbackUrl', () => {
  it('builds correct URL format', () => {
    const url = buildCallbackUrl('https://api.example.com', 'issue-1', 'my-gate', 'abc123')
    expect(url).toBe('https://api.example.com/api/gates/issue-1/my-gate?token=abc123')
  })

  it('URI-encodes special characters in issueId', () => {
    const url = buildCallbackUrl('https://api.example.com', 'issue/1', 'gate', 'token')
    expect(url).toContain('issue%2F1')
  })

  it('URI-encodes special characters in gateName', () => {
    const url = buildCallbackUrl('https://api.example.com', 'issue-1', 'my gate', 'token')
    expect(url).toContain('my%20gate')
  })

  it('normalizes trailing slashes on base URL', () => {
    const url = buildCallbackUrl('https://api.example.com/', 'issue-1', 'gate', 'token')
    expect(url).toBe('https://api.example.com/api/gates/issue-1/gate?token=token')
  })

  it('normalizes multiple trailing slashes', () => {
    const url = buildCallbackUrl('https://api.example.com///', 'issue-1', 'gate', 'token')
    expect(url).toBe('https://api.example.com/api/gates/issue-1/gate?token=token')
  })
})

// ---------------------------------------------------------------------------
// validateWebhookCallback
// ---------------------------------------------------------------------------

describe('validateWebhookCallback', () => {
  it('returns true for matching tokens', () => {
    const token = 'test-webhook-token-value'
    expect(validateWebhookCallback(token, token)).toBe(true)
  })

  it('returns false for mismatched tokens', () => {
    expect(validateWebhookCallback('token-a', 'token-b')).toBe(false)
  })

  it('returns false for empty token', () => {
    expect(validateWebhookCallback('', 'expected')).toBe(false)
  })

  it('returns false for empty expected token', () => {
    expect(validateWebhookCallback('token', '')).toBe(false)
  })

  it('returns false for different length tokens', () => {
    expect(validateWebhookCallback('short', 'a-much-longer-token')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// evaluateWebhookGate
// ---------------------------------------------------------------------------

describe('evaluateWebhookGate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-06-01T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns not satisfied for null state', () => {
    const gate = makeGateDefinition()
    const result = evaluateWebhookGate(gate, null)
    expect(result.satisfied).toBe(false)
    expect(result.callbackUrl).toBeUndefined()
    expect(result.timedOut).toBeUndefined()
  })

  it('returns satisfied for satisfied state', () => {
    const gate = makeGateDefinition()
    const state = makeGateState({ status: 'satisfied', satisfiedAt: Date.now() })
    const result = evaluateWebhookGate(gate, state)
    expect(result.satisfied).toBe(true)
  })

  it('returns timedOut for timed-out state', () => {
    const gate = makeGateDefinition()
    const state = makeGateState({ status: 'timed-out', timedOutAt: Date.now() })
    const result = evaluateWebhookGate(gate, state)
    expect(result.satisfied).toBe(false)
    expect(result.timedOut).toBe(true)
  })

  it('returns callbackUrl for active state', () => {
    const gate = makeGateDefinition()
    const state = makeGateState({
      status: 'active',
      signalSource: 'https://api.example.com/api/gates/issue-1/test-webhook?token=abc',
    })
    const result = evaluateWebhookGate(gate, state)
    expect(result.satisfied).toBe(false)
    expect(result.callbackUrl).toBe(state.signalSource)
  })

  it('returns timedOut when active gate has expired deadline', () => {
    const gate = makeGateDefinition()
    const state = makeGateState({
      status: 'active',
      timeoutDeadline: Date.now() - 1000, // deadline in the past
    })
    const result = evaluateWebhookGate(gate, state)
    expect(result.satisfied).toBe(false)
    expect(result.timedOut).toBe(true)
  })

  it('returns not timed out when active gate has future deadline', () => {
    const gate = makeGateDefinition()
    const state = makeGateState({
      status: 'active',
      timeoutDeadline: Date.now() + 60_000, // deadline in the future
    })
    const result = evaluateWebhookGate(gate, state)
    expect(result.satisfied).toBe(false)
    expect(result.timedOut).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// createWebhookGateActivation
// ---------------------------------------------------------------------------

describe('createWebhookGateActivation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-06-01T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('generates a token', () => {
    const gate = makeGateDefinition()
    const activation = createWebhookGateActivation('issue-1', gate, 'https://api.example.com')
    expect(activation.token).toHaveLength(64)
    expect(activation.token).toMatch(/^[a-f0-9]{64}$/)
  })

  it('builds a callback URL with the generated token', () => {
    const gate = makeGateDefinition({ name: 'review-gate' })
    const activation = createWebhookGateActivation('issue-1', gate, 'https://api.example.com')
    expect(activation.callbackUrl).toContain('https://api.example.com/api/gates/issue-1/review-gate')
    expect(activation.callbackUrl).toContain(`token=${activation.token}`)
  })

  it('computes expiresAt from timeout duration', () => {
    const gate = makeGateDefinition({
      timeout: { duration: '4h', action: 'fail' },
    })
    const activation = createWebhookGateActivation('issue-1', gate, 'https://api.example.com')
    expect(activation.expiresAt).toBe(Date.now() + 14_400_000)
  })

  it('does not set expiresAt when no timeout configured', () => {
    const gate = makeGateDefinition()
    const activation = createWebhookGateActivation('issue-1', gate, 'https://api.example.com')
    expect(activation.expiresAt).toBeUndefined()
  })
})
