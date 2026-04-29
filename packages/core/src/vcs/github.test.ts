/**
 * GitHubVCSProvider — unit tests
 *
 * Tests:
 * - buildCommitMessageWithTrailers / buildAttestationTrailers
 * - attest() emits correct commit trailers
 * - push() classifies errors correctly
 * - pull() returns correct VCSMergeResult variants
 * - Capability-gated verbs throw UnsupportedOperationError correctly
 * - Constructor hasMergeQueue override
 * - Capability profile matches spec table
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock child_process before imports (same pattern as github-native.test.ts)
// ---------------------------------------------------------------------------

vi.mock('child_process', () => ({
  exec: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}))

import { exec } from 'child_process'
import { writeFile, unlink } from 'node:fs/promises'
import {
  GitHubVCSProvider,
  buildCommitMessageWithTrailers,
  buildAttestationTrailers,
  GITHUB_VCS_CAPABILITIES,
} from './github.js'
import { UnsupportedOperationError } from './types.js'
import type { SessionAttestation, Workspace } from './types.js'

const mockExec = vi.mocked(exec)

// ---------------------------------------------------------------------------
// Mock helpers — callback-based (matches how promisify works)
// ---------------------------------------------------------------------------

type ExecCallback = (err: Error | null, result: { stdout: string; stderr: string }) => void

function mockExecSuccess(stdout = '', stderr = '') {
  mockExec.mockImplementation((_cmd: string, _opts: unknown, callback?: unknown) => {
    const cb: ExecCallback = typeof _opts === 'function'
      ? (_opts as ExecCallback)
      : (callback as ExecCallback)
    cb?.(null, { stdout, stderr })
    return {} as ReturnType<typeof exec>
  })
}

function mockExecFailure(message: string) {
  mockExec.mockImplementation((_cmd: string, _opts: unknown, callback?: unknown) => {
    const cb: ExecCallback = typeof _opts === 'function'
      ? (_opts as ExecCallback)
      : (callback as ExecCallback)
    cb?.(new Error(message), { stdout: '', stderr: message })
    return {} as ReturnType<typeof exec>
  })
}

function mockExecSequence(
  responses: Array<{ success: boolean; stdout?: string; error?: string }>,
) {
  let callIndex = 0
  mockExec.mockImplementation((_cmd: string, _opts: unknown, callback?: unknown) => {
    const cb: ExecCallback = typeof _opts === 'function'
      ? (_opts as ExecCallback)
      : (callback as ExecCallback)
    const response = responses[callIndex++] ?? { success: true, stdout: '' }
    if (response.success) {
      cb?.(null, { stdout: response.stdout ?? '', stderr: '' })
    } else {
      cb?.(new Error(response.error ?? 'unknown error'), { stdout: '', stderr: response.error ?? '' })
    }
    return {} as ReturnType<typeof exec>
  })
}

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'github:github.com/org/repo',
    providerId: 'github',
    path: '/tmp/test-workspace',
    headRef: 'abc123',
    ...overrides,
  }
}

function makeAttestation(overrides: Partial<SessionAttestation> = {}): SessionAttestation {
  return {
    agentId: 'agent-001',
    modelRef: { provider: 'anthropic', model: 'claude-opus-4-7' },
    sessionId: 'sess-xyz',
    kitIds: [{ id: 'spring/java', version: '1.0.0' }],
    startedAt: new Date('2026-04-27T00:00:00Z'),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// buildAttestationTrailers
// ---------------------------------------------------------------------------

describe('buildAttestationTrailers', () => {
  it('includes Co-Authored-By trailer', () => {
    const trailers = buildAttestationTrailers(makeAttestation())
    expect(trailers).toContain('Co-Authored-By: agent-001 <agent@rensei.dev>')
  })

  it('includes X-Rensei-Session-Id trailer', () => {
    const trailers = buildAttestationTrailers(makeAttestation())
    expect(trailers).toContain('X-Rensei-Session-Id: sess-xyz')
  })

  it('includes X-Rensei-Model trailer', () => {
    const trailers = buildAttestationTrailers(makeAttestation())
    expect(trailers).toContain('X-Rensei-Model: anthropic/claude-opus-4-7')
  })

  it('includes X-Rensei-Kit-Set trailer when kitIds are present', () => {
    const trailers = buildAttestationTrailers(makeAttestation({
      kitIds: [
        { id: 'spring/java', version: '1.0.0' },
        { id: 'docker-compose', version: '2.1.0' },
      ],
    }))
    expect(trailers).toContain('X-Rensei-Kit-Set: spring/java@1.0.0,docker-compose@2.1.0')
  })

  it('omits X-Rensei-Kit-Set when kitIds is empty', () => {
    const trailers = buildAttestationTrailers(makeAttestation({ kitIds: [] }))
    expect(trailers).not.toContain('X-Rensei-Kit-Set')
  })

  it('includes X-Rensei-Workarea-Snapshot when present', () => {
    const trailers = buildAttestationTrailers(makeAttestation({
      workareaSnapshotRef: { ref: 'snap-abc', providerId: 'workarea-1' },
    }))
    expect(trailers).toContain('X-Rensei-Workarea-Snapshot: snap-abc')
  })

  it('omits X-Rensei-Workarea-Snapshot when absent', () => {
    const trailers = buildAttestationTrailers(makeAttestation({ workareaSnapshotRef: undefined }))
    expect(trailers).not.toContain('X-Rensei-Workarea-Snapshot')
  })

  it('includes X-Rensei-Signed-By when signedBy is present', () => {
    const trailers = buildAttestationTrailers(makeAttestation({ signedBy: 'did:key:z6Mk...' }))
    expect(trailers).toContain('X-Rensei-Signed-By: did:key:z6Mk...')
  })
})

// ---------------------------------------------------------------------------
// buildCommitMessageWithTrailers
// ---------------------------------------------------------------------------

describe('buildCommitMessageWithTrailers', () => {
  it('appends trailers after a blank line separator', () => {
    const msg = buildCommitMessageWithTrailers('fix: my commit', makeAttestation())
    // Should contain blank line between subject and trailers
    expect(msg).toContain('\n\nCo-Authored-By:')
  })

  it('preserves the original commit message', () => {
    const msg = buildCommitMessageWithTrailers('chore: update deps', makeAttestation())
    expect(msg.startsWith('chore: update deps')).toBe(true)
  })

  it('produces a string containing session id trailer', () => {
    const msg = buildCommitMessageWithTrailers('feat: vcs abstraction', makeAttestation({
      sessionId: 'test-session-123',
    }))
    expect(msg).toContain('X-Rensei-Session-Id: test-session-123')
  })
})

// ---------------------------------------------------------------------------
// GitHubVCSProvider — construction
// ---------------------------------------------------------------------------

describe('GitHubVCSProvider constructor', () => {
  it('defaults to hasMergeQueue = true', () => {
    const provider = new GitHubVCSProvider()
    expect(provider.capabilities.hasMergeQueue).toBe(true)
  })

  it('respects hasMergeQueue = false override', () => {
    const provider = new GitHubVCSProvider({ hasMergeQueue: false })
    expect(provider.capabilities.hasMergeQueue).toBe(false)
  })

  it('exposes vcs family manifest', () => {
    const provider = new GitHubVCSProvider()
    expect(provider.manifest.family).toBe('vcs')
    expect(provider.manifest.id).toBe('github')
    expect(provider.manifest.apiVersion).toBe('rensei.dev/v1')
  })

  it('has null signature by default', () => {
    const provider = new GitHubVCSProvider()
    expect(provider.signature).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Capability profile — GitHub matches spec table
// ---------------------------------------------------------------------------

describe('GitHub capability profile', () => {
  it('declares three-way-text merge strategy', () => {
    expect(GITHUB_VCS_CAPABILITIES.mergeStrategy).toBe('three-way-text')
  })

  it('declares line-level conflict granularity', () => {
    expect(GITHUB_VCS_CAPABILITIES.conflictGranularity).toBe('line')
  })

  it('declares hasPullRequests = true', () => {
    expect(GITHUB_VCS_CAPABILITIES.hasPullRequests).toBe(true)
  })

  it('declares hasMergeQueue = true', () => {
    expect(GITHUB_VCS_CAPABILITIES.hasMergeQueue).toBe(true)
  })

  it('declares provenanceNative = false (trailers, not native)', () => {
    expect(GITHUB_VCS_CAPABILITIES.provenanceNative).toBe(false)
  })

  it('declares email identity scheme', () => {
    expect(GITHUB_VCS_CAPABILITIES.identityScheme).toBe('email')
  })

  // ── REN-1343 corpus-008 surface ─────────────────────────────────────────
  it('declares mergeModel = three-way-text (corpus-008 alias of mergeStrategy)', () => {
    expect(GITHUB_VCS_CAPABILITIES.mergeModel).toBe('three-way-text')
    expect(GITHUB_VCS_CAPABILITIES.mergeModel).toBe(GITHUB_VCS_CAPABILITIES.mergeStrategy)
  })

  it('declares patchModel = commit-graph', () => {
    expect(GITHUB_VCS_CAPABILITIES.patchModel).toBe('commit-graph')
  })

  it('declares branchSemantics = git-branches', () => {
    expect(GITHUB_VCS_CAPABILITIES.branchSemantics).toBe('git-branches')
  })

  it('declares auditModel = commit-trailer (git fakes attestation via trailers)', () => {
    expect(GITHUB_VCS_CAPABILITIES.auditModel).toBe('commit-trailer')
  })

  it('declares supportsAttest = true (every shipped adapter supports attest)', () => {
    expect(GITHUB_VCS_CAPABILITIES.supportsAttest).toBe(true)
  })

  it('declares remoteProtocol = git-smart-http', () => {
    expect(GITHUB_VCS_CAPABILITIES.remoteProtocol).toBe('git-smart-http')
  })

  it('declares supportsRebase = true', () => {
    expect(GITHUB_VCS_CAPABILITIES.supportsRebase).toBe(true)
  })

  it('declares supportsBranches = true', () => {
    expect(GITHUB_VCS_CAPABILITIES.supportsBranches).toBe(true)
  })

  it('declares supportsBinary = true', () => {
    expect(GITHUB_VCS_CAPABILITIES.supportsBinary).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Capability-gated optional verbs throw when capability is false
// ---------------------------------------------------------------------------

describe('capability-gated verbs', () => {
  let provider: GitHubVCSProvider

  beforeEach(() => {
    // Provider with both hasPullRequests and hasMergeQueue = false
    provider = new GitHubVCSProvider({ hasMergeQueue: false })
    // Manually override hasPullRequests for testing
    ;(provider as any).capabilities = {
      ...GITHUB_VCS_CAPABILITIES,
      hasPullRequests: false,
      hasMergeQueue: false,
    }
  })

  it('openProposal throws UnsupportedOperationError when hasPullRequests = false', async () => {
    const ws = makeWorkspace()
    await expect(
      provider.openProposal!(ws, { title: 'test', body: 'body', baseRef: 'main' })
    ).rejects.toThrowError(UnsupportedOperationError)
  })

  it('mergeProposal throws UnsupportedOperationError when hasPullRequests = false', async () => {
    const ref = { id: '42', url: 'https://github.com/org/repo/pull/42', state: 'open' as const }
    await expect(
      provider.mergeProposal!(ref, 'auto')
    ).rejects.toThrowError(UnsupportedOperationError)
  })

  it('enqueueForMerge throws UnsupportedOperationError when hasMergeQueue = false', async () => {
    const ref = { id: '42', url: 'https://github.com/org/repo/pull/42', state: 'open' as const }
    await expect(
      provider.enqueueForMerge!(ref, {})
    ).rejects.toThrowError(UnsupportedOperationError)
  })
})

// ---------------------------------------------------------------------------
// GitHubVCSProvider.push()
// ---------------------------------------------------------------------------

describe('GitHubVCSProvider.push()', () => {
  let provider: GitHubVCSProvider

  beforeEach(() => {
    provider = new GitHubVCSProvider()
    vi.clearAllMocks()
  })

  it('returns { kind: "pushed" } on success', async () => {
    mockExecSequence([
      { success: true, stdout: 'def456\n' }, // git rev-parse HEAD
      { success: true, stdout: '' },          // git push
    ])

    const result = await provider.push(makeWorkspace(), { remote: 'origin', ref: 'main' })
    expect(result.kind).toBe('pushed')
    if (result.kind === 'pushed') {
      expect(result.ref.ref).toBe('def456')
    }
  })

  it('returns { kind: "rejected", reason: "non-fast-forward" } on rejected push', async () => {
    mockExecSequence([
      { success: true, stdout: 'abc\n' },
      { success: false, error: '! [rejected] main -> main (non-fast-forward)' },
    ])

    const result = await provider.push(makeWorkspace(), { remote: 'origin', ref: 'main' })
    expect(result.kind).toBe('rejected')
    if (result.kind === 'rejected') {
      expect(result.reason).toBe('non-fast-forward')
    }
  })

  it('returns { kind: "rejected", reason: "auth" } on auth failure', async () => {
    mockExecSequence([
      { success: true, stdout: 'abc\n' },
      { success: false, error: 'Permission denied (publickey)' },
    ])

    const result = await provider.push(makeWorkspace(), { remote: 'origin', ref: 'main' })
    expect(result.kind).toBe('rejected')
    if (result.kind === 'rejected') {
      expect(result.reason).toBe('auth')
    }
  })

  it('returns { kind: "rejected", reason: "policy" } on policy failure', async () => {
    mockExecSequence([
      { success: true, stdout: 'abc\n' },
      { success: false, error: 'remote: Push rejected by repository policy' },
    ])

    const result = await provider.push(makeWorkspace(), { remote: 'origin', ref: 'main' })
    expect(result.kind).toBe('rejected')
    if (result.kind === 'rejected') {
      expect(result.reason).toBe('policy')
    }
  })
})

// ---------------------------------------------------------------------------
// GitHubVCSProvider.pull()
// ---------------------------------------------------------------------------

describe('GitHubVCSProvider.pull()', () => {
  let provider: GitHubVCSProvider

  beforeEach(() => {
    provider = new GitHubVCSProvider()
    vi.clearAllMocks()
  })

  it('returns { kind: "clean" } on successful pull', async () => {
    mockExecSuccess('', '')

    const result = await provider.pull(makeWorkspace(), { remote: 'origin', ref: 'main' })
    expect(result.kind).toBe('clean')
  })

  it('returns { kind: "conflict" } when git reports CONFLICT', async () => {
    mockExecSequence([
      { success: false, error: 'CONFLICT (content): Merge conflict in src/index.ts' },
      { success: true, stdout: 'src/index.ts\n' }, // git diff --name-only --diff-filter=U
    ])

    const result = await provider.pull(makeWorkspace(), { remote: 'origin', ref: 'main' })
    expect(result.kind).toBe('conflict')
    if (result.kind === 'conflict') {
      expect(result.conflicts.length).toBeGreaterThan(0)
    }
  })

  it('returns { kind: "conflict" } when git reports Automatic merge failed', async () => {
    mockExecSequence([
      { success: false, error: 'Automatic merge failed; fix conflicts and then commit the result.' },
      { success: true, stdout: 'src/foo.ts\n' },
    ])

    const result = await provider.pull(makeWorkspace(), { remote: 'origin', ref: 'main' })
    expect(result.kind).toBe('conflict')
  })

  it('rethrows unexpected errors', async () => {
    mockExecFailure('network error: connection refused')

    await expect(
      provider.pull(makeWorkspace(), { remote: 'origin', ref: 'main' })
    ).rejects.toThrow('network error')
  })
})

// ---------------------------------------------------------------------------
// GitHubVCSProvider.attest() — commit trailer emission
// ---------------------------------------------------------------------------

describe('GitHubVCSProvider.attest()', () => {
  let provider: GitHubVCSProvider

  beforeEach(() => {
    provider = new GitHubVCSProvider()
    vi.clearAllMocks()
    vi.mocked(writeFile).mockResolvedValue(undefined)
    vi.mocked(unlink).mockResolvedValue(undefined)
  })

  it('creates an attestation commit and returns a commit-trailer ref', async () => {
    mockExecSequence([
      { success: true, stdout: '' },         // git commit --allow-empty
      { success: true, stdout: 'deadbeef\n' }, // git rev-parse HEAD
    ])

    const ref = await provider.attest!(makeWorkspace(), makeAttestation())

    expect(ref.storageKind).toBe('commit-trailer')
    expect(ref.id).toBe('deadbeef')
    expect(ref.attestedAt).toBeTruthy()
  })

  it('writes session id into the commit message file', async () => {
    mockExecSequence([
      { success: true, stdout: '' },
      { success: true, stdout: 'sha1\n' },
    ])

    await provider.attest!(makeWorkspace(), makeAttestation({ sessionId: 'my-session' }))

    // The writeFile call should have included the session id
    const writeFileCall = vi.mocked(writeFile).mock.calls[0]
    const writtenContent = writeFileCall[1] as string
    expect(writtenContent).toContain('X-Rensei-Session-Id: my-session')
  })

  it('writes model ref into the commit message file', async () => {
    mockExecSequence([
      { success: true, stdout: '' },
      { success: true, stdout: 'sha1\n' },
    ])

    await provider.attest!(makeWorkspace(), makeAttestation({
      modelRef: { provider: 'anthropic', model: 'claude-opus-4-7' },
    }))

    const writtenContent = vi.mocked(writeFile).mock.calls[0][1] as string
    expect(writtenContent).toContain('X-Rensei-Model: anthropic/claude-opus-4-7')
  })
})

// ---------------------------------------------------------------------------
// GitHubVCSProvider.activate()
// ---------------------------------------------------------------------------

describe('GitHubVCSProvider.activate()', () => {
  it('calls git --version to verify git is available', async () => {
    const provider = new GitHubVCSProvider()
    vi.clearAllMocks()
    mockExecSuccess('git version 2.40.0\n', '')

    const host = { emit: vi.fn() }
    await expect(provider.activate(host)).resolves.toBeUndefined()
    expect(mockExec).toHaveBeenCalledWith(
      'git --version',
      expect.any(Object),
      expect.any(Function),
    )
  })

  it('throws when git is not available', async () => {
    const provider = new GitHubVCSProvider()
    vi.clearAllMocks()
    mockExecFailure('command not found: git')

    const host = { emit: vi.fn() }
    await expect(provider.activate(host)).rejects.toThrow('git CLI not found')
  })
})
