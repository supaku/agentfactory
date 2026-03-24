/**
 * Fleet Quota Filter
 *
 * Admission control gate that prevents work dispatch when a project has
 * exceeded its quota limits. Integrates into the worker poll handler's
 * filter chain after the project filter.
 *
 * Filter chain: CapacityFilter → ProjectFilter → **QuotaFilter** → ...
 */

import { createLogger } from './logger.js'
import { getQuotaConfig } from './fleet-quota-storage.js'
import { getQuotaUsage } from './fleet-quota-tracker.js'
import { checkQuotaWithBorrowing } from './fleet-quota-cohort.js'
import type { QueuedWork } from './work-queue.js'
import type { FleetQuota, FleetQuotaUsage } from './fleet-quota-types.js'

const log = createLogger('fleet-quota-filter')

export interface QuotaFilterResult {
  allowed: QueuedWork[]
  rejected: { work: QueuedWork; reason: string }[]
}

/**
 * Filter work items based on fleet quota constraints.
 * Called during worker poll to exclude work from over-quota projects.
 *
 * Batch-fetches quota configs and usage for all unique projects to avoid N+1.
 * Projects without quota config are allowed through (opt-in).
 */
export async function filterByQuota(
  work: QueuedWork[]
): Promise<QuotaFilterResult> {
  if (work.length === 0) {
    return { allowed: [], rejected: [] }
  }

  // Collect unique project names
  const projectNames = new Set<string>()
  for (const w of work) {
    if (w.projectName) {
      projectNames.add(w.projectName)
    }
  }

  // Batch-fetch configs and usage for all projects
  const configMap = new Map<string, FleetQuota>()
  const usageMap = new Map<string, FleetQuotaUsage>()

  await Promise.all(
    Array.from(projectNames).map(async (name) => {
      const config = await getQuotaConfig(name)
      if (config) {
        configMap.set(name, config)
        const usage = await getQuotaUsage(config.name)
        usageMap.set(name, usage)
      }
    })
  )

  const allowed: QueuedWork[] = []
  const rejected: { work: QueuedWork; reason: string }[] = []

  for (const w of work) {
    if (!w.projectName) {
      // No project tag → allow (no quota to enforce)
      allowed.push(w)
      continue
    }

    const config = configMap.get(w.projectName)
    if (!config) {
      // No quota config for this project → allow (opt-in)
      allowed.push(w)
      continue
    }

    const usage = usageMap.get(w.projectName)!

    // Check daily budget (not borrowable)
    if (usage.dailyCostUsd >= config.maxDailyCostUsd) {
      rejected.push({
        work: w,
        reason: `daily_budget: $${usage.dailyCostUsd.toFixed(2)}/$${config.maxDailyCostUsd.toFixed(2)}`,
      })
      continue
    }

    // Check concurrent session limit (with cohort borrowing)
    if (usage.currentSessions >= config.maxConcurrentSessions) {
      // Over own limit — try borrowing from cohort
      const check = await checkQuotaWithBorrowing(w.projectName)
      if (!check.allowed) {
        rejected.push({
          work: w,
          reason: `concurrent_limit: ${usage.currentSessions}/${config.maxConcurrentSessions}`,
        })
        continue
      }
      if (check.borrowed) {
        log.info('Work admitted via borrowed capacity', {
          sessionId: w.sessionId,
          project: w.projectName,
        })
      }
    }

    allowed.push(w)
  }

  if (rejected.length > 0) {
    log.info('Quota filter rejected work items', {
      rejectedCount: rejected.length,
      rejected: rejected.map((r) => ({
        sessionId: r.work.sessionId,
        project: r.work.projectName,
        reason: r.reason,
      })),
    })
  }

  return { allowed, rejected }
}
