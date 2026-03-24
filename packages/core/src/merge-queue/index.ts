/**
 * Merge Queue Module
 *
 * Factory and exports for merge queue adapters.
 */

export type { MergeQueueAdapter, MergeQueueStatus, MergeQueueProviderName } from './types.js'

/**
 * Create a merge queue adapter by provider name.
 *
 * Currently only 'github-native' is implemented.
 * 'mergify' and 'trunk' will throw until implemented.
 *
 * @param name - Provider name
 * @returns MergeQueueAdapter instance
 * @throws Error if provider is not yet implemented
 */
export function createMergeQueueAdapter(name: import('./types.js').MergeQueueProviderName): import('./types.js').MergeQueueAdapter {
  switch (name) {
    case 'github-native':
      // Lazy import to avoid circular dependencies
      // Implementation will be added in SUP-1261
      throw new Error(
        'GitHub native merge queue adapter not yet implemented. See SUP-1261.'
      )
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
        `Unknown merge queue provider: ${name}. Supported: github-native, mergify, trunk.`
      )
  }
}
