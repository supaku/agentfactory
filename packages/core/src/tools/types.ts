import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'

/** A plugin that contributes agent tools from CLI functionality */
export interface ToolPlugin {
  /** Unique plugin name (used as MCP server name, e.g. 'af-linear') */
  name: string
  /** Human-readable description */
  description: string
  /** Create the tool definitions. Called once per agent spawn. */
  createTools(context: ToolPluginContext): SdkMcpToolDefinition<any>[]
}

/** Context passed to plugins during tool creation */
export interface ToolPluginContext {
  /** Environment variables available to the agent */
  env: Record<string, string>
  /** Working directory */
  cwd: string
}
