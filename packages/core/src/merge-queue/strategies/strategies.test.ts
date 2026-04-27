import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('child_process', () => ({
  exec: vi.fn(),
}))

// Strategy tests don't care how the worktree cleanup is implemented — they
// just care that it runs before the detached checkout. The real cleanup
// commands are covered in worktree-cleanup.test.ts.
vi.mock('./worktree-cleanup.js', () => ({
  cleanWorktreeState: vi.fn().mockResolvedValue(undefined),
}))

import { exec } from 'child_process'
import { createMergeStrategy } from './index.js'
import { RebaseStrategy } from './rebase-strategy.js'
import { MergeCommitStrategy } from './merge-commit-strategy.js'
import { SquashStrategy } from './squash-strategy.js'
import { cleanWorktreeState } from './worktree-cleanup.js'
import type { MergeContext } from './types.js'

const mockExec = vi.mocked(exec)
const mockCleanWorktreeState = vi.mocked(cleanWorktreeState)

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

/**
 * The branch-conflict errors that REN-1253 / REN-1254 observed — both git
 * phrasings. Strategies must treat these as `retryable: true` on prepare.
 */
const BRANCH_CONFLICT_USED_BY =
  "Command failed: git checkout feature/test\nfatal: 'feature/test' is already used by worktree at '/Users/me/repo.wt/REN-1253-AC'"
const BRANCH_CONFLICT_CHECKED_OUT =
  "fatal: 'feature/test' is already checked out at '/Users/me/repo/.worktrees/feature-test-DEV'"
/**
 * The "couldn't find remote ref" failure that REN-1166 observed: a duplicate
 * dequeue tried to fetch the source branch a previous run had already deleted
 * after a successful merge. Strategies must mark this as `alreadyMerged: true`
 * so the worker can `noop` instead of bubbling Rejected.
 */
