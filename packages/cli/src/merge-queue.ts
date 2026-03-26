#!/usr/bin/env node
/**
 * AgentFactory Merge Queue CLI
 *
 * Thin wrapper around the merge-queue runner. Handles dotenv, arg parsing,
 * and process.exit so the runner stays process-agnostic.
 *
 * Usage:
 *   af merge-queue <command> [options]
 *
 * Commands:
 *   status [--repo <repoId>]                              Show queue overview
 *   list [--repo <repoId>]                                List all queued PRs
 *   retry <prNumber> [--repo <repoId>]                    Move failed/blocked PR back to queue
 *   skip <prNumber> [--repo <repoId>]                     Remove PR from queue
 *   pause [--repo <repoId>]                               Pause queue processing
 *   resume [--repo <repoId>]                              Resume queue processing
 *   priority <prNumber> <priority> [--repo <repoId>]      Change PR priority
 *
 * Environment (loaded from .env.local in CWD):
 *   REDIS_URL        Required for Redis connection
 */

import path from 'path'
import { config } from 'dotenv'

// Load environment variables from .env.local in CWD
config({ path: path.resolve(process.cwd(), '.env.local') })

import { runMergeQueueCommand, C, type MergeQueueCommand } from './lib/merge-queue-runner.js'

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`
${C.cyan}AgentFactory Merge Queue${C.reset} - Manage the Refinery merge queue

${C.yellow}Usage:${C.reset}
  af merge-queue <command> [options]

${C.yellow}Commands:${C.reset}
  status [--repo <repoId>]                              Show queue overview
  list [--repo <repoId>]                                List all queued PRs
  retry <prNumber> [--repo <repoId>]                    Move failed/blocked PR back to queue
  skip <prNumber> [--repo <repoId>]                     Remove PR from queue
  pause [--repo <repoId>]                               Pause queue processing
  resume [--repo <repoId>]                              Resume queue processing
  priority <prNumber> <priority> [--repo <repoId>]      Change PR priority

${C.yellow}Examples:${C.reset}
  af merge-queue status
  af merge-queue list --repo my-org/my-repo
  af merge-queue retry 42
  af merge-queue skip 42 --repo my-org/my-repo
  af merge-queue pause
  af merge-queue resume
  af merge-queue priority 42 1
`)
}

// ---------------------------------------------------------------------------
// Valid commands
// ---------------------------------------------------------------------------

const VALID_COMMANDS = new Set<MergeQueueCommand>([
  'status',
  'list',
  'retry',
  'skip',
  'pause',
  'resume',
  'priority',
])

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(3) // argv[2] is 'merge-queue'

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage()
    return
  }

  if (!VALID_COMMANDS.has(command as MergeQueueCommand)) {
    console.error(`Unknown command: ${command}`)
    printUsage()
    process.exit(1)
  }

  await runMergeQueueCommand({
    command: command as MergeQueueCommand,
    args,
  })
}

main().catch((error) => {
  console.error('Error:', error instanceof Error ? error.message : error)
  process.exit(1)
})
