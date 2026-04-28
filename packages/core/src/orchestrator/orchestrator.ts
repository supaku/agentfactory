/**
 * Agent Orchestrator
 * Spawns concurrent Claude agents to work on Linear backlog issues
 * Uses the Claude Agent SDK for programmatic control
 */

import { randomUUID } from 'crypto'
import { execSync } from 'child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'fs'
import { resolve, dirname, basename, isAbsolute } from 'path'
import { parse as parseDotenv } from 'dotenv'
import {
  type AgentProvider,
  type AgentHandle,
  type AgentEvent,
  type AgentSpawnConfig,
  createProvider,
  resolveProviderName,
  resolveProviderWithSource,
  resolveModelWithSource,
  resolveSubAgentModel,
  type AgentProviderName,
  type ProvidersConfig,
  type ModelsConfig,
} from '../providers/index.js'
import { buildSafetyInstructions } from '../providers/safety-rules.js'
import { buildBaseInstructionsFromShared } from '../providers/agent-instructions.js'
import {
  initializeAgentDir,
  writeState,
  updateState,
  writeTodos,
  createInitialState,
  checkRecovery,
  buildRecoveryPrompt,
  getHeartbeatTimeoutFromEnv,
  getMaxRecoveryAttemptsFromEnv,
} from './state-recovery.js'
import { createHeartbeatWriter, getHeartbeatIntervalFromEnv, type HeartbeatWriter } from './heartbeat-writer.js'
import { createProgressLogger, type ProgressLogger } from './progress-logger.js'
import { createSessionLogger, type SessionLogger } from './session-logger.js'
import { ContextManager } from './context-manager.js'
import { isSessionLoggingEnabled, isAutoAnalyzeEnabled, getLogAnalysisConfig } from './log-config.js'
import type { WorktreeState, TodosState, TodoItem } from './state-types.js'
import type { AgentWorkType, WorkTypeStatusMappings } from './work-types.js'
import type { IssueTrackerClient, IssueTrackerSession } from './issue-tracker-client.js'
import { parseWorkResult } from './parse-work-result.js'
import { parseSecurityScanOutput } from './security-scan-event.js'
import { runBackstop, formatBackstopComment, type SessionContext } from './session-backstop.js'
import {
  inspectGitStateForSteering,
  decideSteering,
  buildSteeringPrompt,
  runSteeringRetry,
} from './session-steering.js'
import {
  captureQualityBaseline,
  computeQualityDelta,
  formatQualityReport,
  saveBaseline,
  loadBaseline,
  type QualityConfig,
} from './quality-baseline.js'
import { createActivityEmitter, type ActivityEmitter } from './activity-emitter.js'
import { createApiActivityEmitter, type ApiActivityEmitter } from './api-activity-emitter.js'
import { createLogger, type Logger } from '../logger.js'
import { TemplateRegistry, CodexToolPermissionAdapter, createToolPermissionAdapter } from '../templates/index.js'
import { loadRepositoryConfig, getProjectConfig, getProjectPath, getProvidersConfig, getModelsConfig, getProfilesConfig, getDispatchConfig, resolveProfileForSpawn } from '../config/index.js'
import type { ProfileConfig, DispatchConfig, ResolvedProfile } from '../config/index.js'
import type { RepositoryConfig } from '../config/index.js'
import { ToolRegistry } from '../tools/index.js'
import type { ToolPlugin } from '../tools/index.js'
import type { TemplateContext } from '../templates/index.js'
import { getLockFileName, getInstallCommand, getAddCommand, type PackageManager } from '../package-manager.js'
import { createMergeQueueAdapter } from '../merge-queue/index.js'
import {
  isBranchConflictError as isBranchConflictErrorShared,
  parseConflictingWorktreePath as parseConflictingWorktreePathShared,
} from '../merge-queue/branch-conflict.js'
import type {
  OrchestratorConfig,
  OrchestratorIssue,
  AgentProcess,
  OrchestratorEvents,
  SpawnAgentOptions,
  OrchestratorResult,
  OrchestratorStreamConfig,
  StopAgentResult,
  ForwardPromptResult,
  InjectMessageResult,
  SpawnAgentWithResumeOptions,
} from './types.js'
import {
  loadSettingsEnv,
  loadAppEnvFiles,
  generatePromptForWorkType,
} from './spawn-helpers.js'
import {
  extractShellCommand,
  isGrepGlobShellCommand,
  isToolRelatedError,
  extractToolNameFromError,
  mergeMentionContext,
  shouldDeferAcceptanceTransition,
  detectWorkType as detectWorkTypeHelper,
  WORK_TYPE_SUFFIX,
} from './dispatcher.js'
import {
  findRepoRoot,
  resolveMainRepoRoot,
  resolveWorktreePath,
  checkForIncompleteWork,
  checkForPushedWorkWithoutPR,
  getWorktreeIdentifier,
} from '../workarea/git-worktree.js'

// Default inactivity timeout: 5 minutes
const DEFAULT_INACTIVITY_TIMEOUT_MS = 300000
// Coordination inactivity timeout: 30 minutes.
// Coordinators spawn foreground sub-agents via the Agent tool. During sub-agent
// execution the parent event stream is silent (no tool_progress events), so the
// standard 5-minute inactivity timeout kills coordinators prematurely. 30 minutes
// gives sub-agents ample time to complete complex work.
const COORDINATION_INACTIVITY_TIMEOUT_MS = 1800000
// Default max session timeout: unlimited (undefined)
const DEFAULT_MAX_SESSION_TIMEOUT_MS: number | undefined = undefined

// Env vars that Claude Code interprets for authentication/routing. If these
// leak into agent processes from app .env.local files, Claude Code switches
// from Max subscription billing to API-key billing. Apps that need an
// Anthropic API key should use a namespaced name instead (e.g.
// RENSEI_SOCIAL_ANTHROPIC_API_KEY) which won't be recognised by Claude Code.
const AGENT_ENV_BLOCKLIST = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'OPENCLAW_GATEWAY_TOKEN',
]

/**
 * Validate that the git remote origin URL contains the expected repository pattern.
 * Supports both HTTPS (github.com/org/repo) and SSH (git@github.com:org/repo) formats.
 *
 * @param expectedRepo - The expected repository pattern (e.g. 'github.com/renseiai/agentfactory')
 * @param cwd - Working directory to run git commands in
 * @throws Error if the git remote does not match the expected repository
 */
