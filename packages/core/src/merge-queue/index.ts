/**
 * Merge Queue Module
 *
 * Factory and exports for merge queue adapters.
 */

import { GitHubNativeMergeQueueAdapter } from './adapters/github-native.js'
import { LocalMergeQueueAdapter } from './adapters/local.js'
import type { LocalMergeQueueStorage } from './adapters/local.js'

export type { MergeQueueAdapter, MergeQueueStatus, MergeQueueProviderName } from './types.js'
export type { LocalMergeQueueStorage } from './adapters/local.js'
export { LocalMergeQueueAdapter } from './adapters/local.js'
export { MergeWorker } from './merge-worker.js'
export type { MergeWorkerConfig, MergeWorkerDeps, MergeProcessResult } from './merge-worker.js'
export { MergePool } from './merge-pool.js'
export type { MergePoolConfig } from './merge-pool.js'
export { buildFileManifest, buildFileManifests } from './file-manifest.js'
export type { PRFileManifest } from './file-manifest.js'
export { ConflictGraph, buildConflictGraph } from './conflict-graph.js'

/** Optional dependencies for adapter construction */
export interface MergeQueueAdapterDeps {
  /** Required for 'local' provider — Redis-backed queue storage */
  storage?: LocalMergeQueueStorage
}

/**
 * Create a merge queue adapter by provider name.
 *
 * @param name - Provider name
 * @param deps - Optional dependencies (storage required for 'local' provider)
 * @returns MergeQueueAdapter instance
 * @throws Error if provider is not yet implemented or required deps are missing
 */
export function createMergeQueueAdapter(
  name: import('./types.js').MergeQueueProviderName,
  deps?: MergeQueueAdapterDeps,
): import('./types.js').MergeQueueAdapter {
  switch (name) {
    case 'github-native':
      return new GitHubNativeMergeQueueAdapter()
    case 'local':
      if (!deps?.storage) {
        throw new Error(
          "Local merge queue adapter requires 'storage' dependency. " +
          'Pass a LocalMergeQueueStorage implementation via deps.storage.'
        )
      }
      return new LocalMergeQueueAdapter(deps.storage)
    case 'mergify':
      throw new Error(
        'Mergify merge queue adapter not yet implemented. Contributions welcome.'
      )
    case 'trunk':
      throw new Error(
        'Trunk merge queue adapter not yet implemented. Contributions welcome.'
      )
    default:
      throw new Error(
        `Unknown merge queue provider: ${name}. Supported: github-native, local, mergify, trunk.`
      )
  }
}
