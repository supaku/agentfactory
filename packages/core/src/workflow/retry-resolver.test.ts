import { describe, it, expect } from 'vitest'
import { resolveRetryConfig, resolveTimeoutConfig } from './retry-resolver.js'
import type { TemplateRetryConfig, TemplateTimeoutConfig, EscalationConfig } from './workflow-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const globalEscalation: EscalationConfig = {
  ladder: [
    { cycle: 1, strategy: 'normal' },
    { cycle: 2, strategy: 'context-enriched' },
    { cycle: 3, strategy: 'decompose' },
    { cycle: 4, strategy: 'escalate-human' },
  ],
  circuitBreaker: {
    maxSessionsPerIssue: 8,
    maxSessionsPerPhase: 5,
  },
}

// ---------------------------------------------------------------------------
// resolveRetryConfig
// ---------------------------------------------------------------------------

describe('resolveRetryConfig', () => {
  it('template retry overrides phase retry', () => {
    const templateRetry: TemplateRetryConfig = {
      maxAttempts: 2,
      ladder: [{ cycle: 1, strategy: 'normal' }],
    }
    const phaseRetry: TemplateRetryConfig = {
      maxAttempts: 4,
      ladder: [
        { cycle: 1, strategy: 'normal' },
        { cycle: 2, strategy: 'decompose' },
      ],
    }

    const result = resolveRetryConfig(templateRetry, phaseRetry, globalEscalation)

    expect(result.maxAttempts).toBe(2)
    expect(result.ladder).toEqual([{ cycle: 1, strategy: 'normal' }])
  })

  it('phase retry overrides global escalation', () => {
    const phaseRetry: TemplateRetryConfig = {
      maxAttempts: 4,
      ladder: [
        { cycle: 1, strategy: 'normal' },
        { cycle: 3, strategy: 'escalate-human' },
      ],
    }

    const result = resolveRetryConfig(undefined, phaseRetry, globalEscalation)

    expect(result.maxAttempts).toBe(4)
    expect(result.ladder).toEqual([
      { cycle: 1, strategy: 'normal' },
      { cycle: 3, strategy: 'escalate-human' },
    ])
  })

  it('global escalation used as fallback when no overrides', () => {
    const result = resolveRetryConfig(undefined, undefined, globalEscalation)

    // maxAttempts falls back to circuitBreaker.maxSessionsPerPhase
    expect(result.maxAttempts).toBe(5)
    expect(result.ladder).toEqual(globalEscalation.ladder)
  })

  it('uses defaults when nothing is configured', () => {
    const result = resolveRetryConfig(undefined, undefined, undefined)

    expect(result.maxAttempts).toBe(3)
    expect(result.ladder).toEqual([
      { cycle: 1, strategy: 'normal' },
      { cycle: 2, strategy: 'context-enriched' },
      { cycle: 3, strategy: 'decompose' },
    ])
  })

  it('partial override: only maxAttempts overridden at template level', () => {
    const templateRetry: TemplateRetryConfig = { maxAttempts: 1 }
    const phaseRetry: TemplateRetryConfig = {
      maxAttempts: 4,
      ladder: [{ cycle: 1, strategy: 'decompose' }],
    }

    const result = resolveRetryConfig(templateRetry, phaseRetry, globalEscalation)

    // maxAttempts from template, ladder from phase (template has none)
    expect(result.maxAttempts).toBe(1)
    expect(result.ladder).toEqual([{ cycle: 1, strategy: 'decompose' }])
  })

  it('partial override: only ladder overridden at template level', () => {
    const templateRetry: TemplateRetryConfig = {
      ladder: [{ cycle: 1, strategy: 'escalate-human' }],
    }
    const phaseRetry: TemplateRetryConfig = { maxAttempts: 7 }

    const result = resolveRetryConfig(templateRetry, phaseRetry, globalEscalation)

    // maxAttempts falls through to phase, ladder from template
    expect(result.maxAttempts).toBe(7)
    expect(result.ladder).toEqual([{ cycle: 1, strategy: 'escalate-human' }])
  })

  it('global escalation without maxSessionsPerPhase falls back to default', () => {
    const escalationNoPhaseMax: EscalationConfig = {
      ladder: [{ cycle: 1, strategy: 'normal' }],
      circuitBreaker: {
        maxSessionsPerIssue: 8,
      },
    }

    const result = resolveRetryConfig(undefined, undefined, escalationNoPhaseMax)

    expect(result.maxAttempts).toBe(3) // default
    expect(result.ladder).toEqual([{ cycle: 1, strategy: 'normal' }])
  })
})

// ---------------------------------------------------------------------------
// resolveTimeoutConfig
// ---------------------------------------------------------------------------

describe('resolveTimeoutConfig', () => {
  it('template timeout overrides phase timeout', () => {
    const templateTimeout: TemplateTimeoutConfig = { duration: '30m', action: 'fail' }
    const phaseTimeout: TemplateTimeoutConfig = { duration: '2h', action: 'escalate' }

    const result = resolveTimeoutConfig(templateTimeout, phaseTimeout)

    expect(result).not.toBeNull()
    expect(result!.durationMs).toBe(1_800_000) // 30m
    expect(result!.action).toBe('fail')
  })

  it('phase timeout used when no template timeout', () => {
    const phaseTimeout: TemplateTimeoutConfig = { duration: '2h', action: 'escalate' }

    const result = resolveTimeoutConfig(undefined, phaseTimeout)

    expect(result).not.toBeNull()
    expect(result!.durationMs).toBe(7_200_000) // 2h
    expect(result!.action).toBe('escalate')
  })

  it('returns null when no timeout configured', () => {
    const result = resolveTimeoutConfig(undefined, undefined)

    expect(result).toBeNull()
  })

  it('resolves "1d" duration correctly', () => {
    const timeout: TemplateTimeoutConfig = { duration: '1d', action: 'skip' }

    const result = resolveTimeoutConfig(timeout)

    expect(result).not.toBeNull()
    expect(result!.durationMs).toBe(86_400_000) // 1d
    expect(result!.action).toBe('skip')
  })

  it('resolves "90m" duration correctly', () => {
    const timeout: TemplateTimeoutConfig = { duration: '90m', action: 'escalate' }

    const result = resolveTimeoutConfig(timeout)

    expect(result).not.toBeNull()
    expect(result!.durationMs).toBe(5_400_000) // 90m
  })

  it('handles skip action', () => {
    const timeout: TemplateTimeoutConfig = { duration: '1h', action: 'skip' }

    const result = resolveTimeoutConfig(timeout)

    expect(result).not.toBeNull()
    expect(result!.action).toBe('skip')
  })

  it('handles fail action', () => {
    const timeout: TemplateTimeoutConfig = { duration: '1h', action: 'fail' }

    const result = resolveTimeoutConfig(timeout)

    expect(result).not.toBeNull()
    expect(result!.action).toBe('fail')
  })
})
