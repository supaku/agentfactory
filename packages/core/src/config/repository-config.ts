/**
 * Repository Configuration
 *
 * Loads and validates the declarative .agentfactory/config.yaml file.
 * This config controls repository-level settings such as:
 * - Git remote validation (repository field)
 * - Project allowlisting for the orchestrator (allowedProjects field)
 */

import { z } from 'zod'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import YAML from 'yaml'

// ---------------------------------------------------------------------------
// Zod Schema
// ---------------------------------------------------------------------------

export const RepositoryConfigSchema = z.object({
  apiVersion: z.string(),
  kind: z.literal('RepositoryConfig'),
  repository: z.string().optional(),
  allowedProjects: z.array(z.string()).optional(),
  /** Maps Linear project names to their root directory within the repo (e.g., { Family: 'apps/family' }) */
  projectPaths: z.record(z.string(), z.string()).optional(),
  /** Shared directories that any project's agent may modify (e.g., ['packages/ui']) */
  sharedPaths: z.array(z.string()).optional(),
  /**
   * Command to invoke the Linear CLI (default: "pnpm af-linear").
   * For non-Node projects, set to a path or wrapper script, e.g.:
   *   "npx -y @supaku/agentfactory-cli af-linear"
   *   "./tools/af-linear.sh"
   *   "/usr/local/bin/af-linear"
   */
  linearCli: z.string().optional(),
  /**
   * Package manager used by the project (default: "pnpm").
   * Set to "none" for non-Node projects (disables dependency linking and helper scripts).
   * Supported values: "pnpm" | "npm" | "yarn" | "bun" | "none"
   */
  packageManager: z.enum(['pnpm', 'npm', 'yarn', 'bun', 'none']).optional(),
  /**
   * Build command override (e.g. 'cargo build', 'cmake --build build', 'make').
   * Injected into workflow templates as {{buildCommand}}.
   */
  buildCommand: z.string().optional(),
  /**
   * Test command override (e.g. 'cargo test', 'ctest --test-dir build', 'make test').
   * Injected into workflow templates as {{testCommand}}.
   */
  testCommand: z.string().optional(),
  /**
   * Validation command override — replaces typecheck for compiled projects
   * (e.g. 'cargo clippy', 'go vet ./...').
   * Injected into workflow templates as {{validateCommand}}.
   */
  validateCommand: z.string().optional(),
}).refine(
  (data) => !(data.allowedProjects && data.projectPaths),
  { message: 'allowedProjects and projectPaths are mutually exclusive — use one or the other' },
)

// ---------------------------------------------------------------------------
// TypeScript Type
// ---------------------------------------------------------------------------

export type RepositoryConfig = z.infer<typeof RepositoryConfigSchema>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the effective list of allowed project names.
 * When `projectPaths` is set, the keys are the allowed projects.
 * Otherwise falls back to `allowedProjects`.
 */
export function getEffectiveAllowedProjects(config: RepositoryConfig): string[] | undefined {
  if (config.projectPaths) {
    return Object.keys(config.projectPaths)
  }
  return config.allowedProjects
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load and validate .agentfactory/config.yaml from the given git root.
 *
 * @param gitRoot - The root directory of the git repository
 * @returns The validated RepositoryConfig, or null if the file does not exist
 * @throws {z.ZodError} If the file exists but fails schema validation
 */
export function loadRepositoryConfig(gitRoot: string): RepositoryConfig | null {
  const configPath = resolve(gitRoot, '.agentfactory', 'config.yaml')
  if (!existsSync(configPath)) {
    return null
  }
  const content = readFileSync(configPath, 'utf-8')
  const parsed = YAML.parse(content)
  return RepositoryConfigSchema.parse(parsed)
}
