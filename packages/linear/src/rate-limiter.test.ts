import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TokenBucket, DEFAULT_RATE_LIMIT_CONFIG, extractRetryAfterMs } from './rate-limiter.js'

describe('TokenBucket', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ========================================================================
  // Construction & defaults
  // ========================================================================

  it('uses default config when none provided', () => {
    const bucket = new TokenBucket()
    expect(bucket.availableTokens).toBe(DEFAULT_RATE_LIMIT_CONFIG.maxTokens)
  })

  it('accepts custom config', () => {
    const bucket = new TokenBucket({ maxTokens: 10, refillRate: 5 })
    expect(bucket.availableTokens).toBe(10)
  })

  it('allows partial config overrides', () => {
    const bucket = new TokenBucket({ maxTokens: 20 })
    expect(bucket.availableTokens).toBe(20)
  })

  // ========================================================================
  // Token acquisition
  // ========================================================================

  it('resolves immediately when tokens are available', async () => {
    const bucket = new TokenBucket({ maxTokens: 5, refillRate: 1 })

    await bucket.acquire()
    expect(bucket.availableTokens).toBe(4)
  })

  it('depletes tokens with multiple acquires', async () => {
    const bucket = new TokenBucket({ maxTokens: 3, refillRate: 1 })

    await bucket.acquire()
    await bucket.acquire()
    await bucket.acquire()

    expect(bucket.availableTokens).toBe(0)
  })

  // ========================================================================
  // Waiting when depleted
  // ========================================================================

  it('queues callers when tokens are exhausted', async () => {
    const bucket = new TokenBucket({ maxTokens: 1, refillRate: 1 })

    // Use up the only token
    await bucket.acquire()
    expect(bucket.availableTokens).toBe(0)

    // This should not resolve immediately
    let resolved = false
    const promise = bucket.acquire().then(() => {
      resolved = true
    })

    // Give microtasks a chance to run
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toBe(false)
    expect(bucket.pendingCount).toBe(1)

    // Advance time so a token refills (1 token/sec => 1000ms for 1 token)
    await vi.advanceTimersByTimeAsync(1000)
    await promise

    expect(resolved).toBe(true)
    expect(bucket.pendingCount).toBe(0)
  })

  it('drains multiple waiters as tokens refill', async () => {
    const bucket = new TokenBucket({ maxTokens: 1, refillRate: 2 }) // 2 tokens/sec

    await bucket.acquire()

    const results: number[] = []

    const p1 = bucket.acquire().then(() => results.push(1))
    const p2 = bucket.acquire().then(() => results.push(2))

    expect(bucket.pendingCount).toBe(2)

    // At 2 tokens/sec, each token takes 500ms
    // First timer fires at 500ms, drains waiter 1, schedules next
    await vi.advanceTimersByTimeAsync(500)
    await Promise.resolve() // let microtasks run
    expect(results).toEqual([1])

    // Second timer fires at 1000ms total
    await vi.advanceTimersByTimeAsync(500)
    await Promise.resolve()
    expect(results).toEqual([1, 2])

    await Promise.all([p1, p2])
    expect(bucket.pendingCount).toBe(0)
  })

  // ========================================================================
  // Refill behavior
  // ========================================================================

  it('refills tokens over time', async () => {
    const bucket = new TokenBucket({ maxTokens: 10, refillRate: 5 })

    // Drain 5 tokens
    for (let i = 0; i < 5; i++) {
      await bucket.acquire()
    }
    expect(bucket.availableTokens).toBe(5)

    // Advance 1 second => 5 new tokens refilled
    vi.advanceTimersByTime(1000)
    expect(bucket.availableTokens).toBe(10)
  })

  it('does not exceed maxTokens on refill', async () => {
    const bucket = new TokenBucket({ maxTokens: 10, refillRate: 100 })

    // Even after a long time, tokens should not exceed max
    vi.advanceTimersByTime(10_000)
    expect(bucket.availableTokens).toBe(10)
  })

  // ========================================================================
  // penalize
  // ========================================================================

  it('penalize drains tokens to 0', () => {
    const bucket = new TokenBucket({ maxTokens: 10, refillRate: 5 })
    expect(bucket.availableTokens).toBe(10)

    bucket.penalize(5)
    expect(bucket.availableTokens).toBe(0)
  })

  it('penalize freezes token generation for the penalty period', () => {
    const bucket = new TokenBucket({ maxTokens: 10, refillRate: 10 })

    bucket.penalize(3) // 3 second penalty

    // After 2 seconds (still within penalty), no tokens should be available
    vi.advanceTimersByTime(2000)
    expect(bucket.availableTokens).toBe(0)

    // After 3 seconds total (penalty expired), refill should resume
    vi.advanceTimersByTime(1000)
    // Now tokens start refilling from 0 at 10/sec, but elapsed since penalty end is ~0
    expect(bucket.availableTokens).toBe(0)

    // After 4 seconds total (1 second of refill after penalty), 10 tokens
    vi.advanceTimersByTime(1000)
    expect(bucket.availableTokens).toBe(10)
  })

  // ========================================================================
  // DEFAULT_RATE_LIMIT_CONFIG
  // ========================================================================

  it('exports sensible defaults', () => {
    expect(DEFAULT_RATE_LIMIT_CONFIG.maxTokens).toBe(80)
    expect(DEFAULT_RATE_LIMIT_CONFIG.refillRate).toBe(1.5)
  })
})

