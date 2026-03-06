import { describe, it, expect, vi } from 'vitest'
import { ToolRegistry } from '../registry.js'
import type { ToolPlugin, ToolPluginContext } from '../types.js'

// Mock the SDK's createSdkMcpServer since it requires internal MCP runtime
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: ({ name, tools }: { name: string; tools: unknown[] }) => ({
    type: 'sdk',
    name,
    instance: { tools },
  }),
}))

const mockContext: ToolPluginContext = {
  env: { LINEAR_API_KEY: 'test-key', LINEAR_TEAM_NAME: 'TestTeam' },
  cwd: '/tmp/test',
}

function createMockPlugin(name: string, toolCount: number): ToolPlugin {
  return {
    name,
    description: `Mock ${name} plugin`,
    createTools: () =>
      Array.from({ length: toolCount }, (_, i) => ({
        name: `${name}_tool_${i}`,
        description: `Tool ${i}`,
        inputSchema: {},
        handler: async () => ({ content: [] }),
      })),
  }
}

describe('ToolRegistry', () => {
  it('registers plugins and creates servers', () => {
    const registry = new ToolRegistry()
    registry.register(createMockPlugin('alpha', 2))
    registry.register(createMockPlugin('beta', 3))

    const servers = registry.createServers(mockContext)

    expect(Object.keys(servers)).toEqual(['alpha', 'beta'])
    expect(servers['alpha'].type).toBe('sdk')
    expect(servers['alpha'].name).toBe('alpha')
  })

  it('skips plugins that return no tools', () => {
    const registry = new ToolRegistry()
    registry.register(createMockPlugin('empty', 0))
    registry.register(createMockPlugin('has-tools', 1))

    const servers = registry.createServers(mockContext)

    expect(Object.keys(servers)).toEqual(['has-tools'])
  })

  it('returns empty when no plugins registered', () => {
    const registry = new ToolRegistry()
    const servers = registry.createServers(mockContext)

    expect(Object.keys(servers)).toEqual([])
  })

  it('passes context to plugin createTools', () => {
    const createToolsSpy = vi.fn().mockReturnValue([{
      name: 'test_tool',
      description: 'Test',
      inputSchema: {},
      handler: async () => ({ content: [] }),
    }])

    const plugin: ToolPlugin = {
      name: 'spy-plugin',
      description: 'Test plugin',
      createTools: createToolsSpy,
    }

    const registry = new ToolRegistry()
    registry.register(plugin)
    registry.createServers(mockContext)

    expect(createToolsSpy).toHaveBeenCalledWith(mockContext)
  })
})
