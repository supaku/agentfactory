import { describe, it, expect } from 'vitest'
import { DependencyGraph } from '../dependency-graph.js'
import { PageRank } from '../pagerank.js'
import { RepoMapGenerator } from '../repo-map-generator.js'
import type { FileAST } from '../../types.js'

describe('DependencyGraph', () => {
  it('builds from ASTs', () => {
    const graph = new DependencyGraph()
    const asts: FileAST[] = [
      { filePath: 'src/index.ts', language: 'typescript', symbols: [], imports: ['./utils'], exports: ['main'] },
      { filePath: 'src/utils.ts', language: 'typescript', symbols: [], imports: [], exports: ['helper'] },
    ]
    graph.buildFromASTs(asts)
    expect(graph.getFiles()).toHaveLength(2)
  })

  it('resolves relative imports', () => {
    const graph = new DependencyGraph()
    const asts: FileAST[] = [
      { filePath: 'src/index.ts', language: 'typescript', symbols: [], imports: ['./utils'], exports: [] },
      { filePath: 'src/utils.ts', language: 'typescript', symbols: [], imports: [], exports: [] },
    ]
    graph.buildFromASTs(asts)
    const deps = graph.getDependencies('src/index.ts')
    expect(deps).toContain('src/utils.ts')
  })

  it('tracks dependents', () => {
    const graph = new DependencyGraph()
    const asts: FileAST[] = [
      { filePath: 'src/index.ts', language: 'typescript', symbols: [], imports: ['./utils'], exports: [] },
      { filePath: 'src/utils.ts', language: 'typescript', symbols: [], imports: [], exports: [] },
    ]
    graph.buildFromASTs(asts)
    const dependents = graph.getDependents('src/utils.ts')
    expect(dependents).toContain('src/index.ts')
  })

  it('ignores node_modules imports', () => {
    const graph = new DependencyGraph()
    const asts: FileAST[] = [
      { filePath: 'src/index.ts', language: 'typescript', symbols: [], imports: ['express', './utils'], exports: [] },
      { filePath: 'src/utils.ts', language: 'typescript', symbols: [], imports: [], exports: [] },
    ]
    graph.buildFromASTs(asts)
    const deps = graph.getDependencies('src/index.ts')
    expect(deps).toHaveLength(1) // only ./utils
  })

  it('computes in-degrees', () => {
    const graph = new DependencyGraph()
    const asts: FileAST[] = [
      { filePath: 'src/a.ts', language: 'typescript', symbols: [], imports: ['./shared'], exports: [] },
      { filePath: 'src/b.ts', language: 'typescript', symbols: [], imports: ['./shared'], exports: [] },
      { filePath: 'src/shared.ts', language: 'typescript', symbols: [], imports: [], exports: [] },
    ]
    graph.buildFromASTs(asts)
    const degrees = graph.getInDegrees()
    expect(degrees.get('src/shared.ts')).toBe(2)
  })

  it('returns edges', () => {
    const graph = new DependencyGraph()
    const asts: FileAST[] = [
      { filePath: 'src/a.ts', language: 'typescript', symbols: [], imports: ['./b'], exports: [] },
      { filePath: 'src/b.ts', language: 'typescript', symbols: [], imports: [], exports: [] },
    ]
    graph.buildFromASTs(asts)
    const edges = graph.getEdges()
    expect(edges).toHaveLength(1)
    expect(edges[0].from).toBe('src/a.ts')
    expect(edges[0].to).toBe('src/b.ts')
  })
})

