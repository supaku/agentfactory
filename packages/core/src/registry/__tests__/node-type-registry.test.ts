import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NodeTypeRegistry } from '../node-type-registry.js'
import { loadProviderPlugins } from '../loader.js'
import type {
  NodeTypeMetadata,
  ProviderCategory,
  ProviderPlugin,
  ActionDefinition,
  DynamicOptionResult,
} from '../types.js'

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
    ...overrides,
  }
}

function makePlugin(overrides?: Partial<ProviderPlugin>): ProviderPlugin {
  return {
    id: 'linear',
    displayName: 'Linear',
    description: 'Linear issue tracker',
    category: makeCategory(),
    actions: [makeAction()],
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
    expect(categories[0].id).toBe('project-management')

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
      category: makeCategory({ id: 'communication', displayName: 'Communication' }),
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

  it('handles malformed plugin — missing category', () => {
    const badPlugin = { ...makePlugin(), category: undefined } as unknown as ProviderPlugin
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

  it('deduplicates categories from multiple plugins with same category', () => {
    const plugin1 = makePlugin({ id: 'linear' })
    const plugin2 = makePlugin({
      id: 'jira',
      displayName: 'Jira',
      // Same category as linear
      category: makeCategory(),
      actions: [makeAction({ id: 'create-ticket' })],
    })

    loadProviderPlugins(registry, [plugin1, plugin2])

    expect(registry.getCategories()).toHaveLength(1)
    expect(registry.getNodeTypes()).toHaveLength(2)
  })

  it('maps dynamic option fields from action definitions', () => {
    const plugin = makePlugin({
      actions: [
        makeAction({
          id: 'create-issue',
          dynamicOptions: [
            { fieldPath: 'teamId', providerMethod: 'fetchTeams' },
            { fieldPath: 'projectId', providerMethod: 'fetchProjects', dependencies: ['teamId'] },
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
})

// ---------------------------------------------------------------------------
// Dynamic Option Tests
// ---------------------------------------------------------------------------

describe('NodeTypeRegistry dynamic options', () => {
  let registry: NodeTypeRegistry

  beforeEach(() => {
    registry = NodeTypeRegistry.create({ cacheTtlMs: 100 })
  })

  it('delegates to provider plugin for options', async () => {
    const mockOptions: DynamicOptionResult = [
      { value: 'team-1', label: 'Engineering' },
      { value: 'team-2', label: 'Design' },
    ]

    const plugin = makePlugin({
      actions: [
        makeAction({
          fetchDynamicOptions: vi.fn().mockResolvedValue(mockOptions),
        }),
      ],
    })

    loadProviderPlugins(registry, [plugin])

    const result = await registry.loadDynamicOptions('linear', 'create-issue', 'teamId')
    expect(result).toEqual(mockOptions)
  })

  it('returns empty array when no plugin registered', async () => {
    const result = await registry.loadDynamicOptions('unknown', 'action', 'field')
    expect(result).toEqual([])
  })

  it('returns empty array when action has no fetchDynamicOptions', async () => {
    loadProviderPlugins(registry, [makePlugin()])

    const result = await registry.loadDynamicOptions('linear', 'create-issue', 'teamId')
    expect(result).toEqual([])
  })

  it('returns empty array on provider error', async () => {
    const plugin = makePlugin({
      actions: [
        makeAction({
          fetchDynamicOptions: vi.fn().mockRejectedValue(new Error('API error')),
        }),
      ],
    })

    loadProviderPlugins(registry, [plugin])

    const result = await registry.loadDynamicOptions('linear', 'create-issue', 'teamId')
    expect(result).toEqual([])
  })

  it('caches results within TTL', async () => {
    const fetchFn = vi.fn().mockResolvedValue([{ value: 'v1', label: 'L1' }])
    const plugin = makePlugin({
      actions: [makeAction({ fetchDynamicOptions: fetchFn })],
    })

    loadProviderPlugins(registry, [plugin])

    // First call
    await registry.loadDynamicOptions('linear', 'create-issue', 'teamId')
    // Second call (should use cache)
    await registry.loadDynamicOptions('linear', 'create-issue', 'teamId')

    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('refetches after cache TTL expires', async () => {
    const fetchFn = vi.fn().mockResolvedValue([{ value: 'v1', label: 'L1' }])
    const plugin = makePlugin({
      actions: [makeAction({ fetchDynamicOptions: fetchFn })],
    })

    // Use very short TTL
    registry = NodeTypeRegistry.create({ cacheTtlMs: 1 })
    loadProviderPlugins(registry, [plugin])

    await registry.loadDynamicOptions('linear', 'create-issue', 'teamId')

    // Wait for cache to expire
    await new Promise((resolve) => setTimeout(resolve, 10))

    await registry.loadDynamicOptions('linear', 'create-issue', 'teamId')
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('passes context to provider', async () => {
    const fetchFn = vi.fn().mockResolvedValue([])
    const plugin = makePlugin({
      actions: [makeAction({ fetchDynamicOptions: fetchFn })],
    })

    loadProviderPlugins(registry, [plugin])

    const context = { teamId: 'team-1' }
    await registry.loadDynamicOptions('linear', 'create-issue', 'projectId', context)

    expect(fetchFn).toHaveBeenCalledWith('projectId', context)
  })

  it('uses separate cache entries for different contexts', async () => {
    const fetchFn = vi.fn().mockResolvedValue([])
    const plugin = makePlugin({
      actions: [makeAction({ fetchDynamicOptions: fetchFn })],
    })

    loadProviderPlugins(registry, [plugin])

    await registry.loadDynamicOptions('linear', 'create-issue', 'field', { a: '1' })
    await registry.loadDynamicOptions('linear', 'create-issue', 'field', { a: '2' })

    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('handles timeout for slow provider calls', async () => {
    const slowFn = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 15_000)),
    )
    const plugin = makePlugin({
      actions: [makeAction({ fetchDynamicOptions: slowFn })],
    })

    loadProviderPlugins(registry, [plugin])

    const result = await registry.loadDynamicOptions('linear', 'create-issue', 'teamId')
    expect(result).toEqual([])
  }, 15_000)
})

// ---------------------------------------------------------------------------
// Integration Test — Full Flow
// ---------------------------------------------------------------------------

describe('NodeTypeRegistry integration', () => {
  it('full flow: load plugins → query categories → query node types → get schema → load options', async () => {
    const registry = NodeTypeRegistry.create()

    // 1. Create mock plugins
    const linearPlugin = makePlugin({
      id: 'linear',
      displayName: 'Linear',
      description: 'Linear issue tracker',
      category: makeCategory({ id: 'pm', displayName: 'Project Management' }),
      actions: [
        makeAction({
          id: 'create-issue',
          displayName: 'Create Issue',
          inputSchema: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              teamId: { type: 'string', dynamicOptions: true },
            },
          },
          dynamicOptions: [{ fieldPath: 'teamId', providerMethod: 'fetchTeams' }],
          fetchDynamicOptions: vi.fn().mockResolvedValue([
            { value: 'team-eng', label: 'Engineering' },
            { value: 'team-des', label: 'Design' },
          ]),
        }),
      ],
    })

    const slackPlugin = makePlugin({
      id: 'slack',
      displayName: 'Slack',
      description: 'Slack messaging',
      category: makeCategory({ id: 'comms', displayName: 'Communication' }),
      actions: [
        makeAction({ id: 'send-message', displayName: 'Send Message' }),
      ],
    })

    // 2. Load plugins
    loadProviderPlugins(registry, [linearPlugin, slackPlugin])

    // 3. Query categories
    const categories = registry.getCategories()
    expect(categories).toHaveLength(2)
    expect(categories.map((c) => c.id).sort()).toEqual(['comms', 'pm'])

    // 4. Query node types
    const allTypes = registry.getNodeTypes()
    expect(allTypes).toHaveLength(2)

    const pmTypes = registry.getNodeTypes('pm')
    expect(pmTypes).toHaveLength(1)
    expect(pmTypes[0].providerId).toBe('linear')

    // 5. Get input schema
    const schema = registry.getInputSchema('linear', 'create-issue')
    expect(schema).toBeDefined()
    expect((schema as Record<string, unknown>).type).toBe('object')

    // 6. Load dynamic options
    const options = await registry.loadDynamicOptions('linear', 'create-issue', 'teamId')
    expect(options).toHaveLength(2)
    expect(options[0]).toEqual({ value: 'team-eng', label: 'Engineering' })
  })
})
