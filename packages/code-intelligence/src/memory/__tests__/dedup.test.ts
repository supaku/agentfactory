import { describe, it, expect, beforeEach } from 'vitest'
import { xxhash64 } from '../xxhash.js'
import { SimHash } from '../simhash.js'
import { InMemoryStore } from '../memory-store.js'
import { DedupPipeline } from '../dedup-pipeline.js'

describe('xxhash64', () => {
  it('produces consistent hashes for identical content', async () => {
    const hash1 = await xxhash64('hello world')
    const hash2 = await xxhash64('hello world')
    expect(hash1).toBe(hash2)
  })

  it('produces different hashes for different content', async () => {
    const hash1 = await xxhash64('hello world')
    const hash2 = await xxhash64('hello world!')
    expect(hash1).not.toBe(hash2)
  })

  it('returns a hex string', async () => {
    const hash = await xxhash64('test')
    expect(hash).toMatch(/^[0-9a-f]+$/i)
  })

  it('handles empty string', async () => {
    const hash = await xxhash64('')
    expect(typeof hash).toBe('string')
    expect(hash.length).toBeGreaterThan(0)
  })
})

describe('SimHash', () => {
  const simhash = new SimHash()

  it('produces identical fingerprint for identical text', () => {
    const fp1 = simhash.compute('the quick brown fox jumps over the lazy dog')
    const fp2 = simhash.compute('the quick brown fox jumps over the lazy dog')
    expect(fp1).toBe(fp2)
  })

  it('produces similar fingerprint for similar text', () => {
    const fp1 = simhash.compute('the quick brown fox jumps over the lazy dog')
    const fp2 = simhash.compute('the quick brown fox leaps over the lazy dog')
    const distance = simhash.hammingDistance(fp1, fp2)
    expect(distance).toBeLessThan(10)
  })

  it('produces different fingerprint for different text', () => {
    const fp1 = simhash.compute('the quick brown fox jumps over the lazy dog')
    const fp2 = simhash.compute('completely unrelated text about quantum physics and mathematics')
    const distance = simhash.hammingDistance(fp1, fp2)
    expect(distance).toBeGreaterThan(5)
  })

  it('computes hamming distance correctly', () => {
    expect(simhash.hammingDistance(0b1010n, 0b1001n)).toBe(2)
    expect(simhash.hammingDistance(0n, 0n)).toBe(0)
    expect(simhash.hammingDistance(0b1111n, 0b0000n)).toBe(4)
  })

  it('detects near-duplicates within threshold', () => {
    const fp1 = simhash.compute('hello world this is a test document for simhash')
    const fp2 = simhash.compute('hello world this is a test document for simhash!')
    expect(simhash.isNearDuplicate(fp1, fp2, 5)).toBe(true)
  })

  it('handles empty text', () => {
    const fp = simhash.compute('')
    expect(fp).toBe(0n)
  })
})

describe('InMemoryStore', () => {
  let store: InMemoryStore

  beforeEach(() => {
    store = new InMemoryStore()
  })

  it('stores and retrieves entries', async () => {
    const entry = {
      id: 'test-1',
      content: 'hello',
      xxhash: 'abc123',
      simhash: 42n,
      createdAt: Date.now(),
    }
    await store.put(entry)
    const retrieved = await store.get('test-1')
    expect(retrieved).toEqual(entry)
  })

  it('finds by xxhash', async () => {
    const entry = {
      id: 'test-1',
      content: 'hello',
      xxhash: 'abc123',
      simhash: 42n,
      createdAt: Date.now(),
    }
    await store.put(entry)
    const found = await store.findByXxhash('abc123')
    expect(found?.id).toBe('test-1')
  })

  it('returns undefined for missing entries', async () => {
    expect(await store.get('nonexistent')).toBeUndefined()
    expect(await store.findByXxhash('nonexistent')).toBeUndefined()
  })

  it('deletes entries', async () => {
    await store.put({
      id: 'test-1', content: 'hello', xxhash: 'abc', simhash: 0n, createdAt: Date.now(),
    })
    expect(await store.delete('test-1')).toBe(true)
    expect(await store.get('test-1')).toBeUndefined()
    expect(await store.delete('test-1')).toBe(false)
  })

  it('clears all entries', async () => {
    await store.put({ id: '1', content: 'a', xxhash: 'a', simhash: 0n, createdAt: Date.now() })
    await store.put({ id: '2', content: 'b', xxhash: 'b', simhash: 0n, createdAt: Date.now() })
    await store.clear()
    const all = await store.getAll()
    expect(all).toHaveLength(0)
  })

  it('lists all entries', async () => {
    await store.put({ id: '1', content: 'a', xxhash: 'a', simhash: 0n, createdAt: Date.now() })
    await store.put({ id: '2', content: 'b', xxhash: 'b', simhash: 0n, createdAt: Date.now() })
    const all = await store.getAll()
    expect(all).toHaveLength(2)
  })
})

describe('DedupPipeline', () => {
  let store: InMemoryStore
  let pipeline: DedupPipeline

  beforeEach(() => {
    store = new InMemoryStore()
    pipeline = new DedupPipeline(store)
  })

  it('normalizes content', () => {
    const normalized = pipeline.normalize('  hello\r\n  world\t\t  ')
    expect(normalized).toBe('hello\n  world')
  })

  it('detects no duplicate in empty store', async () => {
    const result = await pipeline.check('test content')
    expect(result.isDuplicate).toBe(false)
    expect(result.matchType).toBe('none')
  })

  it('detects exact duplicate', async () => {
    await pipeline.storeContent('entry-1', 'hello world test content')
    const result = await pipeline.check('hello world test content')
    expect(result.isDuplicate).toBe(true)
    expect(result.matchType).toBe('exact')
    expect(result.existingId).toBe('entry-1')
  })

  it('detects near-duplicate', async () => {
    // Use a wider threshold for near-duplicate detection in this test
    const widePipeline = new DedupPipeline(store, { simhashThreshold: 10 })
    await widePipeline.storeContent('entry-1', 'the quick brown fox jumps over the lazy dog and runs through the forest')
    const result = await widePipeline.check('the quick brown fox leaps over the lazy dog and runs through the forest')
    expect(result.isDuplicate).toBe(true)
    expect(['exact', 'near']).toContain(result.matchType)
  })

  it('does not match completely different content', async () => {
    await pipeline.storeContent('entry-1', 'the quick brown fox jumps over the lazy dog in the morning')
    const result = await pipeline.check('quantum physics explains particle behavior in accelerators')
    expect(result.isDuplicate).toBe(false)
    expect(result.matchType).toBe('none')
  })

  it('stores content with metadata', async () => {
    const entry = await pipeline.storeContent('test-1', 'sample content here', { source: 'test' })
    expect(entry.id).toBe('test-1')
    expect(entry.xxhash).toBeTruthy()
    expect(typeof entry.simhash).toBe('bigint')
    expect(entry.metadata).toEqual({ source: 'test' })
  })

  it('handles whitespace normalization for dedup', async () => {
    await pipeline.storeContent('entry-1', 'hello   world')
    // Same content after normalization
    const result = await pipeline.check('hello   world')
    expect(result.isDuplicate).toBe(true)
    expect(result.matchType).toBe('exact')
  })

  it('treats line ending variations as same content', async () => {
    await pipeline.storeContent('entry-1', 'hello\nworld')
    const result = await pipeline.check('hello\r\nworld')
    expect(result.isDuplicate).toBe(true)
    expect(result.matchType).toBe('exact')
  })
})
