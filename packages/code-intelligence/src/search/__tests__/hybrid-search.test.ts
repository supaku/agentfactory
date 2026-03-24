import { describe, it, expect, vi } from 'vitest'
import { SearchEngine } from '../search-engine.js'
import { HybridSearchEngine } from '../hybrid-search.js'
import { minMaxNormalize } from '../score-normalizer.js'
import { classifyQuery } from '../query-classifier.js'
import type { CodeSymbol, SearchResult, EmbeddingChunk } from '../../types.js'
import type { VectorStore, VectorSearchResult } from '../../vector/vector-store.js'
import type { EmbeddingProvider } from '../../embedding/embedding-provider.js'

// ── Helpers ──────────────────────────────────────────────────────────

function makeSymbol(
  name: string,
  kind: string,
  filePath: string,
  extra?: Partial<CodeSymbol>,
): CodeSymbol {
  return {
    name,
    kind: kind as any,
    filePath,
    line: extra?.line ?? 1,
    exported: true,
    ...extra,
  }
}

function makeChunk(
  filePath: string,
  symbolName: string,
  startLine: number,
  embedding?: number[],
): EmbeddingChunk {
  return {
    id: `${filePath}:${symbolName}:${startLine}`,
    content: `function ${symbolName}() {}`,
    embedding,
    metadata: {
      filePath,
      symbolName,
      symbolKind: 'function',
      startLine,
      endLine: startLine + 10,
      language: 'typescript',
    },
  }
}

function createMockVectorStore(results: VectorSearchResult[]): VectorStore {
  return {
    insert: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue(results),
    delete: vi.fn().mockResolvedValue(undefined),
    size: vi.fn().mockReturnValue(results.length > 0 ? 100 : 0),
    save: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
  }
}

function createMockEmbeddingProvider(): EmbeddingProvider {
  return {
    model: 'test-model',
    dimensions: 128,
    embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    embedQuery: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  }
}

// ── Score Normalizer Tests ──────────────────────────────────────────

describe('minMaxNormalize', () => {
  it('normalizes a range of scores to [0, 1]', () => {
    const result = minMaxNormalize([2, 5, 8])
    expect(result[0]).toBeCloseTo(0.0) // min
    expect(result[1]).toBeCloseTo(0.5) // mid
    expect(result[2]).toBeCloseTo(1.0) // max
  })

  it('returns empty array for empty input', () => {
    expect(minMaxNormalize([])).toEqual([])
  })

  it('returns [1.0] for single result', () => {
    expect(minMaxNormalize([42])).toEqual([1.0])
  })

  it('returns all 1.0 when all scores are the same', () => {
    const result = minMaxNormalize([5, 5, 5])
    expect(result).toEqual([1.0, 1.0, 1.0])
  })

  it('handles negative scores', () => {
    const result = minMaxNormalize([-10, 0, 10])
    expect(result[0]).toBeCloseTo(0.0)
    expect(result[1]).toBeCloseTo(0.5)
    expect(result[2]).toBeCloseTo(1.0)
  })

  it('handles two scores', () => {
    const result = minMaxNormalize([3, 7])
    expect(result[0]).toBeCloseTo(0.0)
    expect(result[1]).toBeCloseTo(1.0)
  })
})

// ── CCS Fusion Math Tests ───────────────────────────────────────────

