import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CohereReranker } from '../cohere-reranker.js'
import { VoyageReranker } from '../voyage-reranker.js'
import type { RerankerProvider, RerankDocument, RerankerConfig } from '../reranker-provider.js'
import { SearchEngine } from '../../search/search-engine.js'
import { HybridSearchEngine } from '../../search/hybrid-search.js'
import type { CodeSymbol, SearchResult } from '../../types.js'

// ── Helpers ──────────────────────────────────────────────────────────

/** Create a mock fetch response. */
function mockFetchResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers ?? {}),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response
}

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

function makeSearchResult(
  name: string,
  score: number,
  extra?: Partial<CodeSymbol>,
): SearchResult {
  return {
    symbol: makeSymbol(name, 'function', `src/${name}.ts`, extra),
    score,
    matchType: 'bm25',
  }
}

// ── CohereReranker ──────────────────────────────────────────────────

describe('CohereReranker', () => {
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env.COHERE_API_KEY
    process.env.COHERE_API_KEY = 'test-cohere-key'
  })

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.COHERE_API_KEY = originalEnv
    } else {
      delete process.env.COHERE_API_KEY
    }
    vi.restoreAllMocks()
  })

  it('throws on missing API key', () => {
    delete process.env.COHERE_API_KEY
    expect(() => new CohereReranker()).toThrow('COHERE_API_KEY')
  })

  it('uses default model', () => {
    const reranker = new CohereReranker()
    expect(reranker.model).toBe('rerank-v3.5')
  })

  it('sends correct request format', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockFetchResponse(200, {
        results: [
          { index: 0, relevance_score: 0.95 },
          { index: 1, relevance_score: 0.80 },
        ],
      }),
    )

    const reranker = new CohereReranker()
    const documents: RerankDocument[] = [
      { id: 'doc-0', text: 'function handleRequest() {}' },
      { id: 'doc-1', text: 'function processData() {}' },
    ]

    await reranker.rerank('handle request', documents)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const callArgs = fetchSpy.mock.calls[0]
    expect(callArgs[0]).toBe('https://api.cohere.com/v2/rerank')

    const body = JSON.parse(callArgs[1]!.body as string)
    expect(body.model).toBe('rerank-v3.5')
    expect(body.query).toBe('handle request')
    expect(body.documents).toEqual([
      'function handleRequest() {}',
      'function processData() {}',
    ])
    expect(body.top_n).toBe(2)

    const headers = callArgs[1]!.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer test-cohere-key')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('parses response correctly and maps to RerankResult[]', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockFetchResponse(200, {
        results: [
          { index: 1, relevance_score: 0.95 },
          { index: 0, relevance_score: 0.72 },
        ],
      }),
    )

    const reranker = new CohereReranker()
    const documents: RerankDocument[] = [
      { id: 'doc-a', text: 'first document' },
      { id: 'doc-b', text: 'second document' },
    ]

    const results = await reranker.rerank('query', documents)

    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({ id: 'doc-b', score: 0.95, index: 1 })
    expect(results[1]).toEqual({ id: 'doc-a', score: 0.72, index: 0 })
  })

  it('returns empty array for empty documents', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const reranker = new CohereReranker()
    const results = await reranker.rerank('query', [])

    expect(results).toHaveLength(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('retries on 429', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        mockFetchResponse(429, { message: 'Rate limited' }),
      )
      .mockResolvedValueOnce(
        mockFetchResponse(200, {
          results: [{ index: 0, relevance_score: 0.9 }],
        }),
      )

    const reranker = new CohereReranker({ maxRetries: 3 })
    vi.spyOn(reranker as any, 'sleep').mockResolvedValue(undefined)

    const results = await reranker.rerank('query', [{ id: 'a', text: 'doc' }])
    expect(results).toHaveLength(1)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('retries on 5xx', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        mockFetchResponse(503, { message: 'Service unavailable' }),
      )
      .mockResolvedValueOnce(
        mockFetchResponse(500, { message: 'Internal error' }),
      )
      .mockResolvedValueOnce(
        mockFetchResponse(200, {
          results: [{ index: 0, relevance_score: 0.85 }],
        }),
      )

    const reranker = new CohereReranker({ maxRetries: 3 })
    vi.spyOn(reranker as any, 'sleep').mockResolvedValue(undefined)

    const results = await reranker.rerank('query', [{ id: 'a', text: 'doc' }])
    expect(results).toHaveLength(1)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('throws after exhausting retries', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mockFetchResponse(429, { message: 'Rate limited' }),
    )

    const reranker = new CohereReranker({ maxRetries: 2 })
    vi.spyOn(reranker as any, 'sleep').mockResolvedValue(undefined)

    await expect(
      reranker.rerank('query', [{ id: 'a', text: 'doc' }]),
    ).rejects.toThrow('429')
  })

  it('throws immediately on non-retryable errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockFetchResponse(401, { message: 'Invalid API key' }),
    )

    const reranker = new CohereReranker()
    await expect(
      reranker.rerank('query', [{ id: 'a', text: 'doc' }]),
    ).rejects.toThrow('Invalid API key')
  })
})

