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
