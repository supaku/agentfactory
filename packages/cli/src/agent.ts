#!/usr/bin/env node
/**
 * AgentFactory Agent CLI
 *
 * Manage running agent sessions: stop work, send messages, check status,
 * or reconnect a disconnected Linear session.
 *
 * Usage:
 *   af-agent stop <issue-id>                  Stop a running agent
 *   af-agent chat <issue-id> <message>        Send a message to a running agent
 *   af-agent status <issue-id>                Show session details
 *   af-agent reconnect <issue-id>             Re-establish Linear agent session
 *
 * Environment (loaded from .env.local in CWD):
 *   REDIS_URL          Required for all commands
 *   LINEAR_API_KEY     Required for reconnect
 */

import path from 'path'
import { config } from 'dotenv'

// Load environment variables from .env.local in CWD
config({ path: path.resolve(process.cwd(), '.env.local') })

import { runAgent, C, type AgentCommand } from './lib/agent-runner.js'

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`
${C.cyan}AgentFactory Agent${C.reset} - Manage running agent sessions

${C.yellow}Usage:${C.reset}
  af-agent <command> <issue-id> [args]

${C.yellow}Commands:${C.reset}
  stop <issue-id>                  Stop a running agent (worker aborts within ~5s)
  chat <issue-id> <message>        Send a message to a running agent session
  status <issue-id>                Show detailed session information
  reconnect <issue-id>             Create new Linear session and re-associate

${C.yellow}Arguments:${C.reset}
  <issue-id>    Issue identifier (e.g., SUP-674) or partial session ID

${C.yellow}Examples:${C.reset}
  af-agent stop SUP-674
  af-agent chat SUP-674 "use the existing test fixtures instead"
  af-agent status SUP-674
  af-agent reconnect SUP-674

${C.yellow}Environment:${C.reset}
  REDIS_URL          Required for all commands
  LINEAR_API_KEY     Required for reconnect
`)
}

// ---------------------------------------------------------------------------
// Valid commands
// ---------------------------------------------------------------------------

const VALID_COMMANDS = new Set<AgentCommand>(['stop', 'chat', 'status', 'reconnect'])

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const command = process.argv[2] as string | undefined
  const issueId = process.argv[3]

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage()
    return
  }

  if (!VALID_COMMANDS.has(command as AgentCommand)) {
    console.error(`Unknown command: ${command}`)
    printUsage()
    process.exit(1)
  }

  if (!issueId) {
    console.error(`Usage: af-agent ${command} <issue-id>`)
    process.exit(1)
  }

  // For chat, join remaining args as the message
  let message: string | undefined
  if (command === 'chat') {
    const messageArgs = process.argv.slice(4)
    if (messageArgs.length === 0) {
      console.error('Usage: af-agent chat <issue-id> <message>')
      process.exit(1)
    }
    message = messageArgs.join(' ')
  }

  await runAgent({
    command: command as AgentCommand,
    issueId,
    message,
  })
}

main().catch((error) => {
  console.error('Error:', error instanceof Error ? error.message : error)
  process.exit(1)
})
