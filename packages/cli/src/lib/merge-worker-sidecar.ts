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

import { execSync, execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import fs from 'fs'
import {
  loadRepositoryConfig,
  MergeWorker,
  LocalMergeQueueAdapter,
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

const execFileAsync = promisify(execFile)

/** Label used to opt a PR into the local merge queue (REN-503 handoff signal). */
export const APPROVED_FOR_MERGE_LABEL = 'approved-for-merge'

/** `gh pr list` limit — plenty of headroom; real queues rarely exceed 10. */
const LABEL_POLL_MAX_PRS = 50

/** Timeout for the `gh pr list` call — stays within one poll interval. */
const LABEL_POLL_TIMEOUT_MS = 15_000

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

/**
 * Split a `owner/repo` repoId into components. Returns null for unparseable
 * values (e.g., the "default" fallback) so callers can skip label polling
 * without crashing.
 */
export function splitRepoId(repoId: string): { owner: string; repo: string } | null {
  const parts = repoId.split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  return { owner: parts[0], repo: parts[1] }
}

/** Shape `gh pr list --json number` returns (we only use `number`). */
interface LabeledPR {
  number: number
}

/** Minimal adapter surface the label poller needs. Exported for testing. */
export interface LabelPollerAdapter {
  canEnqueue(owner: string, repo: string, prNumber: number): Promise<boolean>
  enqueue(owner: string, repo: string, prNumber: number): Promise<unknown>
}

/**
 * Poll GitHub for PRs carrying the `approved-for-merge` label and hand any
 * that aren't already queued to the merge queue adapter. This is the
 * secondary REN-503 handoff path — complements the orchestrator's
 * synchronous enqueue on acceptance pass, covers human-initiated queueing
 * (someone labels a PR by hand), and recovers from any missed acceptance
 * event (agent crashed between pass and enqueue).
 *
 * Exported for testing. `gh` is invoked via execFile (no shell), with a
 * dedicated timeout so a stalled call doesn't wedge the sidecar.
 *
 * Returns the number of PRs that were newly enqueued this pass (already-
 * queued PRs are idempotently no-op and not counted).
 */
export async function pollApprovedForMergeLabel(
  adapter: LabelPollerAdapter,
  owner: string,
  repo: string,
  options: {
    /** Injectable for testing — defaults to `gh pr list` via execFile. */
    listLabeledPRs?: (owner: string, repo: string) => Promise<LabeledPR[]>
    log?: (msg: string) => void
  } = {},
): Promise<number> {
  const log = options.log ?? ((m: string) => console.log(`[merge-worker] ${m}`))
  const list = options.listLabeledPRs ?? defaultListLabeledPRs

  let prs: LabeledPR[]
  try {
    prs = await list(owner, repo)
  } catch (error) {
    log(`label poll failed: ${error instanceof Error ? error.message : String(error)}`)
    return 0
  }

  if (prs.length === 0) return 0

  let enqueued = 0
  for (const pr of prs) {
    try {
      const canEnqueue = await adapter.canEnqueue(owner, repo, pr.number)
      if (!canEnqueue) continue
      // adapter.enqueue is idempotent: if already queued it returns the
      // current status without double-inserting, so we don't need to
      // pre-check `isEnqueued` — simpler and avoids a race between check
      // and insert.
      await adapter.enqueue(owner, repo, pr.number)
      enqueued++
      log(`enqueued labeled PR #${pr.number} (${owner}/${repo})`)
    } catch (error) {
      log(`failed to enqueue labeled PR #${pr.number}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return enqueued
}

async function defaultListLabeledPRs(owner: string, repo: string): Promise<LabeledPR[]> {
  const { stdout } = await execFileAsync(
    'gh',
    [
      'pr', 'list',
      '--state', 'open',
      '--label', APPROVED_FOR_MERGE_LABEL,
      '--repo', `${owner}/${repo}`,
      '--json', 'number',
      '--limit', String(LABEL_POLL_MAX_PRS),
    ],
    { timeout: LABEL_POLL_TIMEOUT_MS },
  )
  const parsed = JSON.parse(stdout.trim() || '[]') as Array<{ number: number }>
  return parsed.filter((p): p is LabeledPR => typeof p.number === 'number')
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
      peekAll: (id) => storage.peekAll(id),
      dequeueBatch: (id, prs) => storage.dequeueBatch(id, prs),
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

  // Label poller — REN-503 secondary handoff path. Polls GitHub for PRs
  // carrying `approved-for-merge` and enqueues them via the local adapter.
  // Complements the orchestrator's synchronous enqueue on acceptance pass:
  //   - Recovers from missed acceptance events (agent crash, backstop gap)
  //   - Enables human-initiated queueing (`gh pr edit N --add-label …`)
  //   - No effect if repoId is unparseable (e.g., default-fallback string)
  const adapter = new LocalMergeQueueAdapter(deps.storage as never)
  const repoParts = splitRepoId(repoId)
  const labelPollHandle = repoParts
    ? startLabelPollLoop(adapter, repoParts.owner, repoParts.repo, workerConfig.pollInterval, signal)
    : null

  return {
    stop: () => {
      labelPollHandle?.stop()
      worker.stop()
    },
    done,
  }
}

/**
 * Start a setInterval loop that runs the label poller at the worker's
 * pollInterval. Returns a handle that can be stopped. Errors in the poller
 * are caught inside pollApprovedForMergeLabel — the loop itself never throws.
 */
function startLabelPollLoop(
  adapter: LabelPollerAdapter,
  owner: string,
  repo: string,
  pollIntervalMs: number,
  signal?: AbortSignal,
): { stop: () => void } {
  let stopped = false
  const run = async (): Promise<void> => {
    if (stopped || signal?.aborted) return
    await pollApprovedForMergeLabel(adapter, owner, repo)
  }

  // First tick immediately so a labeled PR isn't delayed by up to pollInterval
  // on startup; then run on the configured cadence.
  void run()
  const timer = setInterval(() => void run(), pollIntervalMs)

  signal?.addEventListener('abort', () => {
    stopped = true
    clearInterval(timer)
  })

  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
  }
}
