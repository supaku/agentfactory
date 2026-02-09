// Types
export type {
  AgentSessionState,
  AgentActivityType,
  AgentActivitySignal,
  AgentActivityContent,
  AgentActivityContentPayload,
  ThoughtActivityContent,
  ActionActivityContent,
  ResponseActivityContent,
  ElicitationActivityContent,
  ErrorActivityContent,
  PromptActivityContent,
  AgentActivityCreateInput,
  AgentActivityResult,
  CreateActivityOptions,
  AgentPlanItemState,
  AgentPlanItem,
  AgentPlan,
  AgentSignals,
  LinearAgentClientConfig,
  RetryConfig,
  LinearWorkflowStatus,
  StatusMapping,
  AgentSessionConfig,
  SessionOperationResult,
  AgentSessionExternalUrl,
  AgentSessionUpdateInput,
  AgentSessionUpdateResult,
  AgentSessionCreateOnIssueInput,
  AgentSessionCreateResult,
  AgentWorkType,
  // Issue relations
  IssueRelationType,
  IssueRelationCreateInput,
  IssueRelationResult,
  IssueRelationBatchResult,
  IssueRelationInfo,
  IssueRelationsResult,
  // Sub-issue graph (coordination)
  SubIssueGraphNode,
  SubIssueGraph,
  SubIssueStatus,
} from './types'

// Work type mappings for status-based routing
export {
  STATUS_WORK_TYPE_MAP,
  WORK_TYPE_START_STATUS,
  WORK_TYPE_COMPLETE_STATUS,
  WORK_TYPE_FAIL_STATUS,
  WORK_TYPE_ALLOWED_STATUSES,
  STATUS_VALID_WORK_TYPES,
  TERMINAL_STATUSES,
  validateWorkTypeForStatus,
  getValidWorkTypesForStatus,
} from './types'

export type { WorkTypeValidationResult } from './types'

// Errors
export {
  LinearAgentError,
  LinearApiError,
  LinearRetryExhaustedError,
  LinearSessionError,
  LinearActivityError,
  LinearPlanError,
  LinearStatusTransitionError,
  AgentSpawnError,
  isLinearAgentError,
  isRetryableError,
  isAgentSpawnError,
} from './errors'

// Retry utilities
export {
  DEFAULT_RETRY_CONFIG,
  sleep,
  calculateDelay,
  withRetry,
  createRetryWrapper,
} from './retry'
export type { RetryContext, RetryCallback, WithRetryOptions } from './retry'

// Constants
export {
  LINEAR_COMMENT_MAX_LENGTH,
  TRUNCATION_MARKER,
  MAX_COMPLETION_COMMENTS,
  COMMENT_OVERHEAD,
  CONTINUATION_MARKER,
  DEFAULT_TEAM_ID,
  LINEAR_PROJECTS,
  LINEAR_LABELS,
  ENVIRONMENT_ISSUE_TYPES,
} from './constants'
export type { EnvironmentIssueType } from './constants'

// Utilities
export {
  truncateText,
  buildCompletionComment,
  splitContentIntoComments,
  buildCompletionComments,
} from './utils'
export type { CommentChunk } from './utils'

// Checkbox utilities
export {
  parseCheckboxes,
  updateCheckbox,
  updateCheckboxByText,
  updateCheckboxes,
  hasCheckboxes,
  getCheckboxSummary,
} from './checkbox-utils'
export type { CheckboxItem, CheckboxUpdate } from './checkbox-utils'

// Client
export { LinearAgentClient, createLinearAgentClient } from './agent-client'

// Session
export { AgentSession, createAgentSession } from './agent-session'
