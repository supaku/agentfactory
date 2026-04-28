/**
 * Observation pipeline — round-trip tests
 *
 * Verifies:
 *   1. Fixture PR + AC round-trip: patterns, conventions, and decision nodes
 *      emerge from a synthetic PR diff with acceptance criteria.
 *   2. Authored intent (CLAUDE.md, ADR) → confidence 1.0; contribution is
 *      stored with 'authored' citation.
 *   3. Inference confidence is capped at 0.95; never reaches 1.0 without
 *      an authored document source.
 *   4. Hook bus subscription: memory.observation.* events are contributed.
 *   5. Workarea lifecycle events (post-activate, post-verb) trigger
 *      lightweight pattern observations.
 *   6. Cluster + dedupe: similar observations merge into fewer contributions.
 *   7. Decay: observations past the TTL are discarded (confidence → 0).
 *   8. isAuthoredDoc detects CLAUDE.md and ADR files correctly.
 *   9. makeAuthoredObservation produces confidence 1.0 observations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { SqliteArchitecturalIntelligence } from './sqlite-impl.js'
import {
  runObservationPass,
  attachPipelineSubscribers,
  isAuthoredDoc,
  makeAuthoredObservation,
  createTestBus,
  MEMORY_OBSERVATION_KINDS,
  type PipelineHookEvent,
  type MemoryObservationEvent,
} from './pipeline.js'
import type { PrDiff } from './diff-reader.js'
import { clusterObservations, effectiveConfidence, _jaccardSimilarity } from './cluster.js'
import type { ArchObservation, ArchScope } from './types.js'
import { CITATION_CONFIDENCE_RANK } from './types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `pipeline-test-${randomUUID().slice(0, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeImpl(dir: string): SqliteArchitecturalIntelligence {
  return new SqliteArchitecturalIntelligence({
    dbPath: join(dir, 'db.sqlite'),
  })
}

const PROJECT_SCOPE: ArchScope = { level: 'project', projectId: 'test-project' }

/**
 * A realistic PR diff fixture representing an auth middleware refactor.
 * Includes: file-path zone (auth), convention signal (Result<T,E>),
 * acceptance criteria, and a decision in the body.
 */
