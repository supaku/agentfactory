/**
 * Real-git integration test for the worktree branch-conflict fix.
 *
 * Simulates the REN-1253 / REN-1254 failure mode:
 *   1. A "remote" bare repo holds `main` and a PR branch.
 *   2. The acceptance agent's worktree (`clone.wt/<ISSUE>-AC`) clones and
 *      checks out the PR branch — exclusive lock on it.
 *   3. The merge worker's dedicated worktree (`clone.wt/__merge-worker__`)
 *      tries to prepare() the same PR for merging.
 *
 * Before the fix: prepare() ran `git checkout <branch>` and hit
 *   fatal: '<branch>' is already used by worktree at ...
 *
 * After the fix: prepare() runs `git checkout --detach origin/<branch>`,
 * which bypasses the per-branch worktree lock and succeeds.
 *
 * The test is skipped when `git` isn't on PATH so CI without git doesn't
 * fail (vitest will still run the mock-based tests in strategies.test.ts).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { RebaseStrategy } from './rebase-strategy.js'
import { SquashStrategy } from './squash-strategy.js'
import { MergeCommitStrategy } from './merge-commit-strategy.js'
import type { MergeContext } from './types.js'

let gitAvailable = true
try {
  execSync('git --version', { stdio: 'pipe' })
} catch {
  gitAvailable = false
}

const describeOrSkip = gitAvailable ? describe : describe.skip

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test',
    },
  }).toString()
}

/**
 * Create a fixture that mirrors the production layout:
 *   - bare remote repo with `main` and `feature/x` committed
 *   - one local clone with two worktrees:
 *       * acceptance worktree holding `feature/x` (the lock holder)
 *       * merge-worker worktree (detached on origin/main)
 *
 * Critically: both worktrees share the same .git dir, matching the production
 * layout where `git worktree add` is used. Git's per-branch exclusivity lock
 * only applies *within a single repository*, so a fixture of separate clones
 * wouldn't reproduce the REN-1253 failure mode.
 */
