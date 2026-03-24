import type {
  ParallelTask,
  ParallelTaskError,
  ParallelTaskResult,
  ParallelismResult,
  ParallelismStrategy,
  ParallelismStrategyOptions,
} from '../parallelism-types.js'

/**
 * Fan-out parallelism strategy.
 *
 * Dispatches N agents in parallel without waiting for completion.
 * All dispatches are initiated concurrently and results are collected
 * from whatever settles during the dispatch window.
 *
 * NOTE: Concurrency limiting (maxConcurrent) is handled by the
 * ConcurrencySemaphore in the ParallelismExecutor — this strategy
 * simply calls `options.dispatch()` for each task.
 */
export class FanOutStrategy implements ParallelismStrategy {
  async execute(
    tasks: ParallelTask[],
    options: ParallelismStrategyOptions,
  ): Promise<ParallelismResult> {
    const completed: ParallelTaskResult[] = []
    const failed: ParallelTaskError[] = []
    const outputs: Record<string, Record<string, unknown>> = {}

    // Fire all dispatches concurrently but don't wait for them
    // Use Promise.allSettled with a short window to catch immediate failures
    const dispatchPromises = tasks.map((task) =>
      options.dispatch(task).then(
        (result) => ({ status: 'fulfilled' as const, value: result, task }),
        (error) => ({ status: 'rejected' as const, reason: error, task }),
      ),
    )

    // Wait for all dispatches to settle — since we already wrapped each
    // promise, Promise.allSettled here will always return 'fulfilled' results
    // containing our inner status objects.
    const results = await Promise.allSettled(dispatchPromises)

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const settled = result.value
        if (settled.status === 'fulfilled') {
          completed.push(settled.value)
          if (settled.value.outputs) {
            outputs[settled.value.issueId] = settled.value.outputs
          }
        } else {
          const errMsg =
            settled.reason instanceof Error
              ? settled.reason.message
              : String(settled.reason)
          failed.push({
            id: settled.task.id,
            issueId: settled.task.issueId,
            error: errMsg,
          })
        }
      }
    }

    return { strategy: 'fan-out', completed, cancelled: [], failed, outputs }
  }
}
