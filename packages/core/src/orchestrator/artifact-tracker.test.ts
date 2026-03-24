import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { resolve } from 'path'
import { ArtifactTracker } from './artifact-tracker.js'
import type { AgentToolUseEvent, AgentEvent } from '../providers/types.js'

const WORKTREE = '/tmp/test-worktree'

function makeToolUse(toolName: string, input: Record<string, unknown>): AgentToolUseEvent {
  return {
    type: 'tool_use',
    toolName,
    input,
    raw: {},
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // By default, existsSync returns true (for file existence checks in Write tool)
  vi.mocked(existsSync).mockReturnValue(true)
})

describe('ArtifactTracker — trackEvent', () => {
  it('tracks Read tool events', () => {
    const tracker = new ArtifactTracker(WORKTREE)
    tracker.trackEvent(makeToolUse('Read', { file_path: '/tmp/test-worktree/src/foo.ts' }))

    const index = tracker.getIndex()
    expect(Object.keys(index.files)).toHaveLength(1)
    expect(index.totalReads).toBe(1)
    const file = Object.values(index.files)[0]
    expect(file.relativePath).toBe('src/foo.ts')
    expect(file.actions).toEqual(['read'])
  })

  it('tracks Write tool events as modified when file exists', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    const tracker = new ArtifactTracker(WORKTREE)
    tracker.trackEvent(makeToolUse('Write', { file_path: '/tmp/test-worktree/src/bar.ts' }))

    const index = tracker.getIndex()
    expect(index.totalWrites).toBe(1)
    const file = Object.values(index.files)[0]
    expect(file.actions).toEqual(['modified'])
  })

  it('tracks Write tool events as created when file does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false)
    const tracker = new ArtifactTracker(WORKTREE)
    tracker.trackEvent(makeToolUse('Write', { file_path: '/tmp/test-worktree/src/new.ts' }))

    const file = Object.values(tracker.getIndex().files)[0]
    expect(file.actions).toEqual(['created'])
  })

  it('tracks Edit tool events as modified', () => {
    const tracker = new ArtifactTracker(WORKTREE)
    tracker.trackEvent(makeToolUse('Edit', { file_path: '/tmp/test-worktree/src/edit.ts' }))

    const file = Object.values(tracker.getIndex().files)[0]
    expect(file.actions).toEqual(['modified'])
    expect(tracker.getIndex().totalWrites).toBe(1)
  })

  it('accumulates actions for the same file', () => {
    const tracker = new ArtifactTracker(WORKTREE)
    tracker.trackEvent(makeToolUse('Read', { file_path: '/tmp/test-worktree/src/foo.ts' }))
    tracker.trackEvent(makeToolUse('Edit', { file_path: '/tmp/test-worktree/src/foo.ts' }))
    tracker.trackEvent(makeToolUse('Read', { file_path: '/tmp/test-worktree/src/foo.ts' }))

    const file = Object.values(tracker.getIndex().files)[0]
    expect(file.actions).toEqual(['read', 'modified', 'read'])
    expect(tracker.getIndex().totalReads).toBe(2)
    expect(tracker.getIndex().totalWrites).toBe(1)
  })

  it('ignores non-tool_use events', () => {
    const tracker = new ArtifactTracker(WORKTREE)
    tracker.trackEvent({ type: 'assistant_text', text: 'hello', raw: {} } as AgentEvent)
    tracker.trackEvent({ type: 'system', subtype: 'status', raw: {} } as AgentEvent)

    expect(Object.keys(tracker.getIndex().files)).toHaveLength(0)
  })

  it('parses bash rm commands', () => {
    const tracker = new ArtifactTracker(WORKTREE)
    tracker.trackEvent(makeToolUse('Bash', { command: 'rm -f /tmp/test-worktree/src/old.ts' }))

    const files = Object.values(tracker.getIndex().files)
    expect(files).toHaveLength(1)
    expect(files[0].actions).toEqual(['deleted'])
  })

  it('parses bash mv commands', () => {
    const tracker = new ArtifactTracker(WORKTREE)
    tracker.trackEvent(makeToolUse('Bash', { command: 'mv /tmp/test-worktree/src/a.ts /tmp/test-worktree/src/b.ts' }))

    const files = Object.values(tracker.getIndex().files)
    expect(files).toHaveLength(2)
  })

  it('ignores tool_use events with missing file_path', () => {
    const tracker = new ArtifactTracker(WORKTREE)
    tracker.trackEvent(makeToolUse('Read', {}))
    tracker.trackEvent(makeToolUse('Write', {}))
    tracker.trackEvent(makeToolUse('Edit', {}))

    expect(Object.keys(tracker.getIndex().files)).toHaveLength(0)
  })
})

