import { describe, it, expect } from 'vitest'
import { InMemoryAgentCancellation } from './agent-cancellation.js'

describe('InMemoryAgentCancellation', () => {
  describe('cancel()', () => {
    it('returns true on first call for a task', async () => {
      const cancellation = new InMemoryAgentCancellation()
      const result = await cancellation.cancel('task-1')
      expect(result).toBe(true)
    })

    it('returns false on duplicate cancel for the same task', async () => {
      const cancellation = new InMemoryAgentCancellation()
      await cancellation.cancel('task-1')
      const result = await cancellation.cancel('task-1')
      expect(result).toBe(false)
    })

    it('returns true for different task IDs', async () => {
      const cancellation = new InMemoryAgentCancellation()
      const r1 = await cancellation.cancel('task-1')
      const r2 = await cancellation.cancel('task-2')
      expect(r1).toBe(true)
      expect(r2).toBe(true)
    })
  })

  describe('isCancelled()', () => {
    it('returns false for a task that has not been cancelled', () => {
      const cancellation = new InMemoryAgentCancellation()
      expect(cancellation.isCancelled('task-1')).toBe(false)
    })

    it('returns true for a task that has been cancelled', async () => {
      const cancellation = new InMemoryAgentCancellation()
      await cancellation.cancel('task-1')
      expect(cancellation.isCancelled('task-1')).toBe(true)
    })

    it('returns correct state for multiple tasks', async () => {
      const cancellation = new InMemoryAgentCancellation()
      await cancellation.cancel('task-1')
      await cancellation.cancel('task-3')
      expect(cancellation.isCancelled('task-1')).toBe(true)
      expect(cancellation.isCancelled('task-2')).toBe(false)
      expect(cancellation.isCancelled('task-3')).toBe(true)
    })
  })

  describe('getCancelledIds()', () => {
    it('returns empty array when nothing is cancelled', () => {
      const cancellation = new InMemoryAgentCancellation()
      expect(cancellation.getCancelledIds()).toEqual([])
    })

    it('returns all cancelled IDs', async () => {
      const cancellation = new InMemoryAgentCancellation()
      await cancellation.cancel('task-a')
      await cancellation.cancel('task-b')
      await cancellation.cancel('task-c')
      const ids = cancellation.getCancelledIds()
      expect(ids).toHaveLength(3)
      expect(ids).toContain('task-a')
      expect(ids).toContain('task-b')
      expect(ids).toContain('task-c')
    })

    it('does not include duplicates', async () => {
      const cancellation = new InMemoryAgentCancellation()
      await cancellation.cancel('task-1')
      await cancellation.cancel('task-1')
      expect(cancellation.getCancelledIds()).toEqual(['task-1'])
    })
  })

  describe('reset()', () => {
    it('clears all cancellation state', async () => {
      const cancellation = new InMemoryAgentCancellation()
      await cancellation.cancel('task-1')
      await cancellation.cancel('task-2')
      expect(cancellation.getCancelledIds()).toHaveLength(2)

      cancellation.reset()

      expect(cancellation.getCancelledIds()).toEqual([])
      expect(cancellation.isCancelled('task-1')).toBe(false)
      expect(cancellation.isCancelled('task-2')).toBe(false)
    })

    it('allows re-cancelling after reset', async () => {
      const cancellation = new InMemoryAgentCancellation()
      await cancellation.cancel('task-1')
      cancellation.reset()
      const result = await cancellation.cancel('task-1')
      expect(result).toBe(true)
      expect(cancellation.isCancelled('task-1')).toBe(true)
    })
  })
})