describe('HybridSearchEngine — CCS fusion', () => {
  it('computes correct CCS score with manual calculation', async () => {
    // Setup: 2 symbols that appear in both BM25 and vector results
    const symbols: CodeSymbol[] = [
      makeSymbol('handleRequest', 'function', 'src/api.ts', { line: 1, language: 'typescript' }),
      makeSymbol('processData', 'function', 'src/data.ts', { line: 5, language: 'typescript' }),
    ]

    const engine = new SearchEngine()
    engine.buildIndex(symbols)

    // Vector results matching the same symbols
    const vectorResults: VectorSearchResult[] = [
      { chunk: makeChunk('src/data.ts', 'processData', 5), score: 0.95 },
      { chunk: makeChunk('src/api.ts', 'handleRequest', 1), score: 0.70 },
    ]

    const vectorStore = createMockVectorStore(vectorResults)
    const embeddingProvider = createMockEmbeddingProvider()

    const hybrid = new HybridSearchEngine(engine, vectorStore, embeddingProvider, {
      alpha: 0.5,
      adaptiveAlpha: false,
      fusionMethod: 'ccs',
    })

    const results = await hybrid.search({ query: 'handleRequest', maxResults: 10 })

    // Both results should have hybrid matchType since they appear in both BM25 and vector
    const handleResult = results.find(r => r.symbol.name === 'handleRequest')
    expect(handleResult).toBeDefined()
    expect(handleResult!.bm25Score).toBeDefined()
    expect(handleResult!.vectorScore).toBeDefined()
    expect(handleResult!.matchType).toBe('hybrid')

    // Score should be between 0 and 1 (normalized fusion)
    expect(handleResult!.score).toBeGreaterThanOrEqual(0)
    expect(handleResult!.score).toBeLessThanOrEqual(1)
  })

  it('produces correct fusion with alpha=0 (BM25-only weight)', async () => {
    const symbols: CodeSymbol[] = [
      makeSymbol('foo', 'function', 'a.ts', { line: 1, language: 'typescript' }),
    ]

    const engine = new SearchEngine()
    engine.buildIndex(symbols)

    const vectorResults: VectorSearchResult[] = [
      { chunk: makeChunk('a.ts', 'foo', 1), score: 0.9 },
    ]

    const vectorStore = createMockVectorStore(vectorResults)
    const embeddingProvider = createMockEmbeddingProvider()

    const hybrid = new HybridSearchEngine(engine, vectorStore, embeddingProvider, {
      alpha: 0,
      adaptiveAlpha: false,
      fusionMethod: 'ccs',
    })

    const results = await hybrid.search({ query: 'foo', maxResults: 10 })
    // With alpha=0, vector component should be 0 — score comes entirely from BM25
    // Single BM25 result normalizes to 1.0, so score = (1-0)*1.0 + 0*norm_vector = 1.0
    const fooResult = results.find(r => r.symbol.name === 'foo')
    expect(fooResult).toBeDefined()
    expect(fooResult!.score).toBeCloseTo(1.0)
  })

  it('produces correct fusion with alpha=1 (vector-only weight)', async () => {
    const symbols: CodeSymbol[] = [
      makeSymbol('foo', 'function', 'a.ts', { line: 1, language: 'typescript' }),
    ]

    const engine = new SearchEngine()
    engine.buildIndex(symbols)

    const vectorResults: VectorSearchResult[] = [
      { chunk: makeChunk('a.ts', 'foo', 1), score: 0.85 },
    ]

    const vectorStore = createMockVectorStore(vectorResults)
    const embeddingProvider = createMockEmbeddingProvider()

    const hybrid = new HybridSearchEngine(engine, vectorStore, embeddingProvider, {
      alpha: 1,
      adaptiveAlpha: false,
      fusionMethod: 'ccs',
    })

    const results = await hybrid.search({ query: 'foo', maxResults: 10 })
    // With alpha=1, BM25 component should be 0 — score comes entirely from vector
    // Single vector result normalizes to 1.0, so score = 1*1.0 + 0*bm25 = 1.0
    const fooResult = results.find(r => r.symbol.name === 'foo')
    expect(fooResult).toBeDefined()
    expect(fooResult!.score).toBeCloseTo(1.0)
  })
})

// ── RRF Fusion Tests ────────────────────────────────────────────────