// ===========================================================================
// extractRetryAfterMs
// ===========================================================================

describe('extractRetryAfterMs', () => {
  it('returns null for non-object errors', () => {
    expect(extractRetryAfterMs(null)).toBeNull()
    expect(extractRetryAfterMs(undefined)).toBeNull()
    expect(extractRetryAfterMs('string')).toBeNull()
    expect(extractRetryAfterMs(42)).toBeNull()
  })

  it('returns null for non-429 errors', () => {
    expect(extractRetryAfterMs({ status: 500 })).toBeNull()
    expect(extractRetryAfterMs({ statusCode: 400 })).toBeNull()
    expect(extractRetryAfterMs({ response: { status: 200 } })).toBeNull()
  })

  it('returns 60s default when 429 but no Retry-After header', () => {
    expect(extractRetryAfterMs({ status: 429 })).toBe(60_000)
  })

  it('parses Retry-After from response.headers plain object', () => {
    const error = {
      status: 429,
      response: {
        status: 429,
        headers: { 'retry-after': '30' },
      },
    }
    expect(extractRetryAfterMs(error)).toBe(30_000)
  })

  it('parses Retry-After from response.headers.get() (fetch-style)', () => {
    const headers = new Map([['retry-after', '45']])
    const error = {
      status: 429,
      response: {
        status: 429,
        headers: {
          get: (name: string) => headers.get(name) ?? null,
        },
      },
    }
    expect(extractRetryAfterMs(error)).toBe(45_000)
  })

  it('parses Retry-After from error.headers', () => {
    const error = {
      status: 429,
      headers: { 'retry-after': '10' },
    }
    expect(extractRetryAfterMs(error)).toBe(10_000)
  })

  it('detects 429 from response.status when top-level status is missing', () => {
    const error = {
      response: {
        status: 429,
        headers: { 'retry-after': '20' },
      },
    }
    expect(extractRetryAfterMs(error)).toBe(20_000)
  })

  it('detects 429 from statusCode property', () => {
    const error = {
      statusCode: 429,
      headers: { 'retry-after': '15' },
    }
    expect(extractRetryAfterMs(error)).toBe(15_000)
  })

  it('falls back to 60s for invalid Retry-After value', () => {
    const error = {
      status: 429,
      response: {
        status: 429,
        headers: { 'retry-after': 'not-a-number' },
      },
    }
    expect(extractRetryAfterMs(error)).toBe(60_000)
  })

  it('falls back to 60s for zero Retry-After', () => {
    const error = {
      status: 429,
      response: {
        status: 429,
        headers: { 'retry-after': '0' },
      },
    }
    expect(extractRetryAfterMs(error)).toBe(60_000)
  })
})
