import type { EmbeddingChunk } from '../types.js'

export interface VectorSearchResult {
  chunk: EmbeddingChunk
  score: number                          // Cosine similarity [0, 1]
}

export interface VectorStore {
  insert(chunks: EmbeddingChunk[]): Promise<void>
  search(query: number[], topK: number): Promise<VectorSearchResult[]>
  delete(ids: string[]): Promise<void>
  size(): number
  save(path: string): Promise<void>     // Persist to disk
  load(path: string): Promise<void>     // Load from disk
  clear(): Promise<void>
}
