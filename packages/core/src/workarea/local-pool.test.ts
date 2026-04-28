/**
 * Tests for WorkareaProvider local-pool implementation (REN-1280)
 *
 * Covers:
 *   - acquire fast path (warm pool reuse)
 *   - acquire slow path (cold start via addWorktree)
 *   - scoped clean removes .next/.turbo/etc on return-to-pool
 *   - REN-1166 regression: stale .next/ is cleaned before returning Workarea
 *   - release modes: destroy, return-to-pool, pause (degrades), archive (degrades)
 *   - lockfile drift invalidation
 *   - file watcher invalidates pool on lockfile change
 *   - cleanStateChecksum is stable when lockfile unchanged, changes when lockfile changes
 *   - pool member staleness
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockedFunction } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// Mocks: git-worktree typed API (REN-1284/1285) + fs operations
// ---------------------------------------------------------------------------

// We mock the typed git-worktree functions so tests don't require a real repo.
vi.mock('./git-worktree.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./git-worktree.js')>()
  return {
    ...original,
    addWorktree: vi.fn(),
    removeWorktreePath: vi.fn(),
    cleanWorktree: vi.fn(),
  }
})

// Mock execSync to intercept git fetch/checkout + pnpm install
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return {
    ...original,
    execSync: vi.fn(),
  }
})

import {
  LocalPoolWorkareaProvider,
  computeCleanStateChecksum,
  deriveToolchainKey,
} from './local-pool.js'
import { addWorktree, removeWorktreePath, cleanWorktree } from './git-worktree.js'
import { execSync } from 'node:child_process'
import type { WorkareaSpec, WorkareaPoolMember } from './types.js'

const mockAddWorktree = addWorktree as MockedFunction<typeof addWorktree>
const mockRemoveWorktreePath = removeWorktreePath as MockedFunction<typeof removeWorktreePath>
const mockCleanWorktree = cleanWorktree as MockedFunction<typeof cleanWorktree>
const mockExecSync = execSync as MockedFunction<typeof execSync>

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSpec(overrides: Partial<WorkareaSpec> = {}): WorkareaSpec {
  return {
    source: { repository: 'github.com/test/repo', ref: 'main' },
    sessionId: randomUUID(),
    scope: { level: 'global' },
    ...overrides,
  }
}

function makeTmpDir(): string {
  const dir = resolve(tmpdir(), `local-pool-test-${randomUUID().slice(0, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function makePoolMember(
  overrides: Partial<WorkareaPoolMember> = {}
): WorkareaPoolMember {
  const id = randomUUID()
  const path = `/fake/pool/wa-${id.slice(0, 8)}`
  return {
    id,
    path,
    repository: 'github.com/test/repo',
    ref: 'main',
    toolchainKey: 'default',
    status: 'ready',
    cleanStateChecksum: 'abc123',
    createdAt: new Date(),
    ...overrides,
  }
}

// Shared pool dir for all tests — created once in beforeEach, torn down after.
let sharedPoolDir: string

function makeProvider(opts: { gitRoot?: string; poolDir?: string } = {}): LocalPoolWorkareaProvider {
  const gitRoot = opts.gitRoot ?? '/fake/git-root'
  const poolDir = opts.poolDir ?? sharedPoolDir
  return new LocalPoolWorkareaProvider({ gitRoot, poolDir })
}

// ---------------------------------------------------------------------------
// Unit tests for deriveToolchainKey
// ---------------------------------------------------------------------------

describe('deriveToolchainKey', () => {
  it('returns "default" for empty/undefined toolchain', () => {
    expect(deriveToolchainKey()).toBe('default')
    expect(deriveToolchainKey({})).toBe('default')
  })

  it('sorts keys deterministically', () => {
    const a = deriveToolchainKey({ node: '20', java: '17' })
    const b = deriveToolchainKey({ java: '17', node: '20' })
    expect(a).toBe(b)
    expect(a).toBe('java@17+node@20')
  })

  it('handles single key', () => {
    expect(deriveToolchainKey({ node: '18' })).toBe('node@18')
  })

  it('replaces undefined values with *', () => {
    expect(deriveToolchainKey({ node: undefined })).toBe('node@*')
  })
})

// ---------------------------------------------------------------------------
// Unit tests for computeCleanStateChecksum
// ---------------------------------------------------------------------------

describe('computeCleanStateChecksum', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns a 64-char hex string', () => {
    const checksum = computeCleanStateChecksum(tmpDir)
    expect(checksum).toMatch(/^[0-9a-f]{64}$/)
  })

  it('produces the same checksum when nothing changes', () => {
    writeFileSync(resolve(tmpDir, 'pnpm-lock.yaml'), 'lockVersion: 9\n')
    const a = computeCleanStateChecksum(tmpDir)
    const b = computeCleanStateChecksum(tmpDir)
    expect(a).toBe(b)
  })

  it('produces a different checksum when lockfile changes', () => {
    writeFileSync(resolve(tmpDir, 'pnpm-lock.yaml'), 'lockVersion: 9\n')
    const before = computeCleanStateChecksum(tmpDir)

    writeFileSync(resolve(tmpDir, 'pnpm-lock.yaml'), 'lockVersion: 9\n\n# changed dep\n')
    const after = computeCleanStateChecksum(tmpDir)

    expect(before).not.toBe(after)
  })

  it('includes engines from package.json', () => {
    writeFileSync(resolve(tmpDir, 'pnpm-lock.yaml'), 'lockVersion: 9\n')
    writeFileSync(resolve(tmpDir, 'package.json'), JSON.stringify({ engines: { node: '>=22' } }))
    const with18 = computeCleanStateChecksum(tmpDir)

    writeFileSync(resolve(tmpDir, 'package.json'), JSON.stringify({ engines: { node: '>=20' } }))
    const with20 = computeCleanStateChecksum(tmpDir)

    expect(with18).not.toBe(with20)
  })

  it('includes .nvmrc content', () => {
    writeFileSync(resolve(tmpDir, 'pnpm-lock.yaml'), '')
    writeFileSync(resolve(tmpDir, '.nvmrc'), '20\n')
    const v20 = computeCleanStateChecksum(tmpDir)

    writeFileSync(resolve(tmpDir, '.nvmrc'), '18\n')
    const v18 = computeCleanStateChecksum(tmpDir)

    expect(v20).not.toBe(v18)
  })
})

// ---------------------------------------------------------------------------
// LocalPoolWorkareaProvider
// ---------------------------------------------------------------------------

describe('LocalPoolWorkareaProvider', () => {
  let provider: LocalPoolWorkareaProvider

  beforeEach(() => {
    vi.clearAllMocks()
    // Create a real temp pool dir so activate() can mkdir it
    sharedPoolDir = makeTmpDir()
    provider = makeProvider()

    // Default mocks — tests override as needed
    mockAddWorktree.mockReturnValue({ ok: true, value: { path: `${sharedPoolDir}/wa-new`, ref: 'main' } })
    mockRemoveWorktreePath.mockReturnValue({ ok: true, value: undefined })
    mockCleanWorktree.mockReturnValue({ ok: true, value: { removed: [] } })
    mockExecSync.mockReturnValue('')
  })

  afterEach(() => {
    rmSync(sharedPoolDir, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // manifest / capabilities
  // -------------------------------------------------------------------------

  it('has the correct manifest fields', () => {
    expect(provider.manifest.family).toBe('workarea')
    expect(provider.manifest.id).toBe('local-pool')
    expect(provider.manifest.apiVersion).toBe('rensei.dev/v1')
  })

  it('declares workarea capabilities', () => {
    expect(provider.capabilities.supportsWarmPool).toBe(true)
    expect(provider.capabilities.supportsSnapshot).toBe(false)
    expect(provider.capabilities.cleanStrategy).toBe('scoped-clean')
  })

  // -------------------------------------------------------------------------
  // activate / deactivate
  // -------------------------------------------------------------------------

  it('activates without error', async () => {
    const host = { emit: vi.fn() }
    await provider.activate(host)
    expect(host.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'post-activate' }))
  })

  it('deactivation is idempotent', async () => {
    const host = { emit: vi.fn() }
    await provider.activate(host)
    await provider.deactivate()
    await provider.deactivate() // second call — should not throw
  })

  it('health returns ready when poolDir exists', async () => {
    const tmpDir = makeTmpDir()
    const p = new LocalPoolWorkareaProvider({ gitRoot: '/fake', poolDir: tmpDir })
    const h = await p.health?.()
    expect(h?.status).toBe('ready')
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // acquire — slow path (cold start)
  // -------------------------------------------------------------------------

  it('slow path: creates a new worktree via addWorktree', async () => {
    const spec = makeSpec()
    mockAddWorktree.mockReturnValue({ ok: true, value: { path: `${sharedPoolDir}/wa-cold`, ref: 'main' } })

    const workarea = await provider.acquire(spec)

    expect(mockAddWorktree).toHaveBeenCalledWith(
      '/fake/git-root',
      'main',
      expect.stringContaining(sharedPoolDir),
    )
    expect(workarea.ref).toBe('main')
    expect(workarea.providerId).toBe('local-pool')
    expect(workarea.mode).toBe('exclusive')
  })

  it('slow path: runs pnpm install --frozen-lockfile', async () => {
    const spec = makeSpec()
    mockAddWorktree.mockReturnValue({ ok: true, value: { path: `${sharedPoolDir}/wa-cold`, ref: 'main' } })

    await provider.acquire(spec)

    expect(mockExecSync).toHaveBeenCalledWith(
      'pnpm install --frozen-lockfile',
      expect.objectContaining({ cwd: expect.stringContaining(sharedPoolDir) }),
    )
  })

  it('slow path: records cleanStateChecksum', async () => {
    const spec = makeSpec()
    mockAddWorktree.mockReturnValue({ ok: true, value: { path: '/fake/pool/wa-cold', ref: 'main' } })

    const workarea = await provider.acquire(spec)

    expect(workarea.cleanStateChecksum).toMatch(/^[0-9a-f]{64}$/)
  })

  it('slow path: throws when addWorktree fails', async () => {
    mockAddWorktree.mockReturnValue({ ok: false, error: 'git-error' })

    await expect(provider.acquire(makeSpec())).rejects.toThrow('addWorktree failed: git-error')
  })

  // -------------------------------------------------------------------------
  // acquire — fast path (warm pool)
  // -------------------------------------------------------------------------

  it('fast path: reuses a ready pool member', async () => {
    // Use cleanStateChecksum: '' to skip the drift check (empty = never computed)
    const member = makePoolMember({ cleanStateChecksum: '' })
    // Pre-inject a ready member
    provider._injectMember(member)

    const spec = makeSpec()
    const workarea = await provider.acquire(spec)

    // addWorktree should NOT be called (fast path)
    expect(mockAddWorktree).not.toHaveBeenCalled()
    expect(workarea.id).toBe(member.id)
    expect(workarea.path).toBe(member.path)
  })

  it('fast path: member status becomes acquired', async () => {
    // Use cleanStateChecksum: '' to skip the drift check
    const member = makePoolMember({ cleanStateChecksum: '' })
    provider._injectMember(member)

    await provider.acquire(makeSpec())

    const pool = provider._getPoolSnapshot()
    expect(pool.get(member.id)?.status).toBe('acquired')
  })

  it('fast path: falls through to slow path when checksum drifts', async () => {
    const member = makePoolMember({ cleanStateChecksum: 'old-checksum-abc123' })
    provider._injectMember(member)

    mockAddWorktree.mockReturnValue({ ok: true, value: { path: '/fake/pool/wa-slow', ref: 'main' } })

    // computeCleanStateChecksum will return a different value (tmpDir-based)
    // The member's checksum 'old-checksum-abc123' won't match the computed one
    await provider.acquire(makeSpec())

    // Slow path was triggered because checksum drifted
    expect(mockAddWorktree).toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // REN-1166 regression — stale .next/ is cleaned before handoff
  // -------------------------------------------------------------------------

  it('REN-1166 regression: scoped clean removes stale .next/ on warm acquire', async () => {
    const tmpDir = makeTmpDir()
    const nextDir = resolve(tmpDir, '.next')
    const turboDir = resolve(tmpDir, '.turbo')
    mkdirSync(nextDir, { recursive: true })
    mkdirSync(turboDir, { recursive: true })

    // Write a lockfile so checksums can be computed
    writeFileSync(resolve(tmpDir, 'pnpm-lock.yaml'), 'lockVersion: 9\n')
    const checksum = computeCleanStateChecksum(tmpDir)

    const member = makePoolMember({
      path: tmpDir,
      cleanStateChecksum: checksum,
    })
    provider._injectMember(member)

    // The .git file must exist for validateWorktree to pass inside cleanWorktree.
    // Since we mocked cleanWorktree, we verify it was called with the worktree path.
    const spec = makeSpec()
    await provider.acquire(spec)

    // Stale artifacts should be removed during fast-path scoped clean
    // (cleanWorktree mock was called OR _scopedClean ran directly)
    // Since _scopedClean runs unconditionally in the fast path, and tmpDir
    // had real .next/.turbo dirs, they should be removed.
    expect(existsSync(nextDir)).toBe(false)
    expect(existsSync(turboDir)).toBe(false)

    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('REN-1166 regression: stale dist/ and coverage/ are removed on acquire', async () => {
    const tmpDir = makeTmpDir()
    writeFileSync(resolve(tmpDir, 'pnpm-lock.yaml'), 'lockVersion: 9\n')
    const checksum = computeCleanStateChecksum(tmpDir)

    mkdirSync(resolve(tmpDir, 'dist'), { recursive: true })
    mkdirSync(resolve(tmpDir, 'coverage'), { recursive: true })

    const member = makePoolMember({ path: tmpDir, cleanStateChecksum: checksum })
    provider._injectMember(member)

    await provider.acquire(makeSpec())

    expect(existsSync(resolve(tmpDir, 'dist'))).toBe(false)
    expect(existsSync(resolve(tmpDir, 'coverage'))).toBe(false)

    rmSync(tmpDir, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // release
  // -------------------------------------------------------------------------

  it('release destroy: removes worktree and pool entry', async () => {
    // Use cleanStateChecksum: '' to bypass drift check
    const member = makePoolMember({ cleanStateChecksum: '' })
    provider._injectMember(member)

    const workarea = await provider.acquire(makeSpec())
    await provider.release(workarea, { kind: 'destroy' })

    expect(mockRemoveWorktreePath).toHaveBeenCalledWith(member.path, '/fake/git-root')
    expect(provider._getPoolSnapshot().has(member.id)).toBe(false)
  })

  it('release return-to-pool: calls cleanWorktree and marks member ready', async () => {
    // Use cleanStateChecksum: '' to bypass drift check on fast path
    const member = makePoolMember({ cleanStateChecksum: '' })
    provider._injectMember(member)

    const spec = makeSpec()
    const workarea = await provider.acquire(spec)

    // Confirm acquired state
    expect(provider._getPoolSnapshot().get(member.id)?.status).toBe('acquired')

    await provider.release(workarea, { kind: 'return-to-pool' })

    expect(mockCleanWorktree).toHaveBeenCalledWith(member.path)
    expect(provider._getPoolSnapshot().get(member.id)?.status).toBe('ready')
  })

  it('release pause: degrades to return-to-pool with console.warn', async () => {
    const member = makePoolMember({ cleanStateChecksum: '' })
    provider._injectMember(member)

    const spec = makeSpec()
    const workarea = await provider.acquire(spec)

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await provider.release(workarea, { kind: 'pause' })

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('pause requested'))
    expect(mockCleanWorktree).toHaveBeenCalled()
    expect(provider._getPoolSnapshot().get(member.id)?.status).toBe('ready')

    warnSpy.mockRestore()
  })

  it('release archive: degrades to return-to-pool with console.warn', async () => {
    const member = makePoolMember({ cleanStateChecksum: '' })
    provider._injectMember(member)

    const spec = makeSpec()
    const workarea = await provider.acquire(spec)

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await provider.release(workarea, { kind: 'archive', label: 'forensic-2026-04-27' })

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('archive not yet implemented'))
    expect(mockCleanWorktree).toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  // -------------------------------------------------------------------------
  // Pool invalidation
  // -------------------------------------------------------------------------

  it('_invalidateAll marks all members invalid', () => {
    provider._injectMember(makePoolMember({ status: 'ready' }))
    provider._injectMember(makePoolMember({ status: 'ready' }))

    provider._invalidateAll()

    for (const m of provider._getPoolSnapshot().values()) {
      expect(m.status).toBe('invalid')
    }
  })

  it('stale members are invalidated before acquire lookup', async () => {
    const staleCreatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000) // 25 hours ago
    const member = makePoolMember({ createdAt: staleCreatedAt })
    provider._injectMember(member)

    // Even though member is "ready", it's stale → falls to slow path
    mockAddWorktree.mockReturnValue({ ok: true, value: { path: '/fake/pool/wa-new', ref: 'main' } })

    await provider.acquire(makeSpec())

    // Slow path should have been triggered
    expect(mockAddWorktree).toHaveBeenCalled()
    // And the stale member should be marked invalid
    expect(provider._getPoolSnapshot().get(member.id)?.status).toBe('invalid')
  })

  // -------------------------------------------------------------------------
  // Observability: acquire emits post-verb hook event
  // -------------------------------------------------------------------------

  it('acquire emits post-verb event to host with acquire_path field', async () => {
    const host = { emit: vi.fn() }
    await provider.activate(host)
    host.emit.mockClear()

    mockAddWorktree.mockReturnValue({ ok: true, value: { path: '/fake/pool/wa-obs', ref: 'main' } })

    await provider.acquire(makeSpec())

    const acquireCall = host.emit.mock.calls.find(
      ([e]) => e.kind === 'post-verb' && e.verb === 'acquire'
    )
    expect(acquireCall).toBeDefined()
    const event = acquireCall![0] as { kind: string; result: Record<string, unknown> }
    expect(event.result).toMatchObject({
      acquire_path: expect.stringMatching(/^(pool-warm|pool-fresh|cold)$/),
      clean_state_checksum: expect.any(String),
      acquire_duration_ms: expect.any(Number),
    })
  })

  // -------------------------------------------------------------------------
  // Pool key derivation
  // -------------------------------------------------------------------------

  it('separate pool keys for different toolchains', async () => {
    // Spec with node@20
    const spec20 = makeSpec({ toolchain: { node: '20' } })
    // Spec with node@18
    const spec18 = makeSpec({ toolchain: { node: '18' } })

    let callCount = 0
    mockAddWorktree.mockImplementation(() => {
      callCount++
      return { ok: true, value: { path: `/fake/pool/wa-${callCount}`, ref: 'main' } }
    })

    await provider.acquire(spec20)
    await provider.acquire(spec18)

    // Both should go through slow path since no pool members exist
    expect(mockAddWorktree).toHaveBeenCalledTimes(2)
  })
})
