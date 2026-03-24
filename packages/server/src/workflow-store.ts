/**
 * WorkflowStore — Redis-backed persistent storage for WorkflowDefinitions
 *
 * Provides CRUD operations for workflow definitions stored in Redis.
 * Used by the deploy endpoint to persist workflows and by WorkflowRegistry
 * to load them as a higher-priority layer above filesystem defaults.
 *
 * Redis key scheme: `af:workflows:{id}` storing JSON-serialized WorkflowDefinition
 * Index key: `af:workflows:index` (set of all workflow IDs)
 * Pub/sub channel: `af:workflows:updated` for change notifications
 */

import Redis from 'ioredis'
import {
  redisSet,
  redisGet,
  redisDel,
  redisSAdd,
  redisSRem,
  redisSMembers,
  getRedisClient,
} from './redis.js'
import { createLogger } from './logger.js'

const log = createLogger('workflow-store')

const KEY_PREFIX = 'af:workflows'
const INDEX_KEY = `${KEY_PREFIX}:index`
const CHANNEL = `${KEY_PREFIX}:updated`

export interface StoredWorkflow {
  /** The raw workflow definition (validated before storage) */
  definition: Record<string, unknown>
  /** ISO timestamp when first stored */
  createdAt: string
  /** ISO timestamp of last update */
  updatedAt: string
  /** Monotonically increasing version number */
  version: number
}

export interface WorkflowStoreMetadata {
  id: string
  name: string
  version: number
  createdAt: string
  updatedAt: string
}

function workflowKey(id: string): string {
  return `${KEY_PREFIX}:${id}`
}

/**
 * Save a validated workflow definition to Redis.
 * Publishes a change notification on the `af:workflows:updated` channel.
 *
 * @param id - Unique workflow identifier (typically metadata.name)
 * @param definition - Already-validated WorkflowDefinition object
 * @returns Metadata about the stored workflow
 */
export async function workflowStoreSave(
  id: string,
  definition: Record<string, unknown>,
): Promise<WorkflowStoreMetadata> {
  const key = workflowKey(id)
  const now = new Date().toISOString()

  // Read existing to preserve createdAt and bump version
  const existing = await redisGet<StoredWorkflow>(key)
  const version = existing ? existing.version + 1 : 1
  const createdAt = existing?.createdAt ?? now

  const stored: StoredWorkflow = {
    definition,
    createdAt,
    updatedAt: now,
    version,
  }

  await redisSet(key, stored)
  await redisSAdd(INDEX_KEY, id)

  // Publish change notification (best-effort, don't fail the save)
  try {
    const redis = getRedisClient()
    await redis.publish(CHANNEL, JSON.stringify({ action: 'save', id, version }))
  } catch (err) {
    log.warn('Failed to publish workflow change notification', { id, error: err })
  }

  const name = typeof definition.metadata === 'object' && definition.metadata !== null
    ? (definition.metadata as Record<string, unknown>).name as string ?? id
    : id

  log.info('Workflow saved', { id, version })

  return { id, name, version, createdAt, updatedAt: now }
}

/**
 * Get a workflow definition by ID.
 *
 * @returns The stored workflow or null if not found
 */
export async function workflowStoreGet(id: string): Promise<StoredWorkflow | null> {
  return redisGet<StoredWorkflow>(workflowKey(id))
}

/**
 * List all stored workflow IDs with their metadata.
 */
export async function workflowStoreList(): Promise<WorkflowStoreMetadata[]> {
  const ids = await redisSMembers(INDEX_KEY)
  const results: WorkflowStoreMetadata[] = []

  for (const id of ids) {
    const stored = await redisGet<StoredWorkflow>(workflowKey(id))
    if (stored) {
      const name = typeof stored.definition.metadata === 'object' && stored.definition.metadata !== null
        ? (stored.definition.metadata as Record<string, unknown>).name as string ?? id
        : id

      results.push({
        id,
        name,
        version: stored.version,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
      })
    } else {
      // Stale index entry — clean it up
      await redisSRem(INDEX_KEY, id)
    }
  }

  return results
}

/**
 * Delete a workflow definition by ID.
 * Publishes a change notification on the `af:workflows:updated` channel.
 *
 * @returns true if the workflow existed and was deleted
 */
export async function workflowStoreDelete(id: string): Promise<boolean> {
  const deleted = await redisDel(workflowKey(id))
  if (deleted > 0) {
    await redisSRem(INDEX_KEY, id)

    // Publish change notification (best-effort)
    try {
      const redis = getRedisClient()
      await redis.publish(CHANNEL, JSON.stringify({ action: 'delete', id }))
    } catch (err) {
      log.warn('Failed to publish workflow delete notification', { id, error: err })
    }

    log.info('Workflow deleted', { id })
    return true
  }
  return false
}

/** The Redis pub/sub channel used for workflow change notifications */
export const WORKFLOW_UPDATED_CHANNEL = CHANNEL

// ---------------------------------------------------------------------------
// Pub/Sub Subscription
// ---------------------------------------------------------------------------

export interface WorkflowChangeEvent {
  action: 'save' | 'delete'
  id: string
  version?: number
}

export type WorkflowChangeListener = (event: WorkflowChangeEvent) => void

/**
 * Subscribe to workflow change notifications.
 * Creates a dedicated subscriber Redis connection (ioredis subscriber
 * connections cannot execute regular commands).
 *
 * @param listener - Callback invoked on each change event
 * @returns An unsubscribe function that cleans up the subscriber connection
 */
export async function subscribeToWorkflowChanges(
  listener: WorkflowChangeListener,
): Promise<() => Promise<void>> {
  const redisUrl = process.env.REDIS_URL
  if (!redisUrl) {
    throw new Error('REDIS_URL not set — cannot subscribe to workflow changes')
  }

  const subscriber = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  })

  await subscriber.connect()
  await subscriber.subscribe(CHANNEL)

  subscriber.on('message', (channel: string, message: string) => {
    if (channel !== CHANNEL) return
    try {
      const event = JSON.parse(message) as WorkflowChangeEvent
      listener(event)
    } catch (err) {
      log.warn('Failed to parse workflow change event', { error: err })
    }
  })

  return async () => {
    try {
      await subscriber.unsubscribe(CHANNEL)
    } catch {
      // Ignore unsubscribe errors during cleanup
    }
    subscriber.disconnect()
  }
}
