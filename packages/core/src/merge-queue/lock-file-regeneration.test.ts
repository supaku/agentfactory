import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('child_process', () => ({
  exec: vi.fn(),
}))

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  access: vi.fn(),
}))

import { exec as execCb } from 'child_process'
import { readFile, writeFile, access } from 'fs/promises'
import { LockFileRegeneration } from './lock-file-regeneration.js'
import type { PackageManager } from './lock-file-regeneration.js'

const mockExec = vi.mocked(execCb)
const mockReadFile = vi.mocked(readFile)
const mockWriteFile = vi.mocked(writeFile)
const mockAccess = vi.mocked(access)

/**
 * Helper: configure the raw exec mock to work with promisify.
 * promisify(exec) turns the callback-style exec into a promise.
 * We mock by calling the callback argument immediately.
 */
function mockExecSuccess(stdout = '', stderr = '') {
  mockExec.mockImplementation((_cmd: unknown, _opts: unknown, callback?: Function) => {
    const cb = typeof _opts === 'function' ? _opts : callback
    cb?.(null, { stdout, stderr })
    return {} as ReturnType<typeof execCb>
  })
}

function mockExecFailure(message: string) {
  mockExec.mockImplementation((_cmd: unknown, _opts: unknown, callback?: Function) => {
    const cb = typeof _opts === 'function' ? _opts : callback
    cb?.(new Error(message), { stdout: '', stderr: '' })
    return {} as ReturnType<typeof execCb>
  })
}

/**
 * Helper: set up exec to succeed for a sequence of calls.
 * Each call pops the next result from the queue; default is success.
 */
function mockExecSequence(results: Array<{ error?: string; stdout?: string }>) {
  let callIndex = 0
  mockExec.mockImplementation((_cmd: unknown, _opts: unknown, callback?: Function) => {
    const cb = typeof _opts === 'function' ? _opts : callback
    const result = results[callIndex] ?? { stdout: '' }
    callIndex++
    if (result.error) {
      cb?.(new Error(result.error), { stdout: '', stderr: '' })
    } else {
      cb?.(null, { stdout: result.stdout ?? '', stderr: '' })
    }
    return {} as ReturnType<typeof execCb>
  })
}

