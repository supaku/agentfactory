import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryVectorStore } from '../hnsw-store.js'
import type { EmbeddingChunk } from '../../types.js'

// ── Helpers ──────────────────────────────────────────────────────────

function makeChunk(id: string, embedding: number[]): EmbeddingChunk {
  return {
    id,
    content: `content for ${id}`,
    embedding,
    metadata: {
      filePath: `src/${id}.ts`,
      symbolName: id,
      symbolKind: 'function',
      startLine: 0,
      endLine: 10,
      language: 'typescript',
    },
  }
}

/** Generate a random unit vector of given dimensions. */
function randomVector(dims: number): number[] {
  const v = Array.from({ length: dims }, () => Math.random() - 0.5)
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0))
  return v.map(x => x / norm)
}

/** Normalize a vector to unit length. */
function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0))
  if (norm === 0) return v
  return v.map(x => x / norm)
}

/** Cosine similarity between two vectors. */
function cosine(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

// ── Tests ────────────────────────────────────────────────────────────

describe('InMemoryVectorStore', () => {
  let store: InMemoryVectorStore

  beforeEach(() => {
    store = new InMemoryVectorStore()
  })

  describe('empty store', () => {
    it('returns empty array for search on empty store', async () => {
      const results = await store.search([1, 0, 0], 5)
      expect(results).toEqual([])
    })

    it('has size 0', () => {
      expect(store.size()).toBe(0)
    })
  })

  describe('insert and search (brute-force)', () => {
    it('inserts and retrieves basic vectors', async () => {
      const chunks = [
        makeChunk('a', [1, 0, 0]),
        makeChunk('b', [0, 1, 0]),
        makeChunk('c', [0, 0, 1]),
      ]
      await store.insert(chunks)
      expect(store.size()).toBe(3)

      const results = await store.search([1, 0, 0], 3)
      expect(results).toHaveLength(3)
      expect(results[0].chunk.id).toBe('a')
      expect(results[0].score).toBeCloseTo(1.0, 5)
    })

    it('respects topK limit', async () => {
      const chunks = Array.from({ length: 10 }, (_, i) =>
        makeChunk(`v${i}`, randomVector(8))
      )
      await store.insert(chunks)

      const results = await store.search(randomVector(8), 3)
      expect(results).toHaveLength(3)
    })

    it('skips chunks without embeddings', async () => {
      const withEmbedding = makeChunk('a', [1, 0, 0])
      const withoutEmbedding: EmbeddingChunk = {
        id: 'b',
        content: 'no embedding',
        metadata: {
          filePath: 'src/b.ts',
          startLine: 0,
          endLine: 5,
          language: 'typescript',
        },
      }
      await store.insert([withEmbedding, withoutEmbedding])
      expect(store.size()).toBe(1)
    })
  })

  describe('cosine similarity correctness', () => {
    it('identical vectors have similarity 1', async () => {
      const v = normalize([3, 4, 0])
      await store.insert([makeChunk('a', v)])
      const results = await store.search(v, 1)
      expect(results[0].score).toBeCloseTo(1.0, 5)
    })

    it('orthogonal vectors have similarity 0', async () => {
      await store.insert([
        makeChunk('x', [1, 0, 0]),
        makeChunk('y', [0, 1, 0]),
      ])
      const results = await store.search([1, 0, 0], 2)
      const yResult = results.find(r => r.chunk.id === 'y')
      expect(yResult!.score).toBeCloseTo(0.0, 5)
    })

    it('opposite vectors have similarity -1', async () => {
      await store.insert([makeChunk('neg', [-1, 0, 0])])
      const results = await store.search([1, 0, 0], 1)
      expect(results[0].score).toBeCloseTo(-1.0, 5)
    })

    it('scores match manual cosine computation', async () => {
      const a = [1, 2, 3]
      const b = [4, 5, 6]
      await store.insert([makeChunk('b', b)])
      const results = await store.search(a, 1)
      expect(results[0].score).toBeCloseTo(cosine(a, b), 5)
    })
  })

  describe('delete', () => {
    it('removes chunks so they do not appear in search', async () => {
      await store.insert([
        makeChunk('a', [1, 0, 0]),
        makeChunk('b', [0, 1, 0]),
        makeChunk('c', [0, 0, 1]),
      ])
      await store.delete(['b'])
      expect(store.size()).toBe(2)

      const results = await store.search([0, 1, 0], 3)
      const ids = results.map(r => r.chunk.id)
      expect(ids).not.toContain('b')
    })

    it('handles deleting non-existent ids gracefully', async () => {
      await store.insert([makeChunk('a', [1, 0, 0])])
      await store.delete(['nonexistent'])
      expect(store.size()).toBe(1)
    })
  })

  describe('clear', () => {
    it('empties the store completely', async () => {
      await store.insert([
        makeChunk('a', [1, 0, 0]),
        makeChunk('b', [0, 1, 0]),
      ])
      expect(store.size()).toBe(2)

      await store.clear()
      expect(store.size()).toBe(0)

      const results = await store.search([1, 0, 0], 5)
      expect(results).toEqual([])
    })
  })

  describe('HNSW promotion', () => {
    it('activates HNSW when threshold is exceeded', async () => {
      store.setHNSWThreshold(50)
      expect(store.isHNSWActive).toBe(false)

      const chunks = Array.from({ length: 60 }, (_, i) =>
        makeChunk(`v${i}`, randomVector(16))
      )
      await store.insert(chunks)
      expect(store.isHNSWActive).toBe(true)
      expect(store.size()).toBe(60)
    })

    it('returns correct results after HNSW promotion', async () => {
      store.setHNSWThreshold(50)

      // Create a distinguishable target vector
      const dims = 16
      const target = Array(dims).fill(0)
      target[0] = 1.0 // Points strongly in dimension 0

      const chunks: EmbeddingChunk[] = [makeChunk('target', normalize(target))]

      // Fill with random vectors
      for (let i = 0; i < 59; i++) {
        chunks.push(makeChunk(`rand${i}`, randomVector(dims)))
      }
      await store.insert(chunks)
      expect(store.isHNSWActive).toBe(true)

      // Search for the target direction
      const query = [...target]
      const results = await store.search(query, 5)
      expect(results.length).toBeGreaterThan(0)
      // The target chunk should be among top results (HNSW is approximate, but with
      // such a distinctive vector it should find it)
      const topIds = results.map(r => r.chunk.id)
      expect(topIds).toContain('target')
    })

    it('delete works after HNSW promotion', async () => {
      store.setHNSWThreshold(50)

      const chunks = Array.from({ length: 55 }, (_, i) =>
        makeChunk(`v${i}`, randomVector(8))
      )
      await store.insert(chunks)
      expect(store.isHNSWActive).toBe(true)

      await store.delete(['v0', 'v1', 'v2'])
      expect(store.size()).toBe(52)

      const results = await store.search(randomVector(8), 55)
      const ids = results.map(r => r.chunk.id)
      expect(ids).not.toContain('v0')
      expect(ids).not.toContain('v1')
      expect(ids).not.toContain('v2')
    })
  })

  describe('persistence (save/load)', () => {
    let tempDir: string

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'vector-store-test-'))
    })

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true })
    })

    it('saves and loads, preserving data', async () => {
      await store.insert([
        makeChunk('a', [1, 0, 0]),
        makeChunk('b', [0, 1, 0]),
        makeChunk('c', [0, 0, 1]),
      ])

      await store.save(tempDir)

      const loaded = new InMemoryVectorStore()
      await loaded.load(tempDir)

      expect(loaded.size()).toBe(3)

      const results = await loaded.search([1, 0, 0], 3)
      expect(results).toHaveLength(3)
      expect(results[0].chunk.id).toBe('a')
      expect(results[0].score).toBeCloseTo(1.0, 5)
    })

    it('saves and loads HNSW index', async () => {
      store.setHNSWThreshold(50)

      const dims = 8
      const chunks = Array.from({ length: 55 }, (_, i) =>
        makeChunk(`v${i}`, randomVector(dims))
      )
      // Make one very distinct chunk
      const distinctVec = Array(dims).fill(0)
      distinctVec[0] = 1.0
      chunks.push(makeChunk('distinct', normalize(distinctVec)))

      await store.insert(chunks)
      expect(store.isHNSWActive).toBe(true)

      await store.save(tempDir)

      const loaded = new InMemoryVectorStore()
      loaded.setHNSWThreshold(50)
      await loaded.load(tempDir)

      expect(loaded.size()).toBe(56)

      const results = await loaded.search(distinctVec, 5)
      const topIds = results.map(r => r.chunk.id)
      expect(topIds).toContain('distinct')
    })
  })

  describe('index invalidation', () => {
    let tempDir: string

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'vector-store-invalid-'))
    })

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true })
    })

    it('rejects loading when model config hash mismatches', async () => {
      const storeV1 = new InMemoryVectorStore({ modelConfigHash: 'hash-v1' })
      await storeV1.insert([makeChunk('a', [1, 0, 0])])
      await storeV1.save(tempDir)

      const storeV2 = new InMemoryVectorStore({ modelConfigHash: 'hash-v2' })
      await expect(storeV2.load(tempDir)).rejects.toThrow(/model config hash mismatch/)
    })

    it('loads successfully when model config hash matches', async () => {
      const storeV1 = new InMemoryVectorStore({ modelConfigHash: 'hash-v1' })
      await storeV1.insert([makeChunk('a', [1, 0, 0])])
      await storeV1.save(tempDir)

      const storeV1Copy = new InMemoryVectorStore({ modelConfigHash: 'hash-v1' })
      await storeV1Copy.load(tempDir)
      expect(storeV1Copy.size()).toBe(1)
    })

    it('loads successfully when no hash is configured on loader', async () => {
      const storeV1 = new InMemoryVectorStore({ modelConfigHash: 'hash-v1' })
      await storeV1.insert([makeChunk('a', [1, 0, 0])])
      await storeV1.save(tempDir)

      const noHash = new InMemoryVectorStore()
      await noHash.load(tempDir)
      expect(noHash.size()).toBe(1)
    })
  })
})
