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
import type { ProvidersConfig } from '../providers/index.js'
import type { RoutingConfig } from '../routing/types.js'

// ---------------------------------------------------------------------------
// Zod Schema
// ---------------------------------------------------------------------------

/** Per-project configuration (object form of projectPaths values) */
export const ProjectConfigSchema = z.object({
  /** Root directory for this project within the repo */
  path: z.string(),
  /** Package manager override for this project */
  packageManager: z.enum(['pnpm', 'npm', 'yarn', 'bun', 'none']).optional(),
  /** Build command override for this project */
  buildCommand: z.string().optional(),
  /** Test command override for this project */
  testCommand: z.string().optional(),
  /** Validation command override for this project */
  validateCommand: z.string().optional(),
})

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>

/**
 * projectPaths values can be a string (path shorthand) or a full ProjectConfig object.
 * String values are normalized to { path: value } by getProjectConfig().
 */
const ProjectPathValueSchema = z.union([z.string(), ProjectConfigSchema])

/** Valid agent provider names */
const AgentProviderNameSchema = z.enum(['claude', 'codex', 'amp', 'spring-ai', 'a2a'])

/** Provider selection configuration */
export const ProvidersConfigSchema = z.object({
  /** Default provider for all agents */
  default: AgentProviderNameSchema.optional(),
  /** Provider overrides by work type (e.g., { qa: 'codex' }) */
  byWorkType: z.record(z.string(), AgentProviderNameSchema).optional(),
  /** Provider overrides by project name (e.g., { Social: 'codex' }) */
  byProject: z.record(z.string(), AgentProviderNameSchema).optional(),
})

/** Routing configuration for MAB-based provider selection */
export const RoutingConfigSectionSchema = z.object({
  /** Enable MAB-based intelligent routing (default: false) */
  enabled: z.boolean().default(false),
  /** Exploration rate for Thompson Sampling (0-1, default: 0.1) */
  explorationRate: z.number().min(0).max(1).default(0.1),
  /** Observation window size (default: 100) */
  windowSize: z.number().int().positive().default(100),
  /** Discount factor for older observations (default: 0.99) */
  discountFactor: z.number().min(0).max(1).default(0.99),
  /** Minimum observations before exploiting (default: 5) */
  minObservationsForExploit: z.number().int().min(0).default(5),
  /** Change detection threshold (default: 0.2) */
  changeDetectionThreshold: z.number().min(0).default(0.2),
})

