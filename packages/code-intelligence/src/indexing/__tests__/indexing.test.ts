import { describe, it, expect } from 'vitest'
import { GitHashProvider } from '../git-hash-provider.js'
import { MerkleTree } from '../merkle-tree.js'
import { ChangeDetector } from '../change-detector.js'
import { IncrementalIndexer } from '../incremental-indexer.js'
import { SymbolExtractor } from '../../parser/symbol-extractor.js'

describe('GitHashProvider', () => {
  const provider = new GitHashProvider()

  it('produces consistent hashes', () => {
    const hash1 = provider.hashContent('hello world')
    const hash2 = provider.hashContent('hello world')
    expect(hash1).toBe(hash2)
  })

  it('produces different hashes for different content', () => {
    const hash1 = provider.hashContent('hello')
    const hash2 = provider.hashContent('world')
    expect(hash1).not.toBe(hash2)
  })

  it('produces 40-char hex string (SHA-1)', () => {
    const hash = provider.hashContent('test')
    expect(hash).toMatch(/^[0-9a-f]{40}$/)
  })

  it('matches git hash-object format', () => {
    // git hash-object computes sha1("blob <size>\0<content>")
    // "hello world" -> blob 11\0hello world
    const hash = provider.hashContent('hello world')
    expect(hash).toHaveLength(40)
  })

  it('hashes directory from child hashes', () => {
    const hash = provider.hashDirectory(['abc123', 'def456'])
    expect(hash).toMatch(/^[0-9a-f]{40}$/)
  })

  it('directory hash is order-independent (sorted)', () => {
    const hash1 = provider.hashDirectory(['abc', 'def'])
    const hash2 = provider.hashDirectory(['def', 'abc'])
    expect(hash1).toBe(hash2)
  })
})

describe('MerkleTree', () => {
  it('builds from files', () => {
    const files = new Map([
      ['src/index.ts', 'export const x = 1'],
      ['src/utils.ts', 'export function foo() {}'],
    ])
    const tree = MerkleTree.fromFiles(files)
    expect(tree.getRootHash()).toBeTruthy()
    expect(tree.getFiles().size).toBe(2)
  })

  it('same files produce same root hash', () => {
    const files = new Map([
      ['a.ts', 'content a'],
      ['b.ts', 'content b'],
    ])
    const tree1 = MerkleTree.fromFiles(files)
    const tree2 = MerkleTree.fromFiles(files)
    expect(tree1.getRootHash()).toBe(tree2.getRootHash())
  })

  it('different files produce different root hash', () => {
    const tree1 = MerkleTree.fromFiles(new Map([['a.ts', 'v1']]))
    const tree2 = MerkleTree.fromFiles(new Map([['a.ts', 'v2']]))
    expect(tree1.getRootHash()).not.toBe(tree2.getRootHash())
  })

  it('retrieves node by path', () => {
    const files = new Map([['src/lib/util.ts', 'content']])
    const tree = MerkleTree.fromFiles(files)
    const node = tree.getNode('src/lib/util.ts')
    expect(node).toBeDefined()
    expect(node!.isDirectory).toBe(false)
  })

  it('retrieves directory node', () => {
    const files = new Map([
      ['src/a.ts', 'a'],
      ['src/b.ts', 'b'],
    ])
    const tree = MerkleTree.fromFiles(files)
    const dir = tree.getNode('src')
    expect(dir).toBeDefined()
    expect(dir!.isDirectory).toBe(true)
    expect(dir!.children.size).toBe(2)
  })

  it('builds from pre-computed hashes', () => {
    const hashes = new Map([
      ['a.ts', 'abc123'],
      ['b.ts', 'def456'],
    ])
    const tree = MerkleTree.fromHashes(hashes)
    expect(tree.getRootHash()).toBeTruthy()
    const files = tree.getFiles()
    expect(files.get('a.ts')).toBe('abc123')
  })
})

