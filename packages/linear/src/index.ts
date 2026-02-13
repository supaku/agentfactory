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
} from './types.js'

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
} from './types.js'

export type { WorkTypeValidationResult } from './types.js'

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
} from './errors.js'

// Retry utilities
export {
  DEFAULT_RETRY_CONFIG,
  sleep,
  calculateDelay,
  withRetry,
  createRetryWrapper,
} from './retry.js'
export type { RetryContext, RetryCallback, WithRetryOptions } from './retry.js'

// Constants
export {
  LINEAR_COMMENT_MAX_LENGTH,
  TRUNCATION_MARKER,
  MAX_COMPLETION_COMMENTS,
  COMMENT_OVERHEAD,
  CONTINUATION_MARKER,
  getDefaultTeamId,
  LINEAR_PROJECTS,
  LINEAR_LABELS,
  ENVIRONMENT_ISSUE_TYPES,
} from './constants.js'
export type { EnvironmentIssueType } from './constants.js'

// Utilities
export {
  truncateText,
  buildCompletionComment,
  splitContentIntoComments,
  buildCompletionComments,
} from './utils.js'
export type { CommentChunk } from './utils.js'

// Checkbox utilities
export {
  parseCheckboxes,
  updateCheckbox,
  updateCheckboxByText,
  updateCheckboxes,
  hasCheckboxes,
  getCheckboxSummary,
} from './checkbox-utils.js'
export type { CheckboxItem, CheckboxUpdate } from './checkbox-utils.js'

// Client
export { LinearAgentClient, createLinearAgentClient } from './agent-client.js'

// Session
export { AgentSession, createAgentSession } from './agent-session.js'

// Webhook types
export * from './webhook-types.js'

// Default implementations (prompt templates, work type detection, priority, auto-trigger)
export {
  defaultGeneratePrompt,
  defaultBuildParentQAContext,
  defaultBuildParentAcceptanceContext,
  defaultDetectWorkTypeFromPrompt,
  defaultGetPriority,
  defaultParseAutoTriggerConfig,
  type DefaultAutoTriggerConfig,
} from './defaults/index.js'
