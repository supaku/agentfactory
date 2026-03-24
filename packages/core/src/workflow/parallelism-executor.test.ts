import { describe, it, expect, vi } from 'vitest'
import { ParallelismExecutor } from './parallelism-executor.js'
import type {
  ParallelTask,
  ParallelTaskResult,
  ParallelismResult,
  ParallelismStrategy,
  ParallelismStrategyOptions,
} from './parallelism-types.js'
import type { ParallelismGroupDefinition } from './workflow-types.js'

/** Helper: create a mock strategy that records calls and delegates to dispatch */
function createMockStrategy(): ParallelismStrategy & {
  executeCalls: Array<{
    tasks: ParallelTask[]
    options: ParallelismStrategyOptions
  }>
} {
  const executeCalls: Array<{
    tasks: ParallelTask[]
    options: ParallelismStrategyOptions
  }> = []

  return {
    executeCalls,
    async execute(
      tasks: ParallelTask[],
      options: ParallelismStrategyOptions,
    ): Promise<ParallelismResult> {
      executeCalls.push({ tasks, options })

      // Use the dispatch function to run all tasks, collecting results
      const completed: ParallelTaskResult[] = []
      for (const task of tasks) {
        const result = await options.dispatch(task)
        completed.push(result)
      }

      return {
        strategy: 'fan-out',
        completed,
        cancelled: [],
        failed: [],
        outputs: {},
      }
    },
  }
}

/** Helper: create a simple dispatch function */
function createDispatch(): (task: ParallelTask) => Promise<ParallelTaskResult> {
  return async (task: ParallelTask): Promise<ParallelTaskResult> => ({
    id: task.id,
    issueId: task.issueId,
    success: true,
    durationMs: 10,
  })
}

/** Helper: create a sample group definition */
function createGroup(
  overrides: Partial<ParallelismGroupDefinition> = {},
): ParallelismGroupDefinition {
  return {
    name: 'test-group',
    phases: ['development'],
    strategy: 'fan-out',
    ...overrides,
  }
}

/** Helper: create sample tasks */
function createTasks(count: number): ParallelTask[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `task-${i + 1}`,
    issueId: `SUP-${100 + i + 1}`,
    phaseName: 'development',
  }))
}

