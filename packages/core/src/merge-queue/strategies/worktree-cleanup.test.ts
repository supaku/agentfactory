import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('child_process', () => ({
  exec: vi.fn(),
}))

import { exec } from 'child_process'
import { cleanWorktreeState } from './worktree-cleanup.js'

const mockExec = vi.mocked(exec)

function mockExecRouter(routes: Record<string, string | Error>) {
  mockExec.mockImplementation((cmd: string, _opts: unknown, callback?: Function) => {
    const cb = typeof _opts === 'function' ? _opts : callback
    const match = Object.keys(routes).find((pattern) => cmd.includes(pattern))
    const result = match ? routes[match] : ''
    if (result instanceof Error) {
      cb?.(result, { stdout: '', stderr: '' })
    } else {
      cb?.(null, { stdout: result, stderr: '' })
    }
    return {} as ReturnType<typeof exec>
  })
}

describe('cleanWorktreeState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('issues abort commands, reset, and clean — in that order', async () => {
    mockExecRouter({})  // all commands succeed, return empty stdout

    await cleanWorktreeState('/worktree')

    const commands = mockExec.mock.calls.map(([cmd]) => cmd as string)
    expect(commands).toEqual([
      'git rebase --abort',
      'git merge --abort',
      'git cherry-pick --abort',
      'git reset --hard HEAD',
      'git clean -fd',
    ])
  })

  it('passes the worktree path as cwd for every command', async () => {
    mockExecRouter({})

    await cleanWorktreeState('/some/custom/path')

    for (const [, opts] of mockExec.mock.calls) {
      expect(opts).toEqual({ cwd: '/some/custom/path' })
    }
  })

  it('swallows "no rebase in progress" errors from abort commands', async () => {
    // This is the expected steady state — no rebase/merge is in progress on
    // most runs, so the abort commands are expected to fail. They must not
    // throw back to prepare().
    mockExecRouter({
      'rebase --abort': new Error('fatal: no rebase in progress'),
      'merge --abort': new Error('fatal: There is no merge to abort'),
      'cherry-pick --abort': new Error('fatal: no cherry-pick in progress'),
    })

    await expect(cleanWorktreeState('/worktree')).resolves.toBeUndefined()
  })

  it('swallows "nothing to commit" on reset and continues to clean', async () => {
    mockExecRouter({
      'reset --hard': new Error('fatal: ambiguous argument HEAD'),
    })

    await expect(cleanWorktreeState('/worktree')).resolves.toBeUndefined()

    // Even after reset fails, clean is still attempted.
    const cleanCall = mockExec.mock.calls.find(([cmd]) => (cmd as string).includes('git clean -fd'))
    expect(cleanCall).toBeDefined()
  })

  it('never uses `git clean -x` (ignored files survive — node_modules stays)', async () => {
    // Regression guard: `-x` would delete `node_modules/` and add ~30s to
    // every prepare() for reinstalls.
    mockExecRouter({})

    await cleanWorktreeState('/worktree')

    for (const [cmd] of mockExec.mock.calls) {
      expect(cmd).not.toMatch(/git clean.*-\w*x/)
    }
  })

  it('is a no-throw contract even when every command fails', async () => {
    mockExecRouter({
      'rebase --abort': new Error('fail'),
      'merge --abort': new Error('fail'),
      'cherry-pick --abort': new Error('fail'),
      'reset --hard': new Error('fail'),
      'clean -fd': new Error('fail'),
    })

    await expect(cleanWorktreeState('/worktree')).resolves.toBeUndefined()
  })
})
