#!/usr/bin/env node
/**
 * AgentFactory CLI
 *
 * Entry point for the agentfactory command.
 * Dispatches to sub-commands based on first argument.
 */

const command = process.argv[2]

function printHelp(): void {
  console.log(`
AgentFactory CLI — Multi-agent fleet management for coding agents

Usage:
  agentfactory <command> [options]

Commands:
  orchestrator    Spawn concurrent agents on backlog issues
  governor        Automated workflow scan loop with configurable triggers
  worker          Start a remote worker that polls for queued work
  worker-fleet    Spawn and manage multiple worker processes
  cleanup         Clean up orphaned git worktrees
  queue-admin     Manage Redis work queue and sessions
  analyze-logs    Analyze agent session logs for errors
  linear          Linear issue tracker operations
  sync-routes     Generate missing route and page files from manifest
  help            Show this help message

Run 'agentfactory <command> --help' for command-specific options.

Learn more: https://github.com/supaku/agentfactory
`)
}

switch (command) {
  case 'orchestrator':
    import('./orchestrator')
    break
  case 'governor':
    import('./governor')
    break
  case 'worker':
    import('./worker')
    break
  case 'worker-fleet':
    import('./worker-fleet')
    break
  case 'cleanup':
    import('./cleanup')
    break
  case 'queue-admin':
    import('./queue-admin')
    break
  case 'analyze-logs':
    import('./analyze-logs')
    break
  case 'linear':
    import('./linear')
    break
  case 'sync-routes':
    import('./sync-routes')
    break
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    printHelp()
    break
  default:
    console.error(`Unknown command: ${command}`)
    printHelp()
    process.exit(1)
}
