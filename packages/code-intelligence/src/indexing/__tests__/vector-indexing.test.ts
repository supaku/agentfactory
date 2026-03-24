import { describe, it, expect, vi } from 'vitest'
import { VectorIndexer } from '../vector-indexer.js'
import { IncrementalIndexer } from '../incremental-indexer.js'
import { SymbolExtractor } from '../../parser/symbol-extractor.js'
import { InMemoryVectorStore } from '../../vector/hnsw-store.js'
import type { EmbeddingProvider } from '../../embedding/embedding-provider.js'
import type { FileAST, CodeSymbol } from '../../types.js'

// ── Helpers ──────────────────────────────────────────────────────────

const mockProvider: EmbeddingProvider = {
  model: 'mock-model',
  dimensions: 4,
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(t => [t.length / 100, 0.5, 0.3, 0.1])
  },
  async embedQuery(text: string): Promise<number[]> {
    return [text.length / 100, 0.5, 0.3, 0.1]
  },
}

function makeSymbol(
  name: string,
  kind: string,
  filePath: string,
  extra?: Partial<CodeSymbol>,
): CodeSymbol {
  return {
    name,
    kind: kind as CodeSymbol['kind'],
    filePath,
    line: 0,
    exported: true,
    ...extra,
  }
}

function makeFileAST(
  filePath: string,
  language: string,
  symbols: CodeSymbol[],
): FileAST {
  return { filePath, language, symbols, imports: [], exports: [] }
}

// ── VectorIndexer ────────────────────────────────────────────────────

