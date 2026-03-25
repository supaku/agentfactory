import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('child_process', () => ({
  exec: vi.fn(),
}))

import { exec } from 'child_process'
import { createMergeStrategy } from './index.js'
import { RebaseStrategy } from './rebase-strategy.js'
import { MergeCommitStrategy } from './merge-commit-strategy.js'
import { SquashStrategy } from './squash-strategy.js'
import type { MergeContext } from './types.js'

const mockExec = vi.mocked(exec)

/** Default context for all tests */
const defaultCtx: MergeContext = {
  repoPath: '/repo',
  worktreePath: '/worktree',
  sourceBranch: 'feature/test',
  targetBranch: 'main',
  prNumber: 42,
  remote: 'origin',
}

/**
 * Mock exec to succeed with given stdout for every call.
 * Matches the promisify(exec) pattern: exec(cmd, opts, callback).
 */
function mockExecSuccess(stdout = '') {
  mockExec.mockImplementation((_cmd: string, _opts: unknown, callback?: Function) => {
    const cb = typeof _opts === 'function' ? _opts : callback
    cb?.(null, { stdout, stderr: '' })
    return {} as ReturnType<typeof exec>
  })
}

/**
 * Mock exec to fail with the given error message for every call.
 */
function mockExecFailure(message: string) {
  mockExec.mockImplementation((_cmd: string, _opts: unknown, callback?: Function) => {
    const cb = typeof _opts === 'function' ? _opts : callback
    cb?.(new Error(message), { stdout: '', stderr: '' })
    return {} as ReturnType<typeof exec>
  })
}

/**
 * Queue sequential mock implementations.
 * Each entry is either a string (success stdout) or an Error (failure).
 */
function mockExecSequence(results: Array<string | Error>) {
  const queue = [...results]
  mockExec.mockImplementation((_cmd: string, _opts: unknown, callback?: Function) => {
    const cb = typeof _opts === 'function' ? _opts : callback
    const next = queue.shift()
    if (next instanceof Error) {
      cb?.(next, { stdout: '', stderr: '' })
    } else {
      cb?.(null, { stdout: next ?? '', stderr: '' })
    }
    return {} as ReturnType<typeof exec>
  })
}

describe('createMergeStrategy factory', () => {
  it('returns RebaseStrategy for "rebase"', () => {
    const strategy = createMergeStrategy('rebase')
    expect(strategy).toBeInstanceOf(RebaseStrategy)
    expect(strategy.name).toBe('rebase')
  })

  it('returns MergeCommitStrategy for "merge"', () => {
    const strategy = createMergeStrategy('merge')
    expect(strategy).toBeInstanceOf(MergeCommitStrategy)
    expect(strategy.name).toBe('merge')
  })

  it('returns SquashStrategy for "squash"', () => {
    const strategy = createMergeStrategy('squash')
    expect(strategy).toBeInstanceOf(SquashStrategy)
    expect(strategy.name).toBe('squash')
  })

  it('throws on unknown strategy name', () => {
    expect(() => createMergeStrategy('unknown' as 'rebase')).toThrow('Unknown merge strategy: unknown')
  })
})

