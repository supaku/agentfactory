/**
 * Circuit Breaker for Linear API calls
 *
 * Prevents wasting rate limit quota on requests that are guaranteed to fail
 * (e.g., expired OAuth tokens, revoked access). Implements the standard
 * closed → open → half-open state machine.
 *
 * State machine:
 *   closed    → all calls proceed; auth failures increment counter;
 *               at threshold → open
 *   open      → all calls throw CircuitOpenError immediately (zero quota);
 *               after resetTimeoutMs → half-open
 *   half-open → one probe call allowed; success → closed;
 *               failure → open (with exponential backoff on reset timeout)
 */

import { CircuitOpenError } from './errors.js'
import type { CircuitBreakerConfig, CircuitBreakerStrategy } from './types.js'

export type CircuitState = 'closed' | 'open' | 'half-open'

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: Required<CircuitBreakerConfig> = {
  failureThreshold: 2,
  resetTimeoutMs: 60_000,
  maxResetTimeoutMs: 300_000,
  backoffMultiplier: 2,
  authErrorCodes: [400, 401, 403],
}

export class CircuitBreaker implements CircuitBreakerStrategy {
  private _state: CircuitState = 'closed'
  private consecutiveFailures = 0
  private openedAt = 0
  private currentResetTimeoutMs: number
  private probeInFlight = false
  private readonly config: Required<CircuitBreakerConfig>

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config }
    this.currentResetTimeoutMs = this.config.resetTimeoutMs
  }

  get state(): CircuitState {
    // Check if open circuit should transition to half-open
    if (this._state === 'open' && this.shouldTransitionToHalfOpen()) {
      this._state = 'half-open'
      this.probeInFlight = false
    }
    return this._state
  }

  /**
   * Check if a call is allowed to proceed.
   * In half-open state, only one probe call is allowed at a time.
   */
  canProceed(): boolean {
    const currentState = this.state // triggers open → half-open check

    switch (currentState) {
      case 'closed':
        return true
      case 'open':
        return false
      case 'half-open':
        // Allow exactly one probe call
        if (this.probeInFlight) return false
        this.probeInFlight = true
        return true
    }
  }

  /**
   * Record a successful API call. Resets the circuit to closed.
   */
  recordSuccess(): void {
    this.consecutiveFailures = 0
    this.probeInFlight = false
    if (this._state !== 'closed') {
      this._state = 'closed'
      this.currentResetTimeoutMs = this.config.resetTimeoutMs
    }
  }

  /**
   * Record an auth failure. May trip the circuit to open.
   * Called after isAuthError() returns true, so the error is already vetted.
   */
  recordAuthFailure(_statusCode?: number): void {
    this.probeInFlight = false
    this.consecutiveFailures++

    if (this._state === 'half-open') {
      // Probe failed — reopen with exponential backoff
      this.trip()
      this.currentResetTimeoutMs = Math.min(
        this.currentResetTimeoutMs * this.config.backoffMultiplier,
        this.config.maxResetTimeoutMs
      )
      return
    }

    if (this.consecutiveFailures >= this.config.failureThreshold) {
      this.trip()
    }
  }

  /**
   * Check if an error is an auth/rate-limit error that should count as a circuit failure.
   *
   * Detects:
   * - HTTP status codes in authErrorCodes (400, 401, 403)
   * - Linear GraphQL RATELIMITED error code in response body
   * - Linear SDK error objects with nested error details
   */
  isAuthError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false

    const err = error as Record<string, unknown>

    // Check HTTP status code
    const statusCode = extractStatusCode(err)
    if (statusCode !== null && this.config.authErrorCodes.includes(statusCode)) {
      return true
    }

    // Check for Linear GraphQL RATELIMITED error
    if (isGraphQLRateLimited(err)) {
      return true
    }

    // Check error message for known auth failure patterns
    const message = (err.message as string) ?? ''
    if (/access denied|unauthorized|forbidden/i.test(message)) {
      return true
    }

    return false
  }

  /**
   * Extract the status code from an auth error, or 0 if not determinable.
   */
  extractStatusCode(error: unknown): number {
    if (typeof error !== 'object' || error === null) return 0
    return extractStatusCode(error as Record<string, unknown>) ?? 0
  }

  /**
   * Reset the circuit breaker to closed state.
   */
  reset(): void {
    this._state = 'closed'
    this.consecutiveFailures = 0
    this.probeInFlight = false
    this.currentResetTimeoutMs = this.config.resetTimeoutMs
  }

  /**
   * Get diagnostic info for logging/monitoring.
   */
  getStatus(): {
    state: CircuitState
    consecutiveFailures: number
    currentResetTimeoutMs: number
    msSinceOpened: number | null
  } {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      currentResetTimeoutMs: this.currentResetTimeoutMs,
      msSinceOpened: this.openedAt > 0 ? Date.now() - this.openedAt : null,
    }
  }

  /**
   * Create a CircuitOpenError with current diagnostic info.
   */
  createOpenError(): CircuitOpenError {
    const timeRemaining = Math.max(
      0,
      this.currentResetTimeoutMs - (Date.now() - this.openedAt)
    )
    return new CircuitOpenError(
      `Circuit breaker is open — Linear API calls blocked for ${Math.ceil(timeRemaining / 1000)}s. ` +
        `${this.consecutiveFailures} consecutive auth failures detected.`,
      timeRemaining
    )
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private trip(): void {
    this._state = 'open'
    this.openedAt = Date.now()
  }

  private shouldTransitionToHalfOpen(): boolean {
    return Date.now() - this.openedAt >= this.currentResetTimeoutMs
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract HTTP status code from various error shapes
 */
function extractStatusCode(err: Record<string, unknown>): number | null {
  // Direct status/statusCode property
  if (typeof err.status === 'number') return err.status
  if (typeof err.statusCode === 'number') return err.statusCode

  // Nested in response
  const response = err.response as Record<string, unknown> | undefined
  if (response) {
    if (typeof response.status === 'number') return response.status
    if (typeof response.statusCode === 'number') return response.statusCode
  }

  return null
}

/**
 * Check if the error contains a Linear GraphQL RATELIMITED error code.
 *
 * Linear returns HTTP 200 with a GraphQL error body when rate-limited:
 * { errors: [{ extensions: { code: 'RATELIMITED' } }] }
 */
function isGraphQLRateLimited(err: Record<string, unknown>): boolean {
  // Check error.extensions.code directly (Linear SDK error shape)
  const extensions = err.extensions as Record<string, unknown> | undefined
  if (extensions?.code === 'RATELIMITED') return true

  // Check nested errors array (raw GraphQL response shape)
  const errors = err.errors as Array<Record<string, unknown>> | undefined
  if (Array.isArray(errors)) {
    for (const gqlError of errors) {
      const ext = gqlError.extensions as Record<string, unknown> | undefined
      if (ext?.code === 'RATELIMITED') return true
    }
  }

  // Check response body for GraphQL errors
  const response = err.response as Record<string, unknown> | undefined
  if (response) {
    const body = response.body as Record<string, unknown> | undefined
    const data = response.data as Record<string, unknown> | undefined
    const target = body ?? data
    if (target) {
      const bodyErrors = target.errors as Array<Record<string, unknown>> | undefined
      if (Array.isArray(bodyErrors)) {
        for (const gqlError of bodyErrors) {
          const ext = gqlError.extensions as Record<string, unknown> | undefined
          if (ext?.code === 'RATELIMITED') return true
        }
      }
    }
  }

  // Check error message as last resort
  const message = (err.message as string) ?? ''
  if (message.includes('RATELIMITED')) return true

  return false
}
