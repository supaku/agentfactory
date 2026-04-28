/**
 * Config loader for ~/.rensei/daemon.yaml
 *
 * Architecture reference:
 *   rensei-architecture/004-sandbox-capability-matrix.md §Configuration shape
 *   rensei-architecture/011-local-daemon-fleet.md §Config file walkthrough
 *
 * Reads, validates (via Zod), and returns a DaemonConfig.
 * Environment-variable substitution is applied on the `authToken` field
 * (${RENSEI_DAEMON_TOKEN} pattern from the YAML schema).
 *
 * On first run (no config file), returns undefined so the setup wizard can
 * create one interactively.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve as resolvePath, dirname } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { z } from 'zod'
import type { DaemonConfig } from './types.js'

// ---------------------------------------------------------------------------
// Default path
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG_PATH = resolvePath(homedir(), '.rensei', 'daemon.yaml')

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const CapacitySchema = z.object({
  maxConcurrentSessions: z.number().int().positive().default(8),
  maxVCpuPerSession: z.number().int().positive().default(4),
  maxMemoryMbPerSession: z.number().int().positive().default(8192),
  reservedForSystem: z.object({
    vCpu: z.number().int().nonnegative().default(4),
    memoryMb: z.number().int().nonnegative().default(16384),
  }).default({ vCpu: 4, memoryMb: 16384 }),
}).default({
  maxConcurrentSessions: 8,
  maxVCpuPerSession: 4,
  maxMemoryMbPerSession: 8192,
  reservedForSystem: { vCpu: 4, memoryMb: 16384 },
})

const ProjectGitSchema = z.object({
  credentialHelper: z.string().optional(),
  sshKey: z.string().optional(),
}).optional()

const ProjectSchema = z.object({
  id: z.string().min(1),
  repository: z.string().min(1),
  cloneStrategy: z.enum(['shallow', 'full', 'reference-clone']).default('shallow'),
  git: ProjectGitSchema,
})

const OrchestratorSchema = z.object({
  url: z.string().url(),
  authToken: z.string().optional(),
})

const AutoUpdateSchema = z.object({
  channel: z.enum(['stable', 'beta', 'main']).default('stable'),
  schedule: z.enum(['nightly', 'on-release', 'manual']).default('nightly'),
  drainTimeoutSeconds: z.number().int().positive().default(600),
}).default({
  channel: 'stable',
  schedule: 'nightly',
  drainTimeoutSeconds: 600,
})

const ObservabilitySchema = z.object({
  logFormat: z.enum(['ndjson', 'pretty']).default('ndjson'),
  logPath: z.string().optional(),
  metricsPort: z.number().int().nonnegative().default(9101),
}).optional()

const DaemonConfigSchema = z.object({
  apiVersion: z.string().default('rensei.dev/v1'),
  kind: z.literal('LocalDaemon').default('LocalDaemon'),
  machine: z.object({
    id: z.string().min(1),
    region: z.string().optional(),
  }),
  capacity: CapacitySchema,
  projects: z.array(ProjectSchema).default([]),
  orchestrator: OrchestratorSchema,
  autoUpdate: AutoUpdateSchema,
  observability: ObservabilitySchema,
})

// ---------------------------------------------------------------------------
// Environment-variable substitution
// ---------------------------------------------------------------------------

/**
 * Substitute ${ENV_VAR} patterns in a string using process.env.
 * Unmatched patterns are left as-is.
 */
function substituteEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, varName: string) => {
    return process.env[varName] ?? match
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and validate a DaemonConfig from the given YAML file path.
 *
 * @param configPath - Path to daemon.yaml. Defaults to ~/.rensei/daemon.yaml.
 * @returns Parsed DaemonConfig, or undefined if the file does not exist.
 * @throws {Error} If the file exists but is invalid YAML or fails schema validation.
 */
export function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): DaemonConfig | undefined {
  if (!existsSync(configPath)) {
    return undefined
  }

  let raw: string
  try {
    raw = readFileSync(configPath, 'utf-8')
  } catch (err) {
    throw new Error(`Failed to read daemon config at ${configPath}: ${(err as Error).message}`)
  }

  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch (err) {
    throw new Error(`Failed to parse daemon config YAML at ${configPath}: ${(err as Error).message}`)
  }

  const result = DaemonConfigSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid daemon config at ${configPath}: ${issues}`)
  }

  const config = result.data as DaemonConfig

  // Apply environment variable substitution to sensitive fields
  if (config.orchestrator.authToken) {
    config.orchestrator.authToken = substituteEnvVars(config.orchestrator.authToken)
  }

  // Override authToken from environment if set
  const envToken = process.env['RENSEI_DAEMON_TOKEN']
  if (envToken) {
    config.orchestrator.authToken = envToken
  }

  return config
}

/**
 * Write a DaemonConfig to a YAML file. Creates parent directories if needed.
 *
 * @param config - The configuration to write.
 * @param configPath - Destination path. Defaults to ~/.rensei/daemon.yaml.
 */
export function writeConfig(config: DaemonConfig, configPath: string = DEFAULT_CONFIG_PATH): void {
  const dir = dirname(configPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const yaml = stringifyYaml(config, { indent: 2 })
  writeFileSync(configPath, yaml, 'utf-8')
}

/**
 * Returns the default config path: ~/.rensei/daemon.yaml.
 */
export function getDefaultConfigPath(): string {
  return DEFAULT_CONFIG_PATH
}

/**
 * Derive a default machine ID from the hostname + platform.
 * Used by the setup wizard when no machine ID is configured.
 */
export function deriveDefaultMachineId(): string {
  const { hostname } = ((): { hostname: string } => {
    try {
      // Node 22+ has os.hostname()
      const os = { hostname: '' }
      os.hostname = require('os').hostname() as string
      return os
    } catch {
      return { hostname: 'local-machine' }
    }
  })()
  return hostname.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-')
}
