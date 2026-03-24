import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { VoyageCodeProvider } from '../voyage-provider.js'
import { Chunker } from '../chunker.js'
import type { FileAST, CodeSymbol } from '../../types.js'

// ── Helpers ──────────────────────────────────────────────────────────

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

/** Build a Voyage API success response for N inputs of D dimensions. */
function voyageSuccessResponse(count: number, dimensions: number = 256) {
  return {
    data: Array.from({ length: count }, (_, i) => ({
      embedding: Array.from({ length: dimensions }, (_, j) => (i + 1) * 0.01 + j * 0.001),
      index: i,
    })),
    model: 'voyage-code-3',
    usage: { total_tokens: count * 10 },
  }
}

// ── VoyageCodeProvider ───────────────────────────────────────────────

describe('VoyageCodeProvider', () => {
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env.VOYAGE_API_KEY
    process.env.VOYAGE_API_KEY = 'test-api-key'
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
    expect(() => new VoyageCodeProvider()).toThrow('VOYAGE_API_KEY')
  })

  it('uses default config values', () => {
    const provider = new VoyageCodeProvider()
    expect(provider.model).toBe('voyage-code-3')
    expect(provider.dimensions).toBe(256)
  })

  it('accepts custom config values', () => {
    const provider = new VoyageCodeProvider({
      model: 'voyage-code-3',
      dimensions: 1024,
      batchSize: 64,
      maxRetries: 5,
    })
    expect(provider.dimensions).toBe(1024)
  })

  it('embeds a single query', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockFetchResponse(200, voyageSuccessResponse(1)),
    )

    const provider = new VoyageCodeProvider()
    const result = await provider.embedQuery('function hello()')

    expect(result).toHaveLength(256)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // Verify the request body includes input_type: 'query'
    const callArgs = fetchSpy.mock.calls[0]
    const body = JSON.parse(callArgs[1]!.body as string)
    expect(body.input_type).toBe('query')
    expect(body.output_dimension).toBe(256)
  })

  it('embeds a batch of texts', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockFetchResponse(200, voyageSuccessResponse(3)),
    )

    const provider = new VoyageCodeProvider()
    const results = await provider.embed(['text 1', 'text 2', 'text 3'])

    expect(results).toHaveLength(3)
    expect(results[0]).toHaveLength(256)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // Verify the request body includes input_type: 'document'
    const callArgs = fetchSpy.mock.calls[0]
    const body = JSON.parse(callArgs[1]!.body as string)
    expect(body.input_type).toBe('document')
  })

  it('returns empty array for empty input', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const provider = new VoyageCodeProvider()
    const results = await provider.embed([])

    expect(results).toHaveLength(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('splits large batches into chunks of 128', async () => {
    // Create 300 texts, should be split into 3 batches (128 + 128 + 44)
    const texts = Array.from({ length: 300 }, (_, i) => `text ${i}`)

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockFetchResponse(200, voyageSuccessResponse(128)))
      .mockResolvedValueOnce(mockFetchResponse(200, voyageSuccessResponse(128)))
      .mockResolvedValueOnce(mockFetchResponse(200, voyageSuccessResponse(44)))

    const provider = new VoyageCodeProvider()
    const results = await provider.embed(texts)

    expect(results).toHaveLength(300)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('retries on 429 rate limit', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        mockFetchResponse(429, { detail: 'Rate limited' }),
      )
      .mockResolvedValueOnce(
        mockFetchResponse(200, voyageSuccessResponse(1)),
      )

    const provider = new VoyageCodeProvider({ maxRetries: 3 })
    // Mock sleep to avoid waiting
    vi.spyOn(provider as any, 'sleep').mockResolvedValue(undefined)

    const result = await provider.embedQuery('test')
    expect(result).toHaveLength(256)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('retries on 5xx server errors', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        mockFetchResponse(503, { detail: 'Service unavailable' }),
      )
      .mockResolvedValueOnce(
        mockFetchResponse(500, { detail: 'Internal error' }),
      )
      .mockResolvedValueOnce(
        mockFetchResponse(200, voyageSuccessResponse(1)),
      )

    const provider = new VoyageCodeProvider({ maxRetries: 3 })
    vi.spyOn(provider as any, 'sleep').mockResolvedValue(undefined)

    const result = await provider.embedQuery('test')
    expect(result).toHaveLength(256)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('throws after exhausting retries', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        mockFetchResponse(429, { detail: 'Rate limited' }),
      )

    const provider = new VoyageCodeProvider({ maxRetries: 2 })
    vi.spyOn(provider as any, 'sleep').mockResolvedValue(undefined)

    await expect(provider.embedQuery('test')).rejects.toThrow('429')
  })

  it('throws immediately on 4xx non-retryable errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockFetchResponse(401, { detail: 'Invalid API key' }),
    )

    const provider = new VoyageCodeProvider()

    await expect(provider.embedQuery('test')).rejects.toThrow('Invalid API key')
  })

  it('respects Retry-After header', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        mockFetchResponse(429, { detail: 'Rate limited' }, { 'retry-after': '5' }),
      )
      .mockResolvedValueOnce(
        mockFetchResponse(200, voyageSuccessResponse(1)),
      )

    const provider = new VoyageCodeProvider({ maxRetries: 3 })
    const sleepSpy = vi.spyOn(provider as any, 'sleep').mockResolvedValue(undefined)

    await provider.embedQuery('test')

    // Should have waited 5000ms (5 seconds from Retry-After header)
    expect(sleepSpy).toHaveBeenCalledWith(5000)
  })

  it('sends correct Authorization header', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockFetchResponse(200, voyageSuccessResponse(1)),
    )

    const provider = new VoyageCodeProvider()
    await provider.embedQuery('test')

    const callArgs = fetchSpy.mock.calls[0]
    const headers = callArgs[1]!.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer test-api-key')
  })
})

