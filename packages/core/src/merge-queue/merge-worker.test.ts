import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('child_process', () => ({
  exec: vi.fn(),
}))

vi.mock('./strategies/index.js', () => ({
  createMergeStrategy: vi.fn(),
}))

vi.mock('./conflict-resolver.js', () => ({
  ConflictResolver: vi.fn(),
}))

vi.mock('./lock-file-regeneration.js', () => ({
  LockFileRegeneration: vi.fn(),
}))

import { exec } from 'child_process'
import { createMergeStrategy } from './strategies/index.js'
import { ConflictResolver } from './conflict-resolver.js'
import { LockFileRegeneration } from './lock-file-regeneration.js'
import { MergeWorker } from './merge-worker.js'
import type { MergeWorkerConfig, MergeWorkerDeps } from './merge-worker.js'

const mockExec = vi.mocked(exec)
const mockCreateMergeStrategy = vi.mocked(createMergeStrategy)
const MockConflictResolver = vi.mocked(ConflictResolver)
const MockLockFileRegeneration = vi.mocked(LockFileRegeneration)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<MergeWorkerConfig> = {}): MergeWorkerConfig {
  return {
    repoId: 'repo-1',
    repoPath: '/repo',
    strategy: 'rebase',
    testCommand: 'pnpm test',
    testTimeout: 300_000,
    lockFileRegenerate: true,
    mergiraf: true,
    pollInterval: 1000,
    maxRetries: 2,
    escalation: {
      onConflict: 'reassign',
      onTestFailure: 'notify',
    },
    deleteBranchOnMerge: true,
    packageManager: 'pnpm',
    remote: 'origin',
    targetBranch: 'main',
    ...overrides,
  }
}

