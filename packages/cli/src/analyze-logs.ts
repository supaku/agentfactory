#!/usr/bin/env node
/**
 * AgentFactory Log Analyzer CLI
 *
 * Thin wrapper around the analyze-logs runner. Handles dotenv, arg parsing,
 * SIGINT, and process.exit so the runner stays process-agnostic.
 *
 * Usage:
 *   af-analyze-logs [options]
 *
 * Options:
 *   --session <id>      Analyze a specific session
 *   --follow, -f        Watch for new sessions and analyze as they complete
 *   --interval <ms>     Poll interval in milliseconds (default: 5000)
 *   --dry-run           Show what would be created without creating issues
 *   --cleanup           Cleanup old logs based on retention policy
 *   --verbose           Show detailed analysis output
 *   --help, -h          Show this help message
 *
 * Environment (loaded from .env.local in CWD):
 *   LINEAR_API_KEY                    Required for issue creation
 *   AGENT_LOG_RETENTION_DAYS          Days before cleanup (default: 7)
 *   AGENT_LOGS_DIR                    Base directory for logs (default: .agent-logs)
 */

import path from 'path'
import { config } from 'dotenv'

// Load environment variables from .env.local in CWD
config({ path: path.resolve(process.cwd(), '.env.local') })

import { runLogAnalyzer, printSummary } from './lib/analyze-logs-runner.js'

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface CliOptions {
  sessionId?: string
  follow: boolean
  interval: number
  dryRun: boolean
  cleanup: boolean
  verbose: boolean
  showHelp: boolean
}

const DEFAULT_POLL_INTERVAL = 5000

function parseArgs(): CliOptions {
  const args = process.argv.slice(2)
  const result: CliOptions = {
    follow: false,
    interval: DEFAULT_POLL_INTERVAL,
    dryRun: false,
    cleanup: false,
    verbose: false,
    showHelp: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--session':
        result.sessionId = args[++i]
        break
      case '--follow':
      case '-f':
        result.follow = true
        break
      case '--interval':
        result.interval = parseInt(args[++i], 10) || DEFAULT_POLL_INTERVAL
        break
      case '--dry-run':
        result.dryRun = true
        break
      case '--cleanup':
        result.cleanup = true
        break
      case '--verbose':
        result.verbose = true
        break
      case '--help':
      case '-h':
        result.showHelp = true
        break
    }
  }

  return result
}

function printHelp(): void {
  console.log(`
AgentFactory Log Analyzer - Analyze agent session logs for errors and improvements

Usage:
  af-analyze-logs [options]

Options:
  --session <id>      Analyze a specific session
  --follow, -f        Watch for new sessions and analyze as they complete
  --interval <ms>     Poll interval in milliseconds (default: 5000)
  --dry-run           Show what would be created without creating issues
  --cleanup           Cleanup old logs based on retention policy
  --verbose           Show detailed analysis output
  --help, -h          Show this help message

Environment Variables:
  LINEAR_API_KEY                    Required for creating Linear issues
  AGENT_LOG_RETENTION_DAYS          Days before log cleanup (default: 7)
  AGENT_LOGS_DIR                    Base directory for logs (default: .agent-logs)

Examples:
  # Analyze all unprocessed sessions
  af-analyze-logs

  # Analyze a specific session
  af-analyze-logs --session abc123

  # Watch for new sessions and analyze continuously
  af-analyze-logs --follow

  # Watch with custom poll interval (10 seconds)
  af-analyze-logs -f --interval 10000

  # Preview what issues would be created (no actual changes)
  af-analyze-logs --dry-run

  # Clean up logs older than retention period
  af-analyze-logs --cleanup

  # Show detailed output during analysis
  af-analyze-logs --verbose
`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArgs()

  if (options.showHelp) {
    printHelp()
    process.exit(0)
  }

  // Create AbortController for SIGINT handling in follow mode
  const controller = new AbortController()

  if (options.follow) {
    const shutdown = () => {
      controller.abort()
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  }

  const result = await runLogAnalyzer(
    {
      sessionId: options.sessionId,
      follow: options.follow,
      interval: options.interval,
      dryRun: options.dryRun,
      cleanup: options.cleanup,
      verbose: options.verbose,
    },
    controller.signal,
  )

  printSummary(result, options.dryRun)
}

main().catch((error) => {
  console.error('Error:', error instanceof Error ? error.message : error)
  process.exit(1)
})
