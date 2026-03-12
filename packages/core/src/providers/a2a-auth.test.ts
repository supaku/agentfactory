import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  resolveA2aCredentials,
  buildA2aAuthHeaders,
  validateA2aAuth,
  type A2aAuthScheme,
  type A2aCredentials,
} from './a2a-auth.js'

// ---------------------------------------------------------------------------
// resolveA2aCredentials
// ---------------------------------------------------------------------------

describe('resolveA2aCredentials', () => {
  it('returns empty credentials when no env vars set', () => {
    const result = resolveA2aCredentials({})
    expect(result).toEqual({})
  })

  it('reads generic A2A_API_KEY', () => {
    const result = resolveA2aCredentials({ A2A_API_KEY: 'my-api-key' })
    expect(result.apiKey).toBe('my-api-key')
  })

  it('reads generic A2A_BEARER_TOKEN', () => {
    const result = resolveA2aCredentials({ A2A_BEARER_TOKEN: 'my-token' })
    expect(result.bearerToken).toBe('my-token')
  })

  it('reads both generic keys simultaneously', () => {
    const result = resolveA2aCredentials({
      A2A_API_KEY: 'key-1',
      A2A_BEARER_TOKEN: 'token-1',
    })
    expect(result.apiKey).toBe('key-1')
    expect(result.bearerToken).toBe('token-1')
  })

  it('reads host-specific keys when agentUrl provided', () => {
    const result = resolveA2aCredentials(
      { A2A_API_KEY_EXAMPLE_COM: 'host-key' },
      'https://example.com/agent',
    )
    expect(result.apiKey).toBe('host-key')
  })

  it('host-specific takes precedence over generic', () => {
    const result = resolveA2aCredentials(
      {
        A2A_API_KEY: 'generic-key',
        A2A_API_KEY_EXAMPLE_COM: 'host-key',
        A2A_BEARER_TOKEN: 'generic-token',
        A2A_BEARER_TOKEN_EXAMPLE_COM: 'host-token',
      },
      'https://example.com/agent',
    )
    expect(result.apiKey).toBe('host-key')
    expect(result.bearerToken).toBe('host-token')
  })

  it('falls back to generic when host-specific not set', () => {
    const result = resolveA2aCredentials(
      {
        A2A_API_KEY: 'generic-key',
        A2A_BEARER_TOKEN: 'generic-token',
      },
      'https://example.com/agent',
    )
    expect(result.apiKey).toBe('generic-key')
    expect(result.bearerToken).toBe('generic-token')
  })

  it('handles URLs with ports correctly (port is not in hostname)', () => {
    const result = resolveA2aCredentials(
      { A2A_API_KEY_LOCALHOST: 'local-key' },
      'http://localhost:8080/agent',
    )
    expect(result.apiKey).toBe('local-key')
  })

  it('handles hostnames with hyphens', () => {
    const result = resolveA2aCredentials(
      { A2A_API_KEY_SPRING_AGENT_EXAMPLE_COM: 'spring-key' },
      'http://spring-agent.example.com:8080/',
    )
    expect(result.apiKey).toBe('spring-key')
  })

  it('handles hostnames with multiple dots and hyphens', () => {
    const result = resolveA2aCredentials(
      { A2A_BEARER_TOKEN_MY_AGENT_US_EAST_1_EXAMPLE_IO: 'region-token' },
      'https://my-agent.us-east-1.example.io/a2a',
    )
    expect(result.bearerToken).toBe('region-token')
  })

  it('ignores invalid agentUrl and falls back to generic', () => {
    const result = resolveA2aCredentials(
      { A2A_API_KEY: 'generic-key' },
      'not-a-url',
    )
    expect(result.apiKey).toBe('generic-key')
  })

  it('returns empty when agentUrl is invalid and no generic keys', () => {
    const result = resolveA2aCredentials({}, 'not-a-url')
    expect(result).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// buildA2aAuthHeaders
// ---------------------------------------------------------------------------

describe('buildA2aAuthHeaders', () => {
  it('returns empty object when no credentials', () => {
    const result = buildA2aAuthHeaders({})
    expect(result).toEqual({})
  })

  it('sets bearer token in Authorization header (auto-detect)', () => {
    const result = buildA2aAuthHeaders({ bearerToken: 'my-token' })
    expect(result).toEqual({ Authorization: 'Bearer my-token' })
  })

  it('sets API key in x-api-key header (auto-detect)', () => {
    const result = buildA2aAuthHeaders({ apiKey: 'my-key' })
    expect(result).toEqual({ 'x-api-key': 'my-key' })
  })

  it('prefers bearer token over API key in auto-detect mode', () => {
    const result = buildA2aAuthHeaders({
      bearerToken: 'my-token',
      apiKey: 'my-key',
    })
    expect(result).toEqual({ Authorization: 'Bearer my-token' })
  })

  it('respects apiKey auth scheme with custom header name', () => {
    const schemes: A2aAuthScheme[] = [
      { type: 'apiKey', in: 'header', name: 'X-Custom-Key' },
    ]
    const result = buildA2aAuthHeaders({ apiKey: 'my-key' }, schemes)
    expect(result).toEqual({ 'X-Custom-Key': 'my-key' })
  })

  it('uses default x-api-key header when scheme has no name', () => {
    const schemes: A2aAuthScheme[] = [
      { type: 'apiKey', in: 'header' },
    ]
    const result = buildA2aAuthHeaders({ apiKey: 'my-key' }, schemes)
    expect(result).toEqual({ 'x-api-key': 'my-key' })
  })

  it('respects http bearer auth scheme', () => {
    const schemes: A2aAuthScheme[] = [
      { type: 'http', scheme: 'bearer' },
    ]
    const result = buildA2aAuthHeaders({ bearerToken: 'my-token' }, schemes)
    expect(result).toEqual({ Authorization: 'Bearer my-token' })
  })

  it('returns empty when scheme requires apiKey but only bearerToken provided', () => {
    const schemes: A2aAuthScheme[] = [
      { type: 'apiKey', in: 'header', name: 'x-api-key' },
    ]
    const result = buildA2aAuthHeaders({ bearerToken: 'my-token' }, schemes)
    expect(result).toEqual({})
  })

  it('returns empty when scheme requires bearer but only apiKey provided', () => {
    const schemes: A2aAuthScheme[] = [
      { type: 'http', scheme: 'bearer' },
    ]
    const result = buildA2aAuthHeaders({ apiKey: 'my-key' }, schemes)
    expect(result).toEqual({})
  })

  it('matches first compatible scheme when multiple provided', () => {
    const schemes: A2aAuthScheme[] = [
      { type: 'http', scheme: 'bearer' },
      { type: 'apiKey', in: 'header', name: 'x-api-key' },
    ]
    const creds: A2aCredentials = { bearerToken: 'my-token', apiKey: 'my-key' }
    const result = buildA2aAuthHeaders(creds, schemes)
    // First scheme (bearer) should match
    expect(result).toEqual({ Authorization: 'Bearer my-token' })
  })

  it('falls to second scheme when first does not match', () => {
    const schemes: A2aAuthScheme[] = [
      { type: 'http', scheme: 'bearer' },
      { type: 'apiKey', in: 'header', name: 'x-api-key' },
    ]
    const creds: A2aCredentials = { apiKey: 'my-key' }
    const result = buildA2aAuthHeaders(creds, schemes)
    // Only apiKey scheme matches
    expect(result).toEqual({ 'x-api-key': 'my-key' })
  })

  it('returns empty when auth schemes array is empty (treated as no schemes)', () => {
    const result = buildA2aAuthHeaders({ apiKey: 'my-key' }, [])
    // Empty array means no schemes -> auto-detect
    expect(result).toEqual({ 'x-api-key': 'my-key' })
  })

  it('ignores unsupported oauth2 scheme and returns empty', () => {
    const schemes: A2aAuthScheme[] = [
      { type: 'oauth2' },
    ]
    const result = buildA2aAuthHeaders({ bearerToken: 'my-token' }, schemes)
    expect(result).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// validateA2aAuth
// ---------------------------------------------------------------------------

describe('validateA2aAuth', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    // Clear relevant env vars
    delete process.env.A2A_SERVER_API_KEY
    delete process.env.WORKER_API_KEY
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('returns false when no auth header provided', () => {
    expect(validateA2aAuth(undefined, { apiKey: 'expected' })).toBe(false)
  })

  it('returns false when no expected key configured', () => {
    expect(validateA2aAuth('Bearer some-token')).toBe(false)
  })

  it('returns true for matching bearer token', () => {
    const result = validateA2aAuth('Bearer secret-key', { apiKey: 'secret-key' })
    expect(result).toBe(true)
  })

  it('returns true for matching raw API key (no Bearer prefix)', () => {
    const result = validateA2aAuth('secret-key', { apiKey: 'secret-key' })
    expect(result).toBe(true)
  })

  it('returns false for mismatched key (timing-safe)', () => {
    const result = validateA2aAuth('Bearer wrong-key', { apiKey: 'correct-key' })
    expect(result).toBe(false)
  })

  it('returns false for mismatched key of different length', () => {
    const result = validateA2aAuth('Bearer short', { apiKey: 'a-much-longer-key' })
    expect(result).toBe(false)
  })

  it('resolves expected key from A2A_SERVER_API_KEY env var', () => {
    process.env.A2A_SERVER_API_KEY = 'env-key'
    const result = validateA2aAuth('Bearer env-key')
    expect(result).toBe(true)
  })

  it('falls back to WORKER_API_KEY env var', () => {
    process.env.WORKER_API_KEY = 'worker-key'
    const result = validateA2aAuth('Bearer worker-key')
    expect(result).toBe(true)
  })

  it('A2A_SERVER_API_KEY takes precedence over WORKER_API_KEY', () => {
    process.env.A2A_SERVER_API_KEY = 'a2a-key'
    process.env.WORKER_API_KEY = 'worker-key'
    expect(validateA2aAuth('Bearer a2a-key')).toBe(true)
    expect(validateA2aAuth('Bearer worker-key')).toBe(false)
  })

  it('uses custom env var name from config', () => {
    process.env.MY_CUSTOM_KEY = 'custom-value'
    const result = validateA2aAuth('Bearer custom-value', {
      apiKeyEnvVar: 'MY_CUSTOM_KEY',
    })
    expect(result).toBe(true)

    // Clean up
    delete process.env.MY_CUSTOM_KEY
  })

  it('explicit apiKey in config takes precedence over env vars', () => {
    process.env.A2A_SERVER_API_KEY = 'env-key'
    const result = validateA2aAuth('Bearer explicit-key', { apiKey: 'explicit-key' })
    expect(result).toBe(true)
  })

  it('returns false for empty auth header string', () => {
    // extractToken with "Bearer " prefix but nothing after gives empty string
    // but "" still gets compared — and empty provided vs non-empty expected -> false
    expect(validateA2aAuth('', { apiKey: 'expected' })).toBe(false)
  })
})
