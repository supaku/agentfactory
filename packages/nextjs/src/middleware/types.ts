/**
 * Types for the middleware factory.
 */

/**
 * Configuration for the AgentFactory middleware.
 */
export interface MiddlewareConfig {
  /** Route path configuration */
  routes?: {
    /** Public routes - no auth, with rate limiting (default: ['/api/public/', '/dashboard', '/']) */
    public?: string[]
    /** Protected routes - require WORKER_API_KEY (default: ['/api/sessions', '/api/workers']) */
    protected?: string[]
    /** Session detail pages - allow public access (default: ['/sessions/']) */
    sessionPages?: string[]
    /** Webhook route (default: '/webhook') */
    webhook?: string
    /** Routes with custom auth in handler (default: ['/api/cleanup']) */
    passthrough?: string[]
  }
  /** Rate limit configurations */
  rateLimits?: {
    /** Public endpoint rate limit (default: 60/min) */
    public?: { max: number; windowMs: number }
    /** Webhook endpoint rate limit (default: 10/sec) */
    webhook?: { max: number; windowMs: number }
  }
}
