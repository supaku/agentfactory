/**
 * Worker Authentication Module
 *
 * Framework-agnostic API key verification for worker endpoints.
 * Workers must include a valid API key in the Authorization header.
 */

import crypto from 'crypto'

/**
 * Extract a Bearer token from an Authorization header value
 *
 * @param authHeader - The Authorization header value
 * @returns The bearer token or null if not a valid Bearer header
 */
export function extractBearerToken(authHeader: string | null | undefined): string | null {
  if (!authHeader?.startsWith('Bearer ')) {
    return null
  }
  return authHeader.slice(7)
}

/**
 * Verify an API key against the expected key using timing-safe comparison
 *
 * @param providedKey - The API key from the request
 * @param expectedKey - The expected API key (defaults to WORKER_API_KEY env var)
 * @returns true if the key is valid
 */
export function verifyApiKey(
  providedKey: string,
  expectedKey?: string
): boolean {
  const expected = expectedKey ?? process.env.WORKER_API_KEY

  if (!expected) {
    return false
  }

  // Use timing-safe comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(providedKey),
      Buffer.from(expected)
    )
  } catch {
    // Buffers have different lengths
    return false
  }
}

/**
 * Check if worker auth is configured
 * (useful for development/testing where auth might be disabled)
 *
 * @param envVar - Environment variable name to check (default: WORKER_API_KEY)
 */
export function isWorkerAuthConfigured(envVar = 'WORKER_API_KEY'): boolean {
  return !!process.env[envVar]
}