describe('RebaseStrategy', () => {
  let strategy: RebaseStrategy

  beforeEach(() => {
    vi.clearAllMocks()
    strategy = new RebaseStrategy()
  })

  it('has name "rebase"', () => {
    expect(strategy.name).toBe('rebase')
  })

  describe('prepare', () => {
    it('fetches target branch and checks out source branch', async () => {
      mockExecSequence([
        '',             // git fetch origin main
        '',             // git checkout feature/test
        'abc123\n',    // git rev-parse HEAD
      ])

      const result = await strategy.prepare(defaultCtx)

      expect(result).toEqual({ success: true, headSha: 'abc123' })
      expect(mockExec).toHaveBeenCalledTimes(3)

      // Verify commands and cwd
      const calls = mockExec.mock.calls
      expect(calls[0][0]).toBe('git fetch origin main')
      expect(calls[0][1]).toEqual({ cwd: '/worktree' })
      expect(calls[1][0]).toBe('git checkout feature/test')
      expect(calls[1][1]).toEqual({ cwd: '/worktree' })
      expect(calls[2][0]).toBe('git rev-parse HEAD')
      expect(calls[2][1]).toEqual({ cwd: '/worktree' })
    })

    it('returns failure when fetch fails', async () => {
      mockExecFailure('fatal: could not read from remote')

      const result = await strategy.prepare(defaultCtx)

      expect(result.success).toBe(false)
      expect(result.error).toContain('could not read from remote')
    })
  })

  describe('execute', () => {
    it('runs rebase and returns success with merged SHA', async () => {
      mockExecSequence([
        '',           // git rebase origin/main
        'def456\n',  // git rev-parse HEAD
      ])

      const result = await strategy.execute(defaultCtx)

      expect(result).toEqual({ status: 'success', mergedSha: 'def456' })
      expect(mockExec).toHaveBeenCalledTimes(2)

      const calls = mockExec.mock.calls
      expect(calls[0][0]).toBe('git rebase origin/main')
      expect(calls[0][1]).toEqual({ cwd: '/worktree' })
    })

    it('detects conflicts, aborts rebase, and returns conflict result', async () => {
      mockExecSequence([
        new Error('CONFLICT (content): Merge conflict in file.ts'),  // git rebase fails
        'src/file.ts\nsrc/other.ts\n',                              // git diff --name-only --diff-filter=U
        '',                                                          // git rebase --abort
      ])

      const result = await strategy.execute(defaultCtx)

      expect(result.status).toBe('conflict')
      expect(result.conflictFiles).toEqual(['src/file.ts', 'src/other.ts'])
      expect(result.conflictDetails).toBe('Rebase conflict in 2 file(s)')
    })

    it('aborts rebase and returns error on non-conflict failure', async () => {
      mockExecSequence([
        new Error('fatal: invalid upstream'),  // git rebase fails
        new Error('no conflicts'),             // git diff --name-only fails (no conflict state)
        '',                                    // git rebase --abort
      ])

      const result = await strategy.execute(defaultCtx)

      expect(result.status).toBe('error')
      expect(result.error).toContain('invalid upstream')
    })

    it('handles abort failure gracefully after error', async () => {
      mockExecSequence([
        new Error('fatal: something went wrong'),  // git rebase fails
        '',                                        // git diff returns empty (no conflicts)
        new Error('no rebase in progress'),        // git rebase --abort fails
      ])

      const result = await strategy.execute(defaultCtx)

      expect(result.status).toBe('error')
      expect(result.error).toContain('something went wrong')
    })
  })

  describe('finalize', () => {
    it('force-pushes source branch and fast-forward merges to target', async () => {
      mockExecSequence([
        '',  // git push origin feature/test --force-with-lease
        '',  // git checkout main
        '',  // git merge --ff-only feature/test
        '',  // git push origin main
      ])

      await strategy.finalize(defaultCtx)

      expect(mockExec).toHaveBeenCalledTimes(4)

      const calls = mockExec.mock.calls
      expect(calls[0][0]).toBe('git push origin feature/test --force-with-lease')
      expect(calls[0][1]).toEqual({ cwd: '/worktree' })
      expect(calls[1][0]).toBe('git checkout main')
      expect(calls[1][1]).toEqual({ cwd: '/worktree' })
      expect(calls[2][0]).toBe('git merge --ff-only feature/test')
      expect(calls[2][1]).toEqual({ cwd: '/worktree' })
      expect(calls[3][0]).toBe('git push origin main')
      expect(calls[3][1]).toEqual({ cwd: '/worktree' })
    })

    it('throws when push fails', async () => {
      mockExecFailure('rejected: non-fast-forward')

      await expect(strategy.finalize(defaultCtx)).rejects.toThrow('rejected: non-fast-forward')
    })
  })
})

describe('MergeCommitStrategy', () => {
  let strategy: MergeCommitStrategy

  beforeEach(() => {
    vi.clearAllMocks()
    strategy = new MergeCommitStrategy()
  })

  it('has name "merge"', () => {
    expect(strategy.name).toBe('merge')
  })

  describe('prepare', () => {
    it('fetches and checks out target branch', async () => {
      mockExecSequence([
        '',            // git fetch origin main
        '',            // git checkout main
        'aaa111\n',   // git rev-parse HEAD
      ])

      const result = await strategy.prepare(defaultCtx)

      expect(result).toEqual({ success: true, headSha: 'aaa111' })
      const calls = mockExec.mock.calls
      expect(calls[0][0]).toBe('git fetch origin main')
      expect(calls[1][0]).toBe('git checkout main')
      expect(calls[1][1]).toEqual({ cwd: '/worktree' })
    })

    it('returns failure on error', async () => {
      mockExecFailure('error: pathspec did not match')

      const result = await strategy.prepare(defaultCtx)

      expect(result.success).toBe(false)
      expect(result.error).toContain('pathspec did not match')
    })
  })

  describe('execute', () => {
    it('runs merge --no-ff and returns success', async () => {
      mockExecSequence([
        '',           // git merge --no-ff
        'bbb222\n',  // git rev-parse HEAD
      ])

      const result = await strategy.execute(defaultCtx)

      expect(result).toEqual({ status: 'success', mergedSha: 'bbb222' })
      const calls = mockExec.mock.calls
      expect(calls[0][0]).toBe(
        'git merge --no-ff origin/feature/test -m "Merge PR #42 from feature/test"',
      )
      expect(calls[0][1]).toEqual({ cwd: '/worktree' })
    })

    it('detects conflicts, aborts merge, and returns conflict result', async () => {
      mockExecSequence([
        new Error('CONFLICT'),              // git merge fails
        'src/conflict.ts\n',                // git diff --name-only --diff-filter=U
        '',                                 // git merge --abort
      ])

      const result = await strategy.execute(defaultCtx)

      expect(result.status).toBe('conflict')
      expect(result.conflictFiles).toEqual(['src/conflict.ts'])
      expect(result.conflictDetails).toBe('Merge conflict in 1 file(s)')
    })

    it('returns error on non-conflict failure', async () => {
      mockExecSequence([
        new Error('fatal: refusing to merge unrelated histories'),  // git merge fails
        '',                                                         // git diff returns empty
        '',                                                         // git merge --abort
      ])

      const result = await strategy.execute(defaultCtx)

      expect(result.status).toBe('error')
      expect(result.error).toContain('unrelated histories')
    })
  })

  describe('finalize', () => {
    it('pushes target branch', async () => {
      mockExecSuccess()

      await strategy.finalize(defaultCtx)

      expect(mockExec).toHaveBeenCalledTimes(1)
      const calls = mockExec.mock.calls
      expect(calls[0][0]).toBe('git push origin main')
      expect(calls[0][1]).toEqual({ cwd: '/worktree' })
    })
  })
})

