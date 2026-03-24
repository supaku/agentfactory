import { describe, it, expect } from 'vitest'
import { FanInStrategy } from './fan-in-strategy.js'
import type {
  ParallelTask,
  ParallelTaskResult,
  ParallelismStrategyOptions,
} from '../parallelism-types.js'

/** Helper: create sample tasks */
function createTasks(count: number): ParallelTask[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `task-${i + 1}`,
    issueId: `SUP-${100 + i + 1}`,
    phaseName: 'development',
  }))
}

/** Helper: create a dispatch that returns success */
function createSuccessDispatch(): (
  task: ParallelTask,
) => Promise<ParallelTaskResult> {
  return async (task: ParallelTask): Promise<ParallelTaskResult> => ({
    id: task.id,
    issueId: task.issueId,
    success: true,
    durationMs: 10,
  })
}

/** Helper: create options with a dispatch function */
function createOptions(
  dispatch: (task: ParallelTask) => Promise<ParallelTaskResult>,
  overrides: Partial<ParallelismStrategyOptions> = {},
): ParallelismStrategyOptions {
  return { dispatch, ...overrides }
}

describe('FanInStrategy', () => {
  describe('waitForAll=true', () => {
    it('waits for all tasks to complete', async () => {
      const strategy = new FanInStrategy()
      const tasks = createTasks(3)
      const completionOrder: string[] = []

      const dispatch = async (
        task: ParallelTask,
      ): Promise<ParallelTaskResult> => {
        // Stagger completion times
        const delay = task.id === 'task-1' ? 30 : task.id === 'task-2' ? 10 : 20
        await new Promise((resolve) => setTimeout(resolve, delay))
        completionOrder.push(task.id)
        return { id: task.id, issueId: task.issueId, success: true }
      }

      const result = await strategy.execute(
        tasks,
        createOptions(dispatch, { waitForAll: true }),
      )

      // All three tasks should be completed
      expect(result.completed).toHaveLength(3)
      // The result should include all task IDs
      const completedIds = result.completed.map((r) => r.id).sort()
      expect(completedIds).toEqual(['task-1', 'task-2', 'task-3'])
    })

    it('handles mix of success and failure', async () => {
      const strategy = new FanInStrategy()
      const tasks = createTasks(4)

      const dispatch = async (
        task: ParallelTask,
      ): Promise<ParallelTaskResult> => {
        if (task.id === 'task-2' || task.id === 'task-4') {
          throw new Error(`failed: ${task.id}`)
        }
        return { id: task.id, issueId: task.issueId, success: true }
      }

      const result = await strategy.execute(
        tasks,
        createOptions(dispatch, { waitForAll: true }),
      )

      expect(result.completed).toHaveLength(2)
      expect(result.failed).toHaveLength(2)

      const completedIds = result.completed.map((r) => r.id).sort()
      expect(completedIds).toEqual(['task-1', 'task-3'])

      const failedIds = result.failed.map((r) => r.id).sort()
      expect(failedIds).toEqual(['task-2', 'task-4'])
      expect(result.failed.find((f) => f.id === 'task-2')?.error).toBe(
        'failed: task-2',
      )
    })
  })

  describe('waitForAll=false', () => {
    it('resolves after first success', async () => {
      const strategy = new FanInStrategy()
      const tasks = createTasks(3)

      const dispatch = async (
        task: ParallelTask,
      ): Promise<ParallelTaskResult> => {
        // task-2 completes first with success
        const delay =
          task.id === 'task-1' ? 50 : task.id === 'task-2' ? 10 : 50
        await new Promise((resolve) => setTimeout(resolve, delay))
        return { id: task.id, issueId: task.issueId, success: true }
      }

      const result = await strategy.execute(
        tasks,
        createOptions(dispatch, { waitForAll: false }),
      )

      // All tasks should still be collected (we wait for remaining after first success)
      expect(result.completed).toHaveLength(3)
      expect(result.strategy).toBe('fan-in')
    })

    it('all fail returns failure result', async () => {
      const strategy = new FanInStrategy()
      const tasks = createTasks(3)

      const dispatch = async (
        task: ParallelTask,
      ): Promise<ParallelTaskResult> => {
        throw new Error(`failed: ${task.id}`)
      }

      const result = await strategy.execute(
        tasks,
        createOptions(dispatch, { waitForAll: false }),
      )

      expect(result.completed).toHaveLength(0)
      expect(result.failed).toHaveLength(3)
    })
  })

  it('collects outputs from completed tasks', async () => {
    const strategy = new FanInStrategy()
    const tasks = createTasks(2)

    const dispatch = async (
      task: ParallelTask,
    ): Promise<ParallelTaskResult> => ({
      id: task.id,
      issueId: task.issueId,
      success: true,
      outputs: { artifact: `build-${task.id}` },
    })

    const result = await strategy.execute(tasks, createOptions(dispatch))

    expect(result.outputs['SUP-101']).toEqual({ artifact: 'build-task-1' })
    expect(result.outputs['SUP-102']).toEqual({ artifact: 'build-task-2' })
  })

  it('maxConcurrent=2 with 5 tasks verifies queuing behavior', async () => {
    // Note: The actual concurrency limiting is done by the ParallelismExecutor's
    // semaphore wrapping the dispatch function. This test verifies that the
    // strategy works correctly with a dispatch that simulates semaphore behavior.
    const strategy = new FanInStrategy()
    const tasks = createTasks(5)

    let peakConcurrent = 0
    let currentConcurrent = 0
    const taskOrder: string[] = []

    // Simulate the semaphore-wrapped dispatch behavior
    const maxConcurrent = 2
    let activeSlots = 0
    const waitQueue: Array<() => void> = []

    const dispatch = async (
      task: ParallelTask,
    ): Promise<ParallelTaskResult> => {
      // Simulate semaphore acquire
      if (activeSlots >= maxConcurrent) {
        await new Promise<void>((resolve) => waitQueue.push(resolve))
      }
      activeSlots++
      currentConcurrent++
      peakConcurrent = Math.max(peakConcurrent, currentConcurrent)
      taskOrder.push(`start:${task.id}`)

      await new Promise((resolve) => setTimeout(resolve, 10))

      taskOrder.push(`end:${task.id}`)
      currentConcurrent--
      activeSlots--
      // Simulate semaphore release
      if (waitQueue.length > 0) {
        const next = waitQueue.shift()!
        next()
      }

      return { id: task.id, issueId: task.issueId, success: true }
    }

    const result = await strategy.execute(
      tasks,
      createOptions(dispatch, { maxConcurrent: 2 }),
    )

    expect(result.completed).toHaveLength(5)
    expect(peakConcurrent).toBeLessThanOrEqual(2)

    // Verify at no point more than 2 tasks are active
    let active = 0
    for (const entry of taskOrder) {
      if (entry.startsWith('start:')) active++
      if (entry.startsWith('end:')) active--
      expect(active).toBeLessThanOrEqual(2)
    }
  })

  it('returns empty result for empty task list', async () => {
    const strategy = new FanInStrategy()
    const dispatch = createSuccessDispatch()

    const result = await strategy.execute([], createOptions(dispatch))

    expect(result.completed).toEqual([])
    expect(result.failed).toEqual([])
    expect(result.cancelled).toEqual([])
    expect(result.outputs).toEqual({})
  })

  it('sets strategy to fan-in', async () => {
    const strategy = new FanInStrategy()
    const tasks = createTasks(1)
    const dispatch = createSuccessDispatch()

    const result = await strategy.execute(tasks, createOptions(dispatch))

    expect(result.strategy).toBe('fan-in')
  })

  it('defaults to waitForAll=true when not specified', async () => {
    const strategy = new FanInStrategy()
    const tasks = createTasks(3)
    const completionOrder: string[] = []

    const dispatch = async (
      task: ParallelTask,
    ): Promise<ParallelTaskResult> => {
      // Stagger completion: task-3 finishes first, task-1 last
      const delay = task.id === 'task-1' ? 30 : task.id === 'task-2' ? 20 : 10
      await new Promise((resolve) => setTimeout(resolve, delay))
      completionOrder.push(task.id)
      return { id: task.id, issueId: task.issueId, success: true }
    }

    // Do NOT pass waitForAll — it should default to true
    const result = await strategy.execute(tasks, createOptions(dispatch))

    // All three should complete since default is waitForAll=true
    expect(result.completed).toHaveLength(3)
    const completedIds = result.completed.map((r) => r.id).sort()
    expect(completedIds).toEqual(['task-1', 'task-2', 'task-3'])
  })
})