// ── Chunker ──────────────────────────────────────────────────────────

describe('Chunker', () => {
  it('creates a chunk from a simple symbol', () => {
    const chunker = new Chunker()
    const ast = makeFileAST('src/utils.ts', 'typescript', [
      makeSymbol('add', 'function', 'src/utils.ts', {
        line: 0,
        endLine: 3,
        signature: 'function add(a: number, b: number): number',
        documentation: 'Adds two numbers.',
      }),
    ])

    const fileContent = [
      'function add(a: number, b: number): number {',
      '  // Adds two numbers.',
      '  return a + b',
      '}',
    ].join('\n')

    const chunks = chunker.chunkFile(ast, fileContent)

    expect(chunks).toHaveLength(1)
    expect(chunks[0].id).toBe('src/utils.ts:add:0')
    expect(chunks[0].content).toContain('function add(a: number, b: number): number')
    expect(chunks[0].content).toContain('Adds two numbers.')
    expect(chunks[0].metadata.filePath).toBe('src/utils.ts')
    expect(chunks[0].metadata.symbolName).toBe('add')
    expect(chunks[0].metadata.symbolKind).toBe('function')
    expect(chunks[0].metadata.startLine).toBe(0)
    expect(chunks[0].metadata.endLine).toBe(3)
    expect(chunks[0].metadata.language).toBe('typescript')
  })

  it('creates chunks for multiple symbols in a file', () => {
    const chunker = new Chunker()
    const ast = makeFileAST('src/math.ts', 'typescript', [
      makeSymbol('add', 'function', 'src/math.ts', { line: 0, endLine: 2 }),
      makeSymbol('subtract', 'function', 'src/math.ts', { line: 4, endLine: 6 }),
      makeSymbol('MathHelper', 'class', 'src/math.ts', { line: 8, endLine: 20 }),
    ])

    const chunks = chunker.chunkFile(ast)
    expect(chunks).toHaveLength(3)
    expect(chunks[0].metadata.symbolName).toBe('add')
    expect(chunks[1].metadata.symbolName).toBe('subtract')
    expect(chunks[2].metadata.symbolName).toBe('MathHelper')
  })

  it('handles symbols without endLine as single-line', () => {
    const chunker = new Chunker()
    const ast = makeFileAST('src/types.ts', 'typescript', [
      makeSymbol('Config', 'type', 'src/types.ts', { line: 5 }),
    ])

    const chunks = chunker.chunkFile(ast)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].metadata.startLine).toBe(5)
    expect(chunks[0].metadata.endLine).toBe(5)
  })

  it('handles symbols without signature or documentation', () => {
    const chunker = new Chunker()
    const ast = makeFileAST('src/utils.ts', 'typescript', [
      makeSymbol('helper', 'function', 'src/utils.ts', { line: 0, endLine: 2 }),
    ])

    const fileContent = 'function helper() {\n  return true\n}'
    const chunks = chunker.chunkFile(ast, fileContent)

    expect(chunks).toHaveLength(1)
    expect(chunks[0].content).toContain('function helper()')
  })

  it('uses sliding window for large symbols', () => {
    const chunker = new Chunker({ maxChunkLines: 10, overlapLines: 2 })

    const ast = makeFileAST('src/big.ts', 'typescript', [
      makeSymbol('bigFunction', 'function', 'src/big.ts', {
        line: 0,
        endLine: 24,
        signature: 'function bigFunction(): void',
      }),
    ])

    // Create 25 lines of content
    const lines = Array.from({ length: 25 }, (_, i) => `  line ${i}`)
    const fileContent = lines.join('\n')

    const chunks = chunker.chunkFile(ast, fileContent)

    // 25 lines with maxChunkLines=10, overlap=2 => step=8
    // Window 0: 0-9, Window 1: 8-17, Window 2: 16-24, Window 3: 24-24
    expect(chunks.length).toBe(4)

    // First chunk should have signature prepended
    expect(chunks[0].content).toContain('function bigFunction(): void')
    expect(chunks[0].id).toBe('src/big.ts:bigFunction:0')
    expect(chunks[0].metadata.startLine).toBe(0)
    expect(chunks[0].metadata.endLine).toBe(9)

    // Second chunk
    expect(chunks[1].id).toBe('src/big.ts:bigFunction:8:1')
    expect(chunks[1].metadata.startLine).toBe(8)
    expect(chunks[1].metadata.endLine).toBe(17)

    // Third chunk
    expect(chunks[2].id).toBe('src/big.ts:bigFunction:16:2')
    expect(chunks[2].metadata.startLine).toBe(16)
    expect(chunks[2].metadata.endLine).toBe(24)

    // Fourth chunk (tail)
    expect(chunks[3].id).toBe('src/big.ts:bigFunction:24:3')
    expect(chunks[3].metadata.startLine).toBe(24)
    expect(chunks[3].metadata.endLine).toBe(24)
  })

  it('sliding window chunks overlap correctly', () => {
    const chunker = new Chunker({ maxChunkLines: 10, overlapLines: 3 })

    const ast = makeFileAST('src/big.ts', 'typescript', [
      makeSymbol('fn', 'function', 'src/big.ts', { line: 0, endLine: 19 }),
    ])

    // 20 lines total
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`)
    const fileContent = lines.join('\n')

    const chunks = chunker.chunkFile(ast, fileContent)

    // step = 10 - 3 = 7
    // Window 0: 0-9, Window 1: 7-16, Window 2: 14-19 => 3 chunks
    expect(chunks.length).toBe(3)

    // Lines 7-9 should appear in both first and second chunk (overlap)
    expect(chunks[0].content).toContain('line 7')
    expect(chunks[0].content).toContain('line 9')
    expect(chunks[1].content).toContain('line 7')
    expect(chunks[1].content).toContain('line 9')
  })

  it('chunks multiple FileASTs via chunkFiles', () => {
    const chunker = new Chunker()
    const asts: FileAST[] = [
      makeFileAST('a.ts', 'typescript', [
        makeSymbol('foo', 'function', 'a.ts', { line: 0, endLine: 5 }),
      ]),
      makeFileAST('b.py', 'python', [
        makeSymbol('bar', 'function', 'b.py', { line: 0, endLine: 3 }),
        makeSymbol('baz', 'class', 'b.py', { line: 5, endLine: 15 }),
      ]),
    ]

    const chunks = chunker.chunkFiles(asts)
    expect(chunks).toHaveLength(3)
    expect(chunks[0].metadata.language).toBe('typescript')
    expect(chunks[1].metadata.language).toBe('python')
    expect(chunks[2].metadata.language).toBe('python')
  })

  it('uses file contents map in chunkFiles', () => {
    const chunker = new Chunker()
    const asts: FileAST[] = [
      makeFileAST('a.ts', 'typescript', [
        makeSymbol('hello', 'function', 'a.ts', { line: 0, endLine: 2 }),
      ]),
    ]
    const contents = new Map([
      ['a.ts', 'function hello() {\n  return "world"\n}'],
    ])

    const chunks = chunker.chunkFiles(asts, contents)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].content).toContain('return "world"')
  })

  it('produces valid chunk ids', () => {
    const chunker = new Chunker()
    const ast = makeFileAST('src/index.ts', 'typescript', [
      makeSymbol('main', 'function', 'src/index.ts', { line: 10, endLine: 20 }),
    ])

    const chunks = chunker.chunkFile(ast)
    expect(chunks[0].id).toBe('src/index.ts:main:10')
  })

  it('handles empty symbol list', () => {
    const chunker = new Chunker()
    const ast = makeFileAST('empty.ts', 'typescript', [])
    const chunks = chunker.chunkFile(ast)
    expect(chunks).toHaveLength(0)
  })

  it('uses symbol name and kind when no body, signature, or docs available', () => {
    const chunker = new Chunker()
    const ast = makeFileAST('src/types.ts', 'typescript', [
      makeSymbol('MyInterface', 'interface', 'src/types.ts', { line: 0 }),
    ])

    // No file content provided, no signature, no docs
    const chunks = chunker.chunkFile(ast)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].content).toBe('interface MyInterface')
  })
})
