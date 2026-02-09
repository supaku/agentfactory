// Types
export type {
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
  WorkTypeTimeoutConfig,
  AgentWorkResult,
} from './types'

// Stream Parser Types
export type {
  ClaudeStreamEvent,
  ClaudeInitEvent,
  ClaudeSystemEvent,
  ClaudeAssistantEvent,
  ClaudeToolUseEvent,
  ClaudeToolResultEvent,
  ClaudeResultEvent,
  ClaudeErrorEvent,
  ClaudeTodoItem,
  ClaudeUserEvent,
  ClaudeEvent,
  ClaudeStreamHandlers,
} from './stream-parser'

// Activity Emitter Types
export type { ActivityEmitterConfig } from './activity-emitter'

// API Activity Emitter Types
export type { ApiActivityEmitterConfig, ProgressMilestone } from './api-activity-emitter'

// State Types (for durable agent hosting)
export type {
  WorktreeState,
  WorktreeStatus,
  HeartbeatState,
  HeartbeatActivityType,
  TodosState,
  TodoItem,
  TodoStatus,
  ProgressLogEntry,
  ProgressEventType,
  RecoveryCheckResult,
  HeartbeatWriterConfig,
  ProgressLoggerConfig,
} from './state-types'

// Log Config Types (for session logging)
export type { LogAnalysisConfig } from './log-config'

// Session Logger Types (for verbose logging)
export type {
  SessionEventType,
  SessionEvent,
  SessionMetadata,
  SessionLoggerConfig,
} from './session-logger'

// Log Analyzer Types (for analysis and issue creation)
export type {
  PatternType,
  PatternSeverity,
  AnalyzedPattern,
  AnalysisResult,
  SuggestedIssue,
  TrackedIssue,
  DeduplicationStore,
} from './log-analyzer'

// Orchestrator
export { AgentOrchestrator, createOrchestrator, getWorktreeIdentifier } from './orchestrator'

// Stream Parser
export { ClaudeStreamParser, createStreamParser } from './stream-parser'

// Activity Emitter
export { ActivityEmitter, createActivityEmitter } from './activity-emitter'

// API Activity Emitter (for remote workers proxying through API)
export { ApiActivityEmitter, createApiActivityEmitter } from './api-activity-emitter'

// Heartbeat Writer (for crash detection)
export {
  HeartbeatWriter,
  createHeartbeatWriter,
  getHeartbeatIntervalFromEnv,
} from './heartbeat-writer'

// Progress Logger (for debugging)
export { ProgressLogger, createProgressLogger } from './progress-logger'

// State Recovery (for crash recovery)
export {
  getAgentDir,
  getStatePath,
  getHeartbeatPath,
  getTodosPath,
  isHeartbeatFresh,
  readWorktreeState,
  readHeartbeat,
  readTodos,
  checkRecovery,
  initializeAgentDir,
  writeState,
  updateState,
  writeTodos,
  createInitialState,
  buildRecoveryPrompt,
  getHeartbeatTimeoutFromEnv,
  getMaxRecoveryAttemptsFromEnv,
  getTaskListId,
} from './state-recovery'

// Log Config
export {
  getLogAnalysisConfig,
  isSessionLoggingEnabled,
  isAutoAnalyzeEnabled,
} from './log-config'

// Session Logger
export {
  SessionLogger,
  createSessionLogger,
  readSessionMetadata,
  readSessionEvents,
} from './session-logger'

// Work Result Parser (for QA/acceptance pass/fail detection)
export { parseWorkResult } from './parse-work-result'

// Log Analyzer
export { LogAnalyzer, createLogAnalyzer } from './log-analyzer'
