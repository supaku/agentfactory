/**
 * Linear API Constants
 *
 * Contains API limits, well-known IDs, and configuration values.
 * All workspace-specific IDs must be provided via environment variables.
 */

// ============================================================================
// LINEAR API LIMITS
// ============================================================================

/**
 * Maximum length for comment body.
 * Linear doesn't publicly document this limit, but testing shows ~10k is safe.
 * We use a conservative limit to avoid truncation issues.
 */
export const LINEAR_COMMENT_MAX_LENGTH = 10000

/**
 * Marker appended when content is truncated
 */
export const TRUNCATION_MARKER = '\n\n... (content truncated)'

/**
 * Maximum number of comments for a single completion (safety limit)
 */
export const MAX_COMPLETION_COMMENTS = 10

/**
 * Characters reserved for part markers and overhead
 */
export const COMMENT_OVERHEAD = 100

/**
 * Continuation marker for multi-part comments
 */
export const CONTINUATION_MARKER = '\n\n*...continued in next comment*'

// ============================================================================
// WELL-KNOWN LINEAR IDs
// All workspace-specific IDs are loaded from environment variables.
// No hardcoded fallback UUIDs — configure via env vars.
// ============================================================================

/**
 * Default team UUID
 * Must be set via LINEAR_TEAM_ID env var
 *
 * Uses a getter to read lazily from process.env, avoiding ESM import
 * hoisting issues where the value is captured before dotenv runs.
 */
export function getDefaultTeamId(): string {
  return process.env.LINEAR_TEAM_ID ?? ''
}

/**
 * Project IDs — must be set via env vars:
 * - LINEAR_PROJECT_AGENT
 * - LINEAR_PROJECT_SOCIAL
 * - LINEAR_PROJECT_TEST
 */
export const LINEAR_PROJECTS = {
  get AGENT() { return process.env.LINEAR_PROJECT_AGENT ?? '' },
  get SOCIAL() { return process.env.LINEAR_PROJECT_SOCIAL ?? '' },
  /** Test project for E2E testing of orchestrator */
  get TEST() { return process.env.LINEAR_PROJECT_TEST ?? '' },
} as const

/**
 * Label IDs for issue classification
 * Must be set via env vars:
 * - LINEAR_LABEL_BUG
 * - LINEAR_LABEL_FEATURE
 * - LINEAR_LABEL_CHORE
 */
export const LINEAR_LABELS = {
  get BUG() { return process.env.LINEAR_LABEL_BUG ?? '' },
  get FEATURE() { return process.env.LINEAR_LABEL_FEATURE ?? '' },
  get CHORE() { return process.env.LINEAR_LABEL_CHORE ?? '' },
  get NEEDS_HUMAN() { return process.env.LINEAR_LABEL_NEEDS_HUMAN ?? '' },
} as const

// Test-related labels (created dynamically, not hardcoded IDs)
export const TEST_LABEL_NAMES = {
  /** Mark issues as test fixtures (not for manual processing) */
  TEST_FIXTURE: 'test-fixture',
  /** Identify issues created by E2E tests */
  E2E_TEST: 'e2e-test',
} as const

// ============================================================================
// ENVIRONMENT ISSUE REPORTING
// ============================================================================

/**
 * Categories of environment issues that agents can report
 */
export const ENVIRONMENT_ISSUE_TYPES = {
  PERMISSION: 'permission',
  NETWORK: 'network',
  SANDBOX: 'sandbox',
  LINEAR_CLI: 'linear-cli',
  DEPENDENCY: 'dependency',
  TIMEOUT: 'timeout',
  TOOL: 'tool',
  HUMAN_BLOCKER: 'human-blocker',
} as const

export type EnvironmentIssueType =
  (typeof ENVIRONMENT_ISSUE_TYPES)[keyof typeof ENVIRONMENT_ISSUE_TYPES]
