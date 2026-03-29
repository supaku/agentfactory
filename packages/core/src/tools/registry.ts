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

  /** Create in-process MCP servers for Claude provider */
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
   * Create stdio MCP server configurations for Codex provider (SUP-1743).
   * Returns server configs that can be passed to Codex app-server via config/batchWrite.
   */
  createStdioServerConfigs(context: ToolPluginContext): CreateStdioServersResult {
    return createStdioServerConfigs(this.plugins, context)
  }
}