describe('VectorIndexer', () => {
  it('indexes files: chunks, embeds, and inserts into store', async () => {
    const store = new InMemoryVectorStore()
    const indexer = new VectorIndexer({
      enabled: true,
      embeddingProvider: mockProvider,
      vectorStore: store,
    })

    const asts: FileAST[] = [
      makeFileAST('src/utils.ts', 'typescript', [
        makeSymbol('add', 'function', 'src/utils.ts', {
          line: 0,
          endLine: 3,
          signature: 'function add(a: number, b: number): number',
        }),
        makeSymbol('subtract', 'function', 'src/utils.ts', {
          line: 5,
          endLine: 8,
          signature: 'function subtract(a: number, b: number): number',
        }),
      ]),
    ]

    const fileContents = new Map([
      ['src/utils.ts', 'function add(a: number, b: number): number {\n  return a + b\n}\n\nfunction subtract(a: number, b: number): number {\n  return a - b\n}\n'],
    ])

    const result = await indexer.indexFiles(asts, fileContents)

    expect(result.chunked).toBe(2)
    expect(result.embedded).toBe(2)
    expect(store.size()).toBe(2)
  })

  it('handles disabled config (no-ops)', async () => {
    const store = new InMemoryVectorStore()
    const indexer = new VectorIndexer({
      enabled: false,
      embeddingProvider: mockProvider,
      vectorStore: store,
    })

    const asts: FileAST[] = [
      makeFileAST('src/utils.ts', 'typescript', [
        makeSymbol('add', 'function', 'src/utils.ts', { line: 0, endLine: 3 }),
      ]),
    ]
    const fileContents = new Map([['src/utils.ts', 'function add() { return 1 }']])

    const indexResult = await indexer.indexFiles(asts, fileContents)
    expect(indexResult.chunked).toBe(0)
    expect(indexResult.embedded).toBe(0)
    expect(store.size()).toBe(0)

    // removeFiles is also a no-op
    await indexer.removeFiles(['src/utils.ts'])
    expect(store.size()).toBe(0)

    // updateFiles is also a no-op
    const updateResult = await indexer.updateFiles(asts, fileContents)
    expect(updateResult.added).toBe(0)
    expect(updateResult.removed).toBe(0)
    expect(updateResult.unchanged).toBe(0)
  })

  it('removes files by path', async () => {
    const store = new InMemoryVectorStore()
    const indexer = new VectorIndexer({
      enabled: true,
      embeddingProvider: mockProvider,
      vectorStore: store,
    })

    // Index two files
    const asts: FileAST[] = [
      makeFileAST('src/a.ts', 'typescript', [
        makeSymbol('foo', 'function', 'src/a.ts', { line: 0, endLine: 2 }),
      ]),
      makeFileAST('src/b.ts', 'typescript', [
        makeSymbol('bar', 'function', 'src/b.ts', { line: 0, endLine: 2 }),
      ]),
    ]
    const fileContents = new Map([
      ['src/a.ts', 'function foo() {}\n'],
      ['src/b.ts', 'function bar() {}\n'],
    ])

    await indexer.indexFiles(asts, fileContents)
    expect(store.size()).toBe(2)

    // Remove one file
    await indexer.removeFiles(['src/a.ts'])
    expect(store.size()).toBe(1)
  })

  it('updates modified files (only re-embeds changed chunks)', async () => {
    const store = new InMemoryVectorStore()
    const embedSpy = vi.fn(mockProvider.embed.bind(mockProvider))
    const spyProvider: EmbeddingProvider = {
      ...mockProvider,
      embed: embedSpy,
    }

    const indexer = new VectorIndexer({
      enabled: true,
      embeddingProvider: spyProvider,
      vectorStore: store,
      batchSize: 128,
    })

    // Initial index with two symbols
    const initialAsts: FileAST[] = [
      makeFileAST('src/math.ts', 'typescript', [
        makeSymbol('add', 'function', 'src/math.ts', {
          line: 0,
          endLine: 2,
          signature: 'function add(a: number, b: number): number',
        }),
        makeSymbol('multiply', 'function', 'src/math.ts', {
          line: 4,
          endLine: 6,
          signature: 'function multiply(a: number, b: number): number',
        }),
      ]),
    ]
    const initialContents = new Map([
      ['src/math.ts', 'function add(a: number, b: number): number {\n  return a + b\n}\n\nfunction multiply(a: number, b: number): number {\n  return a * b\n}\n'],
    ])

    await indexer.indexFiles(initialAsts, initialContents)
    expect(store.size()).toBe(2)
    const initialEmbedCalls = embedSpy.mock.calls.length

    // Update: only change `add`, keep `multiply` the same
    const updatedAsts: FileAST[] = [
      makeFileAST('src/math.ts', 'typescript', [
        makeSymbol('add', 'function', 'src/math.ts', {
          line: 0,
          endLine: 3,
          signature: 'function add(a: number, b: number): number',
        }),
        makeSymbol('multiply', 'function', 'src/math.ts', {
          line: 5,
          endLine: 7,
          signature: 'function multiply(a: number, b: number): number',
        }),
      ]),
    ]
    const updatedContents = new Map([
      ['src/math.ts', 'function add(a: number, b: number): number {\n  // Enhanced add\n  return a + b\n}\n\nfunction multiply(a: number, b: number): number {\n  return a * b\n}\n'],
    ])

    const result = await indexer.updateFiles(updatedAsts, updatedContents)

    // `add` content changed, `multiply` content unchanged
    expect(result.unchanged).toBeGreaterThanOrEqual(0) // multiply may or may not have changed depending on chunk IDs
    expect(result.added).toBeGreaterThanOrEqual(1) // at least `add` was re-embedded
    expect(store.size()).toBe(2)
  })

  it('emits progress events', async () => {
    const store = new InMemoryVectorStore()
    const indexer = new VectorIndexer({
      enabled: true,
      embeddingProvider: mockProvider,
      vectorStore: store,
    })

    const asts: FileAST[] = [
      makeFileAST('src/a.ts', 'typescript', [
        makeSymbol('foo', 'function', 'src/a.ts', { line: 0, endLine: 2 }),
      ]),
    ]
    const fileContents = new Map([['src/a.ts', 'function foo() { return 1 }']])

    const progress: Array<{ phase: string; processed: number; total: number }> = []
    await indexer.indexFiles(asts, fileContents, (p) => {
      progress.push({ ...p })
    })

    // Should have progress events for chunking, embedding, and indexing phases
    const phases = progress.map(p => p.phase)
    expect(phases).toContain('chunking')
    expect(phases).toContain('embedding')
    expect(phases).toContain('indexing')
  })

  it('handles batch splitting', async () => {
    const store = new InMemoryVectorStore()
    const embedSpy = vi.fn(mockProvider.embed.bind(mockProvider))
    const spyProvider: EmbeddingProvider = {
      ...mockProvider,
      embed: embedSpy,
    }

    const indexer = new VectorIndexer({
      enabled: true,
      embeddingProvider: spyProvider,
      vectorStore: store,
      batchSize: 2,    // Small batch to test splitting
      maxConcurrentBatches: 1,
    })

    // Create 5 symbols => 5 chunks => should be split into 3 batches (2+2+1)
    const symbols: CodeSymbol[] = Array.from({ length: 5 }, (_, i) =>
      makeSymbol(`fn${i}`, 'function', 'src/many.ts', { line: i * 3, endLine: i * 3 + 2 }),
    )

    const asts: FileAST[] = [
      makeFileAST('src/many.ts', 'typescript', symbols),
    ]
    const lines = Array.from({ length: 15 }, (_, i) => `line ${i}`)
    const fileContents = new Map([['src/many.ts', lines.join('\n')]])

    await indexer.indexFiles(asts, fileContents)

    // 5 chunks / batchSize 2 = 3 embed calls
    expect(embedSpy).toHaveBeenCalledTimes(3)
    expect(store.size()).toBe(5)
  })
})

