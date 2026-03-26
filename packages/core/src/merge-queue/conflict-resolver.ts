/**
 * Conflict Resolver
 *
 * Attempts automatic conflict resolution via mergiraf merge driver,
 * then escalates remaining conflicts using the configured strategy.
 *
 * Lifecycle:
 *   1. If mergiraf is enabled, check each conflict file for remaining
 *      conflict markers (mergiraf runs as a git merge driver during rebase).
 *   2. Stage any files that mergiraf resolved (no conflict markers).
 *   3. If all files resolved, run `git rebase --continue`.
 *   4. If any files remain unresolved, escalate per the configured strategy.
 */

import { exec as execCb } from 'child_process'
import { promisify } from 'util'

const exec = promisify(execCb)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConflictContext {
  repoPath: string
  worktreePath: string
  sourceBranch: string
  targetBranch: string
  prNumber: number
  issueIdentifier: string
  conflictFiles: string[]
  conflictDetails?: string
}

export type EscalationStrategy = 'reassign' | 'notify' | 'park'

export interface ResolutionResult {
  status: 'resolved' | 'escalated' | 'parked'
  method: 'mergiraf' | 'escalation'
  resolvedFiles?: string[]
  unresolvedFiles?: string[]
  escalationAction?: EscalationStrategy
  message?: string
}

export interface ConflictResolverConfig {
  mergirafEnabled: boolean
  escalationStrategy: EscalationStrategy
}

// ---------------------------------------------------------------------------
// ConflictResolver
// ---------------------------------------------------------------------------

export class ConflictResolver {
  constructor(private config: ConflictResolverConfig) {}

  /**
   * Resolve merge conflicts using mergiraf (if enabled), then escalate
   * any remaining unresolved files using the configured strategy.
   */
  async resolve(ctx: ConflictContext): Promise<ResolutionResult> {
    // 1. If mergiraf enabled, attempt auto-resolution
    if (this.config.mergirafEnabled) {
      const mergirafResult = await this.attemptMergiraf(ctx)
      if (mergirafResult.status === 'resolved') {
        return mergirafResult
      }
      // Partial resolution — update context with remaining files
      ctx = { ...ctx, conflictFiles: mergirafResult.unresolvedFiles ?? ctx.conflictFiles }
    }

    // 2. Escalate remaining conflicts
    return this.escalate(ctx)
  }

  // ---------------------------------------------------------------------------
  // Mergiraf auto-resolution
  // ---------------------------------------------------------------------------

  /**
   * Check each conflict file for remaining conflict markers.
   * Mergiraf runs as a git merge driver during rebase, so by the time we
   * inspect the files, successfully resolved ones will have no markers.
   */
  private async attemptMergiraf(ctx: ConflictContext): Promise<ResolutionResult> {
    const resolvedFiles: string[] = []
    const unresolvedFiles: string[] = []

    for (const file of ctx.conflictFiles) {
      const hasConflict = await this.fileHasConflictMarkers(ctx.worktreePath, file)
      if (!hasConflict) {
        // Mergiraf resolved this file — stage it
        await exec(`git add "${file}"`, { cwd: ctx.worktreePath })
        resolvedFiles.push(file)
      } else {
        unresolvedFiles.push(file)
      }
    }

    if (unresolvedFiles.length === 0) {
      // All resolved — continue rebase
      try {
        await exec('git rebase --continue', {
          cwd: ctx.worktreePath,
          env: { ...process.env, GIT_EDITOR: 'true' },
        })
        return {
          status: 'resolved',
          method: 'mergiraf',
          resolvedFiles,
        }
      } catch {
        // Rebase continue failed — may need more resolution rounds
        return {
          status: 'escalated',
          method: 'mergiraf',
          resolvedFiles,
          unresolvedFiles: ctx.conflictFiles,
          message: 'Mergiraf resolved conflict files but rebase --continue failed',
        }
      }
    }

    return {
      status: 'escalated',
      method: 'mergiraf',
      resolvedFiles,
      unresolvedFiles,
      message: `Mergiraf resolved ${resolvedFiles.length}/${ctx.conflictFiles.length} files`,
    }
  }

  /**
   * Check whether a file contains git conflict markers.
   * grep returns exit code 1 when no matches are found.
   */
  private async fileHasConflictMarkers(worktreePath: string, file: string): Promise<boolean> {
    try {
      const { stdout } = await exec(
        `grep -c "^<<<<<<<\\|^=======\\|^>>>>>>>" "${file}"`,
        { cwd: worktreePath },
      )
      return parseInt(stdout.trim(), 10) > 0
    } catch {
      // grep returns exit code 1 when no matches — no conflict markers
      return false
    }
  }

  // ---------------------------------------------------------------------------
  // Escalation strategies
  // ---------------------------------------------------------------------------

  private async escalate(ctx: ConflictContext): Promise<ResolutionResult> {
    switch (this.config.escalationStrategy) {
      case 'reassign':
        return this.escalateReassign(ctx)
      case 'notify':
        return this.escalateNotify(ctx)
      case 'park':
        return this.escalatePark(ctx)
      default:
        return this.escalateNotify(ctx)
    }
  }

  private async escalateReassign(ctx: ConflictContext): Promise<ResolutionResult> {
    const diffOutput = await this.getConflictDiff(ctx)
    return {
      status: 'escalated',
      method: 'escalation',
      unresolvedFiles: ctx.conflictFiles,
      escalationAction: 'reassign',
      message: `Conflict on ${ctx.issueIdentifier} PR #${ctx.prNumber}. Files: ${ctx.conflictFiles.join(', ')}. Agent should resolve and re-submit.\n\nDiff:\n${diffOutput}`,
    }
  }

  private async escalateNotify(ctx: ConflictContext): Promise<ResolutionResult> {
    return {
      status: 'escalated',
      method: 'escalation',
      unresolvedFiles: ctx.conflictFiles,
      escalationAction: 'notify',
      message: `Merge conflict on ${ctx.issueIdentifier} PR #${ctx.prNumber} requires resolution. Files: ${ctx.conflictFiles.join(', ')}`,
    }
  }

  private async escalatePark(ctx: ConflictContext): Promise<ResolutionResult> {
    return {
      status: 'parked',
      method: 'escalation',
      unresolvedFiles: ctx.conflictFiles,
      escalationAction: 'park',
      message: `PR #${ctx.prNumber} parked due to conflicts in: ${ctx.conflictFiles.join(', ')}. Will auto-retry after other merges complete.`,
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async getConflictDiff(ctx: ConflictContext): Promise<string> {
    try {
      const { stdout } = await exec(
        `git diff ${ctx.conflictFiles.map(f => `"${f}"`).join(' ')}`,
        {
          cwd: ctx.worktreePath,
          maxBuffer: 1024 * 1024, // 1MB
        },
      )
      return stdout.slice(0, 5000) // Truncate for readability
    } catch {
      return '(unable to generate diff)'
    }
  }
}
