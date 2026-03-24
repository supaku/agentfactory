/**
 * Workflow Definition System
 *
 * Declarative workflow graph definitions using YAML (v1.1 schema extension).
 * Defines phases, transitions, escalation ladder, gates, and parallelism.
 */

export type {
  EscalationStrategy,
  PhaseDefinition,
  TransitionDefinition,
  EscalationLadderRung,
  EscalationConfig,
  GateDefinition,
  ParallelismGroupDefinition,
  WorkflowDefinition,
  BranchingDefinition,
  TemplateRetryConfig,
  TemplateTimeoutConfig,
} from './workflow-types.js'

export {
  PhaseDefinitionSchema,
  TransitionDefinitionSchema,
  EscalationLadderRungSchema,
  EscalationConfigSchema,
  GateDefinitionSchema,
  ParallelismGroupDefinitionSchema,
  WorkflowDefinitionSchema,
  BranchingDefinitionSchema,
  TemplateRetryConfigSchema,
  TemplateTimeoutConfigSchema,
  validateWorkflowDefinition,
} from './workflow-types.js'

export {
  loadWorkflowDefinitionFile,
  getBuiltinWorkflowDir,
  getBuiltinWorkflowPath,
} from './workflow-loader.js'

export type { WorkflowRegistryConfig, WorkflowStoreSource } from './workflow-registry.js'
export { WorkflowRegistry } from './workflow-registry.js'

export type { TransitionContext, TransitionResult } from './transition-engine.js'
export { evaluateTransitions } from './transition-engine.js'

export type { BranchingResult } from './branching-router.js'
export { evaluateBranching } from './branching-router.js'

// Duration parser
export { parseDuration, DurationParseError } from './duration.js'

// Retry/timeout resolution
export type { ResolvedRetryConfig, ResolvedTimeoutConfig } from './retry-resolver.js'
export { resolveRetryConfig, resolveTimeoutConfig } from './retry-resolver.js'

// Expression module re-exports for consumers
export type { EvaluationContext } from './expression/index.js'
export { buildEvaluationContext, evaluateCondition } from './expression/index.js'

// Gate state types
export type { GateState, GateStorage } from './gate-state.js'
export {
  InMemoryGateStorage,
  initGateStorage,
  activateGate,
  satisfyGate,
  timeoutGate,
} from './gate-state.js'
export { parseDuration as parseGateDuration } from './gate-state.js'

// Signal gate types and functions
export type { SignalGateTrigger, SignalGateResult } from './gates/signal-gate.js'
export {
  isSignalGateTrigger,
  evaluateSignalGate,
  getApplicableSignalGates,
  createImplicitHoldGate,
  createImplicitResumeGate,
  IMPLICIT_HOLD_GATE_NAME,
  IMPLICIT_RESUME_GATE_NAME,
} from './gates/signal-gate.js'

// Webhook gate types and functions
export type { WebhookGateTrigger, WebhookGateResult, WebhookGateActivation } from './gates/webhook-gate.js'
export {
  generateWebhookToken,
  buildCallbackUrl,
  validateWebhookCallback,
  evaluateWebhookGate,
  isWebhookGateTrigger,
  getApplicableWebhookGates,
  createWebhookGateActivation,
} from './gates/webhook-gate.js'

// Timeout engine types and functions
export type { TimeoutCheckResult, TimedOutGate, TimeoutResolution } from './gates/timeout-engine.js'
export {
  checkGateTimeout,
  checkAllGateTimeouts,
  resolveTimeoutAction,
  processGateTimeouts,
} from './gates/timeout-engine.js'

// Timer gate types and functions
export type { TimerGateTrigger, TimerGateResult } from './gates/timer-gate.js'
export {
  evaluateTimerGate,
  computeNextCronFireTime,
  isTimerGateTrigger,
  getApplicableTimerGates,
  parseCronField,
  parseCronExpression,
} from './gates/timer-gate.js'

// Gate evaluator (main orchestration)
export type { GateEvaluationOptions, GateEvaluationResult } from './gates/gate-evaluator.js'
export {
  evaluateGatesForPhase,
  activateGatesForPhase,
  clearGatesForIssue,
  getApplicableGates,
} from './gates/gate-evaluator.js'