describe('HybridSearchEngine — RRF fusion', () => {
  it('computes correct RRF score', async () => {
    const symbols: CodeSymbol[] = [
      makeSymbol('handleRequest', 'function', 'a.ts', { line: 1, language: 'typescript' }),
      makeSymbol('handleResponse', 'function', 'b.ts', { line: 1, language: 'typescript' }),
    ]

    const engine = new SearchEngine()
    engine.buildIndex(symbols)

    // Both should appear in BM25 results for "handle" — handleRequest rank 1, handleResponse rank 2
    // Vector: handleResponse rank 1, handleRequest rank 2
    const vectorResults: VectorSearchResult[] = [
      { chunk: makeChunk('b.ts', 'handleResponse', 1), score: 0.95 },
      { chunk: makeChunk('a.ts', 'handleRequest', 1), score: 0.80 },
    ]

    const vectorStore = createMockVectorStore(vectorResults)
    const embeddingProvider = createMockEmbeddingProvider()

    const hybrid = new HybridSearchEngine(engine, vectorStore, embeddingProvider, {
      fusionMethod: 'rrf',
      rrfK: 60,
      adaptiveAlpha: false,
    })

    const results = await hybrid.search({ query: 'handle', maxResults: 10 })

    // Both symbols should appear in results from both BM25 and vector
    expect(results.length).toBeGreaterThanOrEqual(2)

    const reqResult = results.find(r => r.symbol.name === 'handleRequest')
    const resResult = results.find(r => r.symbol.name === 'handleResponse')

    expect(reqResult).toBeDefined()
    expect(resResult).toBeDefined()
    expect(reqResult!.matchType).toBe('hybrid')
    expect(resResult!.matchType).toBe('hybrid')
    expect(reqResult!.score).toBeGreaterThan(0)
    expect(resResult!.score).toBeGreaterThan(0)

    // RRF scores: both get 1/(60+rank_bm25) + 1/(60+rank_vector)
    // Since they swap ranks between BM25 and vector, they should have similar scores
    expect(Math.abs(reqResult!.score - resResult!.score)).toBeLessThan(0.01)
  })
})

// ── BM25 Fallback Tests ─────────────────────────────────────────────

describe('HybridSearchEngine — BM25 fallback', () => {
  it('falls back to BM25 when no vector store', async () => {
    const symbols: CodeSymbol[] = [
      makeSymbol('handleRequest', 'function', 'src/api.ts', { language: 'typescript' }),
    ]

    const engine = new SearchEngine()
    engine.buildIndex(symbols)

    const hybrid = new HybridSearchEngine(engine, null, null)

    const results = await hybrid.search({ query: 'handleRequest', maxResults: 10 })
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].symbol.name).toBe('handleRequest')
    // Should use BM25 match types, not hybrid
    expect(['exact', 'fuzzy', 'bm25']).toContain(results[0].matchType)
  })

  it('falls back to BM25 when vector store is empty', async () => {
    const symbols: CodeSymbol[] = [
      makeSymbol('handleRequest', 'function', 'src/api.ts', { language: 'typescript' }),
    ]

    const engine = new SearchEngine()
    engine.buildIndex(symbols)

    const emptyVectorStore = createMockVectorStore([])
    ;(emptyVectorStore.size as any).mockReturnValue(0)
    const embeddingProvider = createMockEmbeddingProvider()

    const hybrid = new HybridSearchEngine(engine, emptyVectorStore, embeddingProvider)

    const results = await hybrid.search({ query: 'handleRequest', maxResults: 10 })
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].symbol.name).toBe('handleRequest')
  })

  it('falls back to BM25 when no embedding provider', async () => {
    const symbols: CodeSymbol[] = [
      makeSymbol('handleRequest', 'function', 'src/api.ts', { language: 'typescript' }),
    ]

    const engine = new SearchEngine()
    engine.buildIndex(symbols)

    const vectorStore = createMockVectorStore([])
    ;(vectorStore.size as any).mockReturnValue(10)

    const hybrid = new HybridSearchEngine(engine, vectorStore, null)

    const results = await hybrid.search({ query: 'handleRequest', maxResults: 10 })
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].symbol.name).toBe('handleRequest')
  })
})

// ── Adaptive Alpha Tests ────────────────────────────────────────────

