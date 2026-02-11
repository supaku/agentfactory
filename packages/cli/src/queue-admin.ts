#!/usr/bin/env node
/**
 * AgentFactory Queue Admin CLI
 *
 * Thin wrapper around the queue-admin runner. Handles dotenv, arg parsing,
 * and process.exit so the runner stays process-agnostic.
 *
 * Usage:
 *   af-queue-admin <command>
 *
 * Commands:
 *   list             List all queued work items
 *   sessions         List all sessions
 *   workers          List all registered workers
 *   clear-claims     Clear stale work claims
 *   clear-queue      Clear the work queue
 *   clear-all        Clear queue, sessions, claims, and workers
 *   reset            Full state reset (claims + queue + stuck sessions)
 *   remove <id>      Remove a specific session by ID (partial match)
 *
 * Environment (loaded from .env.local in CWD):
 *   REDIS_URL        Required for Redis connection
 */

import path from 'path'
import { config } from 'dotenv'

// Load environment variables from .env.local in CWD
config({ path: path.resolve(process.cwd(), '.env.local') })

import { runQueueAdmin, C, type QueueAdminCommand } from './lib/queue-admin-runner.js'

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`
${C.cyan}AgentFactory Queue Admin${C.reset} - Manage Redis work queue and sessions

${C.yellow}Usage:${C.reset}
  af-queue-admin <command>

${C.yellow}Commands:${C.reset}
  list             List all queued work items
  sessions         List all sessions
  workers          List all registered workers
  clear-claims     Clear stale work claims
  clear-queue      Clear the work queue
  clear-all        Clear queue, sessions, claims, and workers
  reset            Full state reset (claims + queue + stuck sessions)
  remove <id>      Remove a specific session by ID (partial match)

${C.yellow}Examples:${C.reset}
  af-queue-admin list
  af-queue-admin sessions
  af-queue-admin clear-queue
  af-queue-admin reset
  af-queue-admin remove abc123
`)
}

// ---------------------------------------------------------------------------
// Valid commands
// ---------------------------------------------------------------------------

const VALID_COMMANDS = new Set<QueueAdminCommand>([
  'list',
  'sessions',
  'workers',
  'clear-claims',
  'clear-queue',
  'clear-all',
  'reset',
  'remove',
])

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const command = process.argv[2] as string | undefined
  const arg = process.argv[3]

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage()
    return
  }

  if (!VALID_COMMANDS.has(command as QueueAdminCommand)) {
    printUsage()
    return
  }

  if (command === 'remove' && !arg) {
    console.error('Usage: af-queue-admin remove <session-id>')
    process.exit(1)
  }

  await runQueueAdmin({
    command: command as QueueAdminCommand,
    sessionId: arg,
  })
}

main().catch((error) => {
  console.error('Error:', error instanceof Error ? error.message : error)
  process.exit(1)
})