const MISSING_SOURCE_REF =
  "Command failed: git fetch origin main feature/test\nfatal: couldn't find remote ref feature/test\n"

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
    it('fetches both branches and issues a detached checkout at origin/<source>', async () => {
      // Detached checkout is the core of the fix — a plain `git checkout <source>`
      // would collide with any concurrent worktree (e.g., the acceptance agent's
      // `<ISSUE>-AC` worktree) holding the same branch.
      mockExecSequence([
        '',             // git fetch origin main feature/test
        '',             // git checkout --detach origin/feature/test
        'abc123\n',    // git rev-parse HEAD
      ])

      const result = await strategy.prepare(defaultCtx)

      expect(result).toEqual({ success: true, headSha: 'abc123' })
      expect(mockExec).toHaveBeenCalledTimes(3)

      const calls = mockExec.mock.calls
      expect(calls[0][0]).toBe('git fetch origin main feature/test')
      expect(calls[0][1]).toEqual({ cwd: '/worktree' })
      expect(calls[1][0]).toBe('git checkout --detach origin/feature/test')
      expect(calls[1][1]).toEqual({ cwd: '/worktree' })
      expect(calls[2][0]).toBe('git rev-parse HEAD')
    })

    it('cleans worktree state before fetching', async () => {
      // v0.8.54 regression: without this, the staged lock file from a prior
      // failed PR's lock-file-regeneration step persisted in the index and
      // blocked every subsequent `git rebase` with
      // "Your index contains uncommitted changes."
      mockExecSequence([
        '',             // git fetch
        '',             // git checkout --detach
        'abc123\n',    // git rev-parse HEAD
      ])

      await strategy.prepare(defaultCtx)

      expect(mockCleanWorktreeState).toHaveBeenCalledWith('/worktree')
      // Called before any exec (cleanup must run before fetch)
      expect(mockCleanWorktreeState.mock.invocationCallOrder[0])
        .toBeLessThan(mockExec.mock.invocationCallOrder[0])
    })

    it('never issues a non-detached checkout of the source branch', async () => {
      // Regression guard for REN-1253 / REN-1254. `git checkout <branch>` (no
      // --detach) is what produced the "is already used by worktree" failure.
      mockExecSuccess('abc123\n')

      await strategy.prepare(defaultCtx)

      for (const [cmd] of mockExec.mock.calls) {
        expect(cmd).not.toMatch(/git checkout (?!--detach)/)
      }
    })

    it('returns failure when fetch fails', async () => {
      mockExecFailure('fatal: could not read from remote')

      const result = await strategy.prepare(defaultCtx)

      expect(result.success).toBe(false)
      expect(result.retryable).toBeFalsy()
      expect(result.error).toContain('could not read from remote')
    })

    it('returns retryable=true on "is already used by worktree" error', async () => {
      mockExecSequence([
        '',                               // git fetch
        new Error(BRANCH_CONFLICT_USED_BY), // git checkout --detach
      ])

      const result = await strategy.prepare(defaultCtx)

      expect(result.success).toBe(false)
      expect(result.retryable).toBe(true)
      expect(result.error).toContain('already used by worktree')
    })

    it('returns retryable=true on "is already checked out at" error', async () => {
      mockExecSequence([
        '',                                    // git fetch
        new Error(BRANCH_CONFLICT_CHECKED_OUT),  // git checkout --detach
      ])

      const result = await strategy.prepare(defaultCtx)

      expect(result.success).toBe(false)
      expect(result.retryable).toBe(true)
    })

    it('returns alreadyMerged=true when source branch is missing on remote (REN-1166)', async () => {
      mockExecSequence([
        new Error(MISSING_SOURCE_REF),  // git fetch fails — branch was deleted
      ])

      const result = await strategy.prepare(defaultCtx)

      expect(result.success).toBe(false)
      expect(result.alreadyMerged).toBe(true)
      expect(result.retryable).toBeFalsy()
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
    it('pushes source via HEAD:<source> refspec and fast-forwards target with the rebased SHA', async () => {
      // Run full prepare+execute so finalize sees the rebased SHA via the
      // strategy's per-context state map.
      mockExecSequence([
        '', '', 'abc123\n',   // prepare
        '', 'def456\n',       // execute → rebasedSha=def456
        '',                   // finalize: push origin HEAD:feature/test --force-with-lease=feature/test
        '',                   // finalize: push origin def456:main
      ])

      await strategy.prepare(defaultCtx)
      await strategy.execute(defaultCtx)
      await strategy.finalize(defaultCtx)

      const finalizeCalls = mockExec.mock.calls.slice(5)
      expect(finalizeCalls).toHaveLength(2)
      expect(finalizeCalls[0][0]).toBe(
        'git push origin HEAD:feature/test --force-with-lease=feature/test',
      )
      expect(finalizeCalls[0][1]).toEqual({ cwd: '/worktree' })
      expect(finalizeCalls[1][0]).toBe('git push origin def456:main')
      expect(finalizeCalls[1][1]).toEqual({ cwd: '/worktree' })
    })

    it('never issues a non-detached checkout during finalize', async () => {
      // Regression guard — the old finalize did `git checkout main`, which
      // would collide with anyone who has `main` checked out elsewhere.
      mockExecSequence([
        '', '', 'abc123\n',  // prepare
        '', 'def456\n',      // execute
        '', '',              // finalize pushes
      ])

      await strategy.prepare(defaultCtx)
      await strategy.execute(defaultCtx)
      await strategy.finalize(defaultCtx)

      for (const [cmd] of mockExec.mock.calls) {
        expect(cmd).not.toMatch(/git checkout (?!--detach)/)
      }
    })

    it('falls back to current HEAD when no rebasedSha was captured', async () => {
      mockExecSequence([
        'fallback-sha\n',   // git rev-parse HEAD (fallback path)
        '',                 // push HEAD:<source>
        '',                 // push <sha>:<target>
      ])

      // finalize called without prior prepare/execute — state map has no entry
      await strategy.finalize({ ...defaultCtx })

      const calls = mockExec.mock.calls
      expect(calls[0][0]).toBe('git rev-parse HEAD')
      expect(calls[2][0]).toBe('git push origin fallback-sha:main')
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
    it('fetches both branches and detaches at origin/<target>', async () => {
      mockExecSequence([
        '',            // git fetch origin main feature/test
        '',            // git checkout --detach origin/main
        'aaa111\n',   // git rev-parse HEAD
      ])

      const result = await strategy.prepare(defaultCtx)

      expect(result).toEqual({ success: true, headSha: 'aaa111' })
      const calls = mockExec.mock.calls
      expect(calls[0][0]).toBe('git fetch origin main feature/test')
      expect(calls[1][0]).toBe('git checkout --detach origin/main')
      expect(calls[1][1]).toEqual({ cwd: '/worktree' })
    })

    it('cleans worktree state before fetching', async () => {
      mockExecSuccess('aaa111\n')
      await strategy.prepare(defaultCtx)
      expect(mockCleanWorktreeState).toHaveBeenCalledWith('/worktree')
    })

    it('never issues a non-detached checkout of the target branch', async () => {
      mockExecSuccess('aaa111\n')
      await strategy.prepare(defaultCtx)
      for (const [cmd] of mockExec.mock.calls) {
        expect(cmd).not.toMatch(/git checkout (?!--detach)/)
      }
    })

    it('returns failure on error', async () => {
      mockExecFailure('error: pathspec did not match')

      const result = await strategy.prepare(defaultCtx)

      expect(result.success).toBe(false)
      expect(result.retryable).toBeFalsy()
      expect(result.error).toContain('pathspec did not match')
    })

    it('returns retryable=true on branch-conflict errors (both phrasings)', async () => {
      for (const msg of [BRANCH_CONFLICT_USED_BY, BRANCH_CONFLICT_CHECKED_OUT]) {
        vi.clearAllMocks()
        mockExecSequence(['', new Error(msg)])

        const result = await strategy.prepare(defaultCtx)

        expect(result.success).toBe(false)
        expect(result.retryable).toBe(true)
      }
    })

    it('returns alreadyMerged=true when source branch is missing on remote (REN-1166)', async () => {
      mockExecSequence([new Error(MISSING_SOURCE_REF)])
      const result = await strategy.prepare(defaultCtx)
      expect(result.success).toBe(false)
      expect(result.alreadyMerged).toBe(true)
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
    it('pushes HEAD to the target branch via refspec', async () => {
      mockExecSuccess()

      await strategy.finalize(defaultCtx)

      expect(mockExec).toHaveBeenCalledTimes(1)
      const calls = mockExec.mock.calls
      expect(calls[0][0]).toBe('git push origin HEAD:main')
      expect(calls[0][1]).toEqual({ cwd: '/worktree' })
    })

    it('never issues a non-detached checkout during finalize', async () => {
      mockExecSuccess()
      await strategy.finalize(defaultCtx)
      for (const [cmd] of mockExec.mock.calls) {
        expect(cmd).not.toMatch(/git checkout (?!--detach)/)
      }
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
    it('fetches both branches and detaches at origin/<target>', async () => {
      mockExecSequence([
        '',            // git fetch origin main feature/test
        '',            // git checkout --detach origin/main
        'ccc333\n',   // git rev-parse HEAD
      ])

      const result = await strategy.prepare(defaultCtx)

      expect(result).toEqual({ success: true, headSha: 'ccc333' })
      const calls = mockExec.mock.calls
      expect(calls[0][0]).toBe('git fetch origin main feature/test')
      expect(calls[1][0]).toBe('git checkout --detach origin/main')
      expect(calls[1][1]).toEqual({ cwd: '/worktree' })
    })

    it('cleans worktree state before fetching', async () => {
      mockExecSuccess('ccc333\n')
      await strategy.prepare(defaultCtx)
      expect(mockCleanWorktreeState).toHaveBeenCalledWith('/worktree')
    })

    it('never issues a non-detached checkout of the target branch', async () => {
      mockExecSuccess('ccc333\n')
      await strategy.prepare(defaultCtx)
      for (const [cmd] of mockExec.mock.calls) {
        expect(cmd).not.toMatch(/git checkout (?!--detach)/)
      }
    })

    it('returns retryable=true on branch-conflict errors (both phrasings)', async () => {
      for (const msg of [BRANCH_CONFLICT_USED_BY, BRANCH_CONFLICT_CHECKED_OUT]) {
        vi.clearAllMocks()
        mockExecSequence(['', new Error(msg)])

        const result = await strategy.prepare(defaultCtx)

        expect(result.success).toBe(false)
        expect(result.retryable).toBe(true)
      }
    })

    it('returns alreadyMerged=true when source branch is missing on remote (REN-1166)', async () => {
      mockExecSequence([new Error(MISSING_SOURCE_REF)])
      const result = await strategy.prepare(defaultCtx)
      expect(result.success).toBe(false)
      expect(result.alreadyMerged).toBe(true)
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
    it('pushes HEAD to the target branch via refspec', async () => {
      mockExecSuccess()

      await strategy.finalize(defaultCtx)

      expect(mockExec).toHaveBeenCalledTimes(1)
      const calls = mockExec.mock.calls
      expect(calls[0][0]).toBe('git push origin HEAD:main')
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