// ── VoyageReranker ──────────────────────────────────────────────────

describe('VoyageReranker', () => {
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env.VOYAGE_API_KEY
    process.env.VOYAGE_API_KEY = 'test-voyage-key'
  })

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.VOYAGE_API_KEY = originalEnv
    } else {
      delete process.env.VOYAGE_API_KEY
    }
    vi.restoreAllMocks()
  })

  it('throws on missing API key', () => {
    delete process.env.VOYAGE_API_KEY
    expect(() => new VoyageReranker()).toThrow('VOYAGE_API_KEY')
  })

  it('uses VOYAGE_API_KEY', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockFetchResponse(200, {
        data: [{ index: 0, relevance_score: 0.9 }],
      }),
    )

    const reranker = new VoyageReranker()
    await reranker.rerank('query', [{ id: 'a', text: 'doc' }])

    const callArgs = fetchSpy.mock.calls[0]
    const headers = callArgs[1]!.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer test-voyage-key')
  })

  it('uses default model', () => {
    const reranker = new VoyageReranker()
    expect(reranker.model).toBe('rerank-2')
  })

  it('sends correct request format', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockFetchResponse(200, {
        data: [
          { index: 0, relevance_score: 0.95 },
          { index: 1, relevance_score: 0.80 },
        ],
      }),
    )

    const reranker = new VoyageReranker()
    const documents: RerankDocument[] = [
      { id: 'doc-0', text: 'function handleRequest() {}' },
      { id: 'doc-1', text: 'function processData() {}' },
    ]

    await reranker.rerank('handle request', documents)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const callArgs = fetchSpy.mock.calls[0]
    expect(callArgs[0]).toBe('https://api.voyageai.com/v1/rerank')

    const body = JSON.parse(callArgs[1]!.body as string)
    expect(body.model).toBe('rerank-2')
    expect(body.query).toBe('handle request')
    expect(body.documents).toEqual([
      'function handleRequest() {}',
      'function processData() {}',
    ])
    expect(body.top_k).toBe(2)
  })

  it('parses response correctly and maps to RerankResult[]', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockFetchResponse(200, {
        data: [
          { index: 1, relevance_score: 0.92 },
          { index: 0, relevance_score: 0.68 },
        ],
      }),
    )

    const reranker = new VoyageReranker()
    const documents: RerankDocument[] = [
      { id: 'doc-a', text: 'first document' },
      { id: 'doc-b', text: 'second document' },
    ]

    const results = await reranker.rerank('query', documents)

    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({ id: 'doc-b', score: 0.92, index: 1 })
    expect(results[1]).toEqual({ id: 'doc-a', score: 0.68, index: 0 })
  })

  it('returns empty array for empty documents', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const reranker = new VoyageReranker()
    const results = await reranker.rerank('query', [])

    expect(results).toHaveLength(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('retries on 429', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        mockFetchResponse(429, { detail: 'Rate limited' }),
      )
      .mockResolvedValueOnce(
        mockFetchResponse(200, {
          data: [{ index: 0, relevance_score: 0.9 }],
        }),
      )

    const reranker = new VoyageReranker({ maxRetries: 3 })
    vi.spyOn(reranker as any, 'sleep').mockResolvedValue(undefined)

    const results = await reranker.rerank('query', [{ id: 'a', text: 'doc' }])
    expect(results).toHaveLength(1)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('retries on 5xx', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        mockFetchResponse(503, { detail: 'Service unavailable' }),
      )
      .mockResolvedValueOnce(
        mockFetchResponse(200, {
          data: [{ index: 0, relevance_score: 0.85 }],
        }),
      )

    const reranker = new VoyageReranker({ maxRetries: 3 })
    vi.spyOn(reranker as any, 'sleep').mockResolvedValue(undefined)

    const results = await reranker.rerank('query', [{ id: 'a', text: 'doc' }])
    expect(results).toHaveLength(1)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('throws after exhausting retries', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mockFetchResponse(429, { detail: 'Rate limited' }),
    )

    const reranker = new VoyageReranker({ maxRetries: 2 })
    vi.spyOn(reranker as any, 'sleep').mockResolvedValue(undefined)

    await expect(
      reranker.rerank('query', [{ id: 'a', text: 'doc' }]),
    ).rejects.toThrow('429')
  })

  it('throws immediately on non-retryable errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockFetchResponse(401, { detail: 'Invalid API key' }),
    )

    const reranker = new VoyageReranker()
    await expect(
      reranker.rerank('query', [{ id: 'a', text: 'doc' }]),
    ).rejects.toThrow('Invalid API key')
  })
})

