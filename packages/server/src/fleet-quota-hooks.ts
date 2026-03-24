/**
 * Fleet Quota Lifecycle Hooks
 *
 * Hooks that wire quota tracking (addConcurrentSession, removeConcurrentSession,
 * addDailyCost) into session lifecycle events: claim, complete, fail, stop,
 * and cost updates.
 *
 * Callers should invoke these hooks at the appropriate lifecycle points.
 * All hooks are no-ops when the project has no quota config (opt-in).
 */

import { createLogger } from './logger.js'
import { getQuotaConfig, getCohortConfig } from './fleet-quota-storage.js'
import {
  addConcurrentSession,
  removeConcurrentSession,
  getConcurrentSessionCount,
  addDailyCost,
} from './fleet-quota-tracker.js'
import { tryAtomicBorrow } from './fleet-quota-cohort.js'

const log = createLogger('fleet-quota-hooks')

/**
 * Called when a session is claimed by a worker.
 * Increments concurrent session count for the project's quota.
 *
 * No-op if the project has no quota config.
 */
export async function onSessionClaimed(
  projectName: string | undefined,
  sessionId: string
): Promise<void> {
  if (!projectName) return

  try {
    const config = await getQuotaConfig(projectName)
    if (!config) return

    const currentCount = await getConcurrentSessionCount(config.name)

    if (
      currentCount >= config.maxConcurrentSessions &&
      config.cohort &&
      (config.borrowingLimit ?? 0) > 0
    ) {
      // Over own limit — use atomic borrow from cohort
      const cohort = await getCohortConfig(config.cohort)
      if (cohort) {
        const peers = (
          await Promise.all(
            cohort.projects
              .filter((p) => p !== projectName)
              .map(async (p) => {
                const peerConfig = await getQuotaConfig(p)
                return peerConfig
                  ? {
                      quotaName: peerConfig.name,
                      maxConcurrentSessions: peerConfig.maxConcurrentSessions,
                      lendingLimit: peerConfig.lendingLimit ?? 0,
                    }
                  : null
              })
          )
        ).filter((p): p is NonNullable<typeof p> => p !== null)

        const borrowed = await tryAtomicBorrow(
          config.name,
          sessionId,
          config.maxConcurrentSessions,
          config.borrowingLimit!,
          peers
        )

        if (borrowed) {
          log.info('Quota incremented via atomic borrow', {
            quotaName: config.name,
            sessionId,
            cohort: config.cohort,
          })
        } else {
          // Borrow failed — capacity consumed between filter and claim.
          // Fall back to simple SADD so session still runs; patrol loop will reconcile.
          await addConcurrentSession(config.name, sessionId)
          log.warn('Atomic borrow failed — capacity consumed between filter and claim', {
            quotaName: config.name,
            sessionId,
            projectName,
          })
        }
        return
      }
    }

    // Under own limit or no cohort — simple add
    const count = await addConcurrentSession(config.name, sessionId)
    log.info('Quota incremented on claim', {
      quotaName: config.name,
      sessionId,
      currentSessions: count,
    })
  } catch (err) {
    log.error('Failed to increment quota on claim', {
      projectName,
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Called when a session reaches a terminal state (completed, failed, stopped).
 * Decrements concurrent session count and records final cost.
 *
 * No-op if the project has no quota config.
 */
export async function onSessionTerminated(
  projectName: string | undefined,
  sessionId: string,
  totalCostUsd?: number
): Promise<void> {
  if (!projectName) return

  try {
    const config = await getQuotaConfig(projectName)
    if (!config) return

    const count = await removeConcurrentSession(config.name, sessionId)

    if (totalCostUsd && totalCostUsd > 0) {
      await addDailyCost(config.name, totalCostUsd)
    }

    log.info('Quota decremented on termination', {
      quotaName: config.name,
      sessionId,
      currentSessions: count,
      totalCostUsd,
    })
  } catch (err) {
    log.error('Failed to update quota on termination', {
      projectName,
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Called when cost data is updated mid-session.
 * Adds the incremental cost (delta) to the daily accumulator.
 *
 * @param previousCostUsd - The previous total cost (to calculate delta)
 * @param newCostUsd - The new total cost
 *
 * No-op if the project has no quota config.
 */
export async function onCostUpdated(
  projectName: string | undefined,
  previousCostUsd: number,
  newCostUsd: number
): Promise<void> {
  if (!projectName) return

  const delta = newCostUsd - previousCostUsd
  if (delta <= 0) return

  try {
    const config = await getQuotaConfig(projectName)
    if (!config) return

    await addDailyCost(config.name, delta)
    log.debug('Quota cost updated mid-session', {
      quotaName: config.name,
      delta,
      newTotal: newCostUsd,
    })
  } catch (err) {
    log.error('Failed to update quota cost', {
      projectName,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
