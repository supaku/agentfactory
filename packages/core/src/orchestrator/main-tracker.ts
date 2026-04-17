/**
 * Main Branch Tracker
 *
 * Monitors the main branch for new commits and identifies which active
 * agents may be affected by the changes. When main advances and overlaps
 * with an agent's working files, the orchestrator can notify the agent
 * to rebase proactively.
 *
 * Usage:
 *   const tracker = new MainTracker(repoPath)
 *   const advance = await tracker.check()
 *   if (advance) {
 *     // advance.changedFiles contains files modified on main
 *     // Compare with agent's modified files to determine overlap
 *   }
 */

import { exec as execCb } from 'child_process'
import { promisify } from 'util'

const exec = promisify(execCb)

export interface MainAdvanceEvent {
  /** Previous HEAD SHA */
  previousSha: string
  /** Current HEAD SHA */
  currentSha: string
  /** Number of new commits */
  commitCount: number
  /** Files changed between previous and current SHA */
  changedFiles: string[]
  /** Timestamp of detection */
  detectedAt: number
}

export class MainTracker {
  private lastKnownSha: string | null = null

  constructor(
    private readonly repoPath: string,
    private readonly remote = 'origin',
    private readonly branch = 'main',
  ) {}

  /**
   * Check if main has advanced since last check.
   * First call initializes the tracker and returns null.
   * Subsequent calls return an event if main has advanced, null otherwise.
   */
  async check(): Promise<MainAdvanceEvent | null> {
    try {
      // Fetch latest
      await exec(`git fetch ${this.remote} ${this.branch}`, {
        cwd: this.repoPath,
        timeout: 30_000,
      })

      // Get current SHA
      const { stdout: currentSha } = await exec(
        `git rev-parse ${this.remote}/${this.branch}`,
        { cwd: this.repoPath },
      )
      const sha = currentSha.trim()

      if (this.lastKnownSha === null) {
        // First check — initialize and return null
        this.lastKnownSha = sha
        return null
      }

      if (sha === this.lastKnownSha) {
        return null // No change
      }

      // Main advanced — compute diff
      const previousSha = this.lastKnownSha
      this.lastKnownSha = sha

      const { stdout: diffOutput } = await exec(
        `git diff --name-only ${previousSha}..${sha}`,
        { cwd: this.repoPath, timeout: 10_000 },
      )

      const changedFiles = diffOutput.trim().split('\n').filter(Boolean)

      const { stdout: countStr } = await exec(
        `git rev-list --count ${previousSha}..${sha}`,
        { cwd: this.repoPath },
      )

      return {
        previousSha,
        currentSha: sha,
        commitCount: parseInt(countStr.trim(), 10) || 0,
        changedFiles,
        detectedAt: Date.now(),
      }
    } catch {
      return null
    }
  }

  /**
   * Check if an agent's working files overlap with a main advance event.
   *
   * @param agentFiles - Files the agent has modified (from git diff in worktree)
   * @param advance - Main advance event
   * @returns Overlapping file paths, or empty array if no overlap
   */
  static findOverlap(agentFiles: string[], advance: MainAdvanceEvent): string[] {
    const advanceSet = new Set(advance.changedFiles)
    return agentFiles.filter(f => advanceSet.has(f))
  }
}
