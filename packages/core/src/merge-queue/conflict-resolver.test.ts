import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('child_process', () => ({
  exec: vi.fn(),
}))

import { exec } from 'child_process'
import { ConflictResolver } from './conflict-resolver.js'
import type { ConflictContext, ConflictResolverConfig } from './conflict-resolver.js'

const mockExec = vi.mocked(exec)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<ConflictContext> = {}): ConflictContext {
  return {
    repoPath: '/repo',
    worktreePath: '/repo/.worktrees/wt-1',
    sourceBranch: 'feature/SUP-100',
    targetBranch: 'main',
    prNumber: 42,
    issueIdentifier: 'SUP-100',
    conflictFiles: ['src/index.ts', 'src/utils.ts'],
    ...overrides,
  }
}

function makeConfig(overrides: Partial<ConflictResolverConfig> = {}): ConflictResolverConfig {
  return {
    mergirafEnabled: true,
    escalationStrategy: 'notify',
    ...overrides,
  }
}

/**
 * Set up mockExec to respond to sequential calls.
 * Each entry maps a pattern (substring match on the command) to a response.
 * Commands not matching any pattern will reject with an error.
 */
function mockExecSequence(
  responses: Array<{
    pattern: string
    stdout?: string
    stderr?: string
    error?: Error | null
  }>,
) {
  const queue = [...responses]
  mockExec.mockImplementation((cmd: string, _opts: unknown, callback?: Function) => {
    const cb = typeof _opts === 'function' ? _opts : callback
    const cmdStr = typeof cmd === 'string' ? cmd : ''

    const idx = queue.findIndex((r) => cmdStr.includes(r.pattern))
    if (idx >= 0) {
      const match = queue[idx]
      queue.splice(idx, 1)
      if (match.error) {
        cb?.(match.error, { stdout: match.stdout ?? '', stderr: match.stderr ?? '' })
      } else {
        cb?.(null, { stdout: match.stdout ?? '', stderr: match.stderr ?? '' })
      }
    } else {
      cb?.(null, { stdout: '', stderr: '' })
    }
    return {} as ReturnType<typeof exec>
  })
}

/**
 * Simple mock where all exec calls succeed with empty stdout.
 */
function mockExecSuccess() {
  mockExec.mockImplementation((_cmd: string, _opts: unknown, callback?: Function) => {
    const cb = typeof _opts === 'function' ? _opts : callback
    cb?.(null, { stdout: '', stderr: '' })
    return {} as ReturnType<typeof exec>
  })
}

/**
 * Mock that routes grep calls (conflict marker checks) to return specific results,
 * and allows other commands (git add, git rebase, git diff) to succeed.
 */