describe('LockFileRegeneration', () => {
  let handler: LockFileRegeneration

  beforeEach(() => {
    vi.clearAllMocks()
    handler = new LockFileRegeneration()
  })

  // -------------------------------------------------------------------------
  // shouldRegenerate
  // -------------------------------------------------------------------------

  describe('shouldRegenerate', () => {
    it('returns true when lockFileRegenerate is true and packageManager is not none', () => {
      expect(handler.shouldRegenerate('pnpm', true)).toBe(true)
      expect(handler.shouldRegenerate('npm', true)).toBe(true)
      expect(handler.shouldRegenerate('yarn', true)).toBe(true)
      expect(handler.shouldRegenerate('bun', true)).toBe(true)
    })

    it('returns false when lockFileRegenerate is false', () => {
      expect(handler.shouldRegenerate('pnpm', false)).toBe(false)
      expect(handler.shouldRegenerate('npm', false)).toBe(false)
      expect(handler.shouldRegenerate('yarn', false)).toBe(false)
      expect(handler.shouldRegenerate('bun', false)).toBe(false)
      expect(handler.shouldRegenerate('none', false)).toBe(false)
    })

    it('returns false when packageManager is none', () => {
      expect(handler.shouldRegenerate('none', true)).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // getLockFileName
  // -------------------------------------------------------------------------

  describe('getLockFileName', () => {
    it('returns correct file for each package manager', () => {
      expect(handler.getLockFileName('pnpm')).toBe('pnpm-lock.yaml')
      expect(handler.getLockFileName('npm')).toBe('package-lock.json')
      expect(handler.getLockFileName('yarn')).toBe('yarn.lock')
      expect(handler.getLockFileName('bun')).toBe('bun.lockb')
    })

    it('returns null for none', () => {
      expect(handler.getLockFileName('none')).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // regenerate
  // -------------------------------------------------------------------------

  describe('regenerate', () => {
    it('deletes lock file, runs install, and stages result for pnpm', async () => {
      mockAccess.mockResolvedValue(undefined)
      mockExecSuccess()

      const result = await handler.regenerate('/tmp/worktree', 'pnpm')

      expect(result).toEqual({
        success: true,
        lockFile: 'pnpm-lock.yaml',
        packageManager: 'pnpm',
      })

      // Verify exec was called 3 times: rm, install, git add
      expect(mockExec).toHaveBeenCalledTimes(3)

      // 1st call: rm the lock file
      const firstCallCmd = mockExec.mock.calls[0][0]
      expect(firstCallCmd).toContain('rm')
      expect(firstCallCmd).toContain('pnpm-lock.yaml')

      // 2nd call: pnpm install
      const secondCallCmd = mockExec.mock.calls[1][0]
      expect(secondCallCmd).toBe('pnpm install --no-frozen-lockfile')

      // 3rd call: git add
      const thirdCallCmd = mockExec.mock.calls[2][0]
      expect(thirdCallCmd).toContain('git add')
      expect(thirdCallCmd).toContain('pnpm-lock.yaml')
    })

    it('works for npm', async () => {
      mockAccess.mockResolvedValue(undefined)
      mockExecSuccess()

      const result = await handler.regenerate('/tmp/worktree', 'npm')

      expect(result.success).toBe(true)
      expect(result.lockFile).toBe('package-lock.json')
      expect(result.packageManager).toBe('npm')

      const installCmd = mockExec.mock.calls[1][0]
      expect(installCmd).toBe('npm install')
    })

    it('works for yarn', async () => {
      mockAccess.mockResolvedValue(undefined)
      mockExecSuccess()

      const result = await handler.regenerate('/tmp/worktree', 'yarn')

      expect(result.success).toBe(true)
      expect(result.lockFile).toBe('yarn.lock')
      expect(result.packageManager).toBe('yarn')

      const installCmd = mockExec.mock.calls[1][0]
      expect(installCmd).toBe('yarn install')
    })

    it('works for bun', async () => {
      mockAccess.mockResolvedValue(undefined)
      mockExecSuccess()

      const result = await handler.regenerate('/tmp/worktree', 'bun')

      expect(result.success).toBe(true)
      expect(result.lockFile).toBe('bun.lockb')
      expect(result.packageManager).toBe('bun')

      const installCmd = mockExec.mock.calls[1][0]
      expect(installCmd).toBe('bun install')
    })

    it('handles install failure gracefully', async () => {
      // access succeeds (lock file exists), rm succeeds, install fails
      mockAccess.mockResolvedValue(undefined)
      mockExecSequence([
        { stdout: '' },                      // rm succeeds
        { error: 'ENOENT: pnpm not found' }, // install fails
      ])

      const result = await handler.regenerate('/tmp/worktree', 'pnpm')

      expect(result.success).toBe(false)
      expect(result.lockFile).toBe('pnpm-lock.yaml')
      expect(result.packageManager).toBe('pnpm')
      expect(result.error).toContain('pnpm not found')
    })

    it('handles missing lock file gracefully (no delete error)', async () => {
      // access throws (lock file doesn't exist), so rm is skipped
      mockAccess.mockRejectedValue(new Error('ENOENT'))
      mockExecSuccess()

      const result = await handler.regenerate('/tmp/worktree', 'pnpm')

      expect(result.success).toBe(true)
      expect(result.lockFile).toBe('pnpm-lock.yaml')

      // Should have only 2 exec calls: install and git add (rm was skipped)
      expect(mockExec).toHaveBeenCalledTimes(2)

      const firstCallCmd = mockExec.mock.calls[0][0]
      expect(firstCallCmd).toBe('pnpm install --no-frozen-lockfile')

      const secondCallCmd = mockExec.mock.calls[1][0]
      expect(secondCallCmd).toContain('git add')
    })

    it('returns error for unsupported package manager (none)', async () => {
      const result = await handler.regenerate('/tmp/worktree', 'none')

      expect(result.success).toBe(false)
      expect(result.lockFile).toBe('')
      expect(result.packageManager).toBe('none')
      expect(result.error).toContain('Unsupported package manager')
    })
  })

  // -------------------------------------------------------------------------
  // ensureGitAttributes
  // -------------------------------------------------------------------------

  describe('ensureGitAttributes', () => {
    it('creates .gitattributes if not exists', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'))
      mockWriteFile.mockResolvedValue(undefined)

      await handler.ensureGitAttributes('/repo', 'pnpm')

      expect(mockWriteFile).toHaveBeenCalledWith(
        '/repo/.gitattributes',
        'pnpm-lock.yaml merge=ours\n',
        'utf-8',
      )
    })

    it('appends entry if not already present', async () => {
      mockReadFile.mockResolvedValue('*.md linguist-documentation\n' as never)
      mockWriteFile.mockResolvedValue(undefined)

      await handler.ensureGitAttributes('/repo', 'pnpm')

      expect(mockWriteFile).toHaveBeenCalledWith(
        '/repo/.gitattributes',
        '*.md linguist-documentation\npnpm-lock.yaml merge=ours\n',
        'utf-8',
      )
    })

    it('appends with newline separator when file does not end with newline', async () => {
      mockReadFile.mockResolvedValue('*.md linguist-documentation' as never)
      mockWriteFile.mockResolvedValue(undefined)

      await handler.ensureGitAttributes('/repo', 'npm')

      expect(mockWriteFile).toHaveBeenCalledWith(
        '/repo/.gitattributes',
        '*.md linguist-documentation\npackage-lock.json merge=ours\n',
        'utf-8',
      )
    })

    it('skips if entry already present', async () => {
      mockReadFile.mockResolvedValue('pnpm-lock.yaml merge=ours\n' as never)

      await handler.ensureGitAttributes('/repo', 'pnpm')

      expect(mockWriteFile).not.toHaveBeenCalled()
    })

    it('handles each package manager', async () => {
      const expectedEntries: Record<string, string> = {
        pnpm: 'pnpm-lock.yaml merge=ours',
        npm: 'package-lock.json merge=ours',
        yarn: 'yarn.lock merge=ours',
        bun: 'bun.lockb merge=ours',
      }

      for (const [pm, expected] of Object.entries(expectedEntries)) {
        vi.clearAllMocks()
        mockReadFile.mockRejectedValue(new Error('ENOENT'))
        mockWriteFile.mockResolvedValue(undefined)

        await handler.ensureGitAttributes('/repo', pm as PackageManager)

        expect(mockWriteFile).toHaveBeenCalledWith(
          '/repo/.gitattributes',
          `${expected}\n`,
          'utf-8',
        )
      }
    })

    it('does nothing for unsupported package manager (none)', async () => {
      await handler.ensureGitAttributes('/repo', 'none')

      expect(mockReadFile).not.toHaveBeenCalled()
      expect(mockWriteFile).not.toHaveBeenCalled()
    })
  })
})
