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
} from './workflow-types.js'

export {
  PhaseDefinitionSchema,
  TransitionDefinitionSchema,
  EscalationLadderRungSchema,
  EscalationConfigSchema,
  GateDefinitionSchema,
  ParallelismGroupDefinitionSchema,
  WorkflowDefinitionSchema,
  validateWorkflowDefinition,
} from './workflow-types.js'

export {
  loadWorkflowDefinitionFile,
  getBuiltinWorkflowDir,
  getBuiltinWorkflowPath,
} from './workflow-loader.js'
