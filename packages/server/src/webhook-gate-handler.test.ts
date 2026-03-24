import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { handleWebhookGateCallback } from './webhook-gate-handler.js'

// ---------------------------------------------------------------------------
// Minimal in-memory gate storage for testing (avoids cross-worktree import)
// ---------------------------------------------------------------------------

interface GateState {
  issueId: string
  gateName: string
  gateType: 'signal' | 'timer' | 'webhook'
  status: 'pending' | 'active' | 'satisfied' | 'timed-out'
  activatedAt: number
  satisfiedAt?: number
  timedOutAt?: number
  timeoutAction?: 'escalate' | 'skip' | 'fail'
  signalSource?: string
  webhookToken?: string
  timeoutDuration?: string
  timeoutDeadline?: number
}

interface GateStorage {
  getGateState(issueId: string, gateName: string): Promise<GateState | null>
  setGateState(issueId: string, gateName: string, state: GateState): Promise<void>
  getActiveGates(issueId: string): Promise<GateState[]>
  clearGateStates(issueId: string): Promise<void>
}

class TestGateStorage implements GateStorage {
  private store = new Map<string, GateState>()
  private key(issueId: string, gateName: string) { return `${issueId}:${gateName}` }
  async getGateState(issueId: string, gateName: string) {
    return this.store.get(this.key(issueId, gateName)) ?? null
  }
  async setGateState(issueId: string, gateName: string, state: GateState) {
    this.store.set(this.key(issueId, gateName), state)
  }
  async getActiveGates(issueId: string) {
    const results: GateState[] = []
    for (const [key, state] of this.store) {
      if (key.startsWith(`${issueId}:`) && state.status === 'active') results.push(state)
    }
    return results
  }
  async clearGateStates(issueId: string) {
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(`${issueId}:`)) this.store.delete(key)
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeActiveWebhookGate(overrides: Partial<GateState> = {}): GateState {
  return {
    issueId: 'issue-1',
    gateName: 'approval-webhook',
    gateType: 'webhook',
    status: 'active',
    activatedAt: Date.now(),
    webhookToken: 'known-token-value-for-testing-purposes-only',
    signalSource: 'https://api.example.com/api/gates/issue-1/approval-webhook?token=known-token-value-for-testing-purposes-only',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// handleWebhookGateCallback
// ---------------------------------------------------------------------------

describe('handleWebhookGateCallback', () => {
  let storage: TestGateStorage

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-06-01T12:00:00Z'))
    storage = new TestGateStorage()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // -----------------------------------------------------------------------
  // Parameter validation
  // -----------------------------------------------------------------------

  it('returns 400 when issueId is missing', async () => {
    const result = await handleWebhookGateCallback(
      { issueId: '', gateName: 'gate', token: 'tok' },
      storage,
    )
    expect(result.status).toBe(400)
    expect(result.body.ok).toBe(false)
    expect(result.body.error).toContain('issueId')
  })

  it('returns 400 when gateName is missing', async () => {
    const result = await handleWebhookGateCallback(
      { issueId: 'issue-1', gateName: '', token: 'tok' },
      storage,
    )
    expect(result.status).toBe(400)
    expect(result.body.ok).toBe(false)
    expect(result.body.error).toContain('gateName')
  })

  it('returns 401 when token is missing', async () => {
    const result = await handleWebhookGateCallback(
      { issueId: 'issue-1', gateName: 'gate', token: '' },
      storage,
    )
    expect(result.status).toBe(401)
    expect(result.body.ok).toBe(false)
    expect(result.body.error).toContain('token')
  })

  // -----------------------------------------------------------------------
  // Gate not found
  // -----------------------------------------------------------------------

  it('returns 404 when gate does not exist', async () => {
    const result = await handleWebhookGateCallback(
      { issueId: 'issue-1', gateName: 'nonexistent', token: 'tok' },
      storage,
    )
    expect(result.status).toBe(404)
    expect(result.body.ok).toBe(false)
    expect(result.body.error).toContain('not found')
  })

  it('returns 404 when gate is not a webhook type', async () => {
    const signalGate: GateState = {
      issueId: 'issue-1',
      gateName: 'signal-gate',
      gateType: 'signal',
      status: 'active',
      activatedAt: Date.now(),
    }
    await storage.setGateState('issue-1', 'signal-gate', signalGate)

    const result = await handleWebhookGateCallback(
      { issueId: 'issue-1', gateName: 'signal-gate', token: 'tok' },
      storage,
    )
    expect(result.status).toBe(404)
    expect(result.body.ok).toBe(false)
  })

  // -----------------------------------------------------------------------
  // Gate state conflicts
  // -----------------------------------------------------------------------

  it('returns 409 when gate is already satisfied', async () => {
    const gate = makeActiveWebhookGate({ status: 'satisfied', satisfiedAt: Date.now() })
    await storage.setGateState('issue-1', 'approval-webhook', gate)

    const result = await handleWebhookGateCallback(
      { issueId: 'issue-1', gateName: 'approval-webhook', token: gate.webhookToken! },
      storage,
    )
    expect(result.status).toBe(409)
    expect(result.body.ok).toBe(false)
    expect(result.body.gateStatus).toBe('satisfied')
    expect(result.body.error).toContain('satisfied')
  })

  it('returns 409 when gate is timed out', async () => {
    const gate = makeActiveWebhookGate({ status: 'timed-out', timedOutAt: Date.now() })
    await storage.setGateState('issue-1', 'approval-webhook', gate)

    const result = await handleWebhookGateCallback(
      { issueId: 'issue-1', gateName: 'approval-webhook', token: gate.webhookToken! },
      storage,
    )
    expect(result.status).toBe(409)
    expect(result.body.ok).toBe(false)
    expect(result.body.gateStatus).toBe('timed-out')
  })

  it('returns 409 when gate timeout deadline has passed', async () => {
    const gate = makeActiveWebhookGate({
      timeoutDeadline: Date.now() - 1000,
    })
    await storage.setGateState('issue-1', 'approval-webhook', gate)

    const result = await handleWebhookGateCallback(
      { issueId: 'issue-1', gateName: 'approval-webhook', token: gate.webhookToken! },
      storage,
    )
    expect(result.status).toBe(409)
    expect(result.body.ok).toBe(false)
    expect(result.body.error).toContain('expired')
  })

  // -----------------------------------------------------------------------
  // Token validation
  // -----------------------------------------------------------------------

  it('returns 401 when token does not match', async () => {
    const gate = makeActiveWebhookGate()
    await storage.setGateState('issue-1', 'approval-webhook', gate)

    const result = await handleWebhookGateCallback(
      { issueId: 'issue-1', gateName: 'approval-webhook', token: 'wrong-token' },
      storage,
    )
    expect(result.status).toBe(401)
    expect(result.body.ok).toBe(false)
    expect(result.body.error).toContain('Invalid token')
  })

  it('returns 500 when gate has no stored token', async () => {
    const gate = makeActiveWebhookGate({ webhookToken: undefined })
    await storage.setGateState('issue-1', 'approval-webhook', gate)

    const result = await handleWebhookGateCallback(
      { issueId: 'issue-1', gateName: 'approval-webhook', token: 'any-token' },
      storage,
    )
    expect(result.status).toBe(500)
    expect(result.body.ok).toBe(false)
    expect(result.body.error).toContain('token not configured')
  })

  // -----------------------------------------------------------------------
  // Successful satisfaction
  // -----------------------------------------------------------------------

  it('satisfies gate with valid token', async () => {
    const gate = makeActiveWebhookGate()
    await storage.setGateState('issue-1', 'approval-webhook', gate)

    const result = await handleWebhookGateCallback(
      { issueId: 'issue-1', gateName: 'approval-webhook', token: gate.webhookToken! },
      storage,
    )

    expect(result.status).toBe(200)
    expect(result.body.ok).toBe(true)
    expect(result.body.gate).toBe('approval-webhook')
    expect(result.body.gateStatus).toBe('satisfied')

    // Verify gate state was updated
    const updated = await storage.getGateState('issue-1', 'approval-webhook')
    expect(updated!.status).toBe('satisfied')
    expect(updated!.satisfiedAt).toBeDefined()
    expect(updated!.signalSource).toBe('webhook-callback')
  })

  it('satisfies gate with cryptographic token', async () => {
    const token = randomBytes(32).toString('hex')
    const gate = makeActiveWebhookGate({ webhookToken: token })
    await storage.setGateState('issue-1', 'approval-webhook', gate)

    const result = await handleWebhookGateCallback(
      { issueId: 'issue-1', gateName: 'approval-webhook', token },
      storage,
    )

    expect(result.status).toBe(200)
    expect(result.body.ok).toBe(true)
  })

  it('includes payload in signal source when provided', async () => {
    const gate = makeActiveWebhookGate()
    await storage.setGateState('issue-1', 'approval-webhook', gate)

    const result = await handleWebhookGateCallback(
      {
        issueId: 'issue-1',
        gateName: 'approval-webhook',
        token: gate.webhookToken!,
        payload: { status: 'approved', reviewer: 'alice' },
      },
      storage,
    )

    expect(result.status).toBe(200)
    expect(result.body.ok).toBe(true)

    const updated = await storage.getGateState('issue-1', 'approval-webhook')
    expect(updated!.signalSource).toContain('webhook-callback:')
    expect(updated!.signalSource).toContain('approved')
    expect(updated!.signalSource).toContain('alice')
  })

  it('works with gate that has a future timeout deadline', async () => {
    const gate = makeActiveWebhookGate({
      timeoutDeadline: Date.now() + 60_000,
    })
    await storage.setGateState('issue-1', 'approval-webhook', gate)

    const result = await handleWebhookGateCallback(
      { issueId: 'issue-1', gateName: 'approval-webhook', token: gate.webhookToken! },
      storage,
    )

    expect(result.status).toBe(200)
    expect(result.body.ok).toBe(true)
  })

  // -----------------------------------------------------------------------
  // Idempotency: second callback after satisfaction
  // -----------------------------------------------------------------------

  it('returns 409 on second callback after gate is already satisfied', async () => {
    const gate = makeActiveWebhookGate()
    await storage.setGateState('issue-1', 'approval-webhook', gate)

    // First callback — succeeds
    const first = await handleWebhookGateCallback(
      { issueId: 'issue-1', gateName: 'approval-webhook', token: gate.webhookToken! },
      storage,
    )
    expect(first.status).toBe(200)

    // Second callback — gate is now satisfied
    const second = await handleWebhookGateCallback(
      { issueId: 'issue-1', gateName: 'approval-webhook', token: gate.webhookToken! },
      storage,
    )
    expect(second.status).toBe(409)
    expect(second.body.gateStatus).toBe('satisfied')
  })
})
