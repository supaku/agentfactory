#!/usr/bin/env node
/**
 * AgentFactory Worker CLI
 *
 * Local worker that polls the coordinator for work and executes agents.
 *
 * Usage:
 *   af-worker [options]
 *
 * Options:
 *   --capacity <number>   Maximum concurrent agents (default: 3)
 *   --hostname <name>     Worker hostname (default: os.hostname())
 *   --api-url <url>       Coordinator API URL (default: WORKER_API_URL env)
 *   --api-key <key>       API key (default: WORKER_API_KEY env)
 *   --dry-run             Poll but don't execute work
 *
 * Environment (loaded from .env.local in CWD):
 *   WORKER_API_URL        Coordinator API URL (e.g., https://agent.example.com)
 *   WORKER_API_KEY        API key for authentication
 *   LINEAR_API_KEY        Required for agent operations
 */

import path from 'path'
import { execSync } from 'child_process'
import { config } from 'dotenv'

// Load environment variables from .env.local in CWD
config({ path: path.resolve(process.cwd(), '.env.local') })

import os from 'os'
import { createOrchestrator, createLogger, type AgentProcess, type OrchestratorIssue, type Logger } from '@supaku/agentfactory'
import type { AgentWorkType } from '@supaku/agentfactory-linear'

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

// Git root for worktree paths
const gitRoot = getGitRoot()

// Configuration
interface WorkerConfig {
  apiUrl: string
  apiKey: string
  hostname: string
  capacity: number
  dryRun: boolean
}

// Work item from the coordinator
interface WorkItem {
  sessionId: string
  issueId: string
  issueIdentifier: string
  priority: number
  queuedAt: number
  prompt?: string
  claudeSessionId?: string
  workType?: AgentWorkType
}

// Import orchestrator types
import type { AgentOrchestrator } from '@supaku/agentfactory'

// Global state
let workerId: string | null = null
let workerShortId: string | null = null
let activeCount = 0
let running = true
let heartbeatInterval: ReturnType<typeof setInterval> | null = null
let pollInterval: ReturnType<typeof setInterval> | null = null

// Heartbeat failure tracking
let consecutiveHeartbeatFailures = 0
const MAX_HEARTBEAT_FAILURES = 3

// Shutdown state
let shutdownInProgress = false

// Track active orchestrators by sessionId for prompt forwarding
const activeOrchestrators: Map<string, AgentOrchestrator> = new Map()

// Logger instance - will be configured after registration
let log: Logger = createLogger({}, { showTimestamp: true })

function parseArgs(): WorkerConfig {
  const args = process.argv.slice(2)
  const workerConfig: WorkerConfig = {
    apiUrl: process.env.WORKER_API_URL || 'https://agent.example.com',
    apiKey: process.env.WORKER_API_KEY || '',
    hostname: os.hostname(),
    capacity: 3,
    dryRun: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--capacity':
        workerConfig.capacity = parseInt(args[++i], 10)
        break
      case '--hostname':
        workerConfig.hostname = args[++i]
        break
      case '--api-url':
        workerConfig.apiUrl = args[++i]
        break
      case '--api-key':
        workerConfig.apiKey = args[++i]
        break
      case '--dry-run':
        workerConfig.dryRun = true
        break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
    }
  }

  return workerConfig
}

function printHelp(): void {
  console.log(`
AgentFactory Worker — Remote agent worker for distributed processing

Usage:
  af-worker [options]

Options:
  --capacity <number>   Maximum concurrent agents (default: 3)
  --hostname <name>     Worker hostname (default: ${os.hostname()})
  --api-url <url>       Coordinator API URL
  --api-key <key>       API key for authentication
  --dry-run             Poll but don't execute work
  --help, -h            Show this help message

Environment (loaded from .env.local in CWD):
  WORKER_API_URL        Coordinator API URL
  WORKER_API_KEY        API key for authentication
  LINEAR_API_KEY        Required for agent operations

Examples:
  # Start worker with default settings
  af-worker

  # Start with custom capacity
  af-worker --capacity 5

  # Test polling without executing
  af-worker --dry-run
`)
}

