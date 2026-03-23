import { InvertedIndex } from './inverted-index.js'
import { CodeTokenizer } from './tokenizer.js'

export interface BM25Options {
  /** Term frequency saturation parameter (default: 1.5). */
  k1?: number
  /** Document length normalization (default: 0.75). */
  b?: number
}

export interface ScoredDoc {
  docId: number
  score: number
}

/**
 * BM25 scoring engine for code search.
 * Uses Okapi BM25 with configurable k1 and b parameters.
 */
export class BM25 {
  private k1: number
  private b: number
  private tokenizer = new CodeTokenizer()

  constructor(options: BM25Options = {}) {
    this.k1 = options.k1 ?? 1.5
    this.b = options.b ?? 0.75
  }

  /** Score all documents against a query. */
  score(query: string, index: InvertedIndex): ScoredDoc[] {
    const queryTokens = this.tokenizer.tokenize(query)
    const N = index.getDocCount()
    const avgdl = index.getAvgDocLength()

    if (N === 0) return []

    // Accumulate scores per document
    const scores = new Map<number, number>()

    for (const token of queryTokens) {
      const postings = index.getPostings(token)
      const df = postings.length // document frequency
      if (df === 0) continue

      // IDF component: log((N - df + 0.5) / (df + 0.5) + 1)
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1)

      for (const posting of postings) {
        const tf = posting.termFreq
        const dl = index.getDocLength(posting.docId)

        // BM25 TF component
        const tfNorm = (tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * (dl / avgdl)))
        const docScore = idf * tfNorm

        scores.set(posting.docId, (scores.get(posting.docId) ?? 0) + docScore)
      }
    }

    // Sort by score descending
    return [...scores.entries()]
      .map(([docId, score]) => ({ docId, score }))
      .sort((a, b) => b.score - a.score)
  }
}
