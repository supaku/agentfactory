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
  worker          Start a remote worker that polls for queued work
  help            Show this help message

Run 'agentfactory <command> --help' for command-specific options.

Learn more: https://github.com/supaku-org/agentfactory
`)
}

switch (command) {
  case 'orchestrator':
    import('./orchestrator')
    break
  case 'worker':
    import('./worker')
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