// ── HybridSearchEngine + Reranker Integration ──────────────────────

describe('HybridSearchEngine with reranker', () => {
  function createMockRerankerProvider(results?: Array<{ index: number; score: number }>): RerankerProvider {
    return {
      model: 'mock-reranker',
      rerank: vi.fn().mockResolvedValue(
        (results ?? []).map(r => ({
          id: `${r.index}`,
          score: r.score,
          index: r.index,
        })),
      ),
    }
  }

  function createFailingRerankerProvider(): RerankerProvider {
    return {
      model: 'failing-reranker',
      rerank: vi.fn().mockRejectedValue(new Error('Reranker failed')),
    }
  }

  it('reranks top candidates and returns reranked scores', async () => {
    const symbols: CodeSymbol[] = [
      makeSymbol('handleRequest', 'function', 'src/api.ts', {
        line: 1,
        language: 'typescript',
        signature: 'function handleRequest(req: Request): Response',
        documentation: 'Handles incoming HTTP requests',
      }),
      makeSymbol('processData', 'function', 'src/data.ts', {
        line: 1,
        language: 'typescript',
        signature: 'function processData(data: unknown): void',
      }),
      makeSymbol('handleError', 'function', 'src/error.ts', {
        line: 1,
        language: 'typescript',
      }),
    ]

    const engine = new SearchEngine()
    engine.buildIndex(symbols)

    const mockProvider = createMockRerankerProvider([
      { index: 2, score: 0.99 },  // handleError gets highest rerank score
      { index: 0, score: 0.85 },  // handleRequest
      { index: 1, score: 0.60 },  // processData
    ])

    const rerankerConfig: RerankerConfig = {
      enabled: true,
      provider: mockProvider,
      topN: 10,
      candidatePool: 50,
    }

    const hybrid = new HybridSearchEngine(engine, null, null, {}, rerankerConfig)
    const results = await hybrid.search({ query: 'handle', maxResults: 20 })

    // Reranker should have been called
    expect(mockProvider.rerank).toHaveBeenCalledTimes(1)

    // Results should have rerankScore set
    for (const r of results) {
      expect(r.rerankScore).toBeDefined()
    }

    // Results should be sorted by rerank score descending
    if (results.length >= 2) {
      expect(results[0].score).toBeGreaterThanOrEqual(results[1].score)
    }
  })

  it('passes through results when reranker is disabled', async () => {
    const symbols: CodeSymbol[] = [
      makeSymbol('handleRequest', 'function', 'src/api.ts', { line: 1, language: 'typescript' }),
      makeSymbol('processData', 'function', 'src/data.ts', { line: 1, language: 'typescript' }),
    ]

    const engine = new SearchEngine()
    engine.buildIndex(symbols)

    const mockProvider = createMockRerankerProvider()

    const rerankerConfig: RerankerConfig = {
      enabled: false,
      provider: mockProvider,
      topN: 10,
      candidatePool: 50,
    }

    const hybrid = new HybridSearchEngine(engine, null, null, {}, rerankerConfig)
    const results = await hybrid.search({ query: 'handle', maxResults: 20 })

    // Reranker should NOT have been called
    expect(mockProvider.rerank).not.toHaveBeenCalled()

    // Results should not have rerankScore
    for (const r of results) {
      expect(r.rerankScore).toBeUndefined()
    }
  })

  it('gracefully falls back when reranker errors', async () => {
    const symbols: CodeSymbol[] = [
      makeSymbol('handleRequest', 'function', 'src/api.ts', { line: 1, language: 'typescript' }),
    ]

    const engine = new SearchEngine()
    engine.buildIndex(symbols)

    const failingProvider = createFailingRerankerProvider()

    const rerankerConfig: RerankerConfig = {
      enabled: true,
      provider: failingProvider,
      topN: 10,
      candidatePool: 50,
    }

    const hybrid = new HybridSearchEngine(engine, null, null, {}, rerankerConfig)
    const results = await hybrid.search({ query: 'handleRequest', maxResults: 20 })

    // Should return results despite reranker failure
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].symbol.name).toBe('handleRequest')

    // Results should not have rerankScore (fallback path)
    expect(results[0].rerankScore).toBeUndefined()
  })

  it('passes through results when rerankerConfig is null', async () => {
    const symbols: CodeSymbol[] = [
      makeSymbol('handleRequest', 'function', 'src/api.ts', { line: 1, language: 'typescript' }),
    ]

    const engine = new SearchEngine()
    engine.buildIndex(symbols)

    const hybrid = new HybridSearchEngine(engine, null, null, {}, null)
    const results = await hybrid.search({ query: 'handleRequest', maxResults: 20 })

    expect(results.length).toBeGreaterThan(0)
    expect(results[0].rerankScore).toBeUndefined()
  })

  it('respects topN limit from reranker config', async () => {
    const symbols: CodeSymbol[] = [
      makeSymbol('a', 'function', 'a.ts', { line: 1, language: 'typescript' }),
      makeSymbol('ab', 'function', 'ab.ts', { line: 1, language: 'typescript' }),
      makeSymbol('abc', 'function', 'abc.ts', { line: 1, language: 'typescript' }),
      makeSymbol('abcd', 'function', 'abcd.ts', { line: 1, language: 'typescript' }),
      makeSymbol('abcde', 'function', 'abcde.ts', { line: 1, language: 'typescript' }),
    ]

    const engine = new SearchEngine()
    engine.buildIndex(symbols)

    const mockProvider = createMockRerankerProvider([
      { index: 0, score: 0.9 },
      { index: 1, score: 0.8 },
      { index: 2, score: 0.7 },
      { index: 3, score: 0.6 },
      { index: 4, score: 0.5 },
    ])

    const rerankerConfig: RerankerConfig = {
      enabled: true,
      provider: mockProvider,
      topN: 2,
      candidatePool: 50,
    }

    const hybrid = new HybridSearchEngine(engine, null, null, {}, rerankerConfig)
    const results = await hybrid.search({ query: 'a', maxResults: 20 })

    expect(results.length).toBeLessThanOrEqual(2)
  })

  it('respects candidatePool limit', async () => {
    // Create many symbols that will all match the query "handle"
    const symbols: CodeSymbol[] = Array.from({ length: 20 }, (_, i) =>
      makeSymbol(`handleFunc${i}`, 'function', `src/f${i}.ts`, { line: 1, language: 'typescript' }),
    )

    const engine = new SearchEngine()
    engine.buildIndex(symbols)

    // Reranker returns results for all docs it receives
    const mockProvider: RerankerProvider = {
      model: 'mock-reranker',
      rerank: vi.fn().mockImplementation((_query: string, docs: RerankDocument[]) => {
        return docs.map((d, i) => ({
          id: d.id,
          score: 0.9 - i * 0.01,
          index: i,
        }))
      }),
    }

    const rerankerConfig: RerankerConfig = {
      enabled: true,
      provider: mockProvider,
      topN: 10,
      candidatePool: 5,
    }

    const hybrid = new HybridSearchEngine(engine, null, null, {}, rerankerConfig)
    await hybrid.search({ query: 'handle', maxResults: 20 })

    // The reranker should have been called
    expect(mockProvider.rerank).toHaveBeenCalledTimes(1)

    // The reranker should have been called with at most candidatePool documents
    const rerankCall = (mockProvider.rerank as ReturnType<typeof vi.fn>).mock.calls[0]
    const docsPassedToReranker = rerankCall[1] as RerankDocument[]
    expect(docsPassedToReranker.length).toBeLessThanOrEqual(5)
  })
})

