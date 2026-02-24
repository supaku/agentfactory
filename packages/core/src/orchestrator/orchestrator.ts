/**
 * Agent Orchestrator
 * Spawns concurrent Claude agents to work on Linear backlog issues
 * Uses the Claude Agent SDK for programmatic control
 */

import { randomUUID } from 'crypto'
import { execSync } from 'child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'fs'
import { resolve, dirname } from 'path'
import { config as loadDotenv } from 'dotenv'
import {
  type AgentProvider,
  type AgentHandle,
  type AgentEvent,
  type AgentSpawnConfig,
  createProvider,
  resolveProviderName,
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
import { isSessionLoggingEnabled, isAutoAnalyzeEnabled, getLogAnalysisConfig } from './log-config.js'
import type { WorktreeState, TodosState, TodoItem } from './state-types.js'
import {
  createLinearAgentClient,
  createAgentSession,
  buildCompletionComments,
  type LinearAgentClient,
  type AgentSession,
  type AgentWorkType,
  type LinearWorkflowStatus,
  STATUS_WORK_TYPE_MAP,
  WORK_TYPE_START_STATUS,
  WORK_TYPE_COMPLETE_STATUS,
  WORK_TYPE_FAIL_STATUS,
} from '@supaku/agentfactory-linear'
import { parseWorkResult } from './parse-work-result.js'
import { createActivityEmitter, type ActivityEmitter } from './activity-emitter.js'
import { createApiActivityEmitter, type ApiActivityEmitter } from './api-activity-emitter.js'
import { createLogger, type Logger } from '../logger.js'
import { TemplateRegistry, ClaudeToolPermissionAdapter } from '../templates/index.js'
import { loadRepositoryConfig } from '../config/index.js'
import type { TemplateContext } from '../templates/index.js'
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
// Default max session timeout: unlimited (undefined)
const DEFAULT_MAX_SESSION_TIMEOUT_MS: number | undefined = undefined

// Env vars that Claude Code interprets for authentication/routing. If these
// leak into agent processes from app .env.local files, Claude Code switches
// from Max subscription billing to API-key billing. Apps that need an
// Anthropic API key should use a namespaced name instead (e.g.
// SUPAKU_SOCIAL_ANTHROPIC_API_KEY) which won't be recognised by Claude Code.
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
 * @param expectedRepo - The expected repository pattern (e.g. 'github.com/supaku/agentfactory')
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

const DEFAULT_CONFIG: Required<Omit<OrchestratorConfig, 'linearApiKey' | 'project' | 'provider' | 'streamConfig' | 'apiActivityConfig' | 'workTypeTimeouts' | 'maxSessionTimeoutMs' | 'templateDir' | 'repository'>> & {
  streamConfig: OrchestratorStreamConfig
  maxSessionTimeoutMs?: number
} = {
  maxConcurrent: 3,
  worktreePath: '.worktrees',
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
      break
    }
    prevDir = currentDir
    currentDir = dirname(currentDir)
  }

  log?.warn('settings.local.json not found', { startDir: workDir })
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
  // Find the repo root (worktrees are inside .worktrees/ which is in the repo)
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
        // Use dotenv to parse the file
        const result = loadDotenv({ path: envPath })
        if (result.parsed) {
          // Merge into our env object
          // dotenv.parsed is Record<string, string>
          Object.assign(env, result.parsed)
          loadedCount++
          log?.debug(`Loaded ${envFileName} from ${appName}`, {
            vars: Object.keys(result.parsed).length,
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
interface IncompleteWorkCheck {
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
function checkForIncompleteWork(worktreePath: string): IncompleteWorkCheck {
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

          try {
            execSync(`git ls-remote --heads origin ${currentBranch}`, {
              cwd: worktreePath,
              encoding: 'utf-8',
              timeout: 10000,
            })
            // Remote branch exists, no issue
          } catch {
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
See CLAUDE.md for the full command reference.

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
and create appropriately scoped Linear issues in Backlog status.
Choose the correct issue structure based on the work:
- Sub-issues (--parentId): When work is a single concern with sequential/parallel phases sharing context and dependencies. Move source to Backlog as parent. Add blocking relations (--type blocks) between sub-issues to define execution order for the coordinator.
- Independent issues (--type related): When items are unrelated work in different codebase areas with no shared context. Source stays in Icebox.
- Single issue rewrite: When scope is atomic (single concern, \u22643 files, no phases). Rewrite source in-place and move to Backlog.
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
See the "Working with Large Files" section in CLAUDE.md for details.${LINEAR_CLI_INSTRUCTION}`
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
See the "Working with Large Files" section in CLAUDE.md for details.${LINEAR_CLI_INSTRUCTION}`
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
See the "Working with Large Files" section in CLAUDE.md for details.${LINEAR_CLI_INSTRUCTION}`
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
See the "Working with Large Files" section in CLAUDE.md for details.${LINEAR_CLI_INSTRUCTION}`
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
- If ANY fail: Post rollup comment listing per-sub-issue results. Parent stays in Finished status.

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
See the "Working with Large Files" section in CLAUDE.md for details.${LINEAR_CLI_INSTRUCTION}`
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
See the "Working with Large Files" section in CLAUDE.md for details.${LINEAR_CLI_INSTRUCTION}`
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
  coordination: 'COORD',
  qa: 'QA',
  acceptance: 'AC',
  refinement: 'REF',
  'qa-coordination': 'QA-COORD',
  'acceptance-coordination': 'AC-COORD',
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

export class AgentOrchestrator {
  private readonly config: Required<Omit<OrchestratorConfig, 'project' | 'provider' | 'streamConfig' | 'apiActivityConfig' | 'workTypeTimeouts' | 'maxSessionTimeoutMs' | 'templateDir' | 'repository'>> & {
    project?: string
    repository?: string
    streamConfig: OrchestratorStreamConfig
    apiActivityConfig?: OrchestratorConfig['apiActivityConfig']
    workTypeTimeouts?: OrchestratorConfig['workTypeTimeouts']
    maxSessionTimeoutMs?: number
  }
  private readonly client: LinearAgentClient
  private readonly events: OrchestratorEvents
  private readonly activeAgents: Map<string, AgentProcess> = new Map()
  private readonly agentHandles: Map<string, AgentHandle> = new Map()
  private provider: AgentProvider
  private readonly agentSessions: Map<string, AgentSession> = new Map()
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
  // Template registry for configurable workflow prompts
  private readonly templateRegistry: TemplateRegistry | null
  // Allowlisted project names from .agentfactory/config.yaml
  private allowedProjects?: string[]
  // Project-to-path mapping from .agentfactory/config.yaml (monorepo support)
  private projectPaths?: Record<string, string>
  // Shared paths from .agentfactory/config.yaml (monorepo support)
  private sharedPaths?: string[]

  constructor(config: OrchestratorConfig = {}, events: OrchestratorEvents = {}) {
    const apiKey = config.linearApiKey ?? process.env.LINEAR_API_KEY
    if (!apiKey) {
      throw new Error('LINEAR_API_KEY is required')
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
      linearApiKey: apiKey,
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
    // Validate git remote matches configured repository (if set)
    if (this.config.repository) {
      validateGitRemote(this.config.repository)
    }

    this.client = createLinearAgentClient({ apiKey })
    this.events = events

    // Initialize agent provider — defaults to Claude, configurable via env
    const providerName = resolveProviderName({ project: config.project })
    this.provider = config.provider ?? createProvider(providerName)

    // Initialize template registry for configurable workflow prompts
    try {
      const templateDirs: string[] = []
      if (config.templateDir) {
        templateDirs.push(config.templateDir)
      }
      // Auto-detect .agentfactory/templates/ in working directory
      const projectTemplateDir = resolve(process.cwd(), '.agentfactory', 'templates')
      if (existsSync(projectTemplateDir) && !templateDirs.includes(projectTemplateDir)) {
        templateDirs.push(projectTemplateDir)
      }
      this.templateRegistry = TemplateRegistry.create({
        templateDirs,
        useBuiltinDefaults: true,
        frontend: 'linear',
      })
      this.templateRegistry.setToolPermissionAdapter(new ClaudeToolPermissionAdapter())
    } catch {
      // If template loading fails, fall back to hardcoded prompts
      this.templateRegistry = null
    }

    // Auto-load .agentfactory/config.yaml from repository root
    try {
      const repoRoot = findRepoRoot(process.cwd())
      if (repoRoot) {
        const repoConfig = loadRepositoryConfig(repoRoot)
        if (repoConfig) {
          // Use repository from config as fallback if not set in OrchestratorConfig
          if (!this.config.repository && repoConfig.repository) {
            this.config.repository = repoConfig.repository
            validateGitRemote(this.config.repository)
          }
          // Store allowedProjects for backlog filtering
          if (repoConfig.projectPaths) {
            this.projectPaths = repoConfig.projectPaths
            this.sharedPaths = repoConfig.sharedPaths
            this.allowedProjects = Object.keys(repoConfig.projectPaths)
          } else if (repoConfig.allowedProjects) {
            this.allowedProjects = repoConfig.allowedProjects
          }
        }
      }
    } catch (err) {
      console.warn('[orchestrator] Failed to load .agentfactory/config.yaml:', err instanceof Error ? err.message : err)
    }
  }

  /**
   * Update the last activity timestamp for an agent (for inactivity timeout tracking)
   * @param issueId - The issue ID of the agent
   * @param activityType - Optional description of the activity type
   */
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

    return baseConfig
  }

  /**
   * Get backlog issues for the configured project
   */
  async getBacklogIssues(limit?: number): Promise<OrchestratorIssue[]> {
    const maxIssues = limit ?? this.config.maxConcurrent

    // Build filter based on project
    const filter: {
      state?: { name: { eqIgnoreCase: string } }
      project?: { id: { eq: string } }
    } = {
      state: { name: { eqIgnoreCase: 'Backlog' } },
    }

    if (this.config.project) {
      const projects = await this.client.linearClient.projects({
        filter: { name: { eqIgnoreCase: this.config.project } },
      })
      if (projects.nodes.length > 0) {
        filter.project = { id: { eq: projects.nodes[0].id } }

        // Cross-reference project repo metadata with config (SUP-725)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime check for method added in SUP-725
        const clientAny = this.client as any
        if (this.config.repository && typeof clientAny.getProjectRepositoryUrl === 'function') {
          try {
            const projectRepoUrl: string | null = await clientAny.getProjectRepositoryUrl(projects.nodes[0].id)
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
      }
    }

    const issues = await this.client.linearClient.issues({
      filter,
      first: maxIssues * 2, // Fetch extra to account for filtering
    })

    const results: OrchestratorIssue[] = []
    for (const issue of issues.nodes) {
      if (results.length >= maxIssues) break

      // Filter by allowedProjects from .agentfactory/config.yaml
      let resolvedProjectName: string | undefined
      if (this.allowedProjects && this.allowedProjects.length > 0) {
        const project = await issue.project
        const projectName = project?.name
        if (!projectName || !this.allowedProjects.includes(projectName)) {
          console.warn(
            `[orchestrator] Skipping issue ${issue.identifier} — project "${projectName ?? '(none)'}" is not in allowedProjects: [${this.allowedProjects.join(', ')}]`
          )
          continue
        }
        resolvedProjectName = projectName
      }

      // Resolve project name for path scoping even when not filtering by allowedProjects
      if (!resolvedProjectName && this.projectPaths) {
        const project = await issue.project
        resolvedProjectName = project?.name
      }

      const labels = await issue.labels()
      const team = await issue.team
      results.push({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? undefined,
        url: issue.url,
        priority: issue.priority,
        labels: labels.nodes.map((l: { name: string }) => l.name),
        teamName: team?.name,
        projectName: resolvedProjectName,
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
   * Check if a path is inside the configured .worktrees/ directory.
   *
   * Only paths within the worktrees directory should ever be candidates for
   * automated cleanup. This prevents the main repo or other directories from
   * being targeted.
   */
  private isInsideWorktreesDir(targetPath: string): boolean {
    const worktreesDir = resolve(this.config.worktreePath)
    const normalizedTarget = resolve(targetPath)
    // Must be inside .worktrees/ (not equal to it)
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
   * operates on paths inside the .worktrees/ directory. This prevents
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

    // SAFETY GUARD 2: Only clean up paths inside .worktrees/
    if (!this.isInsideWorktreesDir(conflictPath)) {
      console.warn(
        `SAFETY: Refusing to clean up ${conflictPath} \u2014 it is not inside the worktrees directory. ` +
        `Only paths inside '${resolve(this.config.worktreePath)}' can be auto-cleaned.`
      )
      return false
    }

    if (!existsSync(conflictPath)) {
      // Directory doesn't exist - just prune git's worktree list
      try {
        execSync('git worktree prune', { stdio: 'pipe', encoding: 'utf-8' })
        console.log(`Pruned stale worktree reference for branch ${branchName}`)
        return true
      } catch {
        return false
      }
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

    // Agent is not alive - safe to clean up
    console.log(
      `Cleaning up stale worktree at ${conflictPath} (agent no longer running) ` +
      `to unblock branch ${branchName}`
    )

    try {
      execSync(`git worktree remove "${conflictPath}" --force`, {
        stdio: 'pipe',
        encoding: 'utf-8',
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
        execSync('git worktree prune', { stdio: 'pipe', encoding: 'utf-8' })
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
    const worktreePath = resolve(this.config.worktreePath, worktreeIdentifier)
    // Use issue identifier for branch name (shared across work types)
    const branchName = issueIdentifier

    // Ensure parent directory exists
    const parentDir = resolve(this.config.worktreePath)
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true })
    }

    // Prune any stale worktrees first (handles deleted directories)
    try {
      execSync('git worktree prune', { stdio: 'pipe', encoding: 'utf-8' })
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
        execSync('git worktree prune', { stdio: 'pipe', encoding: 'utf-8' })
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

    return { worktreePath, worktreeIdentifier }
  }

  /**
   * Clean up a git worktree
   *
   * @param worktreeIdentifier - Worktree identifier with work type suffix (e.g., "SUP-294-QA")
   */
  removeWorktree(worktreeIdentifier: string): void {
    const worktreePath = resolve(this.config.worktreePath, worktreeIdentifier)

    if (existsSync(worktreePath)) {
      try {
        execSync(`git worktree remove "${worktreePath}" --force`, {
          stdio: 'pipe',
          encoding: 'utf-8',
        })
      } catch (error) {
        console.warn(`Failed to remove worktree via git, trying fallback:`, error)
        try {
          execSync(`rm -rf "${worktreePath}"`, { stdio: 'pipe', encoding: 'utf-8' })
          execSync('git worktree prune', { stdio: 'pipe', encoding: 'utf-8' })
        } catch (fallbackError) {
          console.warn(`Fallback worktree removal also failed:`, fallbackError)
        }
      }
    } else {
      // Directory gone but git may still track it
      try {
        execSync('git worktree prune', { stdio: 'pipe', encoding: 'utf-8' })
      } catch {
        // Ignore
      }
    }
  }

  /**
   * Link dependencies from the main repo into a worktree via symlinks.
   *
   * For Node.js/pnpm monorepos, this symlinks node_modules from the main repo
   * into the worktree — instant (~0s) vs pnpm install (~10+ min on cross-volume).
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
      // Symlink root node_modules
      const destRoot = resolve(worktreePath, 'node_modules')
      if (!existsSync(destRoot)) {
        symlinkSync(mainNodeModules, destRoot)
      }

      // Symlink per-workspace node_modules (apps/*, packages/*)
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

          if (!existsSync(dest)) {
            symlinkSync(src, dest)
          }
        }
      }

      if (skipped > 0) {
        console.log(
          `[${identifier}] Dependencies linked successfully (${skipped} workspace(s) skipped — not on this branch)`
        )
      } else {
        console.log(`[${identifier}] Dependencies linked successfully`)
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
   * Fallback: install dependencies via pnpm install.
   * Only called when symlinking fails.
   */
  private installDependencies(worktreePath: string, identifier: string): void {
    console.log(`[${identifier}] Installing dependencies via pnpm...`)

    // Remove any root node_modules symlink from a partial linkDependencies attempt.
    // Without this, pnpm install writes through the symlink into the main repo's
    // node_modules, corrupting it and forcing the user to re-run pnpm install.
    const destRoot = resolve(worktreePath, 'node_modules')
    try {
      if (existsSync(destRoot) && lstatSync(destRoot).isSymbolicLink()) {
        rmSync(destRoot)
        console.log(`[${identifier}] Removed partial node_modules symlink before install`)
      }
    } catch {
      // Ignore cleanup errors — pnpm install may still work
    }

    // Also remove any per-workspace symlinks that were partially created
    for (const subdir of ['apps', 'packages']) {
      const subPath = resolve(worktreePath, subdir)
      if (!existsSync(subPath)) continue
      try {
        for (const entry of readdirSync(subPath)) {
          const nm = resolve(subPath, entry, 'node_modules')
          if (existsSync(nm) && lstatSync(nm).isSymbolicLink()) {
            rmSync(nm)
          }
        }
      } catch {
        // Ignore cleanup errors
      }
    }

    try {
      execSync('pnpm install --frozen-lockfile 2>&1', {
        cwd: worktreePath,
        stdio: 'pipe',
        encoding: 'utf-8',
        timeout: 120_000,
      })
      console.log(`[${identifier}] Dependencies installed successfully`)
    } catch {
      try {
        execSync('pnpm install 2>&1', {
          cwd: worktreePath,
          stdio: 'pipe',
          encoding: 'utf-8',
          timeout: 120_000,
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
   * @deprecated Use linkDependencies() instead. This now delegates to linkDependencies.
   */
  preInstallDependencies(worktreePath: string, identifier: string): void {
    this.linkDependencies(worktreePath, identifier)
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
    } = options

    // Generate prompt based on work type, or use custom prompt if provided
    // Try template registry first, fall back to hardcoded prompts
    let prompt: string
    if (customPrompt) {
      prompt = customPrompt
    } else if (this.templateRegistry?.hasTemplate(workType)) {
      const context: TemplateContext = {
        identifier,
        repository: this.config.repository,
        projectPath: this.projectPaths?.[projectName ?? ''],
        sharedPaths: this.sharedPaths,
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
    }

    this.activeAgents.set(issueId, agent)

    // Track session to issue mapping for stop signal handling
    if (sessionId) {
      this.sessionToIssue.set(sessionId, issueId)
    }

    // Initialize state persistence and monitoring
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

      log.debug('State persistence initialized', { agentDir: resolve(worktreePath, '.agent') })
    } catch (stateError) {
      // Log but don't fail - state persistence is optional
      log.warn('Failed to initialize state persistence', {
        error: stateError instanceof Error ? stateError.message : String(stateError),
      })
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
        const session = createAgentSession({
          client: this.client.linearClient,
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
    const settingsEnv = loadSettingsEnv(worktreePath, log)

    // Load app-specific env files based on work type
    // Development work loads .env.local, QA/acceptance loads .env.test.local
    const appEnv = loadAppEnvFiles(worktreePath, workType, log)

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
    if (workType === 'coordination' || workType === 'qa-coordination' || workType === 'acceptance-coordination') {
      env.SHARED_WORKTREE = 'true'
    }

    // Set Claude Code Task List ID for intra-issue task coordination
    // This enables Tasks to persist across crashes and be shared between subagents
    // Format: {issueIdentifier}-{WORKTYPE} (e.g., "SUP-123-DEV")
    env.CLAUDE_CODE_TASK_LIST_ID = worktreeIdentifier

    // Set team name so agents can use `pnpm af-linear create-issue` without --team
    if (teamName) {
      env.LINEAR_TEAM_NAME = teamName
    }

    log.info('Starting agent via provider', { provider: this.provider.name, worktreePath, workType, promptPreview: prompt.substring(0, 50) })

    // Spawn agent via provider interface
    const spawnConfig: AgentSpawnConfig = {
      prompt,
      cwd: worktreePath,
      env,
      abortController,
      autonomous: true,
      sandboxEnabled: this.config.sandboxEnabled,
      onProcessSpawned: (pid) => {
        agent.pid = pid
        log.info('Agent process spawned', { pid })
      },
    }

    const handle = this.provider.spawn(spawnConfig)

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

    try {
      for await (const event of handle.stream) {
        await this.handleAgentEvent(issueId, sessionId, event, emitter, agent, handle)
      }

      // Query completed successfully
      if (agent.status !== 'stopped') {
        agent.status = 'completed'
      }
      agent.completedAt = new Date()

      // Update state file to completed
      try {
        updateState(agent.worktreePath, {
          status: agent.status === 'stopped' ? 'stopped' : 'completed',
          pullRequestUrl: agent.pullRequestUrl ?? undefined,
        })
      } catch {
        // Ignore state update errors
      }

      // Flush remaining activities
      if (emitter) {
        await emitter.flush()
      }

      // Update Linear status based on work type if auto-transition is enabled
      if (agent.status === 'completed' && this.config.autoTransition) {
        const workType = agent.workType ?? 'development'
        const isResultSensitive = workType === 'qa' || workType === 'acceptance' || workType === 'qa-coordination' || workType === 'acceptance-coordination'

        let targetStatus: LinearWorkflowStatus | null = null

        if (isResultSensitive) {
          // For QA/acceptance: parse result to decide promote vs reject
          const workResult = parseWorkResult(agent.resultMessage, workType)
          agent.workResult = workResult

          if (workResult === 'passed') {
            targetStatus = WORK_TYPE_COMPLETE_STATUS[workType]
            log?.info('Work result: passed, promoting', { workType, targetStatus })
          } else if (workResult === 'failed') {
            targetStatus = WORK_TYPE_FAIL_STATUS[workType]
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
        } else {
          // Non-QA/acceptance: unchanged behavior — always promote on completion
          targetStatus = WORK_TYPE_COMPLETE_STATUS[workType]
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
        const isDevelopmentWork = agent.workType === 'development' || agent.workType === 'inflight'
        let shouldCleanup = true

        // For development work, validate that PR was created or work was fully pushed
        if (shouldPreserve && isDevelopmentWork) {
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
            } else {
              // No PR but also no local changes - agent may not have made any changes
              log?.warn('No PR created but worktree is clean - proceeding with cleanup', {
                worktreePath: agent.worktreePath,
              })
            }
          }
        }

        if (shouldCleanup) {
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
          }
        }

        if (shouldCleanup) {
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
        agent.claudeSessionId = event.sessionId
        this.updateLastActivity(issueId, 'init')

        // Update state with provider session ID
        try {
          updateState(agent.worktreePath, {
            claudeSessionId: event.sessionId,
            status: 'running',
            pid: agent.pid ?? null,
          })
        } catch {
          // Ignore state update errors
        }

        // Notify via callback for external persistence
        if (sessionId) {
          await this.events.onClaudeSessionId?.(sessionId, event.sessionId)
        }
        break

      case 'system':
        // System-level events (status changes, compaction, auth, etc.)
        if (event.subtype === 'status') {
          log?.debug('Status change', { status: event.message })
        } else if (event.subtype === 'compact_boundary') {
          log?.debug('Context compacted')
        } else if (event.subtype === 'hook_response') {
          // Provider-specific hook handling — access raw event for details
          const raw = event.raw as { exit_code?: number; hook_name?: string }
          if (raw.exit_code !== undefined && raw.exit_code !== 0) {
            log?.warn('Hook failed', { hook: raw.hook_name, exitCode: raw.exit_code })
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
        heartbeatWriter?.recordThinking()
        sessionLogger?.logAssistant(event.text)
        if (emitter) {
          await emitter.emitThought(event.text.substring(0, 200))
        }
        break

      case 'tool_use':
        // Tool invocation
        this.updateLastActivity(issueId, 'assistant')
        log?.toolCall(event.toolName, event.input)
        heartbeatWriter?.recordToolCall(event.toolName)
        progressLogger?.logTool(event.toolName, event.input)
        sessionLogger?.logToolUse(event.toolName, event.input)

        // Intercept TodoWrite tool calls to persist todos
        if (event.toolName === 'TodoWrite') {
          try {
            const input = event.input as { todos?: TodoItem[] }
            if (input.todos && Array.isArray(input.todos)) {
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
          }

          // Update state to completing/completed
          try {
            updateState(agent.worktreePath, {
              status: 'completing',
              currentPhase: 'Finalizing work',
            })
            progressLogger?.logComplete({ message: event.message?.substring(0, 200) })
          } catch {
            // Ignore state update errors
          }

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
          // Error result
          log?.error('Agent error result', { subtype: event.errorSubtype })

          // Update state to failed
          const errorMessage = event.errors && event.errors.length > 0
            ? event.errors[0]
            : `Agent error: ${event.errorSubtype}`
          try {
            updateState(agent.worktreePath, {
              status: 'failed',
              errorMessage,
            })
            progressLogger?.logError('Agent error result', new Error(errorMessage))
            sessionLogger?.logError('Agent error result', new Error(errorMessage), { subtype: event.errorSubtype })
          } catch {
            // Ignore state update errors
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
      // Direct Linear API - use AgentSession if available
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
    const comments = buildCompletionComments(
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
        // Backlog issues are always development work
        const workType: AgentWorkType = 'development'

        // Create worktree with work type suffix
        const { worktreePath, worktreeIdentifier } = this.createWorktree(issue.identifier, workType)

        // Link dependencies from main repo into worktree
        this.linkDependencies(worktreePath, issue.identifier)

        const startStatus = WORK_TYPE_START_STATUS[workType]

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
    const team = await issue.team
    const teamName = team?.name

    // Resolve project name for path scoping in monorepos
    let projectName: string | undefined
    if (this.projectPaths) {
      const project = await issue.project
      projectName = project?.name
    }

    console.log(`Processing single issue: ${identifier} (${issueId}) - ${issue.title}`)

    // Defense in depth: re-validate git remote before spawning (guards against long-running instances)
    if (this.config.repository) {
      validateGitRemote(this.config.repository)
    }

    // Auto-detect work type from issue status if not provided
    // This must happen BEFORE creating worktree since path includes work type suffix
    let effectiveWorkType = workType
    if (!effectiveWorkType) {
      const state = await issue.state
      const statusName = state?.name ?? 'Backlog'
      effectiveWorkType = STATUS_WORK_TYPE_MAP[statusName] ?? 'development'
      console.log(`Auto-detected work type: ${effectiveWorkType} (from status: ${statusName})`)
    }

    // Create worktree with work type suffix (e.g., SUP-294-QA)
    const { worktreePath, worktreeIdentifier } = this.createWorktree(identifier, effectiveWorkType)

    // Link dependencies from main repo into worktree
    this.linkDependencies(worktreePath, identifier)

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

      // Use existing Claude session ID for resume if available
      const claudeSessionId = recoveryCheck.state.claudeSessionId ?? undefined

      // Inherit work type from previous state if not provided
      const recoveryWorkType = workType ?? recoveryCheck.state.workType ?? effectiveWorkType
      const effectiveSessionId = sessionId ?? recoveryCheck.state.linearSessionId ?? randomUUID()

      console.log(`Resuming work on ${identifier} (recovery attempt ${updatedState?.recoveryAttempts ?? 1})`)

      // Update status based on work type if auto-transition is enabled
      const startStatus = WORK_TYPE_START_STATUS[recoveryWorkType]
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
        claudeSessionId,
        workType: recoveryWorkType,
        teamName,
        projectName,
      })
    }

    // No recovery needed - proceed with fresh spawn
    // Update status based on work type if auto-transition is enabled
    const startStatus = WORK_TYPE_START_STATUS[effectiveWorkType]
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
    })
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

      // Clean up worktree if requested
      if (cleanupWorktree) {
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
    claudeSessionId?: string,
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
    let worktreePath: string
    let worktreeIdentifier: string
    let identifier: string
    let teamName: string | undefined

    if (existingAgent) {
      worktreePath = existingAgent.worktreePath
      worktreeIdentifier = existingAgent.worktreeIdentifier
      identifier = existingAgent.identifier
      // Use existing Claude session ID if not provided
      claudeSessionId = claudeSessionId ?? existingAgent.claudeSessionId
      // Inherit work type from existing agent if not provided
      workType = workType ?? existingAgent.workType
    } else {
      // Need to fetch issue to get identifier
      try {
        const issue = await this.client.getIssue(issueId)
        identifier = issue.identifier
        const issueTeam = await issue.team
        teamName = issueTeam?.name

        // Auto-detect work type from issue status if not provided
        // This prevents defaulting to 'development' which would cause
        // incorrect status transitions (e.g., Delivered \u2192 Started for acceptance work)
        if (!workType) {
          const state = await issue.state
          const statusName = state?.name ?? 'Backlog'
          workType = STATUS_WORK_TYPE_MAP[statusName] ?? 'development'
        }

        const result = this.createWorktree(identifier, workType)
        worktreePath = result.worktreePath
        worktreeIdentifier = result.worktreeIdentifier

        // Link dependencies from main repo into worktree
        this.linkDependencies(worktreePath, identifier)
      } catch (error) {
        return {
          forwarded: false,
          resumed: false,
          reason: 'not_found',
          error: error instanceof Error ? error : new Error(String(error)),
        }
      }
    }

    // Check if worktree exists
    if (!existsSync(worktreePath)) {
      try {
        const result = this.createWorktree(identifier, workType ?? 'development')
        worktreePath = result.worktreePath
        worktreeIdentifier = result.worktreeIdentifier

        // Link dependencies from main repo into worktree
        this.linkDependencies(worktreePath, identifier)
      } catch (error) {
        return {
          forwarded: false,
          resumed: false,
          reason: 'no_worktree',
          error: error instanceof Error ? error : new Error(String(error)),
        }
      }
    }

    // Spawn agent with resume if we have a Claude session ID
    try {
      const agent = await this.spawnAgentWithResume({
        issueId,
        identifier,
        worktreeIdentifier,
        sessionId,
        worktreePath,
        prompt,
        claudeSessionId,
        workType,
        teamName,
      })

      return {
        forwarded: true,
        resumed: !!claudeSessionId,
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
    const { issueId, identifier, worktreeIdentifier, sessionId, worktreePath, prompt, claudeSessionId, workType, teamName } = options

    // Create logger for this agent
    const log = createLogger({ issueIdentifier: identifier })
    this.agentLoggers.set(issueId, log)

    // Use the work type to determine if we need to transition on start
    // Only certain work types trigger a start transition
    const effectiveWorkType = workType ?? 'development'
    const startStatus = WORK_TYPE_START_STATUS[effectiveWorkType]

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
      claudeSessionId,
      worktreePath,
      pid: undefined,
      status: 'starting',
      startedAt: now,
      lastActivityAt: now, // Initialize for inactivity tracking
      workType,
    }

    this.activeAgents.set(issueId, agent)

    // Track session to issue mapping for stop signal handling
    this.sessionToIssue.set(sessionId, issueId)

    // Initialize state persistence and monitoring (for resumed sessions)
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
      // Preserve Claude session ID if resuming
      if (claudeSessionId) {
        initialState.claudeSessionId = claudeSessionId
      }
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

      log.debug('State persistence initialized', { agentDir: resolve(worktreePath, '.agent') })
    } catch (stateError) {
      // Log but don't fail - state persistence is optional
      log.warn('Failed to initialize state persistence', {
        error: stateError instanceof Error ? stateError.message : String(stateError),
      })
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
      // Direct Linear API
      const session = createAgentSession({
        client: this.client.linearClient,
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
    const settingsEnv = loadSettingsEnv(worktreePath, log)

    // Load app-specific env files based on work type
    // Development work loads .env.local, QA/acceptance loads .env.test.local
    const effectiveWorkTypeForEnv = workType ?? 'development'
    const appEnv = loadAppEnvFiles(worktreePath, effectiveWorkTypeForEnv, log)

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
      provider: this.provider.name,
      worktreePath,
      resuming: !!claudeSessionId,
      workType: workType ?? 'development',
    })

    // Spawn agent via provider interface (with resume if session ID available)
    const spawnConfig: AgentSpawnConfig = {
      prompt,
      cwd: worktreePath,
      env,
      abortController,
      autonomous: true,
      sandboxEnabled: this.config.sandboxEnabled,
      onProcessSpawned: (pid) => {
        agent.pid = pid
        log.info('Agent process spawned', { pid })
      },
    }

    const handle = claudeSessionId
      ? this.provider.resume(claudeSessionId, spawnConfig)
      : this.provider.spawn(spawnConfig)

    this.agentHandles.set(issueId, handle)
    agent.status = 'running'

    // Process the event stream in the background
    this.processEventStream(issueId, identifier, sessionId, handle, emitter, agent)

    return agent
  }

  /**
   * Stop all running agents
   */
  stopAll(): void {
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
