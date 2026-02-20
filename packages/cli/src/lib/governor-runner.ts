/**
 * Governor Runner -- Programmatic API for the governor CLI.
 *
 * Exports `runGovernor()` so the governor can be invoked from code
 * (e.g. Next.js route handlers, tests, or custom scripts) without going
 * through process.argv / process.env / process.exit.
 */

import {
  WorkflowGovernor,
  type GovernorDependencies,
} from '@supaku/agentfactory'
import type {
  GovernorConfig,
  GovernorAction,
  GovernorIssue,
  ScanResult,
} from '@supaku/agentfactory'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GovernorRunnerConfig {
  /** Projects to scan */
  projects: string[]
  /** Scan interval in milliseconds (default: 60000) */
  scanIntervalMs?: number
  /** Maximum concurrent dispatches per scan (default: 3) */
  maxConcurrentDispatches?: number
  /** Enable auto-research from Icebox (default: true) */
  enableAutoResearch?: boolean
  /** Enable auto-backlog-creation from Icebox (default: true) */
  enableAutoBacklogCreation?: boolean
  /** Enable auto-development from Backlog (default: true) */
  enableAutoDevelopment?: boolean
  /** Enable auto-QA from Finished (default: true) */
  enableAutoQA?: boolean
  /** Enable auto-acceptance from Delivered (default: true) */
  enableAutoAcceptance?: boolean
  /** Run a single scan pass and exit (for testing / cron) */
  once?: boolean
  /** Dependency injection for the governor (required) */
  dependencies: GovernorDependencies
  /** Callbacks for governor lifecycle events */
  callbacks?: GovernorRunnerCallbacks
}

export interface GovernorRunnerCallbacks {
  onScanComplete?: (results: ScanResult[]) => void
  onError?: (error: Error) => void
}

export interface GovernorRunnerResult {
  governor: WorkflowGovernor
  /** Only populated in --once mode */
  scanResults?: ScanResult[]
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Start the Workflow Governor with the given configuration.
 *
 * In `once` mode, runs a single scan pass and returns the results.
 * Otherwise, starts the scan loop and returns the governor instance
 * (caller is responsible for calling `governor.stop()` on shutdown).
 */
export async function runGovernor(
  config: GovernorRunnerConfig,
): Promise<GovernorRunnerResult> {
  const governorConfig: Partial<GovernorConfig> = {
    projects: config.projects,
    scanIntervalMs: config.scanIntervalMs,
    maxConcurrentDispatches: config.maxConcurrentDispatches,
    enableAutoResearch: config.enableAutoResearch,
    enableAutoBacklogCreation: config.enableAutoBacklogCreation,
    enableAutoDevelopment: config.enableAutoDevelopment,
    enableAutoQA: config.enableAutoQA,
    enableAutoAcceptance: config.enableAutoAcceptance,
  }

  const governor = new WorkflowGovernor(governorConfig, config.dependencies)

  // -- Single scan mode (--once) --
  if (config.once) {
    const results = await governor.scanOnce()
    config.callbacks?.onScanComplete?.(results)
    return { governor, scanResults: results }
  }

  // -- Continuous scan loop --
  governor.start()
  return { governor }
}

// ---------------------------------------------------------------------------
// CLI argument parser
// ---------------------------------------------------------------------------

export interface GovernorCLIArgs {
  projects: string[]
  scanIntervalMs: number
  maxConcurrentDispatches: number
  enableAutoResearch: boolean
  enableAutoBacklogCreation: boolean
  enableAutoDevelopment: boolean
  enableAutoQA: boolean
  enableAutoAcceptance: boolean
  once: boolean
}

/**
 * Parse CLI arguments for the governor command.
 *
 * Usage:
 *   agentfactory governor --project <name> [--project <name>] [options]
 *
 * Options:
 *   --project <name>            Project to scan (can be repeated)
 *   --scan-interval <ms>        Scan interval in milliseconds (default: 60000)
 *   --max-dispatches <n>        Maximum concurrent dispatches per scan (default: 3)
 *   --no-auto-research          Disable auto-research from Icebox
 *   --no-auto-backlog-creation  Disable auto-backlog-creation from Icebox
 *   --no-auto-development       Disable auto-development from Backlog
 *   --no-auto-qa                Disable auto-QA from Finished
 *   --no-auto-acceptance        Disable auto-acceptance from Delivered
 *   --once                      Run a single scan pass and exit
 *   --help, -h                  Show help
 */
export function parseGovernorArgs(argv: string[] = process.argv.slice(2)): GovernorCLIArgs {
  const result: GovernorCLIArgs = {
    projects: [],
    scanIntervalMs: 60_000,
    maxConcurrentDispatches: 3,
    enableAutoResearch: true,
    enableAutoBacklogCreation: true,
    enableAutoDevelopment: true,
    enableAutoQA: true,
    enableAutoAcceptance: true,
    once: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--project':
        result.projects.push(argv[++i]!)
        break
      case '--scan-interval':
        result.scanIntervalMs = parseInt(argv[++i]!, 10)
        break
      case '--max-dispatches':
        result.maxConcurrentDispatches = parseInt(argv[++i]!, 10)
        break
      case '--no-auto-research':
        result.enableAutoResearch = false
        break
      case '--no-auto-backlog-creation':
        result.enableAutoBacklogCreation = false
        break
      case '--no-auto-development':
        result.enableAutoDevelopment = false
        break
      case '--no-auto-qa':
        result.enableAutoQA = false
        break
      case '--no-auto-acceptance':
        result.enableAutoAcceptance = false
        break
      case '--once':
        result.once = true
        break
      case '--help':
      case '-h':
        printGovernorHelp()
        process.exit(0)
    }
  }

  return result
}

/**
 * Print help text for the governor command.
 */
export function printGovernorHelp(): void {
  console.log(`
AgentFactory Governor — Automated workflow scan loop

Usage:
  agentfactory governor [options]

Options:
  --project <name>            Project to scan (can be repeated for multiple projects)
  --scan-interval <ms>        Scan interval in milliseconds (default: 60000)
  --max-dispatches <n>        Maximum concurrent dispatches per scan (default: 3)
  --no-auto-research          Disable auto-research from Icebox
  --no-auto-backlog-creation  Disable auto-backlog-creation from Icebox
  --no-auto-development       Disable auto-development from Backlog
  --no-auto-qa                Disable auto-QA from Finished
  --no-auto-acceptance        Disable auto-acceptance from Delivered
  --once                      Run a single scan pass and exit
  --help, -h                  Show this help message

Environment:
  LINEAR_API_KEY              Required API key for Linear authentication

Examples:
  # Start the governor for a project
  agentfactory governor --project MyProject

  # Scan multiple projects with custom interval
  agentfactory governor --project ProjectA --project ProjectB --scan-interval 30000

  # Run a single scan and exit (useful for cron jobs)
  agentfactory governor --project MyProject --once

  # Disable auto-QA (only scan for development work)
  agentfactory governor --project MyProject --no-auto-qa --no-auto-acceptance
`)
}