function setupFixture() {
  const root = mkdtempSync(join(tmpdir(), 'merge-queue-int-'))

  // Bare remote
  const remotePath = join(root, 'remote.git')
  execSync(`git init --bare -b main "${remotePath}"`, { stdio: 'pipe' })

  // Seed repo — commits to main and a feature branch
  const seedPath = join(root, 'seed')
  execSync(`git init -b main "${seedPath}"`, { stdio: 'pipe' })
  writeFileSync(join(seedPath, 'README.md'), '# seed\n')
  sh('git add . && git commit -m "init"', seedPath)
  sh(`git remote add origin "${remotePath}"`, seedPath)
  sh('git push -u origin main', seedPath)

  sh('git checkout -b feature/x', seedPath)
  writeFileSync(join(seedPath, 'feature.txt'), 'feature content\n')
  sh('git add . && git commit -m "feature commit"', seedPath)
  sh('git push -u origin feature/x', seedPath)
  sh('git checkout main', seedPath)

  // The "main clone" is the repo that hosts all worktrees.
  const clonePath = join(root, 'clone')
  execSync(`git clone "${remotePath}" "${clonePath}"`, { stdio: 'pipe' })

  // Acceptance worktree — holds `feature/x` (the lock holder, matching how
  // the orchestrator creates acceptance worktrees with a tracked branch).
  const acceptancePath = join(root, 'acceptance')
  sh(`git worktree add -b feature/x-ac "${acceptancePath}" origin/feature/x`, clonePath)
  // Fetch the remote ref onto the local branch name `feature/x`, then attach
  // the worktree to it — this is what the orchestrator does (branch name
  // without the `-AC` suffix; the suffix goes on the directory).
  sh('git fetch origin feature/x:feature/x', clonePath)
  sh('git worktree remove --force "' + acceptancePath + '"', clonePath)
  sh(`git worktree add "${acceptancePath}" feature/x`, clonePath)

  // Merge-worker worktree — detached on origin/main (matches
  // merge-worker-sidecar.ts:ensureMergeWorktree behavior)
  const workerPath = join(root, 'worker')
  sh(`git worktree add --detach "${workerPath}" origin/main`, clonePath)

  return {
    root,
    remotePath,
    clonePath,
    workerPath,
    acceptancePath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

describeOrSkip('merge-queue strategies — real git worktree conflict', () => {
  let fixture: ReturnType<typeof setupFixture>

  beforeAll(() => {
    if (!gitAvailable) return
  })

  beforeEach(() => {
    fixture = setupFixture()
  })

  afterEach(() => {
    fixture.cleanup()
  })

  it('baseline: plain `git checkout <branch>` does hit the "already used by worktree" error', () => {
    // This test proves the failure mode exists in the fixture. If this stops
    // reproducing the error, the subsequent tests lose their meaning — so we
    // guard the invariant explicitly.
    let caught: Error | null = null
    try {
      sh('git checkout feature/x', fixture.workerPath)
    } catch (err) {
      caught = err as Error
    }
    expect(caught).not.toBeNull()
    expect(caught!.message).toMatch(/is already (used by worktree|checked out) at/)
  })

  it('RebaseStrategy.prepare succeeds despite the branch being locked by the acceptance worktree', async () => {
    const strategy = new RebaseStrategy()
    const ctx: MergeContext = {
      repoPath: fixture.workerPath,
      worktreePath: fixture.workerPath,
      sourceBranch: 'feature/x',
      targetBranch: 'main',
      prNumber: 1,
      remote: 'origin',
    }

    const result = await strategy.prepare(ctx)

    expect(result.success).toBe(true)
    expect(result.headSha).toMatch(/^[0-9a-f]{40}$/)
  })

  it('SquashStrategy.prepare succeeds despite the branch being locked', async () => {
    const strategy = new SquashStrategy()
    const ctx: MergeContext = {
      repoPath: fixture.workerPath,
      worktreePath: fixture.workerPath,
      sourceBranch: 'feature/x',
      targetBranch: 'main',
      prNumber: 1,
      remote: 'origin',
    }

    const result = await strategy.prepare(ctx)

    expect(result.success).toBe(true)
    expect(result.headSha).toMatch(/^[0-9a-f]{40}$/)
  })

  it('MergeCommitStrategy.prepare succeeds despite the branch being locked', async () => {
    const strategy = new MergeCommitStrategy()
    const ctx: MergeContext = {
      repoPath: fixture.workerPath,
      worktreePath: fixture.workerPath,
      sourceBranch: 'feature/x',
      targetBranch: 'main',
      prNumber: 1,
      remote: 'origin',
    }

    const result = await strategy.prepare(ctx)

    expect(result.success).toBe(true)
    expect(result.headSha).toMatch(/^[0-9a-f]{40}$/)
  })

  it('RebaseStrategy full rebase+finalize updates remote main to the rebased SHA', async () => {
    const strategy = new RebaseStrategy()
    const ctx: MergeContext = {
      repoPath: fixture.workerPath,
      worktreePath: fixture.workerPath,
      sourceBranch: 'feature/x',
      targetBranch: 'main',
      prNumber: 1,
      remote: 'origin',
    }

    const prepare = await strategy.prepare(ctx)
    expect(prepare.success).toBe(true)

    const execute = await strategy.execute(ctx)
    expect(execute.status).toBe('success')

    await strategy.finalize(ctx)

    // Remote main now points at the rebased SHA
    const remoteMain = execSync(
      `git ls-remote "${fixture.remotePath}" refs/heads/main`,
      { encoding: 'utf-8' },
    ).split(/\s+/)[0]
    expect(remoteMain).toBe(execute.mergedSha)

    // Remote feature branch also updated to the same SHA
    const remoteFeature = execSync(
      `git ls-remote "${fixture.remotePath}" refs/heads/feature/x`,
      { encoding: 'utf-8' },
    ).split(/\s+/)[0]
    expect(remoteFeature).toBe(execute.mergedSha)
  })
})
