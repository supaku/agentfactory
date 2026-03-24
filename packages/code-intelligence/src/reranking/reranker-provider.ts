/**
 * Abstract interfaces for cross-encoder reranking providers.
 * Rerankers rescore search results using a cross-encoder model
 * for higher-precision final rankings.
 */

// ── Rerank Types ────────────────────────────────────────────────────

/** A document to be reranked against a query. */
export interface RerankDocument {
  /** Unique identifier for the document. */
  id: string
  /** Document content to score against the query. */
  text: string
}

/** A single reranking result with relevance score. */
export interface RerankResult {
  /** Unique identifier matching the input document. */
  id: string
  /** Relevance score in [0, 1]. */
  score: number
  /** Original position in the input documents array. */
  index: number
}

// ── Reranker Provider ───────────────────────────────────────────────

/** Abstract interface for cross-encoder reranking providers. */
export interface RerankerProvider {
  /** The model name used for reranking. */
  readonly model: string
  /** Rerank documents against a query, returning results sorted by relevance. */
  rerank(query: string, documents: RerankDocument[]): Promise<RerankResult[]>
}

// ── Reranker Config ─────────────────────────────────────────────────

/** Configuration for the reranking stage in the hybrid search pipeline. */
export interface RerankerConfig {
  /** Feature flag — set to false to disable reranking. Default: true */
  enabled: boolean
  /** The reranking provider to use. */
  provider: RerankerProvider
  /** Return top N results after reranking. Default: 10 */
  topN: number
  /** Feed top N candidates from hybrid search to the reranker. Default: 50 */
  candidatePool: number
}
