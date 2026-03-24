/**
 * Redis Streams Observation Store
 *
 * Append-only log of routing observations backed by Redis Streams.
 * Uses XADD / XRANGE / XREVRANGE for durable, ordered storage with
 * configurable stream trimming via MAXLEN ~.
 */

import { getRedisClient, isRedisConfigured } from './redis.js'
import type { ObservationStore } from '@renseiai/agentfactory'
import { ROUTING_KEYS } from '@renseiai/agentfactory'
import type { RoutingObservation } from '@renseiai/agentfactory'
import type { AgentProviderName } from '@renseiai/agentfactory'
import type { AgentWorkType } from '@renseiai/agentfactory'

const log = {
  info: (msg: string, data?: Record<string, unknown>) => console.log(`[routing] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) => console.warn(`[routing] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) => console.error(`[routing] ${msg}`, data ? JSON.stringify(data) : ''),
  debug: (_msg: string, _data?: Record<string, unknown>) => {},
}

/** Default maximum stream length for MAXLEN ~ trimming */
const DEFAULT_MAX_STREAM_LENGTH = 10_000

/**
 * Serialize a RoutingObservation into flat string key-value pairs
 * suitable for Redis Streams (which require all values to be strings).
 */
function serializeObservation(obs: RoutingObservation): string[] {
  const fields: string[] = [
    'id', obs.id,
    'provider', obs.provider,
    'workType', obs.workType,
    'issueIdentifier', obs.issueIdentifier,
    'sessionId', obs.sessionId,
    'reward', String(obs.reward),
    'taskCompleted', String(obs.taskCompleted),
    'prCreated', String(obs.prCreated),
    'qaResult', obs.qaResult,
    'totalCostUsd', String(obs.totalCostUsd),
    'wallClockMs', String(obs.wallClockMs),
    'timestamp', String(obs.timestamp),
    'confidence', String(obs.confidence),
  ]

  if (obs.project !== undefined) {
    fields.push('project', obs.project)
  }

  if (obs.explorationReason !== undefined) {
    fields.push('explorationReason', obs.explorationReason)
  }

  return fields
}

/**
 * Deserialize a flat string map from a Redis Stream entry back into
 * a RoutingObservation object.
 */
function deserializeObservation(fields: Record<string, string>): RoutingObservation {
  return {
    id: fields.id!,
    provider: fields.provider! as AgentProviderName,
    workType: fields.workType! as AgentWorkType,
    issueIdentifier: fields.issueIdentifier!,
    sessionId: fields.sessionId!,
    reward: Number(fields.reward),
    taskCompleted: fields.taskCompleted === 'true',
    prCreated: fields.prCreated === 'true',
    qaResult: fields.qaResult! as RoutingObservation['qaResult'],
    totalCostUsd: Number(fields.totalCostUsd),
    wallClockMs: Number(fields.wallClockMs),
    timestamp: Number(fields.timestamp),
    confidence: Number(fields.confidence),
    ...(fields.project !== undefined ? { project: fields.project } : {}),
    ...(fields.explorationReason !== undefined ? { explorationReason: fields.explorationReason } : {}),
  }
}

/**
 * Parse Redis Stream entries (returned as [id, [field, value, ...]][])
 * into RoutingObservation objects.
 */
function parseStreamEntries(entries: [string, string[]][]): RoutingObservation[] {
  return entries.map(([_streamId, flatFields]) => {
    const fields: Record<string, string> = {}
    for (let i = 0; i < flatFields.length; i += 2) {
      fields[flatFields[i]!] = flatFields[i + 1]!
    }
    return deserializeObservation(fields)
  })
}

export interface RedisObservationStoreOptions {
  /** Maximum stream length for MAXLEN ~ trimming (default: 10,000) */
  maxStreamLength?: number
}

/**
 * Create a Redis Streams–backed ObservationStore.
 *
 * When Redis is not configured the store degrades gracefully:
 * - recordObservation is a no-op (logs a warning once)
 * - getObservations / getRecentObservations return empty arrays
 */
export function createRedisObservationStore(
  options: RedisObservationStoreOptions = {},
): ObservationStore {
  const maxLen = options.maxStreamLength ?? DEFAULT_MAX_STREAM_LENGTH
  const streamKey = ROUTING_KEYS.observations

  const store: ObservationStore = {
    async recordObservation(obs: RoutingObservation): Promise<void> {
      if (!isRedisConfigured()) {
        log.warn('Redis not configured, observation will not be persisted')
        return
      }

      try {
        const client = getRedisClient()
        const fields = serializeObservation(obs)
        await client.xadd(streamKey, 'MAXLEN', '~', String(maxLen), '*', ...fields)
        log.info('Recorded observation', {
          id: obs.id,
          provider: obs.provider,
          workType: obs.workType,
        })
      } catch (err) {
        log.error('Failed to record observation', {
          id: obs.id,
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    },

    async getObservations(opts: {
      provider?: AgentProviderName
      workType?: AgentWorkType
      limit?: number
      since?: number
    }): Promise<RoutingObservation[]> {
      if (!isRedisConfigured()) {
        log.debug('Redis not configured, returning empty observations')
        return []
      }

      try {
        const client = getRedisClient()

        // XRANGE returns entries in chronological order
        // Use '-' and '+' for full range, or a timestamp-based ID for since
        const start = opts.since ? `${opts.since}-0` : '-'
        const end = '+'

        // Fetch more than limit to account for filtering
        const fetchCount = opts.limit
          ? Math.min(opts.limit * 3, maxLen)
          : maxLen

        const raw = await client.xrange(streamKey, start, end, 'COUNT', fetchCount)
        let observations = parseStreamEntries(raw as [string, string[]][])

        // Apply application-level filters (Redis Streams don't support field filtering)
        if (opts.provider) {
          observations = observations.filter((o) => o.provider === opts.provider)
        }
        if (opts.workType) {
          observations = observations.filter((o) => o.workType === opts.workType)
        }
        if (opts.limit) {
          observations = observations.slice(0, opts.limit)
        }

        return observations
      } catch (err) {
        log.error('Failed to get observations', {
          error: err instanceof Error ? err.message : String(err),
        })
        return []
      }
    },

    async getRecentObservations(
      provider: AgentProviderName,
      workType: AgentWorkType,
      windowSize: number,
    ): Promise<RoutingObservation[]> {
      if (!isRedisConfigured()) {
        log.debug('Redis not configured, returning empty recent observations')
        return []
      }

      try {
        const client = getRedisClient()

        // XREVRANGE returns entries newest-first
        // Fetch more than windowSize to account for filtering by provider/workType
        const fetchCount = Math.min(windowSize * 5, maxLen)

        const raw = await client.xrevrange(streamKey, '+', '-', 'COUNT', fetchCount)
        const observations = parseStreamEntries(raw as [string, string[]][])

        // Filter by provider + workType, then take windowSize entries
        const filtered = observations
          .filter((o) => o.provider === provider && o.workType === workType)
          .slice(0, windowSize)

        return filtered
      } catch (err) {
        log.error('Failed to get recent observations', {
          provider,
          workType,
          error: err instanceof Error ? err.message : String(err),
        })
        return []
      }
    },
  }

  return store
}
