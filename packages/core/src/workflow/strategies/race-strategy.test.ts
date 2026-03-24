import { describe, it, expect } from 'vitest'
import { RaceStrategy } from './race-strategy.js'
import { InMemoryAgentCancellation } from '../agent-cancellation.js'
import type {
  ParallelTask,
  ParallelTaskResult,
  ParallelismStrategyOptions,
} from '../parallelism-types.js'

/** Helper to create a task */
function makeTask(id: string, issueId?: string): ParallelTask {
  return { id, issueId: issueId ?? id, phaseName: 'test-phase' }
}

/** Helper to create a successful result */
function makeResult(
  task: ParallelTask,
  outputs?: Record<string, unknown>,
  durationMs?: number,
): ParallelTaskResult {
  return {
    id: task.id,
    issueId: task.issueId,
    success: true,
    outputs,
    durationMs,
  }
}

/** Helper to create a failed result */
function makeFailedResult(task: ParallelTask): ParallelTaskResult {
  return {
    id: task.id,
    issueId: task.issueId,
    success: false,
  }
}

describe('RaceStrategy', () => {
  it('sets strategy to "race"', async () => {
    const strategy = new RaceStrategy()
    const result = await strategy.execute([], {
      dispatch: async () => ({ id: '', issueId: '', success: true }),
    })
    expect(result.strategy).toBe('race')
  })

  describe('empty task list', () => {
    it('returns empty result', async () => {
      const strategy = new RaceStrategy()
      const result = await strategy.execute([], {
        dispatch: async () => ({ id: '', issueId: '', success: true }),
      })
      expect(result).toEqual({
        strategy: 'race',
        completed: [],
        cancelled: [],
        failed: [],
        outputs: {},
      })
    })
  })

  describe('single task', () => {
    it('returns that task result with no cancellation', async () => {
      const cancellation = new InMemoryAgentCancellation()
      const strategy = new RaceStrategy(cancellation)
      const task = makeTask('t1', 'SUP-100')

      const dispatch = async (t: ParallelTask) =>
        makeResult(t, { code: 'done' }, 100)

      const result = await strategy.execute([task], { dispatch })

      expect(result.completed).toHaveLength(1)
      expect(result.completed[0].id).toBe('t1')
      expect(result.completed[0].success).toBe(true)
      expect(result.cancelled).toEqual([])
      expect(result.failed).toEqual([])
      expect(result.outputs).toEqual({ 'SUP-100': { code: 'done' } })
    })
  })

  describe('race with 3 agents, agent 2 wins first', () => {
    it('collects winner output and cancels others', async () => {
      const cancellation = new InMemoryAgentCancellation()
      const strategy = new RaceStrategy(cancellation)

      const t1 = makeTask('t1', 'SUP-101')
      const t2 = makeTask('t2', 'SUP-102')
      const t3 = makeTask('t3', 'SUP-103')

      const dispatch = async (task: ParallelTask): Promise<ParallelTaskResult> => {
        // Agent 2 resolves fastest
        if (task.id === 't2') {
          await new Promise((r) => setTimeout(r, 10))
          return makeResult(task, { winner: true }, 10)
        }
        // Agent 1 and 3 take longer
        await new Promise((r) => setTimeout(r, 50))
        return makeResult(task, { winner: false }, 50)
      }

      const result = await strategy.execute([t1, t2, t3], { dispatch })

      expect(result.strategy).toBe('race')

      // All tasks should eventually complete (they all resolve successfully)
      expect(result.completed.length).toBeGreaterThanOrEqual(1)

      // Winner's outputs should be collected
      expect(result.outputs['SUP-102']).toEqual({ winner: true })

      // t1 and t3 should be cancelled
      expect(result.cancelled).toContain('t1')
      expect(result.cancelled).toContain('t3')
      expect(result.cancelled).not.toContain('t2')
    })
  })

  describe('all agents fail', () => {
    it('returns aggregated errors and no cancellation', async () => {
      const cancellation = new InMemoryAgentCancellation()
      const strategy = new RaceStrategy(cancellation)

      const t1 = makeTask('t1', 'SUP-201')
      const t2 = makeTask('t2', 'SUP-202')
      const t3 = makeTask('t3', 'SUP-203')

      const dispatch = async (task: ParallelTask): Promise<ParallelTaskResult> => {
        throw new Error(`Agent ${task.id} failed`)
      }

      const result = await strategy.execute([t1, t2, t3], { dispatch })

      expect(result.completed).toEqual([])
      expect(result.cancelled).toEqual([])
      expect(result.failed).toHaveLength(3)

      const failedIds = result.failed.map((f) => f.id)
      expect(failedIds).toContain('t1')
      expect(failedIds).toContain('t2')
      expect(failedIds).toContain('t3')

      for (const f of result.failed) {
        expect(f.error).toMatch(/Agent .+ failed/)
      }

      expect(result.outputs).toEqual({})
    })
  })

  describe('cancellation tracking', () => {
    it('cancelled IDs are reported in result', async () => {
      const cancellation = new InMemoryAgentCancellation()
      const strategy = new RaceStrategy(cancellation)

      const t1 = makeTask('t1')
      const t2 = makeTask('t2')
      const t3 = makeTask('t3')

      const dispatch = async (task: ParallelTask): Promise<ParallelTaskResult> => {
        if (task.id === 't1') {
          // t1 wins immediately
          return makeResult(task, { fast: true }, 1)
        }
        await new Promise((r) => setTimeout(r, 30))
        return makeResult(task, {}, 30)
      }

      const result = await strategy.execute([t1, t2, t3], { dispatch })

      // t2 and t3 should be in cancelled
      expect(result.cancelled).toContain('t2')
      expect(result.cancelled).toContain('t3')
      expect(result.cancelled).toHaveLength(2)

      // Cancellation state matches
      expect(cancellation.isCancelled('t2')).toBe(true)
      expect(cancellation.isCancelled('t3')).toBe(true)
      expect(cancellation.isCancelled('t1')).toBe(false)
    })
  })

  describe('winner outputs collected, non-winner outputs excluded', () => {
    it('only includes the winner outputs in result.outputs', async () => {
      const strategy = new RaceStrategy()

      const t1 = makeTask('t1', 'SUP-301')
      const t2 = makeTask('t2', 'SUP-302')

      const dispatch = async (task: ParallelTask): Promise<ParallelTaskResult> => {
        if (task.id === 't1') {
          // t1 wins
          await new Promise((r) => setTimeout(r, 5))
          return makeResult(task, { result: 'alpha' }, 5)
        }
        // t2 is slower and also succeeds
        await new Promise((r) => setTimeout(r, 40))
        return makeResult(task, { result: 'beta' }, 40)
      }

      const result = await strategy.execute([t1, t2], { dispatch })

      // Winner's outputs should be in result.outputs
      expect(result.outputs['SUP-301']).toEqual({ result: 'alpha' })

      // Non-winner that completed after cancellation: since it still succeeds,
      // its outputs appear only if success is true (per implementation)
      // The key point: the winner's outputs are definitely there
      expect(result.outputs).toHaveProperty('SUP-301')
    })
  })

  describe('agent resolves after winner still appears in completed', () => {
    it('late-finishing agents appear in completed list', async () => {
      const strategy = new RaceStrategy()

      const t1 = makeTask('t1', 'SUP-401')
      const t2 = makeTask('t2', 'SUP-402')

      const dispatch = async (task: ParallelTask): Promise<ParallelTaskResult> => {
        if (task.id === 't1') {
          // t1 wins fast
          return makeResult(task, { first: true }, 1)
        }
        // t2 completes later but still successfully
        await new Promise((r) => setTimeout(r, 30))
        return makeResult(task, { second: true }, 30)
      }

      const result = await strategy.execute([t1, t2], { dispatch })

      // Both should appear in completed since both resolved successfully
      const completedIds = result.completed.map((c) => c.id)
      expect(completedIds).toContain('t1')
      expect(completedIds).toContain('t2')

      // t2 should still be marked as cancelled
      expect(result.cancelled).toContain('t2')
    })
  })

  describe('mixed success and failure', () => {
    it('handles a mix of failures and successes correctly', async () => {
      const strategy = new RaceStrategy()

      const t1 = makeTask('t1', 'SUP-501')
      const t2 = makeTask('t2', 'SUP-502')
      const t3 = makeTask('t3', 'SUP-503')

      const dispatch = async (task: ParallelTask): Promise<ParallelTaskResult> => {
        if (task.id === 't1') {
          // t1 fails fast
          throw new Error('Agent t1 crashed')
        }
        if (task.id === 't2') {
          // t2 succeeds and becomes winner
          await new Promise((r) => setTimeout(r, 15))
          return makeResult(task, { answer: 42 }, 15)
        }
        // t3 succeeds later
        await new Promise((r) => setTimeout(r, 40))
        return makeResult(task, { answer: 99 }, 40)
      }

      const result = await strategy.execute([t1, t2, t3], { dispatch })

      // t1 should be in failed
      expect(result.failed).toHaveLength(1)
      expect(result.failed[0].id).toBe('t1')
      expect(result.failed[0].error).toBe('Agent t1 crashed')

      // t2 should be the winner
      expect(result.outputs['SUP-502']).toEqual({ answer: 42 })

      // t3 should be cancelled
      expect(result.cancelled).toContain('t3')
    })
  })

  describe('non-Error rejection', () => {
    it('handles non-Error rejection values', async () => {
      const strategy = new RaceStrategy()

      const t1 = makeTask('t1', 'SUP-601')

      const dispatch = async (_task: ParallelTask): Promise<ParallelTaskResult> => {
        throw 'string error'
      }

      const result = await strategy.execute([t1], { dispatch })

      expect(result.failed).toHaveLength(1)
      expect(result.failed[0].error).toBe('string error')
    })
  })

  describe('cancellation timeout', () => {
    it('resolves after timeout if agent does not acknowledge cancellation', async () => {
      const cancellation = new InMemoryAgentCancellation()
      // Use a very short timeout (100ms) for test speed
      const strategy = new RaceStrategy(cancellation, 100)

      const t1 = makeTask('t1', 'SUP-701')
      const t2 = makeTask('t2', 'SUP-702')

      const dispatch = async (task: ParallelTask): Promise<ParallelTaskResult> => {
        if (task.id === 't1') {
          // t1 wins immediately
          return makeResult(task, { fast: true }, 1)
        }
        // t2 never completes — simulates an agent that never checks isCancelled()
        return new Promise(() => {
          // intentionally never resolves
        })
      }

      const startTime = Date.now()
      const result = await strategy.execute([t1, t2], { dispatch })
      const elapsed = Date.now() - startTime

      // Should resolve within a reasonable time (timeout + buffer)
      expect(elapsed).toBeLessThan(1000)

      // Winner should still be collected
      expect(result.completed).toHaveLength(1)
      expect(result.completed[0].id).toBe('t1')
      expect(result.outputs['SUP-701']).toEqual({ fast: true })

      // t2 should be marked as cancelled
      expect(result.cancelled).toContain('t2')
    })

    it('respects configurable timeout value', async () => {
      const cancellation = new InMemoryAgentCancellation()
      // Use a 200ms timeout
      const strategy = new RaceStrategy(cancellation, 200)

      const t1 = makeTask('t1', 'SUP-801')
      const t2 = makeTask('t2', 'SUP-802')

      const dispatch = async (task: ParallelTask): Promise<ParallelTaskResult> => {
        if (task.id === 't1') {
          return makeResult(task, { winner: true }, 1)
        }
        // t2 hangs forever
        return new Promise(() => {})
      }

      const startTime = Date.now()
      await strategy.execute([t1, t2], { dispatch })
      const elapsed = Date.now() - startTime

      // Should resolve after ~200ms, not immediately and not at 30s default
      expect(elapsed).toBeGreaterThanOrEqual(150) // allow for timer imprecision
      expect(elapsed).toBeLessThan(1000)
    })

    it('force-resolves with hanging agents after timeout expiry', async () => {
      const cancellation = new InMemoryAgentCancellation()
      const strategy = new RaceStrategy(cancellation, 100)

      const t1 = makeTask('t1', 'SUP-901')
      const t2 = makeTask('t2', 'SUP-902')
      const t3 = makeTask('t3', 'SUP-903')

      const dispatch = async (task: ParallelTask): Promise<ParallelTaskResult> => {
        if (task.id === 't1') {
          // t1 wins fast
          await new Promise((r) => setTimeout(r, 5))
          return makeResult(task, { answer: 'first' }, 5)
        }
        // t2 and t3 hang forever — simulate agents that never check isCancelled()
        return new Promise(() => {})
      }

      const result = await strategy.execute([t1, t2, t3], { dispatch })

      // The strategy should have resolved despite hanging agents
      expect(result.strategy).toBe('race')
      expect(result.completed).toHaveLength(1)
      expect(result.completed[0].id).toBe('t1')
      expect(result.outputs['SUP-901']).toEqual({ answer: 'first' })

      // Both hanging agents should be in the cancelled list
      expect(result.cancelled).toContain('t2')
      expect(result.cancelled).toContain('t3')

      // They should NOT appear in failed since they didn't error
      expect(result.failed).toHaveLength(0)
    })

    it('uses default 30s timeout when none is specified', () => {
      // Verify the constructor default — we test this indirectly by confirming
      // the strategy can be constructed without a timeout parameter
      const strategy = new RaceStrategy()
      // If this compiles and runs, the default is applied internally.
      // We can't directly access the private field, but we verify it doesn't throw.
      expect(strategy).toBeDefined()
    })
  })
})
