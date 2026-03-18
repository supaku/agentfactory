import { describe, it, expect, vi } from 'vitest'
import {
  calculateDelay,
  withRetry,
  createRetryWrapper,
  DEFAULT_RETRY_CONFIG,
} from './retry.js'
import type { RetryConfig } from './types.js'

// Use very short delays to avoid real waits in tests
const fastConfig: Required<RetryConfig> = {
  maxRetries: 3,
  initialDelayMs: 1,
  backoffMultiplier: 2,
  maxDelayMs: 1,
  retryableStatusCodes: [429, 500, 502, 503, 504],
}

// ============================================================================
// calculateDelay
// ============================================================================

describe('calculateDelay', () => {
  const config: Required<RetryConfig> = {
    maxRetries: 3,
    initialDelayMs: 1000,
    backoffMultiplier: 2,
    maxDelayMs: 10000,
    retryableStatusCodes: [429, 500, 502, 503, 504],
  }

  it('returns initialDelayMs for attempt 0', () => {
    expect(calculateDelay(0, config)).toBe(1000)
  })

  it('returns initialDelayMs * backoffMultiplier for attempt 1', () => {
    expect(calculateDelay(1, config)).toBe(2000)
  })

  it('returns initialDelayMs * backoffMultiplier^2 for attempt 2', () => {
    expect(calculateDelay(2, config)).toBe(4000)
  })

  it('caps at maxDelayMs', () => {
    // attempt 4 would be 1000 * 2^4 = 16000, but max is 10000
    expect(calculateDelay(4, config)).toBe(10000)
  })

  it('works with custom config values', () => {
    const custom: Required<RetryConfig> = {
      maxRetries: 5,
      initialDelayMs: 500,
      backoffMultiplier: 3,
      maxDelayMs: 20000,
      retryableStatusCodes: [],
    }
    // attempt 0: 500
    expect(calculateDelay(0, custom)).toBe(500)
    // attempt 1: 500 * 3 = 1500
    expect(calculateDelay(1, custom)).toBe(1500)
    // attempt 2: 500 * 9 = 4500
    expect(calculateDelay(2, custom)).toBe(4500)
    // attempt 3: 500 * 27 = 13500
    expect(calculateDelay(3, custom)).toBe(13500)
    // attempt 4: 500 * 81 = 40500, capped at 20000
    expect(calculateDelay(4, custom)).toBe(20000)
  })
})

// ============================================================================
// withRetry
// ============================================================================

