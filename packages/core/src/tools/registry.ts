import { createSdkMcpServer, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import type { ToolPlugin, ToolPluginContext } from './types.js'

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

  /** Create MCP servers for all registered plugins */
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
}