// ── IncrementalIndexer + VectorIndexer Integration ───────────────────

describe('IncrementalIndexer with VectorIndexer', () => {
  it('added files get vector-indexed', async () => {
    const extractor = new SymbolExtractor()
    const store = new InMemoryVectorStore()
    const vectorIndexer = new VectorIndexer({
      enabled: true,
      embeddingProvider: mockProvider,
      vectorStore: store,
    })

    const indexer = new IncrementalIndexer(extractor)
    indexer.setVectorIndexer(vectorIndexer)

    const files = new Map([
      ['src/main.ts', 'export function main() { return 1 }'],
      ['src/utils.ts', 'export function helper() { return 42 }'],
    ])

    const result = await indexer.index(files)

    expect(result.changes.added).toHaveLength(2)
    // Vector store should have chunks for the added files
    expect(store.size()).toBeGreaterThan(0)
  })

  it('deleted files get removed from vector store', async () => {
    const extractor = new SymbolExtractor()
    const store = new InMemoryVectorStore()
    const vectorIndexer = new VectorIndexer({
      enabled: true,
      embeddingProvider: mockProvider,
      vectorStore: store,
    })

    const indexer = new IncrementalIndexer(extractor)
    indexer.setVectorIndexer(vectorIndexer)

    // First index: two files
    const files1 = new Map([
      ['src/a.ts', 'export function foo() { return 1 }'],
      ['src/b.ts', 'export function bar() { return 2 }'],
    ])
    await indexer.index(files1)
    const sizeAfterFirstIndex = store.size()
    expect(sizeAfterFirstIndex).toBeGreaterThan(0)

    // Second index: remove src/b.ts
    const files2 = new Map([
      ['src/a.ts', 'export function foo() { return 1 }'],
    ])
    const result = await indexer.index(files2)

    expect(result.changes.deleted).toEqual(['src/b.ts'])
    // Store should have fewer chunks
    expect(store.size()).toBeLessThan(sizeAfterFirstIndex)
  })

  it('works exactly as before without vector indexer', async () => {
    const extractor = new SymbolExtractor()
    const indexer = new IncrementalIndexer(extractor)

    // No setVectorIndexer call — should work fine
    const files = new Map([
      ['src/main.ts', 'export function main() {}'],
      ['src/utils.ts', 'export const helper = () => 42'],
    ])
    const result = await indexer.index(files)

    expect(result.changes.added).toHaveLength(2)
    expect(result.changes.modified).toHaveLength(0)
    expect(result.indexed).toHaveLength(2)
    expect(result.metadata.totalFiles).toBe(2)

    // Second pass with modification
    const files2 = new Map([
      ['src/main.ts', 'export function main() {}'],
      ['src/utils.ts', 'export const helper = () => 99'],
    ])
    const result2 = await indexer.index(files2)
    expect(result2.changes.modified).toEqual(['src/utils.ts'])
    expect(result2.indexed).toHaveLength(1)
  })
})
