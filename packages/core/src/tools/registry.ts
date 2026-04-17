import { createSdkMcpServer, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import type { ToolPlugin, ToolPluginContext } from './types.js'
import { createStdioServerConfigs, type CreateStdioServersResult } from './stdio-server.js'

export interface CreateServersResult {
  servers: Record<string, McpSdkServerConfigWithInstance>
  /** Fully-qualified tool names: mcp__{serverName}__{toolName} */
  toolNames: string[]
}

export class ToolRegistry {
  private plugins: ToolPlugin[] = []

  register(plugin: ToolPlugin): void {
    this.plugins.push(plugin)
  }

  /** Get all registered plugins */
  getPlugins(): ToolPlugin[] {
    return [...this.plugins]
  }

  /**
   * Create in-process MCP servers for Claude provider.
   *
   * @deprecated Use {@link createStdioServerConfigs} instead. In-process servers
   * don't propagate to sub-agents spawned via the Agent tool. Stdio servers
   * are used for all providers since v0.8.30.
   */
  createServers(context: ToolPluginContext): CreateServersResult {
    const servers: Record<string, McpSdkServerConfigWithInstance> = {}
    const toolNames: string[] = []
    for (const plugin of this.plugins) {
      const tools = plugin.createTools(context)
      if (tools.length > 0) {
        servers[plugin.name] = createSdkMcpServer({ name: plugin.name, tools })
        for (const tool of tools) {
          toolNames.push(`mcp__${plugin.name}__${tool.name}`)
        }
      }
    }
    return { servers, toolNames }
  }

  /**
   * Create stdio MCP server configurations for all providers.
   * Returns server configs that propagate to sub-agents via stdio transport.
   */
  createStdioServerConfigs(context: ToolPluginContext): CreateStdioServersResult {
    return createStdioServerConfigs(this.plugins, context)
  }
}