describe('SquashStrategy', () => {
  let strategy: SquashStrategy

  beforeEach(() => {
    vi.clearAllMocks()
    strategy = new SquashStrategy()
  })

  it('has name "squash"', () => {
    expect(strategy.name).toBe('squash')
  })

  describe('prepare', () => {
    it('fetches and checks out target branch', async () => {
      mockExecSequence([
        '',            // git fetch origin main
        '',            // git checkout main
        'ccc333\n',   // git rev-parse HEAD
      ])

      const result = await strategy.prepare(defaultCtx)

      expect(result).toEqual({ success: true, headSha: 'ccc333' })
      const calls = mockExec.mock.calls
      expect(calls[0][0]).toBe('git fetch origin main')
      expect(calls[1][0]).toBe('git checkout main')
      expect(calls[1][1]).toEqual({ cwd: '/worktree' })
    })
  })

  describe('execute', () => {
    it('runs merge --squash, commits, and returns success', async () => {
      mockExecSequence([
        '',           // git merge --squash
        '',           // git commit
        'ddd444\n',  // git rev-parse HEAD
      ])

      const result = await strategy.execute(defaultCtx)

      expect(result).toEqual({ status: 'success', mergedSha: 'ddd444' })
      const calls = mockExec.mock.calls
      expect(calls[0][0]).toBe('git merge --squash origin/feature/test')
      expect(calls[0][1]).toEqual({ cwd: '/worktree' })
      expect(calls[1][0]).toBe(
        'git commit -m "Squash merge PR #42 from feature/test"',
      )
      expect(calls[1][1]).toEqual({ cwd: '/worktree' })
    })

    it('detects conflicts, aborts, and returns conflict result', async () => {
      mockExecSequence([
        new Error('CONFLICT'),     // git merge --squash fails
        'src/a.ts\nsrc/b.ts\n',   // git diff --name-only --diff-filter=U
        '',                        // git merge --abort
      ])

      const result = await strategy.execute(defaultCtx)

      expect(result.status).toBe('conflict')
      expect(result.conflictFiles).toEqual(['src/a.ts', 'src/b.ts'])
      expect(result.conflictDetails).toBe('Squash merge conflict in 2 file(s)')
    })

    it('returns error on non-conflict failure', async () => {
      mockExecSequence([
        new Error('fatal: not something we can merge'),  // git merge --squash fails
        '',                                              // git diff returns empty
        '',                                              // git merge --abort
      ])

      const result = await strategy.execute(defaultCtx)

      expect(result.status).toBe('error')
      expect(result.error).toContain('not something we can merge')
    })
  })

  describe('finalize', () => {
    it('pushes target branch', async () => {
      mockExecSuccess()

      await strategy.finalize(defaultCtx)

      expect(mockExec).toHaveBeenCalledTimes(1)
      const calls = mockExec.mock.calls
      expect(calls[0][0]).toBe('git push origin main')
      expect(calls[0][1]).toEqual({ cwd: '/worktree' })
    })
  })
})

describe('All strategies use ctx.worktreePath as cwd', () => {
  const strategies = [
    new RebaseStrategy(),
    new MergeCommitStrategy(),
    new SquashStrategy(),
  ]

  beforeEach(() => {
    vi.clearAllMocks()
  })

  for (const strategy of strategies) {
    it(`${strategy.name} strategy passes worktreePath as cwd to all exec calls`, async () => {
      const customCtx: MergeContext = {
        ...defaultCtx,
        worktreePath: '/custom/worktree/path',
      }

      mockExecSuccess('abc123\n')

      await strategy.prepare(customCtx)

      for (const call of mockExec.mock.calls) {
        expect(call[1]).toEqual({ cwd: '/custom/worktree/path' })
      }
    })
  }
})
