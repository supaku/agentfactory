/**
 * Node Type Registry
 *
 * In-memory store that holds provider plugin metadata and serves it
 * to the canvas UI and execution engine. Synchronous for reads,
 * with a single async method for dynamic option loading.
 */

import type {
  NodeTypeMetadata,
  ProviderCategory,
  DynamicOptionResult,
  ProviderPlugin,
} from './types.js'
import { logger } from '../logger.js'

export class NodeTypeRegistry {
  private nodeTypes = new Map<string, NodeTypeMetadata>()
  private categories = new Map<string, ProviderCategory>()
  private plugins = new Map<string, ProviderPlugin>()
  private dynamicOptionsCache = new Map<string, { result: DynamicOptionResult; expiresAt: number }>()
  private cacheTtlMs: number

  constructor(options?: { cacheTtlMs?: number }) {
    this.cacheTtlMs = options?.cacheTtlMs ?? 60_000
  }

  static create(options?: { cacheTtlMs?: number }): NodeTypeRegistry {
    return new NodeTypeRegistry(options)
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  /** Register a node type metadata entry */
  register(metadata: NodeTypeMetadata): void {
    const key = this.makeNodeTypeKey(metadata.providerId, metadata.actionId)
    this.nodeTypes.set(key, metadata)
  }

  /** Register a provider category */
  registerCategory(category: ProviderCategory): void {
    this.categories.set(category.id, category)
  }

  /** Store a provider plugin reference (used for dynamic option delegation) */
  registerPlugin(plugin: ProviderPlugin): void {
    this.plugins.set(plugin.id, plugin)
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /** List all registered provider categories */
  getCategories(): ProviderCategory[] {
    return Array.from(this.categories.values())
  }

  /** List node types, optionally filtered by category */
  getNodeTypes(category?: string): NodeTypeMetadata[] {
    const all = Array.from(this.nodeTypes.values())
    if (!category) return all
    return all.filter((nt) => nt.category === category)
  }

  /** Get a specific node type by provider and action ID */
  getNodeType(providerId: string, actionId: string): NodeTypeMetadata | undefined {
    const key = this.makeNodeTypeKey(providerId, actionId)
    return this.nodeTypes.get(key)
  }

  /** Get the input schema for a specific node type */
  getInputSchema(providerId: string, actionId: string): Record<string, unknown> | undefined {
    const nodeType = this.getNodeType(providerId, actionId)
    return nodeType?.inputSchema
  }

  // ---------------------------------------------------------------------------
  // Dynamic Options
  // ---------------------------------------------------------------------------

  /**
   * Load dynamic options for a dropdown field by delegating to the provider plugin.
   * This is the only async method on the registry.
   *
   * @param providerId - The provider plugin ID
   * @param actionId - The action ID within the provider
   * @param fieldPath - The field path that needs dynamic options
   * @param context - Optional dependent field values
   * @returns Array of options, or empty array on error
   */
  async loadDynamicOptions(
    providerId: string,
    actionId: string,
    fieldPath: string,
    context?: Record<string, unknown>,
  ): Promise<DynamicOptionResult> {
    const cacheKey = this.makeCacheKey(providerId, actionId, fieldPath, context)
    const cached = this.dynamicOptionsCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result
    }

    const plugin = this.plugins.get(providerId)
    if (!plugin) {
      logger.warn('No plugin registered for dynamic options', { providerId, actionId, fieldPath })
      return []
    }

    const action = plugin.actions.find((a) => a.id === actionId)
    if (!action?.fetchDynamicOptions) {
      logger.warn('Action does not support dynamic options', { providerId, actionId, fieldPath })
      return []
    }

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10_000)

      const result = await Promise.race([
        action.fetchDynamicOptions(fieldPath, context),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () =>
            reject(new Error('Dynamic options request timed out')),
          )
        }),
      ])

      clearTimeout(timeout)

      this.dynamicOptionsCache.set(cacheKey, {
        result,
        expiresAt: Date.now() + this.cacheTtlMs,
      })

      return result
    } catch (error) {
      logger.warn('Failed to load dynamic options', {
        providerId,
        actionId,
        fieldPath,
        error: error instanceof Error ? error.message : String(error),
      })
      return []
    }
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  /** Reset the store (for testing) */
  clear(): void {
    this.nodeTypes.clear()
    this.categories.clear()
    this.plugins.clear()
    this.dynamicOptionsCache.clear()
  }

  private makeNodeTypeKey(providerId: string, actionId: string): string {
    return `${providerId}:${actionId}`
  }

  private makeCacheKey(
    providerId: string,
    actionId: string,
    fieldPath: string,
    context?: Record<string, unknown>,
  ): string {
    const base = `${providerId}:${actionId}:${fieldPath}`
    if (!context || Object.keys(context).length === 0) return base
    return `${base}:${JSON.stringify(context)}`
  }
}
