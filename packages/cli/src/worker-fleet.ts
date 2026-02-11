#!/usr/bin/env node
/**
 * AgentFactory Worker Fleet Manager
 *
 * Spawns and manages multiple worker processes for parallel agent execution.
 * Thin wrapper around the programmatic runner in ./lib/worker-fleet-runner.js.
 *
 * Usage:
 *   af-worker-fleet [options]
 *
 * Options:
 *   -w, --workers <n>   Number of worker processes (default: CPU cores / 2)
 *   -c, --capacity <n>  Agents per worker (default: 3)
 *   -p, --projects <l>  Comma-separated project names to accept (default: all)
 *   --dry-run            Show configuration without starting workers
 *
 * Environment (loaded from .env.local in CWD):
 *   WORKER_FLEET_SIZE     Number of workers (override)
 *   WORKER_CAPACITY       Agents per worker (override)
 *   WORKER_PROJECTS       Comma-separated project names to accept
 *   WORKER_API_URL        Coordinator API URL (required)
 *   WORKER_API_KEY        API key for authentication (required)
 */

import path from 'path'
import os from 'os'
import { config as loadEnv } from 'dotenv'

// Load environment variables from .env.local in CWD
loadEnv({ path: path.resolve(process.cwd(), '.env.local') })

import { runWorkerFleet } from './lib/worker-fleet-runner.js'

// ANSI colors (kept for help output)
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
}

function parseArgs(): { workers: number; capacity: number; dryRun: boolean; projects?: string[] } {
  const args = process.argv.slice(2)
  let workers =
    parseInt(process.env.WORKER_FLEET_SIZE ?? '0', 10) ||
    Math.max(1, Math.floor(os.cpus().length / 2))
  let capacity = parseInt(process.env.WORKER_CAPACITY ?? '3', 10)
  let dryRun = false
  let projects: string[] | undefined

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workers' || args[i] === '-w') {
      workers = parseInt(args[++i], 10)
    } else if (args[i] === '--capacity' || args[i] === '-c') {
      capacity = parseInt(args[++i], 10)
    } else if (args[i] === '--projects' || args[i] === '-p') {
      projects = args[++i].split(',').map(s => s.trim()).filter(Boolean)
    } else if (args[i] === '--dry-run') {
      dryRun = true
    } else if (args[i] === '--help' || args[i] === '-h') {
      printHelp()
      process.exit(0)
    }
  }

  return { workers, capacity, dryRun, projects }
}

function printHelp(): void {
  console.log(`
${colors.cyan}AgentFactory Worker Fleet Manager${colors.reset}
Spawns and manages multiple worker processes for parallel agent execution.

${colors.yellow}Usage:${colors.reset}
  af-worker-fleet [options]

${colors.yellow}Options:${colors.reset}
  -w, --workers <n>   Number of worker processes (default: CPU cores / 2)
  -c, --capacity <n>  Agents per worker (default: 3)
  -p, --projects <l>  Comma-separated project names to accept (default: all)
  --dry-run           Show configuration without starting workers
  -h, --help          Show this help message

${colors.yellow}Examples:${colors.reset}
  af-worker-fleet                     # Auto-detect optimal settings
  af-worker-fleet -w 8 -c 5           # 8 workers x 5 agents = 40 concurrent
  af-worker-fleet -p Social,Agent     # Only accept Social and Agent projects

${colors.yellow}Environment (loaded from .env.local in CWD):${colors.reset}
  WORKER_FLEET_SIZE   Override number of workers
  WORKER_CAPACITY     Override agents per worker
  WORKER_PROJECTS     Comma-separated project names to accept
  WORKER_API_URL      API endpoint (required)
  WORKER_API_KEY      API key for authentication (required)

${colors.yellow}System Info:${colors.reset}
  CPU Cores: ${os.cpus().length}
  Total RAM: ${Math.round(os.totalmem() / 1024 / 1024 / 1024)} GB
  Free RAM:  ${Math.round(os.freemem() / 1024 / 1024 / 1024)} GB
`)
}

// --- Main ---

const fleetArgs = parseArgs()

if (!process.env.WORKER_API_URL) {
  console.error(
    `${colors.red}Error: WORKER_API_URL environment variable is required${colors.reset}`,
  )
  process.exit(1)
}

if (!process.env.WORKER_API_KEY) {
  console.error(
    `${colors.red}Error: WORKER_API_KEY environment variable is required${colors.reset}`,
  )
  process.exit(1)
}

// Create AbortController for graceful shutdown
const controller = new AbortController()

process.on('SIGINT', () => controller.abort())
process.on('SIGTERM', () => controller.abort())

const projects = fleetArgs.projects ??
  (process.env.WORKER_PROJECTS
    ? process.env.WORKER_PROJECTS.split(',').map(s => s.trim()).filter(Boolean)
    : undefined)

runWorkerFleet(
  {
    workers: fleetArgs.workers,
    capacity: fleetArgs.capacity,
    dryRun: fleetArgs.dryRun,
    apiUrl: process.env.WORKER_API_URL,
    apiKey: process.env.WORKER_API_KEY,
    projects,
  },
  controller.signal,
)
  .then(() => {
    process.exit(0)
  })
  .catch((err) => {
    console.error(
      `${colors.red}Fleet error: ${err instanceof Error ? err.message : String(err)}${colors.reset}`,
    )
    process.exit(1)
  })
