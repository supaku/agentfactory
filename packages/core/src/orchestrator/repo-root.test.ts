import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { findRepoRoot, resolveMainRepoRoot } from './orchestrator.js'

/**
 * Tests for findRepoRoot and resolveMainRepoRoot.
 *
 * These use real filesystem temp dirs to exercise the exact stat/read logic
 * that distinguishes .git directories (main repos) from .git files (worktrees).
 */

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'repo-root-test-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('findRepoRoot', () => {
  it('returns the directory containing a .git directory', () => {
    mkdirSync(join(tempDir, '.git'))
    expect(findRepoRoot(tempDir)).toBe(tempDir)
  })

  it('returns the directory containing a .git file (worktree)', () => {
    writeFileSync(join(tempDir, '.git'), 'gitdir: /some/path')
    expect(findRepoRoot(tempDir)).toBe(tempDir)
  })

  it('walks up to find .git in an ancestor directory', () => {
    mkdirSync(join(tempDir, '.git'))
    const nested = join(tempDir, 'src', 'deep', 'dir')
    mkdirSync(nested, { recursive: true })
    expect(findRepoRoot(nested)).toBe(tempDir)
  })

  it('returns null when no .git exists', () => {
    const isolated = mkdtempSync(join(tmpdir(), 'no-git-'))
    try {
      expect(findRepoRoot(isolated)).toBeNull()
    } finally {
      rmSync(isolated, { recursive: true, force: true })
    }
  })

  it('does NOT distinguish .git files from directories — returns worktree path', () => {
    // This is the bug that resolveMainRepoRoot fixes.
    // findRepoRoot returns the worktree root because it only checks existsSync.
    const worktreeDir = join(tempDir, 'worktree')
    mkdirSync(worktreeDir)
    writeFileSync(join(worktreeDir, '.git'), 'gitdir: /irrelevant')
    expect(findRepoRoot(worktreeDir)).toBe(worktreeDir)
  })
})

