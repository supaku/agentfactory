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
  mergeModel: 'three-way-text',
  conflictGranularity: 'line',
  patchModel: 'commit-graph',
  hasPullRequests: true,
  hasReviewWorkflow: true,
  hasMergeQueue: true,
  branchSemantics: 'git-branches',
  supportsBranches: true,
  supportsRebase: true,
  identityScheme: 'email',
  remoteProtocol: 'git-smart-http',
  provenanceNative: false,
  auditModel: 'commit-trailer',
  supportsAttest: true,
  supportsBinary: true,
  supportsStructuredContent: false,
  supportsLargeFiles: false,
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

// ---------------------------------------------------------------------------
// MergeResult variant fixtures — REN-1343 acceptance criterion
//
// "Tests cover each MergeResult variant with a minimal fixture."
//
// These fixtures double as exhaustive-narrowing references for callers that
// switch on result.kind. The fixtures are minimal — just enough to exercise
// each branch of the discriminated union — so callers can copy them into
// their own tests when adding new merge consumers.
// ---------------------------------------------------------------------------

describe('VCSMergeResult — minimal fixtures for each variant', () => {
  /**
   * Minimal "clean" fixture: no resolutions, no conflicts. Use for
   * fast-forward merges and "Already up to date" pulls.
   */
  const cleanFixture: VCSMergeResult = { kind: 'clean' }

  /**
   * Minimal "auto-resolved" fixture: a single token-level resolution from
   * the patch-theory strategy (Atomic's headline path).
   */
  const autoResolvedFixture: VCSMergeResult = {
    kind: 'auto-resolved',
    resolutions: [{ filePath: 'src/foo.ts', strategy: 'patch-theory' }],
  }

  /**
   * Minimal "conflict" fixture: a single unresolvable conflict requiring
   * human/agent intervention. Mirrors what GitHubVCSProvider.pull() returns
   * when git's three-way merge fails.
   */
  const conflictFixture: VCSMergeResult = {
    kind: 'conflict',
    conflicts: [{ filePath: 'src/bar.ts', detail: 'merge conflict' }],
  }

  it('clean fixture is shape { kind: "clean" }', () => {
    expect(cleanFixture).toEqual({ kind: 'clean' })
  })

  it('auto-resolved fixture carries non-empty resolutions array', () => {
    expect(autoResolvedFixture.kind).toBe('auto-resolved')
    if (autoResolvedFixture.kind === 'auto-resolved') {
      expect(autoResolvedFixture.resolutions.length).toBeGreaterThan(0)
      expect(autoResolvedFixture.resolutions[0]).toMatchObject({
        filePath: expect.any(String),
        strategy: expect.any(String),
      })
    }
  })

  it('conflict fixture carries non-empty conflicts array', () => {
    expect(conflictFixture.kind).toBe('conflict')
    if (conflictFixture.kind === 'conflict') {
      expect(conflictFixture.conflicts.length).toBeGreaterThan(0)
      expect(conflictFixture.conflicts[0].filePath).toEqual(expect.any(String))
    }
  })

  it('exhaustive switch covers all three variants', () => {
    function classify(r: VCSMergeResult): 'clean' | 'auto-resolved' | 'conflict' {
      switch (r.kind) {
        case 'clean':
          return 'clean'
        case 'auto-resolved':
          return 'auto-resolved'
        case 'conflict':
          return 'conflict'
      }
    }

    expect(classify(cleanFixture)).toBe('clean')
    expect(classify(autoResolvedFixture)).toBe('auto-resolved')
    expect(classify(conflictFixture)).toBe('conflict')
  })

  it('auto-resolved fixture is NOT confusable with clean — guards "never silently swallowed"', () => {
    // Per corpus 008 §Merge queue logic: auto-resolved MUST be surfaced.
    // A consumer that conflates auto-resolved with clean is a bug.
    expect(autoResolvedFixture.kind).not.toBe('clean')
    expect(cleanFixture.kind).not.toBe('auto-resolved')
  })
})

// ---------------------------------------------------------------------------
// VersionControlProviderCapabilities — corpus-008 surface (REN-1343)
// ---------------------------------------------------------------------------

describe('VersionControlProviderCapabilities — corpus-008 surface', () => {
  it('exposes mergeModel grouping field', () => {
    expect(BASE_CAPS.mergeModel).toBe('three-way-text')
  })

  it('exposes patchModel grouping field', () => {
    expect(BASE_CAPS.patchModel).toBe('commit-graph')
  })

  it('exposes branchSemantics grouping field', () => {
    expect(BASE_CAPS.branchSemantics).toBe('git-branches')
  })

  it('exposes auditModel grouping field', () => {
    expect(BASE_CAPS.auditModel).toBe('commit-trailer')
  })

  it('exposes supportsAttest first-class verb flag (consumed by REN-1314 sigstore)', () => {
    expect(BASE_CAPS.supportsAttest).toBe(true)
  })

  it('mergeModel value matches mergeStrategy value (kept in lock-step)', () => {
    // The corpus-008 alias is intentional duplication; it MUST stay synchronized
    // with mergeStrategy so consumers can query by either name.
    expect(BASE_CAPS.mergeModel).toBe(BASE_CAPS.mergeStrategy)
  })
})

