#!/usr/bin/env node
/**
 * AgentFactory Governor CLI
 *
 * Thin wrapper around the governor runner.
 *
 * Usage:
 *   af-governor [options]
 *
 * Options:
 *   --project <name>            Project to scan (can be repeated)
 *   --scan-interval <ms>        Scan interval in milliseconds (default: 60000)
 *   --max-dispatches <n>        Maximum concurrent dispatches per scan (default: 3)
 *   --no-auto-research          Disable auto-research from Icebox
 *   --no-auto-backlog-creation  Disable auto-backlog-creation from Icebox
 *   --no-auto-development       Disable auto-development from Backlog
 *   --no-auto-qa                Disable auto-QA from Finished
 *   --no-auto-acceptance        Disable auto-acceptance from Delivered
 *   --once                      Run a single scan pass and exit
 *
 * Environment:
 *   LINEAR_API_KEY              Required API key for Linear authentication
 *   GOVERNOR_PROJECTS           Comma-separated project names (fallback for --project)
 */

import path from 'path'
import { config } from 'dotenv'

// Load environment variables from .env.local
config({ path: path.resolve(process.cwd(), '.env.local') })

import {
  parseGovernorArgs,
  runGovernor,
  type GovernorRunnerConfig,
} from './lib/governor-runner.js'
import { createRealDependencies } from './lib/governor-dependencies.js'
import { createLinearAgentClient, type LinearAgentClient } from '@supaku/agentfactory-linear'
import { initTouchpointStorage } from '@supaku/agentfactory'
import { RedisOverrideStorage, listStoredWorkspaces, getAccessToken } from '@supaku/agentfactory-server'
import type { GovernorDependencies, GovernorIssue, GovernorAction, ScanResult } from '@supaku/agentfactory'

// ---------------------------------------------------------------------------
// Stub dependencies
// ---------------------------------------------------------------------------

/**
 * Create placeholder dependencies for the Governor.
 *
 * In a production deployment, these would be backed by the Linear SDK
 * and Redis (via packages/server). For now we provide stubs that log
 * calls and return safe defaults. The WorkSchedulingFrontend (SUP-709
 * Wave 3) will provide the real implementations.
 */
function createStubDependencies(): GovernorDependencies {
  const log = {
    warn: (msg: string, data?: Record<string, unknown>) =>
      console.warn(`[governor-stub] ${msg}`, data ? JSON.stringify(data) : ''),
  }

  return {
    listIssues: async (_project: string): Promise<GovernorIssue[]> => {
      log.warn('listIssues stub called — no issues returned', { project: _project })
      return []
    },
    hasActiveSession: async (_issueId: string): Promise<boolean> => false,
    isWithinCooldown: async (_issueId: string): Promise<boolean> => false,
    isParentIssue: async (_issueId: string): Promise<boolean> => false,
    isHeld: async (_issueId: string): Promise<boolean> => false,
    getOverridePriority: async (_issueId: string) => null,
    getWorkflowStrategy: async (_issueId: string): Promise<string | undefined> => undefined,
    isResearchCompleted: async (_issueId: string): Promise<boolean> => false,
    isBacklogCreationCompleted: async (_issueId: string): Promise<boolean> => false,
    dispatchWork: async (_issueId: string, _action: GovernorAction): Promise<void> => {
      log.warn('dispatchWork stub called', { issueId: _issueId, action: _action })
    },
  }
}

// ---------------------------------------------------------------------------
// Default prompt generator (used when no external generator is provided)
// ---------------------------------------------------------------------------

