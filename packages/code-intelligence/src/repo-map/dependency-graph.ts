import type { FileAST } from '../types.js'

export interface GraphEdge {
  from: string
  to: string
}

/**
 * File dependency graph built from import/export analysis.
 */
export class DependencyGraph {
  private adjacency: Map<string, Set<string>> = new Map()
  private reverseAdjacency: Map<string, Set<string>> = new Map()
  private allFiles: Set<string> = new Set()

  /** Build the graph from parsed file ASTs. */
  buildFromASTs(asts: FileAST[]): void {
    this.adjacency.clear()
    this.reverseAdjacency.clear()
    this.allFiles.clear()

    // Create file lookup for import resolution
    const filePaths = new Set(asts.map(a => a.filePath))

    for (const ast of asts) {
      this.allFiles.add(ast.filePath)
      if (!this.adjacency.has(ast.filePath)) {
        this.adjacency.set(ast.filePath, new Set())
      }

      for (const imp of ast.imports) {
        const resolved = this.resolveImport(imp, ast.filePath, filePaths)
        if (resolved) {
          this.adjacency.get(ast.filePath)!.add(resolved)
          if (!this.reverseAdjacency.has(resolved)) {
            this.reverseAdjacency.set(resolved, new Set())
          }
          this.reverseAdjacency.get(resolved)!.add(ast.filePath)
        }
      }
    }
  }

  /** Get files that this file imports. */
  getDependencies(filePath: string): string[] {
    return [...(this.adjacency.get(filePath) ?? [])]
  }

  /** Get files that import this file. */
  getDependents(filePath: string): string[] {
    return [...(this.reverseAdjacency.get(filePath) ?? [])]
  }

  /** Get all files in the graph. */
  getFiles(): string[] {
    return [...this.allFiles]
  }

  /** Get all edges. */
  getEdges(): GraphEdge[] {
    const edges: GraphEdge[] = []
    for (const [from, tos] of this.adjacency) {
      for (const to of tos) {
        edges.push({ from, to })
      }
    }
    return edges
  }

  /** Get the in-degree for each file (number of dependents). */
  getInDegrees(): Map<string, number> {
    const degrees = new Map<string, number>()
    for (const file of this.allFiles) {
      degrees.set(file, this.reverseAdjacency.get(file)?.size ?? 0)
    }
    return degrees
  }

  /** Get the adjacency map (for PageRank). */
  getAdjacency(): Map<string, Set<string>> {
    return new Map(this.adjacency)
  }

  private resolveImport(importPath: string, fromFile: string, knownFiles: Set<string>): string | null {
    // Skip node_modules / external imports
    if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
      return null
    }

    // Resolve relative path
    const fromDir = fromFile.substring(0, fromFile.lastIndexOf('/'))
    let resolved = this.normalizePath(fromDir + '/' + importPath)

    // Strip .js/.ts extensions for matching
    resolved = resolved.replace(/\.(js|ts|tsx|jsx|mjs|cjs)$/, '')

    // Try exact match, then with extensions
    const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs']
    for (const ext of extensions) {
      if (knownFiles.has(resolved + ext)) {
        return resolved + ext
      }
    }

    // Try /index
    for (const ext of extensions) {
      if (knownFiles.has(resolved + '/index' + ext)) {
        return resolved + '/index' + ext
      }
    }

    return null
  }

  private normalizePath(path: string): string {
    const parts: string[] = []
    for (const part of path.split('/')) {
      if (part === '.' || part === '') continue
      if (part === '..' && parts.length > 0) {
        parts.pop()
      } else if (part !== '..') {
        parts.push(part)
      }
    }
    return parts.join('/')
  }
}