describe('PageRank', () => {
  it('ranks hub files higher', () => {
    const pr = new PageRank()
    const adj = new Map<string, Set<string>>([
      ['a', new Set(['hub'])],
      ['b', new Set(['hub'])],
      ['c', new Set(['hub'])],
      ['hub', new Set(['d'])],
      ['d', new Set()],
    ])
    const scores = pr.compute(adj)
    expect(scores.get('hub')!).toBeGreaterThan(scores.get('a')!)
  })

  it('handles empty graph', () => {
    const pr = new PageRank()
    const scores = pr.compute(new Map())
    expect(scores.size).toBe(0)
  })

  it('assigns non-zero scores to all nodes', () => {
    const pr = new PageRank()
    const adj = new Map<string, Set<string>>([
      ['a', new Set(['b'])],
      ['b', new Set(['c'])],
      ['c', new Set(['a'])],
    ])
    const scores = pr.compute(adj)
    for (const score of scores.values()) {
      expect(score).toBeGreaterThan(0)
    }
  })

  it('scores sum approximately to 1', () => {
    const pr = new PageRank()
    const adj = new Map<string, Set<string>>([
      ['a', new Set(['b'])],
      ['b', new Set(['c'])],
      ['c', new Set(['a'])],
    ])
    const scores = pr.compute(adj)
    const sum = [...scores.values()].reduce((s, v) => s + v, 0)
    expect(sum).toBeCloseTo(1, 1)
  })

  it('converges with damping factor', () => {
    const pr = new PageRank({ damping: 0.85 })
    const adj = new Map<string, Set<string>>([
      ['a', new Set(['b', 'c'])],
      ['b', new Set(['c'])],
      ['c', new Set(['a'])],
    ])
    const scores = pr.compute(adj)
    expect(scores.size).toBe(3)
  })
})

describe('RepoMapGenerator', () => {
  const asts: FileAST[] = [
    {
      filePath: 'src/index.ts', language: 'typescript',
      symbols: [
        { name: 'main', kind: 'function', filePath: 'src/index.ts', line: 1, exported: true },
      ],
      imports: ['./service', './utils'],
      exports: ['main'],
    },
    {
      filePath: 'src/service.ts', language: 'typescript',
      symbols: [
        { name: 'UserService', kind: 'class', filePath: 'src/service.ts', line: 5, exported: true },
      ],
      imports: ['./utils'],
      exports: ['UserService'],
    },
    {
      filePath: 'src/utils.ts', language: 'typescript',
      symbols: [
        { name: 'helper', kind: 'function', filePath: 'src/utils.ts', line: 1, exported: true },
        { name: 'format', kind: 'function', filePath: 'src/utils.ts', line: 10, exported: true },
      ],
      imports: [],
      exports: ['helper', 'format'],
    },
  ]

  it('generates repo map entries', () => {
    const gen = new RepoMapGenerator()
    const entries = gen.generate(asts)
    expect(entries.length).toBe(3)
  })

  it('ranks most-imported files higher', () => {
    const gen = new RepoMapGenerator()
    const entries = gen.generate(asts)
    // utils is imported by both index and service, should rank high
    const utilsRank = entries.find(e => e.filePath === 'src/utils.ts')?.rank ?? 0
    const indexRank = entries.find(e => e.filePath === 'src/index.ts')?.rank ?? 0
    expect(utilsRank).toBeGreaterThanOrEqual(indexRank)
  })

  it('includes exported symbols', () => {
    const gen = new RepoMapGenerator()
    const entries = gen.generate(asts)
    const utils = entries.find(e => e.filePath === 'src/utils.ts')
    expect(utils?.symbols.length).toBe(2)
  })

  it('respects maxFiles', () => {
    const gen = new RepoMapGenerator()
    const entries = gen.generate(asts, { maxFiles: 2 })
    expect(entries.length).toBe(2)
  })

  it('formats as text', () => {
    const gen = new RepoMapGenerator()
    const entries = gen.generate(asts)
    const text = gen.format(entries)
    expect(text).toContain('# Repository Map')
    expect(text).toContain('src/utils.ts')
    expect(text).toContain('function: helper')
  })

  it('filters by file pattern', () => {
    const gen = new RepoMapGenerator()
    const entries = gen.generate(asts, { filePatterns: ['*service*'] })
    expect(entries.every(e => e.filePath.includes('service'))).toBe(true)
  })
})
