/**
 * Token Bucket Rate Limiter
 *
 * Proactive rate limiting for Linear API calls. Uses a token bucket algorithm
 * to throttle requests below Linear's ~100 req/min limit.
 *
 * Default: 80 burst capacity, 1.5 tokens/sec refill (~90 req/min sustained).
 */

export interface TokenBucketConfig {
  /** Maximum tokens (burst capacity). Default: 80 */
  maxTokens: number
  /** Tokens added per second. Default: 1.5 (~90/min) */
  refillRate: number
}

export const DEFAULT_RATE_LIMIT_CONFIG: TokenBucketConfig = {
  maxTokens: 80,
  refillRate: 1.5,
}

export class TokenBucket {
  private tokens: number
  private readonly maxTokens: number
  private readonly refillRate: number
  private lastRefill: number
  private waitQueue: Array<() => void> = []

  constructor(config: Partial<TokenBucketConfig> = {}) {
    const resolved = { ...DEFAULT_RATE_LIMIT_CONFIG, ...config }
    this.maxTokens = resolved.maxTokens
    this.refillRate = resolved.refillRate
    this.tokens = this.maxTokens
    this.lastRefill = Date.now()
  }

  /** Refill tokens based on elapsed time since last refill. */
  private refill(): void {
    const now = Date.now()
    const elapsed = (now - this.lastRefill) / 1000

    // During a penalty period, lastRefill is in the future so elapsed is negative.
    // Skip refill entirely until the penalty expires.
    if (elapsed <= 0) return

    const newTokens = elapsed * this.refillRate
    this.tokens = Math.min(this.maxTokens, this.tokens + newTokens)
    this.lastRefill = now
  }

  /** Drain waiters that can be satisfied after a refill. */
  private drainWaiters(): void {
    while (this.waitQueue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1
      const resolve = this.waitQueue.shift()!
      resolve()
    }
  }

  /**
   * Acquire a single token. Resolves immediately if tokens are available,
   * otherwise queues the caller until a token becomes available via refill.
   */
  async acquire(): Promise<void> {
    this.refill()

    if (this.tokens >= 1 && this.waitQueue.length === 0) {
      this.tokens -= 1
      return
    }

    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve)
      this.scheduleRefillDrain()
    })
  }

  /** Schedule a timer to refill and drain waiters. */
  private refillTimer: ReturnType<typeof setTimeout> | null = null

  private scheduleRefillDrain(): void {
    if (this.refillTimer !== null) return

    // Time until 1 token is available
    const msPerToken = 1000 / this.refillRate
    this.refillTimer = setTimeout(() => {
      this.refillTimer = null
      this.refill()
      this.drainWaiters()

      // If there are still waiters, schedule again
      if (this.waitQueue.length > 0) {
        this.scheduleRefillDrain()
      }
    }, msPerToken)
  }

  /**
   * Penalize the bucket after receiving a 429 rate limit response.
   *
   * Drains all tokens to 0 and shifts the refill baseline forward by
   * `seconds` so no new tokens appear until the penalty expires.
   * Any already-queued waiters will wait for the penalty period plus
   * normal refill time.
   *
   * @param seconds - How long to pause before tokens start refilling (from Retry-After header)
   */
  penalize(seconds: number): void {
    this.tokens = 0
    // Push lastRefill into the future so refill() computes negative elapsed
    // time until the penalty expires, effectively freezing token generation.
    this.lastRefill = Date.now() + seconds * 1000
  }

  /** Current number of available tokens (for testing/monitoring). */
  get availableTokens(): number {
    this.refill()
    return Math.floor(this.tokens)
  }

  /** Number of callers waiting for tokens (for testing/monitoring). */
  get pendingCount(): number {
    return this.waitQueue.length
  }
}

/**
 * Extract a Retry-After delay (in milliseconds) from an error thrown by
 * the Linear SDK or a raw HTTP 429 response.
 *
 * Checks (in order):
 * 1. `error.response.headers.get('retry-after')` (fetch Response)
 * 2. `error.response.headers['retry-after']` (plain object headers)
 * 3. `error.headers?.['retry-after']` (error-level headers)
 *
 * The Retry-After value is parsed as seconds (integer). If no valid value
 * is found, returns `null`.
 */
export function extractRetryAfterMs(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null

  const err = error as Record<string, unknown>

  // Check if this is a rate limit error (status 429)
  const status =
    (err.status as number) ??
    (err.statusCode as number) ??
    ((err.response as Record<string, unknown> | undefined)?.status as number)

  if (status !== 429) return null

  // Try to extract Retry-After from various locations
  const headerValue = getRetryAfterHeader(err)
  if (headerValue === null) {
    // No Retry-After header — use a sensible default of 60s for Linear
    return 60_000
  }

  const seconds = parseInt(headerValue, 10)
  if (Number.isNaN(seconds) || seconds <= 0) return 60_000

  return seconds * 1000
}

function getRetryAfterHeader(err: Record<string, unknown>): string | null {
  // error.response.headers.get('retry-after') — fetch-style Response
  const response = err.response as Record<string, unknown> | undefined
  if (response) {
    const headers = response.headers as Record<string, unknown> | undefined
    if (headers) {
      // Headers object with .get() method (fetch API)
      if (typeof (headers as { get?: unknown }).get === 'function') {
        const val = (headers as { get: (name: string) => string | null }).get('retry-after')
        if (val) return val
      }
      // Plain object headers
      const val = headers['retry-after'] as string | undefined
      if (val) return val
    }
  }

  // error.headers['retry-after']
  const errorHeaders = err.headers as Record<string, unknown> | undefined
  if (errorHeaders) {
    const val = errorHeaders['retry-after'] as string | undefined
    if (val) return val
  }

  return null
}
