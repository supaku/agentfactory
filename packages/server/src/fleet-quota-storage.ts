/**
 * Fleet Quota Configuration Storage
 *
 * Redis-backed CRUD operations for fleet quota and cohort configurations.
 * Quota definitions are persistent (no TTL) — they're administrative config.
 *
 * Redis key schema:
 *   fleet:quota:config:{name}       — JSON FleetQuota (no TTL)
 *   fleet:quota:cohort:{cohortName} — JSON CohortConfig (no TTL)
 */

import { redisSet, redisGet, redisDel, redisKeys } from './redis.js'
import { createLogger } from './logger.js'
import type { FleetQuota, CohortConfig } from './fleet-quota-types.js'

const log = createLogger('fleet-quota-storage')

const QUOTA_CONFIG_PREFIX = 'fleet:quota:config:'
const COHORT_CONFIG_PREFIX = 'fleet:quota:cohort:'

// ---------------------------------------------------------------------------
// Quota Config CRUD
// ---------------------------------------------------------------------------

/**
 * Store a fleet quota configuration.
 */
export async function setQuotaConfig(quota: FleetQuota): Promise<void> {
  const key = `${QUOTA_CONFIG_PREFIX}${quota.name}`
  await redisSet(key, quota)
  log.info('Quota config stored', { name: quota.name, scope: quota.scope })
}

/**
 * Retrieve a fleet quota configuration by name.
 */
export async function getQuotaConfig(name: string): Promise<FleetQuota | null> {
  const key = `${QUOTA_CONFIG_PREFIX}${name}`
  return redisGet<FleetQuota>(key)
}

/**
 * List all configured fleet quotas.
 */
export async function getAllQuotaConfigs(): Promise<FleetQuota[]> {
  const keys = await redisKeys(`${QUOTA_CONFIG_PREFIX}*`)
  const configs: FleetQuota[] = []

  for (const key of keys) {
    const config = await redisGet<FleetQuota>(key)
    if (config) {
      configs.push(config)
    }
  }

  return configs
}

/**
 * Delete a fleet quota configuration.
 * @returns true if a config was deleted, false if it didn't exist
 */
export async function deleteQuotaConfig(name: string): Promise<boolean> {
  const key = `${QUOTA_CONFIG_PREFIX}${name}`
  const deleted = await redisDel(key)
  if (deleted > 0) {
    log.info('Quota config deleted', { name })
  }
  return deleted > 0
}

// ---------------------------------------------------------------------------
// Cohort Config CRUD
// ---------------------------------------------------------------------------

/**
 * Store a cohort configuration.
 */
export async function setCohortConfig(cohort: CohortConfig): Promise<void> {
  const key = `${COHORT_CONFIG_PREFIX}${cohort.name}`
  await redisSet(key, cohort)
  log.info('Cohort config stored', { name: cohort.name, projects: cohort.projects })
}

/**
 * Retrieve a cohort configuration by name.
 */
export async function getCohortConfig(name: string): Promise<CohortConfig | null> {
  const key = `${COHORT_CONFIG_PREFIX}${name}`
  return redisGet<CohortConfig>(key)
}

/**
 * Find which cohort a project belongs to by scanning all cohorts.
 * Returns the first cohort containing the project, or null.
 */
export async function getCohortForProject(projectName: string): Promise<CohortConfig | null> {
  const keys = await redisKeys(`${COHORT_CONFIG_PREFIX}*`)

  for (const key of keys) {
    const cohort = await redisGet<CohortConfig>(key)
    if (cohort && cohort.projects.includes(projectName)) {
      return cohort
    }
  }

  return null
}