function makeDeps(overrides: Partial<MergeWorkerDeps> = {}): MergeWorkerDeps {
  return {
    storage: {
      dequeue: vi.fn().mockResolvedValue(null),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
      markBlocked: vi.fn().mockResolvedValue(undefined),
      peekAll: vi.fn().mockResolvedValue([]),
      dequeueBatch: vi.fn().mockResolvedValue([]),
    },
    redis: {
      setNX: vi.fn().mockResolvedValue(true),
      del: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      expire: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  }
}

function makeEntry(overrides: Partial<{
  prNumber: number
  sourceBranch: string
  targetBranch: string
  issueIdentifier: string
  prUrl: string
}> = {}) {
  return {
    prNumber: 42,
    sourceBranch: 'feature/SUP-100',
    targetBranch: 'main',
    issueIdentifier: 'SUP-100',
    prUrl: 'https://github.com/org/repo/pull/42',
    ...overrides,
  }
}

function makeMockStrategy() {
  return {
    name: 'rebase' as const,
    prepare: vi.fn().mockResolvedValue({ success: true, headSha: 'abc123' }),
    execute: vi.fn().mockResolvedValue({ status: 'success', mergedSha: 'def456' }),
    finalize: vi.fn().mockResolvedValue(undefined),
  }
}

function mockExecSuccess() {
  mockExec.mockImplementation((_cmd: string, _opts: unknown, callback?: Function) => {
    const cb = typeof _opts === 'function' ? _opts : callback
    cb?.(null, { stdout: '', stderr: '' })
    return {} as ReturnType<typeof exec>
  })
}

function mockExecFailure(errorMsg: string, stdout = '') {
  mockExec.mockImplementation((_cmd: string, _opts: unknown, callback?: Function) => {
    const cb = typeof _opts === 'function' ? _opts : callback
    const error = Object.assign(new Error(errorMsg), { stdout })
    cb?.(error, { stdout, stderr: '' })
    return {} as ReturnType<typeof exec>
  })
}

/**
 * Mock exec that routes by command substring.
 */
function mockExecByCommand(routes: Record<string, { stdout?: string; stderr?: string; error?: Error }>) {
  mockExec.mockImplementation((cmd: string, _opts: unknown, callback?: Function) => {
    const cb = typeof _opts === 'function' ? _opts : callback
    const cmdStr = typeof cmd === 'string' ? cmd : ''
    const route = Object.entries(routes).find(([pattern]) => cmdStr.includes(pattern))
    if (route) {
      const [, response] = route
      if (response.error) {
        cb?.(response.error, { stdout: response.stdout ?? '', stderr: response.stderr ?? '' })
      } else {
        cb?.(null, { stdout: response.stdout ?? '', stderr: response.stderr ?? '' })
      }
    } else {
      cb?.(null, { stdout: '', stderr: '' })
    }
    return {} as ReturnType<typeof exec>
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MergeWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // -------------------------------------------------------------------------
  // processEntry: successful merge flow
  // -------------------------------------------------------------------------

  describe('processEntry', () => {
    it('successful merge flow: prepare -> execute -> test -> finalize', async () => {
      vi.useRealTimers()
      const config = makeConfig()
      const deps = makeDeps()
      const worker = new MergeWorker(config, deps)
      const entry = makeEntry()

      const mockStrategy = makeMockStrategy()
      mockCreateMergeStrategy.mockReturnValue(mockStrategy)
      MockConflictResolver.mockImplementation(() => ({
        resolve: vi.fn(),
      }) as any)
      MockLockFileRegeneration.mockImplementation(() => ({
        shouldRegenerate: vi.fn().mockReturnValue(false),
        regenerate: vi.fn(),
        getLockFileName: vi.fn(),
        ensureGitAttributes: vi.fn(),
      }) as any)

      // Test command succeeds
      mockExecSuccess()

      const result = await worker.processEntry(entry)

      expect(result.status).toBe('merged')
      expect(result.prNumber).toBe(42)
      expect(mockStrategy.prepare).toHaveBeenCalledOnce()
      expect(mockStrategy.execute).toHaveBeenCalledOnce()
      expect(mockStrategy.finalize).toHaveBeenCalledOnce()
      // createMergeStrategy called with the configured strategy
      expect(mockCreateMergeStrategy).toHaveBeenCalledWith('rebase')
    })

    it('prepare failure returns error', async () => {
      vi.useRealTimers()
      const config = makeConfig()
      const deps = makeDeps()
      const worker = new MergeWorker(config, deps)
      const entry = makeEntry()

      const mockStrategy = makeMockStrategy()
      mockStrategy.prepare.mockResolvedValue({ success: false, error: 'Could not fetch remote' })
      mockCreateMergeStrategy.mockReturnValue(mockStrategy)
      MockConflictResolver.mockImplementation(() => ({ resolve: vi.fn() }) as any)
      MockLockFileRegeneration.mockImplementation(() => ({
        shouldRegenerate: vi.fn().mockReturnValue(false),
        regenerate: vi.fn(),
        getLockFileName: vi.fn(),
        ensureGitAttributes: vi.fn(),
      }) as any)

      const result = await worker.processEntry(entry)

      expect(result.status).toBe('error')
      expect(result.message).toContain('Prepare failed')
      expect(result.message).toContain('Could not fetch remote')
      expect(mockStrategy.execute).not.toHaveBeenCalled()
      expect(mockStrategy.finalize).not.toHaveBeenCalled()
    })

    it('merge conflict triggers ConflictResolver', async () => {
      vi.useRealTimers()
      const config = makeConfig()
      const deps = makeDeps()
      const worker = new MergeWorker(config, deps)
      const entry = makeEntry()

      const mockStrategy = makeMockStrategy()
      mockStrategy.execute.mockResolvedValue({
        status: 'conflict',
        conflictFiles: ['src/index.ts'],
        conflictDetails: 'Conflict in src/index.ts',
      })
      mockCreateMergeStrategy.mockReturnValue(mockStrategy)

      const mockResolve = vi.fn().mockResolvedValue({
        status: 'escalated',
        method: 'escalation',
        unresolvedFiles: ['src/index.ts'],
        message: 'Conflict on PR #42',
      })
      MockConflictResolver.mockImplementation(() => ({
        resolve: mockResolve,
      }) as any)
      MockLockFileRegeneration.mockImplementation(() => ({
        shouldRegenerate: vi.fn().mockReturnValue(false),
        regenerate: vi.fn(),
        getLockFileName: vi.fn(),
        ensureGitAttributes: vi.fn(),
      }) as any)

      const result = await worker.processEntry(entry)

      expect(result.status).toBe('conflict')
      expect(result.message).toBe('Conflict on PR #42')
      expect(mockResolve).toHaveBeenCalledOnce()
      // Verify the conflict context passed to the resolver
      expect(mockResolve).toHaveBeenCalledWith(expect.objectContaining({
        repoPath: '/repo',
        sourceBranch: 'feature/SUP-100',
        targetBranch: 'main',
        prNumber: 42,
        issueIdentifier: 'SUP-100',
        conflictFiles: ['src/index.ts'],
      }))
    })

    it('resolved conflict continues to test and finalize', async () => {
      vi.useRealTimers()
      const config = makeConfig()
      const deps = makeDeps()
      const worker = new MergeWorker(config, deps)
      const entry = makeEntry()

      const mockStrategy = makeMockStrategy()
      mockStrategy.execute.mockResolvedValue({
        status: 'conflict',
        conflictFiles: ['src/index.ts'],
      })
      mockCreateMergeStrategy.mockReturnValue(mockStrategy)

      const mockResolve = vi.fn().mockResolvedValue({
        status: 'resolved',
        method: 'mergiraf',
        resolvedFiles: ['src/index.ts'],
      })
      MockConflictResolver.mockImplementation(() => ({
        resolve: mockResolve,
      }) as any)
      MockLockFileRegeneration.mockImplementation(() => ({
        shouldRegenerate: vi.fn().mockReturnValue(false),
        regenerate: vi.fn(),
        getLockFileName: vi.fn(),
        ensureGitAttributes: vi.fn(),
      }) as any)

      // Test command succeeds
      mockExecSuccess()

      const result = await worker.processEntry(entry)

      // Should continue past conflict resolution to test and finalize
      expect(result.status).toBe('merged')
      expect(mockStrategy.finalize).toHaveBeenCalledOnce()
    })

    it('unresolved conflict returns conflict status', async () => {
      vi.useRealTimers()
      const config = makeConfig()
      const deps = makeDeps()
      const worker = new MergeWorker(config, deps)
      const entry = makeEntry()

      const mockStrategy = makeMockStrategy()
      mockStrategy.execute.mockResolvedValue({
        status: 'conflict',
        conflictFiles: ['src/a.ts', 'src/b.ts'],
      })
      mockCreateMergeStrategy.mockReturnValue(mockStrategy)

      const mockResolve = vi.fn().mockResolvedValue({
        status: 'parked',
        method: 'escalation',
        unresolvedFiles: ['src/a.ts', 'src/b.ts'],
        message: 'Parked due to conflicts',
      })
      MockConflictResolver.mockImplementation(() => ({
        resolve: mockResolve,
      }) as any)
      MockLockFileRegeneration.mockImplementation(() => ({
        shouldRegenerate: vi.fn().mockReturnValue(false),
        regenerate: vi.fn(),
        getLockFileName: vi.fn(),
        ensureGitAttributes: vi.fn(),
      }) as any)

      const result = await worker.processEntry(entry)

      expect(result.status).toBe('conflict')
      expect(result.message).toBe('Parked due to conflicts')
      // Should NOT proceed to test or finalize
      expect(mockStrategy.finalize).not.toHaveBeenCalled()
    })

    it('lock file regeneration runs when configured', async () => {
      vi.useRealTimers()
      const config = makeConfig({ lockFileRegenerate: true, packageManager: 'pnpm' })
      const deps = makeDeps()
      const worker = new MergeWorker(config, deps)
      const entry = makeEntry()

      const mockStrategy = makeMockStrategy()
      mockCreateMergeStrategy.mockReturnValue(mockStrategy)
      MockConflictResolver.mockImplementation(() => ({ resolve: vi.fn() }) as any)

      const mockShouldRegenerate = vi.fn().mockReturnValue(true)
      const mockRegenerate = vi.fn().mockResolvedValue({ success: true, lockFile: 'pnpm-lock.yaml', packageManager: 'pnpm' })
      MockLockFileRegeneration.mockImplementation(() => ({
        shouldRegenerate: mockShouldRegenerate,
        regenerate: mockRegenerate,
        getLockFileName: vi.fn(),
        ensureGitAttributes: vi.fn(),
      }) as any)

      mockExecSuccess()

      const result = await worker.processEntry(entry)

      expect(result.status).toBe('merged')
      expect(mockShouldRegenerate).toHaveBeenCalledWith('pnpm', true)
      expect(mockRegenerate).toHaveBeenCalledWith('/repo', 'pnpm')
    })

    it('lock file regeneration failure returns error', async () => {
      vi.useRealTimers()
      const config = makeConfig({ lockFileRegenerate: true, packageManager: 'pnpm' })
      const deps = makeDeps()
      const worker = new MergeWorker(config, deps)
      const entry = makeEntry()

      const mockStrategy = makeMockStrategy()
      mockCreateMergeStrategy.mockReturnValue(mockStrategy)
      MockConflictResolver.mockImplementation(() => ({ resolve: vi.fn() }) as any)

      MockLockFileRegeneration.mockImplementation(() => ({
        shouldRegenerate: vi.fn().mockReturnValue(true),
        regenerate: vi.fn().mockResolvedValue({
          success: false,
          lockFile: 'pnpm-lock.yaml',
          packageManager: 'pnpm',
          error: 'pnpm install failed: ENOENT',
        }),
        getLockFileName: vi.fn(),
        ensureGitAttributes: vi.fn(),
      }) as any)

      const result = await worker.processEntry(entry)

      expect(result.status).toBe('error')
      expect(result.message).toContain('Lock file regeneration failed')
      expect(result.message).toContain('pnpm install failed: ENOENT')
      expect(mockStrategy.finalize).not.toHaveBeenCalled()
    })

    it('test failure returns test-failure status', async () => {
      vi.useRealTimers()
      const config = makeConfig()
      const deps = makeDeps()
      const worker = new MergeWorker(config, deps)
      const entry = makeEntry()

      const mockStrategy = makeMockStrategy()
      mockCreateMergeStrategy.mockReturnValue(mockStrategy)
      MockConflictResolver.mockImplementation(() => ({ resolve: vi.fn() }) as any)
      MockLockFileRegeneration.mockImplementation(() => ({
        shouldRegenerate: vi.fn().mockReturnValue(false),
        regenerate: vi.fn(),
        getLockFileName: vi.fn(),
        ensureGitAttributes: vi.fn(),
      }) as any)

      // Test command fails
      mockExecFailure('Test failed: 3 tests failed', 'FAIL src/index.test.ts')

      const result = await worker.processEntry(entry)

      expect(result.status).toBe('test-failure')
      expect(result.message).toContain('FAIL src/index.test.ts')
      expect(mockStrategy.finalize).not.toHaveBeenCalled()
    })

    it('test timeout handled', async () => {
      vi.useRealTimers()
      const config = makeConfig({ testTimeout: 5000 })
      const deps = makeDeps()
      const worker = new MergeWorker(config, deps)
      const entry = makeEntry()

      const mockStrategy = makeMockStrategy()
      mockCreateMergeStrategy.mockReturnValue(mockStrategy)
      MockConflictResolver.mockImplementation(() => ({ resolve: vi.fn() }) as any)
      MockLockFileRegeneration.mockImplementation(() => ({
        shouldRegenerate: vi.fn().mockReturnValue(false),
        regenerate: vi.fn(),
        getLockFileName: vi.fn(),
        ensureGitAttributes: vi.fn(),
      }) as any)

      // Simulate timeout error — exec rejects with a timeout error
      mockExec.mockImplementation((cmd: string, _opts: unknown, callback?: Function) => {
        const cb = typeof _opts === 'function' ? _opts : callback
        const cmdStr = typeof cmd === 'string' ? cmd : ''
        if (cmdStr.includes('pnpm test')) {
          const error = Object.assign(new Error('Command timed out'), { killed: true, signal: 'SIGTERM' })
          cb?.(error, { stdout: '', stderr: '' })
        } else {
          cb?.(null, { stdout: '', stderr: '' })
        }
        return {} as ReturnType<typeof exec>
      })

      const result = await worker.processEntry(entry)

      expect(result.status).toBe('test-failure')
      expect(result.message).toContain('Command timed out')
      expect(mockStrategy.finalize).not.toHaveBeenCalled()
    })

    it('finalize pushes and merges', async () => {
      vi.useRealTimers()
      const config = makeConfig({ deleteBranchOnMerge: false })
      const deps = makeDeps()
      const worker = new MergeWorker(config, deps)
      const entry = makeEntry()

      const mockStrategy = makeMockStrategy()
      mockCreateMergeStrategy.mockReturnValue(mockStrategy)
      MockConflictResolver.mockImplementation(() => ({ resolve: vi.fn() }) as any)
      MockLockFileRegeneration.mockImplementation(() => ({
        shouldRegenerate: vi.fn().mockReturnValue(false),
        regenerate: vi.fn(),
        getLockFileName: vi.fn(),
        ensureGitAttributes: vi.fn(),
      }) as any)

      mockExecSuccess()

      const result = await worker.processEntry(entry)

      expect(result.status).toBe('merged')
      expect(mockStrategy.finalize).toHaveBeenCalledWith(expect.objectContaining({
        repoPath: '/repo',
        sourceBranch: 'feature/SUP-100',
        targetBranch: 'main',
        remote: 'origin',
      }))
    })

    it('branch deletion when configured', async () => {
      vi.useRealTimers()
      const config = makeConfig({ deleteBranchOnMerge: true })
      const deps = makeDeps()
      const worker = new MergeWorker(config, deps)
      const entry = makeEntry()

      const mockStrategy = makeMockStrategy()
      mockCreateMergeStrategy.mockReturnValue(mockStrategy)
      MockConflictResolver.mockImplementation(() => ({ resolve: vi.fn() }) as any)
      MockLockFileRegeneration.mockImplementation(() => ({
        shouldRegenerate: vi.fn().mockReturnValue(false),
        regenerate: vi.fn(),
        getLockFileName: vi.fn(),
        ensureGitAttributes: vi.fn(),
      }) as any)

      mockExecByCommand({
        'git push origin --delete feature/SUP-100': { stdout: '' },
        'pnpm test': { stdout: 'All tests passed' },
      })

      const result = await worker.processEntry(entry)

      expect(result.status).toBe('merged')
      // Verify git push --delete was called
      const deleteCalls = mockExec.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('git push') && call[0].includes('--delete'),
      )
      expect(deleteCalls).toHaveLength(1)
      expect(deleteCalls[0][0]).toContain('feature/SUP-100')
    })

    it('branch deletion failure is non-fatal', async () => {
      vi.useRealTimers()
      const config = makeConfig({ deleteBranchOnMerge: true })
      const deps = makeDeps()
      const worker = new MergeWorker(config, deps)
      const entry = makeEntry()

      const mockStrategy = makeMockStrategy()
      mockCreateMergeStrategy.mockReturnValue(mockStrategy)
      MockConflictResolver.mockImplementation(() => ({ resolve: vi.fn() }) as any)
      MockLockFileRegeneration.mockImplementation(() => ({
        shouldRegenerate: vi.fn().mockReturnValue(false),
        regenerate: vi.fn(),
        getLockFileName: vi.fn(),
        ensureGitAttributes: vi.fn(),
      }) as any)

      // Branch deletion fails but test passes
      mockExecByCommand({
        'git push origin --delete': { error: new Error('remote ref does not exist') },
        'pnpm test': { stdout: 'All tests passed' },
      })

      const result = await worker.processEntry(entry)

      // Should still succeed despite branch deletion failure
      expect(result.status).toBe('merged')
    })

    it('merge strategy error returns error status', async () => {
      vi.useRealTimers()
      const config = makeConfig()
      const deps = makeDeps()
      const worker = new MergeWorker(config, deps)
      const entry = makeEntry()

      const mockStrategy = makeMockStrategy()
      mockStrategy.execute.mockResolvedValue({
        status: 'error',
        error: 'Rebase failed: divergent branches',
      })
      mockCreateMergeStrategy.mockReturnValue(mockStrategy)
      MockConflictResolver.mockImplementation(() => ({ resolve: vi.fn() }) as any)
      MockLockFileRegeneration.mockImplementation(() => ({
        shouldRegenerate: vi.fn().mockReturnValue(false),
        regenerate: vi.fn(),
        getLockFileName: vi.fn(),
        ensureGitAttributes: vi.fn(),
      }) as any)

      const result = await worker.processEntry(entry)

      expect(result.status).toBe('error')
      expect(result.message).toBe('Rebase failed: divergent branches')
      expect(mockStrategy.finalize).not.toHaveBeenCalled()
    })

    it('uses entry.issueIdentifier when provided', async () => {
      vi.useRealTimers()
      const config = makeConfig()
      const deps = makeDeps()
      const worker = new MergeWorker(config, deps)
      const entry = makeEntry({ issueIdentifier: 'SUP-200' })

      const mockStrategy = makeMockStrategy()
      mockStrategy.execute.mockResolvedValue({
        status: 'conflict',
        conflictFiles: ['file.ts'],
      })
      mockCreateMergeStrategy.mockReturnValue(mockStrategy)

      const mockResolve = vi.fn().mockResolvedValue({
        status: 'escalated',
        method: 'escalation',
        unresolvedFiles: ['file.ts'],
        message: 'Conflict',
      })
      MockConflictResolver.mockImplementation(() => ({ resolve: mockResolve }) as any)
      MockLockFileRegeneration.mockImplementation(() => ({
        shouldRegenerate: vi.fn().mockReturnValue(false),
        regenerate: vi.fn(),
        getLockFileName: vi.fn(),
        ensureGitAttributes: vi.fn(),
      }) as any)

      await worker.processEntry(entry)

      expect(mockResolve).toHaveBeenCalledWith(
        expect.objectContaining({ issueIdentifier: 'SUP-200' }),
      )
    })

    it('defaults issueIdentifier to PR-{prNumber} when not provided', async () => {
      vi.useRealTimers()
      const config = makeConfig()
      const deps = makeDeps()
      const worker = new MergeWorker(config, deps)
      const entry = { prNumber: 99, sourceBranch: 'feature/test' }

      const mockStrategy = makeMockStrategy()
      mockStrategy.execute.mockResolvedValue({
        status: 'conflict',
        conflictFiles: ['file.ts'],
      })
      mockCreateMergeStrategy.mockReturnValue(mockStrategy)

      const mockResolve = vi.fn().mockResolvedValue({
        status: 'escalated',
        method: 'escalation',
        unresolvedFiles: ['file.ts'],
        message: 'Conflict',
      })
      MockConflictResolver.mockImplementation(() => ({ resolve: mockResolve }) as any)
      MockLockFileRegeneration.mockImplementation(() => ({
        shouldRegenerate: vi.fn().mockReturnValue(false),
        regenerate: vi.fn(),
        getLockFileName: vi.fn(),
        ensureGitAttributes: vi.fn(),
      }) as any)

      await worker.processEntry(entry)

      expect(mockResolve).toHaveBeenCalledWith(
        expect.objectContaining({ issueIdentifier: 'PR-99' }),
      )
    })

    it('unexpected exception returns error status', async () => {
      vi.useRealTimers()
      const config = makeConfig()
      const deps = makeDeps()
      const worker = new MergeWorker(config, deps)
      const entry = makeEntry()

      const mockStrategy = makeMockStrategy()
      mockStrategy.prepare.mockRejectedValue(new Error('Unexpected git crash'))
      mockCreateMergeStrategy.mockReturnValue(mockStrategy)
      MockConflictResolver.mockImplementation(() => ({ resolve: vi.fn() }) as any)
      MockLockFileRegeneration.mockImplementation(() => ({
        shouldRegenerate: vi.fn().mockReturnValue(false),
        regenerate: vi.fn(),
        getLockFileName: vi.fn(),
        ensureGitAttributes: vi.fn(),
      }) as any)

      const result = await worker.processEntry(entry)

      expect(result.status).toBe('error')
      expect(result.message).toBe('Unexpected git crash')
    })

    it('skips lock file regeneration when lockFileRegenerate is false', async () => {
      vi.useRealTimers()
      const config = makeConfig({ lockFileRegenerate: false })
      const deps = makeDeps()
      const worker = new MergeWorker(config, deps)
      const entry = makeEntry()

      const mockStrategy = makeMockStrategy()
      mockCreateMergeStrategy.mockReturnValue(mockStrategy)
      MockConflictResolver.mockImplementation(() => ({ resolve: vi.fn() }) as any)

      const mockShouldRegenerate = vi.fn().mockReturnValue(false)
      const mockRegenerate = vi.fn()
      MockLockFileRegeneration.mockImplementation(() => ({
        shouldRegenerate: mockShouldRegenerate,
        regenerate: mockRegenerate,
        getLockFileName: vi.fn(),
        ensureGitAttributes: vi.fn(),
      }) as any)

      mockExecSuccess()

      const result = await worker.processEntry(entry)

      expect(result.status).toBe('merged')
      expect(mockShouldRegenerate).toHaveBeenCalledWith('pnpm', false)
      expect(mockRegenerate).not.toHaveBeenCalled()
    })

    it('uses entry.targetBranch when provided, falls back to config', async () => {
      vi.useRealTimers()
      const config = makeConfig({ targetBranch: 'develop' })
      const deps = makeDeps()
      const worker = new MergeWorker(config, deps)

      const mockStrategy = makeMockStrategy()
      mockCreateMergeStrategy.mockReturnValue(mockStrategy)
      MockConflictResolver.mockImplementation(() => ({ resolve: vi.fn() }) as any)
      MockLockFileRegeneration.mockImplementation(() => ({
        shouldRegenerate: vi.fn().mockReturnValue(false),
        regenerate: vi.fn(),
        getLockFileName: vi.fn(),
        ensureGitAttributes: vi.fn(),
      }) as any)
      mockExecSuccess()

      // With explicit targetBranch in entry
      const entry1 = makeEntry({ targetBranch: 'release' })
      await worker.processEntry(entry1)
      expect(mockStrategy.prepare).toHaveBeenCalledWith(
        expect.objectContaining({ targetBranch: 'release' }),
      )

      mockStrategy.prepare.mockClear()

      // Without targetBranch in entry — falls back to config
      const entry2 = { prNumber: 50, sourceBranch: 'fix/bug' }
      await worker.processEntry(entry2)
      expect(mockStrategy.prepare).toHaveBeenCalledWith(
        expect.objectContaining({ targetBranch: 'develop' }),
      )
    })
  })

  // -------------------------------------------------------------------------
  // start/stop
  // -------------------------------------------------------------------------

  describe('start/stop', () => {
    it('acquires Redis lock on start', async () => {
      const config = makeConfig()
      const deps = makeDeps()
      const worker = new MergeWorker(config, deps)

      // Use abort signal to stop immediately after first iteration
      const ac = new AbortController()

      // Make dequeue return null so the loop just polls
      vi.mocked(deps.storage.dequeue).mockResolvedValue(null)
      // Return null for paused check
      vi.mocked(deps.redis.get).mockResolvedValue(null)

      // Start and stop after one iteration
      const startPromise = worker.start(ac.signal)
      // Advance past the first poll interval
      await vi.advanceTimersByTimeAsync(config.pollInterval + 10)
      ac.abort()
      await startPromise

      expect(deps.redis.setNX).toHaveBeenCalledWith('merge:lock:repo-1', 'worker', 300)
    })

    it('throws if lock already held', async () => {
      const config = makeConfig()
      const deps = makeDeps()
      vi.mocked(deps.redis.setNX).mockResolvedValue(false)
      const worker = new MergeWorker(config, deps)

      await expect(worker.start()).rejects.toThrow('Another merge worker is already running for repo repo-1')
    })

    it('releases lock on stop', async () => {
      const config = makeConfig()
      const deps = makeDeps()
      const worker = new MergeWorker(config, deps)

      vi.mocked(deps.storage.dequeue).mockResolvedValue(null)
      vi.mocked(deps.redis.get).mockResolvedValue(null)

      const ac = new AbortController()
      const startPromise = worker.start(ac.signal)

      await vi.advanceTimersByTimeAsync(config.pollInterval + 10)
      ac.abort()
      await startPromise

      expect(deps.redis.del).toHaveBeenCalledWith('merge:lock:repo-1')
    })

    it('stop sets running to false', async () => {
      const config = makeConfig()
      const deps = makeDeps()
      const worker = new MergeWorker(config, deps)

      vi.mocked(deps.storage.dequeue).mockResolvedValue(null)
      vi.mocked(deps.redis.get).mockResolvedValue(null)

      const startPromise = worker.start()

      // Let it start running
      await vi.advanceTimersByTimeAsync(50)

      // Stop the worker
      worker.stop()

      // Advance timers to let the loop exit
      await vi.advanceTimersByTimeAsync(config.pollInterval + 100)
      await startPromise

      // Lock should be released
      expect(deps.redis.del).toHaveBeenCalledWith('merge:lock:repo-1')
    })

    it('heartbeat extends lock TTL', async () => {
      const config = makeConfig()
      const deps = makeDeps()
      const worker = new MergeWorker(config, deps)

      vi.mocked(deps.storage.dequeue).mockResolvedValue(null)
      vi.mocked(deps.redis.get).mockResolvedValue(null)

      const ac = new AbortController()
      const startPromise = worker.start(ac.signal)

      // Advance past the heartbeat interval (60 seconds)
      await vi.advanceTimersByTimeAsync(60_000 + 100)

      // Heartbeat should have called expire to extend the lock
      expect(deps.redis.expire).toHaveBeenCalledWith('merge:lock:repo-1', 300)

      ac.abort()
      await vi.advanceTimersByTimeAsync(config.pollInterval + 10)
      await startPromise
    })

    it('paused queue causes polling wait', async () => {
      const config = makeConfig({ pollInterval: 100 })
      const deps = makeDeps()
      const worker = new MergeWorker(config, deps)

      // First call: paused, second call: paused, then abort
      let callCount = 0
      vi.mocked(deps.redis.get).mockImplementation(async (key: string) => {
        if (key.includes('paused')) {
          callCount++
          return 'true'
        }
        return null
      })

      const ac = new AbortController()
      const startPromise = worker.start(ac.signal)

      // Advance to let it check paused state
      await vi.advanceTimersByTimeAsync(config.pollInterval + 50)
      await vi.advanceTimersByTimeAsync(config.pollInterval + 50)

      ac.abort()
      await vi.advanceTimersByTimeAsync(config.pollInterval + 10)
      await startPromise

      // Should have checked paused state multiple times but never dequeued
      expect(callCount).toBeGreaterThanOrEqual(1)
      expect(deps.storage.dequeue).not.toHaveBeenCalled()
    })

    it('empty queue causes polling wait', async () => {
      const config = makeConfig({ pollInterval: 100 })
      const deps = makeDeps()
      const worker = new MergeWorker(config, deps)

      vi.mocked(deps.storage.dequeue).mockResolvedValue(null)
      vi.mocked(deps.redis.get).mockResolvedValue(null)

      const ac = new AbortController()
      const startPromise = worker.start(ac.signal)

      // Advance past two poll intervals
      await vi.advanceTimersByTimeAsync(config.pollInterval * 2 + 50)

      ac.abort()
      await vi.advanceTimersByTimeAsync(config.pollInterval + 10)
      await startPromise

      // Should have called dequeue multiple times (polling)
      expect(deps.storage.dequeue).toHaveBeenCalled()
      // No markCompleted/markFailed since queue was empty
      expect(deps.storage.markCompleted).not.toHaveBeenCalled()
      expect(deps.storage.markFailed).not.toHaveBeenCalled()
    })

    it('processes entry and marks completed on success', async () => {
      vi.useRealTimers()
      const config = makeConfig({ pollInterval: 50 })
      const deps = makeDeps()
      const worker = new MergeWorker(config, deps)

      const entry = makeEntry()
      // Return entry on first dequeue, null on second (to stop)
      let dequeueCount = 0
      vi.mocked(deps.storage.dequeue).mockImplementation(async () => {
        dequeueCount++
        if (dequeueCount === 1) return entry
        return null
      })
      vi.mocked(deps.redis.get).mockResolvedValue(null)

      // Set up mocks for processEntry
      const mockStrategy = makeMockStrategy()
      mockCreateMergeStrategy.mockReturnValue(mockStrategy)
      MockConflictResolver.mockImplementation(() => ({ resolve: vi.fn() }) as any)
      MockLockFileRegeneration.mockImplementation(() => ({
        shouldRegenerate: vi.fn().mockReturnValue(false),
        regenerate: vi.fn(),
        getLockFileName: vi.fn(),
        ensureGitAttributes: vi.fn(),
      }) as any)
      mockExecSuccess()

      const ac = new AbortController()
      const startPromise = worker.start(ac.signal)

      // Let the processing happen
      await new Promise(resolve => setTimeout(resolve, 200))
      ac.abort()
      await startPromise

      expect(deps.storage.markCompleted).toHaveBeenCalledWith('repo-1', 42)
    })

    it('marks blocked on conflict', async () => {
      vi.useRealTimers()
      const config = makeConfig({ pollInterval: 50 })
      const deps = makeDeps()
      const worker = new MergeWorker(config, deps)

      const entry = makeEntry()
      let dequeueCount = 0
      vi.mocked(deps.storage.dequeue).mockImplementation(async () => {
        dequeueCount++
        if (dequeueCount === 1) return entry
        return null
      })
      vi.mocked(deps.redis.get).mockResolvedValue(null)

      const mockStrategy = makeMockStrategy()
      mockStrategy.execute.mockResolvedValue({ status: 'conflict', conflictFiles: ['a.ts'] })
      mockCreateMergeStrategy.mockReturnValue(mockStrategy)
      MockConflictResolver.mockImplementation(() => ({
        resolve: vi.fn().mockResolvedValue({
          status: 'escalated',
          method: 'escalation',
          message: 'Conflict in a.ts',
        }),
      }) as any)
      MockLockFileRegeneration.mockImplementation(() => ({
        shouldRegenerate: vi.fn().mockReturnValue(false),
        regenerate: vi.fn(),
        getLockFileName: vi.fn(),
        ensureGitAttributes: vi.fn(),
      }) as any)

      const ac = new AbortController()
      const startPromise = worker.start(ac.signal)
      await new Promise(resolve => setTimeout(resolve, 200))
      ac.abort()
      await startPromise

      expect(deps.storage.markBlocked).toHaveBeenCalledWith('repo-1', 42, 'Conflict in a.ts')
    })

    it('marks failed on test failure with notify escalation', async () => {
      vi.useRealTimers()
      const config = makeConfig({
        pollInterval: 50,
        escalation: { onConflict: 'reassign', onTestFailure: 'notify' },
      })
      const deps = makeDeps()
      const worker = new MergeWorker(config, deps)

      const entry = makeEntry()
      let dequeueCount = 0
      vi.mocked(deps.storage.dequeue).mockImplementation(async () => {
        dequeueCount++
        if (dequeueCount === 1) return entry
        return null
      })
      vi.mocked(deps.redis.get).mockResolvedValue(null)

      const mockStrategy = makeMockStrategy()
      mockCreateMergeStrategy.mockReturnValue(mockStrategy)
      MockConflictResolver.mockImplementation(() => ({ resolve: vi.fn() }) as any)
      MockLockFileRegeneration.mockImplementation(() => ({
        shouldRegenerate: vi.fn().mockReturnValue(false),
        regenerate: vi.fn(),
        getLockFileName: vi.fn(),
        ensureGitAttributes: vi.fn(),
      }) as any)
      mockExecFailure('Tests failed', 'FAIL: 2 tests')

      const ac = new AbortController()
      const startPromise = worker.start(ac.signal)
      await new Promise(resolve => setTimeout(resolve, 200))
      ac.abort()
      await startPromise

      expect(deps.storage.markFailed).toHaveBeenCalledWith('repo-1', 42, expect.any(String))
    })

    it('marks blocked on test failure with park escalation', async () => {
      vi.useRealTimers()
      const config = makeConfig({
        pollInterval: 50,
        escalation: { onConflict: 'reassign', onTestFailure: 'park' },
      })
      const deps = makeDeps()
      const worker = new MergeWorker(config, deps)

      const entry = makeEntry()
      let dequeueCount = 0
      vi.mocked(deps.storage.dequeue).mockImplementation(async () => {
        dequeueCount++
        if (dequeueCount === 1) return entry
        return null
      })
      vi.mocked(deps.redis.get).mockResolvedValue(null)

      const mockStrategy = makeMockStrategy()
      mockCreateMergeStrategy.mockReturnValue(mockStrategy)
      MockConflictResolver.mockImplementation(() => ({ resolve: vi.fn() }) as any)
      MockLockFileRegeneration.mockImplementation(() => ({
        shouldRegenerate: vi.fn().mockReturnValue(false),
        regenerate: vi.fn(),
        getLockFileName: vi.fn(),
        ensureGitAttributes: vi.fn(),
      }) as any)
      mockExecFailure('Tests failed', 'FAIL: 2 tests')

      const ac = new AbortController()
      const startPromise = worker.start(ac.signal)
      await new Promise(resolve => setTimeout(resolve, 200))
      ac.abort()
      await startPromise

      expect(deps.storage.markBlocked).toHaveBeenCalledWith('repo-1', 42, expect.any(String))
    })
  })

  // -------------------------------------------------------------------------
  // processEntry: file reservation checks
  // -------------------------------------------------------------------------

  describe('file reservation pre-check', () => {
    it('skips file reservation check when deps.fileReservation is undefined', async () => {
      vi.useRealTimers()
      const config = makeConfig()
      const deps = makeDeps() // no fileReservation
      const worker = new MergeWorker(config, deps)
      const entry = makeEntry()

      const mockStrategy = makeMockStrategy()
      mockCreateMergeStrategy.mockReturnValue(mockStrategy)
      MockConflictResolver.mockImplementation(() => ({
        resolve: vi.fn(),
      }) as any)
      MockLockFileRegeneration.mockImplementation(() => ({
        shouldRegenerate: vi.fn().mockReturnValue(false),
      }) as any)
      mockExecSuccess()

      const result = await worker.processEntry(entry)

      expect(result.status).toBe('merged')
    })

    it('returns conflict when files are reserved by other sessions', async () => {
      vi.useRealTimers()
      const config = makeConfig()
      const mockFileReservation = {
        checkFileConflicts: vi.fn().mockResolvedValue([
          { filePath: 'src/index.ts', heldBy: { sessionId: 'other-session' } },
        ]),
      }
      const deps = makeDeps({ fileReservation: mockFileReservation })
      const worker = new MergeWorker(config, deps)
      const entry = makeEntry()

      const mockStrategy = makeMockStrategy()
      mockCreateMergeStrategy.mockReturnValue(mockStrategy)
      MockConflictResolver.mockImplementation(() => ({
        resolve: vi.fn(),
      }) as any)
      MockLockFileRegeneration.mockImplementation(() => ({
        shouldRegenerate: vi.fn().mockReturnValue(false),
      }) as any)

      // Mock exec for git diff --name-only to return file list
      mockExecByCommand({
        'git diff --name-only': { stdout: 'src/index.ts\nsrc/app.ts\n' },
        'git fetch': {},
        'git checkout': {},
      })

      const result = await worker.processEntry(entry)

      expect(result.status).toBe('conflict')
      expect(result.message).toContain('src/index.ts')
      expect(result.message).toContain('other-session')
      expect(mockFileReservation.checkFileConflicts).toHaveBeenCalledWith(
        'repo-1',
        'merge-worker-42',
        ['src/index.ts', 'src/app.ts'],
      )
    })

    it('proceeds normally when file reservation check fails (best-effort)', async () => {
      vi.useRealTimers()
      const config = makeConfig()
      const mockFileReservation = {
        checkFileConflicts: vi.fn().mockRejectedValue(new Error('Redis down')),
      }
      const deps = makeDeps({ fileReservation: mockFileReservation })
      const worker = new MergeWorker(config, deps)
      const entry = makeEntry()

      const mockStrategy = makeMockStrategy()
      mockCreateMergeStrategy.mockReturnValue(mockStrategy)
      MockConflictResolver.mockImplementation(() => ({
        resolve: vi.fn(),
      }) as any)
      MockLockFileRegeneration.mockImplementation(() => ({
        shouldRegenerate: vi.fn().mockReturnValue(false),
      }) as any)
      mockExecSuccess()

      const result = await worker.processEntry(entry)

      // Should still succeed despite file reservation check failure
      expect(result.status).toBe('merged')
    })

    it('proceeds when no file conflicts found', async () => {
      vi.useRealTimers()
      const config = makeConfig()
      const mockFileReservation = {
        checkFileConflicts: vi.fn().mockResolvedValue([]), // no conflicts
      }
      const deps = makeDeps({ fileReservation: mockFileReservation })
      const worker = new MergeWorker(config, deps)
      const entry = makeEntry()

      const mockStrategy = makeMockStrategy()
      mockCreateMergeStrategy.mockReturnValue(mockStrategy)
      MockConflictResolver.mockImplementation(() => ({
        resolve: vi.fn(),
      }) as any)
      MockLockFileRegeneration.mockImplementation(() => ({
        shouldRegenerate: vi.fn().mockReturnValue(false),
      }) as any)
      mockExecSuccess()

      const result = await worker.processEntry(entry)

      expect(result.status).toBe('merged')
    })
  })
})
