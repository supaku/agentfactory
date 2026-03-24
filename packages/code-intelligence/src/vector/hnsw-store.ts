import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EmbeddingChunk } from '../types.js'
import type { VectorStore, VectorSearchResult } from './vector-store.js'

// ── HNSW Configuration ──────────────────────────────────────────────

export interface HNSWStoreOptions {
  M?: number               // Max connections per layer, default 16
  efConstruction?: number  // Build quality, default 200
  efSearch?: number        // Query quality, default 100
  modelConfigHash?: string // For invalidation
}

// ── Persistence Metadata ────────────────────────────────────────────

interface IndexMeta {
  model: string
  dimensions: number
  chunkCount: number
  createdAt: number
  modelConfigHash: string
}

// ── HNSW Node ───────────────────────────────────────────────────────

interface HNSWNode {
  id: string
  chunk: EmbeddingChunk
  vector: number[]
  level: number
  neighbors: Map<string, number>[]  // One adjacency map per level, id -> unused (could be distance)
}

// ── Serialized Formats ──────────────────────────────────────────────

interface SerializedNode {
  id: string
  chunk: EmbeddingChunk
  vector: number[]
  level: number
  neighbors: string[][]  // neighbors[layer] = array of neighbor ids
}

interface SerializedIndex {
  entryPointId: string | null
  maxLevel: number
  nodes: SerializedNode[]
}

// ── Cosine Similarity ───────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  if (denom === 0) return 0
  return dot / denom
}

// ── HNSW Threshold ──────────────────────────────────────────────────

/** Minimum chunk count to trigger HNSW graph construction. Below this, brute-force is used. */
const DEFAULT_HNSW_THRESHOLD = 1000

// ── InMemoryVectorStore ─────────────────────────────────────────────

export class InMemoryVectorStore implements VectorStore {
  private readonly M: number
  private readonly efConstruction: number
  private readonly efSearch: number
  private readonly modelConfigHash: string
  private hnswThreshold: number

  // Flat storage — always maintained
  private chunks: Map<string, EmbeddingChunk> = new Map()
  private vectors: Map<string, number[]> = new Map()

  // HNSW graph — built when size >= threshold
  private nodes: Map<string, HNSWNode> = new Map()
  private entryPoint: HNSWNode | null = null
  private maxLevel = 0
  private hnswBuilt = false

  constructor(options: HNSWStoreOptions = {}) {
    this.M = options.M ?? 16
    this.efConstruction = options.efConstruction ?? 200
    this.efSearch = options.efSearch ?? 100
    this.modelConfigHash = options.modelConfigHash ?? ''
    this.hnswThreshold = DEFAULT_HNSW_THRESHOLD
  }

  /**
   * Override the HNSW promotion threshold (useful for testing).
   */
  setHNSWThreshold(n: number): void {
    this.hnswThreshold = n
  }

  // ── VectorStore interface ───────────────────────────────────────

  async insert(chunks: EmbeddingChunk[]): Promise<void> {
    for (const chunk of chunks) {
      if (!chunk.embedding || chunk.embedding.length === 0) continue
      this.chunks.set(chunk.id, chunk)
      this.vectors.set(chunk.id, chunk.embedding)
    }

    // Check if we should build / update the HNSW graph
    if (this.chunks.size >= this.hnswThreshold && !this.hnswBuilt) {
      this.buildHNSW()
    } else if (this.hnswBuilt) {
      // Incrementally add new chunks to existing graph
      for (const chunk of chunks) {
        if (!chunk.embedding || chunk.embedding.length === 0) continue
        if (!this.nodes.has(chunk.id)) {
          this.hnswInsert(chunk.id, chunk, chunk.embedding)
        }
      }
    }
  }

  async search(query: number[], topK: number): Promise<VectorSearchResult[]> {
    if (this.chunks.size === 0) return []

    if (this.hnswBuilt) {
      return this.hnswSearch(query, topK)
    }
    return this.bruteForceSearch(query, topK)
  }

  async delete(ids: string[]): Promise<void> {
    for (const id of ids) {
      this.chunks.delete(id)
      this.vectors.delete(id)
      if (this.hnswBuilt) {
        this.hnswRemove(id)
      }
    }
  }