export const RepositoryConfigSchema = z.object({
  apiVersion: z.string(),
  kind: z.literal('RepositoryConfig'),
  repository: z.string().optional(),
  allowedProjects: z.array(z.string()).optional(),
  /**
   * Maps Linear project names to their root directory or full config.
   * String shorthand: { Family: 'apps/family' }
   * Object form: { 'Family iOS': { path: 'apps/family-ios', packageManager: 'none', buildCommand: 'make build' } }
   */
  projectPaths: z.record(z.string(), ProjectPathValueSchema).optional(),
  /** Shared directories that any project's agent may modify (e.g., ['packages/ui']) */
  sharedPaths: z.array(z.string()).optional(),
  /**
   * Command to invoke the Linear CLI (default: "pnpm af-linear").
   * For non-Node projects, set to a path or wrapper script, e.g.:
   *   "npx -y @renseiai/agentfactory-cli af-linear"
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
  /**
   * Provider selection configuration.
   * Allows routing agents to different providers by work type or project.
   */
  providers: ProvidersConfigSchema.optional(),
  /**
   * Routing configuration for MAB-based intelligent provider selection.
   * When enabled, Thompson Sampling is used to learn optimal provider routing.
   */
  routing: RoutingConfigSectionSchema.optional(),
  /**
   * Merge queue configuration.
   * Controls which merge queue provider agents use for automated merging.
   */
  mergeQueue: z.object({
    /** Merge queue provider to use */
    provider: z.enum(['github-native', 'local', 'mergify', 'trunk']).default('local'),
    /** Whether merge queue integration is enabled */
    enabled: z.boolean().default(false),
    /** Automatically add approved PRs to merge queue */
    autoMerge: z.boolean().default(true),
    /** Required CI checks that must pass before merge (provider-specific) */
    requiredChecks: z.array(z.string()).optional(),
    /** Merge strategy: rebase, merge, or squash */
    strategy: z.enum(['rebase', 'merge', 'squash']).default('rebase'),
    /** Command to run after rebase (e.g., test suite) */
    testCommand: z.string().default('pnpm test'),
    /** Timeout for test command in milliseconds */
    testTimeout: z.number().default(300_000),
    /** Regenerate lock files after rebase */
    lockFileRegenerate: z.boolean().default(true),
    /** Use mergiraf for syntax-aware conflict resolution */
    mergiraf: z.boolean().default(true),
    /** Queue polling interval in milliseconds */
    pollInterval: z.number().default(10_000),
    /** Maximum retries for failed merges */
    maxRetries: z.number().default(2),
    /** Escalation policy for conflicts and test failures */
    escalation: z.object({
      onConflict: z.enum(['reassign', 'notify', 'park']).default('reassign'),
      onTestFailure: z.enum(['notify', 'park', 'retry']).default('notify'),
    }).optional(),
    /** Delete PR branch after successful merge */
    deleteBranchOnMerge: z.boolean().default(true),
  }).optional(),
  /**
   * Worktree configuration.
   * Controls where git worktrees are created and how paths are resolved.
   */
  worktree: z.object({
    /**
     * Base directory template for git worktrees.
     * Supports template variables: {repoName} (repo directory basename), {branch} (worktree branch name).
     * Default: '../{repoName}.wt' (sibling directory, outside repo to avoid VSCode file watcher crashes).
     * Legacy: '.worktrees' (inside repo, causes VSCode crashes with many worktrees).
     */
    directory: z.string().default('../{repoName}.wt'),
  }).optional(),
  /**
   * Git merge driver to use in agent worktrees.
   * 'mergiraf' enables syntax-aware merging for supported file types.
   * Defaults to 'default' (standard git line-based merge).
   */
  mergeDriver: z.enum(['mergiraf', 'default']).optional(),
  /**
   * Quality gate configuration.
   * Controls baseline-diff quality checks and ratchet enforcement.
   */
  quality: z.object({
    /** Enable quality baseline capture at worktree creation and post-session delta check */
    baselineEnabled: z.boolean().default(false),
    /** Enable quality ratchet enforcement in merge queue and CI */
    ratchetEnabled: z.boolean().default(false),
    /** Include boy scout rule instructions in agent prompts */
    boyscoutRule: z.boolean().default(true),
    /** Include TDD workflow instructions in agent prompts */
    tddWorkflow: z.boolean().default(true),
  }).optional(),
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

/**
 * Returns the normalized ProjectConfig for a given project name.
 * Handles both string shorthand and object form of projectPaths values.
 * Per-project overrides take precedence over repo-wide defaults.
 */
export function getProjectConfig(config: RepositoryConfig, projectName: string): ProjectConfig | null {
  if (!config.projectPaths) return null
  const value = config.projectPaths[projectName]
  if (value === undefined) return null

  // Normalize string shorthand to object form
  const projectConfig = typeof value === 'string' ? { path: value } : value

  return {
    path: projectConfig.path,
    packageManager: projectConfig.packageManager ?? config.packageManager,
    buildCommand: projectConfig.buildCommand ?? config.buildCommand,
    testCommand: projectConfig.testCommand ?? config.testCommand,
    validateCommand: projectConfig.validateCommand ?? config.validateCommand,
  }
}

/**
 * Returns just the path string for a given project name.
 * Handles both string shorthand and object form.
 */
export function getProjectPath(config: RepositoryConfig, projectName: string): string | undefined {
  if (!config.projectPaths) return undefined
  const value = config.projectPaths[projectName]
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : value.path
}

/**
 * Returns the providers config from a RepositoryConfig, if present.
 * Convenience helper for passing to ProviderResolutionContext.configProviders.
 */
export function getProvidersConfig(config: RepositoryConfig): ProvidersConfig | undefined {
  return config.providers as ProvidersConfig | undefined
}

/**
 * Returns the routing config from a RepositoryConfig, if present.
 * Convenience helper for passing to async provider resolution.
 */
export function getRoutingConfig(config: RepositoryConfig): RoutingConfig | undefined {
  return config.routing as RoutingConfig | undefined
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
