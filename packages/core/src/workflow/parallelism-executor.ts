/**
 * ParallelismExecutor
 *
 * Orchestrates parallel task execution using strategy pattern.
 * Each parallelism group in the workflow definition is executed
 * through its configured strategy with concurrency limiting.
 */

import type { ParallelismGroupDefinition } from './workflow-types.js'
import type {
  ParallelTask,
  ParallelTaskResult,
  ParallelismResult,
  ParallelismStrategy,
  ParallelismStrategyOptions,
} from './parallelism-types.js'
import { ConcurrencySemaphore } from './concurrency-semaphore.js'

export class ParallelismExecutor {
  private readonly strategies: Map<string, ParallelismStrategy> = new Map()

  /**
   * Register a strategy implementation for a strategy name.
   */
  registerStrategy(name: string, strategy: ParallelismStrategy): void {
    this.strategies.set(name, strategy)
  }

  /**
   * Get a registered strategy by name.
   */
  getStrategy(name: string): ParallelismStrategy | undefined {
    return this.strategies.get(name)
  }

  /**
   * Execute a parallelism group with the configured strategy.
   */
  async execute(
    group: ParallelismGroupDefinition,
    tasks: ParallelTask[],
    dispatch: (task: ParallelTask) => Promise<ParallelTaskResult>,
  ): Promise<ParallelismResult> {
    const strategy = this.strategies.get(group.strategy)
    if (!strategy) {
      throw new Error(`No strategy registered for "${group.strategy}"`)
    }

    // Wrap dispatch with semaphore if maxConcurrent is set
    const semaphore = group.maxConcurrent
      ? new ConcurrencySemaphore(group.maxConcurrent)
      : null

    const wrappedDispatch = async (
      task: ParallelTask,
    ): Promise<ParallelTaskResult> => {
      if (semaphore) await semaphore.acquire()
      try {
        return await dispatch(task)
      } finally {
        if (semaphore) semaphore.release()
      }
    }

    const options: ParallelismStrategyOptions = {
      maxConcurrent: group.maxConcurrent,
      waitForAll: group.waitForAll,
      dispatch: wrappedDispatch,
    }

    return strategy.execute(tasks, options)
  }
}
