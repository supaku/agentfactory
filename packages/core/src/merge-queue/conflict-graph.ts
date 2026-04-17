/**
 * Conflict Graph
 *
 * Given a set of PR file manifests, builds an undirected graph where edges
 * represent file overlap between PRs. Uses greedy graph coloring to find
 * independent sets of non-conflicting PRs that can be processed in parallel.
 *
 * PRs with empty file manifests (e.g., failed to compute diff) are treated
 * as conflicting with ALL other PRs to prevent unsafe concurrent merges.
 */

import type { PRFileManifest } from './file-manifest.js'

export class ConflictGraph {
  /** Map of PR number → set of modified files */
  private prFiles = new Map<number, Set<string>>()
  /** Adjacency list: PR number → set of conflicting PR numbers */
  private edges = new Map<number, Set<number>>()

  /**
   * Add a PR's file manifest to the graph.
   * Automatically detects conflicts with previously added PRs.
   */
  addPR(prNumber: number, files: string[]): void {
    const fileSet = new Set(files)
    this.prFiles.set(prNumber, fileSet)

    if (!this.edges.has(prNumber)) {
      this.edges.set(prNumber, new Set())
    }

    // Check for overlaps with all existing PRs
    for (const [otherPR, otherFiles] of this.prFiles) {
      if (otherPR === prNumber) continue

      // Empty file lists are treated as universal conflicts
      const hasOverlap =
        files.length === 0 ||
        otherFiles.size === 0 ||
        files.some(f => otherFiles.has(f))

      if (hasOverlap) {
        this.edges.get(prNumber)!.add(otherPR)
        if (!this.edges.has(otherPR)) {
          this.edges.set(otherPR, new Set())
        }
        this.edges.get(otherPR)!.add(prNumber)
      }
    }
  }

  /**
   * Check if two PRs have conflicting file changes.
   */
  conflicts(pr1: number, pr2: number): boolean {
    return this.edges.get(pr1)?.has(pr2) ?? false
  }

  /**
   * Get files shared between two PRs.
   */
  sharedFiles(pr1: number, pr2: number): string[] {
    const files1 = this.prFiles.get(pr1)
    const files2 = this.prFiles.get(pr2)
    if (!files1 || !files2) return []
    return [...files1].filter(f => files2.has(f))
  }

  /**
   * Find independent batches of non-conflicting PRs using greedy graph coloring.
   *
   * Returns batches ordered by priority (first batch contains the highest-priority
   * PRs that can all merge concurrently). Each batch is limited to maxBatchSize.
   *
   * @param maxBatchSize - Maximum PRs per batch (default: unlimited)
   * @returns Array of PR number arrays, each representing a concurrent batch
   */
  findIndependentBatches(maxBatchSize = Infinity): number[][] {
    const prs = [...this.prFiles.keys()]
    if (prs.length === 0) return []

    // Greedy coloring: assign each PR to the first batch where it has no conflicts
    const batches: number[][] = []
    const assigned = new Set<number>()

    for (const pr of prs) {
      if (assigned.has(pr)) continue

      let placed = false
      for (const batch of batches) {
        if (batch.length >= maxBatchSize) continue

        // Check if this PR conflicts with any PR already in the batch
        const conflictsWithBatch = batch.some(batchPR =>
          this.edges.get(pr)?.has(batchPR) ?? false,
        )

        if (!conflictsWithBatch) {
          batch.push(pr)
          assigned.add(pr)
          placed = true
          break
        }
      }

      if (!placed) {
        batches.push([pr])
        assigned.add(pr)
      }
    }

    return batches
  }

  /**
   * Get the number of PRs in the graph.
   */
  get size(): number {
    return this.prFiles.size
  }
}

/**
 * Build a conflict graph from PR file manifests.
 */
export function buildConflictGraph(manifests: PRFileManifest[]): ConflictGraph {
  const graph = new ConflictGraph()
  for (const manifest of manifests) {
    graph.addPR(manifest.prNumber, manifest.files)
  }
  return graph
}
