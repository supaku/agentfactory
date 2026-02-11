/**
 * Middleware Factory
 *
 * Creates a Next.js middleware function that handles authentication,
 * rate limiting, and security for AgentFactory API routes.
 *
 * Uses the rate limiter and worker auth from @supaku/agentfactory-server
 * for proper LRU eviction and crypto.timingSafeEqual.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  checkRateLimit,
  getClientIP,
  buildRateLimitHeaders,
  verifyApiKey,
} from '@supaku/agentfactory-server'
import type { MiddlewareConfig } from './types.js'

const DEFAULT_PUBLIC_ROUTES = ['/api/public/', '/dashboard', '/']
const DEFAULT_PROTECTED_ROUTES = ['/api/sessions', '/api/workers']
const DEFAULT_SESSION_PAGES = ['/sessions/']
const DEFAULT_WEBHOOK_ROUTE = '/webhook'
const DEFAULT_PASSTHROUGH_ROUTES = ['/api/cleanup']

/**
 * Create an AgentFactory middleware function with configurable routes
 * and rate limiting.
 *
 * @example
 * ```typescript
 * // In middleware.ts:
 * import { createAgentFactoryMiddleware } from '@supaku/agentfactory-nextjs'
 *
 * const { middleware, matcherConfig } = createAgentFactoryMiddleware()
 * export { middleware }
 * export const config = matcherConfig
 * ```
 */
export function createAgentFactoryMiddleware(userConfig?: MiddlewareConfig) {
  const publicRoutes = userConfig?.routes?.public ?? DEFAULT_PUBLIC_ROUTES
  const protectedRoutes = userConfig?.routes?.protected ?? DEFAULT_PROTECTED_ROUTES
  const sessionPages = userConfig?.routes?.sessionPages ?? DEFAULT_SESSION_PAGES
  const webhookRoute = userConfig?.routes?.webhook ?? DEFAULT_WEBHOOK_ROUTE
  const passthroughRoutes = userConfig?.routes?.passthrough ?? DEFAULT_PASSTHROUGH_ROUTES

  function middleware(request: NextRequest): NextResponse | undefined {
    const { pathname } = request.nextUrl
    const clientIP = getClientIP(request.headers)

    // === PUBLIC ROUTES ===
    if (publicRoutes.some(route => pathname === route || pathname.startsWith(route))) {
      const result = checkRateLimit('public', clientIP)

      if (!result.allowed) {
        return new NextResponse(
          JSON.stringify({ error: 'Too many requests' }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              ...buildRateLimitHeaders(result),
            },
          }
        )
      }

      const response = NextResponse.next()
      const rateLimitHeaders = buildRateLimitHeaders(result)
      for (const [key, value] of Object.entries(rateLimitHeaders)) {
        response.headers.set(key, value)
      }
      return response
    }

    // === SESSION DETAIL PAGES ===
    if (sessionPages.some(route => pathname.startsWith(route))) {
      return NextResponse.next()
    }

    // === WEBHOOK ROUTE ===
    if (pathname === webhookRoute) {
      const result = checkRateLimit('webhook', clientIP)

      if (!result.allowed) {
        return new NextResponse(
          JSON.stringify({ error: 'Too many requests' }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              ...buildRateLimitHeaders(result),
            },
          }
        )
      }

      return NextResponse.next()
    }

    // === PROTECTED INTERNAL APIS ===
    if (protectedRoutes.some(route => pathname.startsWith(route))) {
      const workerApiKey = process.env.WORKER_API_KEY

      // In development without key, allow access
      if (!workerApiKey && process.env.NODE_ENV !== 'production') {
        return NextResponse.next()
      }

      if (!workerApiKey) {
        console.error('WORKER_API_KEY not configured - blocking protected API access')
        return new NextResponse(
          JSON.stringify({ error: 'Unauthorized', message: 'Invalid or missing API key' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        )
      }

      const authHeader = request.headers.get('authorization')
      if (!authHeader?.startsWith('Bearer ')) {
        return new NextResponse(
          JSON.stringify({ error: 'Unauthorized', message: 'Invalid or missing API key' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        )
      }

      const token = authHeader.slice(7)
      if (!verifyApiKey(token, workerApiKey)) {
        return new NextResponse(
          JSON.stringify({ error: 'Unauthorized', message: 'Invalid or missing API key' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        )
      }

      return NextResponse.next()
    }

    // === PASSTHROUGH ROUTES ===
    if (passthroughRoutes.some(route => pathname === route || pathname.startsWith(route))) {
      return NextResponse.next()
    }

    // === ALL OTHER ROUTES ===
    return NextResponse.next()
  }

  const matcherConfig = {
    matcher: [
      '/api/:path*',
      webhookRoute,
      '/dashboard',
      '/sessions/:path*',
      '/',
    ],
  }

  return { middleware, matcherConfig }
}
