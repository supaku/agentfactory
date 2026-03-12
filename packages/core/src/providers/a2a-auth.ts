/**
 * A2A Authentication Utilities
 *
 * Client-side: resolve credentials from env vars and build HTTP auth headers
 * for outbound requests to remote A2A agents.
 *
 * Server-side: validate inbound A2A request auth using timing-safe comparison,
 * following the same pattern as worker-auth.ts.
 */

import crypto from 'crypto'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Auth scheme as declared in an A2A AgentCard */
export interface A2aAuthScheme {
  type: 'apiKey' | 'http' | 'oauth2'
  /** For http: e.g. 'bearer' */
  scheme?: string
  /** For apiKey: 'header' | 'query' */
  in?: string
  /** For apiKey: header/query param name */
  name?: string
}

/** Resolved credentials for a remote A2A agent */
export interface A2aCredentials {
  apiKey?: string
  bearerToken?: string
}

/** Configuration for validating incoming A2A requests */
export interface A2aAuthConfig {
  /** API key for validating incoming requests */
  apiKey?: string
  /** Env var name for the API key (default: A2A_SERVER_API_KEY, fallback: WORKER_API_KEY) */
  apiKeyEnvVar?: string
}

// ---------------------------------------------------------------------------
// Client-side: credential resolution
// ---------------------------------------------------------------------------

/**
 * Normalise a hostname into an env-var suffix.
 *
 * - Uppercases
 * - Replaces dots and hyphens with underscores
 *
 * Example: "spring-agent.example.com" -> "SPRING_AGENT_EXAMPLE_COM"
 */
function hostnameToEnvSuffix(hostname: string): string {
  return hostname.toUpperCase().replace(/[.\-]/g, '_')
}

/**
 * Resolve credentials from environment variables for outbound A2A requests.
 *
 * Resolution order:
 * 1. If agentUrl is provided, try host-specific env vars first:
 *    - A2A_API_KEY_{HOSTNAME}
 *    - A2A_BEARER_TOKEN_{HOSTNAME}
 * 2. Fall back to generic env vars:
 *    - A2A_API_KEY
 *    - A2A_BEARER_TOKEN
 *
 * @param env - Environment variable map (e.g. process.env)
 * @param agentUrl - Optional URL of the remote agent for host-specific lookup
 * @returns Resolved credentials (may be empty if no env vars are set)
 */
export function resolveA2aCredentials(
  env: Record<string, string | undefined>,
  agentUrl?: string,
): A2aCredentials {
  const creds: A2aCredentials = {}

  let hostSuffix: string | undefined
  if (agentUrl) {
    try {
      const url = new URL(agentUrl)
      hostSuffix = hostnameToEnvSuffix(url.hostname)
    } catch {
      // Invalid URL — skip host-specific lookup
    }
  }

  // Resolve API key: host-specific first, then generic
  if (hostSuffix) {
    const hostKey = env[`A2A_API_KEY_${hostSuffix}`]
    if (hostKey) {
      creds.apiKey = hostKey
    }
  }
  if (!creds.apiKey) {
    const genericKey = env['A2A_API_KEY']
    if (genericKey) {
      creds.apiKey = genericKey
    }
  }

  // Resolve bearer token: host-specific first, then generic
  if (hostSuffix) {
    const hostToken = env[`A2A_BEARER_TOKEN_${hostSuffix}`]
    if (hostToken) {
      creds.bearerToken = hostToken
    }
  }
  if (!creds.bearerToken) {
    const genericToken = env['A2A_BEARER_TOKEN']
    if (genericToken) {
      creds.bearerToken = genericToken
    }
  }

  return creds
}

// ---------------------------------------------------------------------------
// Client-side: auth header construction
// ---------------------------------------------------------------------------

/**
 * Build HTTP headers for authenticating an outbound A2A request.
 *
 * When auth schemes are provided (from the remote agent's AgentCard), the
 * function matches credentials to the first compatible scheme:
 * - apiKey scheme  -> sets header {scheme.name}: {key}  (default: x-api-key)
 * - http + bearer  -> sets Authorization: Bearer {token}
 *
 * When no auth schemes are provided, auto-detection is used:
 * - bearerToken -> Authorization: Bearer {token}
 * - apiKey      -> x-api-key: {key}
 *
 * @param credentials - Resolved credentials
 * @param authSchemes - Optional auth schemes from the remote agent's card
 * @returns Headers object (may be empty)
 */
export function buildA2aAuthHeaders(
  credentials: A2aCredentials,
  authSchemes?: A2aAuthScheme[],
): Record<string, string> {
  const headers: Record<string, string> = {}

  if (authSchemes && authSchemes.length > 0) {
    // Match credentials to declared auth schemes
    for (const scheme of authSchemes) {
      if (scheme.type === 'apiKey' && credentials.apiKey) {
        const headerName = scheme.name || 'x-api-key'
        headers[headerName] = credentials.apiKey
        return headers
      }

      if (scheme.type === 'http' && scheme.scheme === 'bearer' && credentials.bearerToken) {
        headers['Authorization'] = `Bearer ${credentials.bearerToken}`
        return headers
      }
    }

    // No scheme matched — return empty
    return headers
  }

  // Auto-detect: no auth schemes provided
  if (credentials.bearerToken) {
    headers['Authorization'] = `Bearer ${credentials.bearerToken}`
  } else if (credentials.apiKey) {
    headers['x-api-key'] = credentials.apiKey
  }

  return headers
}

// ---------------------------------------------------------------------------
// Server-side: inbound request validation
// ---------------------------------------------------------------------------

/**
 * Extract a bearer token or raw key from an Authorization header.
 *
 * Supports:
 * - "Bearer <token>" -> returns the token
 * - Raw value (no prefix) -> returns the value as-is
 */
function extractToken(authHeader: string): string {
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7)
  }
  return authHeader
}

/**
 * Validate an incoming A2A request's auth header using timing-safe comparison.
 *
 * Resolution of expected key:
 * 1. config.apiKey (explicit value)
 * 2. env var named by config.apiKeyEnvVar
 * 3. A2A_SERVER_API_KEY env var
 * 4. WORKER_API_KEY env var (fallback for backward compat)
 *
 * If no expected key is configured, returns false (fail closed).
 *
 * @param authHeader - The Authorization header value from the request
 * @param config - Optional auth configuration
 * @returns true if the auth is valid
 */
export function validateA2aAuth(
  authHeader: string | undefined,
  config?: A2aAuthConfig,
): boolean {
  if (!authHeader) {
    return false
  }

  const providedKey = extractToken(authHeader)
  if (!providedKey) {
    return false
  }

  // Resolve expected key
  let expectedKey: string | undefined

  if (config?.apiKey) {
    expectedKey = config.apiKey
  } else if (config?.apiKeyEnvVar) {
    expectedKey = process.env[config.apiKeyEnvVar]
  } else {
    // Default env var resolution chain
    expectedKey = process.env.A2A_SERVER_API_KEY ?? process.env.WORKER_API_KEY
  }

  if (!expectedKey) {
    return false
  }

  // Use timing-safe comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(providedKey),
      Buffer.from(expectedKey),
    )
  } catch {
    // Buffers have different lengths
    return false
  }
}