describe('resolveMainRepoRoot', () => {
  it('returns the directory containing a real .git directory', () => {
    mkdirSync(join(tempDir, '.git'))
    expect(resolveMainRepoRoot(tempDir)).toBe(tempDir)
  })

  it('follows a worktree .git file back to the main repo root', () => {
    // Simulate: main repo at tempDir/main-repo with .git/worktrees/my-branch/
    const mainRepo = join(tempDir, 'main-repo')
    const mainGitDir = join(mainRepo, '.git')
    const worktreesDir = join(mainGitDir, 'worktrees', 'my-branch')
    mkdirSync(worktreesDir, { recursive: true })

    // Worktree at tempDir/worktrees/my-branch/ with .git file pointing back
    const worktreeDir = join(tempDir, 'worktrees', 'my-branch')
    mkdirSync(worktreeDir, { recursive: true })
    writeFileSync(
      join(worktreeDir, '.git'),
      `gitdir: ${worktreesDir}`,
    )

    expect(resolveMainRepoRoot(worktreeDir)).toBe(mainRepo)
  })

  it('follows a worktree .git file with relative gitdir path', () => {
    // main repo at tempDir/repo, worktree at tempDir/repo.wt/feat
    const mainRepo = join(tempDir, 'repo')
    const mainGitDir = join(mainRepo, '.git')
    const worktreesDir = join(mainGitDir, 'worktrees', 'feat')
    mkdirSync(worktreesDir, { recursive: true })

    const worktreeDir = join(tempDir, 'repo.wt', 'feat')
    mkdirSync(worktreeDir, { recursive: true })
    // Relative path from worktree to main .git/worktrees/feat
    writeFileSync(
      join(worktreeDir, '.git'),
      `gitdir: ../../repo/.git/worktrees/feat`,
    )

    expect(resolveMainRepoRoot(worktreeDir)).toBe(mainRepo)
  })

  it('walks up from a nested subdirectory inside a worktree', () => {
    const mainRepo = join(tempDir, 'main-repo')
    const mainGitDir = join(mainRepo, '.git')
    const worktreesDir = join(mainGitDir, 'worktrees', 'branch')
    mkdirSync(worktreesDir, { recursive: true })

    const worktreeDir = join(tempDir, 'wt', 'branch')
    mkdirSync(worktreeDir, { recursive: true })
    writeFileSync(join(worktreeDir, '.git'), `gitdir: ${worktreesDir}`)

    const nestedDir = join(worktreeDir, 'src', 'components')
    mkdirSync(nestedDir, { recursive: true })

    expect(resolveMainRepoRoot(nestedDir)).toBe(mainRepo)
  })

  it('returns null when no .git exists anywhere', () => {
    const isolated = mkdtempSync(join(tmpdir(), 'no-git-'))
    try {
      expect(resolveMainRepoRoot(isolated)).toBeNull()
    } finally {
      rmSync(isolated, { recursive: true, force: true })
    }
  })

  it('returns null when .git file has invalid content', () => {
    // If .git file doesn't start with "gitdir:", the function can't resolve a
    // main repo root and returns null (no catch — it just skips the gitdir branch)
    writeFileSync(join(tempDir, '.git'), 'not a valid gitdir reference')
    expect(resolveMainRepoRoot(tempDir)).toBeNull()
  })

  it('returns main repo root even when worktree is deeper than main repo', () => {
    // Simulate a deeply nested worktree layout:
    // tempDir/deep/nested/main-repo/.git/worktrees/feat/
    // tempDir/deep/nested/main-repo.wt/feat/.git (file)
    const mainRepo = join(tempDir, 'deep', 'nested', 'main-repo')
    const worktreesDir = join(mainRepo, '.git', 'worktrees', 'feat')
    mkdirSync(worktreesDir, { recursive: true })

    const worktreeDir = join(tempDir, 'deep', 'nested', 'main-repo.wt', 'feat')
    mkdirSync(worktreeDir, { recursive: true })
    writeFileSync(join(worktreeDir, '.git'), `gitdir: ${worktreesDir}`)

    expect(resolveMainRepoRoot(worktreeDir)).toBe(mainRepo)
  })
})

describe('resolveMainRepoRoot vs findRepoRoot — the bug scenario', () => {
  it('findRepoRoot returns the worktree path while resolveMainRepoRoot returns the main repo', () => {
    // This is the exact scenario from the bug report:
    // Orchestrator runs from a linked worktree. findRepoRoot returns the worktree
    // path (wrong), resolveMainRepoRoot returns the main repo root (correct).
    const mainRepo = join(tempDir, 'platform')
    const mainGitDir = join(mainRepo, '.git')
    const worktreesDir = join(mainGitDir, 'worktrees', 'platform-1')
    mkdirSync(worktreesDir, { recursive: true })

    const worktreeDir = join(tempDir, 'platform.wt', 'platform-1')
    mkdirSync(worktreeDir, { recursive: true })
    writeFileSync(join(worktreeDir, '.git'), `gitdir: ${worktreesDir}`)

    // findRepoRoot: returns worktree path (the bug)
    expect(findRepoRoot(worktreeDir)).toBe(worktreeDir)

    // resolveMainRepoRoot: returns main repo root (the fix)
    expect(resolveMainRepoRoot(worktreeDir)).toBe(mainRepo)

    // The fixed constructor logic: resolveMainRepoRoot ?? findRepoRoot ?? cwd
    const gitRoot = resolveMainRepoRoot(worktreeDir) ?? findRepoRoot(worktreeDir) ?? worktreeDir
    expect(gitRoot).toBe(mainRepo)
  })

  it('both functions agree for a normal (non-worktree) repo', () => {
    mkdirSync(join(tempDir, '.git'))
    expect(findRepoRoot(tempDir)).toBe(tempDir)
    expect(resolveMainRepoRoot(tempDir)).toBe(tempDir)
  })
})
