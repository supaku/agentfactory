import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  extractBearerToken,
  verifyApiKey,
  isWorkerAuthConfigured,
} from './worker-auth.js'

describe('extractBearerToken', () => {
  it('returns token from "Bearer xyz"', () => {
    expect(extractBearerToken('Bearer xyz')).toBe('xyz')
  })

  it('returns null for null', () => {
    expect(extractBearerToken(null)).toBeNull()
  })

  it('returns null for undefined', () => {
    expect(extractBearerToken(undefined)).toBeNull()
  })

  it('returns null for non-Bearer header', () => {
    expect(extractBearerToken('Basic abc')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(extractBearerToken('')).toBeNull()
  })

  it('returns empty string for "Bearer " (trailing space only)', () => {
    expect(extractBearerToken('Bearer ')).toBe('')
  })
})

describe('verifyApiKey', () => {
  const savedWorkerApiKey = process.env.WORKER_API_KEY

  afterEach(() => {
    if (savedWorkerApiKey === undefined) {
      delete process.env.WORKER_API_KEY
    } else {
      process.env.WORKER_API_KEY = savedWorkerApiKey
    }
  })

  it('returns true for matching keys', () => {
    expect(verifyApiKey('my-secret-key', 'my-secret-key')).toBe(true)
  })

  it('returns false for non-matching keys', () => {
    expect(verifyApiKey('wrong-key', 'my-secret-key')).toBe(false)
  })

  it('returns false when no expected key is available', () => {
    delete process.env.WORKER_API_KEY
    expect(verifyApiKey('any-key')).toBe(false)
  })

  it('returns false for different-length keys', () => {
    expect(verifyApiKey('short', 'much-longer-key')).toBe(false)
  })

  it('uses explicit expectedKey parameter over env var', () => {
    process.env.WORKER_API_KEY = 'env-key'
    expect(verifyApiKey('explicit-key', 'explicit-key')).toBe(true)
    expect(verifyApiKey('env-key', 'explicit-key')).toBe(false)
  })
})

describe('isWorkerAuthConfigured', () => {
  const savedWorkerApiKey = process.env.WORKER_API_KEY

  afterEach(() => {
    if (savedWorkerApiKey === undefined) {
      delete process.env.WORKER_API_KEY
    } else {
      process.env.WORKER_API_KEY = savedWorkerApiKey
    }
  })

  it('returns false when env var is not set', () => {
    delete process.env.WORKER_API_KEY
    expect(isWorkerAuthConfigured()).toBe(false)
  })

  it('returns true when WORKER_API_KEY is set', () => {
    process.env.WORKER_API_KEY = 'some-key'
    expect(isWorkerAuthConfigured()).toBe(true)
  })

  it('checks custom env var name', () => {
    delete process.env.WORKER_API_KEY
    process.env.CUSTOM_AUTH_KEY = 'custom-value'
    expect(isWorkerAuthConfigured('CUSTOM_AUTH_KEY')).toBe(true)
    delete process.env.CUSTOM_AUTH_KEY
  })
})
