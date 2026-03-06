import { createSdkMcpServer, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import type { ToolPlugin, ToolPluginContext } from './types.js'

export class ToolRegistry {
  private plugins: ToolPlugin[] = []

  register(plugin: ToolPlugin): void {
    this.plugins.push(plugin)
  }

  /** Create MCP servers for all registered plugins */
  createServers(context: ToolPluginContext): Record<string, McpSdkServerConfigWithInstance> {
    const servers: Record<string, McpSdkServerConfigWithInstance> = {}
    for (const plugin of this.plugins) {
      const tools = plugin.createTools(context)
      if (tools.length > 0) {
        servers[plugin.name] = createSdkMcpServer({ name: plugin.name, tools })
      }
    }
    return servers
  }
}
