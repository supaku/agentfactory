import { describe, it, expect, vi, beforeEach } from 'vitest'
import { collectSessionOutputs, runBackstop, formatBackstopComment, type SessionContext } from './session-backstop.js'
import type { AgentProcess } from './types.js'

// Mock execSync to avoid actual git/gh commands
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}))

import { execSync } from 'node:child_process'

const mockExecSync = vi.mocked(execSync)

function createMockAgent(overrides?: Partial<AgentProcess>): AgentProcess {
  return {
    issueId: 'issue-123',
    identifier: 'SUP-123',
    status: 'completed',
    startedAt: new Date(),
    completedAt: new Date(),
    pid: 1234,
    lastActivityAt: new Date(),
    ...overrides,
  }
}

function createSessionContext(overrides?: Partial<SessionContext>): SessionContext {
  return {
    agent: createMockAgent(),
    commentPosted: false,
    issueUpdated: false,
    subIssuesCreated: false,
    ...overrides,
  }
}

beforeEach(() => {
  mockExecSync.mockReset()
})

describe('collectSessionOutputs', () => {
  it('collects basic outputs from agent process', () => {
    const ctx = createSessionContext({
      agent: createMockAgent({
        pullRequestUrl: 'https://github.com/org/repo/pull/42',
        workResult: 'passed',
      }),
      commentPosted: true,
      issueUpdated: true,
    })

    const outputs = collectSessionOutputs(ctx)
    expect(outputs.prUrl).toBe('https://github.com/org/repo/pull/42')
    expect(outputs.workResult).toBe('passed')
    expect(outputs.commentPosted).toBe(true)
    expect(outputs.issueUpdated).toBe(true)
  })

  it('inspects git state for worktree-based agents', () => {
    // Mock git commands for commit and branch checks
    mockExecSync
      .mockReturnValueOnce('feat/sup-123\n' as any)  // git branch --show-current
      .mockReturnValueOnce('3\n' as any)              // git rev-list --count main..HEAD
      .mockReturnValueOnce('feat/sup-123\n' as any)  // git branch --show-current (isBranchPushed)
      .mockReturnValueOnce('abc123 refs/heads/feat/sup-123\n' as any) // git ls-remote
      .mockReturnValueOnce('origin/feat/sup-123\n' as any) // git rev-parse @{u}
      .mockReturnValueOnce('0\n' as any)              // git rev-list --count @{u}..HEAD

    const ctx = createSessionContext({
      agent: createMockAgent({ worktreePath: '/tmp/worktree' }),
    })

    const outputs = collectSessionOutputs(ctx)
    expect(outputs.commitsPresent).toBe(true)
    expect(outputs.branchPushed).toBe(true)
  })

  it('defaults to unknown work result when not set', () => {
    const ctx = createSessionContext()
    const outputs = collectSessionOutputs(ctx)
    expect(outputs.workResult).toBe('unknown')
  })
})