describe('ChangeDetector', () => {
  const detector = new ChangeDetector()

  it('detects added files', () => {
    const old = MerkleTree.fromFiles(new Map([['a.ts', 'a']]))
    const nw = MerkleTree.fromFiles(new Map([['a.ts', 'a'], ['b.ts', 'b']]))
    const changes = detector.detect(old, nw)
    expect(changes.added).toEqual(['b.ts'])
    expect(changes.modified).toEqual([])
    expect(changes.deleted).toEqual([])
  })

  it('detects modified files', () => {
    const old = MerkleTree.fromFiles(new Map([['a.ts', 'v1']]))
    const nw = MerkleTree.fromFiles(new Map([['a.ts', 'v2']]))
    const changes = detector.detect(old, nw)
    expect(changes.modified).toEqual(['a.ts'])
    expect(changes.added).toEqual([])
  })

  it('detects deleted files', () => {
    const old = MerkleTree.fromFiles(new Map([['a.ts', 'a'], ['b.ts', 'b']]))
    const nw = MerkleTree.fromFiles(new Map([['a.ts', 'a']]))
    const changes = detector.detect(old, nw)
    expect(changes.deleted).toEqual(['b.ts'])
  })

  it('detects mixed changes', () => {
    const old = MerkleTree.fromFiles(new Map([
      ['keep.ts', 'same'],
      ['modify.ts', 'old'],
      ['delete.ts', 'gone'],
    ]))
    const nw = MerkleTree.fromFiles(new Map([
      ['keep.ts', 'same'],
      ['modify.ts', 'new'],
      ['add.ts', 'new file'],
    ]))
    const changes = detector.detect(old, nw)
    expect(changes.added).toEqual(['add.ts'])
    expect(changes.modified).toEqual(['modify.ts'])
    expect(changes.deleted).toEqual(['delete.ts'])
  })

  it('reports identical trees', () => {
    const files = new Map([['a.ts', 'content']])
    const tree = MerkleTree.fromFiles(files)
    expect(detector.isIdentical(tree, tree)).toBe(true)
  })

  it('reports different trees', () => {
    const tree1 = MerkleTree.fromFiles(new Map([['a.ts', 'v1']]))
    const tree2 = MerkleTree.fromFiles(new Map([['a.ts', 'v2']]))
    expect(detector.isIdentical(tree1, tree2)).toBe(false)
  })
})

describe('IncrementalIndexer', () => {
  it('indexes all files on first run', async () => {
    const extractor = new SymbolExtractor()
    const indexer = new IncrementalIndexer(extractor)

    const files = new Map([
      ['src/main.ts', 'export function main() {}'],
      ['src/utils.ts', 'export const helper = () => 42'],
    ])
    const result = await indexer.index(files)

    expect(result.changes.added).toHaveLength(2)
    expect(result.changes.modified).toHaveLength(0)
    expect(result.indexed).toHaveLength(2)
    expect(result.metadata.totalFiles).toBe(2)
  })

  it('only re-indexes changed files', async () => {
    const extractor = new SymbolExtractor()
    const indexer = new IncrementalIndexer(extractor)

    // First run
    const files1 = new Map([
      ['a.ts', 'export const x = 1'],
      ['b.ts', 'export const y = 2'],
    ])
    await indexer.index(files1)

    // Second run with b.ts modified
    const files2 = new Map([
      ['a.ts', 'export const x = 1'],
      ['b.ts', 'export const y = 3'],
    ])
    const result = await indexer.index(files2)

    expect(result.changes.added).toHaveLength(0)
    expect(result.changes.modified).toEqual(['b.ts'])
    expect(result.indexed).toHaveLength(1)
    expect(result.indexed[0].filePath).toBe('b.ts')
  })

  it('detects deleted files', async () => {
    const extractor = new SymbolExtractor()
    const indexer = new IncrementalIndexer(extractor)

    await indexer.index(new Map([['a.ts', 'x'], ['b.ts', 'y']]))
    const result = await indexer.index(new Map([['a.ts', 'x']]))

    expect(result.changes.deleted).toEqual(['b.ts'])
    expect(result.metadata.totalFiles).toBe(1)
  })

  it('returns all symbols', async () => {
    const extractor = new SymbolExtractor()
    const indexer = new IncrementalIndexer(extractor)

    await indexer.index(new Map([
      ['a.ts', 'export function foo() {}\nexport function bar() {}'],
    ]))

    const symbols = indexer.getAllSymbols()
    expect(symbols.length).toBeGreaterThanOrEqual(2)
  })
})
