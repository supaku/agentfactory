/**
 * Fleet Quota Cohort Borrowing/Lending
 *
 * Kueue-inspired cohort borrowing/lending: when a project exceeds its own quota,
 * it can borrow unused capacity from other projects in the same cohort
 * (up to configured limits).
 *
 * Borrowing algorithm:
 * 1. Check own quota first
 * 2. If over own quota, check if borrowing is possible from cohort peers
 * 3. Return admission decision with borrowing state
 */

import { createLogger } from './logger.js'
import { getQuotaConfig, getCohortForProject } from './fleet-quota-storage.js'
import { getQuotaUsage } from './fleet-quota-tracker.js'
import type { FleetQuota, FleetQuotaUsage, QuotaCheck } from './fleet-quota-types.js'

const log = createLogger('fleet-quota-cohort')

export interface CohortCapacityBreakdown {
  project: string
  maxConcurrent: number
  currentSessions: number
  lendingLimit: number
  availableToLend: number
}

export interface QuotaCheckWithBorrowing extends QuotaCheck {
  /** Whether this admission used borrowed capacity */
  borrowed: boolean
}

/**
 * Calculate how much borrowing capacity is available for a project
 * from its cohort peers.
 */
export async function getAvailableBorrowingCapacity(
  projectName: string
): Promise<{ available: number; breakdown: CohortCapacityBreakdown[] }> {
  const cohort = await getCohortForProject(projectName)
  if (!cohort) {
    return { available: 0, breakdown: [] }
  }

  const config = await getQuotaConfig(projectName)
  if (!config || !config.borrowingLimit || config.borrowingLimit <= 0) {
    return { available: 0, breakdown: [] }
  }

  const breakdown: CohortCapacityBreakdown[] = []
  let totalAvailable = 0

  // Fetch all peer configs and usage in parallel
  const peers = cohort.projects.filter((p) => p !== projectName)
  const peerData = await Promise.all(
    peers.map(async (peerName) => ({
      name: peerName,
      config: await getQuotaConfig(peerName),
      usage: await getQuotaUsage(peerName),
    }))
  )

  for (const peer of peerData) {
    if (!peer.config) continue

    const lendingLimit = peer.config.lendingLimit ?? 0
    if (lendingLimit <= 0) continue

    // Available to lend = min(lendingLimit, unused capacity)
    const unusedCapacity = Math.max(
      0,
      peer.config.maxConcurrentSessions - peer.usage.currentSessions
    )
    const availableToLend = Math.min(lendingLimit, unusedCapacity)

    breakdown.push({
      project: peer.name,
      maxConcurrent: peer.config.maxConcurrentSessions,
      currentSessions: peer.usage.currentSessions,
      lendingLimit,
      availableToLend,
    })

    totalAvailable += availableToLend
  }

  // Cap by borrower's borrowingLimit
  const cappedAvailable = Math.min(totalAvailable, config.borrowingLimit)

  return { available: cappedAvailable, breakdown }
}

/**
 * Check if a project can admit a new session, considering borrowing.
 *
 * 1. Check own quota first
 * 2. If over own quota, check if borrowing is possible
 * 3. Return admission decision with reason
 */
export async function checkQuotaWithBorrowing(
  projectName: string
): Promise<QuotaCheckWithBorrowing> {
  const config = await getQuotaConfig(projectName)
  if (!config) {
    return { allowed: true, reason: 'ok', borrowed: false }
  }

  const usage = await getQuotaUsage(config.name)

  // Check daily budget first (not borrowable for sessions)
  if (usage.dailyCostUsd >= config.maxDailyCostUsd) {
    return {
      allowed: false,
      reason: 'daily_budget',
      currentUsage: usage,
      borrowed: false,
    }
  }

  // Check concurrent sessions
  if (usage.currentSessions < config.maxConcurrentSessions) {
    // Under own limit — no borrowing needed
    return {
      allowed: true,
      reason: 'ok',
      currentUsage: usage,
      borrowed: false,
    }
  }

  // Over own limit — try borrowing
  if (!config.cohort) {
    return {
      allowed: false,
      reason: 'concurrent_limit',
      currentUsage: usage,
      borrowed: false,
    }
  }

  // Calculate already-borrowed sessions
  const alreadyBorrowed = Math.max(
    0,
    usage.currentSessions - config.maxConcurrentSessions
  )
  const borrowingLimit = config.borrowingLimit ?? 0

  if (borrowingLimit <= 0 || alreadyBorrowed >= borrowingLimit) {
    return {
      allowed: false,
      reason: 'concurrent_limit',
      currentUsage: usage,
      borrowed: false,
    }
  }

  // Check available lending capacity from peers
  const { available } = await getAvailableBorrowingCapacity(projectName)

  if (available <= 0) {
    log.debug('No borrowing capacity available from cohort', {
      projectName,
      cohort: config.cohort,
    })
    return {
      allowed: false,
      reason: 'concurrent_limit',
      currentUsage: usage,
      borrowed: false,
    }
  }

  log.info('Admission via borrowed capacity', {
    projectName,
    cohort: config.cohort,
    alreadyBorrowed,
    availableFromPeers: available,
  })

  return {
    allowed: true,
    reason: 'ok',
    currentUsage: usage,
    borrowed: true,
  }
}
