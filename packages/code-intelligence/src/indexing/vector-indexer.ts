import { createHash } from 'node:crypto'
import type { EmbeddingProvider } from '../embedding/embedding-provider.js'
import type { VectorStore } from '../vector/vector-store.js'
import { Chunker } from '../embedding/chunker.js'
import type { FileAST, EmbeddingChunk } from '../types.js'

// ── Config ───────────────────────────────────────────────────────────

export interface VectorIndexConfig {
  enabled: boolean
  embeddingProvider: EmbeddingProvider
  vectorStore: VectorStore
  batchSize?: number
  maxConcurrentBatches?: number
}

// ── Progress ─────────────────────────────────────────────────────────

export interface VectorIndexProgress {
  phase: 'chunking' | 'embedding' | 'indexing'
  processed: number
  total: number
}

// ── Content Hashing ──────────────────────────────────────────────────

function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

// ── VectorIndexer ────────────────────────────────────────────────────

/**
 * Orchestrates the chunk -> embed -> store flow for dense vector indexing.
 *
 * Integrates with the EmbeddingProvider and VectorStore interfaces to
 * compute embeddings for code chunks and maintain a searchable vector index.
 */
export class VectorIndexer {
  private readonly enabled: boolean
  private readonly provider: EmbeddingProvider
  private readonly store: VectorStore
  private readonly batchSize: number
  private readonly maxConcurrentBatches: number
  private readonly chunker: Chunker

  /** Tracks content hashes for previously indexed chunks (id -> hash). */
  private chunkHashes: Map<string, string> = new Map()

  constructor(config: VectorIndexConfig) {
    this.enabled = config.enabled
    this.provider = config.embeddingProvider
    this.store = config.vectorStore
    this.batchSize = config.batchSize ?? 128
    this.maxConcurrentBatches = config.maxConcurrentBatches ?? 2
    this.chunker = new Chunker()
  }

  /**
   * Index new/modified files: chunk -> embed -> insert into vector store.
   */
  async indexFiles(
    asts: FileAST[],
    fileContents: Map<string, string>,
    onProgress?: (progress: VectorIndexProgress) => void,
  ): Promise<{ chunked: number; embedded: number }> {
    if (!this.enabled) return { chunked: 0, embedded: 0 }

    // Phase 1: Chunking
    onProgress?.({ phase: 'chunking', processed: 0, total: asts.length })
    const chunks = this.chunker.chunkFiles(asts, fileContents)
    onProgress?.({ phase: 'chunking', processed: asts.length, total: asts.length })

    if (chunks.length === 0) return { chunked: 0, embedded: 0 }

    // Phase 2: Embedding (batch)
    await this.embedChunks(chunks, onProgress)

    // Phase 3: Indexing (insert into store)
    onProgress?.({ phase: 'indexing', processed: 0, total: chunks.length })
    await this.store.insert(chunks)

    // Track content hashes for future diffing
    for (const chunk of chunks) {
      this.chunkHashes.set(chunk.id, contentHash(chunk.content))
    }

    onProgress?.({ phase: 'indexing', processed: chunks.length, total: chunks.length })

    return { chunked: chunks.length, embedded: chunks.length }
  }

  /**
   * Remove all chunks for given file paths from vector store.
   * Chunk IDs start with filePath, so we filter by prefix.
   */
  async removeFiles(filePaths: string[]): Promise<void> {
    if (!this.enabled) return

    const idsToDelete: string[] = []
    for (const [id] of this.chunkHashes) {
      for (const filePath of filePaths) {
        if (id.startsWith(filePath + ':')) {
          idsToDelete.push(id)
          break
        }
      }
    }

    if (idsToDelete.length > 0) {
      await this.store.delete(idsToDelete)
      for (const id of idsToDelete) {
        this.chunkHashes.delete(id)
      }
    }
  }