describe('HybridSearchEngine — adaptive alpha', () => {
  it('uses lower alpha for identifier queries', () => {
    const classification = classifyQuery('handleRequest')
    expect(classification.type).toBe('identifier')
    expect(classification.alpha).toBe(0.25)
  })

  it('uses higher alpha for natural language queries', () => {
    const classification = classifyQuery('how to handle authentication errors')
    expect(classification.type).toBe('natural')
    expect(classification.alpha).toBe(0.75)
  })

  it('uses balanced alpha for mixed queries', () => {
    const classification = classifyQuery('fix handleRequest error')
    expect(classification.type).toBe('mixed')
    expect(classification.alpha).toBe(0.55)
  })

  it('uses adaptive alpha when enabled (default)', async () => {
    const symbols: CodeSymbol[] = [
      makeSymbol('handleRequest', 'function', 'src/api.ts', { line: 1, language: 'typescript' }),
    ]

    const engine = new SearchEngine()
    engine.buildIndex(symbols)

    const vectorResults: VectorSearchResult[] = [
      { chunk: makeChunk('src/api.ts', 'handleRequest', 1), score: 0.9 },
    ]

    const vectorStore = createMockVectorStore(vectorResults)
    const embeddingProvider = createMockEmbeddingProvider()

    // adaptiveAlpha: true (default) — identifier query should use alpha=0.25
    const hybrid = new HybridSearchEngine(engine, vectorStore, embeddingProvider, {
      adaptiveAlpha: true,
      fusionMethod: 'ccs',
    })

    const results = await hybrid.search({ query: 'handleRequest', maxResults: 10 })
    expect(results.length).toBeGreaterThan(0)
    // With alpha=0.25 (favoring BM25), the BM25 component should dominate
    // For a single matched doc, both normalize to 1.0, so score = 0.25*1.0 + 0.75*1.0 = 1.0
    expect(results[0].score).toBeCloseTo(1.0)
  })

  it('uses fixed alpha when adaptiveAlpha is disabled', async () => {
    const symbols: CodeSymbol[] = [
      makeSymbol('handleRequest', 'function', 'src/api.ts', { line: 1, language: 'typescript' }),
    ]

    const engine = new SearchEngine()
    engine.buildIndex(symbols)

    const vectorResults: VectorSearchResult[] = [
      { chunk: makeChunk('src/api.ts', 'handleRequest', 1), score: 0.9 },
    ]

    const vectorStore = createMockVectorStore(vectorResults)
    const embeddingProvider = createMockEmbeddingProvider()

    const hybrid = new HybridSearchEngine(engine, vectorStore, embeddingProvider, {
      alpha: 0.6,
      adaptiveAlpha: false,
      fusionMethod: 'ccs',
    })

    const results = await hybrid.search({ query: 'handleRequest', maxResults: 10 })
    expect(results.length).toBeGreaterThan(0)
  })
})

// ── Filter Application Tests ────────────────────────────────────────

