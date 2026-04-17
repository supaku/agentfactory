/**
 * Merge Worker — Single-Instance Processor
 *
 * Implements the core rebase -> resolve conflicts -> regenerate lock files -> test -> merge loop.
 * Acquires a Redis lock to ensure only one worker processes a given repository's queue at a time.
 * Uses heartbeat to extend the lock TTL while processing, and supports graceful shutdown.
 *
 * All external dependencies (storage, redis) are injected via MergeWorkerDeps for testability.
 */

import { exec as execCb } from 'child_process'
import { promisify } from 'util'
import { createMergeStrategy } from './strategies/index.js'
import { ConflictResolver } from './conflict-resolver.js'
import { LockFileRegeneration } from './lock-file-regeneration.js'
import type { MergeContext } from './strategies/types.js'
import type { ConflictResolverConfig } from './conflict-resolver.js'
import type { PackageManager } from './lock-file-regeneration.js'
import {
  loadQualityRatchet,
  checkQualityRatchet,
  updateQualityRatchet,
  formatRatchetResult,
} from '../orchestrator/quality-ratchet.js'
import { captureQualityBaseline, type QualityConfig } from '../orchestrator/quality-baseline.js'

const exec = promisify(execCb)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MergeWorkerConfig {
  repoId: string
  repoPath: string
  strategy: 'rebase' | 'merge' | 'squash'
  testCommand: string
  testTimeout: number
  lockFileRegenerate: boolean
  mergiraf: boolean
  pollInterval: number
  maxRetries: number
  escalation: {
    onConflict: 'reassign' | 'notify' | 'park'
    onTestFailure: 'notify' | 'park' | 'retry'
  }
  deleteBranchOnMerge: boolean
  packageManager: PackageManager
  remote: string // default 'origin'
  targetBranch: string // default 'main'
}

export interface MergeWorkerDeps {
  storage: {
    dequeue(repoId: string): Promise<any | null>
    markCompleted(repoId: string, prNumber: number): Promise<void>
    markFailed(repoId: string, prNumber: number, reason: string): Promise<void>
    markBlocked(repoId: string, prNumber: number, reason: string): Promise<void>
    /** Peek all queued entries without removing (used by MergePool) */
    peekAll(repoId: string): Promise<Array<{ prNumber: number; sourceBranch: string }>>
    /** Atomically dequeue multiple PRs for parallel processing (used by MergePool) */
    dequeueBatch(repoId: string, prNumbers: number[]): Promise<Array<{ prNumber: number }>>
  }
  redis: {
    setNX(key: string, value: string, ttlSeconds?: number): Promise<boolean>
    del(key: string): Promise<void>
    get(key: string): Promise<string | null>
    set(key: string, value: string): Promise<void>
    expire(key: string, seconds: number): Promise<void>
  }
  /** Optional file reservation checker for pre-merge conflict detection */
  fileReservation?: {
    checkFileConflicts(
      repoId: string,
      sessionId: string,
      filePaths: string[],
    ): Promise<Array<{ filePath: string; heldBy: { sessionId: string } }>>
  }
}

export interface MergeProcessResult {
  prNumber: number
  status: 'merged' | 'conflict' | 'test-failure' | 'error'
  message?: string
}

// ---------------------------------------------------------------------------
// MergeWorker
// ---------------------------------------------------------------------------

