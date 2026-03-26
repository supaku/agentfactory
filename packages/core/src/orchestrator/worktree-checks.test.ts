import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execSync } from 'child_process'
import { checkForIncompleteWork, checkForPushedWorkWithoutPR } from './orchestrator.js'

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    execSync: vi.fn(),
  }
})

const mockExecSync = vi.mocked(execSync)

beforeEach(() => {
  vi.resetAllMocks()
})

describe('checkForIncompleteWork', () => {
  it('detects uncommitted changes', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'git status --porcelain') return 'M src/index.ts\n?? new-file.ts'
      return ''
    })

    const result = checkForIncompleteWork('/fake/worktree')
    expect(result.hasIncompleteWork).toBe(true)
    expect(result.reason).toBe('uncommitted_changes')
    expect(result.details).toContain('2 file(s)')
  })

  it('detects unpushed commits when upstream exists', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'git status --porcelain') return ''
      if (cmd === 'git rev-parse --abbrev-ref @{u}') return 'origin/SUP-123'
      if (cmd.startsWith('git rev-list --count')) return '3'
      return ''
    })

    const result = checkForIncompleteWork('/fake/worktree')
    expect(result.hasIncompleteWork).toBe(true)
    expect(result.reason).toBe('unpushed_commits')
    expect(result.details).toContain('3 commit(s)')
  })

  it('detects branch never pushed to remote (git ls-remote returns empty)', () => {
    // This is the critical bug fix test:
    // git ls-remote exits 0 with empty output when branch doesn't exist on remote.
    // The old code relied on try/catch and would miss this case.
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'git status --porcelain') return ''
      if (cmd === 'git rev-parse --abbrev-ref @{u}') throw new Error('no upstream')
      if (cmd === 'git log --oneline -1') return 'abc1234 feat: add feature'
      if (cmd === 'git branch --show-current') return 'SUP-1592'
      if (cmd.startsWith('git ls-remote --heads origin')) return '' // empty = branch not on remote
      return ''
    })

    const result = checkForIncompleteWork('/fake/worktree')
    expect(result.hasIncompleteWork).toBe(true)
    expect(result.reason).toBe('unpushed_commits')
    expect(result.details).toContain("Branch 'SUP-1592' has not been pushed to remote")
  })

  it('reports clean when branch exists on remote', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'git status --porcelain') return ''
      if (cmd === 'git rev-parse --abbrev-ref @{u}') throw new Error('no upstream')
      if (cmd === 'git log --oneline -1') return 'abc1234 feat: add feature'
      if (cmd === 'git branch --show-current') return 'SUP-123'
      if (cmd.startsWith('git ls-remote --heads origin')) return 'abc1234def5678\trefs/heads/SUP-123'
      return ''
    })

    const result = checkForIncompleteWork('/fake/worktree')
    expect(result.hasIncompleteWork).toBe(false)
  })

  it('reports clean when no changes and all pushed', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'git status --porcelain') return ''
      if (cmd === 'git rev-parse --abbrev-ref @{u}') return 'origin/SUP-123'
      if (cmd.startsWith('git rev-list --count')) return '0'
      return ''
    })

    const result = checkForIncompleteWork('/fake/worktree')
    expect(result.hasIncompleteWork).toBe(false)
  })

  it('errs on the side of caution when git status fails', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('git not found')
    })

    const result = checkForIncompleteWork('/fake/worktree')
    expect(result.hasIncompleteWork).toBe(true)
    expect(result.details).toContain('Failed to check git status')
  })
})

describe('checkForPushedWorkWithoutPR', () => {
  it('returns false when on main branch', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'git branch --show-current') return 'main'
      return ''
    })

    const result = checkForPushedWorkWithoutPR('/fake/worktree')
    expect(result.hasPushedWork).toBe(false)
  })

  it('returns false when no commits ahead of main', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'git branch --show-current') return 'SUP-123'
      if (cmd.startsWith('git rev-list --count')) return '0'
      return ''
    })

    const result = checkForPushedWorkWithoutPR('/fake/worktree')
    expect(result.hasPushedWork).toBe(false)
  })

  it('detects pushed commits without PR', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'git branch --show-current') return 'SUP-123'
      if (cmd.startsWith('git rev-list --count')) return '5'
      if (cmd.startsWith('git ls-remote --heads origin')) return 'abc1234\trefs/heads/SUP-123'
      return ''
    })

    const result = checkForPushedWorkWithoutPR('/fake/worktree')
    expect(result.hasPushedWork).toBe(true)
    expect(result.branch).toBe('SUP-123')
    expect(result.details).toContain('5 commit(s) ahead of main')
  })

  it('returns false when branch has commits but not pushed', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'git branch --show-current') return 'SUP-123'
      if (cmd.startsWith('git rev-list --count')) return '3'
      if (cmd.startsWith('git ls-remote --heads origin')) return '' // not on remote
      return ''
    })

    const result = checkForPushedWorkWithoutPR('/fake/worktree')
    expect(result.hasPushedWork).toBe(false)
  })

  it('returns false when git commands fail', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('git not found')
    })

    const result = checkForPushedWorkWithoutPR('/fake/worktree')
    expect(result.hasPushedWork).toBe(false)
  })
})
