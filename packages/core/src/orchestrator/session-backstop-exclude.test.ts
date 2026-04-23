/**
 * Backstop exclusion tests
 *
 * Two layers:
 *   1. Unit tests for `shouldExcludeFromBackstop` — pure string logic, no git.
 *   2. Integration tests driving the real backstop against a tmp git repo,
 *      so we catch regressions in the `git add -A` / unstage / commit flow
 *      that the mock-based session-backstop.test.ts cannot see. This file
 *      does NOT mock child_process.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shouldExcludeFromBackstop, runBackstop, type SessionContext } from './session-backstop.js'
import type { AgentProcess } from './types.js'

// ---------------------------------------------------------------------------
// Unit tests — pure path-matching logic
// ---------------------------------------------------------------------------

describe('shouldExcludeFromBackstop', () => {
  it.each([
    // [path, expected]
    ['src/foo.ts', false],
    ['README.md', false],
    ['packages/core/src/main.ts', false],
    // top-level .cache and under
    ['.cache/af', true],
    ['.cache/agent_reconnect.cover.out', true],
    ['.cache/go-build/abc/def.a', true],
    // nested .cache also excluded
    ['packages/core/.cache/foo', true],
    // node_modules anywhere
    ['node_modules/react/index.js', true],
    ['packages/app/node_modules/foo.js', true],
    // dist anywhere
    ['dist/bundle.js', true],
    ['packages/ui/dist/index.d.ts', true],
    // Python
    ['src/__pycache__/foo.cpython-312.pyc', true],
    ['script.pyc', true],
    // Rust target build/release
    ['target/debug/main', true],
    ['target/release/app', true],
    // Top-level .agent only
    ['.agent/heartbeat.json', true],
    ['.agent/progress.log', true],
    // A file *named* .agent (no subpath) should NOT be excluded
    ['.agent', false],
    // Nested .agent is NOT excluded (hypothetical project dir named .agent)
    ['packages/foo/.agent/state.json', false],
    // extension matches
    ['build.log', true],
    ['tmp/thing.tmp', true],
    // debug binaries
    ['__debug_bin12345', true],
    ['cmd/app/__debug_bin_go_tools', true],
    // Empty / edge cases
    ['', false],
  ])('returns %s for %s', (path, expected) => {
    expect(shouldExcludeFromBackstop(path as string)).toBe(expected as boolean)
  })
})

// ---------------------------------------------------------------------------
// Integration tests — real tmp git repo
// ---------------------------------------------------------------------------

describe('backstop auto-commit integration (real git repo)', () => {
  let tmpRoot: string
  let repoPath: string

  /**
   * Run `git -C <repoPath> …` synchronously.
   * Inherits no PATH rewrites; relies on the host's `git`.
   */
  function git(args: string[], cwd = repoPath): string {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test User',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test User',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    }).trim()
  }

  function createAgent(overrides?: Partial<AgentProcess>): AgentProcess {
    return {
      issueId: 'issue-1',
      identifier: 'SUP-123',
      status: 'completed',
      startedAt: new Date(),
      completedAt: new Date(),
      pid: 123,
      lastActivityAt: new Date(),
      workType: 'development',
      worktreePath: repoPath,
      ...overrides,
    }
  }

  function createCtx(overrides?: Partial<SessionContext>): SessionContext {
    return {
      agent: createAgent(),
      commentPosted: false,
      issueUpdated: false,
      subIssuesCreated: false,
      ...overrides,
    }
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'backstop-exclude-'))
    repoPath = join(tmpRoot, 'repo')
    mkdirSync(repoPath, { recursive: true })

    // Initialize repo with a `main` branch and one commit so rev-list main..HEAD works.
    git(['init', '-q', '-b', 'main'])
    git(['config', 'user.name', 'Test User'])
    git(['config', 'user.email', 'test@example.com'])
    writeFileSync(join(repoPath, 'README.md'), '# test\n')
    git(['add', 'README.md'])
    git(['commit', '-q', '-m', 'initial'])

    // Switch to a feature branch — backstop requires branch ahead of main.
    git(['checkout', '-q', '-b', 'SUP-123'])
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('commits a real source file and unstages cache/node_modules/.agent/*.log noise', () => {
    // Add ONE real file
    writeFileSync(join(repoPath, 'real.ts'), 'export const x = 1\n')

    // And lots of things that should be excluded
    mkdirSync(join(repoPath, '.cache/go-build'), { recursive: true })
    writeFileSync(join(repoPath, '.cache/go-build/obj.a'), 'binary\n')
    writeFileSync(join(repoPath, '.cache/coverage.cover.out'), 'data\n')

    mkdirSync(join(repoPath, 'node_modules/react'), { recursive: true })
    writeFileSync(join(repoPath, 'node_modules/react/index.js'), 'module.exports = 1\n')

    mkdirSync(join(repoPath, '.agent'), { recursive: true })
    writeFileSync(join(repoPath, '.agent/heartbeat.json'), '{}\n')
    writeFileSync(join(repoPath, '.agent/progress.log'), 'line\n')

    writeFileSync(join(repoPath, 'debug.log'), 'log\n')
    writeFileSync(join(repoPath, 'scratch.tmp'), 'tmp\n')

    mkdirSync(join(repoPath, 'dist'), { recursive: true })
    writeFileSync(join(repoPath, 'dist/bundle.js'), 'b\n')

    // Run the backstop (it will inspect git state, auto-commit missing work).
    // The branch has no commits yet so `commits_present` is false — exactly
    // the state the real backstop is designed to fix.
    const result = runBackstop(createCtx())

    // The commit must have happened
    const commitAction = result.backstop.actions.find(a => a.field === 'commits_present')
    expect(commitAction, JSON.stringify(result.backstop.actions)).toBeDefined()
    expect(commitAction!.success).toBe(true)

    // Inspect the actual commit: only real.ts should be in it.
    const committed = git(['log', '--name-only', '--pretty=format:', 'main..HEAD'])
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
      .sort()

    expect(committed).toEqual(['real.ts'])

    // Sanity: the other paths must NOT appear in any committed entry.
    for (const bad of [
      '.cache/go-build/obj.a',
      '.cache/coverage.cover.out',
      'node_modules/react/index.js',
      '.agent/heartbeat.json',
      '.agent/progress.log',
      'debug.log',
      'scratch.tmp',
      'dist/bundle.js',
    ]) {
      expect(committed).not.toContain(bad)
    }
  })

  it('still commits tracked-but-ignored .agent files when they are the ONLY change? no — skips commit with "all excluded" outcome', () => {
    // If EVERY change matches an exclude rule, the backstop should refuse to
    // commit rather than make an empty PR.
    mkdirSync(join(repoPath, '.agent'), { recursive: true })
    writeFileSync(join(repoPath, '.agent/heartbeat.json'), '{}\n')
    writeFileSync(join(repoPath, 'noise.log'), 'log\n')

    const result = runBackstop(createCtx())
    const commitAction = result.backstop.actions.find(a => a.field === 'commits_present')
    expect(commitAction).toBeDefined()
    expect(commitAction!.success).toBe(false)
    expect(commitAction!.action).toMatch(/all changes were build artifacts/i)

    // And no commit should have landed on the feature branch
    const revCount = git(['rev-list', '--count', 'main..HEAD'])
    expect(revCount).toBe('0')
  })

  it('unstages .agent files that were already tracked before the backstop ran', () => {
    // Simulate the real-world case (REN-74): .agent/ files were tracked by a
    // prior commit on main, then the agent modified them. `git add -A`
    // re-stages those modifications even though .gitignore says .agent/.
    // The backstop must unstage them.
    //
    // Setup order: check out main, track the .agent file (before .gitignore
    // exists), then add .gitignore. Git keeps tracking the file but stops
    // adding siblings. Then branch off main and have the agent modify the
    // tracked file plus add a real source file.
    git(['checkout', '-q', 'main'])
    mkdirSync(join(repoPath, '.agent'), { recursive: true })
    writeFileSync(join(repoPath, '.agent/heartbeat.json'), 'old\n')
    git(['add', '.agent/heartbeat.json'])
    git(['commit', '-q', '-m', 'track agent dir'])
    writeFileSync(join(repoPath, '.gitignore'), '.agent/\n')
    git(['add', '.gitignore'])
    git(['commit', '-q', '-m', 'ignore agent dir for future additions'])

    // Branch off main, then simulate the agent's edits
    git(['checkout', '-q', '-B', 'SUP-456', 'main'])
    writeFileSync(join(repoPath, '.agent/heartbeat.json'), 'new\n')
    writeFileSync(join(repoPath, 'real.ts'), 'export const x = 1\n')

    const result = runBackstop(createCtx({
      agent: createAgent({ identifier: 'SUP-456' }),
    }))

    const commitAction = result.backstop.actions.find(a => a.field === 'commits_present')
    expect(commitAction, JSON.stringify(result.backstop.actions)).toBeDefined()
    expect(commitAction!.success).toBe(true)

    // Inspect the latest commit on SUP-456 only (diff against main)
    const committed = git(['log', '--name-only', '--pretty=format:', 'main..HEAD'])
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
      .sort()

    expect(committed).toContain('real.ts')
    expect(committed).not.toContain('.agent/heartbeat.json')
  })
})
