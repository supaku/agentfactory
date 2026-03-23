import { describe, it, expect } from 'vitest'
import { CodeTokenizer } from '../tokenizer.js'
import { InvertedIndex } from '../inverted-index.js'
import { BM25 } from '../bm25.js'
import { SearchEngine } from '../search-engine.js'
import type { CodeSymbol } from '../../types.js'

describe('CodeTokenizer', () => {
  const tokenizer = new CodeTokenizer()

  it('tokenizes simple words', () => {
    const tokens = tokenizer.tokenize('hello world')
    expect(tokens).toContain('hello')
    expect(tokens).toContain('world')
  })

  it('splits camelCase', () => {
    const tokens = tokenizer.tokenize('handleRequest')
    expect(tokens).toContain('handlerequest')
    expect(tokens).toContain('handle')
    expect(tokens).toContain('request')
  })

  it('splits PascalCase', () => {
    const tokens = tokenizer.tokenize('UserService')
    expect(tokens).toContain('userservice')
    expect(tokens).toContain('user')
    expect(tokens).toContain('service')
  })

  it('splits snake_case', () => {
    const tokens = tokenizer.tokenize('get_user_by_id')
    expect(tokens).toContain('get_user_by_id')
    expect(tokens).toContain('get')
    expect(tokens).toContain('user')
  })

  it('splits kebab-case', () => {
    const tokens = tokenizer.tokenize('my-component')
    expect(tokens).toContain('my-component')
    expect(tokens).toContain('my')
    expect(tokens).toContain('component')
  })

  it('handles mixed identifiers', () => {
    const tokens = tokenizer.tokenize('XMLParser')
    expect(tokens).toContain('xmlparser')
  })

  it('strips punctuation', () => {
    const tokens = tokenizer.tokenize('foo(bar, baz)')
    expect(tokens).toContain('foo')
    expect(tokens).toContain('bar')
    expect(tokens).toContain('baz')
  })
})

function makeSymbol(name: string, kind: string, filePath: string, extra?: Partial<CodeSymbol>): CodeSymbol {
  return {
    name,
    kind: kind as any,
    filePath,
    line: 1,
    exported: true,
    ...extra,
  }
}

describe('InvertedIndex', () => {
  it('builds from symbols', () => {
    const index = new InvertedIndex()
    index.build([
      makeSymbol('handleRequest', 'function', 'api.ts'),
      makeSymbol('UserService', 'class', 'service.ts'),
    ])
    expect(index.getDocCount()).toBe(2)
  })

  it('returns postings for matching terms', () => {
    const index = new InvertedIndex()
    index.build([
      makeSymbol('handleRequest', 'function', 'api.ts'),
      makeSymbol('handleResponse', 'function', 'api.ts'),
    ])
    const postings = index.getPostings('handle')
    expect(postings.length).toBe(2)
  })

  it('returns empty for non-matching terms', () => {
    const index = new InvertedIndex()
    index.build([makeSymbol('foo', 'function', 'a.ts')])
    expect(index.getPostings('nonexistent')).toHaveLength(0)
  })

  it('retrieves documents by id', () => {
    const index = new InvertedIndex()
    const symbols = [makeSymbol('foo', 'function', 'a.ts')]
    index.build(symbols)
    expect(index.getDocument(0)?.name).toBe('foo')
    expect(index.getDocument(99)).toBeUndefined()
  })
})

describe('BM25', () => {
  it('scores relevant documents higher', () => {
    const index = new InvertedIndex()
    index.build([
      makeSymbol('handleRequest', 'function', 'api.ts', { documentation: 'Handle HTTP request' }),
      makeSymbol('UserService', 'class', 'service.ts', { documentation: 'User management service' }),
      makeSymbol('requestParser', 'function', 'parser.ts', { documentation: 'Parse the request' }),
    ])

    const bm25 = new BM25()
    const scored = bm25.score('request', index)

    expect(scored.length).toBeGreaterThan(0)
    // requestParser and handleRequest should score higher than UserService
    const names = scored.map(s => index.getDocument(s.docId)?.name)
    expect(names[0]).toMatch(/request/i)
  })

  it('returns empty for no matches', () => {
    const index = new InvertedIndex()
    index.build([makeSymbol('foo', 'function', 'a.ts')])
    const bm25 = new BM25()
    const scored = bm25.score('zzz_nonexistent', index)
    expect(scored).toHaveLength(0)
  })

  it('handles empty index', () => {
    const index = new InvertedIndex()
    index.build([])
    const bm25 = new BM25()
    expect(bm25.score('test', index)).toHaveLength(0)
  })
})

describe('SearchEngine', () => {
  let engine: SearchEngine

  const symbols: CodeSymbol[] = [
    makeSymbol('handleRequest', 'function', 'src/api.ts', { language: 'typescript' }),
    makeSymbol('handleResponse', 'function', 'src/api.ts', { language: 'typescript' }),
    makeSymbol('UserService', 'class', 'src/service.ts', { language: 'typescript' }),
    makeSymbol('getUser', 'method', 'src/service.ts', { language: 'typescript', parentName: 'UserService' }),
    makeSymbol('Config', 'interface', 'src/types.ts', { language: 'typescript' }),
    makeSymbol('helper', 'function', 'lib/utils.js', { language: 'javascript' }),
  ]

  it('searches and returns results', () => {
    engine = new SearchEngine()
    engine.buildIndex(symbols)
    const results = engine.search({ query: 'handleRequest', maxResults: 10 })
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].symbol.name).toBe('handleRequest')
    expect(results[0].matchType).toBe('exact')
  })

  it('boosts exact name matches', () => {
    engine = new SearchEngine()
    engine.buildIndex(symbols)
    const results = engine.search({ query: 'UserService', maxResults: 10 })
    expect(results[0].symbol.name).toBe('UserService')
    expect(results[0].matchType).toBe('exact')
  })

  it('filters by symbol kind', () => {
    engine = new SearchEngine()
    engine.buildIndex(symbols)
    const results = engine.search({
      query: 'handle',
      maxResults: 10,
      symbolKinds: ['function'],
    })
    for (const r of results) {
      expect(r.symbol.kind).toBe('function')
    }
  })

  it('filters by language', () => {
    engine = new SearchEngine()
    engine.buildIndex(symbols)
    const results = engine.search({
      query: 'helper',
      maxResults: 10,
      language: 'javascript',
    })
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].symbol.language).toBe('javascript')
  })

  it('filters by file pattern', () => {
    engine = new SearchEngine()
    engine.buildIndex(symbols)
    const results = engine.search({
      query: 'handle',
      maxResults: 10,
      filePattern: '*.ts',
    })
    for (const r of results) {
      expect(r.symbol.filePath).toMatch(/\.ts$/)
    }
  })

  it('respects maxResults', () => {
    engine = new SearchEngine()
    engine.buildIndex(symbols)
    const results = engine.search({ query: 'handle', maxResults: 1 })
    expect(results.length).toBeLessThanOrEqual(1)
  })

  it('returns stats', () => {
    engine = new SearchEngine()
    engine.buildIndex(symbols)
    const stats = engine.getStats()
    expect(stats.totalSymbols).toBe(6)
    expect(stats.totalTerms).toBeGreaterThan(0)
  })
})