describe('ParallelismExecutor', () => {
  describe('registerStrategy and getStrategy', () => {
    it('registers and retrieves a strategy', () => {
      const executor = new ParallelismExecutor()
      const strategy = createMockStrategy()
      executor.registerStrategy('fan-out', strategy)
      expect(executor.getStrategy('fan-out')).toBe(strategy)
    })

    it('returns undefined for unregistered strategy', () => {
      const executor = new ParallelismExecutor()
      expect(executor.getStrategy('fan-out')).toBeUndefined()
    })

    it('overwrites a previously registered strategy', () => {
      const executor = new ParallelismExecutor()
      const strategy1 = createMockStrategy()
      const strategy2 = createMockStrategy()
      executor.registerStrategy('fan-out', strategy1)
      executor.registerStrategy('fan-out', strategy2)
      expect(executor.getStrategy('fan-out')).toBe(strategy2)
    })
  })

  describe('execute with mock strategy', () => {
    it('delegates to the registered strategy and returns result', async () => {
      const executor = new ParallelismExecutor()
      const strategy = createMockStrategy()
      executor.registerStrategy('fan-out', strategy)

      const group = createGroup()
      const tasks = createTasks(3)
      const dispatch = createDispatch()

      const result = await executor.execute(group, tasks, dispatch)

      expect(result.strategy).toBe('fan-out')
      expect(result.completed).toHaveLength(3)
      expect(result.completed[0].issueId).toBe('SUP-101')
      expect(result.completed[1].issueId).toBe('SUP-102')
      expect(result.completed[2].issueId).toBe('SUP-103')
    })
  })

  describe('execute throws when strategy not registered', () => {
    it('throws with a descriptive error', async () => {
      const executor = new ParallelismExecutor()
      const group = createGroup({ strategy: 'race' })
      const tasks = createTasks(1)
      const dispatch = createDispatch()

      await expect(executor.execute(group, tasks, dispatch)).rejects.toThrow(
        'No strategy registered for "race"',
      )
    })
  })

  describe('execute wraps dispatch with semaphore when maxConcurrent set', () => {
    it('limits concurrency via semaphore', async () => {
      const executor = new ParallelismExecutor()

      let peakConcurrent = 0
      let currentConcurrent = 0

      // Create a strategy that dispatches all tasks in parallel
      const concurrentStrategy: ParallelismStrategy = {
        async execute(
          tasks: ParallelTask[],
          options: ParallelismStrategyOptions,
        ): Promise<ParallelismResult> {
          const promises = tasks.map((task) => options.dispatch(task))
          const completed = await Promise.all(promises)
          return {
            strategy: 'fan-out',
            completed,
            cancelled: [],
            failed: [],
            outputs: {},
          }
        },
      }

      executor.registerStrategy('fan-out', concurrentStrategy)

      const dispatch = async (
        task: ParallelTask,
      ): Promise<ParallelTaskResult> => {
        currentConcurrent++
        peakConcurrent = Math.max(peakConcurrent, currentConcurrent)
        await new Promise((resolve) => setTimeout(resolve, 20))
        currentConcurrent--
        return { id: task.id, issueId: task.issueId, success: true }
      }

      const group = createGroup({ maxConcurrent: 2 })
      const tasks = createTasks(5)

      await executor.execute(group, tasks, dispatch)

      expect(peakConcurrent).toBeLessThanOrEqual(2)
    })
  })

  describe('execute passes options correctly', () => {
    it('passes maxConcurrent and waitForAll to strategy', async () => {
      const executor = new ParallelismExecutor()
      const strategy = createMockStrategy()
      executor.registerStrategy('fan-out', strategy)

      const group = createGroup({ maxConcurrent: 3, waitForAll: true })
      const tasks = createTasks(1)
      const dispatch = createDispatch()

      await executor.execute(group, tasks, dispatch)

      expect(strategy.executeCalls).toHaveLength(1)
      const passedOptions = strategy.executeCalls[0].options
      expect(passedOptions.maxConcurrent).toBe(3)
      expect(passedOptions.waitForAll).toBe(true)
      expect(typeof passedOptions.dispatch).toBe('function')
    })

    it('passes tasks through to the strategy', async () => {
      const executor = new ParallelismExecutor()
      const strategy = createMockStrategy()
      executor.registerStrategy('fan-out', strategy)

      const group = createGroup()
      const tasks = createTasks(2)
      const dispatch = createDispatch()

      await executor.execute(group, tasks, dispatch)

      expect(strategy.executeCalls[0].tasks).toBe(tasks)
    })
  })

  describe('execute without maxConcurrent (no semaphore wrapping)', () => {
    it('does not limit concurrency when maxConcurrent is not set', async () => {
      const executor = new ParallelismExecutor()

      let peakConcurrent = 0
      let currentConcurrent = 0

      const concurrentStrategy: ParallelismStrategy = {
        async execute(
          tasks: ParallelTask[],
          options: ParallelismStrategyOptions,
        ): Promise<ParallelismResult> {
          const promises = tasks.map((task) => options.dispatch(task))
          const completed = await Promise.all(promises)
          return {
            strategy: 'fan-out',
            completed,
            cancelled: [],
            failed: [],
            outputs: {},
          }
        },
      }

      executor.registerStrategy('fan-out', concurrentStrategy)

      const dispatch = async (
        task: ParallelTask,
      ): Promise<ParallelTaskResult> => {
        currentConcurrent++
        peakConcurrent = Math.max(peakConcurrent, currentConcurrent)
        await new Promise((resolve) => setTimeout(resolve, 10))
        currentConcurrent--
        return { id: task.id, issueId: task.issueId, success: true }
      }

      // No maxConcurrent set on the group
      const group = createGroup()
      const tasks = createTasks(5)

      await executor.execute(group, tasks, dispatch)

      // All 5 tasks should have been able to run concurrently
      expect(peakConcurrent).toBe(5)
    })
  })
})
