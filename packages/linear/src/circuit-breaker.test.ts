import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CircuitBreaker, DEFAULT_CIRCUIT_BREAKER_CONFIG } from './circuit-breaker.js'
import { CircuitOpenError } from './errors.js'

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ========================================================================
  // Construction & defaults
  // ========================================================================

  it('starts in closed state', () => {
    const cb = new CircuitBreaker()
    expect(cb.state).toBe('closed')
  })

  it('uses default config when none provided', () => {
    const cb = new CircuitBreaker()
    const status = cb.getStatus()
    expect(status.state).toBe('closed')
    expect(status.consecutiveFailures).toBe(0)
    expect(status.currentResetTimeoutMs).toBe(DEFAULT_CIRCUIT_BREAKER_CONFIG.resetTimeoutMs)
  })

  it('accepts custom config', () => {
    const cb = new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 30_000 })
    // Trip it 4 times — should still be closed
    for (let i = 0; i < 4; i++) {
      cb.recordAuthFailure(401)
    }
    expect(cb.state).toBe('closed')
    // 5th failure trips it
    cb.recordAuthFailure(401)
    expect(cb.state).toBe('open')
  })

  // ========================================================================
  // canProceed
  // ========================================================================

  it('allows calls when closed', () => {
    const cb = new CircuitBreaker()
    expect(cb.canProceed()).toBe(true)
  })

  it('blocks calls when open', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 })
    cb.recordAuthFailure(401)
    expect(cb.state).toBe('open')
    expect(cb.canProceed()).toBe(false)
  })

  it('allows one probe call when half-open', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 })
    cb.recordAuthFailure(401)
    expect(cb.state).toBe('open')

    // Advance past reset timeout
    vi.advanceTimersByTime(1001)
    expect(cb.state).toBe('half-open')

    // First call should be allowed (probe)
    expect(cb.canProceed()).toBe(true)
    // Second call should be blocked (probe already in-flight)
    expect(cb.canProceed()).toBe(false)
  })

  // ========================================================================
  // State transitions: closed → open
  // ========================================================================

  it('trips after consecutive auth failures reach threshold', () => {
    const cb = new CircuitBreaker({ failureThreshold: 2 })

    cb.recordAuthFailure(400)
    expect(cb.state).toBe('closed')

    cb.recordAuthFailure(401)
    expect(cb.state).toBe('open')
  })

  it('ignores non-auth status codes for failure counting', () => {
    const cb = new CircuitBreaker({ failureThreshold: 2 })

    cb.recordAuthFailure(500) // not in authErrorCodes
    cb.recordAuthFailure(502)
    expect(cb.state).toBe('closed')
    expect(cb.getStatus().consecutiveFailures).toBe(0)
  })

  it('resets failure count on success', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 })

    cb.recordAuthFailure(401) // 1
    cb.recordAuthFailure(403) // 2
    cb.recordSuccess()        // reset to 0
    cb.recordAuthFailure(400) // 1 — should NOT trip
    expect(cb.state).toBe('closed')
  })

  // ========================================================================
  // State transitions: open → half-open
  // ========================================================================

  it('transitions from open to half-open after resetTimeoutMs', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 5000 })
    cb.recordAuthFailure(401)
    expect(cb.state).toBe('open')

    // Not enough time
    vi.advanceTimersByTime(4999)
    expect(cb.state).toBe('open')

    // Exactly enough time
    vi.advanceTimersByTime(1)
    expect(cb.state).toBe('half-open')
  })

  // ========================================================================
  // State transitions: half-open → closed (probe success)
  // ========================================================================

  it('closes circuit on successful probe in half-open', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 })
    cb.recordAuthFailure(401)

    vi.advanceTimersByTime(1001)
    expect(cb.state).toBe('half-open')

    // Probe succeeds
    cb.canProceed() // acquire probe
    cb.recordSuccess()
    expect(cb.state).toBe('closed')
    expect(cb.getStatus().consecutiveFailures).toBe(0)
  })

  // ========================================================================
  // State transitions: half-open → open (probe failure + exponential backoff)
  // ========================================================================

  it('reopens circuit on failed probe with exponential backoff', () => {
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      maxResetTimeoutMs: 16000,
      backoffMultiplier: 2,
    })

    // First trip
    cb.recordAuthFailure(401)
    expect(cb.state).toBe('open')
    expect(cb.getStatus().currentResetTimeoutMs).toBe(1000)

    // Wait for half-open
    vi.advanceTimersByTime(1001)
    expect(cb.state).toBe('half-open')

    // Probe fails → reopen with backoff
    cb.canProceed()
    cb.recordAuthFailure(401)
    expect(cb.state).toBe('open')
    expect(cb.getStatus().currentResetTimeoutMs).toBe(2000) // 1000 * 2

    // Wait 2000ms for next half-open
    vi.advanceTimersByTime(2001)
    expect(cb.state).toBe('half-open')

    // Probe fails again → further backoff
    cb.canProceed()
    cb.recordAuthFailure(401)
    expect(cb.state).toBe('open')
    expect(cb.getStatus().currentResetTimeoutMs).toBe(4000) // 2000 * 2
  })

  it('caps reset timeout at maxResetTimeoutMs', () => {
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      maxResetTimeoutMs: 3000,
      backoffMultiplier: 2,
    })

    // Trip → open (1000ms)
    cb.recordAuthFailure(401)
    vi.advanceTimersByTime(1001)

    // Probe fail → 2000ms
    cb.canProceed()
    cb.recordAuthFailure(401)
    vi.advanceTimersByTime(2001)

    // Probe fail → 3000ms (capped at max)
    cb.canProceed()
    cb.recordAuthFailure(401)
    expect(cb.getStatus().currentResetTimeoutMs).toBe(3000)

    vi.advanceTimersByTime(3001)
    // Probe fail → still 3000ms (capped)
    cb.canProceed()
    cb.recordAuthFailure(401)
    expect(cb.getStatus().currentResetTimeoutMs).toBe(3000)
  })

  it('resets backoff on successful recovery', () => {
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      maxResetTimeoutMs: 16000,
      backoffMultiplier: 2,
    })

    // Trip and backoff to 2000ms
    cb.recordAuthFailure(401)
    vi.advanceTimersByTime(1001)
    cb.canProceed()
    cb.recordAuthFailure(401)
    expect(cb.getStatus().currentResetTimeoutMs).toBe(2000)

    // Recover
    vi.advanceTimersByTime(2001)
    cb.canProceed()
    cb.recordSuccess()
    expect(cb.state).toBe('closed')
    expect(cb.getStatus().currentResetTimeoutMs).toBe(1000) // reset to original
  })

  // ========================================================================
  // reset()
  // ========================================================================

  it('reset() returns to closed from any state', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 })
    cb.recordAuthFailure(401)
    expect(cb.state).toBe('open')

    cb.reset()
    expect(cb.state).toBe('closed')
    expect(cb.getStatus().consecutiveFailures).toBe(0)
    expect(cb.getStatus().currentResetTimeoutMs).toBe(DEFAULT_CIRCUIT_BREAKER_CONFIG.resetTimeoutMs)
  })

  // ========================================================================
  // isAuthError
  // ========================================================================

  it('detects auth errors by HTTP status code', () => {
    const cb = new CircuitBreaker()

    expect(cb.isAuthError({ status: 400 })).toBe(true)
    expect(cb.isAuthError({ status: 401 })).toBe(true)
    expect(cb.isAuthError({ status: 403 })).toBe(true)
    expect(cb.isAuthError({ statusCode: 401 })).toBe(true)
    expect(cb.isAuthError({ response: { status: 403 } })).toBe(true)
  })

  it('does not flag non-auth status codes', () => {
    const cb = new CircuitBreaker()

    expect(cb.isAuthError({ status: 200 })).toBe(false)
    expect(cb.isAuthError({ status: 404 })).toBe(false)
    expect(cb.isAuthError({ status: 500 })).toBe(false)
    expect(cb.isAuthError({ status: 429 })).toBe(false) // rate limit is handled separately
  })

  it('detects GraphQL RATELIMITED error code', () => {
    const cb = new CircuitBreaker()

    // Direct extensions.code
    expect(cb.isAuthError({ extensions: { code: 'RATELIMITED' } })).toBe(true)

    // Nested errors array
    expect(
      cb.isAuthError({
        errors: [{ extensions: { code: 'RATELIMITED' } }],
      })
    ).toBe(true)

    // In response body
    expect(
      cb.isAuthError({
        response: {
          body: {
            errors: [{ extensions: { code: 'RATELIMITED' } }],
          },
        },
      })
    ).toBe(true)

    // In response data (alternative shape)
    expect(
      cb.isAuthError({
        response: {
          data: {
            errors: [{ extensions: { code: 'RATELIMITED' } }],
          },
        },
      })
    ).toBe(true)
  })

  it('detects auth errors by message pattern', () => {
    const cb = new CircuitBreaker()

    expect(cb.isAuthError({ message: 'Access denied - Only app users can create agent activities' })).toBe(true)
    expect(cb.isAuthError({ message: 'Unauthorized request' })).toBe(true)
    expect(cb.isAuthError({ message: 'Forbidden: insufficient permissions' })).toBe(true)
  })

  it('rejects non-error inputs', () => {
    const cb = new CircuitBreaker()

    expect(cb.isAuthError(null)).toBe(false)
    expect(cb.isAuthError(undefined)).toBe(false)
    expect(cb.isAuthError('string')).toBe(false)
    expect(cb.isAuthError(42)).toBe(false)
  })

  it('detects RATELIMITED in error message', () => {
    const cb = new CircuitBreaker()
    expect(cb.isAuthError({ message: 'GraphQL Error: RATELIMITED' })).toBe(true)
  })

  // ========================================================================
  // createOpenError
  // ========================================================================

  it('creates a CircuitOpenError with remaining time info', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10_000 })
    cb.recordAuthFailure(401)

    // 3 seconds have passed
    vi.advanceTimersByTime(3000)

    const error = cb.createOpenError()
    expect(error).toBeInstanceOf(CircuitOpenError)
    expect(error.code).toBe('CIRCUIT_OPEN')
    expect(error.retryAfterMs).toBeGreaterThan(0)
    expect(error.retryAfterMs).toBeLessThanOrEqual(7000)
    expect(error.message).toMatch(/Circuit breaker is open/)
  })

  // ========================================================================
  // getStatus diagnostic info
  // ========================================================================

  it('provides diagnostic status info', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 5000 })

    let status = cb.getStatus()
    expect(status.state).toBe('closed')
    expect(status.consecutiveFailures).toBe(0)
    expect(status.msSinceOpened).toBeNull()

    cb.recordAuthFailure(401)
    vi.advanceTimersByTime(2000)

    status = cb.getStatus()
    expect(status.state).toBe('open')
    expect(status.consecutiveFailures).toBe(1)
    expect(status.msSinceOpened).toBeGreaterThanOrEqual(2000)
  })
})