describe('ArtifactTracker — getFiles', () => {
  it('returns all files when no filter', () => {
    const tracker = new ArtifactTracker(WORKTREE)
    tracker.trackEvent(makeToolUse('Read', { file_path: '/tmp/test-worktree/a.ts' }))
    tracker.trackEvent(makeToolUse('Edit', { file_path: '/tmp/test-worktree/b.ts' }))

    expect(tracker.getFiles()).toHaveLength(2)
  })

  it('filters by action', () => {
    const tracker = new ArtifactTracker(WORKTREE)
    tracker.trackEvent(makeToolUse('Read', { file_path: '/tmp/test-worktree/a.ts' }))
    tracker.trackEvent(makeToolUse('Edit', { file_path: '/tmp/test-worktree/b.ts' }))

    expect(tracker.getFiles({ action: 'read' })).toHaveLength(1)
    expect(tracker.getFiles({ action: 'modified' })).toHaveLength(1)
  })

  it('filters by glob pattern', () => {
    const tracker = new ArtifactTracker(WORKTREE)
    tracker.trackEvent(makeToolUse('Read', { file_path: '/tmp/test-worktree/src/foo.ts' }))
    tracker.trackEvent(makeToolUse('Read', { file_path: '/tmp/test-worktree/test/bar.ts' }))

    const srcFiles = tracker.getFiles({ glob: 'src/**' })
    expect(srcFiles).toHaveLength(1)
    expect(srcFiles[0].relativePath).toBe('src/foo.ts')
  })
})

describe('ArtifactTracker — persistence', () => {
  it('persists index atomically', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    const tracker = new ArtifactTracker(WORKTREE)
    tracker.trackEvent(makeToolUse('Read', { file_path: '/tmp/test-worktree/src/foo.ts' }))

    tracker.persist()

    const artifactsPath = resolve(WORKTREE, '.agent', 'artifacts.json')
    expect(writeFileSync).toHaveBeenCalledWith(
      artifactsPath + '.tmp',
      expect.any(String)
    )
    expect(renameSync).toHaveBeenCalledWith(artifactsPath + '.tmp', artifactsPath)
  })

  it('loads persisted index', () => {
    const savedIndex = {
      files: {
        '/tmp/test-worktree/src/foo.ts': {
          path: '/tmp/test-worktree/src/foo.ts',
          relativePath: 'src/foo.ts',
          actions: ['read', 'modified'],
          firstSeenAt: 1000,
          lastTouchedAt: 2000,
        }
      },
      totalReads: 1,
      totalWrites: 1,
      lastUpdatedAt: 2000,
    }

    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(savedIndex))

    const tracker = ArtifactTracker.load(WORKTREE)
    const index = tracker.getIndex()
    expect(Object.keys(index.files)).toHaveLength(1)
    expect(index.totalReads).toBe(1)
    expect(index.totalWrites).toBe(1)
  })

  it('returns empty tracker when no persisted file exists', () => {
    vi.mocked(existsSync).mockReturnValue(false)

    const tracker = ArtifactTracker.load(WORKTREE)
    expect(Object.keys(tracker.getIndex().files)).toHaveLength(0)
  })

  it('returns empty tracker when persisted file is invalid JSON', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockReturnValue('not json')

    const tracker = ArtifactTracker.load(WORKTREE)
    expect(Object.keys(tracker.getIndex().files)).toHaveLength(0)
  })
})

describe('ArtifactTracker — toContextString', () => {
  it('returns empty message when no files tracked', () => {
    const tracker = new ArtifactTracker(WORKTREE)
    expect(tracker.toContextString()).toContain('0 files')
  })

  it('categorizes files into modified, read-only, and searched', () => {
    const tracker = new ArtifactTracker(WORKTREE)
    tracker.trackEvent(makeToolUse('Edit', { file_path: '/tmp/test-worktree/src/modified.ts' }))
    tracker.trackEvent(makeToolUse('Read', { file_path: '/tmp/test-worktree/src/readonly.ts' }))

    const output = tracker.toContextString()
    expect(output).toContain('Modified (1)')
    expect(output).toContain('Read-only (1)')
    expect(output).toContain('src/modified.ts')
    expect(output).toContain('src/readonly.ts')
  })

  it('shows action counts for modified files', () => {
    const tracker = new ArtifactTracker(WORKTREE)
    tracker.trackEvent(makeToolUse('Read', { file_path: '/tmp/test-worktree/src/foo.ts' }))
    tracker.trackEvent(makeToolUse('Edit', { file_path: '/tmp/test-worktree/src/foo.ts' }))
    tracker.trackEvent(makeToolUse('Read', { file_path: '/tmp/test-worktree/src/foo.ts' }))

    const output = tracker.toContextString()
    expect(output).toContain('read 2x')
    expect(output).toContain('modified 1x')
  })
})