// ── Document preparation ────────────────────────────────────────────

describe('Document preparation from SearchResult', () => {
  it('includes signature and documentation in rerank text', async () => {
    const symbols: CodeSymbol[] = [
      makeSymbol('handleRequest', 'function', 'src/api.ts', {
        line: 1,
        language: 'typescript',
        signature: 'function handleRequest(req: Request): Response',
        documentation: 'Handles incoming HTTP requests and returns a Response object.',
      }),
    ]

    const engine = new SearchEngine()
    engine.buildIndex(symbols)

    const mockProvider: RerankerProvider = {
      model: 'mock',
      rerank: vi.fn().mockImplementation((_query: string, docs: RerankDocument[]) => {
        // Verify the document text includes signature, docs, name, and kind
        const text = docs[0].text
        expect(text).toContain('function handleRequest(req: Request): Response')
        expect(text).toContain('Handles incoming HTTP requests')
        expect(text).toContain('function handleRequest')
        return [{ id: docs[0].id, score: 0.9, index: 0 }]
      }),
    }

    const rerankerConfig: RerankerConfig = {
      enabled: true,
      provider: mockProvider,
      topN: 10,
      candidatePool: 50,
    }

    const hybrid = new HybridSearchEngine(engine, null, null, {}, rerankerConfig)
    await hybrid.search({ query: 'handleRequest', maxResults: 10 })

    expect(mockProvider.rerank).toHaveBeenCalledTimes(1)
  })

  it('includes name and kind when no signature or documentation', async () => {
    const symbols: CodeSymbol[] = [
      makeSymbol('processData', 'function', 'src/data.ts', {
        line: 1,
        language: 'typescript',
      }),
    ]

    const engine = new SearchEngine()
    engine.buildIndex(symbols)

    const mockProvider: RerankerProvider = {
      model: 'mock',
      rerank: vi.fn().mockImplementation((_query: string, docs: RerankDocument[]) => {
        const text = docs[0].text
        expect(text).toContain('function processData')
        return [{ id: docs[0].id, score: 0.8, index: 0 }]
      }),
    }

    const rerankerConfig: RerankerConfig = {
      enabled: true,
      provider: mockProvider,
      topN: 10,
      candidatePool: 50,
    }

    const hybrid = new HybridSearchEngine(engine, null, null, {}, rerankerConfig)
    await hybrid.search({ query: 'processData', maxResults: 10 })

    expect(mockProvider.rerank).toHaveBeenCalledTimes(1)
  })
})
