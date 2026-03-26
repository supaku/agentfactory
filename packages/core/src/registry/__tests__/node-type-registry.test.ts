import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NodeTypeRegistry } from '../node-type-registry.js'
import { loadProviderPlugins } from '../loader.js'
import type {
  NodeTypeMetadata,
  ProviderCategory,
  DynamicOptionResult,
  DynamicOptionLoader,
} from '../types.js'
import type { ProviderPlugin, ActionDefinition, ActionResult, ProviderExecutionContext } from '../../providers/plugin-types.js'

// Mock logger to suppress output during tests
vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeCategory(overrides?: Partial<ProviderCategory>): ProviderCategory {
  return {
    id: 'project-management',
    displayName: 'Project Management',
    description: 'Project management tools',
    icon: 'folder',
    ...overrides,
  }
}

function makeNodeType(overrides?: Partial<NodeTypeMetadata>): NodeTypeMetadata {
  return {
    id: 'linear:create-issue',
    providerId: 'linear',
    actionId: 'create-issue',
    displayName: 'Create Issue',
    description: 'Create a new Linear issue',
    category: 'project-management',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        teamId: { type: 'string' },
      },
      required: ['title', 'teamId'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
    },
    ...overrides,
  }
}

const stubExecute = async (
  _input: Record<string, unknown>,
  _context: ProviderExecutionContext,
): Promise<ActionResult> => ({ success: true })

function makeAction(overrides?: Partial<ActionDefinition>): ActionDefinition {
  return {
    id: 'create-issue',
    displayName: 'Create Issue',
    description: 'Create a new issue',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        teamId: { type: 'string' },
      },
    },
    outputSchema: { type: 'object' },
    execute: stubExecute,
    ...overrides,
  }
}