function mockConflictChecks(
  fileResults: Record<string, boolean>,
  opts?: { rebaseError?: Error; diffOutput?: string },
) {
  mockExec.mockImplementation((cmd: string, _opts: unknown, callback?: Function) => {
    const cb = typeof _opts === 'function' ? _opts : callback
    const cmdStr = typeof cmd === 'string' ? cmd : ''

    if (cmdStr.includes('grep -c')) {
      // Find which file this grep is checking
      const file = Object.keys(fileResults).find((f) => cmdStr.includes(`"${f}"`))
      if (file !== undefined) {
        if (fileResults[file]) {
          // Has conflict markers — grep returns count > 0
          cb?.(null, { stdout: '3\n', stderr: '' })
        } else {
          // No conflict markers — grep exits with code 1
          cb?.(new Error('grep: exit code 1'), { stdout: '0\n', stderr: '' })
        }
      } else {
        cb?.(new Error('grep: exit code 1'), { stdout: '0\n', stderr: '' })
      }
    } else if (cmdStr.includes('git rebase --continue')) {
      if (opts?.rebaseError) {
        cb?.(opts.rebaseError, { stdout: '', stderr: opts.rebaseError.message })
      } else {
        cb?.(null, { stdout: '', stderr: '' })
      }
    } else if (cmdStr.includes('git diff')) {
      cb?.(null, { stdout: opts?.diffOutput ?? 'diff --git a/file\n+change', stderr: '' })
    } else {
      // git add or other commands succeed
      cb?.(null, { stdout: '', stderr: '' })
    }
    return {} as ReturnType<typeof exec>
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConflictResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // resolve() routing
  // -------------------------------------------------------------------------

  describe('resolve()', () => {
    it('goes straight to escalation when mergiraf is disabled', async () => {
      mockExecSuccess()
      const resolver = new ConflictResolver(makeConfig({ mergirafEnabled: false }))
      const ctx = makeContext()

      const result = await resolver.resolve(ctx)

      expect(result.method).toBe('escalation')
      expect(result.escalationAction).toBe('notify')
      expect(result.unresolvedFiles).toEqual(ctx.conflictFiles)
      // Should never call grep for conflict markers
      const grepCalls = mockExec.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('grep'),
      )
      expect(grepCalls).toHaveLength(0)
    })

    it('attempts mergiraf auto-resolution first when enabled', async () => {
      // All files have conflicts — mergiraf fails to resolve
      mockConflictChecks({
        'src/index.ts': true,
        'src/utils.ts': true,
      })
      const resolver = new ConflictResolver(makeConfig({ mergirafEnabled: true }))
      const ctx = makeContext()

      const result = await resolver.resolve(ctx)

      // Should have called grep for conflict markers
      const grepCalls = mockExec.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('grep'),
      )
      expect(grepCalls).toHaveLength(2)
      // Falls through to escalation
      expect(result.escalationAction).toBe('notify')
    })
  })

  // -------------------------------------------------------------------------
  // attemptMergiraf
  // -------------------------------------------------------------------------

  describe('attemptMergiraf (via resolve)', () => {
    it('resolves all files and returns resolved status', async () => {
      // No conflict markers in any file — mergiraf resolved them all
      mockConflictChecks({
        'src/index.ts': false,
        'src/utils.ts': false,
      })
      const resolver = new ConflictResolver(makeConfig({ mergirafEnabled: true }))
      const ctx = makeContext()

      const result = await resolver.resolve(ctx)

      expect(result.status).toBe('resolved')
      expect(result.method).toBe('mergiraf')
      expect(result.resolvedFiles).toEqual(['src/index.ts', 'src/utils.ts'])
      expect(result.unresolvedFiles).toBeUndefined()

      // git add called for each resolved file
      const addCalls = mockExec.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('git add'),
      )
      expect(addCalls).toHaveLength(2)

      // git rebase --continue called
      const rebaseCalls = mockExec.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('git rebase --continue'),
      )
      expect(rebaseCalls).toHaveLength(1)
    })

    it('resolves some files and escalates with remaining', async () => {
      // index.ts resolved, utils.ts still has conflicts
      mockConflictChecks({
        'src/index.ts': false,
        'src/utils.ts': true,
      })
      const resolver = new ConflictResolver(
        makeConfig({ mergirafEnabled: true, escalationStrategy: 'notify' }),
      )
      const ctx = makeContext()

      const result = await resolver.resolve(ctx)

      // Mergiraf partial resolution falls through to escalation
      expect(result.status).toBe('escalated')
      expect(result.method).toBe('escalation')
      expect(result.escalationAction).toBe('notify')
      // The escalation context should only contain the unresolved file
      expect(result.unresolvedFiles).toEqual(['src/utils.ts'])
    })

    it('resolves no files and escalates with all files', async () => {
      mockConflictChecks({
        'src/index.ts': true,
        'src/utils.ts': true,
      })
      const resolver = new ConflictResolver(
        makeConfig({ mergirafEnabled: true, escalationStrategy: 'park' }),
      )
      const ctx = makeContext()

      const result = await resolver.resolve(ctx)

      expect(result.status).toBe('parked')
      expect(result.method).toBe('escalation')
      expect(result.escalationAction).toBe('park')
      expect(result.unresolvedFiles).toEqual(['src/index.ts', 'src/utils.ts'])
    })

    it('handles rebase --continue failure gracefully', async () => {
      // All files resolved but rebase continue fails
      mockConflictChecks(
        {
          'src/index.ts': false,
          'src/utils.ts': false,
        },
        { rebaseError: new Error('rebase failed: could not apply commit') },
      )
      const resolver = new ConflictResolver(makeConfig({ mergirafEnabled: true }))
      const ctx = makeContext()

      const result = await resolver.resolve(ctx)

      // Mergiraf reports escalated due to rebase failure, then resolve()
      // falls through to the configured escalation strategy (notify)
      expect(result.status).toBe('escalated')
      expect(result.method).toBe('escalation')
      expect(result.escalationAction).toBe('notify')
      // The conflict files from mergiraf's failure are forwarded to escalation
      expect(result.unresolvedFiles).toEqual(['src/index.ts', 'src/utils.ts'])
    })
  })

  // -------------------------------------------------------------------------
  // fileHasConflictMarkers
  // -------------------------------------------------------------------------

  describe('fileHasConflictMarkers (via resolve)', () => {
    it('returns true when conflict markers are present', async () => {
      // Set up: one file with markers, one without
      mockConflictChecks({
        'src/index.ts': true,
        'src/utils.ts': false,
      })
      const resolver = new ConflictResolver(makeConfig({ mergirafEnabled: true }))
      const ctx = makeContext()

      const result = await resolver.resolve(ctx)

      // index.ts was NOT resolved (has markers), utils.ts was resolved
      // Partial resolution — goes to escalation for index.ts
      expect(result.unresolvedFiles).toEqual(['src/index.ts'])
    })

    it('returns false when grep exits with code 1 (no markers)', async () => {
      // All files return grep exit 1 (no markers)
      mockConflictChecks({
        'src/index.ts': false,
        'src/utils.ts': false,
      })
      const resolver = new ConflictResolver(makeConfig({ mergirafEnabled: true }))
      const ctx = makeContext({ conflictFiles: ['src/index.ts'] })

      const result = await resolver.resolve(ctx)

      expect(result.status).toBe('resolved')
      expect(result.method).toBe('mergiraf')
    })
  })

  // -------------------------------------------------------------------------
  // Escalation strategies
  // -------------------------------------------------------------------------

  describe('escalation strategies', () => {
    it('reassign returns escalated with diff context', async () => {
      const diffOutput = 'diff --git a/src/index.ts\n+++ b/src/index.ts\n@@ conflict @@'
      mockConflictChecks({}, { diffOutput })
      const resolver = new ConflictResolver(
        makeConfig({ mergirafEnabled: false, escalationStrategy: 'reassign' }),
      )
      const ctx = makeContext()

      const result = await resolver.resolve(ctx)

      expect(result.status).toBe('escalated')
      expect(result.method).toBe('escalation')
      expect(result.escalationAction).toBe('reassign')
      expect(result.unresolvedFiles).toEqual(ctx.conflictFiles)
      expect(result.message).toContain('SUP-100')
      expect(result.message).toContain('PR #42')
      expect(result.message).toContain('Agent should resolve and re-submit')
      expect(result.message).toContain('Diff:')
      expect(result.message).toContain(diffOutput)
    })

    it('notify returns escalated with file list', async () => {
      mockExecSuccess()
      const resolver = new ConflictResolver(
        makeConfig({ mergirafEnabled: false, escalationStrategy: 'notify' }),
      )
      const ctx = makeContext()

      const result = await resolver.resolve(ctx)

      expect(result.status).toBe('escalated')
      expect(result.method).toBe('escalation')
      expect(result.escalationAction).toBe('notify')
      expect(result.unresolvedFiles).toEqual(ctx.conflictFiles)
      expect(result.message).toContain('Merge conflict on SUP-100 PR #42')
      expect(result.message).toContain('src/index.ts')
      expect(result.message).toContain('src/utils.ts')
    })

    it('park returns parked status', async () => {
      mockExecSuccess()
      const resolver = new ConflictResolver(
        makeConfig({ mergirafEnabled: false, escalationStrategy: 'park' }),
      )
      const ctx = makeContext()

      const result = await resolver.resolve(ctx)

      expect(result.status).toBe('parked')
      expect(result.method).toBe('escalation')
      expect(result.escalationAction).toBe('park')
      expect(result.unresolvedFiles).toEqual(ctx.conflictFiles)
      expect(result.message).toContain('PR #42 parked')
      expect(result.message).toContain('auto-retry')
    })

    it('reassign includes truncated diff when git diff output is available', async () => {
      const longDiff = 'x'.repeat(6000)
      mockConflictChecks({}, { diffOutput: longDiff })
      const resolver = new ConflictResolver(
        makeConfig({ mergirafEnabled: false, escalationStrategy: 'reassign' }),
      )
      const ctx = makeContext()

      const result = await resolver.resolve(ctx)

      // The diff should be truncated to 5000 chars
      expect(result.message).toBeDefined()
      expect(result.message!.includes('Diff:')).toBe(true)
      // The diff portion within the message should be at most 5000 chars
      const diffStart = result.message!.indexOf('Diff:\n') + 'Diff:\n'.length
      const diffPortion = result.message!.slice(diffStart)
      expect(diffPortion.length).toBeLessThanOrEqual(5000)
    })

    it('reassign handles git diff failure gracefully', async () => {
      // Make git diff fail
      mockExec.mockImplementation((cmd: string, _opts: unknown, callback?: Function) => {
        const cb = typeof _opts === 'function' ? _opts : callback
        const cmdStr = typeof cmd === 'string' ? cmd : ''
        if (cmdStr.includes('git diff')) {
          cb?.(new Error('diff failed'), { stdout: '', stderr: '' })
        } else {
          cb?.(null, { stdout: '', stderr: '' })
        }
        return {} as ReturnType<typeof exec>
      })
      const resolver = new ConflictResolver(
        makeConfig({ mergirafEnabled: false, escalationStrategy: 'reassign' }),
      )
      const ctx = makeContext()

      const result = await resolver.resolve(ctx)

      expect(result.status).toBe('escalated')
      expect(result.escalationAction).toBe('reassign')
      expect(result.message).toContain('(unable to generate diff)')
    })
  })

  // -------------------------------------------------------------------------
  // rebase --continue
  // -------------------------------------------------------------------------

  describe('rebase --continue', () => {
    it('is called after all conflicts are resolved by mergiraf', async () => {
      mockConflictChecks({
        'src/index.ts': false,
        'src/utils.ts': false,
      })
      const resolver = new ConflictResolver(makeConfig({ mergirafEnabled: true }))
      const ctx = makeContext()

      await resolver.resolve(ctx)

      const rebaseCalls = mockExec.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('git rebase --continue'),
      )
      expect(rebaseCalls).toHaveLength(1)

      // Verify GIT_EDITOR=true is set to avoid editor prompt
      const rebaseOpts = rebaseCalls[0][1] as { env?: Record<string, string> }
      expect(rebaseOpts.env?.GIT_EDITOR).toBe('true')
    })

    it('is NOT called when some files remain unresolved', async () => {
      mockConflictChecks({
        'src/index.ts': false,
        'src/utils.ts': true,
      })
      const resolver = new ConflictResolver(makeConfig({ mergirafEnabled: true }))
      const ctx = makeContext()

      await resolver.resolve(ctx)

      const rebaseCalls = mockExec.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('git rebase --continue'),
      )
      expect(rebaseCalls).toHaveLength(0)
    })

    it('failure results in escalation with descriptive message', async () => {
      mockConflictChecks(
        { 'src/index.ts': false },
        { rebaseError: new Error('Could not apply abc123') },
      )
      const resolver = new ConflictResolver(
        makeConfig({ mergirafEnabled: true, escalationStrategy: 'notify' }),
      )
      const ctx = makeContext({ conflictFiles: ['src/index.ts'] })

      const result = await resolver.resolve(ctx)

      // When rebase --continue fails, attemptMergiraf returns 'escalated',
      // which causes resolve() to fall through to the escalation strategy.
      // The final result comes from the notify escalation.
      expect(result.status).toBe('escalated')
      expect(result.method).toBe('escalation')
      expect(result.escalationAction).toBe('notify')
      expect(result.message).toContain('Merge conflict on SUP-100 PR #42')
    })
  })

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles empty conflictFiles list', async () => {
      mockExecSuccess()
      const resolver = new ConflictResolver(makeConfig({ mergirafEnabled: false }))
      const ctx = makeContext({ conflictFiles: [] })

      const result = await resolver.resolve(ctx)

      expect(result.status).toBe('escalated')
      expect(result.unresolvedFiles).toEqual([])
    })

    it('handles single conflict file', async () => {
      mockConflictChecks({ 'src/index.ts': false })
      const resolver = new ConflictResolver(makeConfig({ mergirafEnabled: true }))
      const ctx = makeContext({ conflictFiles: ['src/index.ts'] })

      const result = await resolver.resolve(ctx)

      expect(result.status).toBe('resolved')
      expect(result.resolvedFiles).toEqual(['src/index.ts'])
    })

    it('defaults to notify escalation for unknown strategy', async () => {
      mockExecSuccess()
      // Force an unknown strategy to test the default branch
      const resolver = new ConflictResolver(
        makeConfig({
          mergirafEnabled: false,
          escalationStrategy: 'unknown' as 'notify',
        }),
      )
      const ctx = makeContext()

      const result = await resolver.resolve(ctx)

      expect(result.escalationAction).toBe('notify')
    })
  })
})
