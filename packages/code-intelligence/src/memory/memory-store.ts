import type { MemoryEntry, DedupResult } from '../types.js'

/** Interface for persistent memory storage. */
export interface MemoryStore {
  get(id: string): Promise<MemoryEntry | undefined>
  put(entry: MemoryEntry): Promise<void>
  findByXxhash(hash: string): Promise<MemoryEntry | undefined>
  getAll(): Promise<MemoryEntry[]>
  delete(id: string): Promise<boolean>
  clear(): Promise<void>
}

/** In-memory implementation of MemoryStore for testing and lightweight use. */
export class InMemoryStore implements MemoryStore {
  private entries: Map<string, MemoryEntry> = new Map()
  private xxhashIndex: Map<string, string> = new Map() // xxhash -> id

  async get(id: string): Promise<MemoryEntry | undefined> {
    return this.entries.get(id)
  }

  async put(entry: MemoryEntry): Promise<void> {
    this.entries.set(entry.id, entry)
    this.xxhashIndex.set(entry.xxhash, entry.id)
  }

  async findByXxhash(hash: string): Promise<MemoryEntry | undefined> {
    const id = this.xxhashIndex.get(hash)
    if (!id) return undefined
    return this.entries.get(id)
  }

  async getAll(): Promise<MemoryEntry[]> {
    return Array.from(this.entries.values())
  }

  async delete(id: string): Promise<boolean> {
    const entry = this.entries.get(id)
    if (!entry) return false
    this.xxhashIndex.delete(entry.xxhash)
    return this.entries.delete(id)
  }

  async clear(): Promise<void> {
    this.entries.clear()
    this.xxhashIndex.clear()
  }
}