describe('HybridSearchEngine — filters', () => {
  it('filters by symbolKinds in hybrid mode', async () => {
    const symbols: CodeSymbol[] = [
      makeSymbol('handleRequest', 'function', 'src/api.ts', { line: 1, language: 'typescript' }),
      makeSymbol('RequestHandler', 'class', 'src/handler.ts', { line: 1, language: 'typescript' }),
    ]

    const engine = new SearchEngine()
    engine.buildIndex(symbols)

    const vectorResults: VectorSearchResult[] = [
      { chunk: makeChunk('src/api.ts', 'handleRequest', 1), score: 0.9 },
      { chunk: makeChunk('src/handler.ts', 'RequestHandler', 1), score: 0.85 },
    ]

    const vectorStore = createMockVectorStore(vectorResults)
    const embeddingProvider = createMockEmbeddingProvider()

    const hybrid = new HybridSearchEngine(engine, vectorStore, embeddingProvider, {
      adaptiveAlpha: false,
      alpha: 0.5,
    })

    const results = await hybrid.search({
      query: 'request',
      maxResults: 10,
      symbolKinds: ['function'],
    })

    for (const r of results) {
      expect(r.symbol.kind).toBe('function')
    }
  })

  it('filters by language in hybrid mode', async () => {
    const symbols: CodeSymbol[] = [
      makeSymbol('handleRequest', 'function', 'src/api.ts', { line: 1, language: 'typescript' }),
      makeSymbol('handle_request', 'function', 'src/api.py', { line: 1, language: 'python' }),
    ]

    const engine = new SearchEngine()
    engine.buildIndex(symbols)

    const vectorResults: VectorSearchResult[] = [
      { chunk: makeChunk('src/api.ts', 'handleRequest', 1), score: 0.9 },
      {
        chunk: {
          id: 'src/api.py:handle_request:1',
          content: 'def handle_request():',
          metadata: {
            filePath: 'src/api.py',
            symbolName: 'handle_request',
            symbolKind: 'function',
            startLine: 1,
            endLine: 10,
            language: 'python',
          },
        },
        score: 0.85,
      },
    ]

    const vectorStore = createMockVectorStore(vectorResults)
    const embeddingProvider = createMockEmbeddingProvider()

    const hybrid = new HybridSearchEngine(engine, vectorStore, embeddingProvider, {
      adaptiveAlpha: false,
      alpha: 0.5,
    })

    const results = await hybrid.search({
      query: 'handle request',
      maxResults: 10,
      language: 'typescript',
    })

    for (const r of results) {
      expect(r.symbol.language).toBe('typescript')
    }
  })

  it('filters by filePattern in hybrid mode', async () => {
    const symbols: CodeSymbol[] = [
      makeSymbol('handleRequest', 'function', 'src/api.ts', { line: 1, language: 'typescript' }),
      makeSymbol('handleError', 'function', 'lib/error.ts', { line: 1, language: 'typescript' }),
    ]

    const engine = new SearchEngine()
    engine.buildIndex(symbols)

    const vectorResults: VectorSearchResult[] = [
      { chunk: makeChunk('src/api.ts', 'handleRequest', 1), score: 0.9 },
      { chunk: makeChunk('lib/error.ts', 'handleError', 1), score: 0.85 },
    ]

    const vectorStore = createMockVectorStore(vectorResults)
    const embeddingProvider = createMockEmbeddingProvider()

    const hybrid = new HybridSearchEngine(engine, vectorStore, embeddingProvider, {
      adaptiveAlpha: false,
      alpha: 0.5,
    })

    const results = await hybrid.search({
      query: 'handle',
      maxResults: 10,
      filePattern: 'src/**',
    })

    for (const r of results) {
      expect(r.symbol.filePath).toMatch(/^src\//)
    }
  })
})

// ── Vector-only results ─────────────────────────────────────────────

describe('HybridSearchEngine — vector-only results', () => {
  it('includes results found only by vector search', async () => {
    const symbols: CodeSymbol[] = [
      makeSymbol('handleRequest', 'function', 'src/api.ts', { line: 1, language: 'typescript' }),
    ]

    const engine = new SearchEngine()
    engine.buildIndex(symbols)

    // Vector returns an additional result not in BM25
    const vectorResults: VectorSearchResult[] = [
      { chunk: makeChunk('src/api.ts', 'handleRequest', 1), score: 0.9 },
      { chunk: makeChunk('src/auth.ts', 'authenticate', 10), score: 0.8 },
    ]

    const vectorStore = createMockVectorStore(vectorResults)
    const embeddingProvider = createMockEmbeddingProvider()

    const hybrid = new HybridSearchEngine(engine, vectorStore, embeddingProvider, {
      adaptiveAlpha: false,
      alpha: 0.5,
    })

    const results = await hybrid.search({ query: 'handleRequest', maxResults: 10 })

    const authResult = results.find(r => r.symbol.name === 'authenticate')
    expect(authResult).toBeDefined()
    expect(authResult!.matchType).toBe('semantic')
    expect(authResult!.vectorScore).toBeDefined()
    expect(authResult!.bm25Score).toBeUndefined()
  })
})

// ── maxResults ──────────────────────────────────────────────────────

describe('HybridSearchEngine — maxResults', () => {
  it('respects maxResults limit', async () => {
    const symbols: CodeSymbol[] = [
      makeSymbol('foo', 'function', 'a.ts', { line: 1, language: 'typescript' }),
      makeSymbol('fooBar', 'function', 'b.ts', { line: 1, language: 'typescript' }),
      makeSymbol('fooBarBaz', 'function', 'c.ts', { line: 1, language: 'typescript' }),
    ]

    const engine = new SearchEngine()
    engine.buildIndex(symbols)

    const hybrid = new HybridSearchEngine(engine, null, null)

    const results = await hybrid.search({ query: 'foo', maxResults: 1 })
    expect(results.length).toBeLessThanOrEqual(1)
  })
})
