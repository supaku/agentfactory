/**
 * Hybrid search engine combining BM25 lexical search with dense vector semantic search.
 * Uses Convex Combination Score (CCS) fusion with query-adaptive alpha weighting
 * and Reciprocal Rank Fusion (RRF) as a fallback.
 */

import type { SearchQuery, SearchResult } from '../types.js'
import type { VectorStore } from '../vector/vector-store.js'
import type { EmbeddingProvider } from '../embedding/embedding-provider.js'
import type { SearchEngine } from './search-engine.js'
import type { RerankerConfig, RerankDocument } from '../reranking/reranker-provider.js'
import { minMaxNormalize } from './score-normalizer.js'
import { classifyQuery } from './query-classifier.js'

// ── Config ───────────────────────────────────────────────────────────

export interface HybridSearchConfig {
  /** Weight for vector scores in CCS (0 = BM25-only, 1 = vector-only). Default: 0.45 */
  alpha: number
  /** Enable query-adaptive alpha selection. Default: true */
  adaptiveAlpha: boolean
  /** Number of BM25 candidates to retrieve. Default: 100 */
  bm25TopK: number
  /** Number of vector candidates to retrieve. Default: 100 */
  vectorTopK: number
  /** Fusion method. Default: 'ccs' */
  fusionMethod: 'ccs' | 'rrf'
  /** RRF constant k. Default: 60 */
  rrfK: number
}

const DEFAULT_CONFIG: HybridSearchConfig = {
  alpha: 0.45,
  adaptiveAlpha: true,
  bm25TopK: 100,
  vectorTopK: 100,
  fusionMethod: 'ccs',
  rrfK: 60,
}

// ── Internal types ───────────────────────────────────────────────────

/** Key for matching BM25 results to vector results. */
type DocKey = string

interface FusionCandidate {
  bm25Score: number | undefined
  vectorScore: number | undefined
  bm25Rank: number | undefined
  vectorRank: number | undefined
  result: SearchResult
}

// ── Hybrid Search Engine ─────────────────────────────────────────────

export class HybridSearchEngine {
  private bm25Engine: SearchEngine
  private vectorStore: VectorStore | null
  private embeddingProvider: EmbeddingProvider | null
  private config: HybridSearchConfig
  private rerankerConfig: RerankerConfig | null

  constructor(
    bm25Engine: SearchEngine,
    vectorStore: VectorStore | null,
    embeddingProvider: EmbeddingProvider | null,
    config?: Partial<HybridSearchConfig>,
    rerankerConfig?: RerankerConfig | null,
  ) {
    this.bm25Engine = bm25Engine
    this.vectorStore = vectorStore
    this.embeddingProvider = embeddingProvider
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.rerankerConfig = rerankerConfig ?? null
  }

  /** Run hybrid search combining BM25 and vector retrieval. */
  async search(query: SearchQuery): Promise<SearchResult[]> {
    // Step 1: Get BM25 results (always available)
    const bm25Query: SearchQuery = {
      ...query,
      maxResults: this.config.bm25TopK,
    }
    const bm25Results = this.bm25Engine.search(bm25Query)

    let results: SearchResult[]

    // Step 2: If vector store and embedding provider are available, do hybrid fusion
    if (this.vectorStore && this.embeddingProvider && this.vectorStore.size() > 0) {
      results = await this.hybridFusion(query, bm25Results)
    } else {
      // Step 3: Fallback to BM25-only
      results = bm25Results
      if (query.maxResults) {
        results = results.slice(0, query.maxResults)
      }
    }

    // Step 4: Apply reranking if configured and enabled
    results = await this.applyReranking(query.query, results)

    return results
  }

