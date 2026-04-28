/**
 * Agent Orchestrator
 * Spawns concurrent Claude agents to work on Linear backlog issues
 * Uses the Claude Agent SDK for programmatic control
 *
 * Decomposed by REN-1284 — large concerns now live in separate modules:
 *   - packages/core/src/workarea/         (git worktree ops, dep linking)
 *   - packages/core/src/orchestrator/dispatcher.ts   (work-queue routing)
 *   - packages/core/src/orchestrator/session-supervisor.ts (heartbeat / drain / reap)
 */

import { randomUUID } from 'crypto'
import { execSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
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
// ---- Decomposed modules (REN-1284) ----------------------------------------
import {
  findRepoRoot as _findRepoRoot,
  resolveMainRepoRoot as _resolveMainRepoRoot,
  resolveWorktreePath as _resolveWorktreePath,
  getWorktreeIdentifier as _getWorktreeIdentifier,
  checkForIncompleteWork as _checkForIncompleteWork,
  checkForPushedWorkWithoutPR as _checkForPushedWorkWithoutPR,
  createWorktree as _createWorktree,
  removeWorktree as _removeWorktree,
} from '../workarea/git-worktree.js'
import {
  linkDependencies as _linkDependencies,
  syncDependencies as _syncDependencies,
} from '../workarea/dep-linker.js'
import {
  detectWorkType as _detectWorkType,
  shouldDeferAcceptanceTransition as _shouldDeferAcceptanceTransition,
  extractShellCommand as _extractShellCommand,
  isGrepGlobShellCommand as _isGrepGlobShellCommand,
  isToolRelatedError as _isToolRelatedError,
  extractToolNameFromError as _extractToolNameFromError,
  mergeMentionContext as _mergeMentionContext,
  WORK_TYPE_SUFFIX,
} from './dispatcher.js'
import {
  DEFAULT_INACTIVITY_TIMEOUT_MS,
  COORDINATION_INACTIVITY_TIMEOUT_MS,
  DEFAULT_MAX_SESSION_TIMEOUT_MS,
} from './session-supervisor.js'
// ---------------------------------------------------------------------------

// Timeout constants are imported from session-supervisor.ts (REN-1284)

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
    this.gitRoot = _resolveMainRepoRoot(process.cwd()) ?? _findRepoRoot(process.cwd()) ?? process.cwd()

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

    // Coordination work types spawn foreground sub-agents via the Agent tool.
    // During sub-agent execution the parent event stream is silent (no
    // tool_progress events flow from Agent tool execution), so the standard
    // inactivity timeout would kill coordinators prematurely. Use a longer
    // default unless the user has configured a per-work-type override above.
    const isCoordination = workType === 'coordination' || workType === 'inflight-coordination'
      || workType === 'qa-coordination' || workType === 'acceptance-coordination'
      || workType === 'refinement-coordination'
    if (isCoordination) {
      return {
        inactivityTimeoutMs: Math.max(baseConfig.inactivityTimeoutMs, COORDINATION_INACTIVITY_TIMEOUT_MS),
        maxSessionTimeoutMs: baseConfig.maxSessionTimeoutMs,
      }
    }

    return baseConfig
  }

  /**
   * Detect the appropriate work type for an issue, upgrading to coordination
   * variants for parent issues that have sub-issues.
   *
   * This prevents parent issues returning to Backlog after refinement from
   * being dispatched as 'development' (which uses the wrong template and
   * produces no sub-agent orchestration).
   */
  async detectWorkType(issueId: string, statusName: string): Promise<AgentWorkType> {
    const isParent = await this.client.isParentIssue(issueId)
    return _detectWorkType(statusName, isParent, this.statusMappings.statusToWorkType)
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

  // -----------------------------------------------------------------------
  // Worktree management — thin wrappers delegating to workarea/git-worktree.ts
  // and workarea/dep-linker.ts (REN-1284 decomposition).
  // -----------------------------------------------------------------------

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
   * Write helper scripts into the worktree's .agent/ directory.
   * Called as the onCreated callback from createWorktree.
   */
  private writeWorktreeHelpers(worktreePath: string): void {
    const pm = (this.packageManager ?? 'pnpm') as PackageManager
    if (pm === 'none') return

    const addCmd = getAddCommand(pm) ?? `${pm} add`

    const agentDir = resolve(worktreePath, '.agent')
    const scriptPath = resolve(agentDir, 'add-dep.sh')
    const script = [
      '#!/bin/bash',
      '# Safe dependency addition for agents in worktrees.',
      `# Removes symlinked node_modules, then runs ${addCmd} with guard bypass.`,
      '# Usage: bash .agent/add-dep.sh <package> [--filter <workspace>]',
      'set -e',
      'if [ $# -eq 0 ]; then',
      '  echo "Usage: bash .agent/add-dep.sh <package> [--filter <workspace>]"',
      '  exit 1',
      'fi',
      'echo "Cleaning symlinked node_modules..."',
      'rm -rf node_modules',
      'for subdir in apps packages; do',
      '  [ -d "$subdir" ] && find "$subdir" -maxdepth 2 -name node_modules -type d -exec rm -rf {} + 2>/dev/null || true',
      'done',
      `echo "Installing: ${addCmd} $@"`,
      `ORCHESTRATOR_INSTALL=1 exec ${addCmd} "$@"`,
      '',
    ].join('\n')

    try {
      if (!existsSync(agentDir)) {
        mkdirSync(agentDir, { recursive: true })
      }
      writeFileSync(scriptPath, script, { mode: 0o755 })
    } catch (error) {
      console.warn(
        `Failed to write worktree helper scripts: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /**
   * Create a git worktree for an issue with work type suffix.
   * Delegates to workarea/git-worktree.ts createWorktree().
   */
  createWorktree(
    issueIdentifier: string,
    workType: AgentWorkType
  ): { worktreePath: string; worktreeIdentifier: string } {
    const result = _createWorktree({
      issueIdentifier,
      workType,
      worktreePathTemplate: this.config.worktreePath,
      gitRoot: this.gitRoot,
      packageManager: this.packageManager ?? 'pnpm',
      mergeDriverDisabled: this.repoConfig?.mergeDriver === 'default',
      qualityBaselineEnabled: false, // handled below after creation
      onCreated: (wt) => this.writeWorktreeHelpers(wt),
    })

    // Capture quality baseline after worktree is ready
    if (this.isQualityBaselineEnabled()) {
      try {
        const qualityConfig = this.buildQualityConfig()
        const baseline = captureQualityBaseline(result.worktreePath, qualityConfig)
        saveBaseline(result.worktreePath, baseline)
        console.log(`Quality baseline captured: ${baseline.tests.total} tests, ${baseline.typecheck.errorCount} type errors, ${baseline.lint.errorCount} lint errors`)
      } catch (baselineError) {
        console.warn(`Failed to capture quality baseline: ${baselineError instanceof Error ? baselineError.message : String(baselineError)}`)
      }
    }

    return result
  }

  /**
   * Clean up a git worktree.
   * Delegates to workarea/git-worktree.ts removeWorktree().
   */
  removeWorktree(worktreeIdentifier: string, deleteBranchName?: string): void {
    _removeWorktree(worktreeIdentifier, this.config.worktreePath, this.gitRoot, deleteBranchName)
  }

  /**
   * Link dependencies from the main repo into a worktree via symlinks.
   * Delegates to workarea/dep-linker.ts linkDependencies().
   */
  linkDependencies(worktreePath: string, identifier: string): void {
    _linkDependencies(worktreePath, identifier, this.packageManager ?? 'pnpm', this.gitRoot)
  }

  /**
   * Sync dependencies between worktree and main repo before linking.
   * Delegates to workarea/dep-linker.ts syncDependencies().
   */
  syncDependencies(worktreePath: string, identifier: string): void {
    _syncDependencies(worktreePath, identifier, this.packageManager ?? 'pnpm', this.gitRoot)
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
    const mergedMentionContext = _mergeMentionContext(mentionContext, customPrompt)

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
    if (workType === 'coordination' || workType === 'inflight-coordination' || workType === 'qa-coordination' || workType === 'acceptance-coordination' || workType === 'refinement-coordination') {
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
    const needsMoreTurns = workType === 'coordination' || workType === 'inflight-coordination' || workType === 'qa-coordination' || workType === 'acceptance-coordination' || workType === 'refinement-coordination' || workType === 'inflight'
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
            const cmd = _extractShellCommand(event.input)
            if (cmd && _isGrepGlobShellCommand(cmd)) {
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
        const codeProducingTypes = ['development', 'inflight', 'coordination', 'inflight-coordination']
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
        const isResultSensitive = workType === 'qa' || workType === 'acceptance' || workType === 'coordination' || workType === 'qa-coordination' || workType === 'acceptance-coordination' || workType === 'inflight-coordination' || workType === 'merge'

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
              const deferredToMergeQueue = _shouldDeferAcceptanceTransition(workType, !!this.mergeQueueAdapter)
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
          // Non-QA/acceptance: promote on completion, but validate code-producing work types first
          const isCodeProducing = workType === 'development' || workType === 'inflight'

          if (isCodeProducing && agent.worktreePath && !agent.pullRequestUrl) {
            // Code-producing agent completed without a detected PR — check for commits
            const incompleteCheck = _checkForIncompleteWork(agent.worktreePath)

            if (incompleteCheck.hasIncompleteWork) {
              // Agent has uncommitted/unpushed changes — block promotion
              // The diagnostic comment is posted in the cleanup section AFTER the
              // worktree preservation is confirmed — not here, to avoid promising
              // preservation before it actually happens.
              log?.error('Code-producing agent completed without PR and has incomplete work — blocking promotion', {
                workType,
                reason: incompleteCheck.reason,
                details: incompleteCheck.details,
              })

              // Do NOT set targetStatus — leave issue in current state
            } else {
              // Worktree is clean (no uncommitted/unpushed changes) — but check if branch
              // has commits ahead of main that should have resulted in a PR
              const hasPushedWork = _checkForPushedWorkWithoutPR(agent.worktreePath)

              if (hasPushedWork.hasPushedWork) {
                // Agent pushed commits to remote but never created a PR — block promotion
                log?.error('Code-producing agent pushed commits but no PR was created — blocking promotion', {
                  workType,
                  details: hasPushedWork.details,
                })

                try {
                  await this.client.createComment(
                    issueId,
                    `⚠️ **Agent completed and pushed code, but no PR was created.**\n\n` +
                    `${hasPushedWork.details}\n\n` +
                    `**Issue status was NOT promoted** because work cannot be reviewed without a PR.\n\n` +
                    `The branch has been pushed to the remote. To recover:\n` +
                    `\`\`\`bash\ngh pr create --head ${hasPushedWork.branch} --title "feat: <title>" --body "..."\n\`\`\`\n` +
                    `Or re-trigger the agent to complete the PR creation step.`
                  )
                } catch {
                  // Best-effort comment
                }

                // Do NOT set targetStatus — leave issue in current state
              } else {
                // No PR and no pushed commits ahead of main — genuinely clean completion
                targetStatus = this.statusMappings.workTypeCompleteStatus[workType]
              }
            }
          } else {
            targetStatus = this.statusMappings.workTypeCompleteStatus[workType]
          }
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
          (workType === 'acceptance' || workType === 'acceptance-coordination') &&
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
        const codeProducingWorkTypes = new Set(['development', 'inflight', 'coordination', 'inflight-coordination'])
        const agentWorkType = agent.workType ?? 'development'
        const isCodeProducingAgent = codeProducingWorkTypes.has(agentWorkType)

        // Validate that PR was created or work was fully pushed before cleanup
        if (shouldPreserve && isCodeProducingAgent) {
          if (!agent.pullRequestUrl) {
            // No PR detected - check for uncommitted/unpushed work
            const incompleteCheck = _checkForIncompleteWork(agent.worktreePath)

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
          const incompleteCheck = _checkForIncompleteWork(agent.worktreePath)

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
            const failedCodeProducing = new Set(['development', 'inflight', 'coordination', 'inflight-coordination'])
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

              if (_isToolRelatedError(err)) {
                const toolName = _extractToolNameFromError(err)
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
        // Detect work type — parent issues with sub-issues use coordination variants
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
            `Issue ${identifier} is a sub-issue managed by a parent coordinator — skipping independent pickup. ` +
            `Sub-issues should only be processed by their parent's coordination agent.`
          )
        }
      } catch (err) {
        // Re-throw our own guard error; swallow API errors so we don't block on transient failures
        if (err instanceof Error && err.message.includes('managed by a parent coordinator')) {
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
      // Re-validate: upgrade OR downgrade coordination variant based on fresh parent check.
      // The caller may have a stale work type from before the session was queued
      // (e.g., children deleted between queueing and processing).
      try {
        const isParent = await this.client.isParentIssue(issueId)
        const revalidated = _detectWorkType(issue.status ?? 'Backlog', isParent, this.statusMappings.statusToWorkType)
        if (revalidated !== effectiveWorkType) {
          console.log(`Re-validated work type from ${effectiveWorkType} to ${revalidated} (isParent=${isParent})`)
          effectiveWorkType = revalidated
        }
      } catch (err) {
        console.warn(`Failed to check parent status for work type re-validation:`, err)
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
    const needsMoreTurns = resolvedWorkType === 'coordination' || resolvedWorkType === 'qa-coordination' || resolvedWorkType === 'acceptance-coordination' || resolvedWorkType === 'refinement-coordination' || resolvedWorkType === 'inflight'
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
