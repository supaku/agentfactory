import { describe, it, expect, vi } from 'vitest'
import { createStdioServerConfigs } from '../stdio-server.js'
import type { ToolPlugin, ToolPluginContext } from '../types.js'

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
        inputSchema: { type: 'object', properties: { arg: { type: 'string' } } },
        handler: async () => ({ content: [] }),
      })),
  }
}

describe('createStdioServerConfigs', () => {
  it('creates configs for plugins with tools', () => {
    const plugins = [
      createMockPlugin('alpha', 2),
      createMockPlugin('beta', 3),
    ]

    const result = createStdioServerConfigs(plugins, mockContext)

    expect(result.servers).toHaveLength(2)
    expect(result.servers[0].name).toBe('alpha')
    expect(result.servers[0].command).toBe('node')
    expect(result.servers[0].args).toContain('--plugin')
    expect(result.servers[0].args).toContain('alpha')
    expect(result.servers[0].toolNames).toEqual(['alpha_tool_0', 'alpha_tool_1'])

    expect(result.servers[1].name).toBe('beta')
    expect(result.servers[1].toolNames).toEqual(['beta_tool_0', 'beta_tool_1', 'beta_tool_2'])

    expect(result.toolNames).toEqual([
      'alpha_tool_0', 'alpha_tool_1',
      'beta_tool_0', 'beta_tool_1', 'beta_tool_2',
    ])
  })

  it('skips plugins that return no tools', () => {
    const plugins = [
      createMockPlugin('empty', 0),
      createMockPlugin('has-tools', 1),
    ]

    const result = createStdioServerConfigs(plugins, mockContext)

    expect(result.servers).toHaveLength(1)
    expect(result.servers[0].name).toBe('has-tools')
    expect(result.toolNames).toEqual(['has-tools_tool_0'])
  })

  it('returns empty when no plugins have tools', () => {
    const result = createStdioServerConfigs([], mockContext)

    expect(result.servers).toHaveLength(0)
    expect(result.toolNames).toEqual([])
  })

  it('passes environment variables through to server config', () => {
    const plugins = [createMockPlugin('test', 1)]
    const result = createStdioServerConfigs(plugins, mockContext)

    expect(result.servers[0].env).toEqual(mockContext.env)
  })
})

describe('ToolRegistry.createStdioServerConfigs', () => {
  it('delegates to createStdioServerConfigs with registered plugins', async () => {
    // Use dynamic import to avoid mock conflicts with the other registry test
    const { ToolRegistry } = await import('../registry.js')
    const registry = new ToolRegistry()
    registry.register(createMockPlugin('plugin-a', 2))

    const result = registry.createStdioServerConfigs(mockContext)

    expect(result.servers).toHaveLength(1)
    expect(result.servers[0].name).toBe('plugin-a')
    expect(result.toolNames).toEqual(['plugin-a_tool_0', 'plugin-a_tool_1'])
  })
})
