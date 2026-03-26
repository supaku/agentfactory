/**
 * Provider Plugin Loader
 *
 * Discovers and loads provider plugins into the NodeTypeRegistry at startup.
 * Plugins are passed explicitly via dependency injection — no filesystem scanning.
 */

import type { NodeTypeRegistry } from './node-type-registry.js'
import type { ProviderPlugin, NodeTypeMetadata } from './types.js'
import { logger } from '../logger.js'

/**
 * Load an array of provider plugins into the registry.
 *
 * For each plugin:
 * 1. Registers the plugin's category
 * 2. Maps each action definition to NodeTypeMetadata
 * 3. Registers each node type in the store
 * 4. Stores the plugin reference for dynamic option delegation
 *
 * Malformed plugins are logged and skipped — loading never throws.
 */
export function loadProviderPlugins(
  registry: NodeTypeRegistry,
  plugins: ProviderPlugin[],
): void {
  for (const plugin of plugins) {
    try {
      if (!plugin.id || !plugin.category) {
        logger.warn('Skipping malformed plugin: missing id or category', {
          plugin: plugin.id ?? 'unknown',
        })
        continue
      }

      // Register the provider's category (deduplicates by id)
      registry.registerCategory(plugin.category)

      // Store the plugin for dynamic option delegation
      registry.registerPlugin(plugin)

      // Map each action to NodeTypeMetadata and register
      if (!Array.isArray(plugin.actions)) {
        logger.warn('Skipping plugin with no actions array', { plugin: plugin.id })
        continue
      }

      for (const action of plugin.actions) {
        try {
          if (!action.id) {
            logger.warn('Skipping action with missing id', { plugin: plugin.id })
            continue
          }

          const metadata: NodeTypeMetadata = {
            id: `${plugin.id}:${action.id}`,
            providerId: plugin.id,
            actionId: action.id,
            displayName: action.displayName || action.id,
            description: action.description || '',
            category: plugin.category.id,
            inputSchema: action.inputSchema || {},
            outputSchema: action.outputSchema,
            dynamicOptionFields: action.dynamicOptions?.map((d) => d.fieldPath),
          }

          registry.register(metadata)
        } catch (actionError) {
          logger.warn('Skipping malformed action', {
            plugin: plugin.id,
            action: action.id,
            error: actionError instanceof Error ? actionError.message : String(actionError),
          })
        }
      }

      logger.info('Loaded provider plugin', {
        plugin: plugin.id,
        actions: plugin.actions.length,
      })
    } catch (error) {
      logger.warn('Skipping malformed plugin', {
        plugin: plugin.id ?? 'unknown',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
