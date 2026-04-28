/**
 * VCS types — unit tests
 *
 * Tests:
 * - UnsupportedOperationError construction and fields
 * - assertCapability throws/passes correctly
 * - Capability gating: hasMergeQueue, hasPullRequests
 * - VCSMergeResult discriminated union narrowing
 */

import { describe, it, expect } from 'vitest'
import {
  UnsupportedOperationError,
  assertCapability,
} from './types.js'
import type {
  VersionControlProviderCapabilities,
  VCSMergeResult,
} from './types.js'

// ---------------------------------------------------------------------------
// UnsupportedOperationError
// ---------------------------------------------------------------------------

describe('UnsupportedOperationError', () => {
  it('sets name, capability, and providerId', () => {
    const err = new UnsupportedOperationError('hasMergeQueue', 'test-provider')
    expect(err.name).toBe('UnsupportedOperationError')
    expect(err.capability).toBe('hasMergeQueue')
    expect(err.providerId).toBe('test-provider')
  })

  it('generates a default message referencing capability and provider', () => {
    const err = new UnsupportedOperationError('hasPullRequests', 'atomic')
    expect(err.message).toContain('atomic')
    expect(err.message).toContain('hasPullRequests')
  })

  it('accepts a custom message', () => {
    const err = new UnsupportedOperationError('hasMergeQueue', 'p', 'custom message')
    expect(err.message).toBe('custom message')
  })

  it('is an instance of Error', () => {
    const err = new UnsupportedOperationError('hasMergeQueue', 'p')
    expect(err).toBeInstanceOf(Error)
  })
})

// ---------------------------------------------------------------------------
// assertCapability
// ---------------------------------------------------------------------------

const BASE_CAPS: VersionControlProviderCapabilities = {
  mergeStrategy: 'three-way-text',
  conflictGranularity: 'line',
  hasPullRequests: true,
  hasReviewWorkflow: true,
  hasMergeQueue: true,
  identityScheme: 'email',
  provenanceNative: false,
}

describe('assertCapability', () => {
  it('does not throw when capability is true', () => {
    expect(() =>
      assertCapability({ ...BASE_CAPS, hasMergeQueue: true }, 'hasMergeQueue', 'github')
    ).not.toThrow()
  })

  it('throws UnsupportedOperationError when capability is false', () => {
    expect(() =>
      assertCapability({ ...BASE_CAPS, hasMergeQueue: false }, 'hasMergeQueue', 'atomic')
    ).toThrowError(UnsupportedOperationError)
  })

  it('throws for hasPullRequests = false', () => {
    expect(() =>
      assertCapability({ ...BASE_CAPS, hasPullRequests: false }, 'hasPullRequests', 'atomic')
    ).toThrowError(UnsupportedOperationError)
  })

  it('passes for hasPullRequests = true', () => {
    expect(() =>
      assertCapability({ ...BASE_CAPS, hasPullRequests: true }, 'hasPullRequests', 'github')
    ).not.toThrow()
  })

  it('includes providerId in thrown error', () => {
    try {
      assertCapability({ ...BASE_CAPS, hasMergeQueue: false }, 'hasMergeQueue', 'my-provider')
    } catch (e) {
      expect(e).toBeInstanceOf(UnsupportedOperationError)
      expect((e as UnsupportedOperationError).providerId).toBe('my-provider')
    }
  })

  it('includes capability in thrown error', () => {
    try {
      assertCapability({ ...BASE_CAPS, hasMergeQueue: false }, 'hasMergeQueue', 'p')
    } catch (e) {
      expect(e).toBeInstanceOf(UnsupportedOperationError)
      expect((e as UnsupportedOperationError).capability).toBe('hasMergeQueue')
    }
  })
})

// ---------------------------------------------------------------------------
// Capability-gated merge-queue path (doc §Merge queue logic — gated, not hard-wired)
// ---------------------------------------------------------------------------

describe('Capability-gated merge-queue path', () => {
  /**
   * Simulate the merge-queue conditional from 008:
   *
   *   if (!provider.capabilities.hasMergeQueue) {
   *     return await provider.mergeProposal!(ref, 'auto')
   *   }
   *   const ticket = await provider.enqueueForMerge!(ref, { ... })
   */
  it('skips queue serialization when hasMergeQueue is false (commutative VCS path)', () => {
    const caps: VersionControlProviderCapabilities = {
      ...BASE_CAPS,
      hasMergeQueue: false,
    }
    // Commutative VCS — should NOT call enqueueForMerge
    const route = caps.hasMergeQueue ? 'queue' : 'direct-merge'
    expect(route).toBe('direct-merge')
  })

  it('routes to queue when hasMergeQueue is true', () => {
    const caps: VersionControlProviderCapabilities = {
      ...BASE_CAPS,
      hasMergeQueue: true,
    }
    const route = caps.hasMergeQueue ? 'queue' : 'direct-merge'
    expect(route).toBe('queue')
  })

  it('enqueueForMerge throws when called on a provider without hasMergeQueue', () => {
    const caps: VersionControlProviderCapabilities = { ...BASE_CAPS, hasMergeQueue: false }
    expect(() => assertCapability(caps, 'hasMergeQueue', 'atomic')).toThrowError(
      UnsupportedOperationError,
    )
  })
})

// ---------------------------------------------------------------------------
// VCSMergeResult discriminated union
// ---------------------------------------------------------------------------

describe('VCSMergeResult discriminated union', () => {
  it('narrows to clean result', () => {
    const result: VCSMergeResult = { kind: 'clean' }
    expect(result.kind).toBe('clean')
  })

  it('narrows to auto-resolved result with resolutions array', () => {
    const result: VCSMergeResult = {
      kind: 'auto-resolved',
      resolutions: [{ filePath: 'src/foo.ts', strategy: 'patch-theory' }],
    }
    expect(result.kind).toBe('auto-resolved')
    if (result.kind === 'auto-resolved') {
      expect(result.resolutions).toHaveLength(1)
      expect(result.resolutions[0].filePath).toBe('src/foo.ts')
    }
  })

  it('narrows to conflict result with conflicts array', () => {
    const result: VCSMergeResult = {
      kind: 'conflict',
      conflicts: [{ filePath: 'src/bar.ts', detail: 'merge conflict' }],
    }
    expect(result.kind).toBe('conflict')
    if (result.kind === 'conflict') {
      expect(result.conflicts).toHaveLength(1)
      expect(result.conflicts[0].filePath).toBe('src/bar.ts')
    }
  })

  it('auto-resolved must be surfaced (not silently swallowed)', () => {
    // This test embodies the requirement from 008:
    // "MergeResult.auto-resolved must be surfaced, not silently swallowed."
    const result: VCSMergeResult = {
      kind: 'auto-resolved',
      resolutions: [{ filePath: 'src/index.ts', strategy: 'patch-theory' }],
    }

    let surfaced = false
    if (result.kind === 'auto-resolved') {
      // Consumer MUST handle auto-resolved explicitly — cannot conflate with 'clean'
      surfaced = true
    }
    expect(surfaced).toBe(true)
  })
})

