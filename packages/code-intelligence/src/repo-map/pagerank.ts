/**
 * PageRank algorithm for ranking files by structural importance.
 */
export class PageRank {
  private damping: number
  private iterations: number
  private tolerance: number

  constructor(options?: { damping?: number; iterations?: number; tolerance?: number }) {
    this.damping = options?.damping ?? 0.85
    this.iterations = options?.iterations ?? 100
    this.tolerance = options?.tolerance ?? 1e-6
  }

  /**
   * Compute PageRank scores.
   * @param adjacency Map of node -> set of nodes it links to (imports).
   * @returns Map of node -> PageRank score.
   */
  compute(adjacency: Map<string, Set<string>>): Map<string, number> {
    const nodes = [...adjacency.keys()]
    const N = nodes.length
    if (N === 0) return new Map()

    // Build reverse adjacency (who links TO each node)
    const inLinks = new Map<string, string[]>()
    const outDegree = new Map<string, number>()

    for (const node of nodes) {
      inLinks.set(node, [])
      outDegree.set(node, adjacency.get(node)?.size ?? 0)
    }

    for (const [from, tos] of adjacency) {
      for (const to of tos) {
        if (inLinks.has(to)) {
          inLinks.get(to)!.push(from)
        }
      }
    }

    // Initialize scores uniformly
    let scores = new Map<string, number>()
    const initial = 1 / N
    for (const node of nodes) {
      scores.set(node, initial)
    }

    // Iterate
    for (let iter = 0; iter < this.iterations; iter++) {
      const newScores = new Map<string, number>()
      let maxDelta = 0

      for (const node of nodes) {
        let sum = 0
        for (const linker of inLinks.get(node) ?? []) {
          const linkerOut = outDegree.get(linker) ?? 0
          if (linkerOut > 0) {
            sum += (scores.get(linker) ?? 0) / linkerOut
          }
        }
        const newScore = (1 - this.damping) / N + this.damping * sum
        newScores.set(node, newScore)

        const delta = Math.abs(newScore - (scores.get(node) ?? 0))
        if (delta > maxDelta) maxDelta = delta
      }

      scores = newScores

      // Check convergence
      if (maxDelta < this.tolerance) break
    }

    return scores
  }
}
