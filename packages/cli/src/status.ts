#!/usr/bin/env node
/**
 * AgentFactory Status CLI
 *
 * Quick fleet status checks for terminal and scripting use.
 *
 * Usage:
 *   af-status                      One-line fleet summary (via Go binary in TTY)
 *   af-status --json               JSON stats to stdout
 *   af-status --watch              Auto-refresh every 3 seconds
 *   af-status --watch --interval 5s  Custom refresh interval
 *   af-status | jq                 Pipe-friendly (auto-detects non-TTY)
 *
 * Environment (loaded from .env.local in CWD):
 *   WORKER_API_URL     API base URL (default: http://localhost:3000)
 */

import path from 'path'
import { config } from 'dotenv'

// Load environment variables from .env.local in CWD
config({ path: path.resolve(process.cwd(), '.env.local') })

import { runStatus, C } from './lib/status-runner.js'

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`
${C.cyan}AgentFactory Status${C.reset} - Quick fleet status checks

${C.yellow}Usage:${C.reset}
  af-status [options]

${C.yellow}Options:${C.reset}
  --json                Output raw JSON stats to stdout
  --watch               Auto-refresh status every 3 seconds
  --interval <duration> Custom refresh interval (e.g., 1s, 5s) [default: 3s]
  --url <url>           API base URL [default: WORKER_API_URL or http://localhost:3000]
  --help, -h            Show this help message

${C.yellow}Examples:${C.reset}
  af-status                         One-line fleet summary
  af-status --json                  JSON output
  af-status --json | jq .agentsWorking  Extract a field
  af-status --watch                 Auto-refresh mode
  af-status --watch --interval 1s   Refresh every second

${C.yellow}Environment:${C.reset}
  WORKER_API_URL     API base URL (default: http://localhost:3000)
`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.includes('--help') || args.includes('-h') || args.includes('help')) {
    printUsage()
    return
  }

  const jsonMode = args.includes('--json')
  const watchMode = args.includes('--watch')

  // Parse --interval value
  let interval: string | undefined
  const intervalIdx = args.indexOf('--interval')
  if (intervalIdx !== -1 && intervalIdx + 1 < args.length) {
    interval = args[intervalIdx + 1]
  }

  // Parse --url value
  let url: string | undefined
  const urlIdx = args.indexOf('--url')
  if (urlIdx !== -1 && urlIdx + 1 < args.length) {
    url = args[urlIdx + 1]
  }

  await runStatus({ json: jsonMode, watch: watchMode, interval, url })
}

main().catch((error) => {
  console.error('Error:', error instanceof Error ? error.message : error)
  process.exit(1)
})
