/**
 * Base error class for Linear Agent SDK errors
 */
export class LinearAgentError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'LinearAgentError'
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, LinearAgentError)
    }
  }
}

/**
 * Error thrown when Linear API returns an error response
 */
export class LinearApiError extends LinearAgentError {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly response?: unknown
  ) {
    super(message, 'LINEAR_API_ERROR', { statusCode, response })
    this.name = 'LinearApiError'
  }
}

/**
 * Error thrown when all retry attempts are exhausted
 */
export class LinearRetryExhaustedError extends LinearAgentError {
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly lastError: Error
  ) {
    super(message, 'RETRY_EXHAUSTED', {
      attempts,
      lastErrorMessage: lastError.message,
    })
    this.name = 'LinearRetryExhaustedError'
  }
}

/**
 * Error thrown when session operations fail
 */
export class LinearSessionError extends LinearAgentError {
  constructor(
    message: string,
    public readonly sessionId?: string,
    public readonly issueId?: string
  ) {
    super(message, 'SESSION_ERROR', { sessionId, issueId })
    this.name = 'LinearSessionError'
  }
}

/**
 * Error thrown when activity emission fails
 */
export class LinearActivityError extends LinearAgentError {
  constructor(
    message: string,
    public readonly activityType: string,
    public readonly sessionId?: string
  ) {
    super(message, 'ACTIVITY_ERROR', { activityType, sessionId })
    this.name = 'LinearActivityError'
  }
}

/**
 * Error thrown when plan update fails
 */
export class LinearPlanError extends LinearAgentError {
  constructor(message: string, public readonly sessionId?: string) {
    super(message, 'PLAN_ERROR', { sessionId })
    this.name = 'LinearPlanError'
  }
}

/**
 * Error thrown when issue status transition fails
 */
export class LinearStatusTransitionError extends LinearAgentError {
  constructor(
    message: string,
    public readonly issueId: string,
    public readonly fromStatus: string,
    public readonly toStatus: string
  ) {
    super(message, 'STATUS_TRANSITION_ERROR', {
      issueId,
      fromStatus,
      toStatus,
    })
    this.name = 'LinearStatusTransitionError'
  }
}

/**
 * Error thrown when the circuit breaker is open.
 * All API calls are blocked to prevent wasting rate limit quota.
 */
export class CircuitOpenError extends LinearAgentError {
  constructor(
    message: string,
    public readonly retryAfterMs: number
  ) {
    super(message, 'CIRCUIT_OPEN', { retryAfterMs })
    this.name = 'CircuitOpenError'
  }
}

/**
 * Error thrown when agent spawning fails
 */
export class AgentSpawnError extends LinearAgentError {
  constructor(
    message: string,
    public readonly issueId: string,
    public readonly sessionId?: string,
    public readonly isRetryable: boolean = false,
    public readonly cause?: Error
  ) {
    super(message, 'AGENT_SPAWN_ERROR', {
      issueId,
      sessionId,
      isRetryable,
      causeMessage: cause?.message,
    })
    this.name = 'AgentSpawnError'
  }
}

/**
 * Type guard to check if an error is a LinearAgentError
 */
export function isLinearAgentError(error: unknown): error is LinearAgentError {
  return error instanceof LinearAgentError
}

/**
 * Type guard to check if an error is an AgentSpawnError
 */
export function isAgentSpawnError(error: unknown): error is AgentSpawnError {
  return error instanceof AgentSpawnError
}

/**
 * Type guard to check if an error is a CircuitOpenError
 */
export function isCircuitOpenError(error: unknown): error is CircuitOpenError {
  return error instanceof CircuitOpenError
}

/**
 * Type guard to check if an error is retryable
 */
export function isRetryableError(
  error: unknown,
  retryableStatusCodes: number[] = [429, 500, 502, 503, 504]
): boolean {
  if (error instanceof LinearApiError) {
    return retryableStatusCodes.includes(error.statusCode)
  }
  if (error instanceof Error) {
    const networkErrorPatterns = [
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
      'fetch failed',
      'network error',
    ]
    return networkErrorPatterns.some((pattern) =>
      error.message.toLowerCase().includes(pattern.toLowerCase())
    )
  }
  return false
}
