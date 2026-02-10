#!/usr/bin/env node
/**
 * AgentFactory Log Analyzer CLI
 *
 * Analyzes agent session logs for errors and improvement opportunities.
 * Can automatically create deduplicated Linear issues in the backlog.
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
import { execSync } from 'child_process'
import { config } from 'dotenv'

// Load environment variables from .env.local in CWD
config({ path: path.resolve(process.cwd(), '.env.local') })

import { createLogAnalyzer, type LogAnalyzer } from '@supaku/agentfactory'

/**
 * Get the git repository root directory
 */
function getGitRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return process.cwd()
  }
}

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

interface AnalysisStats {
  sessionsAnalyzed: number
  totalErrors: number
  totalPatterns: number
  issuesCreated: number
  issuesUpdated: number
}

/**
 * Analyze a single session and print results
 */
async function analyzeAndPrintSession(
  analyzer: LogAnalyzer,
  sessionId: string,
  options: CliOptions,
  stats: AnalysisStats
): Promise<boolean> {
  console.log(`\nAnalyzing session: ${sessionId}`)
  console.log('-'.repeat(50))

  const result = analyzer.analyzeSession(sessionId)
  if (!result) {
    console.log('  [SKIP] Session not found or incomplete')
    return false
  }

  console.log(`  Issue: ${result.metadata.issueIdentifier}`)
  console.log(`  Work Type: ${result.metadata.workType}`)
  console.log(`  Status: ${result.metadata.status}`)
  console.log(`  Events: ${result.eventsAnalyzed}`)
  console.log(`  Errors: ${result.errorsFound}`)
  console.log(`  Patterns: ${result.patterns.length}`)

  stats.sessionsAnalyzed++
  stats.totalErrors += result.errorsFound
  stats.totalPatterns += result.patterns.length

  if (options.verbose && result.patterns.length > 0) {
    console.log('\n  Detected Patterns:')
    for (const pattern of result.patterns) {
      console.log(`    - [${pattern.severity}] ${pattern.title}`)
      console.log(`      Type: ${pattern.type}, Occurrences: ${pattern.occurrences}`)
      if (pattern.tool) {
        console.log(`      Tool: ${pattern.tool}`)
      }
    }
  }

  if (result.suggestedIssues.length > 0) {
    console.log(`\n  Suggested Issues: ${result.suggestedIssues.length}`)

    if (options.verbose) {
      for (const issue of result.suggestedIssues) {
        console.log(`    - ${issue.title}`)
        console.log(`      Signature: ${issue.signature}`)
        console.log(`      Labels: ${issue.labels.join(', ')}`)
      }
    }

    try {
      const issueResults = await analyzer.createIssues(
        result.suggestedIssues,
        sessionId,
        options.dryRun
      )

      for (const issueResult of issueResults) {
        if (issueResult.created) {
          console.log(`  [${options.dryRun ? 'WOULD CREATE' : 'CREATED'}] ${issueResult.identifier}`)
          stats.issuesCreated++
        } else {
          console.log(`  [${options.dryRun ? 'WOULD UPDATE' : 'UPDATED'}] ${issueResult.identifier}`)
          stats.issuesUpdated++
        }
      }
    } catch (error) {
      console.log(`  [ERROR] Failed to create issues: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (!options.dryRun) {
    analyzer.markProcessed(sessionId, result)
    console.log('  [PROCESSED]')
  }

  return true
}

/**
 * Print summary statistics
 */
function printSummary(stats: AnalysisStats, dryRun: boolean): void {
  console.log('\n' + '='.repeat(50))
  console.log('=== Summary ===\n')
  console.log(`  Sessions analyzed: ${stats.sessionsAnalyzed}`)
  console.log(`  Total errors found: ${stats.totalErrors}`)
  console.log(`  Total patterns detected: ${stats.totalPatterns}`)
  console.log(`  Issues created: ${stats.issuesCreated}${dryRun ? ' (dry run)' : ''}`)
  console.log(`  Issues updated: ${stats.issuesUpdated}${dryRun ? ' (dry run)' : ''}`)
  console.log('')
}

/**
 * Format time for display
 */
function formatTime(): string {
  return new Date().toLocaleTimeString()
}

/**
 * Watch mode - continuously poll for new sessions
 */
async function runFollowMode(
  analyzer: LogAnalyzer,
  options: CliOptions
): Promise<void> {
  const stats: AnalysisStats = {
    sessionsAnalyzed: 0,
    totalErrors: 0,
    totalPatterns: 0,
    issuesCreated: 0,
    issuesUpdated: 0,
  }

  const processedInSession = new Set<string>()

  console.log(`[${formatTime()}] Watching for new sessions (poll interval: ${options.interval}ms)`)
  console.log(`[${formatTime()}] Press Ctrl+C to stop\n`)

  let running = true
  const shutdown = () => {
    console.log(`\n[${formatTime()}] Stopping...`)
    running = false
    printSummary(stats, options.dryRun)
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Initial check for existing unprocessed sessions
  const initialSessions = analyzer.getUnprocessedSessions()
  if (initialSessions.length > 0) {
    console.log(`[${formatTime()}] Found ${initialSessions.length} existing unprocessed session(s)`)
    for (const sid of initialSessions) {
      if (!running) break
      await analyzeAndPrintSession(analyzer, sid, options, stats)
      processedInSession.add(sid)
    }
  }

  // Poll loop
  while (running) {
    await new Promise((resolve) => setTimeout(resolve, options.interval))
    if (!running) break

    const sessions = analyzer.getUnprocessedSessions()
    const newSessions = sessions.filter((s) => !processedInSession.has(s))

    if (newSessions.length > 0) {
      console.log(`[${formatTime()}] Found ${newSessions.length} new session(s) ready for analysis`)
      for (const sid of newSessions) {
        if (!running) break
        const analyzed = await analyzeAndPrintSession(analyzer, sid, options, stats)
        if (analyzed) {
          processedInSession.add(sid)
        }
      }
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs()

  if (options.showHelp) {
    printHelp()
    process.exit(0)
  }

  const gitRoot = getGitRoot()
  const logsDir = process.env.AGENT_LOGS_DIR ?? `${gitRoot}/.agent-logs`

  console.log('\n=== AgentFactory Log Analyzer ===\n')

  if (options.dryRun) {
    console.log('[DRY RUN MODE - No issues will be created]\n')
  }

  const analyzer = createLogAnalyzer({ logsDir })

  if (options.cleanup) {
    console.log('Cleaning up old logs...\n')
    const deleted = analyzer.cleanupOldLogs()
    console.log(`Deleted ${deleted} old log entries.\n`)
    return
  }

  if (options.follow) {
    await runFollowMode(analyzer, options)
    return
  }

  // Standard one-shot mode
  const stats: AnalysisStats = {
    sessionsAnalyzed: 0,
    totalErrors: 0,
    totalPatterns: 0,
    issuesCreated: 0,
    issuesUpdated: 0,
  }

  let sessionsToAnalyze: string[]
  if (options.sessionId) {
    sessionsToAnalyze = [options.sessionId]
    console.log(`Analyzing session: ${options.sessionId}\n`)
  } else {
    sessionsToAnalyze = analyzer.getUnprocessedSessions()
    console.log(`Found ${sessionsToAnalyze.length} unprocessed session(s)\n`)
  }

  if (sessionsToAnalyze.length === 0) {
    console.log('No sessions to analyze.\n')
    return
  }

  for (const sid of sessionsToAnalyze) {
    await analyzeAndPrintSession(analyzer, sid, options, stats)
  }

  printSummary(stats, options.dryRun)
}

main().catch((error) => {
  console.error('Error:', error instanceof Error ? error.message : error)
  process.exit(1)
})
