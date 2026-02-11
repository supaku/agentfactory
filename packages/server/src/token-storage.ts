/**
 * OAuth Token Storage Module
 *
 * Manages Linear OAuth token lifecycle in Redis:
 * - Store, retrieve, refresh, and revoke tokens
 * - Automatic token refresh before expiration
 * - Multi-workspace token support
 */

import { createLogger } from './logger.js'
import { isRedisConfigured, redisSet, redisGet, redisDel, redisKeys } from './redis.js'

const log = createLogger('token-storage')

/**
 * OAuth token data stored in Redis
 */
export interface StoredToken {
  /** The OAuth access token for API calls */
  accessToken: string
  /** The refresh token for obtaining new access tokens */
  refreshToken?: string
  /** Token type (usually "Bearer") */
  tokenType: string
  /** OAuth scopes granted */
  scope?: string
  /** Unix timestamp when the token expires */
  expiresAt?: number
  /** Unix timestamp when the token was stored */
  storedAt: number
  /** Workspace/organization ID this token belongs to */
  workspaceId: string
  /** Workspace name for display purposes */
  workspaceName?: string
}

/**
 * Response from Linear OAuth token exchange
 */
export interface LinearTokenResponse {
  access_token: string
  refresh_token?: string
  token_type: string
  expires_in?: number
  scope?: string
}

/**
 * Organization info from Linear API
 */
export interface LinearOrganization {
  id: string
  name: string
  urlKey: string
}

/**
 * Key prefix for workspace tokens in KV
 */
const TOKEN_KEY_PREFIX = 'oauth:workspace:'

/**
 * Buffer time (in seconds) before expiration to trigger refresh
 * Refresh tokens 5 minutes before they expire
 */
const REFRESH_BUFFER_SECONDS = 5 * 60

/**
 * Build the KV key for a workspace token
 */
function buildTokenKey(workspaceId: string): string {
  return `${TOKEN_KEY_PREFIX}${workspaceId}`
}

/**
 * Store OAuth token for a workspace in Redis
 *
 * @param workspaceId - The Linear organization ID
 * @param tokenResponse - The token data from OAuth exchange
 * @param workspaceName - Optional workspace name for display
 */
export async function storeToken(
  workspaceId: string,
  tokenResponse: LinearTokenResponse,
  workspaceName?: string
): Promise<StoredToken> {
  const now = Math.floor(Date.now() / 1000)

  const storedToken: StoredToken = {
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token,
    tokenType: tokenResponse.token_type,
    scope: tokenResponse.scope,
    expiresAt: tokenResponse.expires_in
      ? now + tokenResponse.expires_in
      : undefined,
    storedAt: now,
    workspaceId,
    workspaceName,
  }

  const key = buildTokenKey(workspaceId)
  await redisSet(key, storedToken)

  log.info('Stored OAuth token', { workspaceId, workspaceName })

  return storedToken
}

/**
 * Retrieve OAuth token for a workspace from Redis
 *
 * @param workspaceId - The Linear organization ID
 * @returns The stored token or null if not found
 */
export async function getToken(workspaceId: string): Promise<StoredToken | null> {
  if (!isRedisConfigured()) {
    log.warn('Redis not configured, cannot retrieve token')
    return null
  }

  const key = buildTokenKey(workspaceId)
  const token = await redisGet<StoredToken>(key)

  return token
}

/**
 * Check if a token needs to be refreshed
 * Returns true if token expires within the buffer period
 *
 * @param token - The stored token to check
 * @returns Whether the token should be refreshed
 */
export function shouldRefreshToken(token: StoredToken): boolean {
  // No expiration means token doesn't expire (Linear API tokens typically don't)
  if (!token.expiresAt) {
    return false
  }

  const now = Math.floor(Date.now() / 1000)
  const timeUntilExpiry = token.expiresAt - now

  return timeUntilExpiry <= REFRESH_BUFFER_SECONDS
}

/**
 * Refresh an OAuth token using the refresh token
 *
 * @param token - The current stored token with refresh token
 * @param clientId - The Linear OAuth client ID
 * @param clientSecret - The Linear OAuth client secret
 * @returns The new stored token or null if refresh failed
 */