export class MergeWorker {
  private running = false
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private config: MergeWorkerConfig,
    private deps: MergeWorkerDeps,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Start the merge worker. Acquires a lock, then loops processing the queue.
   */
  async start(signal?: AbortSignal): Promise<void> {
    // Acquire single-instance lock
    const lockKey = `merge:lock:${this.config.repoId}`
    const acquired = await this.deps.redis.setNX(lockKey, 'worker', 300) // 5 min TTL
    if (!acquired) {
      throw new Error(`Another merge worker is already running for repo ${this.config.repoId}`)
    }

    this.running = true
    this.startHeartbeat(lockKey)

    try {
      while (this.running && !(signal?.aborted)) {
        // Check if paused
        const paused = await this.deps.redis.get(`merge:paused:${this.config.repoId}`)
        if (paused) {
          await this.sleep(this.config.pollInterval, signal)
          continue
        }

        // Try to dequeue next PR
        const entry = await this.deps.storage.dequeue(this.config.repoId)
        if (!entry) {
          // Queue empty — poll interval wait
          await this.sleep(this.config.pollInterval, signal)
          continue
        }

        // Process the PR
        const result = await this.processEntry(entry)

        // Handle result
        switch (result.status) {
          case 'merged':
            await this.deps.storage.markCompleted(this.config.repoId, result.prNumber)
            break
          case 'conflict':
            await this.deps.storage.markBlocked(this.config.repoId, result.prNumber, result.message ?? 'Merge conflict')
            break
          case 'test-failure': {
            const action = this.config.escalation.onTestFailure
            if (action === 'park') {
              await this.deps.storage.markBlocked(this.config.repoId, result.prNumber, result.message ?? 'Tests failed')
            } else {
              await this.deps.storage.markFailed(this.config.repoId, result.prNumber, result.message ?? 'Tests failed')
            }
            break
          }
          case 'error':
            await this.deps.storage.markFailed(this.config.repoId, result.prNumber, result.message ?? 'Unknown error')
            break
        }
      }
    } finally {
      // Graceful shutdown — release lock
      this.stopHeartbeat()
      await this.deps.redis.del(lockKey)
      this.running = false
    }
  }

  /**
   * Stop the merge worker gracefully (finishes current merge before stopping).
   */
  stop(): void {
    this.running = false
  }

