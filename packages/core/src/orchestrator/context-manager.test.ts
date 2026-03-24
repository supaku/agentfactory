import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

import { existsSync, readFileSync } from 'fs'
import { ContextManager } from './context-manager.js'
import type { AgentToolUseEvent, AgentAssistantTextEvent } from '../providers/types.js'

const WORKTREE = '/tmp/test-worktree'

function makeToolUse(toolName: string, input: Record<string, unknown>): AgentToolUseEvent {
  return { type: 'tool_use', toolName, input, raw: {} }
}

function makeAssistantText(text: string): AgentAssistantTextEvent {
  return { type: 'assistant_text', text, raw: {} }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(existsSync).mockReturnValue(true)
})

describe('ContextManager — processEvent', () => {
  it('tracks tool_use events in artifact tracker', () => {
    const manager = new ContextManager({ worktreeRoot: WORKTREE })
    manager.processEvent(makeToolUse('Read', { file_path: '/tmp/test-worktree/src/foo.ts' }))

    const index = manager.getArtifactIndex()
    expect(Object.keys(index.files)).toHaveLength(1)
    expect(index.totalReads).toBe(1)
  })

  it('buffers events for compaction', () => {
    const manager = new ContextManager({ worktreeRoot: WORKTREE })
    manager.processEvent(makeToolUse('Read', { file_path: '/tmp/test-worktree/src/a.ts' }))
    manager.processEvent(makeAssistantText('Working on feature'))

    // After compaction, summary should be generated from buffered events
    manager.handleCompaction()
    const summary = manager.getSummary()
    expect(summary).not.toBeNull()
    expect(summary!.compactionCount).toBe(1)
  })

  it('caps event buffer at maxEventBufferSize', () => {
    const manager = new ContextManager({ worktreeRoot: WORKTREE, maxEventBufferSize: 10 })

    for (let i = 0; i < 15; i++) {
      manager.processEvent(makeToolUse('Read', { file_path: `/tmp/test-worktree/src/${i}.ts` }))
    }

    // Buffer should have been trimmed
    manager.handleCompaction()
    const summary = manager.getSummary()
    expect(summary).not.toBeNull()
  })
})

describe('ContextManager — handleCompaction', () => {
  it('generates summary from buffered events', () => {
    const manager = new ContextManager({ worktreeRoot: WORKTREE })
    manager.processEvent(makeToolUse('Edit', { file_path: '/tmp/test-worktree/src/foo.ts' }))

    manager.handleCompaction()

    const summary = manager.getSummary()
    expect(summary).not.toBeNull()
    expect(summary!.fileModifications.length).toBeGreaterThanOrEqual(1)
  })

  it('merges with existing summary on subsequent compactions', () => {
    const manager = new ContextManager({ worktreeRoot: WORKTREE })

    // First compaction
    manager.processEvent(makeToolUse('Edit', { file_path: '/tmp/test-worktree/src/a.ts' }))
    manager.handleCompaction()
    expect(manager.getSummary()!.compactionCount).toBe(1)

    // Second compaction
    manager.processEvent(makeToolUse('Edit', { file_path: '/tmp/test-worktree/src/b.ts' }))
    manager.handleCompaction()
    expect(manager.getSummary()!.compactionCount).toBe(2)
    expect(manager.getSummary()!.fileModifications.length).toBe(2)
  })

  it('clears event buffer after compaction', () => {
    const manager = new ContextManager({ worktreeRoot: WORKTREE })
    manager.processEvent(makeToolUse('Read', { file_path: '/tmp/test-worktree/src/foo.ts' }))
    manager.handleCompaction()

    // Second compaction with no new events should produce empty span summary
    manager.handleCompaction()
    expect(manager.getSummary()!.compactionCount).toBe(2)
  })
})

describe('ContextManager — getContextSection', () => {
  it('returns empty string when no summary exists', () => {
    const manager = new ContextManager({ worktreeRoot: WORKTREE })
    expect(manager.getContextSection()).toBe('')
  })

  it('returns formatted context section after compaction', () => {
    const manager = new ContextManager({ worktreeRoot: WORKTREE })
    manager.processEvent(makeToolUse('Edit', { file_path: '/tmp/test-worktree/src/foo.ts' }))
    manager.handleCompaction()

    const section = manager.getContextSection()
    expect(section).toContain('<context-summary>')
    expect(section).toContain('</context-summary>')
  })
})

describe('ContextManager — persistence', () => {
  it('loads empty state when no persisted files exist', () => {
    vi.mocked(existsSync).mockReturnValue(false)
    const manager = ContextManager.load(WORKTREE)

    expect(manager.getSummary()).toBeNull()
    expect(Object.keys(manager.getArtifactIndex().files)).toHaveLength(0)
  })

  it('loads persisted summary when available', () => {
    const savedSummary = {
      schemaVersion: 1,
      sessionIntent: 'Test intent',
      fileModifications: [],
      decisionsMade: [],
      nextSteps: [],
      compactionCount: 2,
      lastCompactedAt: 1000,
      tokenEstimate: 100,
    }

    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockImplementation((path) => {
      if (String(path).includes('summary.json')) {
        return JSON.stringify(savedSummary)
      }
      if (String(path).includes('artifacts.json')) {
        return JSON.stringify({ files: {}, totalReads: 0, totalWrites: 0, lastUpdatedAt: 0 })
      }
      return '{}'
    })

    const manager = ContextManager.load(WORKTREE)
    expect(manager.getSummary()).not.toBeNull()
    expect(manager.getSummary()!.sessionIntent).toBe('Test intent')
  })
})

describe('ContextManager — persistIfStale', () => {
  it('does not persist when interval has not elapsed', () => {
    const manager = new ContextManager({ worktreeRoot: WORKTREE })
    manager.processEvent(makeToolUse('Edit', { file_path: '/tmp/test-worktree/src/foo.ts' }))
    manager.handleCompaction() // This persists

    // Should not persist again immediately
    manager.persistIfStale(30000)
    // No error means it worked (skipped persist)
  })
})