export async function refreshToken(
  token: StoredToken,
  clientId: string,
  clientSecret: string
): Promise<StoredToken | null> {
  const workspaceId = token.workspaceId

  if (!token.refreshToken) {
    log.warn('No refresh token available', { workspaceId })
    return null
  }

  try {
    const response = await fetch('https://api.linear.app/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: token.refreshToken,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      log.error('Token refresh failed', {
        workspaceId,
        statusCode: response.status,
        errorDetails: errorText,
      })
      return null
    }

    const tokenResponse = (await response.json()) as LinearTokenResponse

    // Store the new token
    const newToken = await storeToken(
      token.workspaceId,
      tokenResponse,
      token.workspaceName
    )

    log.info('Refreshed OAuth token', { workspaceId })

    return newToken
  } catch (err) {
    log.error('Token refresh error', { workspaceId, error: err })
    return null
  }
}

/**
 * Get a valid access token for a workspace, refreshing if necessary
 *
 * @param workspaceId - The Linear organization ID
 * @param clientId - Optional OAuth client ID for refresh (defaults to env var)
 * @param clientSecret - Optional OAuth client secret for refresh (defaults to env var)
 * @returns The access token or null if not available
 */
export async function getAccessToken(
  workspaceId: string,
  clientId?: string,
  clientSecret?: string
): Promise<string | null> {
  const token = await getToken(workspaceId)

  if (!token) {
    return null
  }

  // Check if token needs refresh
  if (shouldRefreshToken(token)) {
    const cid = clientId ?? process.env.LINEAR_CLIENT_ID
    const csecret = clientSecret ?? process.env.LINEAR_CLIENT_SECRET

    if (!cid || !csecret) {
      log.warn('OAuth credentials not configured, cannot refresh token', { workspaceId })
      // Return existing token even if it might be expiring soon
      return token.accessToken
    }

    const refreshedToken = await refreshToken(token, cid, csecret)

    if (refreshedToken) {
      return refreshedToken.accessToken
    }

    // Refresh failed, return existing token
    log.warn('Token refresh failed, using existing token', { workspaceId })
    return token.accessToken
  }

  return token.accessToken
}

/**
 * Delete a token from Redis (for cleanup or revocation)
 *
 * @param workspaceId - The Linear organization ID
 * @returns Whether the deletion was successful
 */
export async function deleteToken(workspaceId: string): Promise<boolean> {
  if (!isRedisConfigured()) {
    log.warn('Redis not configured, cannot delete token')
    return false
  }

  const key = buildTokenKey(workspaceId)
  const result = await redisDel(key)

  log.info('Deleted OAuth token', { workspaceId })

  return result > 0
}

/**
 * List all stored workspace tokens (for admin purposes)
 * Note: This scans all keys with the token prefix
 *
 * @returns Array of workspace IDs with stored tokens
 */
export async function listStoredWorkspaces(): Promise<string[]> {
  if (!isRedisConfigured()) {
    return []
  }

  const keys = await redisKeys(`${TOKEN_KEY_PREFIX}*`)

  return keys.map((key) => key.replace(TOKEN_KEY_PREFIX, ''))
}

/**
 * Clean up expired tokens from Redis storage
 * Should be called periodically (e.g., via cron job)
 *
 * @returns Number of tokens cleaned up
 */
export async function cleanupExpiredTokens(): Promise<number> {
  if (!isRedisConfigured()) {
    return 0
  }

  const workspaces = await listStoredWorkspaces()
  const now = Math.floor(Date.now() / 1000)
  let cleanedCount = 0

  for (const workspaceId of workspaces) {
    const token = await getToken(workspaceId)

    // Remove tokens that have expired (with some grace period)
    // We add 1 hour grace period to avoid removing tokens that might still be usable
    if (token?.expiresAt && token.expiresAt + 3600 < now) {
      await deleteToken(workspaceId)
      cleanedCount++
      log.info('Cleaned up expired token', { workspaceId })
    }
  }

  return cleanedCount
}

/**
 * Fetch the current user's organization from Linear API
 * Used after OAuth to determine which workspace the token belongs to
 *
 * @param accessToken - The OAuth access token
 * @returns Organization info or null if fetch failed
 */
export async function fetchOrganization(
  accessToken: string
): Promise<LinearOrganization | null> {
  try {
    const response = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        query: `
          query {
            organization {
              id
              name
              urlKey
            }
          }
        `,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      log.error('Failed to fetch organization', {
        statusCode: response.status,
        errorDetails: errorText,
      })
      return null
    }

    const data = (await response.json()) as {
      data?: { organization: LinearOrganization }
      errors?: unknown[]
    }

    if (data.errors) {
      log.error('GraphQL errors fetching organization', { errors: data.errors })
      return null
    }

    return data.data?.organization ?? null
  } catch (err) {
    log.error('Error fetching organization', { error: err })
    return null
  }
}