export function validateGitRemote(expectedRepo: string, cwd?: string): void {
  let remoteUrl: string
  try {
    remoteUrl = execSync('git remote get-url origin', {
      encoding: 'utf-8',
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch {
    throw new Error(
      `Repository validation failed: could not get git remote URL. Expected '${expectedRepo}'.`
    )
  }

  // Normalize: convert SSH format (git@github.com:org/repo.git) to comparable form
  const normalizedRemote = remoteUrl
    .replace(/^git@([^:]+):/, '$1/')  // git@github.com:org/repo -> github.com/org/repo
    .replace(/^https?:\/\//, '')       // https://github.com/org/repo -> github.com/org/repo
    .replace(/\.git$/, '')             // remove trailing .git

  const normalizedExpected = expectedRepo
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/, '')

  if (!normalizedRemote.includes(normalizedExpected)) {
    throw new Error(
      `Repository mismatch: expected '${expectedRepo}' but git remote is '${remoteUrl}'. Refusing to proceed.`
    )
  }
}

const DEFAULT_CONFIG: Required<Omit<OrchestratorConfig, 'linearApiKey' | 'project' | 'provider' | 'streamConfig' | 'apiActivityConfig' | 'workTypeTimeouts' | 'maxSessionTimeoutMs' | 'templateDir' | 'repository' | 'issueTrackerClient' | 'statusMappings' | 'toolPlugins' | 'mergeQueueAdapter' | 'mergeQueueStorage' | 'fileReservation' | 'deployProvider'>> & {
  streamConfig: OrchestratorStreamConfig
  maxSessionTimeoutMs?: number
} = {
  maxConcurrent: 3,
  worktreePath: '../{repoName}.wt',
  autoTransition: true,
  // Preserve worktree when PR creation fails to prevent data loss
  preserveWorkOnPrFailure: true,
  // Sandbox disabled by default due to known bugs:
  // - https://github.com/anthropics/claude-code/issues/14162
  // - https://github.com/anthropics/claude-code/issues/12150
  sandboxEnabled: false,
  streamConfig: {
    minInterval: 500,
    maxOutputLength: 2000,
    includeTimestamps: false,
  },
  // Inactivity timeout: agent is stopped if no activity for this duration
  inactivityTimeoutMs: DEFAULT_INACTIVITY_TIMEOUT_MS,
  // Max session timeout: hard cap on runtime (unlimited by default)
  maxSessionTimeoutMs: DEFAULT_MAX_SESSION_TIMEOUT_MS,
}

// loadSettingsEnv, loadAppEnvFiles, generatePromptForWorkType imported from spawn-helpers.ts above (REN-1284)

// Re-exported from workarea/git-worktree.ts (REN-1284 decomposition)
// Keep identical signatures here so consumers don't break.
export {
  findRepoRoot,
  resolveMainRepoRoot,
  resolveWorktreePath,
} from '../workarea/git-worktree.js'

// Re-exported from workarea/git-worktree.ts (REN-1284 decomposition)
export type { IncompleteWorkCheck, PushedWorkCheck } from '../workarea/git-worktree.js'
export {
  checkForIncompleteWork,
  checkForPushedWorkWithoutPR,
} from '../workarea/git-worktree.js'

// Re-exported from dispatcher.ts (REN-1284 decomposition)
export {
  mergeMentionContext,
  shouldDeferAcceptanceTransition,
  extractShellCommand,
  isGrepGlobShellCommand,
} from './dispatcher.js'

// Re-exported from workarea/git-worktree.ts and dispatcher.ts (REN-1284 decomposition)
export { getWorktreeIdentifier } from '../workarea/git-worktree.js'
export { detectWorkType } from './dispatcher.js'

export class AgentOrchestrator {
  private readonly config: Required<Omit<OrchestratorConfig, 'project' | 'provider' | 'streamConfig' | 'apiActivityConfig' | 'workTypeTimeouts' | 'maxSessionTimeoutMs' | 'templateDir' | 'repository' | 'issueTrackerClient' | 'statusMappings' | 'toolPlugins' | 'mergeQueueAdapter' | 'mergeQueueStorage' | 'fileReservation' | 'deployProvider'>> & {
    project?: string
    repository?: string
    streamConfig: OrchestratorStreamConfig
    apiActivityConfig?: OrchestratorConfig['apiActivityConfig']
    workTypeTimeouts?: OrchestratorConfig['workTypeTimeouts']
    maxSessionTimeoutMs?: number
    fileReservation?: OrchestratorConfig['fileReservation']
  }
  private readonly client: IssueTrackerClient
  private readonly statusMappings: WorkTypeStatusMappings
  private readonly events: OrchestratorEvents
  private readonly activeAgents: Map<string, AgentProcess> = new Map()
  private readonly agentHandles: Map<string, AgentHandle> = new Map()
  private provider: AgentProvider
  private readonly providerCache: Map<AgentProviderName, AgentProvider> = new Map()
  private configProviders?: ProvidersConfig
  private configModels?: ModelsConfig
  private profiles?: Record<string, ProfileConfig>
  private dispatchConfig?: DispatchConfig
  private readonly agentSessions: Map<string, IssueTrackerSession> = new Map()
  private readonly activityEmitters: Map<string, ActivityEmitter | ApiActivityEmitter> = new Map()
  // Track session ID to issue ID mapping for stop signal handling
  private readonly sessionToIssue: Map<string, string> = new Map()
  // Track AbortControllers for stopping agents
  private readonly abortControllers: Map<string, AbortController> = new Map()
  // Loggers per agent for structured output
  private readonly agentLoggers: Map<string, Logger> = new Map()
  // Heartbeat writers per agent for crash detection
  private readonly heartbeatWriters: Map<string, HeartbeatWriter> = new Map()
  // Progress loggers per agent for debugging
  private readonly progressLoggers: Map<string, ProgressLogger> = new Map()
  // Session loggers per agent for verbose analysis logging
  private readonly sessionLoggers: Map<string, SessionLogger> = new Map()
  private readonly contextManagers: Map<string, ContextManager> = new Map()
  // Session output flags for completion contract validation (keyed by issueId)
  private readonly sessionOutputFlags: Map<string, { commentPosted: boolean; issueUpdated: boolean; subIssuesCreated: boolean }> = new Map()
  // Stored spawn configs so the session-steering retry can resume with the same
  // model/effort/sandbox/env as the original session. Keyed by issueId.
  private readonly steeringSpawnConfigs: Map<string, AgentSpawnConfig> = new Map()
  // Buffered assistant text for batched logging (keyed by issueId)
  // Streaming providers (Codex) send one token per event — buffer and flush on sentence boundaries
  private readonly assistantTextBuffers: Map<string, { text: string; timer: ReturnType<typeof setTimeout> | null }> = new Map()
  /** Tracks pending tool_use events by issueId→toolUseId for context emission on tool_result */
  private readonly pendingToolCalls: Map<string, Map<string, { toolName: string; input: Record<string, unknown> }>> = new Map()
  // Flag to prevent promoting agents during fleet shutdown
  private shuttingDown = false
  // Template registry for configurable workflow prompts
  private readonly templateRegistry: TemplateRegistry | null
  // Allowlisted project names from .agentfactory/config.yaml
  private allowedProjects?: string[]
  // Full repository config from .agentfactory/config.yaml
  private repoConfig?: RepositoryConfig
  // Project-to-path mapping from .agentfactory/config.yaml (monorepo support)
  private projectPaths?: Record<string, string>
  // Shared paths from .agentfactory/config.yaml (monorepo support)
  private sharedPaths?: string[]
  // Linear CLI command from .agentfactory/config.yaml (non-Node project support)
  private linearCli?: string
  // Package manager from .agentfactory/config.yaml (non-Node project support)
  private packageManager?: string
  // Configurable build/test/validate commands from .agentfactory/config.yaml
  private buildCommand?: string
  private testCommand?: string
  private validateCommand?: string
  // Tool plugin registry for in-process agent tools
  private readonly toolRegistry: ToolRegistry
  // Merge queue adapter for automated merge operations (initialized from config or repo config)
  private mergeQueueAdapter?: import('../merge-queue/types.js').MergeQueueAdapter
  // Git repository root for running git commands (resolved from worktreePath or cwd)
  private readonly gitRoot: string

  constructor(config: OrchestratorConfig = {}, events: OrchestratorEvents = {}) {
    // Validate that an issue tracker client is available
    if (!config.issueTrackerClient) {
      const apiKey = config.linearApiKey ?? process.env.LINEAR_API_KEY
      if (!apiKey) {
        throw new Error('Either issueTrackerClient or LINEAR_API_KEY is required')
      }
    }

    // Parse timeout config from environment variables (can be overridden by config)
    const envInactivityTimeout = process.env.AGENT_INACTIVITY_TIMEOUT_MS
      ? parseInt(process.env.AGENT_INACTIVITY_TIMEOUT_MS, 10)
      : undefined
    const envMaxSessionTimeout = process.env.AGENT_MAX_SESSION_TIMEOUT_MS
      ? parseInt(process.env.AGENT_MAX_SESSION_TIMEOUT_MS, 10)
      : undefined

    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      linearApiKey: config.linearApiKey ?? process.env.LINEAR_API_KEY ?? '',
      streamConfig: {
        ...DEFAULT_CONFIG.streamConfig,
        ...config.streamConfig,
      },
      apiActivityConfig: config.apiActivityConfig,
      workTypeTimeouts: config.workTypeTimeouts,
      // Config takes precedence over env vars, which take precedence over defaults
      inactivityTimeoutMs: config.inactivityTimeoutMs ?? envInactivityTimeout ?? DEFAULT_CONFIG.inactivityTimeoutMs,
      maxSessionTimeoutMs: config.maxSessionTimeoutMs ?? envMaxSessionTimeout ?? DEFAULT_CONFIG.maxSessionTimeoutMs,
    }
    // Resolve git root from cwd — use resolveMainRepoRoot first so that when the
    // orchestrator runs inside a linked worktree we follow the .git file back to
    // the main repo instead of treating the worktree itself as the repo root.
    this.gitRoot = resolveMainRepoRoot(process.cwd()) ?? findRepoRoot(process.cwd()) ?? process.cwd()

    // Validate git remote matches configured repository (if set)
    if (this.config.repository) {
      validateGitRemote(this.config.repository, this.gitRoot)
    }

    // Use injected client or fail (caller must provide one)
    this.client = config.issueTrackerClient!
    this.statusMappings = config.statusMappings!
    this.events = events

    // Initialize default agent provider — per-spawn resolution may override
    const providerName = resolveProviderName({ project: config.project })
    this.provider = config.provider ?? createProvider(providerName)
    this.providerCache.set(this.provider.name, this.provider)

    // Initialize template registry for configurable workflow prompts
    try {
      const templateDirs: string[] = []
      if (config.templateDir) {
        templateDirs.push(config.templateDir)
      }
      // Auto-detect .agentfactory/templates/ in target repo
      const projectTemplateDir = resolve(this.gitRoot, '.agentfactory', 'templates')
      if (existsSync(projectTemplateDir) && !templateDirs.includes(projectTemplateDir)) {
        templateDirs.push(projectTemplateDir)
      }
      this.templateRegistry = TemplateRegistry.create({
        templateDirs,
        useBuiltinDefaults: true,
        frontend: 'linear',
      })
      this.templateRegistry.setToolPermissionAdapter(createToolPermissionAdapter(this.provider.capabilities.toolPermissionFormat ?? 'claude'))
    } catch {
      // If template loading fails, fall back to hardcoded prompts
      this.templateRegistry = null
    }

    // Auto-load .agentfactory/config.yaml from repository root
    try {
      const repoRoot = this.gitRoot
      if (repoRoot) {
        const repoConfig = loadRepositoryConfig(repoRoot)
        if (repoConfig) {
          this.repoConfig = repoConfig
          // Use repository from config as fallback if not set in OrchestratorConfig
          if (!this.config.repository && repoConfig.repository) {
            this.config.repository = repoConfig.repository
            validateGitRemote(this.config.repository, this.gitRoot)
          }
          // Store allowedProjects for backlog filtering
          if (repoConfig.projectPaths) {
            // Resolve projectPaths to plain path strings (handles both string and object forms)
            this.projectPaths = Object.fromEntries(
              Object.entries(repoConfig.projectPaths).map(([name, value]) => [
                name,
                typeof value === 'string' ? value : value.path,
              ])
            )
            this.sharedPaths = repoConfig.sharedPaths
            this.allowedProjects = Object.keys(repoConfig.projectPaths)
          } else if (repoConfig.allowedProjects) {
            this.allowedProjects = repoConfig.allowedProjects
          }
          // Store non-Node project config (repo-wide defaults)
          if (repoConfig.linearCli) {
            this.linearCli = repoConfig.linearCli
          }
          if (repoConfig.packageManager) {
            this.packageManager = repoConfig.packageManager
          }
          // Store configurable build/test/validate commands (repo-wide defaults)
          if (repoConfig.buildCommand) {
            this.buildCommand = repoConfig.buildCommand
          }
          if (repoConfig.testCommand) {
            this.testCommand = repoConfig.testCommand
          }
          if (repoConfig.validateCommand) {
            this.validateCommand = repoConfig.validateCommand
          }
          // Apply worktree.directory from repo config if worktreePath was not explicitly set
          if (repoConfig.worktree?.directory && !config.worktreePath) {
            this.config.worktreePath = repoConfig.worktree.directory
          }
          // Profile-based config takes precedence over legacy providers/models
          const profilesConfig = getProfilesConfig(repoConfig)
          const dispatchCfg = getDispatchConfig(repoConfig)
          if (profilesConfig && dispatchCfg) {
            this.profiles = profilesConfig
            this.dispatchConfig = dispatchCfg
            // Legacy providers/models sections are silently ignored
          } else {
            // Legacy path: flat providers + models
            this.configProviders = getProvidersConfig(repoConfig)
            this.configModels = getModelsConfig(repoConfig)
          }

          // Initialize merge queue adapter from repository config
          if (repoConfig.mergeQueue?.enabled && !config.mergeQueueAdapter) {
            try {
              const provider = repoConfig.mergeQueue.provider ?? 'local'
              this.mergeQueueAdapter = createMergeQueueAdapter(provider, {
                storage: config.mergeQueueStorage,
              })
              console.log(`[orchestrator] Merge queue adapter initialized: ${provider}`)
            } catch (error) {
              console.warn(`[orchestrator] Failed to initialize merge queue adapter: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
        }
      }
    } catch (err) {
      console.warn('[orchestrator] Failed to load .agentfactory/config.yaml:', err instanceof Error ? err.message : err)
    }

    // Warn if legacy .worktrees/ directory exists inside the repo
    const legacyWorktreePath = resolve(this.gitRoot, '.worktrees')
    if (existsSync(legacyWorktreePath)) {
      console.warn(
        '[orchestrator] Legacy .worktrees/ directory detected inside the repo. ' +
        'Run "af-migrate-worktrees" to move worktrees to the new sibling directory.'
      )
    }

    // Accept merge queue adapter passed directly via config (takes precedence over repo config)
    if (config.mergeQueueAdapter) {
      this.mergeQueueAdapter = config.mergeQueueAdapter
    }

    // Initialize tool plugin registry with injected plugins
    this.toolRegistry = new ToolRegistry()
    if (config.toolPlugins) {
      for (const plugin of config.toolPlugins) {
        this.toolRegistry.register(plugin)
      }
    }
  }

  /**
   * Update the last activity timestamp for an agent (for inactivity timeout tracking)
   * @param issueId - The issue ID of the agent
   * @param activityType - Optional description of the activity type
   */
  /**
   * Buffer assistant text and flush in batches for readable logging.
   * Streaming providers (Codex) emit one token per event — this buffers
   * and flushes after 500ms of silence or on sentence boundaries.
   */
  private bufferAssistantText(issueId: string, text: string, log: Logger | undefined): void {
    let buf = this.assistantTextBuffers.get(issueId)
    if (!buf) {
      buf = { text: '', timer: null }
      this.assistantTextBuffers.set(issueId, buf)
    }

    buf.text += text

    // Clear existing timer
    if (buf.timer) clearTimeout(buf.timer)

    // Flush after 500ms of silence
    buf.timer = setTimeout(() => {
      this.flushAssistantTextBuffer(issueId, log)
    }, 500)
  }

  private flushAssistantTextBuffer(issueId: string, log: Logger | undefined): void {
    const buf = this.assistantTextBuffers.get(issueId)
    if (!buf || !buf.text.trim()) return

    const text = buf.text.trim()
    if (text.length > 0) {
      log?.info('Agent', { text: text.substring(0, 300) })
    }

    buf.text = ''
    if (buf.timer) {
      clearTimeout(buf.timer)
      buf.timer = null
    }
  }

  private updateLastActivity(issueId: string, activityType: string = 'activity'): void {
    const agent = this.activeAgents.get(issueId)
    if (agent) {
      agent.lastActivityAt = new Date()
      this.events.onActivityEmitted?.(agent, activityType)
    }
  }

  /**
   * Get timeout configuration for a specific work type
   * @param workType - The work type to get timeout config for
   * @returns Timeout configuration with inactivity and max session values
   */
  private getTimeoutConfig(workType?: string): { inactivityTimeoutMs: number; maxSessionTimeoutMs?: number } {
    const baseConfig = {
      inactivityTimeoutMs: this.config.inactivityTimeoutMs,
      maxSessionTimeoutMs: this.config.maxSessionTimeoutMs,
    }

    // Apply work-type-specific overrides if configured
    if (workType && this.config.workTypeTimeouts?.[workType as keyof typeof this.config.workTypeTimeouts]) {
      const override = this.config.workTypeTimeouts[workType as keyof typeof this.config.workTypeTimeouts]
      return {
        inactivityTimeoutMs: override?.inactivityTimeoutMs ?? baseConfig.inactivityTimeoutMs,
        maxSessionTimeoutMs: override?.maxSessionTimeoutMs ?? baseConfig.maxSessionTimeoutMs,
      }
    }

    // Work types that spawn foreground sub-agents via the Agent tool may have
    // silent periods in the event stream while sub-agents run. Use a longer
    // inactivity timeout for all work types that may coordinate sub-agents,
    // unless the user has configured a per-work-type override above.
    const maySpawnSubAgents = workType === 'development' || workType === 'inflight'
      || workType === 'qa' || workType === 'acceptance'
      || workType === 'refinement-coordination'
    if (maySpawnSubAgents) {
      return {
        inactivityTimeoutMs: Math.max(baseConfig.inactivityTimeoutMs, COORDINATION_INACTIVITY_TIMEOUT_MS),
        maxSessionTimeoutMs: baseConfig.maxSessionTimeoutMs,
      }
    }

    return baseConfig
  }

  /**
   * Detect the appropriate work type for an issue based on its status.
   * Parent and leaf issues use the same work type — coordinator behavior
   * is decided at runtime by the agent based on sub-issue presence.
   */
  async detectWorkType(issueId: string, statusName: string): Promise<AgentWorkType> {
    return detectWorkTypeHelper(statusName, false, this.statusMappings.statusToWorkType)
  }

  /**
   * Get backlog issues for the configured project
   */
  async getBacklogIssues(limit?: number): Promise<OrchestratorIssue[]> {
    const maxIssues = limit ?? this.config.maxConcurrent

    // Cross-reference project repo metadata with config
    if (this.config.project && this.config.repository) {
      try {
        const projectRepoUrl = await this.client.getProjectRepositoryUrl(this.config.project)
        if (projectRepoUrl) {
          const normalizedProjectRepo = projectRepoUrl
            .replace(/^https?:\/\//, '')
            .replace(/\.git$/, '')
          const normalizedConfigRepo = this.config.repository
            .replace(/^https?:\/\//, '')
            .replace(/\.git$/, '')
          if (!normalizedProjectRepo.includes(normalizedConfigRepo) && !normalizedConfigRepo.includes(normalizedProjectRepo)) {
            console.warn(
              `Warning: Project '${this.config.project}' repository metadata '${projectRepoUrl}' ` +
              `does not match configured repository '${this.config.repository}'. Skipping issues.`
            )
            return []
          }
        }
      } catch (error) {
        // Non-fatal: log warning but continue if metadata check fails
        console.warn('Warning: Could not check project repository metadata:', error instanceof Error ? error.message : String(error))
      }
    }

    // Query issues using the abstract client
    const allIssues = await this.client.queryIssues({
      project: this.config.project,
      status: 'Backlog',
      maxResults: maxIssues * 2, // Fetch extra to account for filtering
    })

    const results: OrchestratorIssue[] = []
    for (const issue of allIssues) {
      if (results.length >= maxIssues) break

      // Skip sub-issues — coordinators manage their lifecycle, not the backlog scanner
      if (issue.parentId) {
        console.log(
          `[orchestrator] Skipping sub-issue ${issue.identifier} — managed by parent coordinator`
        )
        continue
      }

      // Filter by allowedProjects from .agentfactory/config.yaml
      if (this.allowedProjects && this.allowedProjects.length > 0) {
        if (!issue.projectName || !this.allowedProjects.includes(issue.projectName)) {
          console.warn(
            `[orchestrator] Skipping issue ${issue.identifier} — project "${issue.projectName ?? '(none)'}" is not in allowedProjects: [${this.allowedProjects.join(', ')}]`
          )
          continue
        }
      }

      results.push({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        url: issue.url,
        priority: issue.priority,
        labels: issue.labels,
        teamName: issue.teamName,
        projectName: issue.projectName,
      })
    }

    // Sort by priority (lower number = higher priority, 0 means no priority -> goes last)
    return results.sort((a, b) => {
      const aPriority = a.priority || 5
      const bPriority = b.priority || 5
      return aPriority - bPriority
    })
  }

  /**
   * Validate that a path is a valid git worktree
   */
  private validateWorktree(worktreePath: string): { valid: boolean; reason?: string } {
    if (!existsSync(worktreePath)) {
      return { valid: false, reason: 'Directory does not exist' }
    }

    const gitPath = resolve(worktreePath, '.git')
    if (!existsSync(gitPath)) {
      return { valid: false, reason: 'Missing .git file' }
    }

    // Verify .git is a worktree reference file (not a directory)
    try {
      const stat = statSync(gitPath)
      if (stat.isDirectory()) {
        return { valid: false, reason: '.git is a directory, not a worktree reference' }
      }
      const content = readFileSync(gitPath, 'utf-8')
      if (!content.includes('gitdir:')) {
        return { valid: false, reason: '.git file missing gitdir reference' }
      }
    } catch {
      return { valid: false, reason: 'Cannot read .git file' }
    }

    return { valid: true }
  }

  /**
   * Extract the full error message from an execSync error.
   *
   * Node's execSync throws an Error where .message only contains
   * "Command failed: <command>", but the actual git error output
   * is in .stderr. This helper combines both for reliable pattern matching.
   */
  private getExecSyncErrorMessage(error: unknown): string {
    if (error && typeof error === 'object') {
      const parts: string[] = []
      if ('message' in error && typeof (error as { message: unknown }).message === 'string') {
        parts.push((error as { message: string }).message)
      }
      if ('stderr' in error && typeof (error as { stderr: unknown }).stderr === 'string') {
        parts.push((error as { stderr: string }).stderr)
      }
      if ('stdout' in error && typeof (error as { stdout: unknown }).stdout === 'string') {
        parts.push((error as { stdout: string }).stdout)
      }
      return parts.join('\n')
    }
    return String(error)
  }

  // Branch-conflict detection lives in ../merge-queue/branch-conflict.ts so the
  // merge worker can reuse the same logic. These thin wrappers exist only so
  // existing `this.isBranchConflictError(...)` / `this.parseConflictingWorktreePath(...)`
  // call sites keep working.
  private isBranchConflictError(errorMsg: string): boolean {
    return isBranchConflictErrorShared(errorMsg)
  }

  private parseConflictingWorktreePath(errorMsg: string): string | null {
    return parseConflictingWorktreePathShared(errorMsg)
  }

  /**
   * Check if a path is the main git working tree (not a worktree).
   *
   * The main working tree has a `.git` directory, while worktrees have a
   * `.git` file containing a `gitdir:` pointer. This is the primary safeguard
   * against accidentally destroying the main repository.
   */
  private isMainWorktree(targetPath: string): boolean {
    try {
      const gitPath = resolve(targetPath, '.git')
      if (!existsSync(gitPath)) return false
      const stat = statSync(gitPath)
      // Main working tree has .git as a directory; worktrees have .git as a file
      if (stat.isDirectory()) return true

      // Double-check via `git worktree list --porcelain`
      const output = execSync('git worktree list --porcelain', {
        stdio: 'pipe',
        encoding: 'utf-8',
        cwd: this.gitRoot,
      })
      const mainTreeMatch = output.match(/^worktree (.+)$/m)
      if (mainTreeMatch) {
        const mainTreePath = mainTreeMatch[1]
        return resolve(targetPath) === resolve(mainTreePath)
      }
    } catch {
      // If we can't determine, err on the side of caution - treat as main
      return true
    }
    return false
  }

  /**
   * Check if a path is inside the configured worktrees directory.
   *
   * Only paths within the worktrees directory should ever be candidates for
   * automated cleanup. This prevents the main repo or other directories from
   * being targeted.
   */
  private isInsideWorktreesDir(targetPath: string): boolean {
    const worktreesDir = resolveWorktreePath(this.config.worktreePath, this.gitRoot)
    const normalizedTarget = resolve(targetPath)
    // Must be inside the worktrees directory (not equal to it)
    return normalizedTarget.startsWith(worktreesDir + '/')
  }

  /**
   * Attempt to clean up a stale worktree that is blocking branch creation.
   *
   * During dev\u2192qa\u2192acceptance handoffs, the prior work type's worktree may still
   * exist after its agent has finished (the orchestrator cleans up externally,
   * but there's a race window). This method checks if the blocking worktree's
   * agent is still alive via heartbeat. If not, it removes the stale worktree
   * so the new work type can proceed.
   *
   * SAFETY: This method will NEVER clean up the main working tree. It only
   * operates on paths inside the configured worktrees directory. This prevents
   * catastrophic data loss when a branch is checked out in the main tree
   * (e.g., by a user in their IDE).
   *
   * @returns true if the conflicting worktree was cleaned up
   */
  private tryCleanupConflictingWorktree(conflictPath: string, branchName: string): boolean {
    // SAFETY GUARD 1: Never touch the main working tree
    if (this.isMainWorktree(conflictPath)) {
      console.warn(
        `SAFETY: Refusing to clean up ${conflictPath} \u2014 it is the main working tree. ` +
        `Branch '${branchName}' appears to be checked out in the main repo (e.g., via IDE). ` +
        `The agent will retry or skip this issue.`
      )
      return false
    }

    // SAFETY GUARD 2: Only clean up paths inside worktrees directory
    if (!this.isInsideWorktreesDir(conflictPath)) {
      console.warn(
        `SAFETY: Refusing to clean up ${conflictPath} \u2014 it is not inside the worktrees directory. ` +
        `Only paths inside '${resolveWorktreePath(this.config.worktreePath, this.gitRoot)}' can be auto-cleaned.`
      )
      return false
    }

    if (!existsSync(conflictPath)) {
      // Directory doesn't exist - just prune git's worktree list
      try {
        execSync('git worktree prune', { stdio: 'pipe', encoding: 'utf-8', cwd: this.gitRoot })
        console.log(`Pruned stale worktree reference for branch ${branchName}`)
        return true
      } catch {
        return false
      }
    }

    // SAFETY GUARD 4: Preserved worktrees — save work as patch, then allow cleanup.
    // Preserved worktrees contain uncommitted work from a previous agent session.
    // A diagnostic comment was already posted to the issue when the worktree was
    // preserved. Blocking all future agents on this branch indefinitely causes
    // work stoppages, so we save a patch for manual recovery and allow cleanup.
    const preservedMarker = resolve(conflictPath, '.agent', 'preserved.json')
    if (existsSync(preservedMarker)) {
      console.warn(
        `Preserved worktree detected at ${conflictPath}. ` +
        `Saving incomplete work as patch before cleanup to unblock branch '${branchName}'.`
      )
      try {
        const patchDir = resolve(resolveWorktreePath(this.config.worktreePath, this.gitRoot), '.patches')
        if (!existsSync(patchDir)) {
          mkdirSync(patchDir, { recursive: true })
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        const patchName = `${branchName}-preserved-${timestamp}.patch`
        const patchPath = resolve(patchDir, patchName)

        // Capture tracked changes (staged + unstaged)
        const diff = execSync('git diff HEAD', {
          cwd: conflictPath,
          encoding: 'utf-8',
          timeout: 10000,
        })
        if (diff.trim().length > 0) {
          writeFileSync(patchPath, diff)
          console.log(`Saved preserved worktree patch: ${patchPath}`)
        }

        // Capture untracked files — git diff HEAD misses these entirely.
        // Without this, new files the agent created but never committed are lost.
        const untrackedFiles = execSync(
          'git ls-files --others --exclude-standard',
          { cwd: conflictPath, encoding: 'utf-8', timeout: 10000 }
        ).trim()

        if (untrackedFiles.length > 0) {
          const untrackedPatchName = `${branchName}-preserved-${timestamp}-untracked.patch`
          const untrackedPatchPath = resolve(patchDir, untrackedPatchName)
          // Use git diff --no-index to create a patch for untracked files
          // by diffing /dev/null against each file
          const untrackedDiff = execSync(
            'git diff --no-index /dev/null -- ' +
              untrackedFiles.split('\n').map(f => `"${f}"`).join(' ') +
              ' || true',
            { cwd: conflictPath, encoding: 'utf-8', timeout: 10000, shell: '/bin/bash' }
          )
          if (untrackedDiff.trim().length > 0) {
            writeFileSync(untrackedPatchPath, untrackedDiff)
            console.log(`Saved untracked files patch: ${untrackedPatchPath} (${untrackedFiles.split('\n').length} file(s))`)
          }
        }
      } catch (patchError) {
        console.warn(
          'Failed to save preserved worktree patch:',
          patchError instanceof Error ? patchError.message : String(patchError)
        )
      }
      // Fall through to cleanup below (don't return false)
    }

    // Check if the agent in the conflicting worktree is still alive
    const recoveryInfo = checkRecovery(conflictPath, {
      heartbeatTimeoutMs: getHeartbeatTimeoutFromEnv(),
      maxRecoveryAttempts: 0, // We don't want to recover, just check liveness
    })

    if (recoveryInfo.agentAlive) {
      console.log(
        `Branch ${branchName} is held by a running agent at ${conflictPath} - cannot clean up`
      )
      return false
    }

    // Agent is not alive - check for incomplete work before cleaning up
    const incompleteCheck = checkForIncompleteWork(conflictPath)
    if (incompleteCheck.hasIncompleteWork) {
      // Save a patch before removing so work can be recovered
      try {
        const patchDir = resolve(resolveWorktreePath(this.config.worktreePath, this.gitRoot), '.patches')
        if (!existsSync(patchDir)) {
          mkdirSync(patchDir, { recursive: true })
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        const patchName = `${branchName}-${timestamp}.patch`
        const patchPath = resolve(patchDir, patchName)

        // Capture both staged and unstaged changes
        const diff = execSync('git diff HEAD', {
          cwd: conflictPath,
          encoding: 'utf-8',
          timeout: 10000,
        })
        if (diff.trim().length > 0) {
          writeFileSync(patchPath, diff)
          console.log(`Saved incomplete work patch: ${patchPath}`)
        }

        // Also capture untracked files list
        const untracked = execSync('git ls-files --others --exclude-standard', {
          cwd: conflictPath,
          encoding: 'utf-8',
          timeout: 10000,
        }).trim()
        if (untracked.length > 0) {
          // Create a full diff including untracked files
          const fullDiff = execSync('git diff HEAD -- . && git diff --no-index /dev/null $(git ls-files --others --exclude-standard) 2>/dev/null || true', {
            cwd: conflictPath,
            encoding: 'utf-8',
            timeout: 10000,
            shell: '/bin/bash',
          })
          if (fullDiff.trim().length > 0) {
            writeFileSync(patchPath, fullDiff)
            console.log(`Saved incomplete work patch (including untracked files): ${patchPath}`)
          }
        }
      } catch (patchError) {
        console.warn('Failed to save work patch before cleanup:', patchError instanceof Error ? patchError.message : String(patchError))
      }
    }

    console.log(
      `Cleaning up stale worktree at ${conflictPath} (agent no longer running) ` +
      `to unblock branch ${branchName}`
    )

    try {
      execSync(`git worktree remove "${conflictPath}" --force`, {
        stdio: 'pipe',
        encoding: 'utf-8',
        cwd: this.gitRoot,
      })
      console.log(`Removed stale worktree: ${conflictPath}`)
      return true
    } catch (removeError) {
      const removeMsg = removeError instanceof Error ? removeError.message : String(removeError)
      console.warn(`Failed to remove stale worktree ${conflictPath}:`, removeMsg)

      // SAFETY GUARD 3: If git itself says "main working tree", absolutely stop
      if (removeMsg.includes('is a main working tree')) {
        console.error(
          `SAFETY: git confirmed ${conflictPath} is the main working tree. Aborting cleanup.`
        )
        return false
      }

      // Fallback: rm -rf + prune (safe because guards 1 & 2 already verified
      // this path is inside .worktrees/ and is not the main tree)
      try {
        execSync(`rm -rf "${conflictPath}"`, { stdio: 'pipe', encoding: 'utf-8' })
        execSync('git worktree prune', { stdio: 'pipe', encoding: 'utf-8', cwd: this.gitRoot })
        console.log(`Force-removed stale worktree: ${conflictPath}`)
        return true
      } catch {
        return false
      }
    }
  }

  /**
   * Handle a branch conflict error by attempting to clean up the stale worktree
   * and retrying, or throwing a retriable error for the worker's retry loop.
   */
  private handleBranchConflict(errorMsg: string, branchName: string): void {
    const conflictPath = this.parseConflictingWorktreePath(errorMsg)

    if (conflictPath) {
      const cleaned = this.tryCleanupConflictingWorktree(conflictPath, branchName)
      if (cleaned) {
        // Return without throwing - the caller should retry the git command
        return
      }
    }

    // Could not clean up - throw retriable error for worker's retry loop
    throw new Error(
      `Branch '${branchName}' is already checked out in another worktree. ` +
      `This may indicate another agent is still working on this issue.`
    )
  }

  /**
   * Create a git worktree for an issue with work type suffix
   *
   * @param issueIdentifier - Issue identifier (e.g., "SUP-294")
   * @param workType - Type of work being performed
   * @returns Object containing worktreePath and worktreeIdentifier
   */
  createWorktree(
    issueIdentifier: string,
    workType: AgentWorkType
  ): { worktreePath: string; worktreeIdentifier: string } {
    const worktreeIdentifier = getWorktreeIdentifier(issueIdentifier, workType)
    const worktreePath = resolve(resolveWorktreePath(this.config.worktreePath, this.gitRoot), worktreeIdentifier)
    // Use issue identifier for branch name (shared across work types)
    const branchName = issueIdentifier

    // Ensure parent directory exists
    const parentDir = resolveWorktreePath(this.config.worktreePath, this.gitRoot)
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true })
    }

    // Prune any stale worktrees first (handles deleted directories)
    try {
      execSync('git worktree prune', { stdio: 'pipe', encoding: 'utf-8', cwd: this.gitRoot })
    } catch {
      // Ignore prune errors
    }

    // Check if worktree already exists AND is valid
    // A valid worktree has a .git file (not directory) pointing to parent repo with gitdir reference
    if (existsSync(worktreePath)) {
      const validation = this.validateWorktree(worktreePath)
      if (validation.valid) {
        console.log(`Worktree already exists: ${worktreePath}`)
        return { worktreePath, worktreeIdentifier }
      }

      // Invalid/incomplete worktree - must clean up
      console.log(`Removing invalid worktree: ${worktreePath} (${validation.reason})`)
      try {
        rmSync(worktreePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 })
      } catch (cleanupError) {
        throw new Error(
          `Failed to clean up invalid worktree at ${worktreePath}: ` +
          `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
        )
      }

      // Verify cleanup worked
      if (existsSync(worktreePath)) {
        throw new Error(`Failed to remove invalid worktree directory at ${worktreePath}`)
      }
    }

    console.log(`Creating worktree: ${worktreePath} (branch: ${branchName})`)

    // Fetch latest main from remote so worktrees start with current deps/lockfiles.
    // Non-fatal: offline/CI environments may not have network access.
    let hasRemoteMain = false
    try {
      execSync('git fetch origin main', {
        stdio: 'pipe',
        encoding: 'utf-8',
        cwd: this.gitRoot,
        timeout: 30_000,
      })
      hasRemoteMain = true
    } catch {
      console.warn('Failed to fetch origin/main — proceeding with local main')
    }

    // Base new feature branches on origin/main (latest remote) when available,
    // falling back to local main for offline environments.
    const baseBranch = hasRemoteMain ? 'origin/main' : 'main'

    // Non-committing work types use detached HEAD to avoid creating stale branches.
    // Research/BC only read the codebase and never commit. Creating named branches
    // for them pollutes the branch namespace and causes stale-base issues when
    // development later reuses the branch without rebasing.
    const NON_COMMITTING_WORK_TYPES = new Set([
      'research', 'backlog-creation', 'refinement', 'refinement-coordination', 'security',
    ])

    if (NON_COMMITTING_WORK_TYPES.has(workType)) {
      execSync(`git worktree add --detach "${worktreePath}" ${baseBranch}`, {
        stdio: 'pipe',
        encoding: 'utf-8',
        cwd: this.gitRoot,
      })
      console.log(`Created detached worktree for ${workType}: ${worktreePath}`)
      return { worktreePath, worktreeIdentifier }
    }

    // Try to create worktree with new branch
    // Uses a two-attempt strategy: if a branch conflict is detected and the
    // conflicting worktree's agent is no longer alive, clean it up and retry once.
    const MAX_CONFLICT_RETRIES = 1
    let conflictRetries = 0

    const attemptCreateWorktree = (): void => {
      try {
        execSync(`git worktree add "${worktreePath}" -b ${branchName} ${baseBranch}`, {
          stdio: 'pipe',
          encoding: 'utf-8',
          cwd: this.gitRoot,
        })
      } catch (error) {
        // Branch might already exist or be checked out elsewhere
        // Note: execSync errors have the git message in .stderr, not just .message
        const errorMsg = this.getExecSyncErrorMessage(error)

        // If branch is in use by another worktree, try to clean up the stale worktree
        if (this.isBranchConflictError(errorMsg)) {
          if (conflictRetries < MAX_CONFLICT_RETRIES) {
            conflictRetries++
            // handleBranchConflict returns if cleanup succeeded, throws if not
            this.handleBranchConflict(errorMsg, branchName)
            // Cleanup succeeded - retry
            console.log(`Retrying worktree creation after cleaning up stale worktree`)
            attemptCreateWorktree()
            return
          }
          throw new Error(
            `Branch '${branchName}' is already checked out in another worktree. ` +
            `This may indicate another agent is still working on this issue.`
          )
        }

        if (errorMsg.includes('already exists')) {
          // Branch exists, try without -b flag
          try {
            execSync(`git worktree add "${worktreePath}" ${branchName}`, {
              stdio: 'pipe',
              encoding: 'utf-8',
              cwd: this.gitRoot,
            })

            // If this is a code-producing work type and the branch has no unique
            // commits (e.g., created by a prior research/BC phase that used named
            // branches before the detached HEAD fix), reset to current origin/main
            // to prevent working on a stale codebase.
            const CODE_PRODUCING_TYPES = new Set([
              'development', 'inflight',
            ])
            if (CODE_PRODUCING_TYPES.has(workType)) {
              try {
                const aheadCount = execSync(
                  `git -C "${worktreePath}" rev-list --count ${baseBranch}..HEAD`,
                  { stdio: 'pipe', encoding: 'utf-8' }
                ).trim()
                if (aheadCount === '0') {
                  execSync(`git -C "${worktreePath}" reset --hard ${baseBranch}`, {
                    stdio: 'pipe', encoding: 'utf-8',
                  })
                  console.log(`Reset stale branch ${branchName} to ${baseBranch} (was 0 commits ahead)`)
                }
              } catch {
                console.warn(`Failed to check/reset branch freshness for ${branchName}`)
              }
            }
          } catch (innerError) {
            const innerMsg = this.getExecSyncErrorMessage(innerError)

            // If branch is in use by another worktree, try to clean up
            if (this.isBranchConflictError(innerMsg)) {
              if (conflictRetries < MAX_CONFLICT_RETRIES) {
                conflictRetries++
                this.handleBranchConflict(innerMsg, branchName)
                console.log(`Retrying worktree creation after cleaning up stale worktree`)
                attemptCreateWorktree()
                return
              }
              throw new Error(
                `Branch '${branchName}' is already checked out in another worktree. ` +
                `This may indicate another agent is still working on this issue.`
              )
            }

            // For any other error, propagate it
            throw innerError
          }
        } else {
          throw error
        }
      }
    }

    attemptCreateWorktree()

    // Validate worktree was created correctly
    const validation = this.validateWorktree(worktreePath)
    if (!validation.valid) {
      // Clean up partial state
      try {
        if (existsSync(worktreePath)) {
          execSync(`rm -rf "${worktreePath}"`, { stdio: 'pipe', encoding: 'utf-8' })
        }
        execSync('git worktree prune', { stdio: 'pipe', encoding: 'utf-8', cwd: this.gitRoot })
      } catch {
        // Ignore cleanup errors
      }

      throw new Error(
        `Failed to create valid worktree at ${worktreePath}: ${validation.reason}. ` +
        `This may indicate a race condition with another agent.`
      )
    }

    console.log(`Worktree created successfully: ${worktreePath}`)

    // Clear stale stashes. Git stashes are repo-scoped (stored in refs/stash in the
    // shared git directory), so stashes from prior sessions in ANY worktree are visible
    // here. If an agent runs `git stash pop`, it may apply a stale stash from an
    // unrelated session, causing conflicts and potential work loss.
    try {
      const stashList = execSync('git stash list', {
        cwd: worktreePath,
        encoding: 'utf-8',
        timeout: 5000,
      }).trim()
      if (stashList.length > 0) {
        const stashCount = stashList.split('\n').length
        execSync('git stash clear', {
          cwd: worktreePath,
          encoding: 'utf-8',
          timeout: 5000,
        })
        console.log(`Cleared ${stashCount} stale stash(es) to prevent cross-session contamination`)
      }
    } catch {
      // Non-fatal — stash clearing is defensive
    }

    // Initialize .agent/ directory for state persistence
    try {
      initializeAgentDir(worktreePath)
    } catch (initError) {
      // Log but don't fail - state persistence is optional
      console.warn(`Failed to initialize .agent/ directory: ${initError instanceof Error ? initError.message : String(initError)}`)
    }

    // Write helper scripts into .agent/ for agent use
    this.writeWorktreeHelpers(worktreePath)

    // Configure mergiraf merge driver if enabled
    this.configureMergiraf(worktreePath)

    // Bootstrap lockfile and package.json from origin/main
    this.bootstrapWorktreeDeps(worktreePath)

    // Capture quality baseline for delta checking (runs test/typecheck on main)
    if (this.isQualityBaselineEnabled()) {
      try {
        const qualityConfig = this.buildQualityConfig()
        const baseline = captureQualityBaseline(worktreePath, qualityConfig)
        saveBaseline(worktreePath, baseline)
        console.log(`Quality baseline captured: ${baseline.tests.total} tests, ${baseline.typecheck.errorCount} type errors, ${baseline.lint.errorCount} lint errors`)
      } catch (baselineError) {
        // Log but don't fail worktree creation — quality gate is advisory
        console.warn(`Failed to capture quality baseline: ${baselineError instanceof Error ? baselineError.message : String(baselineError)}`)
      }
    }

    return { worktreePath, worktreeIdentifier }
  }

  /**
   * Clean up a git worktree
   *
   * @param worktreeIdentifier - Worktree identifier with work type suffix (e.g., "SUP-294-QA")
   */
  removeWorktree(worktreeIdentifier: string, deleteBranchName?: string): void {
    const worktreePath = resolve(resolveWorktreePath(this.config.worktreePath, this.gitRoot), worktreeIdentifier)

    if (existsSync(worktreePath)) {
      try {
        execSync(`git worktree remove "${worktreePath}" --force`, {
          stdio: 'pipe',
          encoding: 'utf-8',
          cwd: this.gitRoot,
        })
      } catch (error) {
        console.warn(`Failed to remove worktree via git, trying fallback:`, error)
        try {
          execSync(`rm -rf "${worktreePath}"`, { stdio: 'pipe', encoding: 'utf-8' })
          execSync('git worktree prune', { stdio: 'pipe', encoding: 'utf-8', cwd: this.gitRoot })
        } catch (fallbackError) {
          console.warn(`Fallback worktree removal also failed:`, fallbackError)
        }
      }
    } else {
      // Directory gone but git may still track it
      try {
        execSync('git worktree prune', { stdio: 'pipe', encoding: 'utf-8', cwd: this.gitRoot })
      } catch {
        // Ignore
      }
    }

    // Clean up leftover directory shells (e.g., dirs with only .agent/ remaining
    // after git worktree remove succeeded but the directory wasn't fully deleted)
    if (existsSync(worktreePath)) {
      try {
        const entries = readdirSync(worktreePath).filter(e => e !== '.agent')
        if (entries.length === 0) {
          rmSync(worktreePath, { recursive: true, force: true })
        }
      } catch {
        // Best-effort cleanup
      }
    }

    // Delete the branch for non-code-producing work types to prevent stale branches
    // from polluting the namespace and being accidentally reused by future work types.
    //
    // Safety: skip deletion if the branch has a remote upstream — that means it
    // carries development work (from a prior code-producing session) that QA /
    // acceptance / refinement are validating. Deleting the local ref doesn't
    // lose data (remote stays), but forces future agents to re-fetch and
    // breaks the invariant that "branch X exists locally" maps to "there's
    // ongoing work on X." The original stale-branch-cleanup intent was for
    // ephemeral branches created during exploratory work types that never
    // push — those have no upstream and are still cleaned up here.
    if (deleteBranchName) {
      try {
        // A non-zero exit from `git rev-parse --abbrev-ref X@{upstream}` means
        // no upstream is set — safe to delete. A zero exit means upstream exists
        // — preserve the branch.
        let hasUpstream = false
        try {
          execSync(`git rev-parse --abbrev-ref ${deleteBranchName}@{upstream}`, {
            stdio: 'pipe',
            encoding: 'utf-8',
            cwd: this.gitRoot,
          })
          hasUpstream = true
        } catch {
          hasUpstream = false
        }

        if (hasUpstream) {
          console.log(`Preserved branch ${deleteBranchName} (has remote upstream — dev work may still be in progress)`)
        } else {
          execSync(`git branch -D ${deleteBranchName}`, {
            stdio: 'pipe',
            encoding: 'utf-8',
            cwd: this.gitRoot,
          })
          console.log(`Deleted branch ${deleteBranchName} (non-code-producing work type, no upstream)`)
        }
      } catch {
        // Branch may not exist (detached HEAD) or may be in use by another worktree — ignore
      }
    }
  }

  /**
   * Write helper scripts into the worktree's .agent/ directory.
   *
   * Currently writes:
   * - .agent/add-dep.sh: Safely adds a new dependency by removing symlinked
   *   node_modules first, then running `pnpm add` with the guard bypass.
   */
  private writeWorktreeHelpers(worktreePath: string): void {
    const pm = (this.packageManager ?? 'pnpm') as PackageManager
    // Skip helper scripts for non-Node projects
    if (pm === 'none') return

    const addCmd = getAddCommand(pm) ?? `${pm} add`

    const agentDir = resolve(worktreePath, '.agent')
    const scriptPath = resolve(agentDir, 'add-dep.sh')

    const script = `#!/bin/bash
# Safe dependency addition for agents in worktrees.
# Removes symlinked node_modules, then runs ${addCmd} with guard bypass.
# Usage: bash .agent/add-dep.sh <package> [--filter <workspace>]
set -e
if [ $# -eq 0 ]; then
  echo "Usage: bash .agent/add-dep.sh <package> [--filter <workspace>]"
  exit 1
fi
echo "Cleaning symlinked node_modules..."
rm -rf node_modules
for subdir in apps packages; do
  [ -d "$subdir" ] && find "$subdir" -maxdepth 2 -name node_modules -type d -exec rm -rf {} + 2>/dev/null || true
done
echo "Installing: ${addCmd} $@"
ORCHESTRATOR_INSTALL=1 exec ${addCmd} "$@"
`

    try {
      if (!existsSync(agentDir)) {
        mkdirSync(agentDir, { recursive: true })
      }
      writeFileSync(scriptPath, script, { mode: 0o755 })
    } catch (error) {
      // Log but don't fail — the helper is optional
      console.warn(
        `Failed to write worktree helper scripts: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /**
   * Bootstrap worktree dependencies from origin/main.
   * Ensures the lockfile and root package.json in the worktree match the latest
   * remote main, not the (potentially stale) local main the worktree branched from.
   * Framework-neutral: uses getLockFileName() to resolve the correct lockfile.
   * No-op for packageManager 'none'.
   */
  private bootstrapWorktreeDeps(worktreePath: string): void {
    const pm = (this.packageManager ?? 'pnpm') as PackageManager
    if (pm === 'none') return

    const lockFile = getLockFileName(pm)
    if (!lockFile) return

    // Copy lockfile from origin/main into the worktree
    try {
      const originLockContent = execSync(`git show origin/main:${lockFile}`, {
        encoding: 'utf-8',
        cwd: this.gitRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10_000,
      })
      writeFileSync(resolve(worktreePath, lockFile), originLockContent)
    } catch {
      // Lockfile may not exist on origin/main (new repo) or fetch failed — skip
    }

    // Copy root package.json from origin/main
    try {
      const originPkgContent = execSync('git show origin/main:package.json', {
        encoding: 'utf-8',
        cwd: this.gitRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10_000,
      })
      writeFileSync(resolve(worktreePath, 'package.json'), originPkgContent)
    } catch {
      // Skip if not found
    }
  }

  /**
   * Configure mergiraf as the git merge driver in a worktree.
   * Uses worktree-local git config so mergiraf only runs in agent worktrees.
   * Falls back silently to default git merge if mergiraf is not installed.
   */
  private configureMergiraf(worktreePath: string): void {
    // Check if mergiraf is disabled via config
    if (this.repoConfig?.mergeDriver === 'default') {
      return
    }

    try {
      // Check if mergiraf binary is available
      execSync('which mergiraf', { stdio: 'pipe', encoding: 'utf-8' })
    } catch {
      // mergiraf not installed — fall back to default merge silently
      console.log('mergiraf not found on PATH, using default git merge driver')
      return
    }

    try {
      // Enable worktree-local config extension
      execSync('git config extensions.worktreeConfig true', {
        stdio: 'pipe',
        encoding: 'utf-8',
        cwd: worktreePath,
      })

      // Register mergiraf merge driver in worktree-local config
      execSync('git config --worktree merge.mergiraf.name "mergiraf"', {
        stdio: 'pipe',
        encoding: 'utf-8',
        cwd: worktreePath,
      })
      execSync(
        'git config --worktree merge.mergiraf.driver "mergiraf merge --git %O %A %B -s %S -x %X -y %Y -p %P"',
        { stdio: 'pipe', encoding: 'utf-8', cwd: worktreePath },
      )

      // Write .gitattributes in worktree root (not repo root)
      const gitattributesPath = resolve(worktreePath, '.gitattributes')
      if (!existsSync(gitattributesPath)) {
        const content = [
          '# AST-aware merge driver (mergiraf) — worktree-local',
          '*.ts merge=mergiraf',
          '*.tsx merge=mergiraf',
          '*.js merge=mergiraf',
          '*.jsx merge=mergiraf',
          '*.json merge=mergiraf',
          '*.yaml merge=mergiraf',
          '*.yml merge=mergiraf',
          '*.py merge=mergiraf',
          '*.go merge=mergiraf',
          '*.rs merge=mergiraf',
          '*.java merge=mergiraf',
          '*.css merge=mergiraf',
          '*.html merge=mergiraf',
          '',
          '# Lock files — keep ours and regenerate',
          'pnpm-lock.yaml merge=ours',
          'package-lock.json merge=ours',
          'yarn.lock merge=ours',
          '',
        ].join('\n')
        writeFileSync(gitattributesPath, content, 'utf-8')
      }

      console.log(`mergiraf configured as merge driver in ${worktreePath}`)
    } catch (error) {
      // Log warning but don't fail — merge driver is non-critical
      console.warn(
        `Failed to configure mergiraf in worktree: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /**
   * Check if quality baseline capture is enabled via repository config.
   */
  private isQualityBaselineEnabled(): boolean {
    const quality = (this.repoConfig as Record<string, unknown> | null)?.quality as
      | { baselineEnabled?: boolean }
      | undefined
    return quality?.baselineEnabled ?? false
  }

  /**
   * Build quality config from orchestrator settings.
   */
  private buildQualityConfig(): QualityConfig {
    return {
      testCommand: this.testCommand,
      validateCommand: this.validateCommand,
      packageManager: this.packageManager ?? 'pnpm',
      timeoutMs: 120_000,
    }
  }

  /**
   * Load quality baseline from a worktree and convert to TemplateContext shape.
   */
  private loadQualityBaselineForContext(worktreePath?: string): {
    tests: { total: number; passed: number; failed: number }
    typecheckErrors: number
    lintErrors: number
  } | undefined {
    if (!worktreePath || !this.isQualityBaselineEnabled()) return undefined
    try {
      const baseline = loadBaseline(worktreePath)
      if (!baseline) return undefined
      return {
        tests: {
          total: baseline.tests.total,
          passed: baseline.tests.passed,
          failed: baseline.tests.failed,
        },
        typecheckErrors: baseline.typecheck.errorCount,
        lintErrors: baseline.lint.errorCount,
      }
    } catch {
      return undefined
    }
  }

  /**
   * Link dependencies from the main repo into a worktree via symlinks.
   *
   * Creates a REAL node_modules directory in the worktree and symlinks each
   * entry (packages, .pnpm, .bin) individually. This prevents pnpm from
   * resolving through a directory-level symlink and corrupting the main
   * repo's node_modules when an agent accidentally runs `pnpm install`.
   *
   * For non-Node repos (packageManager 'none' or no node_modules), this is a no-op.
   *
   * Falls back to install via the configured package manager if symlinking fails.
   */
  linkDependencies(worktreePath: string, identifier: string): void {
    const pm = (this.packageManager ?? 'pnpm') as PackageManager
    if (pm === 'none') return

    // Use the main repo root (set at construction from process.cwd()) for node_modules.
    // Worktrees are sibling directories that don't contain node_modules.
    const repoRoot = this.gitRoot ?? resolveMainRepoRoot(worktreePath) ?? findRepoRoot(worktreePath)
    if (!repoRoot) {
      console.warn(`[${identifier}] Could not find repo root, skipping dependency linking`)
      return
    }

    const mainNodeModules = resolve(repoRoot, 'node_modules')
    if (!existsSync(mainNodeModules)) {
      // Not a Node.js project, or deps not installed in main repo — nothing to do
      console.log(`[${identifier}] No node_modules in main repo, skipping dependency linking`)
      return
    }

    console.log(`[${identifier}] Linking dependencies from main repo...`)
    try {
      // Link root node_modules — create a real directory with symlinked contents
      // so pnpm can't follow a top-level symlink to corrupt the main repo
      const destRoot = resolve(worktreePath, 'node_modules')
      this.linkNodeModulesContents(mainNodeModules, destRoot, identifier)

      // Link per-workspace node_modules (apps/*, packages/*)
      let skipped = 0
      for (const subdir of ['apps', 'packages']) {
        const mainSubdir = resolve(repoRoot, subdir)
        if (!existsSync(mainSubdir)) continue

        for (const entry of readdirSync(mainSubdir)) {
          const src = resolve(mainSubdir, entry, 'node_modules')
          const destParent = resolve(worktreePath, subdir, entry)
          const dest = resolve(destParent, 'node_modules')

          if (!existsSync(src)) continue

          // Skip entries where the app/package doesn't exist on this branch
          if (!existsSync(destParent)) {
            skipped++
            continue
          }

          this.linkNodeModulesContents(src, dest, identifier)
        }
      }

      // Fix 5: Also scan worktree for workspaces that exist on the branch
      // but not in the main repo's directory listing (e.g., newly added workspaces)
      for (const subdir of ['apps', 'packages']) {
        const wtSubdir = resolve(worktreePath, subdir)
        if (!existsSync(wtSubdir)) continue

        for (const entry of readdirSync(wtSubdir)) {
          const src = resolve(repoRoot, subdir, entry, 'node_modules')
          const dest = resolve(wtSubdir, entry, 'node_modules')

          if (!existsSync(src)) continue  // No source deps to link
          if (existsSync(dest)) continue  // Already linked above

          this.linkNodeModulesContents(src, dest, identifier)
        }
      }

      if (skipped > 0) {
        console.log(
          `[${identifier}] Dependencies linked successfully (${skipped} workspace(s) skipped — not on this branch)`
        )
      } else {
        console.log(`[${identifier}] Dependencies linked successfully`)
      }

      // Verify critical symlinks are intact; if not, remove and retry once
      if (!this.verifyDependencyLinks(worktreePath, identifier)) {
        console.warn(`[${identifier}] Dependency verification failed — removing and re-linking`)
        this.removeWorktreeNodeModules(worktreePath)
        const retryDest = resolve(worktreePath, 'node_modules')
        this.linkNodeModulesContents(mainNodeModules, retryDest, identifier)

        if (!this.verifyDependencyLinks(worktreePath, identifier)) {
          console.warn(`[${identifier}] Verification failed after retry — falling back to install`)
          this.installDependencies(worktreePath, identifier)
        }
      }
    } catch (error) {
      console.warn(
        `[${identifier}] Symlink failed, falling back to install:`,
        error instanceof Error ? error.message : String(error)
      )
      this.installDependencies(worktreePath, identifier)
    }
  }

  /**
   * Verify that critical dependency symlinks are intact and resolvable.
   * Returns true if verification passes, false if re-linking is needed.
   */
  private verifyDependencyLinks(worktreePath: string, identifier: string): boolean {
    const destRoot = resolve(worktreePath, 'node_modules')
    if (!existsSync(destRoot)) return false

    // Sentinel packages that should always be present in a Node.js project
    const sentinels = ['typescript']

    // Also check for .modules.yaml (pnpm store metadata) if using pnpm
    if ((this.packageManager ?? 'pnpm') === 'pnpm') {
      const repoRoot = findRepoRoot(worktreePath)
      if (repoRoot) {
        const pnpmMeta = resolve(repoRoot, 'node_modules', '.modules.yaml')
        if (existsSync(pnpmMeta)) {
          sentinels.push('.modules.yaml')
        }
      }
    }

    for (const pkg of sentinels) {
      const pkgPath = resolve(destRoot, pkg)
      if (!existsSync(pkgPath)) {
        console.warn(`[${identifier}] Verification: missing ${pkg}`)
        return false
      }
      // Follow the symlink — throws if target was deleted from main repo
      try {
        statSync(pkgPath)
      } catch {
        console.warn(`[${identifier}] Verification: broken symlink for ${pkg}`)
        return false
      }
    }
    return true
  }

  /**
   * Remove all node_modules directories from a worktree (root + per-workspace).
   */
  private removeWorktreeNodeModules(worktreePath: string): void {
    const destRoot = resolve(worktreePath, 'node_modules')
    try {
      if (existsSync(destRoot)) {
        rmSync(destRoot, { recursive: true, force: true })
      }
    } catch {
      // Ignore cleanup errors
    }

    for (const subdir of ['apps', 'packages']) {
      const subPath = resolve(worktreePath, subdir)
      if (!existsSync(subPath)) continue
      try {
        for (const entry of readdirSync(subPath)) {
          const nm = resolve(subPath, entry, 'node_modules')
          if (existsSync(nm)) {
            rmSync(nm, { recursive: true, force: true })
          }
        }
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Create or update a symlink atomically, handling EEXIST races.
   *
   * If the destination already exists and points to the correct target, this is a no-op.
   * If it points elsewhere or isn't a symlink, it's replaced.
   */
  private safeSymlink(src: string, dest: string): void {
    try {
      symlinkSync(src, dest)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        // Verify existing symlink points to correct target
        try {
          const existing = readlinkSync(dest)
          if (resolve(existing) === resolve(src)) return // Already correct
        } catch {
          // Not a symlink or can't read — remove and retry
        }
        unlinkSync(dest)
        symlinkSync(src, dest)
      } else {
        throw error
      }
    }
  }

  /**
   * Create a real node_modules directory and symlink each entry from the source.
   *
   * Instead of symlinking the entire node_modules directory (which lets pnpm
   * resolve through the symlink and corrupt the original), we create a real
   * directory and symlink each entry individually. If pnpm "recreates" this
   * directory, it only destroys the worktree's symlinks — not the originals.
   *
   * Supports incremental sync: if the destination already exists, only missing
   * or stale entries are updated (safe for concurrent agents and phase reuse).
   */
  private linkNodeModulesContents(
    srcNodeModules: string,
    destNodeModules: string,
    identifier: string
  ): void {
    mkdirSync(destNodeModules, { recursive: true })

    for (const entry of readdirSync(srcNodeModules)) {
      const srcEntry = resolve(srcNodeModules, entry)
      const destEntry = resolve(destNodeModules, entry)

      // For scoped packages (@org/), create the scope dir and symlink contents
      if (entry.startsWith('@')) {
        const stat = lstatSync(srcEntry)
        if (stat.isDirectory()) {
          mkdirSync(destEntry, { recursive: true })
          for (const scopedEntry of readdirSync(srcEntry)) {
            const srcScoped = resolve(srcEntry, scopedEntry)
            const destScoped = resolve(destEntry, scopedEntry)
            this.safeSymlink(srcScoped, destScoped)
          }
          continue
        }
      }

      this.safeSymlink(srcEntry, destEntry)
    }
  }

  /**
   * Fallback: install dependencies via the configured package manager.
   * Only called when symlinking fails.
   */
  private installDependencies(worktreePath: string, identifier: string): void {
    const pm = (this.packageManager ?? 'pnpm') as PackageManager
    if (pm === 'none') return

    const frozenCmd = getInstallCommand(pm, true)
    const baseCmd = getInstallCommand(pm, false)
    if (!baseCmd) return

    console.log(`[${identifier}] Installing dependencies via ${pm}...`)

    // Remove any node_modules from a partial linkDependencies attempt
    this.removeWorktreeNodeModules(worktreePath)

    // Set ORCHESTRATOR_INSTALL=1 to bypass the preinstall guard script
    // that blocks installs in worktrees (to prevent symlink corruption).
    const installEnv = { ...process.env, ORCHESTRATOR_INSTALL: '1' }

    try {
      execSync(`${frozenCmd ?? baseCmd} 2>&1`, {
        cwd: worktreePath,
        stdio: 'pipe',
        encoding: 'utf-8',
        timeout: 120_000,
        env: installEnv,
      })
      console.log(`[${identifier}] Dependencies installed successfully`)
    } catch {
      try {
        execSync(`${baseCmd} 2>&1`, {
          cwd: worktreePath,
          stdio: 'pipe',
          encoding: 'utf-8',
          timeout: 120_000,
          env: installEnv,
        })
        console.log(`[${identifier}] Dependencies installed (without frozen lockfile)`)
      } catch (retryError) {
        console.warn(
          `[${identifier}] Install failed (agent may retry):`,
          retryError instanceof Error ? retryError.message : String(retryError)
        )
      }
    }
  }

  /**
   * Sync dependencies between worktree and main repo before linking.
   *
   * When a development agent adds new packages on a branch, the lockfile in the
   * worktree diverges from the main repo. This method detects lockfile drift,
   * updates the main repo's node_modules, then re-links into the worktree.
   */
  syncDependencies(worktreePath: string, identifier: string): void {
    const pm = (this.packageManager ?? 'pnpm') as PackageManager
    if (pm === 'none') return

    const repoRoot = this.gitRoot ?? resolveMainRepoRoot(worktreePath) ?? findRepoRoot(worktreePath)
    if (!repoRoot) {
      this.linkDependencies(worktreePath, identifier)
      return
    }

    const lockFileName = getLockFileName(pm)
    if (!lockFileName) {
      this.linkDependencies(worktreePath, identifier)
      return
    }

    const worktreeLock = resolve(worktreePath, lockFileName)
    const mainLock = resolve(repoRoot, lockFileName)

    // Detect behind-drift: worktree lockfile is stale vs origin/main
    // (main was bumped after this worktree was created or last synced)
    let behindDrift = false
    try {
      const originLock = execSync(`git show origin/main:${lockFileName}`, {
        encoding: 'utf-8',
        cwd: this.gitRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10_000,
      })
      if (existsSync(worktreeLock)) {
        const wtContent = readFileSync(worktreeLock, 'utf-8')
        if (wtContent !== originLock) {
          console.log(`[${identifier}] Lockfile behind origin/main — updating worktree`)
          writeFileSync(worktreeLock, originLock)
          behindDrift = true
        }
      }
    } catch {
      // git show failed (no remote, no lockfile on main) — skip behind-drift check
    }

    // Detect ahead-drift: worktree lockfile differs from main repo
    // (agent added/changed dependencies on the branch)
    let aheadDrift = false
    if (existsSync(worktreeLock) && existsSync(mainLock)) {
      try {
        const wtContent = readFileSync(worktreeLock, 'utf-8')
        const mainContent = readFileSync(mainLock, 'utf-8')
        aheadDrift = wtContent !== mainContent
      } catch {
        // If we can't read either file, proceed without sync
      }
    }

    if (aheadDrift || behindDrift) {
      const driftType = behindDrift && aheadDrift ? 'bidirectional' : behindDrift ? 'behind-main' : 'ahead-of-main'
      console.log(`[${identifier}] Lockfile drift detected (${driftType}) — syncing main repo dependencies`)
      try {
        // Copy the worktree's lockfile to the main repo so install picks up new deps
        copyFileSync(worktreeLock, mainLock)

        // Also copy any changed package.json files from worktree workspaces to main
        for (const subdir of ['', 'apps', 'packages']) {
          const wtDir = subdir ? resolve(worktreePath, subdir) : worktreePath
          const mainDir = subdir ? resolve(repoRoot, subdir) : repoRoot

          if (subdir && !existsSync(wtDir)) continue

          const entries = subdir ? readdirSync(wtDir) : ['']
          for (const entry of entries) {
            const wtPkg = resolve(wtDir, entry, 'package.json')
            const mainPkg = resolve(mainDir, entry, 'package.json')
            if (!existsSync(wtPkg)) continue
            try {
              const wtPkgContent = readFileSync(wtPkg, 'utf-8')
              const mainPkgContent = existsSync(mainPkg) ? readFileSync(mainPkg, 'utf-8') : ''
              if (wtPkgContent !== mainPkgContent) {
                copyFileSync(wtPkg, mainPkg)
              }
            } catch {
              // Skip files we can't read
            }
          }
        }

        // Install in the main repo (not the worktree) to update node_modules
        const installCmd = getInstallCommand(pm, true) ?? `${pm} install`
        const installEnv = { ...process.env, ORCHESTRATOR_INSTALL: '1' }
        execSync(`${installCmd} 2>&1`, {
          cwd: repoRoot,
          stdio: 'pipe',
          encoding: 'utf-8',
          timeout: 120_000,
          env: installEnv,
        })
        console.log(`[${identifier}] Main repo dependencies synced`)

        // Remove stale worktree node_modules so linkDependencies creates fresh symlinks
        this.removeWorktreeNodeModules(worktreePath)
      } catch (error) {
        console.warn(
          `[${identifier}] Dependency sync failed, proceeding with existing state:`,
          error instanceof Error ? error.message : String(error)
        )
      }
    }

    this.linkDependencies(worktreePath, identifier)
  }

  /**
   * @deprecated Use linkDependencies() instead. This now delegates to linkDependencies.
   */
  preInstallDependencies(worktreePath: string, identifier: string): void {
    this.linkDependencies(worktreePath, identifier)
  }

  /**
   * Resolve the provider for a specific spawn, using the full priority cascade.
   * Returns a cached provider instance (creating one if needed) and the resolved name.
   */
  /**
   * Build base instructions for providers that need persistent system instructions.
   *
   * Uses shared instruction builders from agent-instructions.ts so all providers
   * (Claude, Codex, etc.) receive the same instruction content: autonomy preamble,
   * tool usage guidance, code editing philosophy, safety rules, git workflow,
   * code intelligence instructions, Linear tool instructions, and project instructions.
   */
  private buildBaseInstructions(options: {
    workType?: AgentWorkType
    worktreePath?: string
    hasCodeIntelligence?: boolean
    codeIntelEnforced?: boolean
    useToolPlugins?: boolean
  }): string {
    // Resolve systemPrompt append from RepositoryConfig
    const appendSections: string[] = []
    if (this.repoConfig?.systemPrompt?.append) {
      appendSections.push(this.repoConfig.systemPrompt.append.trim())
    }
    if (options.workType && this.repoConfig?.systemPrompt?.byWorkType?.[options.workType]) {
      appendSections.push(this.repoConfig.systemPrompt.byWorkType[options.workType].trim())
    }
    const systemPromptAppend = appendSections.length > 0 ? appendSections.join('\n\n') : undefined

    return buildBaseInstructionsFromShared(buildSafetyInstructions(), {
      worktreePath: options.worktreePath,
      hasCodeIntelligence: options.hasCodeIntelligence,
      codeIntelEnforced: options.codeIntelEnforced,
      useToolPlugins: options.useToolPlugins,
      linearCli: this.linearCli,
      systemPromptAppend,
    })
  }

  /**
   * Build structured permission config from template permissions.
   *
   * Translates abstract template `tools.allow` / `tools.disallow` into
   * structured regex patterns for providers with `needsPermissionConfig: true`.
   */
  private buildPermissionConfig(workType?: AgentWorkType): import('../templates/adapters.js').CodexPermissionConfig | undefined {
    if (!this.templateRegistry || !workType) return undefined

    const { allow, disallow } = this.templateRegistry.getRawToolPermissions(workType)
    if (allow.length === 0 && disallow.length === 0) return undefined

    const adapter = new CodexToolPermissionAdapter()
    return adapter.buildPermissionConfig(allow, disallow)
  }

  private resolveProviderForSpawn(context: {
    workType?: string
    projectName?: string
    labels?: string[]
    mentionContext?: string
    dispatchModel?: string
    dispatchSubAgentModel?: string
  }): { provider: AgentProvider; providerName: AgentProviderName; source: string; resolvedProfile?: ResolvedProfile } {
    // Profile-based path: resolve full profile (provider + model + effort + config)
    if (this.profiles && this.dispatchConfig) {
      const resolved = resolveProfileForSpawn({
        profiles: this.profiles,
        dispatch: this.dispatchConfig,
        workType: context.workType,
        project: context.projectName,
        labels: context.labels,
        mentionContext: context.mentionContext,
        dispatchModel: context.dispatchModel,
        dispatchSubAgentModel: context.dispatchSubAgentModel,
      })

      let provider = this.providerCache.get(resolved.provider)
      if (!provider) {
        provider = createProvider(resolved.provider)
        this.providerCache.set(resolved.provider, provider)
      }

      return { provider, providerName: resolved.provider, source: resolved.source, resolvedProfile: resolved }
    }

    // Legacy path: flat providers config
    const { name, source } = resolveProviderWithSource({
      project: context.projectName,
      workType: context.workType,
      labels: context.labels,
      mentionContext: context.mentionContext,
      configProviders: this.configProviders,
    })

    // Return cached instance or create a new one
    let provider = this.providerCache.get(name)
    if (!provider) {
      provider = createProvider(name)
      this.providerCache.set(name, provider)
    }

    return { provider, providerName: name, source }
  }

  /**
   * Spawn a Claude agent for a specific issue using the Agent SDK
   */
  spawnAgent(options: SpawnAgentOptions): AgentProcess {
    const {
      issueId,
      identifier,
      worktreeIdentifier,
      sessionId,
      worktreePath,
      streamActivities,
      workType = 'development',
      prompt: customPrompt,
      teamName,
      projectName,
      labels,
      mentionContext,
      dispatchModel,
      dispatchSubAgentModel,
    } = options

    // Resolve provider (and full profile when profiles are configured)
    const { provider: spawnProvider, providerName: spawnProviderName, source: providerSource, resolvedProfile } =
      this.resolveProviderForSpawn({ workType, projectName, labels, mentionContext, dispatchModel, dispatchSubAgentModel })

    // Extract model, effort, and sub-agent config from profile or legacy resolution
    let resolvedModel: string | undefined
    let resolvedSubAgentModel: string | undefined
    let resolvedEffort: import('../config/profiles.js').EffortLevel | undefined
    let resolvedProviderConfig: Record<string, unknown> | undefined
    let resolvedSubAgentProvider: AgentProviderName | undefined
    let resolvedSubAgentEffort: string | undefined

    if (resolvedProfile) {
      // Profile-based path
      resolvedModel = resolvedProfile.model
      resolvedEffort = resolvedProfile.effort
      resolvedProviderConfig = resolvedProfile.providerConfig
      resolvedSubAgentModel = resolvedProfile.subAgent?.model
      resolvedSubAgentProvider = resolvedProfile.subAgent?.provider
      resolvedSubAgentEffort = resolvedProfile.subAgent?.effort
    } else {
      // Legacy path
      const { model, source: modelSource } = resolveModelWithSource({
        dispatchModel,
        labels,
        workType,
        project: projectName,
        configModels: this.configModels,
      })
      resolvedModel = model
      resolvedSubAgentModel = resolveSubAgentModel({
        dispatchSubAgentModel,
        configModels: this.configModels,
      })
      if (resolvedModel) {
        const log = createLogger({ issueIdentifier: identifier })
        log.info('Model resolved (legacy)', { model: resolvedModel, source: modelSource })
      }
    }

    if (resolvedModel) {
      const log = createLogger({ issueIdentifier: identifier })
      log.info('Model resolved', { model: resolvedModel, source: providerSource, effort: resolvedEffort })
    }

    // Generate prompt. Template registry is the authoritative source for
    // workflow instructions (commit/push/PR ladder, scope audit, path scoping,
    // etc.). When a caller supplies a `prompt` (customPrompt) via webhook,
    // governor, or platform dispatch, treat it as caller-provided context and
    // fold it into the template's `mentionContext` slot so the template's
    // mandatory directives are never displaced.
    //
    // Rules:
    //   1. Template exists → render it; customPrompt becomes mentionContext.
    //   2. Template missing, customPrompt set → use customPrompt verbatim (legacy).
    //   3. Template missing, no customPrompt → generatePromptForWorkType fallback.
    let prompt: string
    const hasTemplate = this.templateRegistry?.hasTemplate(workType) ?? false
    // Merge customPrompt with any explicit mentionContext. See
    // mergeMentionContext() for the merge semantics.
    const mergedMentionContext = mergeMentionContext(mentionContext, customPrompt)

    if (hasTemplate) {
      // Resolve per-project config overrides (falls back to repo-wide defaults)
      const perProject = projectName && this.repoConfig
        ? getProjectConfig(this.repoConfig, projectName)
        : null

      const context: TemplateContext = {
        identifier,
        repository: this.config.repository,
        projectPath: perProject?.path ?? this.projectPaths?.[projectName ?? ''],
        sharedPaths: this.sharedPaths,
        useToolPlugins: (spawnProvider.capabilities.supportsToolPlugins ?? false) && this.toolRegistry.getPlugins().length > 0,
        hasCodeIntelligence: this.toolRegistry.getPlugins().some(p => p.name === 'af-code-intelligence'),
        linearCli: this.linearCli ?? 'pnpm af-linear',
        packageManager: perProject?.packageManager ?? this.packageManager ?? 'pnpm',
        buildCommand: perProject?.buildCommand ?? this.buildCommand,
        testCommand: perProject?.testCommand ?? this.testCommand,
        validateCommand: perProject?.validateCommand ?? this.validateCommand,
        agentBugBacklog: process.env.AGENT_BUG_BACKLOG || undefined,
        mergeQueueEnabled: !!this.mergeQueueAdapter,
        qualityBaseline: this.loadQualityBaselineForContext(worktreePath),
        model: resolvedModel,
        subAgentModel: resolvedSubAgentModel,
        effort: resolvedEffort,
        subAgentEffort: resolvedSubAgentEffort,
        subAgentProvider: resolvedSubAgentProvider,
        mentionContext: mergedMentionContext,
      }
      const rendered = this.templateRegistry!.renderPrompt(workType, context)
      prompt = rendered ?? customPrompt ?? generatePromptForWorkType(identifier, workType)
    } else if (customPrompt) {
      prompt = customPrompt
    } else {
      prompt = generatePromptForWorkType(identifier, workType)
    }

    // Create logger for this agent
    const log = createLogger({ issueIdentifier: identifier })
    this.agentLoggers.set(issueId, log)

    const now = new Date()
    const agent: AgentProcess = {
      issueId,
      identifier,
      worktreeIdentifier,
      sessionId,
      worktreePath,
      pid: undefined,
      status: 'starting',
      startedAt: now,
      lastActivityAt: now, // Initialize for inactivity tracking
      workType,
      providerName: spawnProviderName,
    }

    this.activeAgents.set(issueId, agent)

    // Track session to issue mapping for stop signal handling
    if (sessionId) {
      this.sessionToIssue.set(sessionId, issueId)
    }

    // Initialize state persistence and monitoring (only for worktree-based agents)
    if (worktreePath) {
      try {
        // Write initial state
        const initialState = createInitialState({
          issueId,
          issueIdentifier: identifier,
          linearSessionId: sessionId ?? null,
          workType,
          prompt,
          workerId: this.config.apiActivityConfig?.workerId ?? null,
          pid: null, // Will be updated when process spawns
        })
        // Track which provider was used so recovery can detect provider changes
        initialState.providerName = spawnProviderName
        writeState(worktreePath, initialState)

        // Start heartbeat writer for crash detection
        const heartbeatWriter = createHeartbeatWriter({
          agentDir: resolve(worktreePath, '.agent'),
          pid: process.pid, // Will be updated to child PID after spawn
          intervalMs: getHeartbeatIntervalFromEnv(),
          startTime: now.getTime(),
        })
        heartbeatWriter.start()
        this.heartbeatWriters.set(issueId, heartbeatWriter)

        // Start progress logger for debugging
        const progressLogger = createProgressLogger({
          agentDir: resolve(worktreePath, '.agent'),
        })
        progressLogger.logStart({ issueId, workType, prompt: prompt.substring(0, 200) })
        this.progressLoggers.set(issueId, progressLogger)

        // Start session logger for verbose analysis if enabled
        if (isSessionLoggingEnabled()) {
          const logConfig = getLogAnalysisConfig()
          const sessionLogger = createSessionLogger({
            sessionId: sessionId ?? issueId,
            issueId,
            issueIdentifier: identifier,
            workType,
            prompt,
            logsDir: logConfig.logsDir,
            workerId: this.config.apiActivityConfig?.workerId,
          })
          this.sessionLoggers.set(issueId, sessionLogger)
          log.debug('Session logging initialized', { logsDir: logConfig.logsDir })
        }

        // Initialize context manager for context window management
        const contextManager = ContextManager.load(worktreePath)
        this.contextManagers.set(issueId, contextManager)

        log.debug('State persistence initialized', { agentDir: resolve(worktreePath, '.agent') })
      } catch (stateError) {
        // Log but don't fail - state persistence is optional
        log.warn('Failed to initialize state persistence', {
          error: stateError instanceof Error ? stateError.message : String(stateError),
        })
      }
    }

    this.events.onAgentStart?.(agent)

    // Set up activity streaming if sessionId is provided
    const shouldStream = streamActivities ?? !!sessionId
    let emitter: ActivityEmitter | ApiActivityEmitter | null = null

    if (shouldStream && sessionId) {
      // Check if we should use API-based activity emitter (for remote workers)
      // This proxies activities through the agent app which has OAuth tokens
      if (this.config.apiActivityConfig) {
        const { baseUrl, apiKey, workerId } = this.config.apiActivityConfig
        log.debug('Using API activity emitter', { baseUrl })

        emitter = createApiActivityEmitter({
          sessionId,
          workerId,
          apiBaseUrl: baseUrl,
          apiKey,
          minInterval: this.config.streamConfig.minInterval,
          maxOutputLength: this.config.streamConfig.maxOutputLength,
          includeTimestamps: this.config.streamConfig.includeTimestamps,
          onActivityEmitted: (type, content) => {
            log.activity(type, content)
          },
          onActivityError: (type, error) => {
            log.error(`Activity error (${type})`, { error: error.message })
          },
        })
      } else {
        // Direct Linear API - only works with OAuth tokens (not API keys)
        // This will fail for createAgentActivity calls but works for comments
        const session = this.client.createSession({
          issueId,
          sessionId,
          autoTransition: false, // Orchestrator handles transitions
        })
        this.agentSessions.set(issueId, session)

        // Create ActivityEmitter with rate limiting
        emitter = createActivityEmitter({
          session,
          minInterval: this.config.streamConfig.minInterval,
          maxOutputLength: this.config.streamConfig.maxOutputLength,
          includeTimestamps: this.config.streamConfig.includeTimestamps,
          onActivityEmitted: (type, content) => {
            log.activity(type, content)
          },
        })
      }
      this.activityEmitters.set(issueId, emitter)
    }

    // Create AbortController for cancellation
    const abortController = new AbortController()
    this.abortControllers.set(issueId, abortController)

    // Load environment from settings.local.json and app .env files.
    // Pass the main repo root so these functions can find gitignored files
    // (settings.local.json, .env.local) that only exist in the main repo.
    const envBaseDir = worktreePath ?? process.cwd()
    const settingsEnv = loadSettingsEnv(envBaseDir, log, this.gitRoot)
    const appEnv = loadAppEnvFiles(envBaseDir, workType, log, this.gitRoot)

    // Build environment variables - inherit ALL from process.env (required for node to be found)
    // Then overlay app env vars, settings.local.json env vars, then our specific vars
    const processEnvFiltered: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string' && !AGENT_ENV_BLOCKLIST.includes(key)) {
        processEnvFiltered[key] = value
      }
    }

    const filteredAppEnv = Object.fromEntries(
      Object.entries(appEnv).filter(([key]) => !AGENT_ENV_BLOCKLIST.includes(key))
    )
    const filteredSettingsEnv = Object.fromEntries(
      Object.entries(settingsEnv).filter(([key]) => !AGENT_ENV_BLOCKLIST.includes(key))
    )

    const env: Record<string, string> = {
      ...processEnvFiltered, // Include all parent env vars (PATH, NODE_PATH, etc.)
      ...filteredAppEnv, // Include app env vars (blocklisted keys stripped)
      ...filteredSettingsEnv, // Include settings.local.json env vars (blocklisted keys stripped)
      LINEAR_ISSUE_ID: issueId,
      // Disable user .npmrc to prevent picking up expired auth tokens from ~/.npmrc
      // Point to a non-existent file so npm/pnpm won't try to use stale credentials
      NPM_CONFIG_USERCONFIG: '/dev/null',
      npm_config_userconfig: '/dev/null',
    }

    if (sessionId) {
      env.LINEAR_SESSION_ID = sessionId
    }

    // Set work type so agent knows what kind of work it's doing
    env.LINEAR_WORK_TYPE = workType

    // Flag shared worktree for coordination mode so sub-agents know not to modify git state
    if (workType === 'development' || workType === 'inflight' || workType === 'qa' || workType === 'acceptance' || workType === 'refinement-coordination') {
      env.SHARED_WORKTREE = 'true'
    }

    // Set Claude Code Task List ID for intra-issue task coordination
    // This enables Tasks to persist across crashes and be shared between subagents
    // Format: {issueIdentifier}-{WORKTYPE} (e.g., "SUP-123-DEV")
    env.CLAUDE_CODE_TASK_LIST_ID = worktreeIdentifier ?? `${identifier}-${WORK_TYPE_SUFFIX[workType]}`

    // Set team name so agents can use `pnpm af-linear create-issue` without --team
    if (teamName) {
      env.LINEAR_TEAM_NAME = teamName
    }

    // Pass API proxy URL and auth token so af-linear CLI can proxy through
    // the platform API when LINEAR_API_KEY is not available.
    // Without AGENTFACTORY_API_URL the CLI falls back to direct LinearAgentClient
    // which requires LINEAR_API_KEY and fails with 401 in platform-delegated setups.
    if (this.config.apiActivityConfig?.baseUrl) {
      env.AGENTFACTORY_API_URL = this.config.apiActivityConfig.baseUrl
    }
    if (this.config.apiActivityConfig?.apiKey) {
      env.WORKER_AUTH_TOKEN = this.config.apiActivityConfig.apiKey
    }

    log.info('Starting agent via provider', { provider: spawnProviderName, source: providerSource, cwd: worktreePath ?? 'repo-root', workType, promptPreview: prompt.substring(0, 50) })

    // Create stdio MCP server configs for tool plugins.
    // Stdio servers are used for all providers (Claude + Codex) so that
    // sub-agents spawned via the Agent tool inherit the tool servers.
    // In-process servers (createServers) only work for the top-level agent.
    const toolPluginContext = {
      env,
      cwd: worktreePath ?? process.cwd(),
      ...(this.config.fileReservation ? { fileReservation: this.config.fileReservation } : {}),
    }
    const stdioServers = this.toolRegistry.getPlugins().length > 0
      ? this.toolRegistry.createStdioServerConfigs(toolPluginContext)
      : undefined

    // Coordinators need significantly more turns than standard agents
    // since they spawn sub-agents and poll their status repeatedly.
    // Inflight also gets the bump — it may be resuming coordination work.
    const needsMoreTurns = workType === 'development' || workType === 'inflight' || workType === 'qa' || workType === 'acceptance' || workType === 'refinement-coordination'
    const maxTurns = needsMoreTurns ? 200 : undefined

    // Build code intelligence enforcement config.
    // Only providers with canUseTool-style enforcement (supportsCodeIntelligenceEnforcement) can use this.
    const hasCodeIntel = this.toolRegistry.getPlugins().some(p => p.name === 'af-code-intelligence')
    const supportsToolPlugins = (spawnProvider.capabilities.supportsToolPlugins ?? false) && this.toolRegistry.getPlugins().length > 0
    const codeIntelEnforcement = (
      this.repoConfig?.codeIntelligence?.enforceUsage &&
      hasCodeIntel &&
      (spawnProvider.capabilities.supportsCodeIntelligenceEnforcement ?? false)
    ) ? {
      enforceUsage: true,
      fallbackAfterAttempt: this.repoConfig.codeIntelligence.fallbackAfterAttempt ?? true,
    } : undefined

    // Build base instructions and permission config for providers that need them.
    // Capability-driven: any provider declaring needsBaseInstructions/needsPermissionConfig gets them.
    const baseInstructions = (spawnProvider.capabilities.needsBaseInstructions ?? false)
      ? this.buildBaseInstructions({
          workType,
          worktreePath,
          hasCodeIntelligence: hasCodeIntel,
          codeIntelEnforced: this.repoConfig?.codeIntelligence?.enforceUsage ?? false,
          useToolPlugins: supportsToolPlugins,
        })
      : undefined
    const permissionConfig = (spawnProvider.capabilities.needsPermissionConfig ?? false) && this.templateRegistry
      ? this.buildPermissionConfig(workType)
      : undefined

    // Resolve systemPrompt append from RepositoryConfig for Claude provider
    const systemPromptAppendSections: string[] = []
    if (this.repoConfig?.systemPrompt?.append) {
      systemPromptAppendSections.push(this.repoConfig.systemPrompt.append.trim())
    }
    if (workType && this.repoConfig?.systemPrompt?.byWorkType?.[workType]) {
      systemPromptAppendSections.push(this.repoConfig.systemPrompt.byWorkType[workType].trim())
    }
    const systemPromptAppend = systemPromptAppendSections.length > 0
      ? systemPromptAppendSections.join('\n\n')
      : undefined

    // Spawn agent via provider interface
    const spawnConfig: AgentSpawnConfig = {
      prompt,
      cwd: worktreePath ?? process.cwd(),
      env,
      abortController,
      autonomous: true,
      sandboxEnabled: this.config.sandboxEnabled,
      mcpToolNames: stdioServers?.toolNames,
      mcpStdioServers: stdioServers?.servers,
      maxTurns,
      model: resolvedModel,
      effort: resolvedEffort,
      providerConfig: resolvedProviderConfig,
      subAgentProvider: resolvedSubAgentProvider,
      baseInstructions,
      permissionConfig,
      codeIntelligenceEnforcement: codeIntelEnforcement,
      systemPromptAppend,
      onProcessSpawned: (pid) => {
        agent.pid = pid
        log.info('Agent process spawned', { pid })
      },
    }

    const handle = spawnProvider.spawn(spawnConfig)

    this.agentHandles.set(issueId, handle)
    agent.status = 'running'

    // Process the event stream in the background
    this.processEventStream(issueId, identifier, sessionId, handle, emitter, agent)

    return agent
  }

  /**
   * Process the provider event stream and emit activities
   */
  private async processEventStream(
    issueId: string,
    identifier: string,
    sessionId: string | undefined,
    handle: AgentHandle,
    emitter: ActivityEmitter | ApiActivityEmitter | null,
    agent: AgentProcess
  ): Promise<void> {
    const log = this.agentLoggers.get(issueId)

    // Accumulate all assistant text for WORK_RESULT marker fallback scanning.
    // The provider's result message only contains the final turn's text, but
    // the agent may have emitted the marker in an earlier turn.
    const assistantTextChunks: string[] = []

    // Code intelligence adoption telemetry
    let codeIntelToolCalls = 0
    let grepGlobToolCalls = 0

    try {
      for await (const event of handle.stream) {
        if (event.type === 'assistant_text') {
          assistantTextChunks.push(event.text)
        }
        // Also capture tool call inputs that may contain WORK_RESULT markers.
        // Agents sometimes embed the marker inside a create-comment body rather
        // than in their direct text output.
        if (event.type === 'tool_use' && event.input) {
          const inputStr = typeof event.input === 'string' ? event.input : JSON.stringify(event.input)
          if (inputStr.includes('WORK_RESULT')) {
            assistantTextChunks.push(inputStr)
          }
        }
        // Track code intelligence vs legacy search tool usage.
        // Two shapes: Claude native tools ("Grep" / "Glob") and provider shell
        // commands (Codex "shell" with input.command containing rg/grep/find/sed).
        // Without the shell-command classification, Codex sessions always
        // reported grepGlobCalls=0 even when the agent grepped heavily.
        if (event.type === 'tool_use') {
          if (event.toolName.includes('af_code_')) codeIntelToolCalls++
          if (event.toolName === 'Grep' || event.toolName === 'Glob') {
            grepGlobToolCalls++
          } else if (event.toolName === 'shell' && event.input) {
            const cmd = extractShellCommand(event.input)
            if (cmd && isGrepGlobShellCommand(cmd)) {
              grepGlobToolCalls++
            }
          }
        }
        await this.handleAgentEvent(issueId, sessionId, event, emitter, agent, handle)
      }

      // Query completed successfully — preserve 'failed' or 'stopped' status.
      // If the orchestrator is shutting down (fleet kill), force 'stopped' to prevent
      // the backstop from promoting incomplete work.
      if (this.shuttingDown && agent.status !== 'failed') {
        agent.status = 'stopped'
        log?.info('Agent stopped by fleet shutdown — skipping backstop and auto-transition')
      } else if (agent.status !== 'stopped' && agent.status !== 'failed') {
        agent.status = 'completed'
      }
      agent.completedAt = new Date()

      // Log code intelligence adoption telemetry
      if (this.toolRegistry.getPlugins().some(p => p.name === 'af-code-intelligence')) {
        const total = codeIntelToolCalls + grepGlobToolCalls
        log?.info('Code intelligence adoption', {
          codeIntelCalls: codeIntelToolCalls,
          grepGlobCalls: grepGlobToolCalls,
          ratio: total > 0 ? (codeIntelToolCalls / total).toFixed(2) : 'N/A',
        })
      }

      // Update state file to completed (only for worktree-based agents)
      if (agent.worktreePath) {
        try {
          updateState(agent.worktreePath, {
            status: agent.status === 'stopped' ? 'stopped' : agent.status === 'failed' ? 'failed' : 'completed',
            pullRequestUrl: agent.pullRequestUrl ?? undefined,
          })
        } catch {
          // Ignore state update errors
        }
      }

      // Emit structured security scan events for security work type agents
      if (emitter && agent.status === 'completed' && agent.workType === 'security') {
        const fullOutput = assistantTextChunks.join('\n')
        const scanEvents = parseSecurityScanOutput(fullOutput)
        for (const scanEvent of scanEvents) {
          try {
            await emitter.emitSecurityScan(scanEvent)
            log?.info('Security scan event emitted', {
              scanner: scanEvent.scanner,
              findings: scanEvent.totalFindings,
            })
          } catch (scanError) {
            log?.warn('Failed to emit security scan event', {
              error: scanError instanceof Error ? scanError.message : String(scanError),
            })
          }
        }
      }

      // Emit a final response activity to close the Linear agent session.
      // Linear auto-transitions sessions to "complete" when a response activity is emitted.
      if (emitter && (agent.status === 'completed' || agent.status === 'failed')) {
        try {
          if (agent.status === 'completed') {
            const summary = agent.resultMessage
              ? agent.resultMessage.substring(0, 500)
              : 'Work completed successfully.'
            await emitter.emitResponse(summary)
          } else {
            await emitter.emitResponse(
              agent.resultMessage || 'Agent encountered an error during execution.'
            )
          }
        } catch (emitError) {
          log?.warn('Failed to emit completion response activity', {
            error: emitError instanceof Error ? emitError.message : String(emitError),
          })
        }
      }

      // Flush remaining activities
      if (emitter) {
        await emitter.flush()
      }

      // Post-exit PR detection: if the agent exited without a detected PR URL,
      // check GitHub directly in case the PR was created but the output wasn't captured
      if (agent.status === 'completed' && !agent.pullRequestUrl && agent.worktreePath) {
        const postExitWorkType = agent.workType ?? 'development'
        const isPostExitCodeProducing = postExitWorkType === 'development' || postExitWorkType === 'inflight'
        if (isPostExitCodeProducing) {
          try {
            const currentBranch = execSync('git branch --show-current', {
              cwd: agent.worktreePath,
              encoding: 'utf-8',
              timeout: 10000,
            }).trim()

            if (currentBranch && currentBranch !== 'main' && currentBranch !== 'master') {
              const prJson = execSync(`gh pr list --head "${currentBranch}" --json url --limit 1`, {
                cwd: agent.worktreePath,
                encoding: 'utf-8',
                timeout: 15000,
              }).trim()

              const prs = JSON.parse(prJson) as Array<{ url: string }>
              if (prs.length > 0 && prs[0].url) {
                log?.info('Post-exit PR detection found existing PR', { prUrl: prs[0].url, branch: currentBranch })
                agent.pullRequestUrl = prs[0].url
                if (sessionId) {
                  await this.updateSessionPullRequest(sessionId, prs[0].url, agent)
                }
              }
            }
          } catch (error) {
            log?.debug('Post-exit PR detection failed (non-fatal)', {
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
      }

      // --- Session Steering: For providers that support resume, give the
      // agent a second chance to finish commit/push/PR itself before the
      // deterministic backstop takes over with a blind auto-commit.
      if (agent.status === 'completed' && agent.worktreePath) {
        await this.attemptSessionSteering(agent, log).catch((error) => {
          log?.warn('Session steering threw — falling through to backstop', {
            error: error instanceof Error ? error.message : String(error),
          })
        })
      }

      // --- Session Backstop: Validate completion contract and recover missing outputs ---
      if (agent.status === 'completed') {
        const outputFlags = this.sessionOutputFlags.get(issueId)
        const backstopCtx: SessionContext = {
          agent,
          commentPosted: outputFlags?.commentPosted ?? false,
          issueUpdated: outputFlags?.issueUpdated ?? false,
          subIssuesCreated: outputFlags?.subIssuesCreated ?? false,
        }
        const backstopResult = runBackstop(backstopCtx)

        if (backstopResult.backstop.actions.length > 0) {
          log?.info('Session backstop ran', {
            actions: backstopResult.backstop.actions.map(a => `${a.field}:${a.success ? 'ok' : 'fail'}`),
            fullyRecovered: backstopResult.backstop.fullyRecovered,
            remainingGaps: backstopResult.backstop.remainingGaps,
          })

          // Post backstop diagnostic comment if there were actions taken or gaps remaining
          const backstopComment = formatBackstopComment(backstopResult)
          if (backstopComment) {
            try {
              await this.client.createComment(issueId, backstopComment)
            } catch {
              // Best-effort diagnostic comment
            }
          }
        }

        // If backstop recovered the PR URL, update the session
        if (agent.pullRequestUrl && sessionId) {
          try {
            await this.updateSessionPullRequest(sessionId, agent.pullRequestUrl, agent)
          } catch {
            // Best-effort session update
          }
        }
      }

      // --- Quality Gate: Check quality delta for code-producing work types ---
      if (agent.status === 'completed' && agent.worktreePath && this.isQualityBaselineEnabled()) {
        const codeProducingTypes = ['development', 'inflight']
        const agentWorkType = agent.workType ?? 'development'
        if (codeProducingTypes.includes(agentWorkType)) {
          try {
            const baseline = loadBaseline(agent.worktreePath)
            if (baseline) {
              const qualityConfig = this.buildQualityConfig()
              const current = captureQualityBaseline(agent.worktreePath, qualityConfig)
              const delta = computeQualityDelta(baseline, current)

              if (!delta.passed) {
                const report = formatQualityReport(baseline, current, delta)
                log?.warn('Quality gate FAILED — agent worsened quality metrics', {
                  testFailuresDelta: delta.testFailuresDelta,
                  typeErrorsDelta: delta.typeErrorsDelta,
                  lintErrorsDelta: delta.lintErrorsDelta,
                })

                // Post quality gate failure comment
                try {
                  await this.client.createComment(
                    issueId,
                    `## Quality Gate Failed\n\n` +
                    `The agent's changes worsened quality metrics compared to the baseline (main).\n\n` +
                    report +
                    `\n\n**Status promotion blocked.** The agent must fix quality regressions before this work can advance to QA.`
                  )
                } catch {
                  // Best-effort comment
                }

                // Block status promotion by marking agent as failed
                agent.status = 'failed'
                agent.workResult = 'failed'
              } else {
                log?.info('Quality gate passed', {
                  testFailuresDelta: delta.testFailuresDelta,
                  typeErrorsDelta: delta.typeErrorsDelta,
                  testCountDelta: delta.testCountDelta,
                })

                if (delta.testFailuresDelta < 0 || delta.typeErrorsDelta < 0 || delta.lintErrorsDelta < 0) {
                  log?.info('Boy scout rule: agent improved quality metrics', {
                    testFailuresDelta: delta.testFailuresDelta,
                    typeErrorsDelta: delta.typeErrorsDelta,
                    lintErrorsDelta: delta.lintErrorsDelta,
                  })
                }
              }
            }
          } catch (qualityError) {
            log?.warn('Quality gate check failed (non-fatal)', {
              error: qualityError instanceof Error ? qualityError.message : String(qualityError),
            })
            // Quality gate check failure should not block the session — degrade gracefully
          }
        }
      }

      // Update Linear status based on work type if auto-transition is enabled
      if ((agent.status === 'completed' || agent.status === 'failed') && this.config.autoTransition) {
        const workType = agent.workType ?? 'development'
        const isResultSensitive = workType === 'qa' || workType === 'acceptance' || workType === 'development' || workType === 'inflight' || workType === 'merge'

        let targetStatus: string | null = null

        if (isResultSensitive) {
          if (agent.status === 'failed') {
            // Agent crashed/errored — treat as QA/acceptance failure
            agent.workResult = 'failed'
            targetStatus = this.statusMappings.workTypeFailStatus[workType]
            log?.info('Agent failed (crash/error), transitioning to fail status', { workType, targetStatus })
          } else {
            // For QA/acceptance: parse result to decide promote vs reject.
            // Try the final result message first, then fall back to scanning
            // all accumulated assistant text (the marker may be in an earlier turn).
            let workResult = parseWorkResult(agent.resultMessage, workType)
            if (workResult === 'unknown' && assistantTextChunks.length > 0) {
              const fullText = assistantTextChunks.join('\n')
              workResult = parseWorkResult(fullText, workType)
              if (workResult !== 'unknown') {
                log?.info('Work result found in accumulated text (not in final message)', { workResult })
              }
            }
            agent.workResult = workResult

            if (workResult === 'passed') {
              // REN-503/REN-1153: when the local merge queue is enabled,
              // a passing acceptance only signals "the code is ready to
              // ship". The actual transition to Accepted is driven by the
              // merge worker once the PR lands on main — that's what makes
              // Accepted mean "live in production" rather than "the agent
              // says we're done." On merge failure (conflict / test-fail /
              // error) the worker demotes to Rejected and refinement picks
              // it up. The orchestrator's only job here is to enqueue, which
              // happens unconditionally a few lines below.
              const deferredToMergeQueue = shouldDeferAcceptanceTransition(workType, !!this.mergeQueueAdapter)
              if (deferredToMergeQueue) {
                log?.info('Acceptance passed — deferring status transition to merge worker', {
                  workType,
                  rationale: 'mergeQueueEnabled',
                })
              } else {
                targetStatus = this.statusMappings.workTypeCompleteStatus[workType]
                log?.info('Work result: passed, promoting', { workType, targetStatus })
              }
            } else if (workResult === 'failed') {
              targetStatus = this.statusMappings.workTypeFailStatus[workType]
              log?.info('Work result: failed, transitioning to fail status', { workType, targetStatus })
            } else {
              // unknown — safe default: don't transition
              log?.warn('Work result: unknown, skipping auto-transition', {
                workType,
                hasResultMessage: !!agent.resultMessage,
              })

              // Post a diagnostic comment so the issue doesn't silently stall
              try {
                await this.client.createComment(
                  issueId,
                  `⚠️ Agent completed but no structured result marker was detected in the output.\n\n` +
                  `**Issue status was NOT updated automatically.**\n\n` +
                  `The orchestrator expected one of:\n` +
                  `- \`<!-- WORK_RESULT:passed -->\` to promote the issue\n` +
                  `- \`<!-- WORK_RESULT:failed -->\` to record a failure\n\n` +
                  `This usually means the agent exited early (timeout, error, or missing logic). ` +
                  `Check the agent logs for details, then manually update the issue status or re-trigger the agent.`
                )
                log?.info('Posted diagnostic comment for unknown work result')
              } catch (error) {
                log?.warn('Failed to post diagnostic comment for unknown work result', {
                  error: error instanceof Error ? error.message : String(error),
                })
              }
            }
          }
        } else if (agent.status === 'completed') {
          // Non-result-sensitive work types (research, backlog-creation, refinement, etc.):
          // promote on completion
          targetStatus = this.statusMappings.workTypeCompleteStatus[workType]
        }

        if (targetStatus) {
          try {
            await this.client.updateIssueStatus(issueId, targetStatus)
            log?.info('Issue status updated', { from: workType, to: targetStatus })
          } catch (error) {
            log?.error('Failed to update status', {
              targetStatus,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        } else if (!isResultSensitive) {
          log?.info('No auto-transition configured for work type', { workType })
        }

        // Merge queue: enqueue PR after successful merge work, or after a
        // passing acceptance when the local merge queue is configured. This
        // is the REN-503 primary handoff path — acceptance validates the
        // code, orchestrator hands the PR off to the queue, worker serializes
        // the actual merge against the latest main. Without this wire, the
        // queue feature is decorative (the trigger-merge dispatch that used
        // to populate it was removed in v0.8.20 as a QA-bypass fix).
        const isMergeWork = workType === 'merge'
        const isAcceptancePass =
          workType === 'acceptance' &&
          agent.workResult === 'passed'
        const shouldEnqueue =
          (isMergeWork || isAcceptancePass) &&
          this.mergeQueueAdapter &&
          agent.pullRequestUrl
        if (shouldEnqueue) {
          try {
            const prMatch = agent.pullRequestUrl!.match(/\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
            if (prMatch) {
              const [, owner, repo, prNum] = prMatch
              const canEnqueue = await this.mergeQueueAdapter!.canEnqueue(owner, repo, parseInt(prNum, 10))
              if (canEnqueue) {
                const status = await this.mergeQueueAdapter!.enqueue(owner, repo, parseInt(prNum, 10))
                log?.info('PR enqueued in merge queue', {
                  owner, repo, prNumber: prNum, state: status.state,
                  trigger: isMergeWork ? 'merge_work' : 'acceptance_pass',
                })
                // Feeds the acceptance completion contract's
                // pr_merged_or_enqueued check so the backstop treats this
                // as a successful handoff, not a missed merge.
                agent.prEnqueuedForMerge = true
              } else {
                log?.info('PR not eligible for merge queue', { owner, repo, prNumber: prNum })
              }
            }
          } catch (error) {
            log?.warn('Failed to enqueue PR in merge queue', {
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }

        // Unassign agent from issue for clean handoff visibility
        // This enables automated QA pickup via webhook
        // Skip unassignment for research work (user should decide when to move to backlog)
        if (workType !== 'research') {
          try {
            await this.client.unassignIssue(issueId)
            log?.info('Agent unassigned from issue')
          } catch (error) {
            log?.warn('Failed to unassign agent from issue', {
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
      }

      // Post completion comment with full result (not truncated)
      // This uses multi-comment splitting for long messages
      if (agent.status === 'completed' && agent.resultMessage) {
        await this.postCompletionComment(issueId, sessionId, agent.resultMessage, log)
      }

      // Release file reservations held by this session.
      // Must happen before worktree cleanup so other agents can immediately use the files.
      // TTL provides fallback if this call fails.
      if (this.config.fileReservation && sessionId) {
        try {
          await this.config.fileReservation.releaseAllSessionFiles(sessionId)
        } catch {
          // Best-effort — TTL handles eventual release
        }
      }

      // Clean up worktree for completed agents
      // NOTE: This must happen AFTER the agent exits to avoid breaking its shell session
      // Agents should NEVER clean up their own worktree - this is the orchestrator's job
      if (agent.status === 'completed' && agent.worktreePath) {
        const shouldPreserve = this.config.preserveWorkOnPrFailure ?? DEFAULT_CONFIG.preserveWorkOnPrFailure
        let shouldCleanup = true

        // Only check for incomplete work on code-producing work types.
        // Non-code work types (research, backlog-creation, QA, refinement, etc.) use
        // worktrees for codebase exploration but don't produce commits/PRs. Checking
        // them triggers false "work not persisted" warnings from bootstrapped .agent/ files.
        const codeProducingWorkTypes = new Set(['development', 'inflight'])
        const agentWorkType = agent.workType ?? 'development'
        const isCodeProducingAgent = codeProducingWorkTypes.has(agentWorkType)

        // Validate that PR was created or work was fully pushed before cleanup
        if (shouldPreserve && isCodeProducingAgent) {
          if (!agent.pullRequestUrl) {
            // No PR detected - check for uncommitted/unpushed work
            const incompleteCheck = checkForIncompleteWork(agent.worktreePath)

            if (incompleteCheck.hasIncompleteWork) {
              // Mark as incomplete and preserve worktree
              agent.status = 'incomplete'
              agent.incompleteReason = incompleteCheck.reason
              shouldCleanup = false
              log?.warn('Work incomplete - preserving worktree', {
                reason: incompleteCheck.reason,
                details: incompleteCheck.details,
                worktreePath: agent.worktreePath,
              })

              // Delete the heartbeat file so the preserved worktree isn't falsely
              // detected as having a live agent (which would block branch reuse)
              try {
                const heartbeatPath = resolve(agent.worktreePath, '.agent', 'heartbeat.json')
                if (existsSync(heartbeatPath)) {
                  unlinkSync(heartbeatPath)
                }
              } catch {
                // Best-effort - heartbeat will go stale naturally after timeout
              }

              // Write a .preserved marker so branch conflict resolution knows not to
              // destroy this worktree. The marker includes context for diagnostics.
              try {
                const agentDir = resolve(agent.worktreePath, '.agent')
                if (!existsSync(agentDir)) {
                  mkdirSync(agentDir, { recursive: true })
                }
                writeFileSync(
                  resolve(agentDir, 'preserved.json'),
                  JSON.stringify({
                    preservedAt: new Date().toISOString(),
                    issueId,
                    reason: incompleteCheck.reason,
                    details: incompleteCheck.details,
                  }, null, 2)
                )
              } catch {
                // Best-effort - the shouldCleanup=false flag is the primary guard
              }

              // Post diagnostic comment NOW that preservation is confirmed
              try {
                await this.client.createComment(
                  issueId,
                  `⚠️ **Agent completed but work was not persisted.**\n\n` +
                  `The agent reported success but no PR was detected, and the worktree has ${incompleteCheck.details}.\n\n` +
                  `**Issue status was NOT promoted** to prevent lost work from advancing through the pipeline.\n\n` +
                  `The worktree has been preserved at \`${agent.worktreePath}\`. ` +
                  `To recover: cd into the worktree, commit, push, and create a PR manually.`
                )
              } catch {
                // Best-effort comment
              }
            } else {
              // No PR but also no local changes - agent may not have made any changes
              log?.warn('No PR created but worktree is clean - proceeding with cleanup', {
                worktreePath: agent.worktreePath,
              })
            }
          }
        }

        if (shouldCleanup && agent.worktreeIdentifier) {
          try {
            // For non-code-producing work types, also delete the branch to prevent
            // stale branches from being accidentally reused by development agents.
            const shouldDeleteBranch = !isCodeProducingAgent
            this.removeWorktree(
              agent.worktreeIdentifier,
              shouldDeleteBranch ? (agent.identifier ?? undefined) : undefined
            )
            log?.info('Worktree cleaned up', { worktreePath: agent.worktreePath })
          } catch (error) {
            log?.warn('Failed to clean up worktree', {
              worktreePath: agent.worktreePath,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
      }

      // Finalize session logger before cleanup
      const finalStatus = agent.status === 'completed' ? 'completed' : (agent.status === 'stopped' ? 'stopped' : 'completed')
      this.finalizeSessionLogger(issueId, finalStatus, {
        pullRequestUrl: agent.pullRequestUrl,
      })

      // Clean up in-memory resources
      this.cleanupAgent(issueId, sessionId)

      if (agent.status === 'completed') {
        this.events.onAgentComplete?.(agent)
      } else if (agent.status === 'incomplete') {
        this.events.onAgentIncomplete?.(agent)
      } else if (agent.status === 'stopped') {
        this.events.onAgentStopped?.(agent)
      }
    } catch (error) {
      // Handle abort/cancellation
      if (error instanceof Error && error.name === 'AbortError') {
        agent.status = 'stopped'
        agent.completedAt = new Date()
        this.finalizeSessionLogger(issueId, 'stopped')
        this.cleanupAgent(issueId, sessionId)
        this.events.onAgentStopped?.(agent)
        return
      }

      // Handle other errors
      log?.error('Agent error', { error: error instanceof Error ? error.message : String(error) })
      agent.status = 'failed'
      agent.completedAt = new Date()
      agent.error = error instanceof Error ? error : new Error(String(error))

      // Flush remaining activities
      if (emitter) {
        await emitter.flush()
      }

      // Clean up worktree for failed agents (but preserve if there's work)
      if (agent.worktreePath) {
        const shouldPreserve = this.config.preserveWorkOnPrFailure ?? DEFAULT_CONFIG.preserveWorkOnPrFailure
        let shouldCleanup = true

        // Check for any uncommitted/unpushed work before cleaning up
        if (shouldPreserve) {
          const incompleteCheck = checkForIncompleteWork(agent.worktreePath)

          if (incompleteCheck.hasIncompleteWork) {
            // Preserve worktree - there's work that could be recovered
            shouldCleanup = false
            agent.incompleteReason = incompleteCheck.reason
            log?.warn('Agent failed but has uncommitted work - preserving worktree', {
              reason: incompleteCheck.reason,
              details: incompleteCheck.details,
              worktreePath: agent.worktreePath,
            })

            // Delete the heartbeat file so the preserved worktree isn't falsely
            // detected as having a live agent (which would block branch reuse)
            try {
              const heartbeatPath = resolve(agent.worktreePath, '.agent', 'heartbeat.json')
              if (existsSync(heartbeatPath)) {
                unlinkSync(heartbeatPath)
              }
            } catch {
              // Best-effort - heartbeat will go stale naturally after timeout
            }

            // Write a .preserved marker so branch conflict resolution knows not to
            // destroy this worktree
            try {
              const agentDir = resolve(agent.worktreePath, '.agent')
              if (!existsSync(agentDir)) {
                mkdirSync(agentDir, { recursive: true })
              }
              writeFileSync(
                resolve(agentDir, 'preserved.json'),
                JSON.stringify({
                  preservedAt: new Date().toISOString(),
                  issueId,
                  reason: incompleteCheck.reason,
                  details: incompleteCheck.details,
                }, null, 2)
              )
            } catch {
              // Best-effort - the shouldCleanup=false flag is the primary guard
            }
          }
        }

        if (shouldCleanup && agent.worktreeIdentifier) {
          try {
            const failedAgentWorkType = agent.workType ?? 'development'
            const failedCodeProducing = new Set(['development', 'inflight'])
            const shouldDeleteBranch = !failedCodeProducing.has(failedAgentWorkType)
            this.removeWorktree(
              agent.worktreeIdentifier,
              shouldDeleteBranch ? (agent.identifier ?? undefined) : undefined
            )
            log?.info('Worktree cleaned up after failure', { worktreePath: agent.worktreePath })
          } catch (cleanupError) {
            log?.warn('Failed to clean up worktree after failure', {
              worktreePath: agent.worktreePath,
              error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            })
          }
        }
      }

      // Finalize session logger with error
      this.finalizeSessionLogger(issueId, 'failed', {
        errorMessage: agent.error?.message,
      })

      this.cleanupAgent(issueId, sessionId)
      this.events.onAgentError?.(agent, agent.error)
    }
  }

  /**
   * Handle a single normalized agent event from any provider
   */
  private async handleAgentEvent(
    issueId: string,
    sessionId: string | undefined,
    event: AgentEvent,
    emitter: ActivityEmitter | ApiActivityEmitter | null,
    agent: AgentProcess,
    handle: AgentHandle
  ): Promise<void> {
    const log = this.agentLoggers.get(issueId)

    // Get heartbeat writer and progress logger for state updates
    const heartbeatWriter = this.heartbeatWriters.get(issueId)
    const progressLogger = this.progressLoggers.get(issueId)
    const sessionLogger = this.sessionLoggers.get(issueId)

    switch (event.type) {
      case 'init':
        log?.success('Agent initialized', { session: event.sessionId.substring(0, 12) })
        agent.providerSessionId = event.sessionId
        this.updateLastActivity(issueId, 'init')

        // Update state with provider session ID (only for worktree-based agents)
        // Skip if agent already failed — a late init event after an error would
        // re-persist a stale session ID, preventing fresh recovery on next attempt
        if (agent.worktreePath && agent.status !== 'failed') {
          try {
            updateState(agent.worktreePath, {
              providerSessionId: event.sessionId,
              status: 'running',
              pid: agent.pid ?? null,
            })
          } catch {
            // Ignore state update errors
          }
        }

        // Notify via callback for external persistence
        if (sessionId) {
          await this.events.onProviderSessionId?.(sessionId, event.sessionId)
        }
        break

      case 'system':
        // System-level events (status changes, compaction, auth, etc.)
        if (event.subtype === 'status') {
          log?.debug('Status change', { status: event.message })
        } else if (event.subtype === 'compact_boundary') {
          log?.debug('Context compacted')
          // Trigger incremental summarization on compaction boundary
          this.contextManagers.get(issueId)?.handleCompaction()
        } else if (event.subtype === 'hook_response') {
          // Provider-specific hook handling — access raw event for details
          const raw = event.raw as { exit_code?: number; hook_name?: string }
          if (raw.exit_code !== undefined && raw.exit_code !== 0) {
            log?.warn('Hook failed', { hook: raw.hook_name, exitCode: raw.exit_code })
          }
        } else if (event.subtype === 'reasoning') {
          // Codex reasoning/thinking events — buffer and log for fleet observability
          this.updateLastActivity(issueId, 'thinking')
          if (event.message) {
            this.bufferAssistantText(issueId, event.message, log)
          }
          heartbeatWriter?.recordThinking()
          // Persist reasoning to Linear session (same pattern as Claude's assistant_text)
          if (emitter && event.message && typeof event.message === 'string') {
            await emitter.emitThought(event.message.substring(0, 200))
          }
        } else if (event.subtype === 'auth_status') {
          if (event.message?.includes('error') || event.message?.includes('Error')) {
            log?.error('Auth error', { error: event.message })
          }
        } else {
          log?.debug('System event', { subtype: event.subtype, message: event.message })
        }
        break

      case 'tool_result':
        // Tool results — track activity and detect PR URLs
        this.updateLastActivity(issueId, 'tool_result')

        // Feed to context manager for artifact tracking
        this.contextManagers.get(issueId)?.processEvent(event)

        sessionLogger?.logToolResult(event.toolUseId ?? 'unknown', event.content, event.isError)

        // Detect GitHub PR URLs in tool output (from gh pr create)
        if (sessionId) {
          const prUrl = this.extractPullRequestUrl(event.content)
          if (prUrl) {
            log?.info('Pull request detected', { prUrl })
            agent.pullRequestUrl = prUrl
            await this.updateSessionPullRequest(sessionId, prUrl, agent)
          }
        }

        // Auto-emit structured context for successful tool results
        if (emitter && !event.isError && event.toolUseId) {
          const pending = this.pendingToolCalls.get(issueId)?.get(event.toolUseId)
          if (pending) {
            this.pendingToolCalls.get(issueId)!.delete(event.toolUseId)
            this.emitToolContext(emitter, pending.toolName, pending.input)
          }
        }
        break

      case 'assistant_text':
        // Assistant text output
        this.updateLastActivity(issueId, 'assistant')

        // Buffer and log agent reasoning for fleet observability.
        // Streaming providers (Codex) send one token per event — buffer for readability.
        if (event.text) {
          this.bufferAssistantText(issueId, event.text, log)
        }

        // Feed to context manager for session intent extraction
        this.contextManagers.get(issueId)?.processEvent(event)

        heartbeatWriter?.recordThinking()
        sessionLogger?.logAssistant(event.text)

        // Detect GitHub PR URLs in assistant text (backup for tool_result detection)
        if (sessionId && !agent.pullRequestUrl) {
          const prUrl = this.extractPullRequestUrl(event.text)
          if (prUrl) {
            log?.info('Pull request detected in assistant text', { prUrl })
            agent.pullRequestUrl = prUrl
            await this.updateSessionPullRequest(sessionId, prUrl, agent)
          }
        }

        if (emitter) {
          await emitter.emitThought(event.text.substring(0, 200))
        }
        break

      case 'tool_use':
        // Tool invocation
        this.updateLastActivity(issueId, 'assistant')

        // Feed to context manager for artifact tracking
        this.contextManagers.get(issueId)?.processEvent(event)

        log?.toolCall(event.toolName, event.input)
        heartbeatWriter?.recordToolCall(event.toolName)
        progressLogger?.logTool(event.toolName, event.input)
        sessionLogger?.logToolUse(event.toolName, event.input)

        // Track session output signals for completion contract validation
        this.trackSessionOutputSignal(issueId, event.toolName, event.input)

        // Intercept TodoWrite tool calls to persist todos
        if (event.toolName === 'TodoWrite') {
          try {
            const input = event.input as { todos?: TodoItem[] }
            if (input.todos && Array.isArray(input.todos) && agent.worktreePath) {
              const todosState: TodosState = {
                updatedAt: Date.now(),
                items: input.todos,
              }
              writeTodos(agent.worktreePath, todosState)
              log?.debug('Todos persisted', { count: input.todos.length })
            }
          } catch {
            // Ignore todos persistence errors
          }
        }

        // Track pending tool call for context emission on tool_result
        if (event.toolUseId) {
          if (!this.pendingToolCalls.has(issueId)) {
            this.pendingToolCalls.set(issueId, new Map())
          }
          this.pendingToolCalls.get(issueId)!.set(event.toolUseId, {
            toolName: event.toolName,
            input: event.input,
          })
        }

        if (emitter) {
          await emitter.emitToolUse(event.toolName, event.input)
        }
        break

      case 'tool_progress':
        // Tool execution progress — track activity for long-running tools
        this.updateLastActivity(issueId, `tool_progress:${event.toolName}`)
        log?.debug('Tool progress', { tool: event.toolName, elapsed: `${event.elapsedSeconds}s` })
        break

      case 'result':
        // Flush any buffered assistant text before processing result
        this.flushAssistantTextBuffer(issueId, log)

        if (event.success) {
          log?.success('Agent completed', {
            cost: event.cost?.totalCostUsd ? `$${event.cost.totalCostUsd.toFixed(4)}` : 'N/A',
            turns: event.cost?.numTurns,
          })

          // Track cost data on the agent
          if (event.cost) {
            agent.totalCostUsd = event.cost.totalCostUsd
            agent.inputTokens = event.cost.inputTokens
            agent.outputTokens = event.cost.outputTokens
          }

          // Store full result for completion comment posting later
          if (event.message) {
            agent.resultMessage = event.message

            // Detect GitHub PR URLs in final result message (backup for tool_result detection)
            if (sessionId && !agent.pullRequestUrl) {
              const prUrl = this.extractPullRequestUrl(event.message)
              if (prUrl) {
                log?.info('Pull request detected in result message', { prUrl })
                agent.pullRequestUrl = prUrl
                await this.updateSessionPullRequest(sessionId, prUrl, agent)
              }
            }
          }

          // Update state to completing/completed (only for worktree-based agents)
          if (agent.worktreePath) {
            try {
              updateState(agent.worktreePath, {
                status: 'completing',
                currentPhase: 'Finalizing work',
              })
            } catch {
              // Ignore state update errors
            }
          }
          progressLogger?.logComplete({ message: event.message?.substring(0, 200) })

          // Check cost limit
          const maxCostUsd = parseFloat(process.env.AGENT_MAX_COST_USD ?? '0')
          if (maxCostUsd > 0 && event.cost?.totalCostUsd && event.cost.totalCostUsd > maxCostUsd) {
            log?.warn('Agent exceeded cost limit', {
              totalCost: event.cost.totalCostUsd,
              limit: maxCostUsd,
            })
          }

          // Emit truncated preview to activity feed (ephemeral)
          if (emitter && event.message && typeof event.message === 'string') {
            await emitter.emitThought(`Completed: ${event.message.substring(0, 200)}...`, true)
          }
        } else {
          // Error result — mark agent as failed so auto-transition doesn't fire
          // with an empty resultMessage (which would always produce 'unknown')
          agent.status = 'failed'
          log?.error('Agent error result', { subtype: event.errorSubtype })

          // Update state to failed
          const errorMessage = event.errors && event.errors.length > 0
            ? event.errors[0]
            : `Agent error: ${event.errorSubtype}`
          if (agent.worktreePath) {
            try {
              // If the error is a stale session (resume failed), clear providerSessionId
              // so the next recovery attempt starts fresh instead of hitting the same error.
              // Claude: "No conversation found with session ID"
              // Codex: "thread/resume failed" or "thread/resume: ..."
              const isStaleSession =
                errorMessage.includes('No conversation found with session ID') ||
                errorMessage.includes('thread/resume failed') ||
                errorMessage.includes('thread/resume:')
              updateState(agent.worktreePath, {
                status: 'failed',
                errorMessage,
                ...(isStaleSession && { providerSessionId: null }),
              })
              if (isStaleSession) {
                log?.info('Cleared stale providerSessionId from state — next recovery will start fresh')
              }
            } catch {
              // Ignore state update errors
            }
          }
          progressLogger?.logError('Agent error result', new Error(errorMessage))
          sessionLogger?.logError('Agent error result', new Error(errorMessage), { subtype: event.errorSubtype })

          // Merge queue: dequeue PR on merge agent failure
          if (agent.workType === 'merge' && this.mergeQueueAdapter && agent.pullRequestUrl) {
            try {
              const prMatch = agent.pullRequestUrl.match(/\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
              if (prMatch) {
                const [, owner, repo, prNum] = prMatch
                await this.mergeQueueAdapter.dequeue(owner, repo, parseInt(prNum, 10))
                log?.info('PR dequeued from merge queue after failure', { owner, repo, prNumber: prNum })
              }
            } catch (dequeueError) {
              log?.warn('Failed to dequeue PR from merge queue', {
                error: dequeueError instanceof Error ? dequeueError.message : String(dequeueError),
              })
            }
          }

          // Report tool errors as Linear issues for tracking
          // Only report for 'error_during_execution' subtype (tool/execution errors)
          if (
            event.errorSubtype === 'error_during_execution' &&
            event.errors &&
            emitter
          ) {
            for (const err of event.errors) {
              log?.error('Error detail', { error: err })

              if (isToolRelatedError(err)) {
                const toolName = extractToolNameFromError(err)
                try {
                  const issue = await emitter.reportToolError(toolName, err, {
                    issueIdentifier: agent.identifier,
                    additionalContext: {
                      agentStatus: agent.status,
                      workType: agent.workType,
                      subtype: event.errorSubtype,
                    },
                  })
                  if (issue) {
                    log?.info('Tool error reported to Linear', {
                      issue: issue.identifier,
                      toolName,
                    })
                  }
                } catch (reportError) {
                  log?.warn('Failed to report tool error', {
                    error:
                      reportError instanceof Error
                        ? reportError.message
                        : String(reportError),
                  })
                }
              }
            }
          } else if (event.errors) {
            for (const err of event.errors) {
              log?.error('Error detail', { error: err })
            }
          }
        }
        break

      case 'error':
        log?.error('Agent error', { message: event.message, code: event.code })
        break

      default:
        log?.debug('Unhandled event type', { type: (event as { type: string }).type })
    }
  }

  /**
   * Extract GitHub PR URL from text (typically from gh pr create output)
   */
  /**
   * Track session output signals from tool calls for completion contract validation.
   * Detects when agents call Linear CLI or MCP tools that produce required outputs.
   */
  private trackSessionOutputSignal(issueId: string, toolName: string, input: Record<string, unknown>): void {
    let flags = this.sessionOutputFlags.get(issueId)
    if (!flags) {
      flags = { commentPosted: false, issueUpdated: false, subIssuesCreated: false }
      this.sessionOutputFlags.set(issueId, flags)
    }

    // Detect comment creation (CLI via Bash or MCP tool)
    if (
      toolName === 'af_linear_create_comment' ||
      toolName === 'mcp__af-linear__af_linear_create_comment'
    ) {
      flags.commentPosted = true
    }

    // Detect issue update (CLI via Bash or MCP tool)
    if (
      toolName === 'af_linear_update_issue' ||
      toolName === 'mcp__af-linear__af_linear_update_issue'
    ) {
      flags.issueUpdated = true
    }

    // Detect issue creation (CLI via Bash or MCP tool)
    if (
      toolName === 'af_linear_create_issue' ||
      toolName === 'mcp__af-linear__af_linear_create_issue'
    ) {
      flags.subIssuesCreated = true
    }

    // Detect Bash tool calls that invoke the Linear CLI
    if (toolName === 'Bash') {
      const command = typeof input?.command === 'string' ? input.command : ''
      if (command.includes('af-linear create-comment') || command.includes('af-linear create_comment')) {
        flags.commentPosted = true
      }
      if (command.includes('af-linear update-issue') || command.includes('af-linear update_issue')) {
        flags.issueUpdated = true
      }
      if (command.includes('af-linear create-issue') || command.includes('af-linear create_issue')) {
        flags.subIssuesCreated = true
      }
    }
  }

  /**
   * Emit structured context entries based on completed tool calls.
   * Fire-and-forget — errors are silently ignored.
   */
  private emitToolContext(
    emitter: ActivityEmitter | ApiActivityEmitter,
    toolName: string,
    input: Record<string, unknown>,
  ): void {
    // Only ApiActivityEmitter has emitContext
    if (!('emitContext' in emitter)) return
    const api = emitter as ApiActivityEmitter

    const filePath = input.file_path ?? input.path

    switch (toolName) {
      case 'Read':
      case 'View':
      case 'cat':
        if (filePath) api.emitContext('currentFile', String(filePath))
        break

      case 'Write':
      case 'Edit':
      case 'Create':
        if (filePath) api.emitContext('lastEditedFile', String(filePath))
        break

      case 'Grep':
      case 'Search':
      case 'Glob':
      case 'Find':
        if (input.pattern) {
          api.emitContext('lastSearch', { tool: toolName, pattern: input.pattern })
        }
        break

      case 'Bash': {
        const command = typeof input.command === 'string' ? input.command : ''
        if (!command) break

        if (command.startsWith('git ')) {
          api.emitContext('lastGitOp', command.substring(0, 100))
        }

        const cdMatch = command.match(/\bcd\s+("[^"]+"|'[^']+'|\S+)/)
        if (cdMatch) {
          const dir = cdMatch[1].replace(/^["']|["']$/g, '')
          api.emitContext('workingDirectory', dir)
        }

        if (/\b(pnpm\s+test|npm\s+test|yarn\s+test|vitest|jest|mocha)\b/.test(command)) {
          api.emitContext('lastTestRun', { command: command.substring(0, 200) })
        }
        break
      }
    }
  }

  private extractPullRequestUrl(text: string): string | null {
    // GitHub PR URL pattern: https://github.com/owner/repo/pull/123
    const prUrlPattern = /https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/g
    const matches = text.match(prUrlPattern)
    return matches ? matches[0] : null
  }

  /**
   * Update the Linear session with the PR URL
   */
  private async updateSessionPullRequest(
    sessionId: string,
    prUrl: string,
    agent: AgentProcess
  ): Promise<void> {
    const log = this.agentLoggers.get(agent.issueId)

    // If using API activity config, call the API endpoint
    if (this.config.apiActivityConfig) {
      const { baseUrl, apiKey } = this.config.apiActivityConfig
      try {
        const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/external-urls`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            externalUrls: [{ label: 'Pull Request', url: prUrl }],
          }),
        })

        if (!response.ok) {
          const error = await response.text()
          log?.warn('Failed to update session PR URL via API', { status: response.status, error })
        } else {
          log?.info('Session PR URL updated via API')
        }
      } catch (error) {
        log?.warn('Failed to update session PR URL via API', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    } else {
      // Direct issue tracker API - use session if available
      const session = this.agentSessions.get(agent.issueId)
      if (session) {
        try {
          await session.setPullRequestUrl(prUrl)
          log?.info('Session PR URL updated via Linear API')
        } catch (error) {
          log?.warn('Failed to update session PR URL via Linear API', {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
  }

  /**
   * Post completion comment with full result message
   * Uses multi-comment splitting for long messages (up to 10 comments, 10k chars each)
   */
  private async postCompletionComment(
    issueId: string,
    sessionId: string | undefined,
    resultMessage: string,
    log?: Logger
  ): Promise<void> {
    // Build completion comments with multi-part splitting
    const comments = this.client.buildCompletionComments(
      resultMessage,
      [], // No plan items to include (already shown via activities)
      sessionId ?? null
    )

    log?.info('Posting completion comment', {
      parts: comments.length,
      totalLength: resultMessage.length,
    })

    // If using API activity config, call the API endpoint
    if (this.config.apiActivityConfig) {
      const { baseUrl, apiKey } = this.config.apiActivityConfig
      try {
        const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/completion`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            summary: resultMessage,
          }),
        })

        if (!response.ok) {
          const error = await response.text()
          log?.warn('Failed to post completion comment via API', { status: response.status, error })
        } else {
          log?.info('Completion comment posted via API')
        }
      } catch (error) {
        log?.warn('Failed to post completion comment via API', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    } else {
      // Direct Linear API - post comments sequentially
      for (const chunk of comments) {
        try {
          await this.client.createComment(issueId, chunk.body)
          log?.info(`Posted completion comment part ${chunk.partNumber}/${chunk.totalParts}`)
          // Small delay between comments to ensure ordering
          if (chunk.partNumber < chunk.totalParts) {
            await new Promise(resolve => setTimeout(resolve, 100))
          }
        } catch (error) {
          log?.error(`Failed to post completion comment part ${chunk.partNumber}`, {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
  }

  /**
   * Clean up agent resources
   */
  private cleanupAgent(issueId: string, sessionId?: string): void {
    this.agentHandles.delete(issueId)
    this.agentSessions.delete(issueId)
    this.activityEmitters.delete(issueId)
    this.abortControllers.delete(issueId)
    this.agentLoggers.delete(issueId)
    const buf = this.assistantTextBuffers.get(issueId)
    if (buf?.timer) clearTimeout(buf.timer)
    this.assistantTextBuffers.delete(issueId)

    // Stop heartbeat writer
    const heartbeatWriter = this.heartbeatWriters.get(issueId)
    if (heartbeatWriter) {
      heartbeatWriter.stop()
      this.heartbeatWriters.delete(issueId)
    }

    // Stop progress logger
    const progressLogger = this.progressLoggers.get(issueId)
    if (progressLogger) {
      progressLogger.stop()
      this.progressLoggers.delete(issueId)
    }

    // Cleanup session output flags
    this.sessionOutputFlags.delete(issueId)

    // Cleanup stored spawn config used for steering retries
    this.steeringSpawnConfigs.delete(issueId)

    // Persist and cleanup context manager
    const contextManager = this.contextManagers.get(issueId)
    if (contextManager) {
      try {
        contextManager.persist()
      } catch {
        // Ignore persistence errors during cleanup
      }
      this.contextManagers.delete(issueId)
    }

    this.pendingToolCalls.delete(issueId)

    // Session logger is cleaned up separately (in finalizeSessionLogger)
    // to ensure the final status is captured before cleanup
    this.sessionLoggers.delete(issueId)

    if (sessionId) {
      this.sessionToIssue.delete(sessionId)
    }
  }

  /**
   * Finalize the session logger with final status
   */
  private finalizeSessionLogger(
    issueId: string,
    status: 'completed' | 'failed' | 'stopped',
    options?: { errorMessage?: string; pullRequestUrl?: string }
  ): void {
    const sessionLogger = this.sessionLoggers.get(issueId)
    if (sessionLogger) {
      sessionLogger.finalize(status, options)
    }
  }

  /**
   * Run the orchestrator - spawn agents for backlog issues
   */
  async run(): Promise<OrchestratorResult> {
    const issues = await this.getBacklogIssues()
    const result: OrchestratorResult = {
      success: true,
      agents: [],
      errors: [],
    }

    if (issues.length === 0) {
      console.log('No backlog issues found')
      return result
    }

    console.log(`Found ${issues.length} backlog issue(s)`)

    for (const issue of issues) {
      this.events.onIssueSelected?.(issue)
      console.log(`Processing: ${issue.identifier} - ${issue.title}`)

      try {
        // Detect work type from issue status
        const workType = await this.detectWorkType(issue.id, 'Backlog')

        // Create worktree with work type suffix
        const { worktreePath, worktreeIdentifier } = this.createWorktree(issue.identifier, workType)

        // Sync and link dependencies from main repo into worktree
        this.syncDependencies(worktreePath, issue.identifier)

        const startStatus = this.statusMappings.workTypeStartStatus[workType]

        // Update issue status based on work type if auto-transition is enabled
        if (this.config.autoTransition && startStatus) {
          await this.client.updateIssueStatus(issue.id, startStatus)
          console.log(`Updated ${issue.identifier} status to ${startStatus}`)
        }

        // Spawn agent with generated session ID for autonomous mode
        const agent = this.spawnAgent({
          issueId: issue.id,
          identifier: issue.identifier,
          worktreeIdentifier,
          sessionId: randomUUID(),
          worktreePath,
          workType,
          teamName: issue.teamName,
          projectName: issue.projectName,
          labels: issue.labels,
        })

        result.agents.push(agent)
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))
        result.errors.push({ issueId: issue.id, error: err })
        console.error(`Failed to process ${issue.identifier}:`, err.message)
      }
    }

    result.success = result.errors.length === 0

    return result
  }

  /**
   * Spawn agent for a single issue (webhook-triggered or CLI)
   * Generates a session ID if not provided to enable autonomous mode
   *
   * This method includes crash recovery support:
   * - If a worktree exists with valid state and stale heartbeat, triggers recovery
   * - If a worktree exists with fresh heartbeat (agent alive), throws error to prevent duplicates
   *
   * @param issueIdOrIdentifier - Issue ID or identifier (e.g., SUP-123)
   * @param sessionId - Optional Linear session ID
   * @param workType - Optional work type (auto-detected from issue status if not provided)
   * @param prompt - Optional custom prompt override
   */
  async spawnAgentForIssue(
    issueIdOrIdentifier: string,
    sessionId?: string,
    workType?: AgentWorkType,
    prompt?: string,
    extra?: { dispatchModel?: string; dispatchSubAgentModel?: string }
  ): Promise<AgentProcess> {
    console.log(`Fetching issue:`, issueIdOrIdentifier)
    const issue = await this.client.getIssue(issueIdOrIdentifier)
    const identifier = issue.identifier
    const issueId = issue.id // Use the actual UUID
    const teamName = issue.teamName

    // Labels for provider resolution (pre-resolved by IssueTrackerClient)
    const labelNames = issue.labels

    // Resolve project name for path scoping in monorepos
    let projectName: string | undefined
    if (this.projectPaths) {
      projectName = issue.projectName
    }

    console.log(`Processing single issue: ${identifier} (${issueId}) - ${issue.title}`)

    // Guard: skip work if the issue has moved to a terminal status since being queued
    const currentStatus = issue.status
    if (currentStatus && (this.statusMappings.terminalStatuses as readonly string[]).includes(currentStatus)) {
      throw new Error(
        `Issue ${identifier} is in terminal status '${currentStatus}' — skipping ${workType ?? 'auto'} work. ` +
        `The issue was likely accepted/canceled after being queued.`
      )
    }

    // Guard: skip sub-issues that should be managed by a coordinator, not spawned independently.
    // Only applies when no explicit work type is provided (i.e., orchestrator auto-pickup).
    // Coordinators spawning sub-agents always pass an explicit work type, so they bypass this check.
    if (!workType) {
      try {
        const isChild = await this.client.isChildIssue(issueId)
        if (isChild) {
          throw new Error(
            `Issue ${identifier} is a sub-issue managed by a parent agent — skipping independent pickup. ` +
            `Sub-issues should only be processed by their parent issue's agent.`
          )
        }
      } catch (err) {
        // Re-throw our own guard error; swallow API errors so we don't block on transient failures
        if (err instanceof Error && err.message.includes('managed by a parent agent')) {
          throw err
        }
        console.warn(`Failed to check child status for ${identifier}:`, err)
      }
    }

    // Defense in depth: re-validate git remote before spawning (guards against long-running instances)
    if (this.config.repository) {
      validateGitRemote(this.config.repository, this.gitRoot)
    }

    // Auto-detect work type from issue status if not provided
    // This must happen BEFORE creating worktree since path includes work type suffix
    let effectiveWorkType = workType
    if (!effectiveWorkType) {
      const statusName = issue.status ?? 'Backlog'
      effectiveWorkType = await this.detectWorkType(issueId, statusName)
    } else {
      // Re-validate work type from issue status in case the caller had a stale value.
      try {
        const revalidated = detectWorkTypeHelper(issue.status ?? 'Backlog', false, this.statusMappings.statusToWorkType)
        if (revalidated !== effectiveWorkType) {
          console.log(`Re-validated work type from ${effectiveWorkType} to ${revalidated}`)
          effectiveWorkType = revalidated
        }
      } catch (err) {
        console.warn(`Failed to re-validate work type:`, err)
      }
    }

    // Create isolated worktree for the agent
    let worktreePath: string | undefined
    let worktreeIdentifier: string | undefined

    if (this.statusMappings.workTypesRequiringWorktree.has(effectiveWorkType)) {
      const wt = this.createWorktree(identifier, effectiveWorkType)
      worktreePath = wt.worktreePath
      worktreeIdentifier = wt.worktreeIdentifier

      // Sync and link dependencies from main repo into worktree
      this.syncDependencies(worktreePath, identifier)

      // Check for existing state and potential recovery.
      // Pass `expectedIdentifier` so a worktree holding stale state from a
      // DIFFERENT issue (e.g., a reused path after a template change) can't
      // trigger a cross-issue recovery. The conflict-check call site at
      // cleanupConflictingBranch intentionally omits this option.
      const recoveryCheck = checkRecovery(worktreePath, {
        heartbeatTimeoutMs: getHeartbeatTimeoutFromEnv(),
        maxRecoveryAttempts: getMaxRecoveryAttemptsFromEnv(),
        expectedIdentifier: identifier,
      })

      if (recoveryCheck.agentAlive) {
        // Agent is still running - prevent duplicate
        throw new Error(
          `Agent already running for ${identifier}: ${recoveryCheck.message}. ` +
          `Stop the existing agent before spawning a new one.`
        )
      }

      if (recoveryCheck.reason === 'identifier_mismatch') {
        // Stale state from a different issue. Log loudly so this is visible
        // in ops — but don't fail; fall through to fresh spawn, which will
        // overwrite state.json with the current issue's identifier.
        console.warn(
          `[orchestrator] ${identifier}: worktree ${worktreePath} held stale state ` +
          `for ${recoveryCheck.state?.issueIdentifier} — refusing cross-issue recovery, starting fresh`
        )
      }

      if (recoveryCheck.canRecover && recoveryCheck.state) {
        // Crashed agent detected - trigger recovery
        console.log(`Recovery detected for ${identifier}: ${recoveryCheck.message}`)

        // Increment recovery attempts in state
        const updatedState = updateState(worktreePath, {
          recoveryAttempts: (recoveryCheck.state.recoveryAttempts ?? 0) + 1,
        })

        // Build recovery prompt
        const recoveryPrompt = prompt ?? buildRecoveryPrompt(recoveryCheck.state, recoveryCheck.todos)

        // Inherit work type from previous state if not provided
        const recoveryWorkType = workType ?? recoveryCheck.state.workType ?? effectiveWorkType

        // Use existing provider session ID for resume if available,
        // but clear it when the work type or provider has changed.
        // A session from a different work type or provider cannot be resumed —
        // attempting it produces errors and wastes the recovery attempt.
        const workTypeChanged = recoveryWorkType !== recoveryCheck.state.workType

        // Resolve which provider will handle this recovery to detect provider switches
        // (e.g., previous run was Claude but labels now route to Codex)
        const { name: recoveryProviderName } = resolveProviderWithSource({
          project: projectName,
          workType: recoveryWorkType,
          labels: labelNames,
          configProviders: this.configProviders,
        })
        const providerChanged = recoveryCheck.state.providerName != null &&
          recoveryProviderName !== recoveryCheck.state.providerName

        const shouldClearSession = workTypeChanged || providerChanged
        const providerSessionId = shouldClearSession
          ? undefined
          : (recoveryCheck.state.providerSessionId ?? undefined)
        if (shouldClearSession && recoveryCheck.state.providerSessionId) {
          const reason = providerChanged
            ? `provider changed from ${recoveryCheck.state.providerName} to ${recoveryProviderName}`
            : `work type changed from ${recoveryCheck.state.workType} to ${recoveryWorkType}`
          console.log(`Clearing stale providerSessionId — ${reason}`)
          updateState(worktreePath, { providerSessionId: null })
        }
        const effectiveSessionId = sessionId ?? recoveryCheck.state.linearSessionId ?? randomUUID()

        console.log(`Resuming work on ${identifier} (recovery attempt ${updatedState?.recoveryAttempts ?? 1})`)

        // Update status based on work type if auto-transition is enabled
        const startStatus = this.statusMappings.workTypeStartStatus[recoveryWorkType]
        if (this.config.autoTransition && startStatus) {
          await this.client.updateIssueStatus(issueId, startStatus)
          console.log(`Updated ${identifier} status to ${startStatus}`)
        }

        // Spawn with resume capability
        return this.spawnAgentWithResume({
          issueId,
          identifier,
          worktreeIdentifier,
          sessionId: effectiveSessionId,
          worktreePath,
          prompt: recoveryPrompt,
          providerSessionId,
          workType: recoveryWorkType,
          teamName,
          projectName,
          labels: labelNames,
        })
      }
    }

    // No recovery needed - proceed with fresh spawn
    // Update status based on work type if auto-transition is enabled
    const startStatus = this.statusMappings.workTypeStartStatus[effectiveWorkType]
    if (this.config.autoTransition && startStatus) {
      await this.client.updateIssueStatus(issueId, startStatus)
      console.log(`Updated ${identifier} status to ${startStatus}`)
    }

    // Generate session ID if not provided to enable autonomous mode
    // This ensures LINEAR_SESSION_ID is always set, triggering headless operation
    const effectiveSessionId = sessionId ?? randomUUID()

    // Spawn agent with work type and optional custom prompt
    return this.spawnAgent({
      issueId,
      identifier,
      worktreeIdentifier,
      sessionId: effectiveSessionId,
      worktreePath,
      workType: effectiveWorkType,
      prompt,
      teamName,
      projectName,
      labels: labelNames,
      dispatchModel: extra?.dispatchModel,
      dispatchSubAgentModel: extra?.dispatchSubAgentModel,
    })
  }

  /**
   * Get the merge queue adapter, if configured.
   * Returns undefined if no merge queue is enabled.
   */
  getMergeQueueAdapter(): import('../merge-queue/types.js').MergeQueueAdapter | undefined {
    return this.mergeQueueAdapter
  }

  /**
   * Get all active agents
   */
  getActiveAgents(): AgentProcess[] {
    return Array.from(this.activeAgents.values()).filter(
      (a) => a.status === 'running' || a.status === 'starting'
    )
  }

  /**
   * Stop a running agent by issue ID
   * @param issueId - The Linear issue ID
   * @param cleanupWorktree - Whether to remove the git worktree
   * @param stopReason - Why the agent is being stopped: 'user_request' or 'timeout'
   */
  async stopAgent(
    issueId: string,
    cleanupWorktree = false,
    stopReason: 'user_request' | 'timeout' = 'user_request'
  ): Promise<StopAgentResult> {
    const agent = this.activeAgents.get(issueId)
    if (!agent) {
      return { stopped: false, reason: 'not_found' }
    }

    if (agent.status !== 'running' && agent.status !== 'starting') {
      return { stopped: false, reason: 'already_stopped', agent }
    }

    const abortController = this.abortControllers.get(issueId)
    if (!abortController) {
      return { stopped: false, reason: 'not_found', agent }
    }

    const log = this.agentLoggers.get(issueId)

    try {
      // Emit final activity before stopping
      const emitter = this.activityEmitters.get(issueId)
      if (emitter) {
        try {
          const message = stopReason === 'user_request'
            ? 'Agent stopped by user request.'
            : 'Agent stopped due to timeout.'
          await emitter.emitResponse(message)
          await emitter.flush()
        } catch (emitError) {
          log?.warn('Failed to emit stop activity', {
            error: emitError instanceof Error ? emitError.message : String(emitError),
          })
        }
      }

      // Mark as stopped with reason before aborting
      agent.status = 'stopped'
      agent.stopReason = stopReason
      agent.completedAt = new Date()

      // Abort the query
      abortController.abort()

      // Clean up worktree if requested (only if agent has a worktree)
      if (cleanupWorktree && agent.worktreeIdentifier) {
        this.removeWorktree(agent.worktreeIdentifier)
      }

      const logMessage = stopReason === 'user_request'
        ? 'Agent stopped by user request'
        : 'Agent stopped due to timeout'
      log?.status('stopped', logMessage)
      return { stopped: true, agent }
    } catch (error) {
      log?.warn('Failed to stop agent', {
        error: error instanceof Error ? error.message : String(error),
      })
      return { stopped: false, reason: 'signal_failed', agent }
    }
  }

  /**
   * Stop a running agent by session ID
   */
  async stopAgentBySession(sessionId: string, cleanupWorktree = false): Promise<StopAgentResult> {
    const issueId = this.sessionToIssue.get(sessionId)
    if (!issueId) {
      return { stopped: false, reason: 'not_found' }
    }

    return this.stopAgent(issueId, cleanupWorktree)
  }

  /**
   * Get agent by session ID
   */
  getAgentBySession(sessionId: string): AgentProcess | undefined {
    const issueId = this.sessionToIssue.get(sessionId)
    if (!issueId) return undefined
    return this.activeAgents.get(issueId)
  }

  /**
   * Update the worker ID for all active activity emitters.
   * Called after worker re-registration to ensure activities are attributed
   * to the new worker ID and pass ownership checks.
   *
   * @param newWorkerId - The new worker ID after re-registration
   */
  updateWorkerId(newWorkerId: string): void {
    // Update the config for any future emitters
    if (this.config.apiActivityConfig) {
      this.config.apiActivityConfig.workerId = newWorkerId
    }

    // Update all existing activity emitters
    for (const [issueId, emitter] of this.activityEmitters.entries()) {
      // Only ApiActivityEmitter has updateWorkerId method
      if ('updateWorkerId' in emitter && typeof emitter.updateWorkerId === 'function') {
        emitter.updateWorkerId(newWorkerId)
        console.log(`[Orchestrator] Updated worker ID for emitter ${issueId}`)
      }
    }
  }

  /**
   * Forward a follow-up prompt to an existing or new agent
   *
   * If the agent is running, attempts to inject the message into the running session
   * without stopping it. If injection fails or agent isn't running, it will be
   * stopped gracefully and resumed with the new prompt.
   *
   * @param workType - Optional work type. If not provided, inherits from existing agent or defaults to 'development'.
   */
  async forwardPrompt(
    issueId: string,
    sessionId: string,
    prompt: string,
    providerSessionId?: string,
    workType?: AgentWorkType
  ): Promise<ForwardPromptResult> {
    const existingAgent = this.activeAgents.get(issueId)

    // If agent is running, try to inject the message without stopping
    if (existingAgent && (existingAgent.status === 'running' || existingAgent.status === 'starting')) {
      const injectResult = await this.injectMessage(issueId, sessionId, prompt)

      if (injectResult.injected) {
        console.log(`Message injected into running agent for ${existingAgent.identifier}`)
        return {
          forwarded: true,
          resumed: false,
          injected: true,
          agent: existingAgent,
        }
      }

      // Injection failed - fall back to stop and respawn
      console.log(`Message injection failed for ${existingAgent.identifier}: ${injectResult.reason} - stopping and respawning`)
      await this.stopAgent(issueId, false) // Don't cleanup worktree
    }

    // Get worktree path from existing agent or create new one
    let worktreePath: string | undefined
    let worktreeIdentifier: string | undefined
    let identifier: string
    let teamName: string | undefined

    if (existingAgent) {
      worktreePath = existingAgent.worktreePath
      worktreeIdentifier = existingAgent.worktreeIdentifier
      identifier = existingAgent.identifier
      // Use existing provider session ID if not provided
      providerSessionId = providerSessionId ?? existingAgent.providerSessionId
      // Inherit work type from existing agent if not provided
      workType = workType ?? existingAgent.workType
    } else {
      // Need to fetch issue to get identifier
      try {
        const issue = await this.client.getIssue(issueId)
        identifier = issue.identifier
        teamName = issue.teamName

        // Guard: skip work if the issue has moved to a terminal status since being queued
        const currentStatus = issue.status
        if (currentStatus && (this.statusMappings.terminalStatuses as readonly string[]).includes(currentStatus)) {
          console.log(`Issue ${identifier} is in terminal status '${currentStatus}' — skipping work`)
          return {
            forwarded: false,
            resumed: false,
            reason: 'terminal_status',
          }
        }

        // Auto-detect work type from issue status if not provided
        // This prevents defaulting to 'development' which would cause
        // incorrect status transitions (e.g., Delivered → Started for acceptance work)
        if (!workType) {
          const statusName = currentStatus ?? 'Backlog'
          workType = await this.detectWorkType(issue.id, statusName)
        }

        // Create isolated worktree for the agent
        if (this.statusMappings.workTypesRequiringWorktree.has(workType)) {
          const result = this.createWorktree(identifier, workType)
          worktreePath = result.worktreePath
          worktreeIdentifier = result.worktreeIdentifier

          // Sync and link dependencies from main repo into worktree
          this.syncDependencies(worktreePath, identifier)
        }
      } catch (error) {
        return {
          forwarded: false,
          resumed: false,
          reason: 'not_found',
          error: error instanceof Error ? error : new Error(String(error)),
        }
      }
    }

    // Check if worktree exists (only relevant for code work types)
    const effectiveWorkType = workType ?? 'development'
    if (this.statusMappings.workTypesRequiringWorktree.has(effectiveWorkType) && worktreePath && !existsSync(worktreePath)) {
      try {
        const result = this.createWorktree(identifier, effectiveWorkType)
        worktreePath = result.worktreePath
        worktreeIdentifier = result.worktreeIdentifier

        // Sync and link dependencies from main repo into worktree
        this.syncDependencies(worktreePath, identifier)
      } catch (error) {
        return {
          forwarded: false,
          resumed: false,
          reason: 'no_worktree',
          error: error instanceof Error ? error : new Error(String(error)),
        }
      }
    }

    // Spawn agent with resume if we have a provider session ID
    try {
      const agent = await this.spawnAgentWithResume({
        issueId,
        identifier,
        worktreeIdentifier,
        sessionId,
        worktreePath,
        prompt,
        providerSessionId,
        workType,
        teamName,
        mentionContext: prompt,
      })

      return {
        forwarded: true,
        resumed: !!providerSessionId,
        agent,
      }
    } catch (error) {
      return {
        forwarded: false,
        resumed: false,
        reason: 'spawn_failed',
        error: error instanceof Error ? error : new Error(String(error)),
      }
    }
  }

  /**
   * Inject a user message into a running agent session without stopping it.
   *
   * Uses the SDK's streamInput() method to send follow-up messages to a running session.
   * This is the preferred method for user follow-ups as it doesn't interrupt agent work.
   *
   * @param issueId - The issue ID the agent is working on
   * @param sessionId - The Linear session ID
   * @param message - The user message to inject
   * @returns Result indicating if injection was successful
   */
  async injectMessage(
    issueId: string,
    sessionId: string,
    message: string
  ): Promise<InjectMessageResult> {
    const log = this.agentLoggers.get(issueId)
    const agent = this.activeAgents.get(issueId)
    const handle = this.agentHandles.get(issueId)

    // Check if agent is running
    if (!agent || (agent.status !== 'running' && agent.status !== 'starting')) {
      return {
        injected: false,
        reason: 'not_running',
      }
    }

    // Check if we have the handle
    if (!handle) {
      log?.warn('No AgentHandle found for running agent', { issueId, sessionId })
      return {
        injected: false,
        reason: 'no_query',
      }
    }

    try {
      // Inject the message into the running session via provider handle
      log?.info('Injecting user message into running session', {
        issueId,
        sessionId,
        messageLength: message.length,
      })

      await handle.injectMessage(message)

      // Update activity timestamp since we just interacted with the agent
      agent.lastActivityAt = new Date()

      log?.success('Message injected successfully')

      return {
        injected: true,
      }
    } catch (error) {
      log?.error('Failed to inject message', {
        error: error instanceof Error ? error.message : String(error),
      })

      return {
        injected: false,
        reason: 'injection_failed',
        error: error instanceof Error ? error : new Error(String(error)),
      }
    }
  }

  /**
   * Spawn an agent with resume capability for continuing a previous session
   * If autoTransition is enabled, also transitions the issue status to the appropriate working state
   */
  async spawnAgentWithResume(options: SpawnAgentWithResumeOptions): Promise<AgentProcess> {
    const { issueId, identifier, worktreeIdentifier, sessionId, worktreePath, prompt, providerSessionId, workType, teamName, labels, mentionContext, dispatchModel, dispatchSubAgentModel } = options

    // Resolve provider (and full profile when profiles are configured)
    const { provider: spawnProvider, providerName: spawnProviderName, source: providerSource, resolvedProfile } =
      this.resolveProviderForSpawn({ workType, projectName: options.projectName, labels, mentionContext, dispatchModel, dispatchSubAgentModel })

    // Extract model and effort from profile or legacy resolution
    let resolvedModel: string | undefined
    let resolvedEffort: import('../config/profiles.js').EffortLevel | undefined
    let resolvedProviderConfig: Record<string, unknown> | undefined

    if (resolvedProfile) {
      resolvedModel = resolvedProfile.model
      resolvedEffort = resolvedProfile.effort
      resolvedProviderConfig = resolvedProfile.providerConfig
    } else {
      const { model, source: modelSource } = resolveModelWithSource({
        dispatchModel,
        labels,
        workType,
        project: options.projectName,
        configModels: this.configModels,
      })
      resolvedModel = model
    }

    // Create logger for this agent
    const log = createLogger({ issueIdentifier: identifier })
    this.agentLoggers.set(issueId, log)

    if (resolvedModel) {
      log.info('Model resolved for resume', { model: resolvedModel, source: providerSource, effort: resolvedEffort })
    }

    // Use the work type to determine if we need to transition on start
    // Only certain work types trigger a start transition
    const effectiveWorkType = workType ?? 'development'
    const startStatus = this.statusMappings.workTypeStartStatus[effectiveWorkType]

    if (this.config.autoTransition && startStatus) {
      try {
        await this.client.updateIssueStatus(issueId, startStatus)
        log.info('Transitioned issue status on resume', { workType: effectiveWorkType, to: startStatus })
      } catch (error) {
        // Log but don't fail - status might already be in a working state
        log.warn('Failed to transition issue status', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const now = new Date()
    const agent: AgentProcess = {
      issueId,
      identifier,
      worktreeIdentifier,
      sessionId,
      providerSessionId,
      worktreePath,
      pid: undefined,
      status: 'starting',
      startedAt: now,
      lastActivityAt: now, // Initialize for inactivity tracking
      workType,
      providerName: spawnProviderName,
    }

    this.activeAgents.set(issueId, agent)

    // Track session to issue mapping for stop signal handling
    this.sessionToIssue.set(sessionId, issueId)

    // Initialize state persistence and monitoring (only for worktree-based agents)
    if (worktreePath) {
      try {
        // Write/update state with resume info
        const initialState = createInitialState({
          issueId,
          issueIdentifier: identifier,
          linearSessionId: sessionId,
          workType: effectiveWorkType,
          prompt,
          workerId: this.config.apiActivityConfig?.workerId ?? null,
          pid: null, // Will be updated when process spawns
        })
        // Preserve provider session ID if resuming
        if (providerSessionId) {
          initialState.providerSessionId = providerSessionId
        }
        // Track which provider was used so recovery can detect provider changes
        initialState.providerName = spawnProviderName
        writeState(worktreePath, initialState)

        // Start heartbeat writer for crash detection
        const heartbeatWriter = createHeartbeatWriter({
          agentDir: resolve(worktreePath, '.agent'),
          pid: process.pid, // Will be updated to child PID after spawn
          intervalMs: getHeartbeatIntervalFromEnv(),
          startTime: now.getTime(),
        })
        heartbeatWriter.start()
        this.heartbeatWriters.set(issueId, heartbeatWriter)

        // Start progress logger for debugging
        const progressLogger = createProgressLogger({
          agentDir: resolve(worktreePath, '.agent'),
        })
        progressLogger.logStart({ issueId, workType: effectiveWorkType, prompt: prompt.substring(0, 200) })
        this.progressLoggers.set(issueId, progressLogger)

        // Start session logger for verbose analysis if enabled
        if (isSessionLoggingEnabled()) {
          const logConfig = getLogAnalysisConfig()
          const sessionLogger = createSessionLogger({
            sessionId,
            issueId,
            issueIdentifier: identifier,
            workType: effectiveWorkType,
            prompt,
            logsDir: logConfig.logsDir,
            workerId: this.config.apiActivityConfig?.workerId,
          })
          this.sessionLoggers.set(issueId, sessionLogger)
          log.debug('Session logging initialized', { logsDir: logConfig.logsDir })
        }

        // Initialize context manager for context window management
        const contextManager = ContextManager.load(worktreePath)
        this.contextManagers.set(issueId, contextManager)

        log.debug('State persistence initialized', { agentDir: resolve(worktreePath, '.agent') })
      } catch (stateError) {
        // Log but don't fail - state persistence is optional
        log.warn('Failed to initialize state persistence', {
          error: stateError instanceof Error ? stateError.message : String(stateError),
        })
      }
    }

    this.events.onAgentStart?.(agent)

    // Set up activity streaming
    let emitter: ActivityEmitter | ApiActivityEmitter

    // Check if we should use API-based activity emitter (for remote workers)
    if (this.config.apiActivityConfig) {
      const { baseUrl, apiKey, workerId } = this.config.apiActivityConfig
      log.debug('Using API activity emitter', { baseUrl })

      emitter = createApiActivityEmitter({
        sessionId,
        workerId,
        apiBaseUrl: baseUrl,
        apiKey,
        minInterval: this.config.streamConfig.minInterval,
        maxOutputLength: this.config.streamConfig.maxOutputLength,
        includeTimestamps: this.config.streamConfig.includeTimestamps,
        onActivityEmitted: (type, content) => {
          log.activity(type, content)
        },
        onActivityError: (type, error) => {
          log.error(`Activity error (${type})`, { error: error.message })
        },
      })
    } else {
      // Direct issue tracker API
      const session = this.client.createSession({
        issueId,
        sessionId,
        autoTransition: false,
      })
      this.agentSessions.set(issueId, session)

      emitter = createActivityEmitter({
        session,
        minInterval: this.config.streamConfig.minInterval,
        maxOutputLength: this.config.streamConfig.maxOutputLength,
        includeTimestamps: this.config.streamConfig.includeTimestamps,
        onActivityEmitted: (type, content) => {
          log.activity(type, content)
        },
      })
    }
    this.activityEmitters.set(issueId, emitter)

    // Create AbortController for cancellation
    const abortController = new AbortController()
    this.abortControllers.set(issueId, abortController)

    // Load environment from settings.local.json and app .env files.
    // Pass the main repo root so these functions can find gitignored files.
    const envBaseDir = worktreePath ?? process.cwd()
    const settingsEnv = loadSettingsEnv(envBaseDir, log, this.gitRoot)
    const effectiveWorkTypeForEnv = workType ?? 'development'
    const appEnv = loadAppEnvFiles(envBaseDir, effectiveWorkTypeForEnv, log, this.gitRoot)

    // Build environment variables - inherit ALL from process.env (required for node to be found)
    // Then overlay app env vars, settings.local.json env vars, then our specific vars
    // Apply the same blocklist as spawnAgent() to prevent API key leakage
    const processEnvFiltered: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string' && !AGENT_ENV_BLOCKLIST.includes(key)) {
        processEnvFiltered[key] = value
      }
    }

    const filteredAppEnv = Object.fromEntries(
      Object.entries(appEnv).filter(([key]) => !AGENT_ENV_BLOCKLIST.includes(key))
    )
    const filteredSettingsEnv = Object.fromEntries(
      Object.entries(settingsEnv).filter(([key]) => !AGENT_ENV_BLOCKLIST.includes(key))
    )

    const env: Record<string, string> = {
      ...processEnvFiltered, // Include all parent env vars (PATH, NODE_PATH, etc.)
      ...filteredAppEnv, // Include app env vars (blocklisted keys stripped)
      ...filteredSettingsEnv, // Include settings.local.json env vars (blocklisted keys stripped)
      LINEAR_ISSUE_ID: issueId,
      LINEAR_SESSION_ID: sessionId,
      // Set work type so agent knows if it's doing QA or development work
      ...(workType && { LINEAR_WORK_TYPE: workType }),
      // Set team name so agents can use `pnpm af-linear create-issue` without --team
      ...(teamName && { LINEAR_TEAM_NAME: teamName }),
      // Pass API proxy URL and auth token so af-linear CLI can proxy through the platform API
      ...(this.config.apiActivityConfig?.baseUrl && { AGENTFACTORY_API_URL: this.config.apiActivityConfig.baseUrl }),
      ...(this.config.apiActivityConfig?.apiKey && { WORKER_AUTH_TOKEN: this.config.apiActivityConfig.apiKey }),
    }

    log.info('Starting agent via provider', {
      provider: spawnProviderName,
      source: providerSource,
      cwd: worktreePath ?? 'repo-root',
      resuming: !!providerSessionId,
      workType: workType ?? 'development',
    })

    // Create stdio MCP server configs for tool plugins (same as spawn path)
    const toolPluginContext = {
      env,
      cwd: worktreePath ?? process.cwd(),
      ...(this.config.fileReservation ? { fileReservation: this.config.fileReservation } : {}),
    }
    const stdioServers = this.toolRegistry.getPlugins().length > 0
      ? this.toolRegistry.createStdioServerConfigs(toolPluginContext)
      : undefined

    // Coordinators need significantly more turns than standard agents
    const resolvedWorkType = workType ?? 'development'
    const needsMoreTurns = resolvedWorkType === 'development' || resolvedWorkType === 'inflight' || resolvedWorkType === 'qa' || resolvedWorkType === 'acceptance' || resolvedWorkType === 'refinement-coordination'
    const maxTurns = needsMoreTurns ? 200 : undefined

    // Build code intelligence and tool plugin flags
    const hasCodeIntel = this.toolRegistry.getPlugins().some(p => p.name === 'af-code-intelligence')
    const supportsToolPlugins = (spawnProvider.capabilities.supportsToolPlugins ?? false) && this.toolRegistry.getPlugins().length > 0

    // Build base instructions and permission config for providers that need them (capability-driven)
    const baseInstructions = (spawnProvider.capabilities.needsBaseInstructions ?? false)
      ? this.buildBaseInstructions({
          workType,
          worktreePath,
          hasCodeIntelligence: hasCodeIntel,
          codeIntelEnforced: this.repoConfig?.codeIntelligence?.enforceUsage ?? false,
          useToolPlugins: supportsToolPlugins,
        })
      : undefined
    const permissionConfig = (spawnProvider.capabilities.needsPermissionConfig ?? false) && this.templateRegistry
      ? this.buildPermissionConfig(workType)
      : undefined

    // Resolve systemPrompt append from RepositoryConfig for Claude provider
    const systemPromptAppendSections: string[] = []
    if (this.repoConfig?.systemPrompt?.append) {
      systemPromptAppendSections.push(this.repoConfig.systemPrompt.append.trim())
    }
    if (workType && this.repoConfig?.systemPrompt?.byWorkType?.[workType]) {
      systemPromptAppendSections.push(this.repoConfig.systemPrompt.byWorkType[workType].trim())
    }
    const systemPromptAppend = systemPromptAppendSections.length > 0
      ? systemPromptAppendSections.join('\n\n')
      : undefined

    // Spawn agent via provider interface (with resume if session ID available)
    const spawnConfig: AgentSpawnConfig = {
      prompt,
      cwd: worktreePath ?? process.cwd(),
      env,
      abortController,
      autonomous: true,
      sandboxEnabled: this.config.sandboxEnabled,
      mcpToolNames: stdioServers?.toolNames,
      mcpStdioServers: stdioServers?.servers,
      maxTurns,
      model: resolvedModel,
      effort: resolvedEffort,
      providerConfig: resolvedProviderConfig,
      baseInstructions,
      permissionConfig,
      systemPromptAppend,
      onProcessSpawned: (pid) => {
        agent.pid = pid
        log.info('Agent process spawned', { pid })
      },
    }

    const handle = providerSessionId
      ? this.createResumeWithFallbackHandle(spawnProvider, providerSessionId, spawnConfig, agent, log)
      : spawnProvider.spawn(spawnConfig)

    // Retain the spawn config so post-session steering can resume with the same
    // model/effort/sandbox/env. Cleared after the backstop runs.
    this.steeringSpawnConfigs.set(issueId, spawnConfig)

    this.agentHandles.set(issueId, handle)
    agent.status = 'running'

    // Process the event stream in the background
    this.processEventStream(issueId, identifier, sessionId, handle, emitter, agent)

    return agent
  }

  /**
   * Post-session steering: if the agent exited without committing/pushing/
   * creating a PR and the provider supports session resume, re-enter the
   * session with a focused follow-up prompt so the agent can finish its own
   * work. The deterministic backstop still runs afterwards as a final safety
   * net — this just reduces how often it needs to auto-commit on the agent's
   * behalf.
   *
   * No-ops (returns immediately) when steering preconditions aren't met.
   */
  private async attemptSessionSteering(agent: AgentProcess, log: Logger | undefined): Promise<void> {
    const issueId = agent.issueId
    if (!agent.worktreePath) return

    const provider = agent.providerName ? this.providerCache.get(agent.providerName) : undefined
    const gitState = inspectGitStateForSteering(agent.worktreePath)
    const decision = decideSteering({ agent, provider, gitState })

    if (!decision.shouldAttempt) {
      log?.debug('Session steering skipped', { reason: decision.reason })
      return
    }

    const baseSpawnConfig = this.steeringSpawnConfigs.get(issueId)
    if (!baseSpawnConfig) {
      log?.debug('Session steering skipped', { reason: 'no stored spawn config' })
      return
    }

    log?.warn('Attempting session steering retry', {
      reason: decision.reason,
      provider: provider!.name,
      providerSessionId: agent.providerSessionId,
    })

    const steeringPrompt = buildSteeringPrompt({
      identifier: agent.identifier,
      gitState,
      hasPr: !!agent.pullRequestUrl,
    })

    const outcome = await runSteeringRetry({
      provider: provider!,
      providerSessionId: agent.providerSessionId!,
      baseSpawnConfig,
      steeringPrompt,
    })

    // Capture any PR URL the agent created during the retry
    if (outcome.detectedPrUrl && !agent.pullRequestUrl) {
      agent.pullRequestUrl = outcome.detectedPrUrl
    }

    log?.info('Session steering result', {
      reason: outcome.reason,
      succeeded: outcome.succeeded,
      detectedPrUrl: outcome.detectedPrUrl,
      eventsConsumed: outcome.eventsConsumed,
      error: outcome.error,
    })
  }

  /**
   * Create a resume handle that falls back to a fresh spawn if the session is stale.
   * This avoids wasting a recovery attempt when the Claude Code session has expired.
   */
  private createResumeWithFallbackHandle(
    provider: AgentProvider,
    providerSessionId: string,
    spawnConfig: AgentSpawnConfig,
    agent: AgentProcess,
    log: Logger | undefined,
  ): AgentHandle {
    let currentHandle = provider.resume(providerSessionId, spawnConfig)

    const fallbackStream = async function* (): AsyncIterable<AgentEvent> {
      for await (const event of currentHandle.stream) {
        // Detect stale session error: the resume failed because the session no longer exists.
        // Claude: "No conversation found with session ID"
        // Codex: "thread/resume failed" or "thread/resume: ..."
        if (
          event.type === 'result' &&
          !event.success &&
          event.errors?.some(e =>
            e.includes('No conversation found with session ID') ||
            e.includes('thread/resume failed') ||
            e.includes('thread/resume:')
          )
        ) {
          log?.warn('Stale session detected during resume — falling back to fresh spawn', {
            staleSessionId: providerSessionId,
          })

          // Clear stale session from worktree state
          if (agent.worktreePath) {
            try {
              updateState(agent.worktreePath, { providerSessionId: null })
            } catch {
              // Ignore state update errors
            }
          }
          agent.providerSessionId = undefined

          // Spawn fresh and yield all its events instead
          currentHandle = provider.spawn(spawnConfig)
          yield* currentHandle.stream
          return
        }

        yield event
      }
    }

    return {
      get sessionId() { return currentHandle.sessionId },
      stream: fallbackStream(),
      injectMessage: (text: string) => currentHandle.injectMessage(text),
      stop: () => currentHandle.stop(),
    }
  }

  /**
   * Stop all running agents
   */
  stopAll(): void {
    this.shuttingDown = true

    for (const [issueId] of this.abortControllers) {
      try {
        const agent = this.activeAgents.get(issueId)
        if (agent) {
          agent.status = 'stopped'
          agent.completedAt = new Date()
        }
        const abortController = this.abortControllers.get(issueId)
        abortController?.abort()
      } catch (error) {
        console.warn(`Failed to stop agent for ${issueId}:`, error)
      }
    }
    this.abortControllers.clear()
    this.sessionToIssue.clear()
  }

  /**
   * Gracefully shut down all provider resources (e.g., Codex app-server processes).
   * Call after stopAll() to ensure child processes don't become orphans.
   */
  async shutdownProviders(): Promise<void> {
    const shutdownPromises: Promise<void>[] = []
    for (const [name, provider] of this.providerCache) {
      if (provider.shutdown) {
        console.log(`Shutting down ${name} provider...`)
        shutdownPromises.push(
          provider.shutdown().catch((err) => {
            console.warn(`Failed to shut down ${name} provider:`, err)
          })
        )
      }
    }
    if (shutdownPromises.length > 0) {
      await Promise.all(shutdownPromises)
    }
  }

  /**
   * Full graceful cleanup: stop all agents and shut down provider resources.
   * Use this instead of stopAll() when the fleet is exiting.
   */
  async cleanup(): Promise<void> {
    this.stopAll()
    await this.shutdownProviders()
  }

  /**
   * Wait for all agents to complete with inactivity-based timeout
   *
   * Unlike a simple session timeout, this method monitors each agent's activity
   * and only stops agents that have been inactive for longer than the inactivity
   * timeout. Active agents are allowed to run indefinitely (unless maxSessionTimeoutMs
   * is set as a hard cap).
   *
   * @param inactivityTimeoutMsOverride - Override inactivity timeout from config (for backwards compatibility)
   */
  async waitForAll(inactivityTimeoutMsOverride?: number): Promise<AgentProcess[]> {
    const activeAgents = this.getActiveAgents()

    if (activeAgents.length === 0) {
      return Array.from(this.activeAgents.values())
    }

    return new Promise((resolve) => {
      const checkInterval = setInterval(async () => {
        const stillActive = this.getActiveAgents()

        if (stillActive.length === 0) {
          clearInterval(checkInterval)
          resolve(Array.from(this.activeAgents.values()))
          return
        }

        const now = Date.now()

        // Check each agent for inactivity timeout and max session timeout
        for (const agent of stillActive) {
          // Get timeout config for this agent's work type
          const timeoutConfig = this.getTimeoutConfig(agent.workType)

          // Use override if provided (for backwards compatibility), otherwise use config
          const inactivityTimeout = inactivityTimeoutMsOverride ?? timeoutConfig.inactivityTimeoutMs
          const maxSessionTimeout = timeoutConfig.maxSessionTimeoutMs

          const log = this.agentLoggers.get(agent.issueId)
          const timeSinceLastActivity = now - agent.lastActivityAt.getTime()
          const totalRuntime = now - agent.startedAt.getTime()

          // Check max session timeout (hard cap regardless of activity)
          if (maxSessionTimeout && totalRuntime > maxSessionTimeout) {
            log?.warn('Agent reached max session timeout', {
              totalRuntime: `${Math.floor(totalRuntime / 1000)}s`,
              maxSessionTimeout: `${Math.floor(maxSessionTimeout / 1000)}s`,
            })
            await this.stopAgent(agent.issueId, false, 'timeout')
            continue
          }

          // Check inactivity timeout (agent is "hung" only if no activity)
          if (timeSinceLastActivity > inactivityTimeout) {
            log?.warn('Agent timed out due to inactivity', {
              timeSinceLastActivity: `${Math.floor(timeSinceLastActivity / 1000)}s`,
              inactivityTimeout: `${Math.floor(inactivityTimeout / 1000)}s`,
              lastActivityAt: agent.lastActivityAt.toISOString(),
            })
            await this.stopAgent(agent.issueId, false, 'timeout')
          }
        }

        // Check again if all agents are done after potential stops
        const remaining = this.getActiveAgents()
        if (remaining.length === 0) {
          clearInterval(checkInterval)
          resolve(Array.from(this.activeAgents.values()))
        }
      }, 1000)
    })
  }
}

/**
 * Create an orchestrator instance
 */
export function createOrchestrator(
  config?: OrchestratorConfig,
  events?: OrchestratorEvents
): AgentOrchestrator {
  return new AgentOrchestrator(config, events)
}
