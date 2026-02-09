import type { RetryConfig } from './types'
import { isRetryableError } from './errors'

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  backoffMultiplier: 2,
  maxDelayMs: 10000,
  retryableStatusCodes: [429, 500, 502, 503, 504],
}

/**
 * Sleep utility for async delays
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Calculate delay for a given retry attempt with exponential backoff
 */
export function calculateDelay(
  attempt: number,
  config: Required<RetryConfig>
): number {
  const delay =
    config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt)
  return Math.min(delay, config.maxDelayMs)
}

/**
 * Retry context passed to callbacks
 */
export interface RetryContext {
  attempt: number
  maxRetries: number
  lastError?: Error
  delay: number
}

/**
 * Callback for retry events
 */
export type RetryCallback = (context: RetryContext) => void

/**
 * Options for withRetry function
 */
export interface WithRetryOptions {
  config?: RetryConfig
  onRetry?: RetryCallback
  shouldRetry?: (error: unknown) => boolean
}

/**
 * Execute an async function with exponential backoff retry logic
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: WithRetryOptions = {}
): Promise<T> {
  const config: Required<RetryConfig> = {
    ...DEFAULT_RETRY_CONFIG,
    ...options.config,
  }

  const shouldRetry =
    options.shouldRetry ??
    ((error) => isRetryableError(error, config.retryableStatusCodes))

  let lastError: Error = new Error('Unknown error')

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      if (attempt === config.maxRetries || !shouldRetry(error)) {
        throw lastError
      }

      const delay = calculateDelay(attempt, config)

      if (options.onRetry) {
        options.onRetry({
          attempt,
          maxRetries: config.maxRetries,
          lastError,
          delay,
        })
      }

      await sleep(delay)
    }
  }

  throw lastError
}

/**
 * Create a retry wrapper with pre-configured options
 */
export function createRetryWrapper(defaultOptions: WithRetryOptions = {}) {
  return function <T>(
    fn: () => Promise<T>,
    options?: WithRetryOptions
  ): Promise<T> {
    return withRetry(fn, {
      ...defaultOptions,
      ...options,
      config: {
        ...defaultOptions.config,
        ...options?.config,
      },
    })
  }
}
