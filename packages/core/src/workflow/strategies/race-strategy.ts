import type {
  ParallelTask,
  ParallelTaskResult,
  ParallelTaskError,
  ParallelismResult,
  ParallelismStrategy,
  ParallelismStrategyOptions,
} from '../parallelism-types.js'
import { InMemoryAgentCancellation } from '../agent-cancellation.js'

/**
 * Race parallelism strategy.
 *
 * Dispatches N agents in parallel. The first successful completion wins,
 * and cancellation is signaled for all remaining tasks.
 *
 * NOTE: Concurrency limiting (maxConcurrent) is handled by the
 * ConcurrencySemaphore in the ParallelismExecutor — this strategy
 * simply calls `options.dispatch()` for each task.
 */
export class RaceStrategy implements ParallelismStrategy {
  private readonly cancellation: InMemoryAgentCancellation
  private readonly cancellationTimeoutMs: number

  constructor(cancellation?: InMemoryAgentCancellation, cancellationTimeoutMs?: number) {
    this.cancellation = cancellation ?? new InMemoryAgentCancellation()
    this.cancellationTimeoutMs = cancellationTimeoutMs ?? 30_000
  }

  async execute(
    tasks: ParallelTask[],
    options: ParallelismStrategyOptions,
  ): Promise<ParallelismResult> {
    if (tasks.length === 0) {
      return { strategy: 'race', completed: [], cancelled: [], failed: [], outputs: {} }
    }

    const completed: ParallelTaskResult[] = []
    const failed: ParallelTaskError[] = []
    const outputs: Record<string, Record<string, unknown>> = {}
    let winner: ParallelTaskResult | null = null

    // Track each task's promise with its task reference
    type SettledResult =
      | { status: 'fulfilled'; value: ParallelTaskResult; task: ParallelTask }
      | { status: 'rejected'; reason: unknown; task: ParallelTask }

    const taskPromises: Promise<SettledResult>[] = tasks.map((task) =>
      options.dispatch(task).then(
        (result) => ({ status: 'fulfilled' as const, value: result, task }),
        (error) => ({ status: 'rejected' as const, reason: error, task }),
      ),
    )

    // Use a winner-detection approach: wrap each promise to detect the
    // first successful result, signal cancellation, then wait for all to settle.
    let resolveWinner: ((result: ParallelTaskResult | null) => void) | null = null
    const winnerPromise = new Promise<ParallelTaskResult | null>((resolve) => {
      resolveWinner = resolve
    })

    let settledCount = 0
    const totalTasks = tasks.length

    const wrappedPromises = taskPromises.map(async (promise) => {
      const settled = await promise
      settledCount++

      if (settled.status === 'fulfilled') {
        completed.push(settled.value)
        if (settled.value.success && !winner) {
          // First successful completion — this is the winner
          winner = settled.value
          if (settled.value.outputs) {
            outputs[settled.value.issueId] = settled.value.outputs
          }
          // Signal cancellation for all other tasks
          for (const task of tasks) {
            if (task.id !== settled.task.id) {
              await this.cancellation.cancel(task.id)
            }
          }
          resolveWinner?.(settled.value)
        } else if (settled.value.outputs && settled.value.success) {
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

      // If all tasks settled and no winner, resolve
      if (settledCount === totalTasks && !winner) {
        resolveWinner?.(null)
      }
    })

    // Wait for the winner or all to fail
    await winnerPromise
    // Wait for remaining tasks to settle, with a timeout to prevent hanging
    // if agents never check isCancelled() and never complete
    await Promise.race([
      Promise.allSettled(wrappedPromises),
      new Promise<void>((resolve) => setTimeout(resolve, this.cancellationTimeoutMs)),
    ])

    // Build cancelled list (all tasks that were cancelled, excluding winner and failed)
    const cancelledIds = this.cancellation.getCancelledIds()

    return {
      strategy: 'race',
      completed,
      cancelled: cancelledIds,
      failed,
      outputs,
    }
  }
}
