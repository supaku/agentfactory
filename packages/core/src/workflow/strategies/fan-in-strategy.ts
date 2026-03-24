import type {
  ParallelTask,
  ParallelTaskError,
  ParallelTaskResult,
  ParallelismResult,
  ParallelismStrategy,
  ParallelismStrategyOptions,
} from '../parallelism-types.js'

/**
 * Fan-in parallelism strategy.
 *
 * Dispatches N agents in parallel and waits for results.
 *
 * When `waitForAll` is true (default): waits for ALL tasks to settle
 * using Promise.allSettled() semantics.
 *
 * When `waitForAll` is false: resolves on the first successful result,
 * but still waits for all remaining tasks to complete for full result
 * collection.
 *
 * NOTE: Concurrency limiting (maxConcurrent) is handled by the
 * ConcurrencySemaphore in the ParallelismExecutor — this strategy
 * simply calls `options.dispatch()` for each task.
 */
export class FanInStrategy implements ParallelismStrategy {
  async execute(
    tasks: ParallelTask[],
    options: ParallelismStrategyOptions,
  ): Promise<ParallelismResult> {
    const completed: ParallelTaskResult[] = []
    const failed: ParallelTaskError[] = []
    const outputs: Record<string, Record<string, unknown>> = {}
    const waitForAll = options.waitForAll !== false // default true

    // Dispatch all tasks, wrapping each result
    const taskPromises = tasks.map((task) =>
      options.dispatch(task).then(
        (result) => ({ status: 'fulfilled' as const, value: result }),
        (error) => ({ status: 'rejected' as const, reason: error, task }),
      ),
    )

    if (waitForAll) {
      // Wait for all tasks to settle
      const results = await Promise.allSettled(taskPromises)
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
    } else {
      // Wait for first success, then collect remaining
      let firstSuccessResolve: ((result: ParallelTaskResult | null) => void) | null =
        null
      const firstSuccessPromise = new Promise<ParallelTaskResult | null>(
        (resolve) => {
          firstSuccessResolve = resolve
        },
      )

      let pendingCount = taskPromises.length
      let hasSuccess = false

      const wrappedPromises = taskPromises.map(async (promise) => {
        const result = await promise
        if (result.status === 'fulfilled') {
          completed.push(result.value)
          if (result.value.outputs) {
            outputs[result.value.issueId] = result.value.outputs
          }
          if (!hasSuccess && result.value.success) {
            hasSuccess = true
            firstSuccessResolve?.(result.value)
          }
        } else {
          const errMsg =
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason)
          failed.push({
            id: result.task.id,
            issueId: result.task.issueId,
            error: errMsg,
          })
        }
        pendingCount--
        if (pendingCount === 0 && !hasSuccess) {
          firstSuccessResolve?.(null)
        }
      })

      // Wait for first success or all to complete
      await firstSuccessPromise
      // Still wait for all remaining to finish
      await Promise.allSettled(wrappedPromises)
    }

    return { strategy: 'fan-in', completed, cancelled: [], failed, outputs }
  }
}