  private async hybridFusion(
    query: SearchQuery,
    bm25Results: SearchResult[],
  ): Promise<SearchResult[]> {
    // Embed the query
    const queryVector = await this.embeddingProvider!.embedQuery(query.query)

    // Search vector store
    const vectorResults = await this.vectorStore!.search(queryVector, this.config.vectorTopK)

    // Build candidate map keyed by docKey
    const candidates = new Map<DocKey, FusionCandidate>()

    // Add BM25 results
    for (let i = 0; i < bm25Results.length; i++) {
      const r = bm25Results[i]
      const key = this.makeDocKey(r.symbol.filePath, r.symbol.name, r.symbol.line)
      candidates.set(key, {
        bm25Score: r.score,
        vectorScore: undefined,
        bm25Rank: i + 1,
        vectorRank: undefined,
        result: r,
      })
    }

    // Add/merge vector results
    for (let i = 0; i < vectorResults.length; i++) {
      const vr = vectorResults[i]
      const meta = vr.chunk.metadata
      const key = this.makeDocKey(
        meta.filePath,
        meta.symbolName ?? '',
        meta.startLine,
      )

      const existing = candidates.get(key)
      if (existing) {
        existing.vectorScore = vr.score
        existing.vectorRank = i + 1
      } else {
        // Vector-only result — create a SearchResult from the chunk metadata
        candidates.set(key, {
          bm25Score: undefined,
          vectorScore: vr.score,
          bm25Rank: undefined,
          vectorRank: i + 1,
          result: {
            symbol: {
              name: meta.symbolName ?? '',
              kind: meta.symbolKind ?? 'function',
              filePath: meta.filePath,
              line: meta.startLine,
              endLine: meta.endLine,
              language: meta.language,
              exported: false,
            },
            score: 0, // Will be set by fusion
            matchType: 'semantic',
          },
        })
      }
    }

    // Determine alpha
    const alpha = this.config.adaptiveAlpha
      ? classifyQuery(query.query).alpha
      : this.config.alpha

    // Fuse scores
    const fused = this.config.fusionMethod === 'ccs'
      ? this.ccsFusion(candidates, alpha)
      : this.rrfFusion(candidates)

    // Apply filters
    let results = fused.filter(r => {
      if (query.symbolKinds && !query.symbolKinds.includes(r.symbol.kind)) return false
      if (query.language && r.symbol.language !== query.language) return false
      if (query.filePattern && !this.matchPattern(r.symbol.filePath, query.filePattern)) return false
      return true
    })

    // Sort by fused score descending
    results.sort((a, b) => b.score - a.score)

    // Limit results
    if (query.maxResults) {
      results = results.slice(0, query.maxResults)
    }

    return results
  }

  /**
   * Convex Combination Score fusion.
   * score(d) = alpha * normalized_vector(d) + (1 - alpha) * normalized_bm25(d)
   */
  private ccsFusion(
    candidates: Map<DocKey, FusionCandidate>,
    alpha: number,
  ): SearchResult[] {
    // Collect raw scores for normalization
    const bm25Scores: number[] = []
    const vectorScores: number[] = []

    for (const c of candidates.values()) {
      if (c.bm25Score !== undefined) bm25Scores.push(c.bm25Score)
      if (c.vectorScore !== undefined) vectorScores.push(c.vectorScore)
    }

    // Normalize
    const bm25Normalized = minMaxNormalize(bm25Scores)
    const vectorNormalized = minMaxNormalize(vectorScores)

    // Build a map from raw score to normalized score
    let bm25Idx = 0
    let vectorIdx = 0
    const bm25NormMap = new Map<number, number[]>()
    const vectorNormMap = new Map<number, number[]>()

    // Since multiple candidates can have the same raw score, use arrays
    for (const c of candidates.values()) {
      if (c.bm25Score !== undefined) {
        if (!bm25NormMap.has(c.bm25Score)) bm25NormMap.set(c.bm25Score, [])
        bm25NormMap.get(c.bm25Score)!.push(bm25Normalized[bm25Idx++])
      }
      if (c.vectorScore !== undefined) {
        if (!vectorNormMap.has(c.vectorScore)) vectorNormMap.set(c.vectorScore, [])
        vectorNormMap.get(c.vectorScore)!.push(vectorNormalized[vectorIdx++])
      }
    }

    // Reset counters for consumption
    const bm25NormCounters = new Map<number, number>()
    const vectorNormCounters = new Map<number, number>()

    const results: SearchResult[] = []

    // Re-iterate to assign normalized scores in order
    bm25Idx = 0
    vectorIdx = 0

    for (const c of candidates.values()) {
      let normBm25 = 0
      let normVector = 0

      if (c.bm25Score !== undefined) {
        normBm25 = bm25Normalized[bm25Idx++]
      }
      if (c.vectorScore !== undefined) {
        normVector = vectorNormalized[vectorIdx++]
      }

      const fusedScore = alpha * normVector + (1 - alpha) * normBm25
      const hasBoth = c.bm25Score !== undefined && c.vectorScore !== undefined

      results.push({
        ...c.result,
        score: fusedScore,
        matchType: hasBoth ? 'hybrid' : (c.vectorScore !== undefined ? 'semantic' : c.result.matchType),
        bm25Score: c.bm25Score,
        vectorScore: c.vectorScore,
      })
    }

    return results
  }

