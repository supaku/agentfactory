import { describe, it, expect } from 'vitest'
import {
  isBranchConflictError,
  isMissingRemoteRefError,
  parseConflictingWorktreePath,
} from './branch-conflict.js'

describe('isBranchConflictError', () => {
  it('matches the "is already used by worktree at" phrasing', () => {
    // This is the exact message observed in REN-1253 / REN-1254 merge-queue
    // failures — the one the fix was written to resolve.
    const msg = "Command failed: git checkout REN-1253\nfatal: 'REN-1253' is already used by worktree at '/Users/me/repo.wt/REN-1253-AC'"
    expect(isBranchConflictError(msg)).toBe(true)
  })

  it('matches the "is already checked out at" phrasing', () => {
    const msg = "fatal: 'feature/x' is already checked out at '/home/u/repo/.worktrees/feature-x'"
    expect(isBranchConflictError(msg)).toBe(true)
  })

  it('returns false for unrelated git errors', () => {
    expect(isBranchConflictError('fatal: could not read from remote repository')).toBe(false)
    expect(isBranchConflictError('CONFLICT (content): Merge conflict in foo.ts')).toBe(false)
    expect(isBranchConflictError('error: pathspec "X" did not match any file(s) known to git')).toBe(false)
  })

  it('returns false for empty input', () => {
    expect(isBranchConflictError('')).toBe(false)
  })

  it('is case-sensitive — git always emits lowercase', () => {
    // If this ever flips, the downstream retry logic would stop firing. Lock
    // it in so a well-meaning refactor can't silently regress.
    expect(isBranchConflictError("'X' IS ALREADY USED BY WORKTREE AT '/p'")).toBe(false)
  })
})

describe('parseConflictingWorktreePath', () => {
  it('extracts the path from "used by worktree at" phrasing', () => {
    const msg = "fatal: 'REN-1253' is already used by worktree at '/Users/me/repo.wt/REN-1253-AC'"
    expect(parseConflictingWorktreePath(msg)).toBe('/Users/me/repo.wt/REN-1253-AC')
  })

  it('extracts the path from "checked out at" phrasing', () => {
    const msg = "fatal: 'feature/x' is already checked out at '/home/u/.worktrees/feature-x'"
    expect(parseConflictingWorktreePath(msg)).toBe('/home/u/.worktrees/feature-x')
  })

  it('handles paths with spaces', () => {
    const msg = "fatal: 'X' is already used by worktree at '/Users/My User/repo/wt/X'"
    expect(parseConflictingWorktreePath(msg)).toBe('/Users/My User/repo/wt/X')
  })

  it('returns null for non-matching messages', () => {
    expect(parseConflictingWorktreePath('fatal: not a git repository')).toBeNull()
    expect(parseConflictingWorktreePath('')).toBeNull()
  })

  it('returns null when the path is unquoted', () => {
    // Shouldn't happen in real git output, but guard against loose matches.
    const msg = "is already used by worktree at /no/quotes/here"
    expect(parseConflictingWorktreePath(msg)).toBeNull()
  })
})

describe('isMissingRemoteRefError', () => {
  it('matches the exact REN-1166 error for the named source branch', () => {
    // The message that bubbled "⚠️ Merge queue error" on a PR that had
    // already merged: the duplicate dequeue tried to fetch the just-deleted
    // source branch.
    const msg = "Command failed: git fetch origin main REN-1166\nfatal: couldn't find remote ref REN-1166\n"
    expect(isMissingRemoteRefError(msg, 'REN-1166')).toBe(true)
  })

  it('does not match when the missing ref is the target branch (real config error)', () => {
    // Catching a missing target would silently swallow a misconfiguration
    // worth surfacing — guard against that by anchoring on the source.
    const msg = "fatal: couldn't find remote ref main"
    expect(isMissingRemoteRefError(msg, 'feature/x')).toBe(false)
  })

  it('does not match when the missing ref differs from the expected source', () => {
    const msg = "fatal: couldn't find remote ref some-other-branch"
    expect(isMissingRemoteRefError(msg, 'feature/x')).toBe(false)
  })

  it('returns false for unrelated git errors', () => {
    expect(isMissingRemoteRefError('fatal: not a git repository', 'X')).toBe(false)
    expect(isMissingRemoteRefError('CONFLICT (content): Merge conflict', 'X')).toBe(false)
    expect(isMissingRemoteRefError('', 'X')).toBe(false)
  })

  it('handles slashed branch names', () => {
    const msg = "fatal: couldn't find remote ref feature/SUP-100"
    expect(isMissingRemoteRefError(msg, 'feature/SUP-100')).toBe(true)
  })
})
