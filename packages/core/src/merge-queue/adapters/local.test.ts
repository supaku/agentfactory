import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocalMergeQueueAdapter } from './local.js'
import type { LocalMergeQueueStorage } from './local.js'

// Mock child_process.exec
vi.mock('child_process', () => ({
  exec: vi.fn(),
}))

import { exec } from 'child_process'

function mockExec(stdout: string) {
  ;(exec as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_cmd: string, _opts: unknown, cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
      // promisify wraps exec — the 2-arg form is (cmd, opts) returning Promise
      // but we also need to handle the 3-arg callback form
      if (typeof _opts === 'function') {
        cb = _opts as typeof cb
        _opts = undefined
      }
      if (cb) {
        cb(null, { stdout, stderr: '' })
        return
      }
      return { stdout, stderr: '' }
    },
  )
}

function mockExecReject(error: Error) {
  ;(exec as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_cmd: string, _opts: unknown, cb?: (err: Error | null, result: unknown) => void) => {
      if (typeof _opts === 'function') {
        cb = _opts as typeof cb
      }
      if (cb) {
        cb(error, null)
        return
      }
      throw error
    },
  )
}

function createMockStorage(overrides: Partial<LocalMergeQueueStorage> = {}): LocalMergeQueueStorage {
  return {
    enqueue: vi.fn().mockResolvedValue(undefined),
    dequeue: vi.fn().mockResolvedValue(null),
    getQueueDepth: vi.fn().mockResolvedValue(0),
    isEnqueued: vi.fn().mockResolvedValue(false),
    getPosition: vi.fn().mockResolvedValue(null),
    remove: vi.fn().mockResolvedValue(undefined),
    getFailedReason: vi.fn().mockResolvedValue(null),
    getBlockedReason: vi.fn().mockResolvedValue(null),
    peekAll: vi.fn().mockResolvedValue([]),
    dequeueBatch: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

describe('LocalMergeQueueAdapter', () => {
  let storage: LocalMergeQueueStorage
  let adapter: LocalMergeQueueAdapter

  beforeEach(() => {
    vi.clearAllMocks()
    storage = createMockStorage()
    adapter = new LocalMergeQueueAdapter(storage)
  })

  it('has name "local"', () => {
    expect(adapter.name).toBe('local')
  })

  describe('isEnabled', () => {
    it('always returns true', async () => {
      expect(await adapter.isEnabled('owner', 'repo')).toBe(true)
    })
  })

  describe('canEnqueue', () => {
    it('returns true for open PR', async () => {
      mockExec(JSON.stringify({ state: 'OPEN', headRefName: 'feat/test' }))
      expect(await adapter.canEnqueue('owner', 'repo', 42)).toBe(true)
    })

    it('returns false for merged PR', async () => {
      mockExec(JSON.stringify({ state: 'MERGED', headRefName: 'feat/test' }))
      expect(await adapter.canEnqueue('owner', 'repo', 42)).toBe(false)
    })

    it('returns false for closed PR', async () => {
      mockExec(JSON.stringify({ state: 'CLOSED', headRefName: 'feat/test' }))
      expect(await adapter.canEnqueue('owner', 'repo', 42)).toBe(false)
    })

    it('returns false on gh CLI error', async () => {
      mockExecReject(new Error('gh: not found'))
      expect(await adapter.canEnqueue('owner', 'repo', 42)).toBe(false)
    })
  })

  describe('enqueue', () => {
    it('adds PR to storage and returns queued status', async () => {
      mockExec(JSON.stringify({ headRefName: 'feat/my-branch', url: 'https://github.com/o/r/pull/10' }))
      ;(storage.isEnqueued as ReturnType<typeof vi.fn>).mockResolvedValue(false)
      ;(storage.getPosition as ReturnType<typeof vi.fn>).mockResolvedValue(1)

      const status = await adapter.enqueue('owner', 'repo', 10)

      expect(storage.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          repoId: 'owner/repo',
          prNumber: 10,
          sourceBranch: 'feat/my-branch',
          targetBranch: 'main',
          priority: 3,
        }),
      )
      expect(status.state).toBe('merging') // position 1 = merging
    })

    it('returns existing status if already enqueued', async () => {
      ;(storage.isEnqueued as ReturnType<typeof vi.fn>).mockResolvedValue(true)
      ;(storage.getPosition as ReturnType<typeof vi.fn>).mockResolvedValue(3)

      const status = await adapter.enqueue('owner', 'repo', 10)

      expect(storage.enqueue).not.toHaveBeenCalled()
      expect(status.state).toBe('queued')
      expect(status.position).toBe(3)
    })

    it('falls back to default branch name on gh CLI error', async () => {
      mockExecReject(new Error('gh: not found'))
      ;(storage.isEnqueued as ReturnType<typeof vi.fn>).mockResolvedValue(false)
      ;(storage.getPosition as ReturnType<typeof vi.fn>).mockResolvedValue(2)

      await adapter.enqueue('owner', 'repo', 5)

      expect(storage.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceBranch: 'pr-5',
          prUrl: 'https://github.com/owner/repo/pull/5',
        }),
      )
    })
  })

  describe('getStatus', () => {
    it('returns queued with position when in queue', async () => {
      ;(storage.getPosition as ReturnType<typeof vi.fn>).mockResolvedValue(3)

      const status = await adapter.getStatus('owner', 'repo', 10)
      expect(status.state).toBe('queued')
      expect(status.position).toBe(3)
    })

    it('returns merging when position is 1', async () => {
      ;(storage.getPosition as ReturnType<typeof vi.fn>).mockResolvedValue(1)

      const status = await adapter.getStatus('owner', 'repo', 10)
      expect(status.state).toBe('merging')
      expect(status.position).toBe(1)
    })

    it('returns failed when PR has failed reason', async () => {
      ;(storage.getPosition as ReturnType<typeof vi.fn>).mockResolvedValue(null)
      ;(storage.getFailedReason as ReturnType<typeof vi.fn>).mockResolvedValue('Tests failed')

      const status = await adapter.getStatus('owner', 'repo', 10)
      expect(status.state).toBe('failed')
      expect(status.failureReason).toBe('Tests failed')
    })

    it('returns blocked when PR has blocked reason', async () => {
      ;(storage.getPosition as ReturnType<typeof vi.fn>).mockResolvedValue(null)
      ;(storage.getFailedReason as ReturnType<typeof vi.fn>).mockResolvedValue(null)
      ;(storage.getBlockedReason as ReturnType<typeof vi.fn>).mockResolvedValue('Merge conflict in utils.ts')

      const status = await adapter.getStatus('owner', 'repo', 10)
      expect(status.state).toBe('blocked')
      expect(status.failureReason).toBe('Merge conflict in utils.ts')
    })

    it('returns merged when PR is already merged', async () => {
      ;(storage.getPosition as ReturnType<typeof vi.fn>).mockResolvedValue(null)
      ;(storage.getFailedReason as ReturnType<typeof vi.fn>).mockResolvedValue(null)
      ;(storage.getBlockedReason as ReturnType<typeof vi.fn>).mockResolvedValue(null)
      mockExec(JSON.stringify({ state: 'MERGED' }))

      const status = await adapter.getStatus('owner', 'repo', 10)
      expect(status.state).toBe('merged')
    })

    it('returns not-queued when PR is not in any state', async () => {
      ;(storage.getPosition as ReturnType<typeof vi.fn>).mockResolvedValue(null)
      ;(storage.getFailedReason as ReturnType<typeof vi.fn>).mockResolvedValue(null)
      ;(storage.getBlockedReason as ReturnType<typeof vi.fn>).mockResolvedValue(null)
      mockExec(JSON.stringify({ state: 'OPEN' }))

      const status = await adapter.getStatus('owner', 'repo', 10)
      expect(status.state).toBe('not-queued')
    })
  })

  describe('dequeue', () => {
    it('removes PR from storage', async () => {
      await adapter.dequeue('owner', 'repo', 10)
      expect(storage.remove).toHaveBeenCalledWith('owner/repo', 10)
    })
  })
})
