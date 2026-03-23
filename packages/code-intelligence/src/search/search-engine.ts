import type { CodeSymbol, SearchQuery, SearchResult } from '../types.js'
import { InvertedIndex } from './inverted-index.js'
import { BM25, type BM25Options } from './bm25.js'

/**
 * High-level search engine combining BM25 ranking with filtering and exact match boosting.
 */
export class SearchEngine {
  private index = new InvertedIndex()
  private bm25: BM25
  private symbols: CodeSymbol[] = []

  constructor(options?: BM25Options) {
    this.bm25 = new BM25(options)
  }

  /** Build the search index from symbols. */
  buildIndex(symbols: CodeSymbol[]): void {
    this.symbols = symbols
    this.index.build(symbols)
  }

  /** Search for symbols matching a query. */
  search(query: SearchQuery): SearchResult[] {
    const scored = this.bm25.score(query.query, this.index)

    let results: SearchResult[] = []
    const queryLower = query.query.toLowerCase()

    for (const { docId, score } of scored) {
      const symbol = this.index.getDocument(docId)
      if (!symbol) continue

      // Apply filters
      if (query.symbolKinds && !query.symbolKinds.includes(symbol.kind)) continue
      if (query.language && symbol.language !== query.language) continue
      if (query.filePattern && !this.matchPattern(symbol.filePath, query.filePattern)) continue

      // Determine match type and boost exact matches
      let matchType: 'exact' | 'fuzzy' | 'bm25' = 'bm25'
      let finalScore = score

      if (symbol.name.toLowerCase() === queryLower) {
        matchType = 'exact'
        finalScore *= 3.0 // Boost exact name matches
      } else if (symbol.name.toLowerCase().includes(queryLower)) {
        matchType = 'fuzzy'
        finalScore *= 1.5 // Boost partial name matches
      }

      results.push({ symbol, score: finalScore, matchType })
    }

    // Sort by final score
    results.sort((a, b) => b.score - a.score)

    // Limit results
    if (query.maxResults) {
      results = results.slice(0, query.maxResults)
    }

    return results
  }

  /** Get index statistics. */
  getStats(): { totalSymbols: number; totalTerms: number } {
    return {
      totalSymbols: this.index.getDocCount(),
      totalTerms: this.index.getTerms().length,
    }
  }

  private matchPattern(filePath: string, pattern: string): boolean {
    // Simple glob matching: *.ts matches .ts files, src/** matches src/ prefix
    if (pattern.startsWith('*')) {
      return filePath.endsWith(pattern.slice(1))
    }
    if (pattern.endsWith('/**')) {
      return filePath.startsWith(pattern.slice(0, -3))
    }
    if (pattern.endsWith('/*')) {
      const dir = pattern.slice(0, -2)
      return filePath.startsWith(dir) && !filePath.slice(dir.length + 1).includes('/')
    }
    return filePath.includes(pattern)
  }
}
