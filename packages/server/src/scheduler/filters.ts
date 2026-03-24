/**
 * Scheduler Filters Module
 *
 * Implements a K8s-inspired filter pipeline that eliminates ineligible workers
 * before scoring. Each filter is a pure function that returns pass/fail with
 * a reason string on failure.
 *
 * Filters run sequentially per worker. A worker must pass ALL filters to be
 * included in the feasible set sent to the scoring phase.
 */

import type { WorkerInfo } from '../worker-storage.js'
import type { QueuedWork } from '../work-queue.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FilterResult {
  pass: boolean
  reason?: string // Only set on failure
}

export interface SchedulerFilter {
  name: string
  filter(work: QueuedWork, worker: WorkerInfo): FilterResult
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * CapacityFilter: Reject workers that are already at capacity.
 *
 * A worker is at capacity when activeCount >= capacity.
 */
export const CapacityFilter: SchedulerFilter = {
  name: 'CapacityFilter',
  filter(_work: QueuedWork, worker: WorkerInfo): FilterResult {
    if (worker.activeCount >= worker.capacity) {
      return {
        pass: false,
        reason: `worker at capacity (${worker.activeCount}/${worker.capacity})`,
      }
    }
    return { pass: true }
  },
}

/**
 * ProjectFilter: Reject workers whose project list does not include
 * the work item's project.
 *
 * If the worker has no project restriction (projects is undefined or empty),
 * it passes all work items. If the work item has no projectName, it also passes.
 */
export const ProjectFilter: SchedulerFilter = {
  name: 'ProjectFilter',
  filter(work: QueuedWork, worker: WorkerInfo): FilterResult {
    // No project restriction on worker — accept all
    if (!worker.projects || worker.projects.length === 0) {
      return { pass: true }
    }

    // Work item has no project — accept (unscoped work goes anywhere)
    if (!work.projectName) {
      return { pass: true }
    }

    if (!worker.projects.includes(work.projectName)) {
      return {
        pass: false,
        reason: `project ${work.projectName} not in worker's project list`,
      }
    }

    return { pass: true }
  },
}

/**
 * ProviderFilter: Reject workers that do not support the work item's provider.
 *
 * If the worker has no provider restriction (providers is undefined or empty),
 * it passes all work items. If the work item has no provider field, it also passes.
 *
 * Note: The `providers` field was added to WorkerData in this changeset.
 */
export const ProviderFilter: SchedulerFilter = {
  name: 'ProviderFilter',
  filter(work: QueuedWork, worker: WorkerInfo): FilterResult {
    const providers = worker.providers

    // No provider restriction on worker — accept all
    if (!providers || providers.length === 0) {
      return { pass: true }
    }

    // Work item has no provider — accept (generic work goes anywhere)
    const provider = (work as unknown as Record<string, unknown>).provider as
      | string
      | undefined
    if (!provider) {
      return { pass: true }
    }

    if (!providers.includes(provider)) {
      return {
        pass: false,
        reason: `worker does not support provider ${provider}`,
      }
    }

    return { pass: true }
  },
}

/**
 * QuotaFilter: Check if the work item's organization has sufficient API quota.
 *
 * TODO: Wire up once QueuedWork gains an `orgId` field. Currently always passes
 * because QueuedWork does not carry org/workspace identity. When orgId is
 * available, call `isQuotaLow(orgId)` from quota-tracker.ts and fail if low.
 */
export const QuotaFilter: SchedulerFilter = {
  name: 'QuotaFilter',
  filter(_work: QueuedWork, _worker: WorkerInfo): FilterResult {
    // TODO: When QueuedWork has orgId, check quota:
    //   const orgId = (work as any).orgId
    //   if (orgId && await isQuotaLow(orgId)) {
    //     return { pass: false, reason: `quota low for org ${orgId}` }
    //   }
    return { pass: true }
  },
}

/**
 * StatusFilter: Reject workers that are not in 'active' status.
 *
 * Workers in 'draining' or 'offline' status should not receive new work.
 */
export const StatusFilter: SchedulerFilter = {
  name: 'StatusFilter',
  filter(_work: QueuedWork, worker: WorkerInfo): FilterResult {
    if (worker.status !== 'active') {
      return {
        pass: false,
        reason: `worker status is ${worker.status}`,
      }
    }
    return { pass: true }
  },
}

// ---------------------------------------------------------------------------
// Default filter set (order matters for short-circuit efficiency)
// ---------------------------------------------------------------------------

export const DEFAULT_FILTERS: SchedulerFilter[] = [
  StatusFilter,
  CapacityFilter,
  ProjectFilter,
  ProviderFilter,
  QuotaFilter,
]

// ---------------------------------------------------------------------------
// Pipeline Runner
// ---------------------------------------------------------------------------

export interface FilterPipelineResult {
  /** Workers that passed all filters */
  feasible: WorkerInfo[]
  /** Map of workerId -> array of filter failure reasons */
  filtered: Map<string, string[]>
}

/**
 * Run the filter pipeline against a set of workers for a given work item.
 *
 * Each worker is tested against every filter. A worker must pass ALL filters
 * to be included in the feasible set. Failed filters accumulate reasons per
 * worker so callers can log/debug why a worker was excluded.
 */
export function runFilters(
  work: QueuedWork,
  workers: WorkerInfo[],
  filters: SchedulerFilter[] = DEFAULT_FILTERS,
): FilterPipelineResult {
  const feasible: WorkerInfo[] = []
  const filtered = new Map<string, string[]>()

  for (const worker of workers) {
    const failReasons: string[] = []

    for (const f of filters) {
      const result = f.filter(work, worker)
      if (!result.pass && result.reason) {
        failReasons.push(result.reason)
      }
    }

    if (failReasons.length === 0) {
      feasible.push(worker)
    } else {
      filtered.set(worker.id, failReasons)
    }
  }

  return { feasible, filtered }
}