function makePlugin(overrides?: Partial<ProviderPlugin>): ProviderPlugin {
  return {
    id: 'linear',
    displayName: 'Linear',
    description: 'Linear issue tracker',
    version: '1.0.0',
    actions: [makeAction()],
    triggers: [],
    conditions: [],
    credentials: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Core Registry Tests
// ---------------------------------------------------------------------------

describe('NodeTypeRegistry', () => {
  let registry: NodeTypeRegistry

  beforeEach(() => {
    registry = NodeTypeRegistry.create()
  })

  describe('static create()', () => {
    it('creates a new registry instance', () => {
      const reg = NodeTypeRegistry.create()
      expect(reg).toBeInstanceOf(NodeTypeRegistry)
    })

    it('accepts cache TTL option', () => {
      const reg = NodeTypeRegistry.create({ cacheTtlMs: 5000 })
      expect(reg).toBeInstanceOf(NodeTypeRegistry)
    })
  })

  describe('register()', () => {
    it('adds node type metadata to the store', () => {
      const metadata = makeNodeType()
      registry.register(metadata)

      const result = registry.getNodeType('linear', 'create-issue')
      expect(result).toEqual(metadata)
    })

    it('overwrites duplicate registrations (same providerId + actionId)', () => {
      registry.register(makeNodeType({ displayName: 'Original' }))
      registry.register(makeNodeType({ displayName: 'Updated' }))

      const result = registry.getNodeType('linear', 'create-issue')
      expect(result?.displayName).toBe('Updated')
    })
  })

  describe('registerCategory()', () => {
    it('adds a provider category', () => {
      registry.registerCategory(makeCategory())

      const categories = registry.getCategories()
      expect(categories).toHaveLength(1)
      expect(categories[0].id).toBe('project-management')
    })

    it('deduplicates categories by id', () => {
      registry.registerCategory(makeCategory({ displayName: 'PM v1' }))
      registry.registerCategory(makeCategory({ displayName: 'PM v2' }))

      const categories = registry.getCategories()
      expect(categories).toHaveLength(1)
      expect(categories[0].displayName).toBe('PM v2')
    })
  })

  describe('getCategories()', () => {
    it('returns all registered categories', () => {
      registry.registerCategory(makeCategory({ id: 'pm', displayName: 'PM' }))
      registry.registerCategory(makeCategory({ id: 'comms', displayName: 'Communication' }))

      const categories = registry.getCategories()
      expect(categories).toHaveLength(2)
      expect(categories.map((c) => c.id)).toContain('pm')
      expect(categories.map((c) => c.id)).toContain('comms')
    })

    it('returns empty array when no categories registered', () => {
      expect(registry.getCategories()).toEqual([])
    })
  })

  describe('getNodeTypes()', () => {
    it('returns all node types when no category filter', () => {
      registry.register(makeNodeType({ providerId: 'linear', actionId: 'a1', category: 'pm' }))
      registry.register(makeNodeType({ providerId: 'slack', actionId: 'a2', category: 'comms' }))

      const types = registry.getNodeTypes()
      expect(types).toHaveLength(2)
    })

    it('filters by category when provided', () => {
      registry.register(makeNodeType({ providerId: 'linear', actionId: 'a1', category: 'pm' }))
      registry.register(makeNodeType({ providerId: 'slack', actionId: 'a2', category: 'comms' }))

      const pmTypes = registry.getNodeTypes('pm')
      expect(pmTypes).toHaveLength(1)
      expect(pmTypes[0].providerId).toBe('linear')
    })

    it('returns empty array for unknown category', () => {
      registry.register(makeNodeType())
      expect(registry.getNodeTypes('unknown')).toEqual([])
    })

    it('returns empty array when no node types registered', () => {
      expect(registry.getNodeTypes()).toEqual([])
    })
  })

  describe('getNodeType()', () => {
    it('returns specific node type by providerId and actionId', () => {
      registry.register(makeNodeType())
      const result = registry.getNodeType('linear', 'create-issue')
      expect(result?.displayName).toBe('Create Issue')
    })

    it('returns undefined for unregistered node type', () => {
      expect(registry.getNodeType('unknown', 'unknown')).toBeUndefined()
    })
  })

  describe('getInputSchema()', () => {
    it('returns JSON Schema for a registered node type', () => {
      const schema = { type: 'object', properties: { title: { type: 'string' } } }
      registry.register(makeNodeType({ inputSchema: schema }))

      const result = registry.getInputSchema('linear', 'create-issue')
      expect(result).toEqual(schema)
    })

    it('returns undefined for unregistered node type', () => {
      expect(registry.getInputSchema('unknown', 'unknown')).toBeUndefined()
    })
  })

  describe('clear()', () => {
    it('resets the store completely', () => {
      registry.register(makeNodeType())
      registry.registerCategory(makeCategory())

      registry.clear()

      expect(registry.getNodeTypes()).toEqual([])
      expect(registry.getCategories()).toEqual([])
      expect(registry.getNodeType('linear', 'create-issue')).toBeUndefined()
    })
  })
})

// ---------------------------------------------------------------------------
// Plugin Loading Tests
// ---------------------------------------------------------------------------

describe('loadProviderPlugins()', () => {
  let registry: NodeTypeRegistry

  beforeEach(() => {
    registry = NodeTypeRegistry.create()
  })

  it('populates registry from mock provider plugins', () => {
    loadProviderPlugins(registry, [makePlugin()])

    const categories = registry.getCategories()
    expect(categories).toHaveLength(1)
    // Category is auto-generated from plugin id
    expect(categories[0].id).toBe('linear')

    const nodeTypes = registry.getNodeTypes()
    expect(nodeTypes).toHaveLength(1)
    expect(nodeTypes[0].providerId).toBe('linear')
    expect(nodeTypes[0].actionId).toBe('create-issue')
  })

  it('loads multiple plugins', () => {
    const slackPlugin = makePlugin({
      id: 'slack',
      displayName: 'Slack',
      description: 'Slack messaging',
      actions: [
        makeAction({ id: 'send-message', displayName: 'Send Message' }),
        makeAction({ id: 'list-channels', displayName: 'List Channels' }),
      ],
    })

    loadProviderPlugins(registry, [makePlugin(), slackPlugin])

    expect(registry.getCategories()).toHaveLength(2)
    expect(registry.getNodeTypes()).toHaveLength(3)
  })

  it('handles malformed plugin — missing id', () => {
    const badPlugin = { ...makePlugin(), id: '' } as ProviderPlugin
    loadProviderPlugins(registry, [badPlugin])

    expect(registry.getNodeTypes()).toEqual([])
  })

  it('handles malformed plugin — no actions array', () => {
    const badPlugin = { ...makePlugin(), actions: undefined } as unknown as ProviderPlugin
    loadProviderPlugins(registry, [badPlugin])

    // Category should still be registered
    expect(registry.getCategories()).toHaveLength(1)
    // But no node types
    expect(registry.getNodeTypes()).toEqual([])
  })

  it('skips actions with missing id', () => {
    const plugin = makePlugin({
      actions: [
        makeAction({ id: '' }),
        makeAction({ id: 'valid-action' }),
      ],
    })

    loadProviderPlugins(registry, [plugin])
    expect(registry.getNodeTypes()).toHaveLength(1)
    expect(registry.getNodeTypes()[0].actionId).toBe('valid-action')
  })

  it('handles empty plugin list', () => {
    loadProviderPlugins(registry, [])

    expect(registry.getNodeTypes()).toEqual([])
    expect(registry.getCategories()).toEqual([])
  })

  it('deduplicates categories from multiple plugins with same id', () => {
    const plugin1 = makePlugin({ id: 'linear' })
    const plugin2 = makePlugin({
      id: 'linear',
      displayName: 'Linear Updated',
      actions: [makeAction({ id: 'create-ticket' })],
    })

    loadProviderPlugins(registry, [plugin1, plugin2])

    // Same plugin id → same category, deduplicated
    expect(registry.getCategories()).toHaveLength(1)
    expect(registry.getNodeTypes()).toHaveLength(2)
  })

  it('maps dynamic option fields from action definitions', () => {
    const plugin = makePlugin({
      actions: [
        makeAction({
          id: 'create-issue',
          dynamicOptions: [
            { fieldPath: 'teamId' },
            { fieldPath: 'projectId', dependsOn: ['teamId'] },
          ],
        }),
      ],
    })

    loadProviderPlugins(registry, [plugin])

    const nodeType = registry.getNodeType('linear', 'create-issue')
    expect(nodeType?.dynamicOptionFields).toEqual(['teamId', 'projectId'])
  })

  it('constructs composite node type id from plugin and action', () => {
    loadProviderPlugins(registry, [makePlugin()])

    const nodeType = registry.getNodeType('linear', 'create-issue')
    expect(nodeType?.id).toBe('linear:create-issue')
  })

  it('uses action category when present', () => {
    const plugin = makePlugin({
      actions: [
        makeAction({ id: 'create-issue', category: 'project-management' }),
      ],
    })

    loadProviderPlugins(registry, [plugin])

    const nodeType = registry.getNodeType('linear', 'create-issue')
    expect(nodeType?.category).toBe('project-management')
  })

  it('falls back to plugin id for category when action has no category', () => {
    const plugin = makePlugin({
      id: 'linear',
      actions: [makeAction({ id: 'create-issue', category: undefined })],
    })

    loadProviderPlugins(registry, [plugin])

    const nodeType = registry.getNodeType('linear', 'create-issue')
    expect(nodeType?.category).toBe('linear')
  })
})

// ---------------------------------------------------------------------------
// Dynamic Option Tests
// ---------------------------------------------------------------------------

describe('NodeTypeRegistry dynamic options', () => {
  let registry: NodeTypeRegistry

  beforeEach(() => {
    registry = NodeTypeRegistry.create({ cacheTtlMs: 100 })
  })

  it('delegates to registered loader for options', async () => {
    const mockOptions: DynamicOptionResult = [
      { value: 'team-1', label: 'Engineering' },
      { value: 'team-2', label: 'Design' },
    ]

    const loader: DynamicOptionLoader = vi.fn().mockResolvedValue(mockOptions)
    registry.registerDynamicOptionLoader('linear', loader)

    loadProviderPlugins(registry, [makePlugin()])

    const result = await registry.loadDynamicOptions('linear', 'create-issue', 'teamId')
    expect(result).toEqual(mockOptions)
  })

  it('returns empty array when no loader registered', async () => {
    const result = await registry.loadDynamicOptions('unknown', 'action', 'field')
    expect(result).toEqual([])
  })

  it('returns empty array when no loader for provider', async () => {
    loadProviderPlugins(registry, [makePlugin()])

    const result = await registry.loadDynamicOptions('linear', 'create-issue', 'teamId')
    expect(result).toEqual([])
  })

  it('returns empty array on loader error', async () => {
    const loader: DynamicOptionLoader = vi.fn().mockRejectedValue(new Error('API error'))
    registry.registerDynamicOptionLoader('linear', loader)

    loadProviderPlugins(registry, [makePlugin()])

    const result = await registry.loadDynamicOptions('linear', 'create-issue', 'teamId')
    expect(result).toEqual([])
  })

  it('caches results within TTL', async () => {
    const loader = vi.fn<DynamicOptionLoader>().mockResolvedValue([{ value: 'v1', label: 'L1' }])
    registry.registerDynamicOptionLoader('linear', loader)

    loadProviderPlugins(registry, [makePlugin()])

    // First call
    await registry.loadDynamicOptions('linear', 'create-issue', 'teamId')
    // Second call (should use cache)
    await registry.loadDynamicOptions('linear', 'create-issue', 'teamId')

    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('refetches after cache TTL expires', async () => {
    const loader = vi.fn<DynamicOptionLoader>().mockResolvedValue([{ value: 'v1', label: 'L1' }])

    // Use very short TTL
    registry = NodeTypeRegistry.create({ cacheTtlMs: 1 })
    registry.registerDynamicOptionLoader('linear', loader)
    loadProviderPlugins(registry, [makePlugin()])

    await registry.loadDynamicOptions('linear', 'create-issue', 'teamId')

    // Wait for cache to expire
    await new Promise((resolve) => setTimeout(resolve, 10))

    await registry.loadDynamicOptions('linear', 'create-issue', 'teamId')
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('passes context to loader', async () => {
    const loader = vi.fn<DynamicOptionLoader>().mockResolvedValue([])
    registry.registerDynamicOptionLoader('linear', loader)

    loadProviderPlugins(registry, [makePlugin()])

    const context = { teamId: 'team-1' }
    await registry.loadDynamicOptions('linear', 'create-issue', 'projectId', context)

    expect(loader).toHaveBeenCalledWith('create-issue', 'projectId', context)
  })

  it('uses separate cache entries for different contexts', async () => {
    const loader = vi.fn<DynamicOptionLoader>().mockResolvedValue([])
    registry.registerDynamicOptionLoader('linear', loader)

    loadProviderPlugins(registry, [makePlugin()])

    await registry.loadDynamicOptions('linear', 'create-issue', 'field', { a: '1' })
    await registry.loadDynamicOptions('linear', 'create-issue', 'field', { a: '2' })

    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('handles timeout for slow loader calls', async () => {
    const slowLoader: DynamicOptionLoader = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 15_000)),
    )
    registry.registerDynamicOptionLoader('linear', slowLoader)

    loadProviderPlugins(registry, [makePlugin()])

    const result = await registry.loadDynamicOptions('linear', 'create-issue', 'teamId')
    expect(result).toEqual([])
  }, 15_000)

  it('registers loaders via loadProviderPlugins', async () => {
    const mockOptions: DynamicOptionResult = [
      { value: 'team-1', label: 'Engineering' },
    ]

    const loaders = new Map<string, DynamicOptionLoader>()
    loaders.set('linear', vi.fn<DynamicOptionLoader>().mockResolvedValue(mockOptions))

    loadProviderPlugins(registry, [makePlugin()], loaders)

    const result = await registry.loadDynamicOptions('linear', 'create-issue', 'teamId')
    expect(result).toEqual(mockOptions)
  })
})

// ---------------------------------------------------------------------------
// Integration Test — Full Flow
// ---------------------------------------------------------------------------

describe('NodeTypeRegistry integration', () => {
  it('full flow: load plugins → query categories → query node types → get schema → load options', async () => {
    const registry = NodeTypeRegistry.create()

    const mockOptions: DynamicOptionResult = [
      { value: 'team-eng', label: 'Engineering' },
      { value: 'team-des', label: 'Design' },
    ]

    // 1. Create mock plugins with canonical ProviderPlugin shape
    const linearPlugin = makePlugin({
      id: 'linear',
      displayName: 'Linear',
      description: 'Linear issue tracker',
      actions: [
        makeAction({
          id: 'create-issue',
          displayName: 'Create Issue',
          category: 'pm',
          inputSchema: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              teamId: { type: 'string' },
            },
          },
          dynamicOptions: [{ fieldPath: 'teamId' }],
        }),
      ],
    })

    const slackPlugin = makePlugin({
      id: 'slack',
      displayName: 'Slack',
      description: 'Slack messaging',
      actions: [
        makeAction({ id: 'send-message', displayName: 'Send Message', category: 'comms' }),
      ],
    })

    // 2. Create dynamic option loaders
    const loaders = new Map<string, DynamicOptionLoader>()
    loaders.set('linear', vi.fn<DynamicOptionLoader>().mockResolvedValue(mockOptions))

    // 3. Load plugins
    loadProviderPlugins(registry, [linearPlugin, slackPlugin], loaders)

    // 4. Query categories (auto-generated from plugin id/displayName)
    const categories = registry.getCategories()
    expect(categories).toHaveLength(2)
    expect(categories.map((c) => c.id).sort()).toEqual(['linear', 'slack'])

    // 5. Query node types by action category
    const allTypes = registry.getNodeTypes()
    expect(allTypes).toHaveLength(2)

    const pmTypes = registry.getNodeTypes('pm')
    expect(pmTypes).toHaveLength(1)
    expect(pmTypes[0].providerId).toBe('linear')

    // 6. Get input schema
    const schema = registry.getInputSchema('linear', 'create-issue')
    expect(schema).toBeDefined()
    expect((schema as Record<string, unknown>).type).toBe('object')

    // 7. Load dynamic options
    const options = await registry.loadDynamicOptions('linear', 'create-issue', 'teamId')
    expect(options).toHaveLength(2)
    expect(options[0]).toEqual({ value: 'team-eng', label: 'Engineering' })
  })
})
