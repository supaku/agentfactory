#!/usr/bin/env node
/**
 * AgentFactory Orchestrator CLI
 *
 * Local script to spawn concurrent coding agents on backlog issues.
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
import { execSync } from 'child_process'
import { config } from 'dotenv'

// Load environment variables from .env.local
config({ path: path.resolve(process.cwd(), '.env.local') })

import { createOrchestrator, type AgentProcess, type OrchestratorIssue } from '@supaku/agentfactory'

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

function parseArgs(): {
  project?: string
  max: number
  single?: string
  wait: boolean
  dryRun: boolean
} {
  const args = process.argv.slice(2)
  const result = {
    project: undefined as string | undefined,
    max: 3,
    single: undefined as string | undefined,
    wait: true,
    dryRun: false,
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
  console.log(`Dry run: ${args.dryRun}`)
  console.log('')

  const gitRoot = getGitRoot()
  const orchestrator = createOrchestrator(
    {
      project: args.project,
      maxConcurrent: args.max,
      worktreePath: path.resolve(gitRoot, '.worktrees'),
    },
    {
      onIssueSelected: (issue: OrchestratorIssue) => {
        console.log(`Selected: ${issue.identifier} - ${issue.title}`)
        console.log(`  URL: ${issue.url}`)
        console.log(`  Labels: ${issue.labels.join(', ') || 'none'}`)
      },
      onAgentStart: (agent: AgentProcess) => {
        console.log(`Agent started: ${agent.identifier} (PID: ${agent.pid})`)
        console.log(`  Worktree: ${agent.worktreePath}`)
      },
      onAgentComplete: (agent: AgentProcess) => {
        const duration = agent.completedAt
          ? formatDuration(agent.completedAt.getTime() - agent.startedAt.getTime())
          : 'unknown'
        console.log(`Agent completed: ${agent.identifier} (${duration})`)
      },
      onAgentError: (agent: AgentProcess, error: Error) => {
        console.error(`Agent failed: ${agent.identifier}`)
        console.error(`  Error: ${error.message}`)
      },
      onAgentIncomplete: (agent: AgentProcess) => {
        const duration = agent.completedAt
          ? formatDuration(agent.completedAt.getTime() - agent.startedAt.getTime())
          : 'unknown'
        console.warn(`Agent incomplete: ${agent.identifier} (${duration})`)
        console.warn(`  Reason: ${agent.incompleteReason ?? 'unknown'}`)
        console.warn(`  Worktree preserved: ${agent.worktreePath}`)
      },
    }
  )

  try {
    if (args.single) {
      console.log(`Processing single issue: ${args.single}`)

      if (args.dryRun) {
        console.log('[DRY RUN] Would spawn agent for:', args.single)
        return
      }

      await orchestrator.spawnAgentForIssue(args.single)
      console.log(`Agent spawned for ${args.single}`)

      if (args.wait) {
        console.log('Waiting for agent to complete...')
        await orchestrator.waitForAll()
      }

      return
    }

    if (args.dryRun) {
      const issues = await orchestrator.getBacklogIssues()

      if (issues.length === 0) {
        console.log('No backlog issues found')
        return
      }

      console.log(`[DRY RUN] Would process ${issues.length} issue(s):`)
      for (const issue of issues) {
        console.log(`  - ${issue.identifier}: ${issue.title}`)
        console.log(`    Priority: ${issue.priority || 'none'}`)
        console.log(`    Labels: ${issue.labels.join(', ') || 'none'}`)
      }
      return
    }

    const result = await orchestrator.run()

    console.log('')
    console.log('Orchestrator started')
    console.log(`  Agents spawned: ${result.agents.length}`)
    console.log(`  Errors: ${result.errors.length}`)

    if (result.errors.length > 0) {
      console.log('')
      console.log('Errors:')
      for (const { issueId, error } of result.errors) {
        console.log(`  ${issueId}: ${error.message}`)
      }
    }

    if (args.wait && result.agents.length > 0) {
      console.log('')
      console.log('Waiting for all agents to complete...')

      process.on('SIGINT', () => {
        console.log('')
        console.log('Received SIGINT, stopping agents...')
        orchestrator.stopAll()
        process.exit(1)
      })

      const completedAgents = await orchestrator.waitForAll()

      console.log('')
      console.log('All agents completed')
      console.log('Results:')
      for (const agent of completedAgents) {
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

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