  size(): number {
    return this.chunks.size
  }

  async save(dirPath: string): Promise<void> {
    await mkdir(dirPath, { recursive: true })

    const meta: IndexMeta = {
      model: 'in-memory',
      dimensions: this.getFirstDimensions(),
      chunkCount: this.chunks.size,
      createdAt: Date.now(),
      modelConfigHash: this.modelConfigHash,
    }

    const index = this.serializeIndex()

    await writeFile(join(dirPath, 'meta.json'), JSON.stringify(meta, null, 2))
    await writeFile(join(dirPath, 'index.json'), JSON.stringify(index))
  }

  async load(dirPath: string): Promise<void> {
    const metaRaw = await readFile(join(dirPath, 'meta.json'), 'utf-8')
    const meta: IndexMeta = JSON.parse(metaRaw)

    // Validate model config hash
    if (this.modelConfigHash && meta.modelConfigHash && meta.modelConfigHash !== this.modelConfigHash) {
      throw new Error(
        `Index model config hash mismatch: stored="${meta.modelConfigHash}" current="${this.modelConfigHash}"`
      )
    }

    const indexRaw = await readFile(join(dirPath, 'index.json'), 'utf-8')
    const index: SerializedIndex = JSON.parse(indexRaw)

    this.deserializeIndex(index)
  }

  async clear(): Promise<void> {
    this.chunks.clear()
    this.vectors.clear()
    this.nodes.clear()
    this.entryPoint = null
    this.maxLevel = 0
    this.hnswBuilt = false
  }

  // ── Query whether the HNSW graph is active (for testing) ──────

  get isHNSWActive(): boolean {
    return this.hnswBuilt
  }

  // ── Brute-force search ────────────────────────────────────────

  private bruteForceSearch(query: number[], topK: number): VectorSearchResult[] {
    const results: VectorSearchResult[] = []

    for (const [id, vector] of this.vectors) {
      const score = cosineSimilarity(query, vector)
      const chunk = this.chunks.get(id)!
      results.push({ chunk, score })
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, topK)
  }

  // ── HNSW: Build from scratch ──────────────────────────────────

  private buildHNSW(): void {
    this.nodes.clear()
    this.entryPoint = null
    this.maxLevel = 0

    for (const [id, vector] of this.vectors) {
      const chunk = this.chunks.get(id)!
      this.hnswInsert(id, chunk, vector)
    }
    this.hnswBuilt = true
  }

  // ── HNSW: Random level assignment ─────────────────────────────

  private randomLevel(): number {
    // Level = floor(-ln(uniform) * mL), where mL = 1/ln(M)
    const mL = 1 / Math.log(this.M)
    return Math.floor(-Math.log(Math.random()) * mL)
  }

  // ── HNSW: Insert a single element ────────────────────────────

  private hnswInsert(id: string, chunk: EmbeddingChunk, vector: number[]): void {
    const level = this.randomLevel()
    const node: HNSWNode = {
      id,
      chunk,
      vector,
      level,
      neighbors: [],
    }
    for (let l = 0; l <= level; l++) {
      node.neighbors.push(new Map())
    }
    this.nodes.set(id, node)

    if (!this.entryPoint) {
      this.entryPoint = node
      this.maxLevel = level
      return
    }

    let currentNode = this.entryPoint

    // Traverse from top to node's level+1 — greedy single-hop
    for (let l = this.maxLevel; l > level; l--) {
      currentNode = this.greedyClosest(currentNode, vector, l)
    }

    // For each layer from min(level, maxLevel) down to 0, do ef-search and connect
    const topInsertLevel = Math.min(level, this.maxLevel)
    for (let l = topInsertLevel; l >= 0; l--) {
      const candidates = this.searchLayer(currentNode, vector, this.efConstruction, l)
      const neighbors = this.selectNeighbors(candidates, this.M)

      for (const [neighborId, score] of neighbors) {
        const neighbor = this.nodes.get(neighborId)!
        // Connect bidirectionally
        node.neighbors[l].set(neighborId, score)
        if (l < neighbor.neighbors.length) {
          neighbor.neighbors[l].set(id, score)
          // Prune neighbor's connections if needed
          if (neighbor.neighbors[l].size > this.M) {
            this.pruneConnections(neighbor, l)
          }
        }
      }

      // Move currentNode to the closest found for next layer
      if (candidates.length > 0) {
        currentNode = this.nodes.get(candidates[0][0])!
      }
    }

    // Update entry point if new node has higher level
    if (level > this.maxLevel) {
      this.entryPoint = node
      this.maxLevel = level
    }
  }

