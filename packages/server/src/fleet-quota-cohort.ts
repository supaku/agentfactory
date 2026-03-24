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
 *
 * Race condition protection:
 * The `tryAtomicBorrow` function uses a Lua script to atomically check peer
 * capacity and add the session to the borrower's concurrent set, preventing
 * TOCTOU races when two projects borrow from the same cohort simultaneously.
 */

import { createLogger } from './logger.js'
import { getQuotaConfig, getCohortForProject } from './fleet-quota-storage.js'
import { getQuotaUsage } from './fleet-quota-tracker.js'
import { redisEval } from './redis.js'
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
 * Lua script for atomic borrow check + session add.
 *
 * KEYS[1] = borrower's concurrent set key (fleet:quota:concurrent:{name})
 * ARGV[1] = sessionId to add
 * ARGV[2] = borrower's maxConcurrentSessions
 * ARGV[3] = borrower's borrowingLimit
 * ARGV[4] = number of peer entries (N)
 * ARGV[5..5+N-1] = peer concurrent set keys
 * ARGV[5+N..5+2N-1] = peer maxConcurrentSessions values
 * ARGV[5+2N..5+3N-1] = peer lendingLimit values
 *
 * Returns: 1 if borrowed and session added, 0 if no capacity available
 */
const ATOMIC_BORROW_SCRIPT = `
local borrowerKey = KEYS[1]
local sessionId = ARGV[1]
local maxConcurrent = tonumber(ARGV[2])
local borrowingLimit = tonumber(ARGV[3])
local peerCount = tonumber(ARGV[4])

-- Check borrower's current sessions
local borrowerSessions = redis.call('SCARD', borrowerKey)

-- If under own limit, no borrowing needed (shouldn't reach here, but safety check)
if borrowerSessions < maxConcurrent then
  redis.call('SADD', borrowerKey, sessionId)
  return 1
end

-- Calculate already borrowed
local alreadyBorrowed = borrowerSessions - maxConcurrent
if alreadyBorrowed >= borrowingLimit then
  return 0
end

-- Check peer lending capacity atomically
local totalAvailable = 0
for i = 1, peerCount do
  local peerKey = ARGV[4 + i]
  local peerMax = tonumber(ARGV[4 + peerCount + i])
  local peerLendingLimit = tonumber(ARGV[4 + 2 * peerCount + i])
  local peerSessions = redis.call('SCARD', peerKey)
  local unused = peerMax - peerSessions
  if unused < 0 then unused = 0 end
  local canLend = math.min(peerLendingLimit, unused)
  totalAvailable = totalAvailable + canLend
end

-- Cap by remaining borrowing allowance
local remainingBorrowable = borrowingLimit - alreadyBorrowed
local available = math.min(totalAvailable, remainingBorrowable)

if available > 0 then
  redis.call('SADD', borrowerKey, sessionId)
  return 1
end

return 0
`

/**
 * Atomically check borrowing capacity and add session if available.
 * Uses a Lua script to prevent TOCTOU race conditions.
 *
 * @returns true if the session was added (borrowed), false if no capacity
 */
export async function tryAtomicBorrow(
  borrowerQuotaName: string,
  sessionId: string,
  maxConcurrentSessions: number,
  borrowingLimit: number,
  peers: Array<{
    quotaName: string
    maxConcurrentSessions: number
    lendingLimit: number
  }>
): Promise<boolean> {
  const borrowerKey = `fleet:quota:concurrent:${borrowerQuotaName}`
  const peerKeys = peers.map((p) => `fleet:quota:concurrent:${p.quotaName}`)
  const peerMaxValues = peers.map((p) => p.maxConcurrentSessions)
  const peerLendingLimits = peers.map((p) => p.lendingLimit)

  const args: (string | number)[] = [
    sessionId,
    maxConcurrentSessions,
    borrowingLimit,
    peers.length,
    ...peerKeys,
    ...peerMaxValues,
    ...peerLendingLimits,
  ]

  const result = await redisEval(ATOMIC_BORROW_SCRIPT, [borrowerKey], args)
  return result === 1
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

  // Check available lending capacity from peers (read-only check for admission decision)
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
