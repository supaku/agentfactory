import { describe, it, expect } from 'vitest'
import { ConflictGraph, buildConflictGraph } from './conflict-graph.js'

describe('ConflictGraph', () => {
  it('detects no conflict between PRs with disjoint files', () => {
    const graph = new ConflictGraph()
    graph.addPR(1, ['src/a.ts', 'src/b.ts'])
    graph.addPR(2, ['src/c.ts', 'src/d.ts'])

    expect(graph.conflicts(1, 2)).toBe(false)
    expect(graph.sharedFiles(1, 2)).toEqual([])
  })

  it('detects conflict between PRs with overlapping files', () => {
    const graph = new ConflictGraph()
    graph.addPR(1, ['src/a.ts', 'src/b.ts'])
    graph.addPR(2, ['src/b.ts', 'src/c.ts'])

    expect(graph.conflicts(1, 2)).toBe(true)
    expect(graph.sharedFiles(1, 2)).toEqual(['src/b.ts'])
  })

  it('treats empty file lists as universal conflicts', () => {
    const graph = new ConflictGraph()
    graph.addPR(1, ['src/a.ts'])
    graph.addPR(2, [])  // Unknown files — conflicts with everything

    expect(graph.conflicts(1, 2)).toBe(true)
  })

  it('finds independent batches for non-conflicting PRs', () => {
    const graph = new ConflictGraph()
    graph.addPR(1, ['src/a.ts'])
    graph.addPR(2, ['src/b.ts'])
    graph.addPR(3, ['src/c.ts'])

    const batches = graph.findIndependentBatches()
    // All 3 are independent — should be in one batch
    expect(batches).toHaveLength(1)
    expect(batches[0]).toEqual([1, 2, 3])
  })

  it('separates conflicting PRs into different batches', () => {
    const graph = new ConflictGraph()
    graph.addPR(1, ['src/a.ts'])
    graph.addPR(2, ['src/a.ts'])  // Conflicts with PR 1
    graph.addPR(3, ['src/b.ts'])  // Independent

    const batches = graph.findIndependentBatches()
    expect(batches).toHaveLength(2)
    // PR 1 and 3 can go together, PR 2 must be separate
    expect(batches[0]).toContain(1)
    expect(batches[0]).toContain(3)
    expect(batches[1]).toContain(2)
  })

  it('respects maxBatchSize', () => {
    const graph = new ConflictGraph()
    graph.addPR(1, ['src/a.ts'])
    graph.addPR(2, ['src/b.ts'])
    graph.addPR(3, ['src/c.ts'])

    const batches = graph.findIndependentBatches(2)
    expect(batches).toHaveLength(2)
    expect(batches[0]).toHaveLength(2)
    expect(batches[1]).toHaveLength(1)
  })

  it('handles complex conflict chains', () => {
    const graph = new ConflictGraph()
    // PR 1 conflicts with PR 2
    // PR 2 conflicts with PR 3
    // PR 1 does NOT conflict with PR 3
    graph.addPR(1, ['src/a.ts'])
    graph.addPR(2, ['src/a.ts', 'src/b.ts'])
    graph.addPR(3, ['src/b.ts'])

    const batches = graph.findIndependentBatches()
    expect(batches).toHaveLength(2)
    // PR 1 and 3 can merge together (no shared files)
    expect(batches[0]).toContain(1)
    expect(batches[0]).toContain(3)
    // PR 2 must be separate (conflicts with both)
    expect(batches[1]).toContain(2)
  })

  it('returns empty batches for empty graph', () => {
    const graph = new ConflictGraph()
    expect(graph.findIndependentBatches()).toEqual([])
    expect(graph.size).toBe(0)
  })
})

describe('buildConflictGraph', () => {
  it('builds graph from PR file manifests', () => {
    const graph = buildConflictGraph([
      { prNumber: 1, sourceBranch: 'feat-1', files: ['src/a.ts'], computedAt: 0 },
      { prNumber: 2, sourceBranch: 'feat-2', files: ['src/b.ts'], computedAt: 0 },
      { prNumber: 3, sourceBranch: 'feat-3', files: ['src/a.ts', 'src/c.ts'], computedAt: 0 },
    ])

    expect(graph.size).toBe(3)
    expect(graph.conflicts(1, 2)).toBe(false)
    expect(graph.conflicts(1, 3)).toBe(true)
    expect(graph.conflicts(2, 3)).toBe(false)
  })
})
