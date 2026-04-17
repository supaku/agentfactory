/**
 * File Change Manifest
 *
 * Builds a list of files modified by a PR branch relative to a target branch.
 * Used by the conflict graph to determine which PRs can merge concurrently
 * (non-overlapping file changes) vs. which must serialize (overlapping files).
 */

import { exec as execCb } from 'child_process'
import { promisify } from 'util'

const exec = promisify(execCb)

export interface PRFileManifest {
  prNumber: number
  sourceBranch: string
  files: string[]
  computedAt: number
}

/**
 * Get the list of files modified by a branch relative to a target branch.
 *
 * Uses three-dot diff (`target...source`) to show only changes introduced
 * on the source branch since it diverged from target — excludes changes
 * that happened on target after the branch point.
 */
export async function buildFileManifest(
  repoPath: string,
  sourceBranch: string,
  targetBranch: string,
  remote: string,
): Promise<string[]> {
  try {
    const { stdout } = await exec(
      `git diff --name-only ${remote}/${targetBranch}...${sourceBranch}`,
      { cwd: repoPath, timeout: 30_000 },
    )
    return stdout.trim().split('\n').filter(Boolean)
  } catch {
    // If the diff fails (e.g., branch not fetched), return empty
    // so the PR is treated as potentially conflicting with everything
    return []
  }
}

/**
 * Build file manifests for multiple PRs.
 * Returns manifests in the same order as input entries.
 */
export async function buildFileManifests(
  repoPath: string,
  entries: Array<{ prNumber: number; sourceBranch: string }>,
  targetBranch: string,
  remote: string,
): Promise<PRFileManifest[]> {
  const results = await Promise.all(
    entries.map(async (entry) => {
      const files = await buildFileManifest(repoPath, entry.sourceBranch, targetBranch, remote)
      return {
        prNumber: entry.prNumber,
        sourceBranch: entry.sourceBranch,
        files,
        computedAt: Date.now(),
      }
    }),
  )
  return results
}
