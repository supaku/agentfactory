/**
 * Merge Worker Sidecar
 *
 * Starts the merge worker as a background loop alongside the fleet.
 * Only one merge worker runs per repo (enforced by Redis lock).
 *
 * The sidecar:
 * 1. Reads .agentfactory/config.yaml for merge queue settings
 * 2. Creates a dedicated worktree for merge operations
 * 3. Starts the MergeWorker poll loop
 * 4. Stops gracefully on AbortSignal
 *
 * If Redis is not configured or merge queue is not enabled, this is a no-op.
 */

import { execSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import {
  loadRepositoryConfig,
  MergeWorker,
  type MergeWorkerConfig,
  type MergeWorkerDeps,
} from '@renseiai/agentfactory'
import {
  MergeQueueStorage,
  isRedisConfigured,
  redisSetNX,
  redisDel,
  redisGet,
  redisSet,
  redisExpire,
} from '@renseiai/agentfactory-server'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MergeWorkerSidecarConfig {
  /** Git repository root (default: auto-detect from cwd) */
  gitRoot?: string
  /** Override repoId (default: derived from git remote) */
  repoId?: string
}

export interface MergeWorkerSidecarHandle {
  /** Stop the merge worker gracefully */
  stop(): void
  /** Promise that resolves when the worker exits */
  done: Promise<void>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getGitRoot(): string {
  return execSync('git rev-parse --show-toplevel', {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

function getRepoId(gitRoot: string): string {
  try {
    const remote = execSync('git remote get-url origin', {
      encoding: 'utf-8',
      cwd: gitRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    // Extract owner/repo from git URL
    const match = remote.match(/[:/]([^/]+\/[^/.]+?)(?:\.git)?$/)
    return match ? match[1] : 'default'
  } catch {
    return 'default'
  }
}

function ensureMergeWorktree(gitRoot: string): string {
  const worktreeBase = path.resolve(gitRoot, '..', path.basename(gitRoot) + '.wt')
  const worktreePath = path.join(worktreeBase, '__merge-worker__')

  if (fs.existsSync(worktreePath)) {
    // Verify it's a valid worktree
    try {
      execSync('git rev-parse --git-dir', { cwd: worktreePath, stdio: ['pipe', 'pipe', 'pipe'] })
      // Pull latest main
      execSync('git fetch origin main && git reset --hard origin/main', {
        cwd: worktreePath,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      return worktreePath
    } catch {
      // Invalid worktree — recreate
      try {
        execSync(`git worktree remove --force "${worktreePath}"`, { cwd: gitRoot, stdio: ['pipe', 'pipe', 'pipe'] })
      } catch { /* best effort */ }
    }
  }

  // Create the worktree directory parent
  fs.mkdirSync(worktreeBase, { recursive: true })

  // Create a detached worktree on main
  execSync(`git worktree add --detach "${worktreePath}" origin/main`, {
    cwd: gitRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  return worktreePath
}

// ---------------------------------------------------------------------------
// Sidecar
// ---------------------------------------------------------------------------

/**
 * Start the merge worker sidecar if merge queue is enabled.
 *
 * Returns a handle to stop the worker, or null if merge queue is not
 * configured or Redis is unavailable. Safe to call unconditionally —
 * it checks all preconditions before starting.
 */
export function startMergeWorkerSidecar(
  config: MergeWorkerSidecarConfig = {},
  signal?: AbortSignal,
): MergeWorkerSidecarHandle | null {
  // Check Redis
  if (!isRedisConfigured()) {
    return null
  }

  // Check repo config
  const gitRoot = config.gitRoot ?? getGitRoot()
  const repoConfig = loadRepositoryConfig(gitRoot)
  if (!repoConfig?.mergeQueue?.enabled) {
    return null
  }

  const provider = repoConfig.mergeQueue.provider ?? 'local'
  if (provider !== 'local') {
    // GitHub-native or other external providers handle merging themselves
    return null
  }

  const repoId = config.repoId ?? getRepoId(gitRoot)

  // Create dedicated worktree for merge operations
  let worktreePath: string
  try {
    worktreePath = ensureMergeWorktree(gitRoot)
  } catch (error) {
    console.warn(`[merge-worker] Failed to create merge worktree: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }

  // Build merge worker config from repo config
  const mqConfig = repoConfig.mergeQueue
  const workerConfig: MergeWorkerConfig = {
    repoId,
    repoPath: worktreePath,
    strategy: mqConfig.strategy ?? 'rebase',
    testCommand: mqConfig.testCommand ?? 'pnpm test',
    testTimeout: mqConfig.testTimeout ?? 300_000,
    lockFileRegenerate: mqConfig.lockFileRegenerate ?? true,
    mergiraf: mqConfig.mergiraf ?? true,
    pollInterval: mqConfig.pollInterval ?? 10_000,
    maxRetries: mqConfig.maxRetries ?? 2,
    escalation: {
      onConflict: mqConfig.escalation?.onConflict ?? 'reassign',
      onTestFailure: mqConfig.escalation?.onTestFailure ?? 'notify',
    },
    deleteBranchOnMerge: mqConfig.deleteBranchOnMerge ?? true,
    packageManager: (repoConfig.packageManager ?? 'pnpm') as 'pnpm' | 'npm' | 'yarn' | 'bun',
    remote: 'origin',
    targetBranch: 'main',
  }

  // Wire Redis deps for the merge worker
  const storage = new MergeQueueStorage()
  const deps: MergeWorkerDeps = {
    storage: {
      dequeue: (id) => storage.dequeue(id),
      markCompleted: (id, pr) => storage.markCompleted(id, pr),
      markFailed: (id, pr, reason) => storage.markFailed(id, pr, reason),
      markBlocked: (id, pr, reason) => storage.markBlocked(id, pr, reason),
    },
    redis: {
      setNX: async (key, value, ttl) => {
        const result = await redisSetNX(key, value, ttl)
        return result
      },
      del: (key) => redisDel(key).then(() => undefined),
      get: (key) => redisGet<string>(key),
      set: (key, value) => redisSet(key, value).then(() => undefined),
      expire: (key, seconds) => redisExpire(key, seconds).then(() => undefined),
    },
  }

  const worker = new MergeWorker(workerConfig, deps)

  console.log(`[merge-worker] Starting merge worker sidecar (repo: ${repoId}, worktree: ${worktreePath})`)

  const done = worker.start(signal).catch((error) => {
    // Lock acquisition failure is expected if another worker is already running
    if (error instanceof Error && error.message.includes('already running')) {
      console.log(`[merge-worker] Another merge worker is already running for ${repoId} — skipping`)
    } else {
      console.error(`[merge-worker] Merge worker error: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  return {
    stop: () => worker.stop(),
    done,
  }
}
