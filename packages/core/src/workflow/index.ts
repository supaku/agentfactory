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