describe('withRetry', () => {
  it('succeeds on first attempt without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok')

    const result = await withRetry(fn, { config: fastConfig })

    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('succeeds on 2nd attempt after 1 failure', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValue('ok')

    const result = await withRetry(fn, {
      config: fastConfig,
      shouldRetry: () => true,
    })

    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('succeeds on nth attempt', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockRejectedValueOnce(new Error('fail 3'))
      .mockResolvedValue('ok')

    const result = await withRetry(fn, {
      config: fastConfig,
      shouldRetry: () => true,
    })

    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(4)
  })

  it('throws after exhausting all retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('persistent failure'))

    await expect(
      withRetry(fn, {
        config: { ...fastConfig, maxRetries: 2 },
        shouldRetry: () => true,
      })
    ).rejects.toThrow('persistent failure')

    // attempt 0, 1, 2 = 3 calls total
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('calls onRetry callback on each retry', async () => {
    const onRetry = vi.fn()
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValue('ok')

    await withRetry(fn, {
      config: fastConfig,
      shouldRetry: () => true,
      onRetry,
    })

    expect(onRetry).toHaveBeenCalledTimes(2)

    // First retry: attempt 0
    expect(onRetry).toHaveBeenNthCalledWith(1, {
      attempt: 0,
      maxRetries: fastConfig.maxRetries,
      lastError: expect.objectContaining({ message: 'fail 1' }),
      delay: expect.any(Number),
    })

    // Second retry: attempt 1
    expect(onRetry).toHaveBeenNthCalledWith(2, {
      attempt: 1,
      maxRetries: fastConfig.maxRetries,
      lastError: expect.objectContaining({ message: 'fail 2' }),
      delay: expect.any(Number),
    })
  })

  it('respects custom shouldRetry predicate and stops retrying when false', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('retryable'))
      .mockRejectedValueOnce(new Error('not retryable'))
      .mockResolvedValue('ok')

    const shouldRetry = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)

    await expect(
      withRetry(fn, { config: fastConfig, shouldRetry })
    ).rejects.toThrow('not retryable')

    expect(fn).toHaveBeenCalledTimes(2)
    expect(shouldRetry).toHaveBeenCalledTimes(2)
  })

  it('does not retry when shouldRetry returns false for specific error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fatal'))

    await expect(
      withRetry(fn, {
        config: fastConfig,
        shouldRetry: () => false,
      })
    ).rejects.toThrow('fatal')

    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('uses getRetryAfterMs delay when provided', async () => {
    const onRetry = vi.fn()
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValue('ok')

    await withRetry(fn, {
      config: fastConfig,
      shouldRetry: () => true,
      getRetryAfterMs: () => 5,
      onRetry,
    })

    expect(fn).toHaveBeenCalledTimes(2)
    // The delay should be the value from getRetryAfterMs (5), not the calculated backoff
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ delay: 5 })
    )
  })

  it('calls onRateLimited when getRetryAfterMs returns a value', async () => {
    const onRateLimited = vi.fn()
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValue('ok')

    await withRetry(fn, {
      config: fastConfig,
      shouldRetry: () => true,
      getRetryAfterMs: () => 42,
      onRateLimited,
    })

    expect(onRateLimited).toHaveBeenCalledTimes(1)
    expect(onRateLimited).toHaveBeenCalledWith(42)
  })

  it('does not call onRateLimited when getRetryAfterMs returns null', async () => {
    const onRateLimited = vi.fn()
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValue('ok')

    await withRetry(fn, {
      config: fastConfig,
      shouldRetry: () => true,
      getRetryAfterMs: () => null,
      onRateLimited,
    })

    expect(onRateLimited).not.toHaveBeenCalled()
  })

  it('wraps non-Error thrown values into Error objects', async () => {
    const fn = vi.fn().mockRejectedValue('string error')

    await expect(
      withRetry(fn, {
        config: { ...fastConfig, maxRetries: 0 },
        shouldRetry: () => true,
      })
    ).rejects.toThrow('string error')
  })
})

// ============================================================================
// createRetryWrapper
// ============================================================================

describe('createRetryWrapper', () => {
  it('creates a wrapper that uses default options', async () => {
    const onRetry = vi.fn()
    const retryFn = createRetryWrapper({
      config: fastConfig,
      shouldRetry: () => true,
      onRetry,
    })

    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok')

    const result = await retryFn(fn)

    expect(result).toBe('ok')
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('allows overriding defaults per call', async () => {
    const defaultOnRetry = vi.fn()
    const callOnRetry = vi.fn()

    const retryFn = createRetryWrapper({
      config: fastConfig,
      shouldRetry: () => true,
      onRetry: defaultOnRetry,
    })

    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok')

    await retryFn(fn, { onRetry: callOnRetry })

    // Per-call onRetry should override the default
    expect(callOnRetry).toHaveBeenCalledTimes(1)
    expect(defaultOnRetry).not.toHaveBeenCalled()
  })

  it('merges config from defaults and per-call overrides', async () => {
    const onRetry = vi.fn()

    const retryFn = createRetryWrapper({
      config: { ...fastConfig, maxRetries: 5 },
      shouldRetry: () => true,
      onRetry,
    })

    const fn = vi.fn().mockRejectedValue(new Error('fail'))

    // Override maxRetries to 1 per call
    await expect(
      retryFn(fn, { config: { maxRetries: 1 } })
    ).rejects.toThrow('fail')

    // 2 calls: attempt 0 + attempt 1
    expect(fn).toHaveBeenCalledTimes(2)
  })
})

// ============================================================================
// DEFAULT_RETRY_CONFIG
// ============================================================================

describe('DEFAULT_RETRY_CONFIG', () => {
  it('has expected default values', () => {
    expect(DEFAULT_RETRY_CONFIG).toEqual({
      maxRetries: 3,
      initialDelayMs: 1000,
      backoffMultiplier: 2,
      maxDelayMs: 10000,
      retryableStatusCodes: [429, 500, 502, 503, 504],
    })
  })
})