describe('runBackstop', () => {
  it('returns no-op for work types without contracts', () => {
    // Use a work type cast that has no contract
    const ctx = createSessionContext({
      agent: createMockAgent({ workType: 'unknown-type' as any }),
    })
    const result = runBackstop(ctx)
    expect(result.contract).toBeNull()
    expect(result.backstop.fullyRecovered).toBe(true)
    expect(result.backstop.actions).toHaveLength(0)
  })

  it('returns satisfied for development with all outputs present', () => {
    // Mock git: commits ahead of main, branch pushed
    mockExecSync
      .mockReturnValueOnce('feat/sup-123\n' as any)  // branch
      .mockReturnValueOnce('2\n' as any)              // rev-list count
      .mockReturnValueOnce('feat/sup-123\n' as any)  // branch (isBranchPushed)
      .mockReturnValueOnce('abc refs/heads/feat/sup-123\n' as any) // ls-remote
      .mockReturnValueOnce('origin/feat/sup-123\n' as any) // @{u}
      .mockReturnValueOnce('0\n' as any)              // unpushed count

    const ctx = createSessionContext({
      agent: createMockAgent({
        workType: 'development',
        worktreePath: '/tmp/worktree',
        pullRequestUrl: 'https://github.com/org/repo/pull/42',
      }),
    })
    const result = runBackstop(ctx)
    expect(result.validation!.satisfied).toBe(true)
    expect(result.backstop.actions).toHaveLength(0)
  })

  it('auto-pushes branch when commits exist but branch not pushed', () => {
    // collectSessionOutputs calls:
    //   hasCommitsAheadOfMain: git branch, git rev-list
    //   isBranchPushed: git branch, git ls-remote (empty = not pushed)
    // backstopPushBranch calls:
    //   git branch, git push
    // backstopCreatePR calls:
    //   git branch, gh pr list, gh pr create
    // (re-validation uses mutated outputs object, no git calls)
    mockExecSync
      // --- collectSessionOutputs ---
      .mockReturnValueOnce('feat/sup-123\n' as any)  // hasCommits: git branch
      .mockReturnValueOnce('2\n' as any)              // hasCommits: git rev-list
      .mockReturnValueOnce('feat/sup-123\n' as any)  // isBranchPushed: git branch
      .mockReturnValueOnce('' as any)                  // isBranchPushed: ls-remote (empty = not pushed)
      // --- backstopPushBranch ---
      .mockReturnValueOnce('feat/sup-123\n' as any)  // git branch
      .mockReturnValueOnce('' as any)                  // git push -u origin
      // --- backstopCreatePR ---
      .mockReturnValueOnce('feat/sup-123\n' as any)  // git branch
      .mockReturnValueOnce('[]' as any)                // gh pr list (empty)
      .mockReturnValueOnce('https://github.com/org/repo/pull/99\n' as any) // gh pr create

    const ctx = createSessionContext({
      agent: createMockAgent({
        workType: 'development',
        worktreePath: '/tmp/worktree',
        // No PR URL — agent didn't create one
      }),
    })
    const result = runBackstop(ctx)
    const pushAction = result.backstop.actions.find(a => a.field === 'branch_pushed')
    expect(pushAction).toBeDefined()
    expect(pushAction!.success).toBe(true)
    expect(pushAction!.action).toContain('auto-pushed')
  })

  it('skips backstop actions in dry-run mode', () => {
    // Mock git: commits present, branch not pushed
    mockExecSync
      .mockReturnValueOnce('feat/sup-123\n' as any)  // branch
      .mockReturnValueOnce('2\n' as any)              // count
      .mockReturnValueOnce('feat/sup-123\n' as any)  // branch (isBranchPushed)
      .mockReturnValueOnce('\n' as any)                // ls-remote empty

    const ctx = createSessionContext({
      agent: createMockAgent({
        workType: 'development',
        worktreePath: '/tmp/worktree',
        pullRequestUrl: 'https://github.com/org/repo/pull/42',
      }),
    })
    const result = runBackstop(ctx, { dryRun: true })
    const pushAction = result.backstop.actions.find(a => a.field === 'branch_pushed')
    expect(pushAction).toBeDefined()
    expect(pushAction!.success).toBe(false)
    expect(pushAction!.detail).toBe('dry-run')
  })

  it('reports satisfied for QA with pass result and comment', () => {
    const ctx = createSessionContext({
      agent: createMockAgent({ workType: 'qa', workResult: 'passed' }),
      commentPosted: true,
    })
    const result = runBackstop(ctx)
    expect(result.validation!.satisfied).toBe(true)
  })

  it('reports unsatisfied for QA with unknown work result', () => {
    const ctx = createSessionContext({
      agent: createMockAgent({ workType: 'qa' }),
      commentPosted: true,
    })
    const result = runBackstop(ctx)
    expect(result.validation!.satisfied).toBe(false)
    expect(result.backstop.remainingGaps).toContain('work_result')
  })

  it('reports satisfied for refinement with comment posted', () => {
    const ctx = createSessionContext({
      agent: createMockAgent({ workType: 'refinement' }),
      commentPosted: true,
    })
    const result = runBackstop(ctx)
    expect(result.validation!.satisfied).toBe(true)
  })

  it('reports unsatisfied for refinement without comment', () => {
    const ctx = createSessionContext({
      agent: createMockAgent({ workType: 'refinement' }),
      commentPosted: false,
    })
    const result = runBackstop(ctx)
    expect(result.validation!.satisfied).toBe(false)
    expect(result.backstop.remainingGaps).toContain('comment_posted')
  })

  it('auto-commits uncommitted changes for development work type', () => {
    // Clear git identity env vars so the mock sequence for getGitConfig is consumed
    const origName = process.env.GIT_AUTHOR_NAME
    const origEmail = process.env.GIT_AUTHOR_EMAIL
    delete process.env.GIT_AUTHOR_NAME
    delete process.env.GIT_AUTHOR_EMAIL

    // collectSessionOutputs: no commits ahead of main, branch not pushed
    mockExecSync
      // --- collectSessionOutputs ---
      .mockReturnValueOnce('SUP-123\n' as any)     // hasCommits: git branch
      .mockReturnValueOnce('0\n' as any)             // hasCommits: rev-list (no commits)
      .mockReturnValueOnce('SUP-123\n' as any)     // isBranchPushed: git branch
      .mockReturnValueOnce('' as any)                 // isBranchPushed: ls-remote (not pushed)
      // --- backstopCommitChanges ---
      .mockReturnValueOnce(' M src/foo.ts\n?? src/bar.ts\n' as any) // git status --porcelain
      .mockReturnValueOnce('Test User\n' as any)     // git config user.name
      .mockReturnValueOnce('test@example.com\n' as any) // git config user.email
      .mockReturnValueOnce('' as any)                 // git add -A
      // git reset HEAD -- <pattern> calls (all throw = no matches, that's fine)
      .mockImplementation((cmd: any, ...rest: any[]) => {
        const cmdStr = typeof cmd === 'string' ? cmd : ''
        if (cmdStr.startsWith('git reset HEAD -- ')) throw new Error('no match')
        if (cmdStr === 'git diff --cached --name-only') return 'src/foo.ts\nsrc/bar.ts\n'
        if (cmdStr.startsWith('git commit')) return ''
        // backstopPushBranch
        if (cmdStr === 'git branch --show-current') return 'SUP-123\n'
        if (cmdStr.startsWith('git push')) return ''
        // backstopCreatePR
        if (cmdStr.startsWith('gh pr list')) return '[]'
        if (cmdStr.startsWith('gh pr create')) return 'https://github.com/org/repo/pull/99\n'
        return ''
      })

    const ctx = createSessionContext({
      agent: createMockAgent({
        workType: 'development',
        worktreePath: '/tmp/worktree',
      }),
    })
    const result = runBackstop(ctx)

    const commitAction = result.backstop.actions.find(a => a.field === 'commits_present')
    expect(commitAction).toBeDefined()
    expect(commitAction!.success).toBe(true)
    expect(commitAction!.action).toContain('auto-committed 2 file(s)')

    const pushAction = result.backstop.actions.find(a => a.field === 'branch_pushed')
    expect(pushAction).toBeDefined()
    expect(pushAction!.success).toBe(true)

    const prAction = result.backstop.actions.find(a => a.field === 'pr_url')
    expect(prAction).toBeDefined()
    expect(prAction!.success).toBe(true)

    // Restore env vars
    if (origName !== undefined) process.env.GIT_AUTHOR_NAME = origName
    if (origEmail !== undefined) process.env.GIT_AUTHOR_EMAIL = origEmail
  })

  it('aborts auto-commit when staged file count exceeds safety cap', () => {
    // Generate 300 fake file names to exceed the 200 cap
    const manyFiles = Array.from({ length: 300 }, (_, i) => `gocache/file-${i}.o`).join('\n')

    mockExecSync
      // --- collectSessionOutputs ---
      .mockReturnValueOnce('SUP-123\n' as any)     // hasCommits: git branch
      .mockReturnValueOnce('0\n' as any)             // hasCommits: rev-list
      .mockReturnValueOnce('SUP-123\n' as any)     // isBranchPushed: git branch
      .mockReturnValueOnce('' as any)                 // isBranchPushed: ls-remote
      // --- backstopCommitChanges ---
      .mockReturnValueOnce(' M src/foo.ts\n' as any) // git status --porcelain (has changes)
      .mockReturnValueOnce('' as any)                 // git add -A
      // git reset HEAD -- <pattern> calls all throw (no matches)
      .mockImplementation((cmd: any) => {
        const cmdStr = typeof cmd === 'string' ? cmd : ''
        if (cmdStr.startsWith('git reset HEAD -- ')) throw new Error('no match')
        if (cmdStr === 'git diff --cached --name-only') return manyFiles
        // Final git reset HEAD to clean staging
        if (cmdStr === 'git reset HEAD') return ''
        return ''
      })

    const ctx = createSessionContext({
      agent: createMockAgent({
        workType: 'development',
        worktreePath: '/tmp/worktree',
      }),
    })
    const result = runBackstop(ctx)

    const commitAction = result.backstop.actions.find(a => a.field === 'commits_present')
    expect(commitAction).toBeDefined()
    expect(commitAction!.success).toBe(false)
    expect(commitAction!.action).toContain('safety cap')
    expect(commitAction!.detail).toContain('gocache/file-0.o')
  })

  it('does not auto-commit for non-code-producing work types', () => {
    // QA work type has no commits_present requirement — backstop should not commit
    const ctx = createSessionContext({
      agent: createMockAgent({ workType: 'qa', worktreePath: '/tmp/worktree' }),
      commentPosted: true,
    })
    const result = runBackstop(ctx)
    const commitAction = result.backstop.actions.find(a => a.field === 'commits_present')
    expect(commitAction).toBeUndefined()
  })

  it('skips auto-commit in dry-run mode', () => {
    mockExecSync
      .mockReturnValueOnce('SUP-123\n' as any)     // hasCommits: git branch
      .mockReturnValueOnce('0\n' as any)             // hasCommits: rev-list
      .mockReturnValueOnce('SUP-123\n' as any)     // isBranchPushed: git branch
      .mockReturnValueOnce('' as any)                 // isBranchPushed: ls-remote

    const ctx = createSessionContext({
      agent: createMockAgent({
        workType: 'development',
        worktreePath: '/tmp/worktree',
      }),
    })
    const result = runBackstop(ctx, { dryRun: true })
    const commitAction = result.backstop.actions.find(a => a.field === 'commits_present')
    expect(commitAction).toBeDefined()
    expect(commitAction!.success).toBe(false)
    expect(commitAction!.detail).toBe('dry-run')
  })

  it('reports satisfied for backlog-creation with sub-issues', () => {
    const ctx = createSessionContext({
      agent: createMockAgent({ workType: 'backlog-creation' }),
      subIssuesCreated: true,
    })
    const result = runBackstop(ctx)
    expect(result.validation!.satisfied).toBe(true)
  })

  it('uses repository config git identity when env vars are not set', () => {
    const origName = process.env.GIT_AUTHOR_NAME
    const origEmail = process.env.GIT_AUTHOR_EMAIL
    delete process.env.GIT_AUTHOR_NAME
    delete process.env.GIT_AUTHOR_EMAIL

    mockExecSync
      // --- collectSessionOutputs ---
      .mockReturnValueOnce('SUP-123\n' as any)     // hasCommits: git branch
      .mockReturnValueOnce('0\n' as any)             // hasCommits: rev-list (no commits)
      .mockReturnValueOnce('SUP-123\n' as any)     // isBranchPushed: git branch
      .mockReturnValueOnce('' as any)                 // isBranchPushed: ls-remote (not pushed)
      // --- backstopCommitChanges ---
      .mockReturnValueOnce(' M src/foo.ts\n' as any) // git status --porcelain
      .mockReturnValueOnce('' as any)                 // git add -A
      // git reset HEAD -- <pattern> calls + diff + commit + push + PR
      .mockImplementation((cmd: any, ...rest: any[]) => {
        const cmdStr = typeof cmd === 'string' ? cmd : ''
        if (cmdStr.startsWith('git reset HEAD -- ')) throw new Error('no match')
        if (cmdStr === 'git diff --cached --name-only') return 'src/foo.ts\n'
        if (cmdStr.startsWith('git commit')) return ''
        if (cmdStr === 'git branch --show-current') return 'SUP-123\n'
        if (cmdStr.startsWith('git push')) return ''
        if (cmdStr.startsWith('gh pr list')) return '[]'
        if (cmdStr.startsWith('gh pr create')) return 'https://github.com/org/repo/pull/99\n'
        return ''
      })

    const ctx = createSessionContext({
      agent: createMockAgent({
        workType: 'development',
        worktreePath: '/tmp/worktree',
      }),
    })
    const result = runBackstop(ctx, {
      repoConfig: {
        apiVersion: 'v1',
        kind: 'RepositoryConfig' as const,
        git: {
          authorName: 'Rensei Agent',
          authorEmail: 'agent@custom.com',
        },
      },
    })

    const commitAction = result.backstop.actions.find(a => a.field === 'commits_present')
    expect(commitAction).toBeDefined()
    expect(commitAction!.success).toBe(true)

    // Verify git commit was called with the right env vars
    const commitCall = mockExecSync.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('git commit')
    )
    expect(commitCall).toBeDefined()
    const commitEnv = (commitCall![1] as any)?.env
    expect(commitEnv.GIT_AUTHOR_NAME).toBe('Rensei Agent')
    expect(commitEnv.GIT_AUTHOR_EMAIL).toBe('agent@custom.com')

    // Restore
    if (origName !== undefined) process.env.GIT_AUTHOR_NAME = origName
    if (origEmail !== undefined) process.env.GIT_AUTHOR_EMAIL = origEmail
  })
})

