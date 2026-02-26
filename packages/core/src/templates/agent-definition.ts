/**
 * Agent Definition Parser
 *
 * Parses agent definition markdown files with YAML frontmatter.
 * Supports configurable build/test/CLI commands in frontmatter that
 * can be referenced in the body via Handlebars interpolation.
 *
 * Example frontmatter:
 *   ---
 *   name: developer
 *   description: General-purpose development agent
 *   tools: Read, Edit, Write, Grep, Glob, Bash
 *   model: opus
 *   build_commands:
 *     verify: "cmake --build build-arm64/ --target engine-headless"
 *     full: "cmake --build build-arm64/ --target engine-legacy"
 *   test_commands:
 *     unit: "cargo test"
 *     integration: "cargo test -- --ignored"
 *   af_linear: "bash tools/af-linear.sh"
 *   ---
 */

import fs from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import Handlebars from 'handlebars'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Parsed frontmatter from an agent definition markdown file.
 */
export interface AgentDefinitionFrontmatter {
  /** Agent name (e.g., "developer", "qa-reviewer") */
  name: string
  /** When the orchestrator should select this agent */
  description?: string
  /** Comma-separated list of allowed tools */
  tools?: string
  /** Model to use (opus, sonnet, haiku) */
  model?: string
  /** Named build commands (e.g., { verify: "cmake --build ...", full: "make all" }) */
  build_commands?: Record<string, string>
  /** Named test commands (e.g., { unit: "cargo test", integration: "cargo test -- --ignored" }) */
  test_commands?: Record<string, string>
  /** Custom Linear CLI command override (e.g., "bash tools/af-linear.sh") */
  af_linear?: string
}

/**
 * Fully parsed agent definition with frontmatter and body.
 */
export interface AgentDefinition {
  /** Parsed and validated frontmatter fields */
  frontmatter: AgentDefinitionFrontmatter
  /** Raw markdown body (after frontmatter) */
  rawBody: string
  /** Body rendered with frontmatter variables interpolated */
  renderedBody: string
}

// ---------------------------------------------------------------------------
// Zod Schema
// ---------------------------------------------------------------------------

export const AgentDefinitionFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  tools: z.string().optional(),
  model: z.enum(['opus', 'sonnet', 'haiku']).optional(),
  build_commands: z.record(z.string(), z.string()).optional(),
  test_commands: z.record(z.string(), z.string()).optional(),
  af_linear: z.string().optional(),
})

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

/**
 * Parse a markdown string with YAML frontmatter into an AgentDefinition.
 *
 * The body supports Handlebars interpolation for frontmatter fields:
 *   - {{build_commands.verify}} → the "verify" build command
 *   - {{test_commands.unit}} → the "unit" test command
 *   - {{af_linear}} → the Linear CLI override
 *   - {{name}}, {{description}}, {{model}} → basic fields
 *
 * @throws {Error} If frontmatter is malformed or fails validation
 */
export function parseAgentDefinition(content: string): AgentDefinition {
  const match = content.match(FRONTMATTER_RE)
  if (!match) {
    throw new Error('Agent definition must start with YAML frontmatter delimited by ---')
  }

  const [, yamlBlock, body] = match
  const parsed = parseYaml(yamlBlock)
  const frontmatter = AgentDefinitionFrontmatterSchema.parse(parsed)

  const rawBody = body.trimStart()
  const renderedBody = renderBody(rawBody, frontmatter)

  return { frontmatter, rawBody, renderedBody }
}

/**
 * Parse an agent definition from a file path.
 *
 * @throws {Error} If file cannot be read or parsed
 */
export function parseAgentDefinitionFile(filePath: string): AgentDefinition {
  const content = fs.readFileSync(filePath, 'utf-8')
  try {
    return parseAgentDefinition(content)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to parse agent definition ${filePath}: ${message}`)
  }
}

// ---------------------------------------------------------------------------
// Body Rendering
// ---------------------------------------------------------------------------

/**
 * Render the markdown body with frontmatter values as Handlebars context.
 * Uses noEscape to preserve markdown formatting.
 */
function renderBody(body: string, frontmatter: AgentDefinitionFrontmatter): string {
  try {
    const template = Handlebars.compile(body, { noEscape: true })
    return template(frontmatter)
  } catch {
    // If body has no Handlebars expressions or they fail, return raw body
    return body
  }
}
