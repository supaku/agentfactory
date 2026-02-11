#!/usr/bin/env node
/**
 * AgentFactory Worker CLI
 *
 * Local worker that polls the coordinator for work and executes agents.
 * Thin wrapper around the programmatic runner in ./lib/worker-runner.js.
 *
 * Usage:
 *   af-worker [options]
 *
 * Options:
 *   --capacity <number>   Maximum concurrent agents (default: 3)
 *   --hostname <name>     Worker hostname (default: os.hostname())
 *   --api-url <url>       Coordinator API URL (default: WORKER_API_URL env)
 *   --api-key <key>       API key (default: WORKER_API_KEY env)
 *   --dry-run             Poll but don't execute work
 *
 * Environment (loaded from .env.local in CWD):
 *   WORKER_API_URL        Coordinator API URL (e.g., https://agent.example.com)
 *   WORKER_API_KEY        API key for authentication
 *   LINEAR_API_KEY        Required for agent operations
 */

import path from 'path'
import { config } from 'dotenv'

// Load environment variables from .env.local in CWD
config({ path: path.resolve(process.cwd(), '.env.local') })

import os from 'os'
import { runWorker } from './lib/worker-runner.js'

interface WorkerCliArgs {
  apiUrl: string
  apiKey: string
  hostname: string
  capacity: number
  dryRun: boolean
}

function parseArgs(): WorkerCliArgs {
  const args = process.argv.slice(2)
  const parsed: WorkerCliArgs = {
    apiUrl: process.env.WORKER_API_URL || 'https://agent.example.com',
    apiKey: process.env.WORKER_API_KEY || '',
    hostname: os.hostname(),
    capacity: 3,
    dryRun: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--capacity':
        parsed.capacity = parseInt(args[++i], 10)
        break
      case '--hostname':
        parsed.hostname = args[++i]
        break
      case '--api-url':
        parsed.apiUrl = args[++i]
        break
      case '--api-key':
        parsed.apiKey = args[++i]
        break
      case '--dry-run':
        parsed.dryRun = true
        break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
    }
  }

  return parsed
}

function printHelp(): void {
  console.log(`
AgentFactory Worker — Remote agent worker for distributed processing

Usage:
  af-worker [options]

Options:
  --capacity <number>   Maximum concurrent agents (default: 3)
  --hostname <name>     Worker hostname (default: ${os.hostname()})
  --api-url <url>       Coordinator API URL
  --api-key <key>       API key for authentication
  --dry-run             Poll but don't execute work
  --help, -h            Show this help message

Environment (loaded from .env.local in CWD):
  WORKER_API_URL        Coordinator API URL
  WORKER_API_KEY        API key for authentication
  LINEAR_API_KEY        Required for agent operations

Examples:
  # Start worker with default settings
  af-worker

  # Start with custom capacity
  af-worker --capacity 5

  # Test polling without executing
  af-worker --dry-run
`)
}

// --- Main ---

const cliArgs = parseArgs()

if (!cliArgs.apiKey) {
  console.error('Error: WORKER_API_KEY environment variable is required')
  process.exit(1)
}

if (!process.env.LINEAR_API_KEY) {
  console.error('Error: LINEAR_API_KEY environment variable is required')
  process.exit(1)
}

// Create AbortController for graceful shutdown
const controller = new AbortController()

process.on('SIGINT', () => controller.abort())
process.on('SIGTERM', () => controller.abort())

runWorker(
  {
    apiUrl: cliArgs.apiUrl,
    apiKey: cliArgs.apiKey,
    hostname: cliArgs.hostname,
    capacity: cliArgs.capacity,
    dryRun: cliArgs.dryRun,
    linearApiKey: process.env.LINEAR_API_KEY,
  },
  controller.signal,
)
  .then(() => {
    process.exit(0)
  })
  .catch((error) => {
    console.error('Fatal error:', error)
    process.exit(1)
  })
