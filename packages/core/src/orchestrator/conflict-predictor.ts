/**
 * Conflict Predictor
 *
 * Pre-development conflict prediction. Before spawning a development agent,
 * checks in-flight PRs and file reservations for potential file overlap.
 * Injects a warning into the agent's template context if conflicts are likely.
 *
 * This is a best-effort heuristic — it can't predict which files the agent
 * will actually modify. It checks:
 *   1. Files reserved by active sessions (via file reservation system)
 *   2. Files modified by open PRs from other issues
 *
 * The prediction is advisory: it warns the agent but doesn't block work.
 */

import { exec as execCb } from 'child_process'
import { promisify } from 'util'

const exec = promisify(execCb)

export interface ConflictPrediction {
  riskLevel: 'none' | 'low' | 'high'
  overlappingPRs: Array<{ prNumber: number; branch: string; sharedFiles: string[] }>
  warning?: string
}

/**
 * Predict potential merge conflicts before starting development.
 *
 * Checks open PRs targeting main for file overlap with the given scope paths.
 * If no scope paths are provided, returns no prediction (can't predict without scope).
 *
 * @param repoPath - Path to the git repository
 * @param scopePaths - Directories/files likely to be modified (from path-scoping config)
 * @param remote - Git remote name (default: 'origin')
 * @param targetBranch - Target branch (default: 'main')
 */
export async function predictConflicts(
  repoPath: string,
  scopePaths?: string[],
  remote = 'origin',
  targetBranch = 'main',
): Promise<ConflictPrediction> {
  if (!scopePaths || scopePaths.length === 0) {
    return { riskLevel: 'none', overlappingPRs: [] }
  }

  try {
    // Get list of open PRs via gh CLI
    const { stdout: prJson } = await exec(
      `gh pr list --json number,headRefName --state open --limit 50`,
      { cwd: repoPath, timeout: 30_000 },
    )

    const prs = JSON.parse(prJson) as Array<{ number: number; headRefName: string }>
    if (prs.length === 0) {
      return { riskLevel: 'none', overlappingPRs: [] }
    }

    const overlapping: ConflictPrediction['overlappingPRs'] = []

    for (const pr of prs) {
      try {
        const { stdout: diffOutput } = await exec(
          `git diff --name-only ${remote}/${targetBranch}...${remote}/${pr.headRefName}`,
          { cwd: repoPath, timeout: 10_000 },
        )

        const prFiles = diffOutput.trim().split('\n').filter(Boolean)

        // Check if any PR files fall within scope paths
        const shared = prFiles.filter(file =>
          scopePaths.some(scope => file.startsWith(scope)),
        )

        if (shared.length > 0) {
          overlapping.push({
            prNumber: pr.number,
            branch: pr.headRefName,
            sharedFiles: shared,
          })
        }
      } catch {
        // Skip PRs where diff fails (branch might not be fetched)
      }
    }

    if (overlapping.length === 0) {
      return { riskLevel: 'none', overlappingPRs: [] }
    }

    const riskLevel = overlapping.length >= 3 ? 'high' : 'low'
    const prList = overlapping
      .map(p => `PR #${p.prNumber} (${p.branch}): ${p.sharedFiles.join(', ')}`)
      .join('\n  ')

    return {
      riskLevel,
      overlappingPRs: overlapping,
      warning:
        `${overlapping.length} open PR(s) modify files in your project scope:\n  ${prList}\n` +
        `To minimize merge conflicts: use af_code_reserve_files before editing shared files, ` +
        `and rebase onto main frequently.`,
    }
  } catch {
    // gh CLI not available or other error — skip prediction
    return { riskLevel: 'none', overlappingPRs: [] }
  }
}