const AUTH_REFACTOR_PR: PrDiff = {
  repository: 'github.com/example/myapp',
  prNumber: 42,
  title: 'Refactor auth — chose Middleware over per-route checks',
  body: `
## Summary

Centralized auth into a single middleware layer at lib/auth/middleware.ts.

We chose middleware over per-route checks because it's easier to audit and
consistent with the existing pattern in the codebase.

## Why

Per-route checks were inconsistent and hard to audit. This change migrated
them all to a single middleware that returns Result<AuthResult, AuthError>.

## Decision

Picked centralized middleware over per-route approach for auditability.
  `.trim(),
  acceptanceCriteria: [
    'All API routes must delegate authentication to lib/auth/middleware.ts',
    'Auth middleware should return Result<AuthResult, AuthError>',
    'Never bypass auth middleware without a documented justification',
    'Auth errors are never thrown — always returned via Result',
  ],
  files: [
    {
      path: 'lib/auth/middleware.ts',
      added: true,
      patch: `
+export async function authMiddleware(req: Request): Promise<Result<AuthResult, AuthError>> {
+  const token = req.headers.get('Authorization')
+  if (!token) return { ok: false, error: { code: 'MISSING_TOKEN' } }
+  const result = await validateToken(token)
+  return result
+}
      `.trim(),
    },
    {
      path: 'lib/auth/validate.ts',
      added: false,
      patch: `
+export async function validateToken(token: string): Promise<Result<AuthResult, AuthError>> {
+  // Validate JWT
+  try {
+    const payload = await verifyJwt(token)
+    return { ok: true, value: { userId: payload.sub } }
+  } catch {
+    return { ok: false, error: { code: 'INVALID_TOKEN' } }
+  }
+}
      `.trim(),
    },
    {
      path: 'lib/api/users.ts',
      added: false,
      patch: `
-// Old per-route auth
-const user = await getUser(req)
-if (!user) throw new Error('Unauthorized')
+// Delegated to auth middleware
+const authResult = await authMiddleware(req)
+if (!authResult.ok) return { error: authResult.error }
      `.trim(),
    },
    {
      path: 'tests/auth/middleware.test.ts',
      added: true,
      patch: `
+describe('authMiddleware', () => {
+  it('returns Result with error for missing token', async () => {
+    const result = await authMiddleware(makeReq(null))
+    expect(result.ok).toBe(false)
+  })
+  it('returns Result with value for valid token', async () => {
+    const result = await authMiddleware(makeReq(VALID_TOKEN))
+    expect(result.ok).toBe(true)
+  })
+})
      `.trim(),
    },
  ],
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string
let impl: SqliteArchitecturalIntelligence

beforeEach(() => {
  tmpDir = makeTmpDir()
  impl = makeImpl(tmpDir)
})

afterEach(() => {
  impl.close()
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 1. Fixture PR round-trip: nodes emerge from the pipeline
// ---------------------------------------------------------------------------

describe('fixture PR round-trip: pattern + convention + decision nodes', () => {
  it('auth refactor PR produces pattern, convention, and decision observations', async () => {
    const result = await runObservationPass({
      since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      prDiffs: [AUTH_REFACTOR_PR],
      ai: impl,
      scope: PROJECT_SCOPE,
    })

    expect(result.diffsProcessed).toBe(1)
    expect(result.contributed).toBeGreaterThan(0)

    const view = await impl.query({ workType: 'development', scope: PROJECT_SCOPE })

    // Pattern: auth zone should be detected
    const authPattern = view.patterns.find(
      (p) => p.title.toLowerCase().includes('auth'),
    )
    expect(authPattern).toBeDefined()

    // Convention: Result<T, E> usage should be detected
    const resultConvention = view.conventions.find(
      (c) => c.title.toLowerCase().includes('result'),
    )
    expect(resultConvention).toBeDefined()

    // Decision: "chose middleware over" should be detected
    const decision = view.decisions.find(
      (d) => d.title.toLowerCase().includes('middleware') || d.title.toLowerCase().includes('chose'),
    )
    expect(decision).toBeDefined()
  })

  it('acceptance criteria produce convention and pattern observations', async () => {
    await runObservationPass({
      since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      prDiffs: [AUTH_REFACTOR_PR],
      ai: impl,
      scope: PROJECT_SCOPE,
    })

    const view = await impl.query({ workType: 'development', scope: PROJECT_SCOPE })

    // AC items with "must/should/never" → conventions
    const authConvention = view.conventions.find(
      (c) => c.description.toLowerCase().includes('acceptance criterion'),
    )
    expect(authConvention).toBeDefined()
  })

  it('citation chain traces back to the PR change ref', async () => {
    await runObservationPass({
      since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      prDiffs: [AUTH_REFACTOR_PR],
      ai: impl,
      scope: PROJECT_SCOPE,
    })

    const view = await impl.query({ workType: 'development', scope: PROJECT_SCOPE })

    // At least one node should have a citation back to a PR change
    const allCitations = [...view.patterns, ...view.conventions, ...view.decisions]
      .flatMap((n) => n.citations)
    const changeCitation = allCitations.find((c) => c.source.kind === 'change')
    expect(changeCitation).toBeDefined()
    if (changeCitation?.source.kind === 'change') {
      expect(changeCitation.source.changeRef.prNumber).toBe(42)
    }
  })

  it('inference confidence is capped at 0.95 by default', async () => {
    await runObservationPass({
      since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      prDiffs: [AUTH_REFACTOR_PR],
      ai: impl,
      scope: PROJECT_SCOPE,
    })

    const obs = impl._getAllObservations()
    // All observations from diff inference should be <= 0.95
    for (const o of obs) {
      expect(o.confidence).toBeLessThanOrEqual(0.95)
    }
  })
})

// ---------------------------------------------------------------------------
// 2. Authored intent: CLAUDE.md / ADR → confidence 1.0
// ---------------------------------------------------------------------------

describe('authored intent: CLAUDE.md and ADR get confidence 1.0', () => {
  it('manual authored observation via contribute() gets authored citation', async () => {
    const authoredObs: ArchObservation = {
      kind: 'convention',
      payload: {
        title: 'Hexagonal architecture layout',
        description: 'Domain in domain/, adapters in adapters/. Documented in CLAUDE.md.',
        examples: [{ path: 'CLAUDE.md' }],
      },
      source: { authoredDoc: { path: 'CLAUDE.md', kind: 'claude-md' } },
      confidence: 1.0,
      scope: PROJECT_SCOPE,
    }

    await impl.contribute(authoredObs)

    const view = await impl.query({ workType: 'development', scope: PROJECT_SCOPE })
    const conv = view.conventions.find((c) => c.title.includes('Hexagonal'))
    expect(conv).toBeDefined()
    expect(conv!.citations[0]!.confidence).toBe('authored')
    expect(CITATION_CONFIDENCE_RANK['authored']).toBeGreaterThan(
      CITATION_CONFIDENCE_RANK['inferred-high'],
    )
  })

  it('makeAuthoredObservation produces confidence 1.0 for CLAUDE.md', () => {
    const obs = makeAuthoredObservation(
      'CLAUDE.md',
      'Project conventions',
      'All API routes use Result<T,E>',
      PROJECT_SCOPE,
    )
    expect(obs).not.toBeNull()
    expect(obs!.confidence).toBe(1.0)
    expect(obs!.source.authoredDoc?.kind).toBe('claude-md')
  })

  it('makeAuthoredObservation produces confidence 1.0 for ADR files', () => {
    const obs = makeAuthoredObservation(
      'docs/decisions/ADR-001-use-drizzle.md',
      'ADR-001: Use Drizzle ORM',
      'Drizzle was chosen over Prisma for edge-runtime support.',
      PROJECT_SCOPE,
    )
    expect(obs).not.toBeNull()
    expect(obs!.confidence).toBe(1.0)
    expect(obs!.source.authoredDoc?.kind).toBe('adr')
  })

  it('authored observation in pipeline pass bypasses cluster decay', async () => {
    const authored: ArchObservation = {
      kind: 'convention',
      payload: { title: 'CLAUDE.md convention', description: 'From CLAUDE.md' },
      source: { authoredDoc: { path: 'CLAUDE.md', kind: 'claude-md' } },
      confidence: 1.0,
      scope: PROJECT_SCOPE,
    }

    // Use a far-past date to simulate maximum decay
    const veryOldDate = new Date(0) // epoch

    const result = await runObservationPass({
      since: veryOldDate,
      prDiffs: [],
      extraObservations: [{ observation: authored, recordedAt: veryOldDate }],
      ai: impl,
      scope: PROJECT_SCOPE,
      now: new Date(),
    })

    // Authored bypasses decay — should be contributed
    expect(result.contributed).toBe(1)
    expect(result.discarded).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. isAuthoredDoc detection
// ---------------------------------------------------------------------------

describe('isAuthoredDoc detection', () => {
  it('detects CLAUDE.md at root', () => {
    expect(isAuthoredDoc('CLAUDE.md')).toEqual({ kind: 'claude-md' })
  })

  it('detects CLAUDE.md in a subdirectory', () => {
    expect(isAuthoredDoc('packages/core/CLAUDE.md')).toEqual({ kind: 'claude-md' })
  })

  it('detects ADR-NNN-title.md', () => {
    expect(isAuthoredDoc('ADR-001-use-drizzle.md')).toEqual({ kind: 'adr' })
    expect(isAuthoredDoc('adr-002-pick-postgres.md')).toEqual({ kind: 'adr' })
  })

  it('detects docs/decisions/*.md', () => {
    expect(isAuthoredDoc('docs/decisions/001-use-drizzle.md')).toEqual({ kind: 'adr' })
  })

  it('returns false for regular TypeScript files', () => {
    expect(isAuthoredDoc('packages/core/src/foo.ts')).toBe(false)
  })

  it('returns false for README.md', () => {
    expect(isAuthoredDoc('README.md')).toBe(false)
  })

  it('detects architecture spec files', () => {
    const result = isAuthoredDoc('rensei-architecture/007-intelligence-services.md')
    expect(result).toEqual({ kind: 'spec' })
  })
})

// ---------------------------------------------------------------------------
// 4. Hook bus: memory.observation.* events are contributed
// ---------------------------------------------------------------------------

describe('hook bus: memory.observation.* events are contributed', () => {
  it('memory.observation.pattern event causes a contribution', async () => {
    const bus = createTestBus()
    const unsub = attachPipelineSubscribers(bus, impl, { scope: PROJECT_SCOPE })

    const event: MemoryObservationEvent = {
      kind: 'memory.observation.pattern',
      observation: {
        kind: 'pattern',
        payload: {
          title: 'Memory-observed auth pattern',
          description: 'Observed auth centralization via memory event.',
          locations: [{ path: 'lib/auth/middleware.ts' }],
          tags: ['auth'],
        },
        source: { sessionId: 'session-mem-001' },
        confidence: 0.75,
        scope: PROJECT_SCOPE,
      },
    }

    await bus.emit(event)

    const view = await impl.query({ workType: 'development', scope: PROJECT_SCOPE })
    expect(view.patterns).toHaveLength(1)
    expect(view.patterns[0]!.title).toBe('Memory-observed auth pattern')

    unsub()
  })

  it('handles all four memory.observation.* kinds', async () => {
    const bus = createTestBus()
    const unsub = attachPipelineSubscribers(bus, impl, { scope: PROJECT_SCOPE })

    for (const kind of MEMORY_OBSERVATION_KINDS) {
      const obsKind = kind.replace('memory.observation.', '') as ArchObservation['kind']
      const event: PipelineHookEvent = {
        kind,
        observation: {
          kind: obsKind,
          payload: {
            title: `Test ${obsKind}`,
            description: `Observation of kind ${obsKind}`,
            ...(obsKind === 'deviation'
              ? { deviatesFrom: { kind: 'pattern', patternId: 'p1' }, status: 'pending', severity: 'low' }
              : {}),
            ...(obsKind === 'decision'
              ? { chosen: 'Option A', alternatives: [], rationale: 'Test', status: 'active' }
              : {}),
          },
          source: { sessionId: `sess-${obsKind}` },
          confidence: 0.6,
          scope: PROJECT_SCOPE,
        },
      }
      await bus.emit(event)
    }

    const obs = impl._getAllObservations()
    expect(obs).toHaveLength(MEMORY_OBSERVATION_KINDS.length)

    unsub()
  })

  it('unsub removes the subscriber', async () => {
    const bus = createTestBus()
    const unsub = attachPipelineSubscribers(bus, impl, { scope: PROJECT_SCOPE })

    unsub() // detach before emitting

    await bus.emit({
      kind: 'memory.observation.pattern',
      observation: {
        kind: 'pattern',
        payload: { title: 'Should not appear', description: '' },
        source: { sessionId: 'sess' },
        confidence: 0.7,
        scope: PROJECT_SCOPE,
      },
    })

    const obs = impl._getAllObservations()
    expect(obs).toHaveLength(0)
  })

  it('confidence cap is enforced on memory events', async () => {
    const bus = createTestBus()
    const unsub = attachPipelineSubscribers(bus, impl, {
      scope: PROJECT_SCOPE,
      inferenceConfidenceCap: 0.80,
    })

    await bus.emit({
      kind: 'memory.observation.convention',
      observation: {
        kind: 'convention',
        payload: { title: 'Capped convention', description: '' },
        source: { sessionId: 'sess-cap' },
        confidence: 0.99, // above the override cap
        scope: PROJECT_SCOPE,
      },
    })

    const obs = impl._getAllObservations()
    expect(obs).toHaveLength(1)
    expect(obs[0]!.confidence).toBeLessThanOrEqual(0.80)

    unsub()
  })
})

// ---------------------------------------------------------------------------
// 5. Workarea lifecycle hook events
// ---------------------------------------------------------------------------

describe('workarea lifecycle hook events trigger observations', () => {
  it('post-activate on workarea provider produces a pattern observation', async () => {
    const bus = createTestBus()
    const unsub = attachPipelineSubscribers(bus, impl, { scope: PROJECT_SCOPE })

    await bus.emit({
      kind: 'post-activate',
      provider: { id: 'local-workarea', family: 'workarea' },
      durationMs: 120,
    })

    const obs = impl._getAllObservations()
    expect(obs.length).toBeGreaterThan(0)
    expect(obs[0]!.kind).toBe('pattern')

    unsub()
  })

  it('post-verb "acquire" on workarea provider produces a pattern observation', async () => {
    const bus = createTestBus()
    const unsub = attachPipelineSubscribers(bus, impl, { scope: PROJECT_SCOPE })

    await bus.emit({
      kind: 'post-verb',
      provider: { id: 'local-workarea', family: 'workarea' },
      verb: 'acquire',
      durationMs: 200,
      result: null,
    })

    const obs = impl._getAllObservations()
    expect(obs.length).toBeGreaterThan(0)

    unsub()
  })

  it('non-workarea post-activate events are ignored', async () => {
    const bus = createTestBus()
    const unsub = attachPipelineSubscribers(bus, impl, { scope: PROJECT_SCOPE })

    await bus.emit({
      kind: 'post-activate',
      provider: { id: 'github-vcs', family: 'vcs' },
      durationMs: 50,
    })

    const obs = impl._getAllObservations()
    expect(obs).toHaveLength(0)

    unsub()
  })
})

// ---------------------------------------------------------------------------
// 6. Cluster + dedupe
// ---------------------------------------------------------------------------

describe('cluster + dedupe logic', () => {
  it('two identical observations are merged into one cluster', async () => {
    const obs: ArchObservation = {
      kind: 'convention',
      payload: {
        title: 'Result error handling pattern',
        description: 'Code uses Result<T, E> for error propagation',
      },
      source: { sessionId: 'sess-a' },
      confidence: 0.6,
      scope: PROJECT_SCOPE,
    }

    const obs2: ArchObservation = {
      ...obs,
      source: { sessionId: 'sess-b' },
      confidence: 0.55,
    }

    const result = await runObservationPass({
      since: new Date(Date.now() - 1000),
      prDiffs: [],
      extraObservations: [
        { observation: obs, recordedAt: new Date() },
        { observation: obs2, recordedAt: new Date() },
      ],
      ai: impl,
      scope: PROJECT_SCOPE,
    })

    // Two similar observations should cluster into 1
    expect(result.contributed).toBe(1)
    expect(result.clusterMerges).toBe(1)
  })

  it('two dissimilar observations stay as separate clusters', async () => {
    const obs1: ArchObservation = {
      kind: 'pattern',
      payload: {
        title: 'Auth centralized middleware',
        description: 'Authentication handled in single middleware location',
      },
      source: { sessionId: 'sess-1' },
      confidence: 0.6,
      scope: PROJECT_SCOPE,
    }

    const obs2: ArchObservation = {
      kind: 'convention',
      payload: {
        title: 'Database connection pooling',
        description: 'Database connections are pooled for efficiency',
      },
      source: { sessionId: 'sess-2' },
      confidence: 0.6,
      scope: PROJECT_SCOPE,
    }

    const result = await runObservationPass({
      since: new Date(Date.now() - 1000),
      prDiffs: [],
      extraObservations: [
        { observation: obs1, recordedAt: new Date() },
        { observation: obs2, recordedAt: new Date() },
      ],
      ai: impl,
      scope: PROJECT_SCOPE,
    })

    expect(result.contributed).toBe(2)
    expect(result.clusterMerges).toBe(0)
  })

  it('cluster merge boosts representative confidence slightly', () => {
    const now = new Date()
    const obs: ArchObservation = {
      kind: 'pattern',
      payload: { title: 'Same pattern', description: 'Same pattern description same' },
      source: { sessionId: 'sess' },
      confidence: 0.50,
      scope: PROJECT_SCOPE,
    }

    const clusters = clusterObservations(
      [
        { observation: obs, recordedAt: now },
        { observation: { ...obs, source: { sessionId: 'sess2' }, confidence: 0.48 }, recordedAt: now },
        { observation: { ...obs, source: { sessionId: 'sess3' }, confidence: 0.46 }, recordedAt: now },
      ],
      now,
    )

    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.clusterSize).toBe(3)
    // Representative gets a merge boost
    expect(clusters[0]!.representative.confidence).toBeGreaterThan(0.50)
    // But stays capped at 0.95
    expect(clusters[0]!.representative.confidence).toBeLessThanOrEqual(0.95)
  })
})

// ---------------------------------------------------------------------------
// 7. Decay
// ---------------------------------------------------------------------------

describe('decay: stale observations are filtered', () => {
  it('observation past decayDays is marked decayed', () => {
    const obs: ArchObservation = {
      kind: 'pattern',
      payload: { title: 'Old pattern', description: 'old old old pattern observation' },
      source: { sessionId: 'sess-old' },
      confidence: 0.7,
      scope: PROJECT_SCOPE,
    }

    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) // 60 days ago
    const clusters = clusterObservations(
      [{ observation: obs, recordedAt: oldDate }],
      new Date(),
      { decayDays: 30 },
    )

    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.decayed).toBe(true)
    expect(clusters[0]!.representative.confidence).toBeLessThan(0.7)
  })

  it('effectiveConfidence returns 0 for observation at 2x decayDays', () => {
    const obs: ArchObservation = {
      kind: 'convention',
      payload: { title: 'Expired', description: '' },
      source: { sessionId: 's' },
      confidence: 0.8,
      scope: PROJECT_SCOPE,
    }

    const oldDate = new Date(Date.now() - 61 * 24 * 60 * 60 * 1000) // just past 2x 30 days
    const effective = effectiveConfidence(obs, oldDate, new Date(), { decayDays: 30 })
    expect(effective).toBe(0)
  })

  it('authored observation never decays', () => {
    const obs: ArchObservation = {
      kind: 'convention',
      payload: { title: 'CLAUDE.md convention', description: '' },
      source: { authoredDoc: { path: 'CLAUDE.md', kind: 'claude-md' } },
      confidence: 1.0,
      scope: PROJECT_SCOPE,
    }

    const oldDate = new Date(0) // epoch
    const effective = effectiveConfidence(obs, oldDate, new Date(), { decayDays: 30 })
    expect(effective).toBe(1.0)
  })

  it('decayed-to-zero observations are discarded (confidenceFloor)', async () => {
    const obs: ArchObservation = {
      kind: 'pattern',
      payload: { title: 'Very stale observation', description: 'very old stale expired pattern' },
      source: { sessionId: 's' },
      confidence: 0.5,
      scope: PROJECT_SCOPE,
    }

    const veryOld = new Date(0) // epoch (far past any decay window)
    const result = await runObservationPass({
      since: veryOld,
      prDiffs: [],
      extraObservations: [{ observation: obs, recordedAt: veryOld }],
      ai: impl,
      scope: PROJECT_SCOPE,
      now: new Date(),
      clusterConfig: { decayDays: 30 },
    })

    expect(result.discarded).toBeGreaterThanOrEqual(1)
    expect(result.contributed).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 8. Jaccard similarity
// ---------------------------------------------------------------------------

describe('Jaccard similarity', () => {
  it('identical token sets have similarity 1.0', () => {
    const s = new Set(['auth', 'middleware', 'pattern'])
    expect(_jaccardSimilarity(s, s)).toBe(1.0)
  })

  it('disjoint sets have similarity 0.0', () => {
    const a = new Set(['auth', 'middleware'])
    const b = new Set(['database', 'pooling'])
    expect(_jaccardSimilarity(a, b)).toBe(0)
  })

  it('overlapping sets have intermediate similarity', () => {
    const a = new Set(['auth', 'middleware', 'pattern'])
    const b = new Set(['auth', 'middleware', 'database'])
    // intersection = {auth, middleware}, union = 4 → 0.5
    expect(_jaccardSimilarity(a, b)).toBe(0.5)
  })

  it('both empty sets return 0 (undefined similarity)', () => {
    expect(_jaccardSimilarity(new Set(), new Set())).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 9. Multiple PRs in one pass
// ---------------------------------------------------------------------------

describe('multiple PRs in one pass', () => {
  it('two PRs with different signals produce distinct contributions', async () => {
    const pr1: PrDiff = {
      repository: 'github.com/example/app',
      prNumber: 10,
      title: 'Add auth middleware',
      body: 'Centralized auth middleware',
      files: [
        {
          path: 'lib/auth/middleware.ts',
          added: true,
          patch: '+export async function auth(): Promise<Result<User, Error>> { return ok(user) }',
        },
      ],
    }

    const pr2: PrDiff = {
      repository: 'github.com/example/app',
      prNumber: 11,
      title: 'Add database connection pool',
      body: 'Using pg pool for database connections',
      files: [
        {
          path: 'lib/db/pool.ts',
          added: true,
          patch: '+export const pool = new Pool({ max: 10, idleTimeoutMillis: 30000 })',
        },
      ],
    }

    const result = await runObservationPass({
      since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      prDiffs: [pr1, pr2],
      ai: impl,
      scope: PROJECT_SCOPE,
    })

    expect(result.diffsProcessed).toBe(2)
    expect(result.contributed).toBeGreaterThan(0)

    const view = await impl.query({ workType: 'development', scope: PROJECT_SCOPE })
    const allNodes = [...view.patterns, ...view.conventions, ...view.decisions]
    expect(allNodes.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 10. createTestBus
// ---------------------------------------------------------------------------

describe('createTestBus', () => {
  it('delivers events to subscriber', async () => {
    const bus = createTestBus()
    const received: PipelineHookEvent[] = []

    bus.subscribe({}, async (e) => { received.push(e) })

    await bus.emit({ kind: 'test', value: 42 })

    expect(received).toHaveLength(1)
    expect(received[0]!.kind).toBe('test')
  })

  it('unsub removes the handler', async () => {
    const bus = createTestBus()
    const received: PipelineHookEvent[] = []

    const unsub = bus.subscribe({}, async (e) => { received.push(e) })
    unsub()

    await bus.emit({ kind: 'test' })
    expect(received).toHaveLength(0)
  })

  it('clear removes all handlers', async () => {
    const bus = createTestBus()
    const received: PipelineHookEvent[] = []

    bus.subscribe({}, async (e) => { received.push(e) })
    bus.subscribe({}, async (e) => { received.push(e) })
    bus.clear()

    await bus.emit({ kind: 'test' })
    expect(received).toHaveLength(0)
    expect(bus.subscriberCount).toBe(0)
  })
})