  /**
   * Update chunks for modified files (delete old, insert new) with content-hash diffing.
   * Only re-embeds chunks whose content actually changed.
   */
  async updateFiles(
    asts: FileAST[],
    fileContents: Map<string, string>,
    onProgress?: (progress: VectorIndexProgress) => void,
  ): Promise<{ added: number; removed: number; unchanged: number }> {
    if (!this.enabled) return { added: 0, removed: 0, unchanged: 0 }

    // Phase 1: Chunk the new versions
    onProgress?.({ phase: 'chunking', processed: 0, total: asts.length })
    const newChunks = this.chunker.chunkFiles(asts, fileContents)
    onProgress?.({ phase: 'chunking', processed: asts.length, total: asts.length })

    // Collect file paths being updated
    const filePaths = new Set(asts.map(a => a.filePath))

    // Collect old chunk IDs for these files
    const oldChunkIds = new Set<string>()
    for (const [id] of this.chunkHashes) {
      for (const filePath of filePaths) {
        if (id.startsWith(filePath + ':')) {
          oldChunkIds.add(id)
          break
        }
      }
    }

    // Diff: compare content hashes
    const newChunkMap = new Map<string, EmbeddingChunk>()
    for (const chunk of newChunks) {
      newChunkMap.set(chunk.id, chunk)
    }

    const unchangedIds = new Set<string>()
    const changedChunks: EmbeddingChunk[] = []
    const addedChunks: EmbeddingChunk[] = []

    for (const chunk of newChunks) {
      const newHash = contentHash(chunk.content)
      const oldHash = this.chunkHashes.get(chunk.id)

      if (oldHash && oldHash === newHash) {
        // Content unchanged — skip re-embedding
        unchangedIds.add(chunk.id)
      } else if (oldHash) {
        // Content changed — needs re-embedding
        changedChunks.push(chunk)
      } else {
        // New chunk
        addedChunks.push(chunk)
      }
    }

    // IDs to remove: old chunk IDs that are no longer present in new chunks
    const removedIds: string[] = []
    for (const id of oldChunkIds) {
      if (!newChunkMap.has(id)) {
        removedIds.push(id)
      }
    }

    // Delete removed and changed chunks from store
    const idsToDelete = [...removedIds, ...changedChunks.map(c => c.id)]
    if (idsToDelete.length > 0) {
      await this.store.delete(idsToDelete)
    }

    // Embed and insert changed + added chunks
    const toEmbed = [...changedChunks, ...addedChunks]
    if (toEmbed.length > 0) {
      await this.embedChunks(toEmbed, onProgress)

      onProgress?.({ phase: 'indexing', processed: 0, total: toEmbed.length })
      await this.store.insert(toEmbed)
      onProgress?.({ phase: 'indexing', processed: toEmbed.length, total: toEmbed.length })
    }

    // Update content hashes
    for (const id of removedIds) {
      this.chunkHashes.delete(id)
    }
    for (const chunk of toEmbed) {
      this.chunkHashes.set(chunk.id, contentHash(chunk.content))
    }

    return {
      added: addedChunks.length + changedChunks.length,
      removed: removedIds.length,
      unchanged: unchangedIds.size,
    }
  }

  /**
   * Get the underlying vector store (for save/load operations).
   */
  getStore(): VectorStore {
    return this.store
  }

  // ── Private Helpers ──────────────────────────────────────────────

  /**
   * Embed chunks in batches with controlled concurrency.
   * Assigns embeddings back to the chunk objects in-place.
   */
  private async embedChunks(
    chunks: EmbeddingChunk[],
    onProgress?: (progress: VectorIndexProgress) => void,
  ): Promise<void> {
    const totalChunks = chunks.length
    let processedCount = 0

    onProgress?.({ phase: 'embedding', processed: 0, total: totalChunks })

    // Split into batches
    const batches: EmbeddingChunk[][] = []
    for (let i = 0; i < chunks.length; i += this.batchSize) {
      batches.push(chunks.slice(i, i + this.batchSize))
    }

    // Process batches with controlled concurrency
    for (let i = 0; i < batches.length; i += this.maxConcurrentBatches) {
      const concurrentBatches = batches.slice(i, i + this.maxConcurrentBatches)

      const results = await Promise.all(
        concurrentBatches.map(batch => {
          const texts = batch.map(c => c.content)
          return this.provider.embed(texts)
        }),
      )

      // Assign embeddings back to chunks
      for (let batchIdx = 0; batchIdx < concurrentBatches.length; batchIdx++) {
        const batch = concurrentBatches[batchIdx]
        const embeddings = results[batchIdx]
        for (let chunkIdx = 0; chunkIdx < batch.length; chunkIdx++) {
          batch[chunkIdx].embedding = embeddings[chunkIdx]
        }
        processedCount += batch.length
        onProgress?.({ phase: 'embedding', processed: processedCount, total: totalChunks })
      }
    }
  }
}