  /**
   * Reciprocal Rank Fusion.
   * rrf_score(d) = sum(1 / (k + rank_i(d))) for each ranking
   */
  private rrfFusion(candidates: Map<DocKey, FusionCandidate>): SearchResult[] {
    const k = this.config.rrfK
    const results: SearchResult[] = []

    for (const c of candidates.values()) {
      let rrfScore = 0
      if (c.bm25Rank !== undefined) {
        rrfScore += 1 / (k + c.bm25Rank)
      }
      if (c.vectorRank !== undefined) {
        rrfScore += 1 / (k + c.vectorRank)
      }

      const hasBoth = c.bm25Rank !== undefined && c.vectorRank !== undefined

      results.push({
        ...c.result,
        score: rrfScore,
        matchType: hasBoth ? 'hybrid' : (c.vectorRank !== undefined ? 'semantic' : c.result.matchType),
        bm25Score: c.bm25Score,
        vectorScore: c.vectorScore,
      })
    }

    return results
  }

  /**
   * Apply cross-encoder reranking to search results.
   * Returns results unchanged if reranker is not configured, disabled, or errors.
   */
  private async applyReranking(query: string, results: SearchResult[]): Promise<SearchResult[]> {
    if (!this.rerankerConfig || !this.rerankerConfig.enabled) {
      return results
    }

    const { provider, topN = 10, candidatePool = 50 } = this.rerankerConfig

    // Take the top candidatePool results for reranking
    const candidates = results.slice(0, candidatePool)
    if (candidates.length === 0) return results

    // Build rerank documents from search results
    const documents: RerankDocument[] = candidates.map((r, i) => ({
      id: `${i}`,
      text: this.buildRerankText(r),
    }))

    try {
      const rerankResults = await provider.rerank(query, documents)

      // Build a map from index to rerank score
      const scoreMap = new Map<number, number>()
      for (const rr of rerankResults) {
        scoreMap.set(rr.index, rr.score)
      }

      // Update candidate results with rerank scores
      const reranked: SearchResult[] = []
      for (let i = 0; i < candidates.length; i++) {
        const rerankScore = scoreMap.get(i)
        if (rerankScore !== undefined) {
          reranked.push({
            ...candidates[i],
            score: rerankScore,
            rerankScore,
          })
        }
      }

      // Sort by reranker score descending
      reranked.sort((a, b) => b.score - a.score)

      // Return top N
      return reranked.slice(0, topN)
    } catch {
      // Graceful fallback: return original results if reranker errors
      return results
    }
  }

  /** Build text for reranking from a search result's symbol metadata. */
  private buildRerankText(result: SearchResult): string {
    const parts: string[] = []

    const { symbol } = result

    if (symbol.signature) {
      parts.push(symbol.signature)
    }

    if (symbol.documentation) {
      parts.push(symbol.documentation)
    }

    // Always include name and kind for context
    parts.push(`${symbol.kind} ${symbol.name}`)

    return parts.join('\n')
  }

  /** Create a document key for matching BM25 results to vector results. */
  private makeDocKey(filePath: string, symbolName: string, startLine: number): DocKey {
    return `${filePath}:${symbolName}:${startLine}`
  }

  private matchPattern(filePath: string, pattern: string): boolean {
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
