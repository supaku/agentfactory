import type { EmbeddingProviderConfig } from '../types.js'

/**
 * Abstract interface for embedding providers.
 * Implementations produce dense vectors from text for semantic search.
 */
export interface EmbeddingProvider {
  readonly model: string
  readonly dimensions: number
  /** Batch embed multiple texts, returning one vector per text. */
  embed(texts: string[]): Promise<number[][]>
  /** Embed a single query text. */
  embedQuery(text: string): Promise<number[]>
}

export type { EmbeddingProviderConfig }
