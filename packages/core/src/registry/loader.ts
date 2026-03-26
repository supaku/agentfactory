/**
 * Provider Plugin Loader
 *
 * Discovers and loads provider plugins into the NodeTypeRegistry at startup.
 * Plugins are passed explicitly via dependency injection — no filesystem scanning.
 */

import type { NodeTypeRegistry } from './node-type-registry.js'
import type { NodeTypeMetadata, DynamicOptionLoader } from './types.js'
import type { ProviderPlugin } from '../providers/plugin-types.js'
import { logger } from '../logger.js'

/**
 * Load an array of provider plugins into the registry.
 *
 * For each plugin:
 * 1. Auto-generates a provider category from plugin metadata
 * 2. Maps each action definition to NodeTypeMetadata
 * 3. Registers each node type in the store
 * 4. Registers a dynamic option loader if provided
 *
 * Malformed plugins are logged and skipped — loading never throws.
 *
 * @param dynamicOptionLoaders - Optional map of provider ID → loader callback
 *   for runtime dynamic option fetching. If omitted, dynamic options are not available.
 */
export function loadProviderPlugins(
  registry: NodeTypeRegistry,
  plugins: ProviderPlugin[],
  dynamicOptionLoaders?: Map<string, DynamicOptionLoader>,
): void {
  for (const plugin of plugins) {
    try {
      if (!plugin.id) {
        logger.warn('Skipping malformed plugin: missing id', {
          plugin: 'unknown',
        })
        continue
      }

      // Auto-generate a provider category from the plugin metadata
      registry.registerCategory({
        id: plugin.id,
        displayName: plugin.displayName,
        description: plugin.description ?? '',
        icon: plugin.icon,
      })

      // Register dynamic option loader if provided
      const loader = dynamicOptionLoaders?.get(plugin.id)
      if (loader) {
        registry.registerDynamicOptionLoader(plugin.id, loader)
      }

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

          const category = action.category ?? plugin.id

          const metadata: NodeTypeMetadata = {
            id: `${plugin.id}:${action.id}`,
            providerId: plugin.id,
            actionId: action.id,
            displayName: action.displayName || action.id,
            description: action.description || '',
            category,
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