  // ── HNSW: Remove an element ───────────────────────────────────

  private hnswRemove(id: string): void {
    const node = this.nodes.get(id)
    if (!node) return

    // Remove all bidirectional edges
    for (let l = 0; l < node.neighbors.length; l++) {
      for (const neighborId of node.neighbors[l].keys()) {
        const neighbor = this.nodes.get(neighborId)
        if (neighbor && l < neighbor.neighbors.length) {
          neighbor.neighbors[l].delete(id)
        }
      }
    }

    this.nodes.delete(id)

    // If this was the entry point, pick a new one
    if (this.entryPoint?.id === id) {
      if (this.nodes.size === 0) {
        this.entryPoint = null
        this.maxLevel = 0
        this.hnswBuilt = false
      } else {
        // Find node with highest level
        let best: HNSWNode | null = null
        for (const n of this.nodes.values()) {
          if (!best || n.level > best.level) best = n
        }
        this.entryPoint = best
        this.maxLevel = best?.level ?? 0
      }
    }
  }

  // ── HNSW: Search ──────────────────────────────────────────────

  private hnswSearch(query: number[], topK: number): VectorSearchResult[] {
    if (!this.entryPoint) return []

    let currentNode = this.entryPoint

    // Greedy descent from top layer to layer 1
    for (let l = this.maxLevel; l > 0; l--) {
      currentNode = this.greedyClosest(currentNode, query, l)
    }

    // ef-search at layer 0
    const candidates = this.searchLayer(currentNode, query, Math.max(this.efSearch, topK), 0)

    const results: VectorSearchResult[] = candidates
      .slice(0, topK)
      .map(([id, score]) => ({
        chunk: this.chunks.get(id)!,
        score,
      }))

    return results
  }

  // ── HNSW: Greedy closest at a layer ───────────────────────────

  private greedyClosest(start: HNSWNode, query: number[], layer: number): HNSWNode {
    let current = start
    let bestSim = cosineSimilarity(query, current.vector)

    let improved = true
    while (improved) {
      improved = false
      if (layer >= current.neighbors.length) break
      for (const neighborId of current.neighbors[layer].keys()) {
        const neighbor = this.nodes.get(neighborId)
        if (!neighbor) continue
        const sim = cosineSimilarity(query, neighbor.vector)
        if (sim > bestSim) {
          bestSim = sim
          current = neighbor
          improved = true
        }
      }
    }
    return current
  }

  // ── HNSW: ef-bounded search at a single layer ────────────────

  private searchLayer(
    entryNode: HNSWNode,
    query: number[],
    ef: number,
    layer: number,
  ): [string, number][] {
    const visited = new Set<string>()
    const candidates: [string, number][] = [] // [id, similarity]
    const results: [string, number][] = []    // [id, similarity]

    const entrySim = cosineSimilarity(query, entryNode.vector)
    candidates.push([entryNode.id, entrySim])
    results.push([entryNode.id, entrySim])
    visited.add(entryNode.id)

    while (candidates.length > 0) {
      // Pick the best candidate (highest similarity)
      candidates.sort((a, b) => b[1] - a[1])
      const [currentId, currentSim] = candidates.shift()!

      // Get the worst result
      results.sort((a, b) => b[1] - a[1])
      const worstResult = results[results.length - 1][1]

      // If current candidate is worse than worst result and we have enough results, stop
      if (currentSim < worstResult && results.length >= ef) break

      const currentNode = this.nodes.get(currentId)
      if (!currentNode || layer >= currentNode.neighbors.length) continue

      for (const neighborId of currentNode.neighbors[layer].keys()) {
        if (visited.has(neighborId)) continue
        visited.add(neighborId)

        const neighbor = this.nodes.get(neighborId)
        if (!neighbor) continue

        const sim = cosineSimilarity(query, neighbor.vector)

        results.sort((a, b) => b[1] - a[1])
        const currentWorst = results[results.length - 1][1]

        if (results.length < ef || sim > currentWorst) {
          candidates.push([neighborId, sim])
          results.push([neighborId, sim])

          if (results.length > ef) {
            results.sort((a, b) => b[1] - a[1])
            results.pop()
          }
        }
      }
    }

    results.sort((a, b) => b[1] - a[1])
    return results
  }

