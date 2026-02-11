/**
 * Session Hash Utility
 *
 * Creates opaque, non-reversible session IDs for public API.
 * Internal session IDs (Linear UUIDs) are hashed to prevent enumeration
 * and hide internal structure from public viewers.
 */

import crypto from 'crypto'
import { getSessionHashSalt, isSessionHashConfigured } from './env-validation.js'

/**
 * Create a public hash from a session ID
 *
 * Uses HMAC-SHA256 with a secret salt to create a consistent
 * but non-reversible public identifier.
 *
 * @param sessionId - Internal Linear session ID
 * @param saltEnvVar - Environment variable name for the salt (default: SESSION_HASH_SALT)
 * @returns Hashed public ID (16 character hex string)
 */
export function hashSessionId(sessionId: string, saltEnvVar?: string): string {
  if (!isSessionHashConfigured()) {
    // In development without salt, use truncated hash
    // This is less secure but allows development without full config
    return crypto
      .createHash('sha256')
      .update(sessionId)
      .digest('hex')
      .slice(0, 16)
  }

  const salt = getSessionHashSalt(saltEnvVar)
  const hmac = crypto.createHmac('sha256', salt)
  hmac.update(sessionId)

  // Return first 16 characters for a reasonably short but unique ID
  return hmac.digest('hex').slice(0, 16)
}

/**
 * Create a lookup map from session IDs to their hashes
 *
 * Useful for resolving hashed IDs back to sessions when
 * you have the full list of sessions.
 *
 * @param sessionIds - Array of internal session IDs
 * @returns Map of hash -> sessionId
 */
export function createHashLookup(sessionIds: string[]): Map<string, string> {
  const lookup = new Map<string, string>()
  for (const id of sessionIds) {
    lookup.set(hashSessionId(id), id)
  }
  return lookup
}

/**
 * Find session ID by its public hash
 *
 * Since hashing is one-way, we need to hash all session IDs
 * and compare. This is O(n) but acceptable for the expected
 * number of sessions (typically < 100).
 *
 * @param publicId - Hashed public ID
 * @param sessionIds - Array of internal session IDs to search
 * @returns Matching session ID or null
 */
export function findSessionByHash(
  publicId: string,
  sessionIds: string[]
): string | null {
  for (const id of sessionIds) {
    if (hashSessionId(id) === publicId) {
      return id
    }
  }
  return null
}

/**
 * Validate a public session ID format
 *
 * @param publicId - Potential public session ID
 * @returns Whether the format is valid
 */
export function isValidPublicId(publicId: string): boolean {
  // Should be 16 character hex string
  return /^[a-f0-9]{16}$/.test(publicId)
}
