#!/usr/bin/env node
/**
 * AgentFactory Orchestrator CLI
 *
 * Thin wrapper around the orchestrator runner.
 *
 * Usage:
 *   af-orchestrator [options]
 *
 * Options:
 *   --project <name>    Filter issues by project name
 *   --max <number>      Maximum concurrent agents (default: 3)
 *   --single <id>       Process a single issue by ID
 *   --no-wait           Don't wait for agents to complete
 *   --dry-run           Show what would be done without executing
 *
 * Environment:
 *   LINEAR_API_KEY      Required API key for Linear authentication
 */

import path from 'path'
import { config } from 'dotenv'

// Load environment variables from .env.local
config({ path: path.resolve(process.cwd(), '.env.local') })

import { runOrchestrator } from './lib/orchestrator-runner.js'

function parseArgs(): {
  project?: string
  max: number
  single?: string
  wait: boolean
  dryRun: boolean
  templates?: string
  repo?: string
} {
  const args = process.argv.slice(2)
  const result = {
    project: undefined as string | undefined,
    max: 3,
    single: undefined as string | undefined,
    wait: true,
    dryRun: false,
    templates: undefined as string | undefined,
    repo: undefined as string | undefined,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--project':
        result.project = args[++i]
        break
      case '--max':
        result.max = parseInt(args[++i], 10)
        break
      case '--single':
        result.single = args[++i]
        break
      case '--no-wait':
        result.wait = false
        break
      case '--dry-run':
        result.dryRun = true
        break
      case '--templates':
        result.templates = args[++i]
        break
      case '--repo':
        result.repo = args[++i]
        break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
    }
  }

  return result
}

function printHelp(): void {
  console.log(`
AgentFactory Orchestrator — Multi-agent fleet management for coding agents

Usage:
  af-orchestrator [options]

Options:
  --project <name>    Filter issues by project name
  --max <number>      Maximum concurrent agents (default: 3)
  --single <id>       Process a single issue by ID
  --no-wait           Don't wait for agents to complete
  --dry-run           Show what would be done without executing
  --templates <path>  Custom workflow template directory
  --repo <url>        Git repository URL for worktree cloning
  --help, -h          Show this help message

Environment:
  LINEAR_API_KEY      Required API key for Linear authentication

Examples:
  # Process up to 3 backlog issues from a project
  af-orchestrator --project MyProject

  # Process a specific issue
  af-orchestrator --single PROJ-123

  # Preview what issues would be processed
  af-orchestrator --project MyProject --dry-run
`)
}

async function main(): Promise<void> {
  const args = parseArgs()

  if (!process.env.LINEAR_API_KEY) {
    console.error('Error: LINEAR_API_KEY environment variable is required')
    process.exit(1)
  }

  console.log('AgentFactory Orchestrator')
  console.log('========================')
  console.log(`Project: ${args.project ?? 'All'}`)
  console.log(`Max concurrent: ${args.max}`)
  console.log(`Repo: ${args.repo ?? 'Any'}`)
  console.log(`Dry run: ${args.dryRun}`)
  console.log('')

  if (args.single) {
    console.log(`Processing single issue: ${args.single}`)

    if (args.dryRun) {
      console.log('[DRY RUN] Would spawn agent for:', args.single)
      return
    }
  }

  try {
    const result = await runOrchestrator({
      linearApiKey: process.env.LINEAR_API_KEY,
      project: args.project,
      max: args.max,
      single: args.single,
      wait: args.wait,
      dryRun: args.dryRun,
      templateDir: args.templates,
      repository: args.repo,
    })

    if (!args.single && !args.dryRun) {
      console.log('')
      console.log('Orchestrator started')
      console.log(`  Agents spawned: ${result.agentsSpawned}`)
      console.log(`  Errors: ${result.errors.length}`)

      if (result.errors.length > 0) {
        console.log('')
        console.log('Errors:')
        for (const { issueId, error } of result.errors) {
          console.log(`  ${issueId}: ${error.message}`)
        }
      }
    }

    if (args.single) {
      console.log(`Agent spawned for ${args.single}`)
    }

    if (args.wait && result.completed.length > 0) {
      console.log('')
      console.log('All agents completed')
      console.log('Results:')
      for (const agent of result.completed) {
        const duration = agent.completedAt
          ? formatDuration(agent.completedAt.getTime() - agent.startedAt.getTime())
          : 'unknown'
        const status = agent.status === 'completed' ? 'SUCCESS' : 'FAILED'
        console.log(`  ${agent.identifier}: ${status} (${duration})`)
      }
    }
  } catch (error) {
    console.error('Orchestrator failed:', error instanceof Error ? error.message : error)
    process.exit(1)
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`
  }
  return `${seconds}s`
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
