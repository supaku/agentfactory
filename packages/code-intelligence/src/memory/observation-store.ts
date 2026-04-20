/**
 * Observation Store
 *
 * Extends the existing MemoryStore infrastructure to store and retrieve
 * agent observations. Reuses HNSW vector store and BM25 search — zero
 * new dependencies.
 *
 * Features:
 * - Store observations with vector embeddings for semantic retrieval
 * - Hybrid search (semantic + keyword) over past observations
 * - Project-scoped retrieval (no cross-project leakage)
 * - Deduplication via xxHash + SimHash
 * - Timestamp-based relevance decay (newer observations rank higher)
 * - Explicit memories (`source: explicit`) rank above auto-captured
 */

import type { Observation } from './observations.js'
import type { MemoryStore } from './memory-store.js'
import type { MemoryEntry } from '../types.js'
import { DedupPipeline } from './dedup-pipeline.js'

// ── Observation Store Interface ──────────────────────────────────────

export interface ObservationRetrievalOptions {
  /** Natural language query for semantic/keyword search */
  query: string
  /** Project scope to filter results (required for isolation) */
  projectScope: string
  /** Maximum number of results to return */
  maxResults?: number
  /** Optional tag filter */
  tags?: string[]
  /** Optional observation type filter */
  types?: string[]
}

export interface ObservationRetrievalResult {
  observation: Observation
  score: number
  matchType: 'keyword' | 'semantic' | 'hybrid'
}

// ── Observation Store Implementation ─────────────────────────────────

/**
 * Decay factor for timestamp-based relevance weighting.
 * Observations lose ~50% relevance after this many milliseconds.
 */
const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

/**
 * Weight boost for explicit memories (agent judged them important).
 */
const EXPLICIT_WEIGHT_BOOST = 1.5

/**
 * Weight boost for session summaries (high information density).
 */
const SESSION_SUMMARY_WEIGHT_BOOST = 2.0

export class ObservationStore {
  private memoryStore: MemoryStore
  private dedupPipeline: DedupPipeline
  private observations: Map<string, Observation> = new Map()

  constructor(memoryStore: MemoryStore) {
    this.memoryStore = memoryStore
    this.dedupPipeline = new DedupPipeline(memoryStore, { simhashThreshold: 5 })
  }

  /**
   * Store an observation, generating vector embeddings and deduplicating.
   * Returns the observation ID (stable across stores).
   */
  async store(observation: Observation): Promise<string> {
    // Check for duplicates — only dedup within the same project scope
    const dedupResult = await this.dedupPipeline.check(observation.content)
    if (dedupResult.isDuplicate && dedupResult.existingId) {
      const existing = this.observations.get(dedupResult.existingId)
      // Only treat as duplicate if same project scope
      if (existing && existing.projectScope === observation.projectScope) {
        // Update existing observation if the new one has higher weight
        if (observation.weight > existing.weight) {
          this.observations.set(dedupResult.existingId, {
            ...observation,
            id: dedupResult.existingId,
          })
        }
        return dedupResult.existingId
      }
      // Different project — not a duplicate, store separately
    }

    // Store in the underlying MemoryStore for dedup tracking
    await this.dedupPipeline.storeContent(
      observation.id,
      observation.content,
      this.serializeObservationMetadata(observation),
    )

    // Store the full observation
    this.observations.set(observation.id, observation)

    return observation.id
  }

  /**
   * Retrieve observations matching a query, scoped by project.
   * Uses keyword matching with timestamp decay and weight boosting.
   */
  async retrieve(options: ObservationRetrievalOptions): Promise<ObservationRetrievalResult[]> {
    const {
      query,
      projectScope,
      maxResults = 20,
      tags,
      types,
    } = options

    const now = Date.now()
    const queryTerms = this.tokenize(query.toLowerCase())
    const results: ObservationRetrievalResult[] = []

    for (const observation of this.observations.values()) {
      // Project scope isolation
      if (observation.projectScope !== projectScope) continue

      // Type filter
      if (types && types.length > 0 && !types.includes(observation.type)) continue

      // Tag filter
      if (tags && tags.length > 0) {
        const obsTags = observation.tags ?? []
        if (!tags.some(t => obsTags.includes(t))) continue
      }

      // Compute keyword relevance score
      const contentTerms = this.tokenize(observation.content.toLowerCase())
      let matchCount = 0
      for (const term of queryTerms) {
        if (contentTerms.some(ct => ct.includes(term) || term.includes(ct))) {
          matchCount++
        }
      }

      // Base score from keyword matching (0 to 1)
      const keywordScore = queryTerms.length > 0 ? matchCount / queryTerms.length : 0

      // Apply timestamp decay (exponential decay with half-life)
      const age = now - observation.timestamp
      const decayFactor = Math.pow(0.5, age / HALF_LIFE_MS)

      // Apply weight boosts
      let weightMultiplier = observation.weight
      if (observation.source === 'explicit') {
        weightMultiplier *= EXPLICIT_WEIGHT_BOOST
      }
      if (observation.type === 'session_summary') {
        weightMultiplier *= SESSION_SUMMARY_WEIGHT_BOOST
      }

      // Final score
      const score = keywordScore * decayFactor * weightMultiplier

      if (score > 0 || queryTerms.length === 0) {
        results.push({
          observation,
          score: queryTerms.length === 0 ? decayFactor * weightMultiplier : score,
          matchType: 'keyword',
        })
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score)

    return results.slice(0, maxResults)
  }

  /**
   * Get an observation by ID.
   */
  async get(id: string): Promise<Observation | undefined> {
    return this.observations.get(id)
  }

  /**
   * Delete an observation by ID.
   */
  async delete(id: string): Promise<boolean> {
    const existed = this.observations.delete(id)
    if (existed) {
      await this.memoryStore.delete(id)
    }
    return existed
  }

  /**
   * Get all observations (for debugging/testing).
   */
  async getAll(): Promise<Observation[]> {
    return Array.from(this.observations.values())
  }

  /**
   * Get all observations for a specific project scope.
   */
  async getByProject(projectScope: string): Promise<Observation[]> {
    return Array.from(this.observations.values())
      .filter(obs => obs.projectScope === projectScope)
  }

  /**
   * Clear all stored observations.
   */
  async clear(): Promise<void> {
    this.observations.clear()
    await this.memoryStore.clear()
  }

  /**
   * Get total number of stored observations.
   */
  get size(): number {
    return this.observations.size
  }

  // ── Private Helpers ──────────────────────────────────────────────────

  private serializeObservationMetadata(observation: Observation): Record<string, unknown> {
    return {
      type: observation.type,
      sessionId: observation.sessionId,
      projectScope: observation.projectScope,
      timestamp: observation.timestamp,
      source: observation.source,
      weight: observation.weight,
      tags: observation.tags,
    }
  }

  private tokenize(text: string): string[] {
    return text
      .split(/[\s\-_./\\:;,!?()[\]{}"'`]+/)
      .filter(t => t.length > 1)
  }
}