  /**
   * Process a single queue entry: rebase -> resolve conflicts -> regenerate lock files -> test -> merge
   */
  async processEntry(entry: {
    prNumber: number
    sourceBranch: string
    targetBranch?: string
    issueIdentifier?: string
    prUrl?: string
  }): Promise<MergeProcessResult> {
    const strategy = createMergeStrategy(this.config.strategy)
    const conflictResolver = new ConflictResolver({
      mergirafEnabled: this.config.mergiraf,
      escalationStrategy: this.config.escalation.onConflict,
    } satisfies ConflictResolverConfig)
    const lockFileHandler = new LockFileRegeneration()

    const ctx: MergeContext = {
      repoPath: this.config.repoPath,
      worktreePath: this.config.repoPath, // In production, would use a dedicated worktree
      sourceBranch: entry.sourceBranch,
      targetBranch: entry.targetBranch ?? this.config.targetBranch,
      prNumber: entry.prNumber,
      remote: this.config.remote,
    }

    try {
      // 1. Prepare: fetch latest main
      const prepareResult = await strategy.prepare(ctx)
      if (!prepareResult.success) {
        return { prNumber: entry.prNumber, status: 'error', message: `Prepare failed: ${prepareResult.error}` }
      }

      // 1.5 Optional: check if modified files are reserved by active sessions
      if (this.deps.fileReservation) {
        try {
          const { stdout } = await exec(
            `git diff --name-only ${ctx.remote}/${ctx.targetBranch}...${ctx.sourceBranch}`,
            { cwd: ctx.repoPath },
          )
          const modifiedFiles = stdout.trim().split('\n').filter(Boolean)
          if (modifiedFiles.length > 0) {
            const conflicts = await this.deps.fileReservation.checkFileConflicts(
              this.config.repoId,
              `merge-worker-${entry.prNumber}`,
              modifiedFiles,
            )
            if (conflicts.length > 0) {
              const conflictList = conflicts.map(c => `${c.filePath} (held by ${c.heldBy.sessionId})`).join(', ')
              return {
                prNumber: entry.prNumber,
                status: 'conflict',
                message: `Files reserved by active sessions: ${conflictList}`,
              }
            }
          }
        } catch {
          // File reservation check is best-effort; don't block merge on check failure
        }
      }

      // 2. Execute merge strategy (rebase/merge/squash)
      const mergeResult = await strategy.execute(ctx)

      // 3. Handle conflicts
      if (mergeResult.status === 'conflict') {
        const resolution = await conflictResolver.resolve({
          repoPath: ctx.repoPath,
          worktreePath: ctx.worktreePath,
          sourceBranch: ctx.sourceBranch,
          targetBranch: ctx.targetBranch,
          prNumber: ctx.prNumber,
          issueIdentifier: entry.issueIdentifier ?? `PR-${entry.prNumber}`,
          conflictFiles: mergeResult.conflictFiles ?? [],
          conflictDetails: mergeResult.conflictDetails,
        })

        if (resolution.status !== 'resolved') {
          return {
            prNumber: entry.prNumber,
            status: 'conflict',
            message: resolution.message ?? `Unresolved conflicts in: ${(resolution.unresolvedFiles ?? []).join(', ')}`,
          }
        }
      } else if (mergeResult.status === 'error') {
        return { prNumber: entry.prNumber, status: 'error', message: mergeResult.error ?? 'Merge strategy failed' }
      }

      // 4. Regenerate lock files if configured
      if (lockFileHandler.shouldRegenerate(this.config.packageManager, this.config.lockFileRegenerate)) {
        const regenResult = await lockFileHandler.regenerate(ctx.worktreePath, this.config.packageManager)
        if (!regenResult.success) {
          return { prNumber: entry.prNumber, status: 'error', message: `Lock file regeneration failed: ${regenResult.error}` }
        }
      }

      // 5. Run test suite
      const testResult = await this.runTests(ctx.worktreePath)
      if (!testResult.passed) {
        return { prNumber: entry.prNumber, status: 'test-failure', message: testResult.output }
      }

      // 5.5. Quality ratchet check (if ratchet file exists)
      const ratchet = loadQualityRatchet(ctx.worktreePath)
      if (ratchet) {
        const qualityConfig: QualityConfig = {
          testCommand: this.config.testCommand,
          packageManager: this.config.packageManager as string,
        }
        const current = captureQualityBaseline(ctx.worktreePath, qualityConfig)
        const ratchetResult = checkQualityRatchet(ratchet, current)
        if (!ratchetResult.passed) {
          return {
            prNumber: entry.prNumber,
            status: 'test-failure',
            message: `Quality ratchet violated: ${formatRatchetResult(ratchetResult)}`,
          }
        }

        // Tighten ratchet if metrics improved (will be included in the merge)
        const updated = updateQualityRatchet(
          ctx.worktreePath,
          current,
          entry.issueIdentifier ?? `PR-${entry.prNumber}`,
        )
        if (updated) {
          try {
            await exec(
              'git add .agentfactory/quality-ratchet.json && git commit -m "chore: tighten quality ratchet"',
              { cwd: ctx.worktreePath },
            )
          } catch {
            // Ratchet update commit is best-effort
          }
        }
      }

      // 6. Finalize: push and merge
      await strategy.finalize(ctx)

      // 7. Delete branch if configured
      if (this.config.deleteBranchOnMerge) {
        try {
          await exec(`git push ${this.config.remote} --delete ${entry.sourceBranch}`, {
            cwd: ctx.worktreePath,
          })
        } catch {
          // Branch deletion failure is non-fatal
        }
      }

      return { prNumber: entry.prNumber, status: 'merged' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { prNumber: entry.prNumber, status: 'error', message }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async runTests(worktreePath: string): Promise<{ passed: boolean; output: string }> {
    try {
      const { stdout, stderr } = await exec(this.config.testCommand, {
        cwd: worktreePath,
        timeout: this.config.testTimeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      })
      return { passed: true, output: stdout + stderr }
    } catch (error) {
      const message = error instanceof Error ? (error as any).stdout ?? error.message : String(error)
      return { passed: false, output: message }
    }
  }

  private startHeartbeat(lockKey: string): void {
    // Extend lock TTL every 60 seconds
    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.deps.redis.expire(lockKey, 300)
      } catch {
        // Heartbeat failure — will be handled by TTL expiry
      }
    }, 60_000)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
    })
  }
}
