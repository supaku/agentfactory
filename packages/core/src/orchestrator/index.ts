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
} from './types.js'

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
} from './stream-parser.js'

// Activity Emitter Types
export type { ActivityEmitterConfig } from './activity-emitter.js'

// API Activity Emitter Types
export type { ApiActivityEmitterConfig, ProgressMilestone } from './api-activity-emitter.js'

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
} from './state-types.js'

// Log Config Types (for session logging)
export type { LogAnalysisConfig } from './log-config.js'

// Session Logger Types (for verbose logging)
export type {
  SessionEventType,
  SessionEvent,
  SessionMetadata,
  SessionLoggerConfig,
} from './session-logger.js'

// Log Analyzer Types (for analysis and issue creation)
export type {
  PatternType,
  PatternSeverity,
  AnalyzedPattern,
  AnalysisResult,
  SuggestedIssue,
  TrackedIssue,
  DeduplicationStore,
} from './log-analyzer.js'

// Orchestrator
export { AgentOrchestrator, createOrchestrator, getWorktreeIdentifier, validateGitRemote } from './orchestrator.js'

// Stream Parser
export { ClaudeStreamParser, createStreamParser } from './stream-parser.js'

// Activity Emitter
export { ActivityEmitter, createActivityEmitter } from './activity-emitter.js'

// API Activity Emitter (for remote workers proxying through API)
export { ApiActivityEmitter, createApiActivityEmitter } from './api-activity-emitter.js'

// Heartbeat Writer (for crash detection)
export {
  HeartbeatWriter,
  createHeartbeatWriter,
  getHeartbeatIntervalFromEnv,
} from './heartbeat-writer.js'

// Progress Logger (for debugging)
export { ProgressLogger, createProgressLogger } from './progress-logger.js'

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
} from './state-recovery.js'

// Log Config
export {
  getLogAnalysisConfig,
  isSessionLoggingEnabled,
  isAutoAnalyzeEnabled,
} from './log-config.js'

// Session Logger
export {
  SessionLogger,
  createSessionLogger,
  readSessionMetadata,
  readSessionEvents,
} from './session-logger.js'

// Work Result Parser (for QA/acceptance pass/fail detection)
export { parseWorkResult } from './parse-work-result.js'

// Log Analyzer
export { LogAnalyzer, createLogAnalyzer } from './log-analyzer.js'
