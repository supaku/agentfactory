import { describe, it, expect } from 'vitest'
import {
  SymbolKindSchema,
  CodeSymbolSchema,
  FileASTSchema,
  FileIndexSchema,
  SearchQuerySchema,
  SearchResultSchema,
  MemoryEntrySchema,
  DedupResultSchema,
  IndexMetadataSchema,
  RepoMapEntrySchema,
} from '../types.js'

describe('SymbolKindSchema', () => {
  it('accepts valid symbol kinds', () => {
    const kinds = ['function', 'class', 'interface', 'type', 'variable', 'method',
      'property', 'import', 'export', 'enum', 'struct', 'trait', 'impl', 'macro',
      'decorator', 'module']
    for (const kind of kinds) {
      expect(SymbolKindSchema.parse(kind)).toBe(kind)
    }
  })

  it('rejects invalid symbol kinds', () => {
    expect(() => SymbolKindSchema.parse('invalid')).toThrow()
  })
})

describe('CodeSymbolSchema', () => {
  it('parses a valid symbol', () => {
    const symbol = CodeSymbolSchema.parse({
      name: 'myFunction',
      kind: 'function',
      filePath: 'src/utils.ts',
      line: 10,
      exported: true,
      signature: 'function myFunction(x: number): string',
    })
    expect(symbol.name).toBe('myFunction')
    expect(symbol.kind).toBe('function')
    expect(symbol.exported).toBe(true)
  })

  it('applies defaults', () => {
    const symbol = CodeSymbolSchema.parse({
      name: 'x',
      kind: 'variable',
      filePath: 'a.ts',
      line: 0,
    })
    expect(symbol.exported).toBe(false)
  })

  it('rejects empty name', () => {
    expect(() => CodeSymbolSchema.parse({
      name: '',
      kind: 'function',
      filePath: 'a.ts',
      line: 0,
    })).toThrow()
  })

  it('rejects negative line number', () => {
    expect(() => CodeSymbolSchema.parse({
      name: 'x',
      kind: 'function',
      filePath: 'a.ts',
      line: -1,
    })).toThrow()
  })
})

describe('FileASTSchema', () => {
  it('parses valid file AST', () => {
    const ast = FileASTSchema.parse({
      filePath: 'src/main.ts',
      language: 'typescript',
      symbols: [{
        name: 'main',
        kind: 'function',
        filePath: 'src/main.ts',
        line: 1,
      }],
      imports: ['./utils'],
      exports: ['main'],
    })
    expect(ast.symbols).toHaveLength(1)
    expect(ast.imports).toEqual(['./utils'])
  })
})

describe('FileIndexSchema', () => {
  it('parses valid file index', () => {
    const idx = FileIndexSchema.parse({
      filePath: 'src/lib.ts',
      gitHash: 'abc123def456',
      symbols: [],
      lastIndexed: Date.now(),
    })
    expect(idx.gitHash).toBe('abc123def456')
  })
})

describe('SearchQuerySchema', () => {
  it('parses minimal query', () => {
    const q = SearchQuerySchema.parse({ query: 'myFunc' })
    expect(q.query).toBe('myFunc')
    expect(q.maxResults).toBe(20)
  })

  it('parses full query', () => {
    const q = SearchQuerySchema.parse({
      query: 'handler',
      maxResults: 10,
      filePattern: '*.ts',
      symbolKinds: ['function', 'method'],
      language: 'typescript',
    })
    expect(q.symbolKinds).toEqual(['function', 'method'])
  })

  it('rejects empty query', () => {
    expect(() => SearchQuerySchema.parse({ query: '' })).toThrow()
  })
})

describe('SearchResultSchema', () => {
  it('parses valid result', () => {
    const result = SearchResultSchema.parse({
      symbol: {
        name: 'foo',
        kind: 'function',
        filePath: 'a.ts',
        line: 5,
      },
      score: 1.5,
      matchType: 'bm25',
    })
    expect(result.score).toBe(1.5)
    expect(result.matchType).toBe('bm25')
  })
})

describe('MemoryEntrySchema', () => {
  it('parses valid entry', () => {
    const entry = MemoryEntrySchema.parse({
      id: 'mem-001',
      content: 'Some content',
      xxhash: 'abcdef0123456789',
      simhash: BigInt('0xdeadbeef'),
      createdAt: Date.now(),
      metadata: { source: 'test' },
    })
    expect(entry.id).toBe('mem-001')
    expect(typeof entry.simhash).toBe('bigint')
  })
})

describe('DedupResultSchema', () => {
  it('parses exact match', () => {
    const result = DedupResultSchema.parse({
      isDuplicate: true,
      matchType: 'exact',
      existingId: 'mem-001',
    })
    expect(result.isDuplicate).toBe(true)
  })

  it('parses near match', () => {
    const result = DedupResultSchema.parse({
      isDuplicate: true,
      matchType: 'near',
      existingId: 'mem-002',
      hammingDistance: 2,
    })
    expect(result.hammingDistance).toBe(2)
  })

  it('parses no match', () => {
    const result = DedupResultSchema.parse({
      isDuplicate: false,
      matchType: 'none',
    })
    expect(result.existingId).toBeUndefined()
  })
})

describe('IndexMetadataSchema', () => {
  it('parses valid metadata', () => {
    const meta = IndexMetadataSchema.parse({
      version: 1,
      rootHash: 'abc123',
      totalFiles: 100,
      totalSymbols: 1500,
      lastUpdated: Date.now(),
      languages: ['typescript', 'javascript'],
    })
    expect(meta.totalFiles).toBe(100)
  })
})

describe('RepoMapEntrySchema', () => {
  it('parses valid entry', () => {
    const entry = RepoMapEntrySchema.parse({
      filePath: 'src/index.ts',
      rank: 0.85,
      symbols: [
        { name: 'main', kind: 'function', line: 1 },
        { name: 'Config', kind: 'interface', line: 20 },
      ],
    })
    expect(entry.symbols).toHaveLength(2)
    expect(entry.rank).toBe(0.85)
  })
})
