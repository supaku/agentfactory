import type { DedupResult, MemoryEntry } from '../types.js'
import type { MemoryStore } from './memory-store.js'
import { xxhash64 } from './xxhash.js'
import { SimHash } from './simhash.js'

export interface DedupPipelineOptions {
  /** Hamming distance threshold for near-duplicate detection (default: 3). */
  simhashThreshold?: number
}

/**
 * Two-tier deduplication pipeline.
 * Tier 1: xxHash64 exact content matching.
 * Tier 2: SimHash fuzzy matching with configurable Hamming threshold.
 */
export class DedupPipeline {
  private memoryStore: MemoryStore
  private simhash: SimHash
  private threshold: number

  constructor(store: MemoryStore, options: DedupPipelineOptions = {}) {
    this.memoryStore = store
    this.simhash = new SimHash()
    this.threshold = options.simhashThreshold ?? 3
  }

  /** Normalize content for consistent hashing. */
  normalize(content: string): string {
    return content
      .replace(/\r\n/g, '\n')    // Normalize line endings
      .replace(/\t/g, '  ')       // Normalize tabs
      .replace(/ +$/gm, '')       // Strip trailing whitespace
      .trim()
  }

  /** Check content against existing memory for duplicates. */
  async check(content: string): Promise<DedupResult> {
    const normalized = this.normalize(content)
    const hash = await xxhash64(normalized)

    // Tier 1: exact match via xxHash64
    const exactMatch = await this.memoryStore.findByXxhash(hash)
    if (exactMatch) {
      return {
        isDuplicate: true,
        matchType: 'exact',
        existingId: exactMatch.id,
      }
    }

    // Tier 2: fuzzy match via SimHash
    const fingerprint = this.simhash.compute(normalized)
    const allEntries = await this.memoryStore.getAll()
    for (const entry of allEntries) {
      const distance = this.simhash.hammingDistance(fingerprint, entry.simhash)
      if (distance <= this.threshold) {
        return {
          isDuplicate: true,
          matchType: 'near',
          existingId: entry.id,
          hammingDistance: distance,
        }
      }
    }

    return {
      isDuplicate: false,
      matchType: 'none',
    }
  }

  /** Store new content, returning the created entry. */
  async storeContent(id: string, content: string, metadata?: Record<string, unknown>): Promise<MemoryEntry> {
    const normalized = this.normalize(content)
    const hash = await xxhash64(normalized)
    const fingerprint = this.simhash.compute(normalized)

    const entry: MemoryEntry = {
      id,
      content: normalized,
      xxhash: hash,
      simhash: fingerprint,
      createdAt: Date.now(),
      ...(metadata ? { metadata } : {}),
    }
    await this.memoryStore.put(entry)
    return entry
  }
}
