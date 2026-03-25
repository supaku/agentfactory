import { describe, it, expect } from 'vitest'
import { getWorktreeIdentifier, resolveWorktreePath } from './orchestrator.js'

describe('getWorktreeIdentifier', () => {
  it('returns identifier with DEV suffix for development', () => {
    expect(getWorktreeIdentifier('SUP-123', 'development')).toBe('SUP-123-DEV')
  })

  it('returns identifier with QA suffix for qa', () => {
    expect(getWorktreeIdentifier('SUP-123', 'qa')).toBe('SUP-123-QA')
  })

  it('returns identifier with AC suffix for acceptance', () => {
    expect(getWorktreeIdentifier('SUP-123', 'acceptance')).toBe('SUP-123-AC')
  })

  it('returns identifier with COORD suffix for coordination', () => {
    expect(getWorktreeIdentifier('SUP-123', 'coordination')).toBe('SUP-123-COORD')
  })

  it('returns identifier with RES suffix for research', () => {
    expect(getWorktreeIdentifier('SUP-123', 'research')).toBe('SUP-123-RES')
  })

  it('returns identifier with BC suffix for backlog-creation', () => {
    expect(getWorktreeIdentifier('SUP-123', 'backlog-creation')).toBe('SUP-123-BC')
  })

  it('returns identifier with INF suffix for inflight', () => {
    expect(getWorktreeIdentifier('SUP-123', 'inflight')).toBe('SUP-123-INF')
  })

  it('returns identifier with INF-COORD suffix for inflight-coordination', () => {
    expect(getWorktreeIdentifier('SUP-123', 'inflight-coordination')).toBe('SUP-123-INF-COORD')
  })

  it('returns identifier with REF suffix for refinement', () => {
    expect(getWorktreeIdentifier('SUP-123', 'refinement')).toBe('SUP-123-REF')
  })

  it('returns identifier with QA-COORD suffix for qa-coordination', () => {
    expect(getWorktreeIdentifier('SUP-123', 'qa-coordination')).toBe('SUP-123-QA-COORD')
  })

  it('returns identifier with AC-COORD suffix for acceptance-coordination', () => {
    expect(getWorktreeIdentifier('SUP-123', 'acceptance-coordination')).toBe('SUP-123-AC-COORD')
  })

  it('returns identifier with REF-COORD suffix for refinement-coordination', () => {
    expect(getWorktreeIdentifier('SUP-123', 'refinement-coordination')).toBe('SUP-123-REF-COORD')
  })

  it('works with different issue identifier formats', () => {
    expect(getWorktreeIdentifier('PROJ-1', 'development')).toBe('PROJ-1-DEV')
    expect(getWorktreeIdentifier('AB-99999', 'qa')).toBe('AB-99999-QA')
  })
})

describe('resolveWorktreePath', () => {
  it('resolves {repoName} template variable', () => {
    const result = resolveWorktreePath('../{repoName}.wt', '/home/user/my-project')
    expect(result).toBe('/home/user/my-project.wt')
  })

  it('resolves {branch} template variable', () => {
    const result = resolveWorktreePath('../{repoName}.wt/{branch}', '/home/user/my-project', 'SUP-123')
    expect(result).toBe('/home/user/my-project.wt/SUP-123')
  })

  it('resolves relative paths against gitRoot', () => {
    const result = resolveWorktreePath('.worktrees', '/home/user/my-project')
    expect(result).toBe('/home/user/my-project/.worktrees')
  })

  it('handles absolute paths unchanged', () => {
    const result = resolveWorktreePath('/custom/path', '/home/user/my-project')
    expect(result).toBe('/custom/path')
  })

  it('resolves multiple {repoName} occurrences', () => {
    const result = resolveWorktreePath('../{repoName}-worktrees/{repoName}', '/home/user/platform')
    expect(result).toBe('/home/user/platform-worktrees/platform')
  })

  it('handles repo names with special characters', () => {
    const result = resolveWorktreePath('../{repoName}.wt', '/home/user/my-cool.project')
    expect(result).toBe('/home/user/my-cool.project.wt')
  })

  it('does not replace {branch} when branch is not provided', () => {
    const result = resolveWorktreePath('../{repoName}.wt/{branch}', '/home/user/repo')
    expect(result).toBe('/home/user/repo.wt/{branch}')
  })
})
