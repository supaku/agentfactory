/**
 * Orchestrator Runner -- Programmatic API for the orchestrator CLI.
 *
 * Exports `runOrchestrator()` so the orchestrator can be invoked from code
 * (e.g. Next.js route handlers, tests, or custom scripts) without going
 * through process.argv / process.env / process.exit.
 */

import path from 'path'
import { execSync } from 'child_process'
import {
  createOrchestrator,
  type AgentProcess,
  type OrchestratorIssue,
} from '@supaku/agentfactory'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OrchestratorRunnerConfig {
  /** Linear API key for authentication */
  linearApiKey: string
  /** Filter issues by project name */
  project?: string
  /** Maximum concurrent agents (default: 3) */
  max?: number
  /** Process a single issue by ID */
  single?: string
  /** Wait for agents to complete (default: true) */
  wait?: boolean
  /** Show what would be done without executing (default: false) */
  dryRun?: boolean
  /** Git repository root (default: auto-detect) */
  gitRoot?: string
  /** Callbacks for agent lifecycle events */
  callbacks?: OrchestratorCallbacks
  /** Custom workflow template directory path */
  templateDir?: string
}

export interface OrchestratorCallbacks {
  onIssueSelected?: (issue: OrchestratorIssue) => void
  onAgentStart?: (agent: AgentProcess) => void
  onAgentComplete?: (agent: AgentProcess) => void
  onAgentError?: (agent: AgentProcess, error: Error) => void
  onAgentIncomplete?: (agent: AgentProcess) => void
}

export interface OrchestratorRunnerResult {
  agentsSpawned: number
  errors: Array<{ issueId: string; error: Error }>
  completed: AgentProcess[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getGitRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return process.cwd()
  }
}

export function formatDuration(ms: number): string {
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

// ---------------------------------------------------------------------------
// Default callbacks (console.log-based, matching the original CLI output)
// ---------------------------------------------------------------------------

function defaultCallbacks(): OrchestratorCallbacks {
  return {
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
    onAgentError: (_agent: AgentProcess, error: Error) => {
      console.error(`Agent failed: ${_agent.identifier}`)
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
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runOrchestrator(
  config: OrchestratorRunnerConfig,
): Promise<OrchestratorRunnerResult> {
  const maxConcurrent = config.max ?? 3
  const wait = config.wait ?? true
  const dryRun = config.dryRun ?? false
  const gitRoot = config.gitRoot ?? getGitRoot()

  const cb = config.callbacks ?? defaultCallbacks()

  const orchestratorConfig: Record<string, unknown> = {
    project: config.project,
    maxConcurrent,
    worktreePath: path.resolve(gitRoot, '.worktrees'),
    linearApiKey: config.linearApiKey,
  }
  if (config.templateDir) {
    orchestratorConfig.templateDir = config.templateDir
  }

  const orchestrator = createOrchestrator(
    orchestratorConfig as Parameters<typeof createOrchestrator>[0],
    {
      onIssueSelected: cb.onIssueSelected,
      onAgentStart: cb.onAgentStart,
      onAgentComplete: cb.onAgentComplete,
      onAgentError: cb.onAgentError,
      onAgentIncomplete: cb.onAgentIncomplete,
    },
  )

  const result: OrchestratorRunnerResult = {
    agentsSpawned: 0,
    errors: [],
    completed: [],
  }

  // --single mode ----------------------------------------------------------
  if (config.single) {
    if (dryRun) {
      return result
    }

    await orchestrator.spawnAgentForIssue(config.single)
    result.agentsSpawned = 1

    if (wait) {
      // Wire up SIGINT so callers running from a terminal can stop agents
      const sigintHandler = () => {
        orchestrator.stopAll()
      }
      process.on('SIGINT', sigintHandler)

      try {
        const completed = await orchestrator.waitForAll()
        result.completed = completed
      } finally {
        process.removeListener('SIGINT', sigintHandler)
      }
    }

    return result
  }

  // --dry-run mode ---------------------------------------------------------
  if (dryRun) {
    await orchestrator.getBacklogIssues()
    // Nothing to spawn in dry-run; caller can inspect issues via callbacks
    return result
  }

  // Normal run -------------------------------------------------------------
  const runResult = await orchestrator.run()

  result.agentsSpawned = runResult.agents.length
  result.errors = runResult.errors

  if (wait && runResult.agents.length > 0) {
    const sigintHandler = () => {
      orchestrator.stopAll()
    }
    process.on('SIGINT', sigintHandler)

    try {
      const completed = await orchestrator.waitForAll()
      result.completed = completed
    } finally {
      process.removeListener('SIGINT', sigintHandler)
    }
  }

  return result
}
