/**
 * Agent Orchestrator
 * Spawns concurrent Claude agents to work on Linear backlog issues
 * Uses the Claude Agent SDK for programmatic control
 */

import { randomUUID } from 'crypto'
import { execSync } from 'child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'fs'
import { resolve, dirname, basename } from 'path'
import { parse as parseDotenv } from 'dotenv'
import {
  type AgentProvider,
  type AgentHandle,
  type AgentEvent,
  type AgentSpawnConfig,
  createProvider,
  resolveProviderName,
  resolveProviderWithSource,
  type AgentProviderName,
  type ProvidersConfig,
} from '../providers/index.js'
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
import { loadRepositoryConfig, getProjectConfig, getProjectPath, getProvidersConfig } from '../config/index.js'
import type { RepositoryConfig } from '../config/index.js'
import { ToolRegistry } from '../tools/index.js'
import type { ToolPlugin } from '../tools/index.js'
import type { TemplateContext } from '../templates/index.js'
import { createMergeQueueAdapter } from '../merge-queue/index.js'
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

const DEFAULT_CONFIG: Required<Omit<OrchestratorConfig, 'linearApiKey' | 'project' | 'provider' | 'streamConfig' | 'apiActivityConfig' | 'workTypeTimeouts' | 'maxSessionTimeoutMs' | 'templateDir' | 'repository' | 'issueTrackerClient' | 'statusMappings' | 'toolPlugins' | 'mergeQueueAdapter' | 'mergeQueueStorage'>> & {
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

/**
 * Load environment variables from .claude/settings.local.json
 */
function loadSettingsEnv(workDir: string, log?: Logger): Record<string, string> {
  // Walk up from workDir to find .claude/settings.local.json
  let currentDir = workDir
  let prevDir = ''

  // Keep walking up until we reach the filesystem root
  while (currentDir !== prevDir) {
    const settingsPath = resolve(currentDir, '.claude', 'settings.local.json')
    const exists = existsSync(settingsPath)

    if (exists) {
      try {
        const content = readFileSync(settingsPath, 'utf-8')
        const settings = JSON.parse(content)
        if (settings.env && typeof settings.env === 'object') {
          // Filter to only string values
          const env: Record<string, string> = {}
          for (const [key, value] of Object.entries(settings.env)) {
            if (typeof value === 'string') {
              env[key] = value
            }
          }
          log?.debug('Loaded settings.local.json', { envVars: Object.keys(env).length })
          return env
        }
      } catch (error) {
        log?.warn('Failed to load settings.local.json', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
      // File exists but has no env property — not an error
      log?.debug('settings.local.json found but contains no env property', { path: settingsPath })
      return {}
    }
    prevDir = currentDir
    currentDir = dirname(currentDir)
  }

  log?.debug('settings.local.json not found', { startDir: workDir })
  return {}
}

/**
 * Find the repository root by walking up from a directory
 * The repo root is identified by having a .git directory (not file, which worktrees have)
 */
function findRepoRoot(startDir: string): string | null {
  let currentDir = startDir
  let prevDir = ''

  while (currentDir !== prevDir) {
    const gitPath = resolve(currentDir, '.git')
    if (existsSync(gitPath)) {
      // Check if it's a directory (main repo) not a file (worktree)
      try {
        const content = readFileSync(gitPath, 'utf-8')
        // If it starts with "gitdir:", it's a worktree reference
        if (!content.startsWith('gitdir:')) {
          return currentDir
        }
      } catch {
        // If we can't read it as a file, it's a directory (main repo)
        return currentDir
      }
    }
    prevDir = currentDir
    currentDir = dirname(currentDir)
  }

  return null
}

/**
 * Resolve a worktree path template into an absolute path.
 *
 * Supports template variables:
 * - `{repoName}` → basename of the git repo root directory
 * - `{branch}` → the worktree branch/identifier name
 *
 * Relative paths are resolved against the git repo root.
 *
 * Examples:
 *   '../{repoName}.wt' + branch 'SUP-123' → '/path/to/repoName.wt/SUP-123'
 *   '.worktrees' + branch 'SUP-123' → '/path/to/repo/.worktrees/SUP-123'
 */
export function resolveWorktreePath(
  template: string,
  gitRoot: string,
  branch?: string,
): string {
  const repoName = basename(gitRoot)
  let resolved = template.replace(/\{repoName\}/g, repoName)
  if (branch !== undefined) {
    resolved = resolved.replace(/\{branch\}/g, branch)
  }
  return resolve(gitRoot, resolved)
}

/**
 * Load environment variables from app .env files based on work type
 *
 * - Development work: loads .env.local from all apps
 * - QA/Acceptance work: loads .env.test.local from all apps
 *
 * This ensures agents running in worktrees have access to database config
 * and other environment variables that are gitignored.
 */
function loadAppEnvFiles(
  workDir: string,
  workType: AgentWorkType,
  log?: Logger
): Record<string, string> {
  // Find the repo root (worktrees may be in a sibling directory or inside the repo)
  const repoRoot = findRepoRoot(workDir)
  if (!repoRoot) {
    log?.warn('Could not find repo root for env file loading', { startDir: workDir })
    return {}
  }

  const appsDir = resolve(repoRoot, 'apps')
  if (!existsSync(appsDir)) {
    log?.warn('Apps directory not found', { appsDir })
    return {}
  }

  // Determine which env file to load based on work type
  const isTestWork = workType === 'qa' || workType === 'acceptance' || workType === 'qa-coordination' || workType === 'acceptance-coordination'
  const envFileName = isTestWork ? '.env.test.local' : '.env.local'

  const env: Record<string, string> = {}
  let loadedCount = 0

  try {
    const appDirs = readdirSync(appsDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name)

    for (const appName of appDirs) {
      const envPath = resolve(appsDir, appName, envFileName)
      if (existsSync(envPath)) {
        // Parse the file without injecting into process.env (avoids dotenv log spam)
        const parsed = parseDotenv(readFileSync(envPath, 'utf-8'))
        if (parsed && Object.keys(parsed).length > 0) {
          Object.assign(env, parsed)
          loadedCount++
          log?.debug(`Loaded ${envFileName} from ${appName}`, {
            vars: Object.keys(parsed).length,
          })
        }
      }
    }

    if (loadedCount > 0) {
      log?.info(`Loaded ${envFileName} from ${loadedCount} app(s)`, {
        workType,
        totalVars: Object.keys(env).length,
      })
    } else {
      log?.warn(`No ${envFileName} files found in apps/`, { workType })
    }
  } catch (error) {
    log?.warn('Failed to load app env files', {
      error: error instanceof Error ? error.message : String(error),
    })
  }

  return env
}

/**
 * Patterns that indicate tool-related errors (not API or resource limit errors)
 */
const TOOL_ERROR_PATTERNS = [
  // Sandbox violations
  /sandbox/i,
  /not allowed/i,
  /operation not permitted/i,
  // Permission errors
  /permission denied/i,
  /EACCES/,
  /access denied/i,
  // File system errors
  /ENOENT/,
  /no such file or directory/i,
  /file not found/i,
  // Network errors
  /ECONNREFUSED/,
  /ETIMEDOUT/,
  /ENOTFOUND/,
  /connection refused/i,
  /network error/i,
  // Command/tool failures
  /command failed/i,
  /exited with code/i,
  /tool.*error/i,
  /tool.*failed/i,
  // General error indicators from tools
  /is_error.*true/i,
]

/**
 * Check if an error message is related to tool execution
 * (vs API errors, resource limits, etc.)
 */
function isToolRelatedError(error: string): boolean {
  return TOOL_ERROR_PATTERNS.some((pattern) => pattern.test(error))
}

/**
 * Extract tool name from an error message if present
 */
function extractToolNameFromError(error: string): string {
  // Try to extract tool name from common patterns
  const patterns = [
    /Tool\s+["']?(\w+)["']?/i,
    /(\w+)\s+tool.*(?:error|failed)/i,
    /Failed to (?:run|execute|call)\s+["']?(\w+)["']?/i,
  ]

  for (const pattern of patterns) {
    const match = error.match(pattern)
    if (match && match[1]) {
      return match[1]
    }
  }

  return 'unknown'
}

/**
 * Result of checking for incomplete work in a worktree
 */
export interface IncompleteWorkCheck {
  hasIncompleteWork: boolean
  reason?: 'uncommitted_changes' | 'unpushed_commits'
  details?: string
}

/**
 * Check if a worktree has uncommitted changes or unpushed commits
 *
 * @param worktreePath - Path to the git worktree
 * @returns Check result with reason if incomplete work is found
 */
export function checkForIncompleteWork(worktreePath: string): IncompleteWorkCheck {
  try {
    // Check for uncommitted changes (staged or unstaged)
    const statusOutput = execSync('git status --porcelain', {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 10000,
    }).trim()

    if (statusOutput.length > 0) {
      const changedFiles = statusOutput.split('\n').length
      return {
        hasIncompleteWork: true,
        reason: 'uncommitted_changes',
        details: `${changedFiles} file(s) with uncommitted changes`,
      }
    }

    // Check for unpushed commits
    // First, check if we have an upstream branch
    try {
      const trackingBranch = execSync('git rev-parse --abbrev-ref @{u}', {
        cwd: worktreePath,
        encoding: 'utf-8',
        timeout: 10000,
      }).trim()

      // Count commits ahead of upstream
      const unpushedOutput = execSync(`git rev-list --count ${trackingBranch}..HEAD`, {
        cwd: worktreePath,
        encoding: 'utf-8',
        timeout: 10000,
      }).trim()

      const unpushedCount = parseInt(unpushedOutput, 10)
      if (unpushedCount > 0) {
        return {
          hasIncompleteWork: true,
          reason: 'unpushed_commits',
          details: `${unpushedCount} commit(s) not pushed to ${trackingBranch}`,
        }
      }
    } catch {
      // No upstream branch set - check if we have any local commits
      // This happens when branch was created but never pushed
      try {
        const logOutput = execSync('git log --oneline -1', {
          cwd: worktreePath,
          encoding: 'utf-8',
          timeout: 10000,
        }).trim()

        if (logOutput.length > 0) {
          // Check if remote branch exists
          const currentBranch = execSync('git branch --show-current', {
            cwd: worktreePath,
            encoding: 'utf-8',
            timeout: 10000,
          }).trim()

          const remoteRef = execSync(`git ls-remote --heads origin ${currentBranch}`, {
            cwd: worktreePath,
            encoding: 'utf-8',
            timeout: 10000,
          }).trim()

          if (remoteRef.length === 0) {
            // Remote branch doesn't exist - branch never pushed
            return {
              hasIncompleteWork: true,
              reason: 'unpushed_commits',
              details: `Branch '${currentBranch}' has not been pushed to remote`,
            }
          }
        }
      } catch {
        // Empty repo or other issue - assume safe to clean
      }
    }

    return { hasIncompleteWork: false }
  } catch (error) {
    // If git commands fail, err on the side of caution and report incomplete
    return {
      hasIncompleteWork: true,
      reason: 'uncommitted_changes',
      details: `Failed to check git status: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * Check if a worktree branch has been pushed to remote with commits ahead of main
 * but no PR was created. This catches the case where an agent pushes code and exits
 * before running `gh pr create`.
 */
export interface PushedWorkCheck {
  hasPushedWork: boolean
  branch?: string
  details?: string
}

export function checkForPushedWorkWithoutPR(worktreePath: string): PushedWorkCheck {
  try {
    const currentBranch = execSync('git branch --show-current', {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 10000,
    }).trim()

    // If on main, no work to check
    if (currentBranch === 'main' || currentBranch === 'master') {
      return { hasPushedWork: false }
    }

    // Count commits ahead of main
    const aheadOutput = execSync(`git rev-list --count main..HEAD`, {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 10000,
    }).trim()

    const aheadCount = parseInt(aheadOutput, 10)
    if (aheadCount === 0) {
      return { hasPushedWork: false }
    }

    // Branch has commits ahead of main — check if they've been pushed
    try {
      const remoteRef = execSync(`git ls-remote --heads origin ${currentBranch}`, {
        cwd: worktreePath,
        encoding: 'utf-8',
        timeout: 10000,
      }).trim()

      if (remoteRef.length > 0) {
        // Branch exists on remote with commits ahead of main — likely missing a PR
        return {
          hasPushedWork: true,
          branch: currentBranch,
          details: `Branch \`${currentBranch}\` has ${aheadCount} commit(s) ahead of main and has been pushed to the remote, but no PR was detected.`,
        }
      }
    } catch {
      // ls-remote failed — can't confirm remote state
    }

    return { hasPushedWork: false }
  } catch {
    // Git commands failed — don't block on our check failing
    return { hasPushedWork: false }
  }
}

/**
 * Generate a prompt for the agent based on work type
 *
 * @param identifier - Issue identifier (e.g., SUP-123)
 * @param workType - Type of work being performed
 * @param options - Optional configuration
 * @param options.parentContext - Pre-built enriched prompt for parent issues with sub-issues.
 *   When provided for 'qa' or 'acceptance' work types, this overrides the default prompt
 *   to include sub-issue context and holistic validation instructions.
 * @returns The appropriate prompt for the work type
 */
function generatePromptForWorkType(
  identifier: string,
  workType: AgentWorkType,
  options?: { parentContext?: string; mentionContext?: string; failureContext?: string }
): string {
  // Use enriched parent context for QA/acceptance if provided
  if (options?.parentContext && (workType === 'qa' || workType === 'acceptance')) {
    return options.parentContext
  }

  const LINEAR_CLI_INSTRUCTION = `

LINEAR CLI (CRITICAL):
Use the Linear CLI (\`pnpm af-linear\`) for ALL Linear operations. Do NOT use Linear MCP tools.
See the project documentation (CLAUDE.md / AGENTS.md) for the full command reference.

HUMAN-NEEDED BLOCKERS:
If you encounter work that requires human action and cannot be resolved autonomously
(e.g., missing API keys/credentials, infrastructure not provisioned, third-party onboarding,
manual setup steps, policy decisions, access permissions), create a blocker issue:
  pnpm af-linear create-blocker <SOURCE-ISSUE-ID> --title "What human needs to do" --description "Detailed steps"
This creates a tracked issue in Icebox with 'Needs Human' label, linked as blocking the source issue.
Do NOT silently skip human-needed work or bury it in comments.
Only create blockers for things that genuinely require a human — not for things you can retry or work around.`

  let basePrompt: string
  switch (workType) {
    case 'research':
      basePrompt = `Research and flesh out story ${identifier}.
Analyze requirements, identify technical approach, estimate complexity,
and update the story description with detailed acceptance criteria.
Do NOT implement code. Focus on story refinement only.${LINEAR_CLI_INSTRUCTION}`
      break

    case 'backlog-creation':
      basePrompt = `Create backlog issues from the researched story ${identifier}.
Read the issue description, identify distinct work items, classify each as bug/feature/chore,
and create appropriately scoped Linear issues in Icebox status (so a human can review before moving to Backlog).
Choose the correct issue structure based on the work:
- Sub-issues (--parentId): When work is a single concern with sequential/parallel phases sharing context and dependencies. Keep source in Icebox as parent. Add blocking relations (--type blocks) between sub-issues to define execution order for the coordinator.
- Independent issues (--type related): When items are unrelated work in different codebase areas with no shared context. Source stays in Icebox.
- Single issue rewrite: When scope is atomic (single concern, \u22643 files, no phases). Rewrite source in-place, keep in Icebox.
IMPORTANT: When creating multiple issues (sub-issues or independent), always add "related" links between them AND blocking relations where one step depends on another. This informs sub-agents and the coordinator of execution order.
Do NOT wait for user approval - create issues automatically.${LINEAR_CLI_INSTRUCTION}`
      break

    case 'development':
      basePrompt = `Start work on ${identifier}.
Implement the feature/fix as specified in the issue description.

DEPENDENCY INSTALLATION:
Dependencies are symlinked from the main repo by the orchestrator. Do NOT run pnpm install.
If you encounter a specific "Cannot find module" error, run it SYNCHRONOUSLY
(never with run_in_background). Never use sleep or polling loops to wait for commands.

IMPORTANT: If you encounter "exceeds maximum allowed tokens" error when reading files:
- Use Grep to search for specific code patterns instead of reading entire files
- Use Read with offset/limit parameters to paginate through large files
- Avoid reading auto-generated files like payload-types.ts (use Grep instead)
See the "Working with Large Files" section in the project documentation (CLAUDE.md / AGENTS.md) for details.${LINEAR_CLI_INSTRUCTION}`
      break

    case 'inflight':
      basePrompt = `Continue work on ${identifier}.
Resume where you left off. Check the issue for any new comments or feedback.

DEPENDENCY INSTALLATION:
Dependencies are symlinked from the main repo by the orchestrator. Do NOT run pnpm install.
If you encounter a specific "Cannot find module" error, run it SYNCHRONOUSLY
(never with run_in_background). Never use sleep or polling loops to wait for commands.

IMPORTANT: If you encounter "exceeds maximum allowed tokens" error when reading files:
- Use Grep to search for specific code patterns instead of reading entire files
- Use Read with offset/limit parameters to paginate through large files
- Avoid reading auto-generated files like payload-types.ts (use Grep instead)
See the "Working with Large Files" section in the project documentation (CLAUDE.md / AGENTS.md) for details.${LINEAR_CLI_INSTRUCTION}`
      break

    case 'inflight-coordination':
      basePrompt = `Resume coordination of sub-issue execution for parent issue ${identifier}.
Check sub-issue statuses, continue work on incomplete sub-issues, and create a PR when all are done.

SUB-ISSUE STATUS MANAGEMENT:
You MUST update sub-issue statuses in Linear as work progresses:
- When starting work on a sub-issue: pnpm af-linear update-sub-issue <id> --state Started
- When a sub-agent completes a sub-issue: pnpm af-linear update-sub-issue <id> --state Finished --comment "Completed by coordinator agent"
- If a sub-agent fails on a sub-issue: pnpm af-linear create-comment <sub-issue-id> --body "Sub-agent failed: <reason>"

COMPLETION VERIFICATION:
Before marking the parent issue as complete, verify ALL sub-issues are in Finished status:
  pnpm af-linear list-sub-issue-statuses ${identifier}
If any sub-issue is not Finished, report the failure and do not mark the parent as complete.

SUB-AGENT SAFETY RULES (CRITICAL):
This is a SHARED WORKTREE. Multiple sub-agents run concurrently in this directory.
Every sub-agent prompt you construct MUST include these rules:

1. NEVER run: git worktree remove, git worktree prune
2. NEVER run: git checkout, git switch (to a different branch)
3. NEVER run: git reset --hard, git clean -fd, git restore .
4. NEVER delete or modify the .git file in the worktree root
5. Only the orchestrator manages worktree lifecycle
6. Work only on files relevant to your sub-issue to minimize conflicts
7. Commit changes with descriptive messages before reporting completion

Prefix every sub-agent prompt with: "SHARED WORKTREE — DO NOT MODIFY GIT STATE"

DEPENDENCY INSTALLATION:
Dependencies are symlinked from the main repo by the orchestrator. Do NOT run pnpm install.
If you encounter a specific "Cannot find module" error, run it SYNCHRONOUSLY
(never with run_in_background). Never use sleep or polling loops to wait for commands.

IMPORTANT: If you encounter "exceeds maximum allowed tokens" error when reading files:
- Use Grep to search for specific code patterns instead of reading entire files
- Use Read with offset/limit parameters to paginate through large files
- Avoid reading auto-generated files like payload-types.ts (use Grep instead)
See the "Working with Large Files" section in the project documentation (CLAUDE.md / AGENTS.md) for details.${LINEAR_CLI_INSTRUCTION}`
      break

    case 'qa':
      basePrompt = `QA ${identifier}.
Validate the implementation against acceptance criteria.
Run tests, check for regressions, verify the PR meets requirements.

STRUCTURED RESULT MARKER (REQUIRED):
You MUST include a structured result marker in your final output message.
The orchestrator parses your output to determine whether to promote or reject the issue.
Without this marker, the issue status will NOT be updated automatically.
- On QA pass: Include <!-- WORK_RESULT:passed --> in your final message
- On QA fail: Include <!-- WORK_RESULT:failed --> in your final message

DEPENDENCY INSTALLATION:
Dependencies are symlinked from the main repo by the orchestrator. Do NOT run pnpm install.
If you encounter a specific "Cannot find module" error, run it SYNCHRONOUSLY
(never with run_in_background). Never use sleep or polling loops to wait for commands.

IMPORTANT: If you encounter "exceeds maximum allowed tokens" error when reading files:
- Use Grep to search for specific code patterns instead of reading entire files
- Use Read with offset/limit parameters to paginate through large files
- Avoid reading auto-generated files like payload-types.ts (use Grep instead)
See the "Working with Large Files" section in the project documentation (CLAUDE.md / AGENTS.md) for details.${LINEAR_CLI_INSTRUCTION}`
      break

    case 'acceptance':
      basePrompt = `Process acceptance for ${identifier}.
Validate development and QA work is complete.
Verify PR is ready to merge (CI passing, no conflicts).
Merge the PR using: gh pr merge <PR_NUMBER> --squash
After merge succeeds, delete the remote branch: git push origin --delete <BRANCH_NAME>

STRUCTURED RESULT MARKER (REQUIRED):
You MUST include a structured result marker in your final output message.
The orchestrator parses your output to determine whether to promote or reject the issue.
Without this marker, the issue status will NOT be updated automatically.
- On acceptance pass: Include <!-- WORK_RESULT:passed --> in your final message
- On acceptance fail: Include <!-- WORK_RESULT:failed --> in your final message${LINEAR_CLI_INSTRUCTION}`
      break

    case 'refinement':
      basePrompt = `Refine ${identifier} based on rejection feedback.
Read the rejection comments, identify required changes,
update the issue description with refined requirements,
then return to Backlog for re-implementation.${LINEAR_CLI_INSTRUCTION}`
      break

    case 'refinement-coordination':
      basePrompt = `Coordinate refinement across sub-issues for parent issue ${identifier}.

WORKFLOW:
1. Read the QA/acceptance failure comments on ${identifier} to identify which sub-issues failed and why
2. Fetch sub-issues: pnpm af-linear list-sub-issues ${identifier}
3. For each FAILING sub-issue:
   a. Update its description with the specific failure feedback from the QA/acceptance report
   b. Move it back to Backlog: pnpm af-linear update-sub-issue <id> --state Backlog --comment "Refinement: <failure summary>"
4. Leave PASSING sub-issues in their current state (Finished) — do not re-run them
5. Once all failing sub-issues are updated, the parent issue will be moved to Backlog by the orchestrator,
   which will trigger a coordination agent that picks up only the Backlog sub-issues for re-implementation.

IMPORTANT CONSTRAINTS:
- This is a REFINEMENT task — do NOT implement fixes yourself, only triage and route feedback to sub-issues.
- NEVER run pnpm af-linear update-issue --state on the parent issue. The orchestrator manages parent status transitions.
- Only use pnpm af-linear for: list-sub-issues, list-sub-issue-statuses, get-issue, list-comments, create-comment, update-sub-issue${LINEAR_CLI_INSTRUCTION}`
      break

    case 'coordination':
      basePrompt = `Coordinate sub-issue execution for parent issue ${identifier}.
Fetch sub-issues with dependency graph, create Claude Code Tasks mapping to each sub-issue,
spawn sub-agents for unblocked sub-issues in parallel, monitor completion,
and create a single PR with all changes when done.

SUB-ISSUE STATUS MANAGEMENT:
You MUST update sub-issue statuses in Linear as work progresses:
- When starting work on a sub-issue: pnpm af-linear update-sub-issue <id> --state Started
- When a sub-agent completes a sub-issue: pnpm af-linear update-sub-issue <id> --state Finished --comment "Completed by coordinator agent"
- If a sub-agent fails on a sub-issue: pnpm af-linear create-comment <sub-issue-id> --body "Sub-agent failed: <reason>"

COMPLETION VERIFICATION:
Before marking the parent issue as complete, verify ALL sub-issues are in Finished status:
  pnpm af-linear list-sub-issue-statuses ${identifier}
If any sub-issue is not Finished, report the failure and do not mark the parent as complete.

SUB-AGENT SAFETY RULES (CRITICAL):
This is a SHARED WORKTREE. Multiple sub-agents run concurrently in this directory.
Every sub-agent prompt you construct MUST include these rules:

1. NEVER run: git worktree remove, git worktree prune
2. NEVER run: git checkout, git switch (to a different branch)
3. NEVER run: git reset --hard, git clean -fd, git restore .
4. NEVER delete or modify the .git file in the worktree root
5. Only the orchestrator manages worktree lifecycle
6. Work only on files relevant to your sub-issue to minimize conflicts
7. Commit changes with descriptive messages before reporting completion

Prefix every sub-agent prompt with: "SHARED WORKTREE \u2014 DO NOT MODIFY GIT STATE"

DEPENDENCY INSTALLATION:
Dependencies are symlinked from the main repo by the orchestrator. Do NOT run pnpm install.
If you encounter a specific "Cannot find module" error, run it SYNCHRONOUSLY
(never with run_in_background). Never use sleep or polling loops to wait for commands.

IMPORTANT: If you encounter "exceeds maximum allowed tokens" error when reading files:
- Use Grep to search for specific code patterns instead of reading entire files
- Use Read with offset/limit parameters to paginate through large files
- Avoid reading auto-generated files like payload-types.ts (use Grep instead)
See the "Working with Large Files" section in the project documentation (CLAUDE.md / AGENTS.md) for details.${LINEAR_CLI_INSTRUCTION}`
      break

    case 'qa-coordination':
      basePrompt = `Coordinate QA across sub-issues for parent issue ${identifier}.

WORKFLOW:
1. Fetch sub-issues: pnpm af-linear list-sub-issues ${identifier}
2. Create Claude Code Tasks for each sub-issue's QA verification
3. Spawn qa-reviewer sub-agents in parallel \u2014 no dependency graph needed, all sub-issues are already Finished
4. Each sub-agent: reads sub-issue requirements, runs scoped tests, validates implementation, emits pass/fail
5. Collect results \u2014 ALL sub-issues must pass QA for the parent to pass

RESULT HANDLING:
- If ALL pass: Mark parent as complete (transitions to Delivered). Update each sub-issue to Delivered.
- If ANY fail: Post rollup comment listing per-sub-issue results. Emit <!-- WORK_RESULT:failed -->. The orchestrator will move the issue to Rejected for coordinated refinement.

IMPORTANT CONSTRAINTS:
- This is READ-ONLY validation \u2014 do NOT create PRs or make git commits
- The PR already exists from the development coordination phase
- Run pnpm test, pnpm typecheck, and pnpm build as part of validation
- Verify each sub-issue's acceptance criteria against the actual code changes

SUB-AGENT SAFETY RULES (CRITICAL):
This is a SHARED WORKTREE. Multiple sub-agents run concurrently in this directory.
Every sub-agent prompt you construct MUST include these rules:
1. NEVER run: git worktree remove, git worktree prune
2. NEVER run: git checkout, git switch (to a different branch)
3. NEVER run: git reset --hard, git clean -fd, git restore .
4. NEVER delete or modify the .git file in the worktree root
5. Work only on files relevant to your sub-issue to minimize conflicts
Prefix every sub-agent prompt with: "SHARED WORKTREE \u2014 DO NOT MODIFY GIT STATE"

STRUCTURED RESULT MARKER (REQUIRED):
You MUST include a structured result marker in your final output message.
The orchestrator parses your output to determine whether to promote or reject the issue.
Without this marker, the issue status will NOT be updated automatically.
- On QA pass: Include <!-- WORK_RESULT:passed --> in your final message
- On QA fail: Include <!-- WORK_RESULT:failed --> in your final message

DEPENDENCY INSTALLATION:
Dependencies are symlinked from the main repo by the orchestrator. Do NOT run pnpm install.
If you encounter a specific "Cannot find module" error, run it SYNCHRONOUSLY
(never with run_in_background). Never use sleep or polling loops to wait for commands.

IMPORTANT: If you encounter "exceeds maximum allowed tokens" error when reading files:
- Use Grep to search for specific code patterns instead of reading entire files
- Use Read with offset/limit parameters to paginate through large files
- Avoid reading auto-generated files like payload-types.ts (use Grep instead)
See the "Working with Large Files" section in the project documentation (CLAUDE.md / AGENTS.md) for details.${LINEAR_CLI_INSTRUCTION}`
      break

    case 'acceptance-coordination':
      basePrompt = `Coordinate acceptance across sub-issues for parent issue ${identifier}.

WORKFLOW:
1. Verify all sub-issues are in Delivered status: pnpm af-linear list-sub-issue-statuses ${identifier}
2. If any sub-issue is NOT Delivered, report which sub-issues need attention and fail
3. Validate the PR:
   - CI checks are passing
   - No merge conflicts
   - Preview deployment succeeded (if applicable)
4. Merge the PR: gh pr merge <PR_NUMBER> --squash
5. After merge succeeds, delete the remote branch: git push origin --delete <BRANCH_NAME>
6. Bulk-update all sub-issues to Accepted: for each sub-issue, run pnpm af-linear update-sub-issue <id> --state Accepted
7. Mark parent as complete (transitions to Accepted)

IMPORTANT CONSTRAINTS:
- ALL sub-issues must be in Delivered status before proceeding
- The PR must pass CI and have no conflicts
- If merge fails, report the error and do not mark as Accepted

STRUCTURED RESULT MARKER (REQUIRED):
You MUST include a structured result marker in your final output message.
The orchestrator parses your output to determine whether to promote or reject the issue.
Without this marker, the issue status will NOT be updated automatically.
- On acceptance pass: Include <!-- WORK_RESULT:passed --> in your final message
- On acceptance fail: Include <!-- WORK_RESULT:failed --> in your final message

IMPORTANT: If you encounter "exceeds maximum allowed tokens" error when reading files:
- Use Grep to search for specific code patterns instead of reading entire files
- Use Read with offset/limit parameters to paginate through large files
- Avoid reading auto-generated files like payload-types.ts (use Grep instead)
See the "Working with Large Files" section in the project documentation (CLAUDE.md / AGENTS.md) for details.${LINEAR_CLI_INSTRUCTION}`
      break

    case 'merge':
      basePrompt = `Handle merge queue operations for ${identifier}.
Check PR merge readiness (CI status, approvals).
Attempt rebase onto latest main.
Resolve conflicts using mergiraf-enhanced git merge if available.
Push updated branch and trigger merge via configured merge queue provider.${LINEAR_CLI_INSTRUCTION}`
      break

    case 'security':
      basePrompt = `Security scan ${identifier}.
Run security scanning tools (SAST, dependency audit) against the codebase and output structured results.

WORKFLOW:
1. Identify the project type (Node.js, Python, etc.) by inspecting package.json, requirements.txt, etc.
2. Run appropriate scanners (semgrep for SAST, npm-audit/pip-audit for dependencies)
3. Parse scanner outputs and produce structured JSON summaries
4. Output results in fenced code blocks tagged \`security-scan-result\`

IMPORTANT CONSTRAINTS:
- This is READ-ONLY scanning — do NOT make code changes, git commits, or fix vulnerabilities yourself.
- If critical or high severity issues found, emit <!-- WORK_RESULT:failed -->.
- If only medium/low or no issues found, emit <!-- WORK_RESULT:passed -->.
- If a scanner is not available, skip it and note this in your output.

STRUCTURED RESULT MARKER (REQUIRED):
You MUST include a structured result marker in your final output message.
- On pass: Include <!-- WORK_RESULT:passed --> in your final message
- On fail: Include <!-- WORK_RESULT:failed --> in your final message${LINEAR_CLI_INSTRUCTION}`
      break
  }

  // Inject workflow failure context for retries
  if (options?.failureContext) {
    basePrompt += options.failureContext
  }

  if (options?.mentionContext) {
    return `${basePrompt}\n\nAdditional context from the user's mention:\n${options.mentionContext}`
  }
  return basePrompt
}

/**
 * Map work type to worktree identifier suffix
 * This prevents different work types from using the same worktree directory
 */
const WORK_TYPE_SUFFIX: Record<AgentWorkType, string> = {
  research: 'RES',
  'backlog-creation': 'BC',
  development: 'DEV',
  inflight: 'INF',
  'inflight-coordination': 'INF-COORD',
  coordination: 'COORD',
  qa: 'QA',
  acceptance: 'AC',
  refinement: 'REF',
  'refinement-coordination': 'REF-COORD',
  'qa-coordination': 'QA-COORD',
  'acceptance-coordination': 'AC-COORD',
  merge: 'MRG',
  security: 'SEC',
}

/**
 * Generate a worktree identifier that includes the work type suffix
 *
 * @param issueIdentifier - Issue identifier (e.g., "SUP-294")
 * @param workType - Type of work being performed
 * @returns Worktree identifier with suffix (e.g., "SUP-294-QA")
 */
export function getWorktreeIdentifier(
  issueIdentifier: string,
  workType: AgentWorkType
): string {
  const suffix = WORK_TYPE_SUFFIX[workType]
  return `${issueIdentifier}-${suffix}`
}

/**
 * Detect the appropriate work type for an issue based on its status,
 * upgrading to coordination variants for parent issues with sub-issues.
 *
 * This prevents parent issues returning to Backlog after refinement from
 * being dispatched as 'development' (which uses the wrong template and
 * produces no sub-agent orchestration).
 */
export function detectWorkType(statusName: string, isParent: boolean, statusToWorkType?: Record<string, AgentWorkType>): AgentWorkType {
  const mapping = statusToWorkType ?? {}
  let workType: AgentWorkType = mapping[statusName] ?? 'development'
  console.log(`Auto-detected work type: ${workType} (from status: ${statusName})`)

  if (isParent) {
    if (workType === 'development') workType = 'coordination'
    else if (workType === 'qa') workType = 'qa-coordination'
    else if (workType === 'acceptance') workType = 'acceptance-coordination'
    else if (workType === 'inflight') workType = 'inflight-coordination'
    else if (workType === 'refinement') workType = 'refinement-coordination'
    console.log(`Upgraded to coordination work type: ${workType} (parent issue)`)
  }

  return workType
}

export class AgentOrchestrator {
  private readonly config: Required<Omit<OrchestratorConfig, 'project' | 'provider' | 'streamConfig' | 'apiActivityConfig' | 'workTypeTimeouts' | 'maxSessionTimeoutMs' | 'templateDir' | 'repository' | 'issueTrackerClient' | 'statusMappings' | 'toolPlugins' | 'mergeQueueAdapter' | 'mergeQueueStorage'>> & {
    project?: string
    repository?: string
    streamConfig: OrchestratorStreamConfig
    apiActivityConfig?: OrchestratorConfig['apiActivityConfig']
    workTypeTimeouts?: OrchestratorConfig['workTypeTimeouts']
    maxSessionTimeoutMs?: number
  }
  private readonly client: IssueTrackerClient
  private readonly statusMappings: WorkTypeStatusMappings
  private readonly events: OrchestratorEvents
  private readonly activeAgents: Map<string, AgentProcess> = new Map()
  private readonly agentHandles: Map<string, AgentHandle> = new Map()
  private provider: AgentProvider
  private readonly providerCache: Map<AgentProviderName, AgentProvider> = new Map()
  private configProviders?: ProvidersConfig
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
  // Buffered assistant text for batched logging (keyed by issueId)
  // Streaming providers (Codex) send one token per event — buffer and flush on sentence boundaries
  private readonly assistantTextBuffers: Map<string, { text: string; timer: ReturnType<typeof setTimeout> | null }> = new Map()
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
    // Resolve git root from cwd (worktreePath may be a sibling directory outside the repo)
    this.gitRoot = findRepoRoot(process.cwd()) ?? process.cwd()

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
      this.templateRegistry.setToolPermissionAdapter(createToolPermissionAdapter(this.provider.name))
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
          // Store providers config for per-spawn resolution
          this.configProviders = getProvidersConfig(repoConfig)

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
    return detectWorkType(statusName, isParent, this.statusMappings.statusToWorkType)
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

  /**
   * Check if a git error indicates a branch/worktree conflict.
   *
   * Git uses different error messages depending on the situation:
   * - "is already checked out at '/path'" - branch checked out in another worktree
   * - "is already used by worktree at '/path'" - branch associated with another worktree
   *
   * Both mean the same thing: the branch is occupied by another worktree.
   */
  private isBranchConflictError(errorMsg: string): boolean {
    return errorMsg.includes('is already checked out at') ||
           errorMsg.includes('is already used by worktree at')
  }

  /**
   * Extract the conflicting worktree path from a git branch conflict error.
   *
   * Parses paths like:
   * - "fatal: 'SUP-402' is already checked out at '/path/to/.worktrees/SUP-402-DEV'"
   * - "fatal: 'SUP-402' is already used by worktree at '/path/to/.worktrees/SUP-402-DEV'"
   */
  private parseConflictingWorktreePath(errorMsg: string): string | null {
    // Match either "checked out at" or "used by worktree at" followed by a quoted path
    const match = errorMsg.match(/(?:already checked out at|already used by worktree at)\s+'([^']+)'/)
    return match?.[1] ?? null
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

        const diff = execSync('git diff HEAD', {
          cwd: conflictPath,
          encoding: 'utf-8',
          timeout: 10000,
        })
        if (diff.trim().length > 0) {
          writeFileSync(patchPath, diff)
          console.log(`Saved preserved worktree patch: ${patchPath}`)
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

    // Determine the base branch for new worktrees
    // Always base new feature branches on 'main' to avoid HEAD resolution issues
    // when running from worktrees with deleted branches (e.g., after PR merge in acceptance)
    const baseBranch = 'main'

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
  removeWorktree(worktreeIdentifier: string): void {
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
  }

  /**
   * Write helper scripts into the worktree's .agent/ directory.
   *
   * Currently writes:
   * - .agent/add-dep.sh: Safely adds a new dependency by removing symlinked
   *   node_modules first, then running `pnpm add` with the guard bypass.
   */
  private writeWorktreeHelpers(worktreePath: string): void {
    // Skip helper scripts for non-Node projects (no pnpm/npm available)
    if (this.packageManager === 'none') {
      return
    }

    const agentDir = resolve(worktreePath, '.agent')
    const scriptPath = resolve(agentDir, 'add-dep.sh')

    const script = `#!/bin/bash
# Safe dependency addition for agents in worktrees.
# Removes symlinked node_modules, then runs pnpm add with guard bypass.
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
echo "Installing: pnpm add $@"
ORCHESTRATOR_INSTALL=1 exec pnpm add "$@"
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
   * For non-Node repos (no node_modules in main repo), this is a no-op.
   *
   * Falls back to `pnpm install --frozen-lockfile` if symlinking fails.
   */
  linkDependencies(worktreePath: string, identifier: string): void {
    const repoRoot = findRepoRoot(worktreePath)
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

    // Also check for .modules.yaml (pnpm store metadata) if it exists in main
    const repoRoot = findRepoRoot(worktreePath)
    if (repoRoot) {
      const pnpmMeta = resolve(repoRoot, 'node_modules', '.modules.yaml')
      if (existsSync(pnpmMeta)) {
        sentinels.push('.modules.yaml')
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
   * Fallback: install dependencies via pnpm install.
   * Only called when symlinking fails.
   */
  private installDependencies(worktreePath: string, identifier: string): void {
    console.log(`[${identifier}] Installing dependencies via pnpm...`)

    // Remove any node_modules from a partial linkDependencies attempt
    this.removeWorktreeNodeModules(worktreePath)

    // Set ORCHESTRATOR_INSTALL=1 to bypass the preinstall guard script
    // that blocks pnpm install in worktrees (to prevent symlink corruption).
    const installEnv = { ...process.env, ORCHESTRATOR_INSTALL: '1' }

    try {
      execSync('pnpm install --frozen-lockfile 2>&1', {
        cwd: worktreePath,
        stdio: 'pipe',
        encoding: 'utf-8',
        timeout: 120_000,
        env: installEnv,
      })
      console.log(`[${identifier}] Dependencies installed successfully`)
    } catch {
      try {
        execSync('pnpm install 2>&1', {
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
    const repoRoot = findRepoRoot(worktreePath)
    if (!repoRoot) {
      this.linkDependencies(worktreePath, identifier)
      return
    }

    const worktreeLock = resolve(worktreePath, 'pnpm-lock.yaml')
    const mainLock = resolve(repoRoot, 'pnpm-lock.yaml')

    // Detect lockfile drift: if the worktree has a lockfile that differs from main,
    // a dev agent added/changed dependencies on the branch
    let lockfileDrifted = false
    if (existsSync(worktreeLock) && existsSync(mainLock)) {
      try {
        const wtContent = readFileSync(worktreeLock, 'utf-8')
        const mainContent = readFileSync(mainLock, 'utf-8')
        lockfileDrifted = wtContent !== mainContent
      } catch {
        // If we can't read either file, proceed without sync
      }
    }

    if (lockfileDrifted) {
      console.log(`[${identifier}] Lockfile drift detected — syncing main repo dependencies`)
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
        const installEnv = { ...process.env, ORCHESTRATOR_INSTALL: '1' }
        execSync('pnpm install --frozen-lockfile 2>&1', {
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
   * Build base instructions for Codex App Server agents (SUP-1746).
   *
   * Assembles safety rules and project-specific instructions (AGENTS.md / CLAUDE.md)
   * into a persistent system prompt passed via `instructions` on `thread/start`.
   */
  private buildCodexBaseInstructions(workType?: AgentWorkType, worktreePath?: string): string {
    const sections: string[] = []

    // Safety rules — mirrors autonomousCanUseTool deny patterns as natural-language rules
    sections.push(`# Safety Rules

You are running in an AgentFactory-managed worktree. Follow these rules strictly:

1. NEVER run: rm -rf / (or any rm of the filesystem root)
2. NEVER run: git worktree remove, git worktree prune
3. NEVER run: git reset --hard
4. NEVER run: git push --force (use --force-with-lease on feature branches if needed)
5. NEVER run: git checkout <branch>, git switch <branch> (do not change the checked-out branch)
6. NEVER modify files in the .git directory
7. Commit changes with descriptive messages before reporting completion`)

    // Project-specific instructions — load AGENTS.md or CLAUDE.md from worktree root
    if (worktreePath) {
      for (const filename of ['AGENTS.md', 'CLAUDE.md']) {
        const instrPath = resolve(worktreePath, filename)
        if (existsSync(instrPath)) {
          try {
            const content = readFileSync(instrPath, 'utf-8')
            if (content.trim()) {
              sections.push(`# Project Instructions (${filename})\n\n${content.trim()}`)
              break // Only load one: AGENTS.md takes priority
            }
          } catch {
            // Ignore read errors — project instructions are optional
          }
        }
      }
    }

    return sections.join('\n\n')
  }

  /**
   * Build Codex permission config from template permissions (SUP-1748).
   *
   * Translates abstract template `tools.allow` / `tools.disallow` into
   * structured regex patterns for the Codex approval bridge.
   */
  private buildCodexPermissionConfig(workType?: AgentWorkType): import('../templates/adapters.js').CodexPermissionConfig | undefined {
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
  }): { provider: AgentProvider; providerName: AgentProviderName; source: string } {
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
    } = options

    // Resolve provider for this specific spawn (may differ from default)
    const { provider: spawnProvider, providerName: spawnProviderName, source: providerSource } =
      this.resolveProviderForSpawn({ workType, projectName, labels, mentionContext })

    // Generate prompt based on work type, or use custom prompt if provided
    // Try template registry first, fall back to hardcoded prompts
    let prompt: string
    if (customPrompt) {
      prompt = customPrompt
    } else if (this.templateRegistry?.hasTemplate(workType)) {
      // Resolve per-project config overrides (falls back to repo-wide defaults)
      const perProject = projectName && this.repoConfig
        ? getProjectConfig(this.repoConfig, projectName)
        : null

      const context: TemplateContext = {
        identifier,
        repository: this.config.repository,
        projectPath: perProject?.path ?? this.projectPaths?.[projectName ?? ''],
        sharedPaths: this.sharedPaths,
        useToolPlugins: spawnProviderName === 'claude',
        linearCli: this.linearCli ?? 'pnpm af-linear',
        packageManager: perProject?.packageManager ?? this.packageManager ?? 'pnpm',
        buildCommand: perProject?.buildCommand ?? this.buildCommand,
        testCommand: perProject?.testCommand ?? this.testCommand,
        validateCommand: perProject?.validateCommand ?? this.validateCommand,
        agentBugBacklog: process.env.AGENT_BUG_BACKLOG || undefined,
        mergeQueueEnabled: !!this.mergeQueueAdapter,
        qualityBaseline: this.loadQualityBaselineForContext(worktreePath),
      }
      const rendered = this.templateRegistry.renderPrompt(workType, context)
      prompt = rendered ?? generatePromptForWorkType(identifier, workType)
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

    // Load environment from settings.local.json
    const envBaseDir = worktreePath ?? process.cwd()
    const settingsEnv = loadSettingsEnv(envBaseDir, log)

    // Load app-specific env files based on work type
    // Development work loads .env.local, QA/acceptance loads .env.test.local
    const appEnv = loadAppEnvFiles(envBaseDir, workType, log)

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

    log.info('Starting agent via provider', { provider: spawnProviderName, source: providerSource, cwd: worktreePath ?? 'repo-root', workType, promptPreview: prompt.substring(0, 50) })

    // Create tool servers from registered plugins
    const toolPluginContext = { env, cwd: worktreePath ?? process.cwd() }
    const toolServers = spawnProviderName === 'claude'
      ? this.toolRegistry.createServers(toolPluginContext)
      : undefined

    // Create stdio MCP server configs for Codex provider (SUP-1744)
    const stdioServers = spawnProviderName === 'codex'
      ? this.toolRegistry.createStdioServerConfigs(toolPluginContext)
      : undefined

    // Coordinators need significantly more turns than standard agents
    // since they spawn sub-agents and poll their status repeatedly.
    // Inflight also gets the bump — it may be resuming coordination work.
    const needsMoreTurns = workType === 'coordination' || workType === 'inflight-coordination' || workType === 'qa-coordination' || workType === 'acceptance-coordination' || workType === 'refinement-coordination' || workType === 'inflight'
    const maxTurns = needsMoreTurns ? 200 : undefined

    // SUP-1746/SUP-1748: Build Codex-specific base instructions and permission config
    const codexBaseInstructions = spawnProviderName === 'codex'
      ? this.buildCodexBaseInstructions(workType, worktreePath)
      : undefined
    const codexPermissionConfig = spawnProviderName === 'codex' && this.templateRegistry
      ? this.buildCodexPermissionConfig(workType)
      : undefined

    // Spawn agent via provider interface
    const spawnConfig: AgentSpawnConfig = {
      prompt,
      cwd: worktreePath ?? process.cwd(),
      env,
      abortController,
      autonomous: true,
      sandboxEnabled: this.config.sandboxEnabled,
      mcpServers: toolServers?.servers,
      mcpToolNames: toolServers?.toolNames,
      mcpStdioServers: stdioServers?.servers,
      maxTurns,
      baseInstructions: codexBaseInstructions,
      permissionConfig: codexPermissionConfig,
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
              targetStatus = this.statusMappings.workTypeCompleteStatus[workType]
              log?.info('Work result: passed, promoting', { workType, targetStatus })
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
            const incompleteCheck = checkForIncompleteWork(agent.worktreePath)

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
              const hasPushedWork = checkForPushedWorkWithoutPR(agent.worktreePath)

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

        // Merge queue: enqueue PR after successful merge work
        if (workType === 'merge' && this.mergeQueueAdapter && agent.pullRequestUrl) {
          try {
            const prMatch = agent.pullRequestUrl.match(/\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
            if (prMatch) {
              const [, owner, repo, prNum] = prMatch
              const canEnqueue = await this.mergeQueueAdapter.canEnqueue(owner, repo, parseInt(prNum, 10))
              if (canEnqueue) {
                const status = await this.mergeQueueAdapter.enqueue(owner, repo, parseInt(prNum, 10))
                log?.info('PR enqueued in merge queue', { owner, repo, prNumber: prNum, state: status.state })
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
            this.removeWorktree(agent.worktreeIdentifier)
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
            this.removeWorktree(agent.worktreeIdentifier)
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
          if (emitter && event.message) {
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
          if (emitter && event.message) {
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
    prompt?: string
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
      // Re-validate: upgrade to coordination variant if this is a parent issue
      // The caller may have a stale work type from before the session was queued
      try {
        const isParent = await this.client.isParentIssue(issueId)
        if (isParent) {
          const upgraded = detectWorkType(issue.status ?? 'Backlog', isParent, this.statusMappings.statusToWorkType)
          if (upgraded !== effectiveWorkType) {
            console.log(`Upgrading work type from ${effectiveWorkType} to ${upgraded} (parent issue detected)`)
            effectiveWorkType = upgraded
          }
        }
      } catch (err) {
        console.warn(`Failed to check parent status for coordination upgrade:`, err)
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

      // Check for existing state and potential recovery
      const recoveryCheck = checkRecovery(worktreePath, {
        heartbeatTimeoutMs: getHeartbeatTimeoutFromEnv(),
        maxRecoveryAttempts: getMaxRecoveryAttemptsFromEnv(),
      })

      if (recoveryCheck.agentAlive) {
        // Agent is still running - prevent duplicate
        throw new Error(
          `Agent already running for ${identifier}: ${recoveryCheck.message}. ` +
          `Stop the existing agent before spawning a new one.`
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
    const { issueId, identifier, worktreeIdentifier, sessionId, worktreePath, prompt, providerSessionId, workType, teamName, labels, mentionContext } = options

    // Resolve provider for this specific spawn (may differ from default)
    const { provider: spawnProvider, providerName: spawnProviderName, source: providerSource } =
      this.resolveProviderForSpawn({ workType, projectName: options.projectName, labels, mentionContext })

    // Create logger for this agent
    const log = createLogger({ issueIdentifier: identifier })
    this.agentLoggers.set(issueId, log)

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

    // Load environment from settings.local.json
    const envBaseDir = worktreePath ?? process.cwd()
    const settingsEnv = loadSettingsEnv(envBaseDir, log)

    // Load app-specific env files based on work type
    // Development work loads .env.local, QA/acceptance loads .env.test.local
    const effectiveWorkTypeForEnv = workType ?? 'development'
    const appEnv = loadAppEnvFiles(envBaseDir, effectiveWorkTypeForEnv, log)

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
    }

    log.info('Starting agent via provider', {
      provider: spawnProviderName,
      source: providerSource,
      cwd: worktreePath ?? 'repo-root',
      resuming: !!providerSessionId,
      workType: workType ?? 'development',
    })

    // Create tool servers from registered plugins
    const toolPluginContext = { env, cwd: worktreePath ?? process.cwd() }
    const toolServers = spawnProviderName === 'claude'
      ? this.toolRegistry.createServers(toolPluginContext)
      : undefined

    // Create stdio MCP server configs for Codex provider (SUP-1744)
    const stdioServers = spawnProviderName === 'codex'
      ? this.toolRegistry.createStdioServerConfigs(toolPluginContext)
      : undefined

    // Coordinators need significantly more turns than standard agents
    const resolvedWorkType = workType ?? 'development'
    const needsMoreTurns = resolvedWorkType === 'coordination' || resolvedWorkType === 'qa-coordination' || resolvedWorkType === 'acceptance-coordination' || resolvedWorkType === 'refinement-coordination' || resolvedWorkType === 'inflight'
    const maxTurns = needsMoreTurns ? 200 : undefined

    // SUP-1746/SUP-1748: Build Codex-specific base instructions and permission config
    const codexBaseInstructions = spawnProviderName === 'codex'
      ? this.buildCodexBaseInstructions(workType, worktreePath)
      : undefined
    const codexPermissionConfig = spawnProviderName === 'codex' && this.templateRegistry
      ? this.buildCodexPermissionConfig(workType)
      : undefined

    // Spawn agent via provider interface (with resume if session ID available)
    const spawnConfig: AgentSpawnConfig = {
      prompt,
      cwd: worktreePath ?? process.cwd(),
      env,
      abortController,
      autonomous: true,
      sandboxEnabled: this.config.sandboxEnabled,
      mcpServers: toolServers?.servers,
      mcpToolNames: toolServers?.toolNames,
      mcpStdioServers: stdioServers?.servers,
      maxTurns,
      baseInstructions: codexBaseInstructions,
      permissionConfig: codexPermissionConfig,
      onProcessSpawned: (pid) => {
        agent.pid = pid
        log.info('Agent process spawned', { pid })
      },
    }

    const handle = providerSessionId
      ? this.createResumeWithFallbackHandle(spawnProvider, providerSessionId, spawnConfig, agent, log)
      : spawnProvider.spawn(spawnConfig)

    this.agentHandles.set(issueId, handle)
    agent.status = 'running'

    // Process the event stream in the background
    this.processEventStream(issueId, identifier, sessionId, handle, emitter, agent)

    return agent
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