  // ── HNSW: Select best neighbors ──────────────────────────────

  private selectNeighbors(
    candidates: [string, number][],
    maxNeighbors: number,
  ): [string, number][] {
    // Simple: just take the top-M by similarity
    const sorted = [...candidates].sort((a, b) => b[1] - a[1])
    return sorted.slice(0, maxNeighbors)
  }

  // ── HNSW: Prune overloaded connections ────────────────────────

  private pruneConnections(node: HNSWNode, layer: number): void {
    const neighbors = Array.from(node.neighbors[layer].entries())
      .map(([id]) => {
        const n = this.nodes.get(id)
        if (!n) return null
        const sim = cosineSimilarity(node.vector, n.vector)
        return [id, sim] as [string, number]
      })
      .filter((x): x is [string, number] => x !== null)

    neighbors.sort((a, b) => b[1] - a[1])
    const kept = neighbors.slice(0, this.M)

    node.neighbors[layer].clear()
    for (const [id, sim] of kept) {
      node.neighbors[layer].set(id, sim)
    }
  }

  // ── Serialization ─────────────────────────────────────────────

  private serializeIndex(): SerializedIndex {
    const serializedNodes: SerializedNode[] = []
    for (const node of this.nodes.values()) {
      const neighbors: string[][] = []
      for (let l = 0; l < node.neighbors.length; l++) {
        neighbors.push(Array.from(node.neighbors[l].keys()))
      }
      serializedNodes.push({
        id: node.id,
        chunk: node.chunk,
        vector: node.vector,
        level: node.level,
        neighbors,
      })
    }

    // If HNSW is not built, serialize from flat storage
    if (!this.hnswBuilt && this.chunks.size > 0) {
      for (const [id, chunk] of this.chunks) {
        const vector = this.vectors.get(id)
        if (!vector) continue
        serializedNodes.push({
          id,
          chunk,
          vector,
          level: 0,
          neighbors: [[]],
        })
      }
    }

    return {
      entryPointId: this.entryPoint?.id ?? null,
      maxLevel: this.maxLevel,
      nodes: serializedNodes,
    }
  }

  private deserializeIndex(index: SerializedIndex): void {
    this.chunks.clear()
    this.vectors.clear()
    this.nodes.clear()
    this.entryPoint = null
    this.maxLevel = index.maxLevel

    // First pass: create all nodes without neighbors
    for (const sn of index.nodes) {
      this.chunks.set(sn.id, sn.chunk)
      this.vectors.set(sn.id, sn.vector)

      const node: HNSWNode = {
        id: sn.id,
        chunk: sn.chunk,
        vector: sn.vector,
        level: sn.level,
        neighbors: [],
      }
      for (let l = 0; l <= sn.level; l++) {
        node.neighbors.push(new Map())
      }
      this.nodes.set(sn.id, node)
    }

    // Second pass: wire up neighbor connections
    for (const sn of index.nodes) {
      const node = this.nodes.get(sn.id)!
      for (let l = 0; l < sn.neighbors.length; l++) {
        for (const neighborId of sn.neighbors[l]) {
          if (this.nodes.has(neighborId)) {
            node.neighbors[l].set(neighborId, 0)
          }
        }
      }
    }

    // Set entry point
    if (index.entryPointId && this.nodes.has(index.entryPointId)) {
      this.entryPoint = this.nodes.get(index.entryPointId)!
    }

    // Mark HNSW as built if we have enough nodes
    this.hnswBuilt = this.nodes.size >= this.hnswThreshold
  }

  // ── Helpers ───────────────────────────────────────────────────

  private getFirstDimensions(): number {
    for (const vector of this.vectors.values()) {
      return vector.length
    }
    return 0
  }
}