function defaultGeneratePrompt(identifier: string, workType: string): string {
  const prompts: Record<string, string> = {
    research: `Research and analyze ${identifier}.`,
    'backlog-creation': `Create backlog issues for ${identifier}.`,
    development: `Start work on ${identifier}.`,
    qa: `QA ${identifier}.`,
    acceptance: `Process acceptance for ${identifier}.`,
    refinement: `Refine ${identifier} based on feedback.`,
    coordination: `Coordinate sub-issue execution for ${identifier}.`,
  }
  return prompts[workType] || `Process ${workType} for ${identifier}.`
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseGovernorArgs()

  // Fall back to GOVERNOR_PROJECTS env var (comma-separated) when no --project flags
  if (args.projects.length === 0 && process.env.GOVERNOR_PROJECTS) {
    args.projects = process.env.GOVERNOR_PROJECTS.split(',').map(s => s.trim()).filter(Boolean)
  }

  if (args.projects.length === 0) {
    console.error('Error: at least one --project is required (or set GOVERNOR_PROJECTS env var)')
    process.exit(1)
  }

  console.log('AgentFactory Governor')
  console.log('=====================')
  console.log(`Projects: ${args.projects.join(', ')}`)
  console.log(`Scan interval: ${args.scanIntervalMs}ms`)
  console.log(`Max dispatches per scan: ${args.maxConcurrentDispatches}`)
  console.log(`Execution mode: ${args.mode}`)
  console.log(`Mode: ${args.once ? 'single scan' : 'continuous'}`)
  console.log('')

  // -----------------------------------------------------------------------
  // Choose real or stub dependencies based on environment
  // -----------------------------------------------------------------------
  let dependencies: GovernorDependencies

  const linearApiKey = process.env.LINEAR_API_KEY
  const redisUrl = process.env.REDIS_URL

  if (linearApiKey) {
    console.log('LINEAR_API_KEY detected — using real dependencies')

    const linearClient = createLinearAgentClient({ apiKey: linearApiKey })

    // Resolve OAuth token from Redis for Agent API operations
    let oauthClient: LinearAgentClient | undefined
    let organizationId: string | undefined

    // Initialize touchpoint storage (for isHeld / getOverridePriority) when Redis is available
    if (redisUrl) {
      console.log('REDIS_URL detected — initializing Redis-backed touchpoint storage')
      initTouchpointStorage(new RedisOverrideStorage())

      // Resolve OAuth token for Linear Agent API (createAgentSessionOnIssue)
      try {
        const workspaces = await listStoredWorkspaces()
        if (workspaces.length > 0) {
          organizationId = workspaces[0]  // Use first workspace (single-tenant)
          const accessToken = await getAccessToken(organizationId)
          if (accessToken) {
            oauthClient = createLinearAgentClient({ apiKey: accessToken })
            console.log(`OAuth token resolved for workspace ${organizationId}`)
          } else {
            console.warn('Warning: No OAuth access token found — agent sessions will use personal API key')
          }
        } else {
          console.warn('Warning: No stored workspaces found — agent sessions will use personal API key')
        }
      } catch (err) {
        console.warn('Warning: Failed to resolve OAuth token —', err instanceof Error ? err.message : err)
      }
    } else {
      console.warn('Warning: REDIS_URL not set — touchpoint overrides (HOLD, PRIORITY) will not persist')
    }

    dependencies = createRealDependencies({
      linearClient,
      oauthClient,
      organizationId,
      generatePrompt: defaultGeneratePrompt,
    })
  } else {
    console.warn('Warning: LINEAR_API_KEY not set — using stub dependencies (no real work will be dispatched)')
    dependencies = createStubDependencies()
  }

  const runnerConfig: GovernorRunnerConfig = {
    projects: args.projects,
    scanIntervalMs: args.scanIntervalMs,
    maxConcurrentDispatches: args.maxConcurrentDispatches,
    enableAutoResearch: args.enableAutoResearch,
    enableAutoBacklogCreation: args.enableAutoBacklogCreation,
    enableAutoDevelopment: args.enableAutoDevelopment,
    enableAutoQA: args.enableAutoQA,
    enableAutoAcceptance: args.enableAutoAcceptance,
    once: args.once,
    mode: args.mode,
    dependencies,
    callbacks: {
      onScanComplete: (results: ScanResult[]) => {
        for (const result of results) {
          console.log(`[${result.project}] Scanned ${result.scannedIssues} issues, dispatched ${result.actionsDispatched}`)
          if (result.errors.length > 0) {
            for (const err of result.errors) {
              console.error(`  Error: ${err.issueId} — ${err.error}`)
            }
          }
        }
      },
      onError: (error: Error) => {
        console.error('Governor error:', error.message)
      },
    },
  }

  try {
    const { governor, scanResults } = await runGovernor(runnerConfig)

    if (args.once && scanResults) {
      // Print summary and exit
      let totalDispatched = 0
      let totalErrors = 0
      for (const result of scanResults) {
        totalDispatched += result.actionsDispatched
        totalErrors += result.errors.length
      }
      console.log('')
      console.log(`Scan complete: ${totalDispatched} actions dispatched, ${totalErrors} errors`)
      return
    }

    // Continuous mode — handle graceful shutdown
    console.log('Governor running. Press Ctrl+C to stop.')

    const shutdown = () => {
      console.log('\nShutting down governor...')
      governor.stop()
      process.exit(0)
    }

    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  } catch (error) {
    console.error('Governor failed:', error instanceof Error ? error.message : error)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