describe('formatBackstopComment', () => {
  it('returns null when contract satisfied with no actions', () => {
    const ctx = createSessionContext({
      agent: createMockAgent({ workType: 'qa', workResult: 'passed' }),
      commentPosted: true,
    })
    const result = runBackstop(ctx)
    const comment = formatBackstopComment(result)
    expect(comment).toBeNull()
  })

  it('returns recovery summary when backstop took actions', () => {
    // Mock: commits present, branch not pushed, push succeeds
    mockExecSync
      .mockReturnValueOnce('feat/sup-123\n' as any)
      .mockReturnValueOnce('2\n' as any)
      .mockReturnValueOnce('feat/sup-123\n' as any)
      .mockReturnValueOnce('\n' as any)                // not pushed
      .mockReturnValueOnce('feat/sup-123\n' as any)  // backstop push branch
      .mockReturnValueOnce('' as any)                  // push succeeds
      // Now PR creation attempt
      .mockReturnValueOnce('feat/sup-123\n' as any)  // branch for PR
      .mockReturnValueOnce('[]\n' as any)              // no existing PR
      .mockReturnValueOnce('https://github.com/org/repo/pull/99\n' as any) // gh pr create

    const ctx = createSessionContext({
      agent: createMockAgent({
        workType: 'development',
        worktreePath: '/tmp/worktree',
      }),
    })
    const result = runBackstop(ctx)
    const comment = formatBackstopComment(result)
    expect(comment).toBeDefined()
    expect(comment).toContain('backstop')
  })

  it('includes remaining gaps when not fully recovered', () => {
    const ctx = createSessionContext({
      agent: createMockAgent({ workType: 'qa' }),
      commentPosted: false,
    })
    const result = runBackstop(ctx)
    const comment = formatBackstopComment(result)
    expect(comment).toBeDefined()
    expect(comment).toContain('Still missing')
    expect(comment).toContain('NOT updated automatically')
  })
})
