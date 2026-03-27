/**
 * Tool category classification based on tool name pattern matching.
 *
 * Classifies tools into functional categories for dashboard and analytics use.
 */

export type ToolCategory = 'security' | 'testing' | 'build' | 'deploy' | 'research' | 'general'

const CATEGORY_PATTERNS: Array<{ category: ToolCategory; patterns: RegExp }> = [
  {
    category: 'security',
    patterns: /security|vuln|scan|sast|dast|sbom|cve|audit(?!.*\bno-audit\b)/i,
  },
  {
    category: 'testing',
    patterns: /test|jest|vitest|playwright|cypress|coverage|assert/i,
  },
  {
    category: 'deploy',
    patterns: /deploy|release|publish|docker|k8s|terraform|infra/i,
  },
  {
    category: 'build',
    patterns: /build|compile|bundle|webpack|vite|esbuild|tsc/i,
  },
  {
    category: 'research',
    patterns: /search|fetch|browse|read|grep|glob|explore/i,
  },
]

/**
 * Extract the tool-specific portion from an MCP-qualified tool name.
 *
 * MCP tool names follow the pattern `mcp__{pluginName}__{toolName}`.
 * Returns the portion after the last `__` separator, or the original
 * name if it's not MCP-qualified.
 */
function extractToolName(toolName: string): string {
  const lastSep = toolName.lastIndexOf('__')
  if (lastSep !== -1 && lastSep < toolName.length - 2) {
    return toolName.substring(lastSep + 2)
  }
  return toolName
}

/**
 * Classify a tool into a functional category based on its name.
 *
 * Handles both simple tool names (e.g. `Read`, `Bash`) and
 * MCP-qualified names (e.g. `mcp__af-linear__af_linear_create_issue`).
 *
 * Returns `'general'` for tools that don't match any specific category.
 */
export function classifyTool(toolName: string): ToolCategory {
  const name = extractToolName(toolName)

  for (const { category, patterns } of CATEGORY_PATTERNS) {
    if (patterns.test(name)) {
      return category
    }
  }

  return 'general'
}
