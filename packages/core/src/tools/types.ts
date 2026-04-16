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
  /** Optional delegate for file reservation operations across parallel sessions */
  fileReservation?: {
    reserveFiles(
      sessionId: string,
      filePaths: string[],
      reason?: string,
    ): Promise<{
      reserved: string[]
      conflicts: Array<{
        filePath: string
        heldBy: { sessionId: string; reservedAt: number }
      }>
    }>
    checkFileConflicts(
      sessionId: string,
      filePaths: string[],
    ): Promise<
      Array<{
        filePath: string
        heldBy: { sessionId: string; reservedAt: number }
      }>
    >
    releaseFiles(sessionId: string, filePaths: string[]): Promise<number>
  }
}
