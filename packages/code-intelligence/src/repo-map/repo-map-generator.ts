import type { FileAST, RepoMapEntry, CodeSymbol } from '../types.js'
import { DependencyGraph } from './dependency-graph.js'
import { PageRank } from './pagerank.js'

export interface RepoMapOptions {
  maxFiles?: number
  filePatterns?: string[]
  includeSymbols?: boolean
}

/**
 * Aider-style repo map generator.
 * Ranks files by PageRank importance and produces LLM-friendly output.
 */
export class RepoMapGenerator {
  private graph = new DependencyGraph()
  private pagerank = new PageRank()

  /** Generate a repo map from parsed file ASTs. */
  generate(asts: FileAST[], options: RepoMapOptions = {}): RepoMapEntry[] {
    const maxFiles = options.maxFiles ?? 50
    const includeSymbols = options.includeSymbols ?? true

    // Build dependency graph
    this.graph.buildFromASTs(asts)

    // Compute PageRank
    const adjacency = this.graph.getAdjacency()
    const scores = this.pagerank.compute(adjacency)

    // Build entries
    const astMap = new Map(asts.map(a => [a.filePath, a]))
    let entries: RepoMapEntry[] = []

    for (const [filePath, rank] of scores) {
      // Apply file pattern filter
      if (options.filePatterns && !this.matchAnyPattern(filePath, options.filePatterns)) {
        continue
      }

      const ast = astMap.get(filePath)
      const symbols = includeSymbols && ast
        ? ast.symbols
          .filter(s => s.exported)
          .map(s => ({ name: s.name, kind: s.kind, line: s.line }))
        : []

      entries.push({ filePath, rank, symbols })
    }

    // Sort by rank descending
    entries.sort((a, b) => b.rank - a.rank)

    // Limit
    if (entries.length > maxFiles) {
      entries = entries.slice(0, maxFiles)
    }

    return entries
  }

  /** Format repo map as LLM-friendly text. */
  format(entries: RepoMapEntry[]): string {
    const lines: string[] = ['# Repository Map', '']

    for (const entry of entries) {
      lines.push(`## ${entry.filePath} (rank: ${entry.rank.toFixed(4)})`)
      if (entry.symbols.length > 0) {
        for (const sym of entry.symbols) {
          lines.push(`  ${sym.kind}: ${sym.name} (line ${sym.line})`)
        }
      }
      lines.push('')
    }

    return lines.join('\n')
  }

  private matchAnyPattern(filePath: string, patterns: string[]): boolean {
    return patterns.some(p => {
      if (p.startsWith('*')) return filePath.endsWith(p.slice(1))
      if (p.endsWith('/**')) return filePath.startsWith(p.slice(0, -3))
      return filePath.includes(p)
    })
  }
}
