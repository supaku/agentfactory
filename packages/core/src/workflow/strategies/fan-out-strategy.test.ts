import { describe, it, expect } from 'vitest'
import { FanOutStrategy } from './fan-out-strategy.js'
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

describe('FanOutStrategy', () => {
  it('dispatches all tasks and returns results', async () => {
    const strategy = new FanOutStrategy()
    const tasks = createTasks(3)
    const dispatched: string[] = []

    const dispatch = async (
      task: ParallelTask,
    ): Promise<ParallelTaskResult> => {
      dispatched.push(task.id)
      return { id: task.id, issueId: task.issueId, success: true }
    }

    const result = await strategy.execute(tasks, createOptions(dispatch))

    expect(dispatched).toEqual(['task-1', 'task-2', 'task-3'])
    expect(result.completed).toHaveLength(3)
    expect(result.completed[0].issueId).toBe('SUP-101')
    expect(result.completed[1].issueId).toBe('SUP-102')
    expect(result.completed[2].issueId).toBe('SUP-103')
  })

  it('handles dispatch failures gracefully', async () => {
    const strategy = new FanOutStrategy()
    const tasks = createTasks(3)

    const dispatch = async (
      task: ParallelTask,
    ): Promise<ParallelTaskResult> => {
      if (task.id === 'task-2') {
        throw new Error('dispatch failed for task-2')
      }
      return { id: task.id, issueId: task.issueId, success: true }
    }

    const result = await strategy.execute(tasks, createOptions(dispatch))

    expect(result.completed).toHaveLength(2)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].id).toBe('task-2')
    expect(result.failed[0].issueId).toBe('SUP-102')
    expect(result.failed[0].error).toBe('dispatch failed for task-2')
  })

  it('collects outputs from successful tasks', async () => {
    const strategy = new FanOutStrategy()
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

  it('returns empty result for empty task list', async () => {
    const strategy = new FanOutStrategy()
    const dispatch = createSuccessDispatch()

    const result = await strategy.execute([], createOptions(dispatch))

    expect(result.completed).toEqual([])
    expect(result.failed).toEqual([])
    expect(result.cancelled).toEqual([])
    expect(result.outputs).toEqual({})
  })

  it('sets strategy to fan-out', async () => {
    const strategy = new FanOutStrategy()
    const tasks = createTasks(1)
    const dispatch = createSuccessDispatch()

    const result = await strategy.execute(tasks, createOptions(dispatch))

    expect(result.strategy).toBe('fan-out')
  })

  it('cancelled array is always empty', async () => {
    const strategy = new FanOutStrategy()
    const tasks = createTasks(3)

    const dispatch = async (
      task: ParallelTask,
    ): Promise<ParallelTaskResult> => {
      if (task.id === 'task-2') {
        throw new Error('failed')
      }
      return { id: task.id, issueId: task.issueId, success: true }
    }

    const result = await strategy.execute(tasks, createOptions(dispatch))

    expect(result.cancelled).toEqual([])
  })
})