/**
 * Create a child logger with agent/issue context
 */
function createAgentLogger(issueIdentifier: string): Logger {
  return log.child({ issueIdentifier })
}

// Error types for API requests
type ApiError =
  | { type: 'worker_not_found' }
  | { type: 'network_error'; message: string }
  | { type: 'server_error'; status: number; body: string }

interface ApiResult<T> {
  data: T | null
  error: ApiError | null
}

async function apiRequest<T>(
  workerConfig: WorkerConfig,
  apiPath: string,
  options: RequestInit = {},
  retries = 3
): Promise<T | null> {
  const result = await apiRequestWithError<T>(workerConfig, apiPath, options, retries)
  return result.data
}

async function apiRequestWithError<T>(
  workerConfig: WorkerConfig,
  apiPath: string,
  options: RequestInit = {},
  retries = 3
): Promise<ApiResult<T>> {
  const url = `${workerConfig.apiUrl}${apiPath}`

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${workerConfig.apiKey}`,
          ...options.headers,
        },
      })

      if (!response.ok) {
        const errorBody = await response.text()

        // Check for "Worker not found" specifically
        if (response.status === 404 && errorBody.includes('Worker not found')) {
          log.warn(`Worker not found on server: ${apiPath}`, { status: response.status })
          return { data: null, error: { type: 'worker_not_found' } }
        }

        log.error(`API request failed: ${apiPath}`, { status: response.status, body: errorBody })
        return { data: null, error: { type: 'server_error', status: response.status, body: errorBody } }
      }

      return { data: (await response.json()) as T, error: null }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      const isLastAttempt = attempt === retries

      if (isLastAttempt) {
        log.error(`API request error: ${apiPath}`, { error: errorMsg, attempts: attempt })
        return { data: null, error: { type: 'network_error', message: errorMsg } }
      }

      // Exponential backoff: 1s, 2s, 4s
      const delay = Math.pow(2, attempt - 1) * 1000
      log.warn(`API request failed, retrying in ${delay}ms: ${apiPath}`, {
        error: errorMsg,
        attempt,
        maxRetries: retries,
      })
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  return { data: null, error: { type: 'network_error', message: 'Max retries exceeded' } }
}

async function register(
  workerConfig: WorkerConfig
): Promise<{ workerId: string; heartbeatInterval: number; pollInterval: number } | null> {
  log.info('Registering with coordinator', {
    apiUrl: workerConfig.apiUrl,
    hostname: workerConfig.hostname,
    capacity: workerConfig.capacity,
  })

  const result = await apiRequest<{
    workerId: string
    heartbeatInterval: number
    pollInterval: number
  }>(workerConfig, '/api/workers/register', {
    method: 'POST',
    body: JSON.stringify({
      hostname: workerConfig.hostname,
      capacity: workerConfig.capacity,
      version: '1.0.0',
    }),
  })

  if (result) {
    log.status('registered', `Worker ID: ${result.workerId.substring(0, 8)}`)
  }

  return result
}

// Flag to prevent multiple concurrent re-registration attempts
let reregistrationInProgress = false

/**
 * Transfer session ownership to a new worker ID
 */
async function transferSessionOwnership(
  workerConfig: WorkerConfig,
  sessionId: string,
  newWorkerId: string,
  oldWorkerId: string
): Promise<boolean> {
  const result = await apiRequest<{ transferred: boolean; reason?: string }>(
    workerConfig,
    `/api/sessions/${sessionId}/transfer-ownership`,
    {
      method: 'POST',
      body: JSON.stringify({ newWorkerId, oldWorkerId }),
    }
  )

  if (result?.transferred) {
    log.debug('Session ownership transferred', {
      sessionId: sessionId.substring(0, 8),
      oldWorkerId: oldWorkerId.substring(0, 8),
      newWorkerId: newWorkerId.substring(0, 8),
    })
    return true
  } else {
    log.warn('Failed to transfer session ownership', {
      sessionId: sessionId.substring(0, 8),
      reason: result?.reason,
    })
    return false
  }
}

async function attemptReregistration(workerConfig: WorkerConfig): Promise<boolean> {
  if (reregistrationInProgress) {
    log.debug('Re-registration already in progress, skipping')
    return false
  }

  reregistrationInProgress = true
  const oldWorkerId = workerId
  log.warn('Worker not found on server - attempting to re-register')

  try {
    const registration = await register(workerConfig)
    if (registration) {
      const newWorkerId = registration.workerId
      workerId = newWorkerId
      workerShortId = newWorkerId.substring(4, 8) // Skip 'wkr_' prefix
      consecutiveHeartbeatFailures = 0
      log.status('re-registered', `New Worker ID: ${workerShortId}`)

      // Transfer ownership of active sessions to the new worker ID
      if (oldWorkerId && activeOrchestrators.size > 0) {
        log.info('Transferring ownership of active sessions', {
          sessionCount: activeOrchestrators.size,
          oldWorkerId: oldWorkerId.substring(0, 8),
          newWorkerId: newWorkerId.substring(0, 8),
        })

        const transferPromises: Promise<boolean>[] = []
        for (const sessionId of activeOrchestrators.keys()) {
          transferPromises.push(
            transferSessionOwnership(workerConfig, sessionId, newWorkerId, oldWorkerId)
          )
        }

        const results = await Promise.all(transferPromises)
        const successCount = results.filter(Boolean).length
        log.info('Session ownership transfer complete', {
          total: results.length,
          succeeded: successCount,
          failed: results.length - successCount,
        })

        // Update worker ID in all active orchestrators' activity emitters
        for (const [sessionId, orchestrator] of activeOrchestrators.entries()) {
          orchestrator.updateWorkerId(newWorkerId)
          log.debug('Updated orchestrator worker ID', {
            sessionId: sessionId.substring(0, 8),
          })
        }
      }

      return true
    }
    log.error('Re-registration failed')
    return false
  } finally {
    reregistrationInProgress = false
  }
}

async function sendHeartbeat(workerConfig: WorkerConfig): Promise<void> {
  if (!workerId) return

  const result = await apiRequestWithError<{
    acknowledged: boolean
    serverTime: string
    pendingWorkCount: number
  }>(workerConfig, `/api/workers/${workerId}/heartbeat`, {
    method: 'POST',
    body: JSON.stringify({
      activeCount,
      load: {
        cpu: os.loadavg()[0],
        memory: 1 - os.freemem() / os.totalmem(),
      },
    }),
  })

  if (result.data) {
    consecutiveHeartbeatFailures = 0
    log.debug('Heartbeat acknowledged', {
      activeCount,
      pendingWorkCount: result.data.pendingWorkCount,
    })
  } else if (result.error?.type === 'worker_not_found') {
    consecutiveHeartbeatFailures++
    await attemptReregistration(workerConfig)
  } else {
    consecutiveHeartbeatFailures++
    log.warn('Heartbeat failed', {
      consecutiveFailures: consecutiveHeartbeatFailures,
      maxFailures: MAX_HEARTBEAT_FAILURES,
      errorType: result.error?.type,
    })

    if (consecutiveHeartbeatFailures >= MAX_HEARTBEAT_FAILURES) {
      log.error('Multiple heartbeat failures - checking if re-registration needed', {
        consecutiveFailures: consecutiveHeartbeatFailures,
      })
      await attemptReregistration(workerConfig)
    }
  }
}

// Pending prompt from user via Linear
interface PendingPrompt {
  id: string
  sessionId: string
  issueId: string
  prompt: string
  userId?: string
  userName?: string
  createdAt: number
}

// Poll result including both work and pending prompts
interface PollResult {
  work: WorkItem[]
  pendingPrompts: Record<string, PendingPrompt[]>
  hasPendingPrompts: boolean
}

async function pollForWork(workerConfig: WorkerConfig): Promise<PollResult> {
  if (!workerId) return { work: [], pendingPrompts: {}, hasPendingPrompts: false }

  const result = await apiRequestWithError<PollResult>(
    workerConfig,
    `/api/workers/${workerId}/poll`
  )

  // Handle worker not found - trigger re-registration
  if (result.error?.type === 'worker_not_found') {
    await attemptReregistration(workerConfig)
    return { work: [], pendingPrompts: {}, hasPendingPrompts: false }
  }

  if (!result.data) {
    return { work: [], pendingPrompts: {}, hasPendingPrompts: false }
  }

  const pollData = result.data

  // Log when we receive pending prompts
  if (pollData.hasPendingPrompts) {
    const totalPrompts = Object.values(pollData.pendingPrompts).reduce(
      (sum, prompts) => sum + prompts.length,
      0
    )
    log.info('Received pending prompts', {
      sessionCount: Object.keys(pollData.pendingPrompts).length,
      totalPrompts,
      sessions: Object.entries(pollData.pendingPrompts).map(([sessionId, prompts]) => ({
        sessionId: sessionId.substring(0, 8),
        promptCount: prompts.length,
        promptIds: prompts.map((p) => p.id),
      })),
    })
  }

  return pollData
}

async function claimWork(
  workerConfig: WorkerConfig,
  sessionId: string
): Promise<{ claimed: boolean; work?: WorkItem } | null> {
  if (!workerId) return null

  return apiRequest(workerConfig, `/api/sessions/${sessionId}/claim`, {
    method: 'POST',
    body: JSON.stringify({ workerId }),
  })
}

async function reportStatus(
  workerConfig: WorkerConfig,
  sessionId: string,
  status: 'running' | 'finalizing' | 'completed' | 'failed' | 'stopped',
  extra?: { claudeSessionId?: string; worktreePath?: string; error?: { message: string } }
): Promise<void> {
  if (!workerId) return

  await apiRequest(workerConfig, `/api/sessions/${sessionId}/status`, {
    method: 'POST',
    body: JSON.stringify({
      workerId,
      status,
      ...extra,
    }),
  })

  log.debug(`Reported status: ${status}`, { sessionId })
}

/**
 * Post a progress update comment to the Linear issue thread
 */
async function postProgress(
  workerConfig: WorkerConfig,
  sessionId: string,
  milestone: string,
  message: string
): Promise<void> {
  if (!workerId) return

  const result = await apiRequest<{ posted: boolean; reason?: string }>(
    workerConfig,
    `/api/sessions/${sessionId}/progress`,
    {
      method: 'POST',
      body: JSON.stringify({
        workerId,
        milestone,
        message,
      }),
    }
  )

  if (result?.posted) {
    log.debug(`Progress posted: ${milestone}`, { sessionId })
  } else {
    log.warn(`Failed to post progress: ${milestone}`, { reason: result?.reason })
  }
}

/**
 * Check if session has been stopped (via Linear stop button)
 */
async function checkSessionStopped(
  workerConfig: WorkerConfig,
  sessionId: string
): Promise<boolean> {
  const result = await apiRequest<{ status: string }>(
    workerConfig,
    `/api/sessions/${sessionId}/status`
  )
  return result?.status === 'stopped'
}

async function deregister(workerConfig: WorkerConfig): Promise<void> {
  if (!workerId) return

  log.info('Deregistering worker')

  const result = await apiRequest<{
    deregistered: boolean
    unclaimedSessions: string[]
  }>(workerConfig, `/api/workers/${workerId}`, {
    method: 'DELETE',
  })

  if (result) {
    log.status('stopped', `Unclaimed sessions: ${result.unclaimedSessions.length}`)
  }

  workerId = null
}

async function executeWork(
  workerConfig: WorkerConfig,
  work: WorkItem
): Promise<void> {
  const agentLog = createAgentLogger(work.issueIdentifier)
  const isResume = !!work.claudeSessionId

  agentLog.section(`${isResume ? 'Resuming' : 'Starting'} work on ${work.issueIdentifier}`)
  agentLog.info('Work details', {
    hasPrompt: !!work.prompt,
    isResume,
    workType: work.workType,
  })

  activeCount++

  // Two-phase completion: set in try/catch, read in finally
  let finalStatus: 'completed' | 'failed' | 'stopped' = 'failed'
  let statusPayload: { claudeSessionId?: string; worktreePath?: string; error?: { message: string } } | undefined

  // Issue lock TTL refresher
  let lockRefresher: ReturnType<typeof setInterval> | null = null

  try {
    await reportStatus(workerConfig, work.sessionId, 'running')

    // Start lock TTL refresher (refresh every 60s, lock TTL is 2 hours)
    if (work.issueId) {
      lockRefresher = setInterval(async () => {
        try {
          const response = await apiRequest<{ refreshed: boolean }>(
            workerConfig,
            `/api/sessions/${work.sessionId}/lock-refresh`,
            {
              method: 'POST',
              body: JSON.stringify({ workerId, issueId: work.issueId }),
            }
          )
          if (response?.refreshed) {
            agentLog.debug('Issue lock TTL refreshed')
          }
        } catch {
          // Non-fatal — lock has a 2hr TTL so missing one refresh is fine
        }
      }, 60_000)
    }

    // Post initial progress
    await postProgress(
      workerConfig,
      work.sessionId,
      isResume ? 'resumed' : 'claimed',
      isResume
        ? `Resuming work on ${work.issueIdentifier}`
        : `Worker claimed ${work.issueIdentifier}. Setting up environment...`
    )

    // Create orchestrator with API activity proxy
    const orchestrator = createOrchestrator(
      {
        maxConcurrent: 1,
        worktreePath: path.resolve(gitRoot, '.worktrees'),
        apiActivityConfig: {
          baseUrl: workerConfig.apiUrl,
          apiKey: workerConfig.apiKey,
          workerId: workerId!,
        },
      },
      {
        onIssueSelected: (issue: OrchestratorIssue) => {
          agentLog.info('Issue fetched', {
            title: issue.title.slice(0, 50),
            labels: issue.labels.join(', '),
          })
        },
        onAgentStart: (agent: AgentProcess) => {
          agentLog.status('running', `PID: ${agent.pid}`)
          agentLog.debug('Agent details', {
            worktree: agent.worktreePath,
          })

          reportStatus(workerConfig, work.sessionId, 'running', {
            claudeSessionId: agent.sessionId,
            worktreePath: agent.worktreePath,
          })

          postProgress(
            workerConfig,
            work.sessionId,
            'started',
            `Agent started working on ${agent.identifier}`
          )
        },
        onAgentComplete: (agent: AgentProcess) => {
          agentLog.status('completed', `Exit code: ${agent.exitCode}`)
        },
        onAgentError: (_agent: AgentProcess, error: Error) => {
          agentLog.error('Agent error', { error: error.message })
        },
        onAgentStopped: (_agent: AgentProcess) => {
          agentLog.status('stopped')
        },
        onAgentIncomplete: (agent: AgentProcess) => {
          agentLog.warn('Agent incomplete - worktree preserved', {
            reason: agent.incompleteReason,
            worktreePath: agent.worktreePath,
          })
        },
        onClaudeSessionId: (_linearSessionId: string, claudeSessionId: string) => {
          agentLog.debug('Claude session captured', { claudeSessionId })
          reportStatus(workerConfig, work.sessionId, 'running', {
            claudeSessionId,
          })
        },
      }
    )

    // Store orchestrator for prompt forwarding
    activeOrchestrators.set(work.sessionId, orchestrator)
    agentLog.debug('Orchestrator registered for session', {
      sessionId: work.sessionId.substring(0, 8),
    })

    let spawnedAgent: AgentProcess

    // Retry configuration for "agent already running" conflicts
    const MAX_SPAWN_RETRIES = 6
    const SPAWN_RETRY_DELAY_MS = 15000

    if (work.claudeSessionId) {
      // Resume existing Claude session
      agentLog.info('Resuming Claude session', {
        claudeSessionId: work.claudeSessionId.substring(0, 12),
      })

      const prompt = work.prompt || `Continue work on ${work.issueIdentifier}`
      const result = await orchestrator.forwardPrompt(
        work.issueId,
        work.sessionId,
        prompt,
        work.claudeSessionId,
        work.workType
      )

      if (!result.forwarded || !result.agent) {
        throw new Error(
          `Failed to resume session: ${result.reason || 'unknown error'}`
        )
      }

      agentLog.success('Session resumed')
      spawnedAgent = result.agent
    } else {
      // Fresh start with retry logic
      agentLog.info('Spawning new agent', { workType: work.workType })

      let lastError: Error | null = null
      for (let attempt = 1; attempt <= MAX_SPAWN_RETRIES; attempt++) {
        try {
          spawnedAgent = await orchestrator.spawnAgentForIssue(
            work.issueIdentifier,
            work.sessionId,
            work.workType,
            work.prompt
          )
          break
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err))

          const isAgentRunning = lastError.message.includes('Agent already running') ||
                                 lastError.message.includes('Agent is still running')
          const isBranchConflict = lastError.message.includes('already checked out') ||
                                   lastError.message.includes('is already checked out at')
          const isRetriable = isAgentRunning || isBranchConflict

          if (isRetriable && attempt < MAX_SPAWN_RETRIES) {
            const reason = isBranchConflict
              ? 'Branch in use by another agent'
              : 'Agent still running'
            agentLog.warn(`${reason}, waiting to retry (attempt ${attempt}/${MAX_SPAWN_RETRIES})`, {
              retryInMs: SPAWN_RETRY_DELAY_MS,
            })

            await postProgress(
              workerConfig,
              work.sessionId,
              'waiting',
              `${reason}, waiting to retry (${attempt}/${MAX_SPAWN_RETRIES})...`
            )

            await new Promise(resolve => setTimeout(resolve, SPAWN_RETRY_DELAY_MS))
          } else {
            throw lastError
          }
        }
      }

      if (!spawnedAgent!) {
        throw lastError || new Error('Failed to spawn agent after retries')
      }
    }

    agentLog.info('Agent spawned', {
      pid: spawnedAgent.pid,
      status: spawnedAgent.status,
    })

    if (!spawnedAgent.pid) {
      agentLog.warn('Agent has no PID - spawn may have failed')
    }

    // Start a stop signal checker
    let stopRequested = false
    const stopChecker = setInterval(async () => {
      try {
        if (await checkSessionStopped(workerConfig, work.sessionId)) {
          agentLog.warn('Stop signal received')
          stopRequested = true
          clearInterval(stopChecker)
          await orchestrator.stopAgent(work.issueId, false)
        }
      } catch {
        // Ignore errors in stop checker
      }
    }, 5000)

    // Wait for agent to complete
    agentLog.info('Waiting for agent to complete...')
    const results = await orchestrator.waitForAll()
    const agent = results[0]

    clearInterval(stopChecker)

    // Determine final status
    if (stopRequested || agent?.stopReason === 'user_request') {
      finalStatus = 'stopped'
      await reportStatus(workerConfig, work.sessionId, 'finalizing')
      await postProgress(workerConfig, work.sessionId, 'stopped', `Work stopped by user request`)
      agentLog.status('stopped', 'Work stopped by user request')
    } else if (agent?.stopReason === 'timeout') {
      finalStatus = 'failed'
      statusPayload = { error: { message: 'Agent timed out' } }
      await reportStatus(workerConfig, work.sessionId, 'finalizing')
      await postProgress(workerConfig, work.sessionId, 'failed', `Work timed out`)
      agentLog.status('stopped', 'Work timed out')
    } else if (agent?.status === 'completed') {
      finalStatus = 'completed'
      statusPayload = {
        claudeSessionId: agent.sessionId,
        worktreePath: agent.worktreePath,
      }
      await reportStatus(workerConfig, work.sessionId, 'finalizing')
      await postProgress(workerConfig, work.sessionId, 'completed', `Work completed successfully on ${work.issueIdentifier}`)
      agentLog.success('Work completed successfully')
    } else {
      const errorMsg = agent?.error?.message || 'Agent did not complete successfully'
      finalStatus = 'failed'
      statusPayload = { error: { message: errorMsg } }
      await reportStatus(workerConfig, work.sessionId, 'finalizing')
      await postProgress(workerConfig, work.sessionId, 'failed', `Work failed: ${errorMsg}`)
      agentLog.error('Work failed', { error: errorMsg })
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error'
    agentLog.error('Work execution failed', { error: errorMsg })
    finalStatus = 'failed'
    statusPayload = { error: { message: errorMsg } }
    await reportStatus(workerConfig, work.sessionId, 'finalizing').catch(() => {})
    await postProgress(workerConfig, work.sessionId, 'failed', `Work failed: ${errorMsg}`)
  } finally {
    if (lockRefresher) clearInterval(lockRefresher)

    activeOrchestrators.delete(work.sessionId)
    agentLog.debug('Orchestrator unregistered for session', {
      sessionId: work.sessionId.substring(0, 8),
    })
    activeCount--

    // Report true terminal status AFTER all cleanup
    await reportStatus(workerConfig, work.sessionId, finalStatus, statusPayload).catch((err) => {
      agentLog.error('Failed to report final status', { error: err instanceof Error ? err.message : String(err) })
    })
  }
}

async function main(): Promise<void> {
  const workerConfig = parseArgs()

  if (!workerConfig.apiKey) {
    console.error('Error: WORKER_API_KEY environment variable is required')
    process.exit(1)
  }

  if (!process.env.LINEAR_API_KEY) {
    console.error('Error: LINEAR_API_KEY environment variable is required')
    process.exit(1)
  }

  log.section('AgentFactory Worker')
  log.info('Configuration', {
    apiUrl: workerConfig.apiUrl,
    hostname: workerConfig.hostname,
    capacity: workerConfig.capacity,
    dryRun: workerConfig.dryRun,
  })

  // Register with coordinator
  const registration = await register(workerConfig)
  if (!registration) {
    log.error('Failed to register with coordinator')
    process.exit(1)
  }

  workerId = registration.workerId
  workerShortId = registration.workerId.substring(0, 8)

  // Update logger with worker context
  log = createLogger(
    { workerId, workerShortId },
    { showTimestamp: true }
  )

  // Set up heartbeat
  heartbeatInterval = setInterval(
    () => sendHeartbeat(workerConfig),
    registration.heartbeatInterval
  )

  // Set up graceful shutdown
  const shutdown = () => {
    if (shutdownInProgress) return
    shutdownInProgress = true

    log.warn('Shutting down...')
    running = false

    if (heartbeatInterval) clearInterval(heartbeatInterval)
    if (pollInterval) clearInterval(pollInterval)

    // Fire and forget - server will clean up via heartbeat timeout
    deregister(workerConfig).catch(() => {})

    log.status('stopped', 'Shutdown complete')
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Send initial heartbeat
  await sendHeartbeat(workerConfig)

  // Main poll loop
  log.info('Starting poll loop...')

  while (running) {
    try {
      const availableCapacity = workerConfig.capacity - activeCount

      const pollResult = await pollForWork(workerConfig)

      // Handle new work items if we have capacity
      if (availableCapacity > 0 && pollResult.work.length > 0) {
        log.info(`Found ${pollResult.work.length} work item(s)`, {
          activeCount,
          availableCapacity,
        })

        for (const item of pollResult.work.slice(0, availableCapacity)) {
          if (!running) break

          const claimResult = await claimWork(workerConfig, item.sessionId)

          if (claimResult?.claimed) {
            log.status('claimed', item.issueIdentifier)

            if (workerConfig.dryRun) {
              log.info(`[DRY RUN] Would execute: ${item.issueIdentifier}`)
            } else {
              executeWork(workerConfig, item).catch((error) => {
                log.error('Background work execution failed', {
                  error: error instanceof Error ? error.message : String(error),
                })
              })
            }
          } else {
            log.warn(`Failed to claim work: ${item.issueIdentifier}`)
          }
        }
      }

      // Handle pending prompts for active sessions
      if (pollResult.hasPendingPrompts) {
        for (const [sessionId, prompts] of Object.entries(pollResult.pendingPrompts)) {
          for (const prompt of prompts) {
            log.info('Processing pending prompt', {
              sessionId: sessionId.substring(0, 8),
              promptId: prompt.id,
              promptLength: prompt.prompt.length,
              userName: prompt.userName,
            })

            const orchestrator = activeOrchestrators.get(sessionId)

            if (!orchestrator) {
              log.warn('No active orchestrator found for session', {
                sessionId: sessionId.substring(0, 8),
                promptId: prompt.id,
              })
              continue
            }

            const agent = orchestrator.getAgentBySession(sessionId)
            const claudeSessionId = agent?.claudeSessionId

            log.info('Forwarding prompt to Claude session', {
              sessionId: sessionId.substring(0, 8),
              promptId: prompt.id,
              hasClaudeSession: !!claudeSessionId,
              agentStatus: agent?.status,
            })

            try {
              const result = await orchestrator.forwardPrompt(
                prompt.issueId,
                sessionId,
                prompt.prompt,
                claudeSessionId,
                agent?.workType
              )

              if (result.forwarded) {
                log.success(result.injected ? 'Message injected into running session' : 'Prompt forwarded successfully', {
                  sessionId: sessionId.substring(0, 8),
                  promptId: prompt.id,
                  injected: result.injected ?? false,
                  resumed: result.resumed,
                  newAgentPid: result.agent?.pid,
                })

                const claimResult = await apiRequest<{ claimed: boolean }>(
                  workerConfig,
                  `/api/sessions/${sessionId}/prompts`,
                  {
                    method: 'POST',
                    body: JSON.stringify({ promptId: prompt.id }),
                  }
                )

                if (claimResult?.claimed) {
                  log.debug('Prompt claimed', { promptId: prompt.id })
                } else {
                  log.warn('Failed to claim prompt', { promptId: prompt.id })
                }
              } else {
                log.error('Failed to forward prompt', {
                  sessionId: sessionId.substring(0, 8),
                  promptId: prompt.id,
                  reason: result.reason,
                  error: result.error?.message,
                })
              }
            } catch (error) {
              log.error('Error forwarding prompt', {
                sessionId: sessionId.substring(0, 8),
                promptId: prompt.id,
                error: error instanceof Error ? error.message : String(error),
              })
            }
          }
        }
      }
    } catch (error) {
      log.error('Poll loop error', {
        error: error instanceof Error ? error.message : String(error),
      })
    }

    // Wait before next poll
    await new Promise((resolve) =>
      setTimeout(resolve, registration.pollInterval)
    )
  }
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
