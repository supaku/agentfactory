/**
 * Workflow Definition Types
 *
 * TypeScript interfaces and Zod schemas for the WorkflowDefinition document kind.
 * A WorkflowDefinition declares the workflow graph — phases, transitions,
 * escalation ladder, gates, and parallelism — in YAML rather than hard-coded
 * TypeScript.
 *
 * Supports two schema versions:
 * - **v1.1**: Phase-based workflow with template bindings, transitions, escalation
 * - **v2**: Event-driven workflow with triggers, providers, config, and multi-step nodes
 *
 * Use {@link AnyWorkflowDefinition} for consumers that handle both versions.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Escalation Strategy
// ---------------------------------------------------------------------------

/**
 * Escalation strategies that control how the workflow responds to failures.
 * Mirrors the hard-coded ladder in agent-tracking.ts:computeStrategy().
 */
export type EscalationStrategy =
  | 'normal'
  | 'context-enriched'
  | 'decompose'
  | 'escalate-human'

// ---------------------------------------------------------------------------
// Phase Definition
// ---------------------------------------------------------------------------

/**
 * Declares a structured output that a phase produces.
 * Outputs are extracted from agent results using marker comments.
 */
export interface PhaseOutputDeclaration {
  /** Data type of the output value */
  type: 'string' | 'json' | 'url' | 'boolean'
  /** Human-readable description of the output */
  description?: string
  /** Whether this output must be present (default: false) */
  required?: boolean
}

/**
 * Declares an input dependency on an upstream phase's output.
 */
export interface PhaseInputDeclaration {
  /** Reference to upstream output in "phaseName.outputKey" format */
  from: string
  /** Human-readable description of the input */
  description?: string
}

/**
 * A phase in the workflow graph. Each phase references a WorkflowTemplate
 * by name and optionally provides strategy-specific template variants.
 */
export interface PhaseDefinition {
  /** Unique phase name (e.g., "development", "qa", "refinement") */
  name: string
  /** Human-readable description */
  description?: string
  /** WorkflowTemplate name to use for this phase */
  template: string
  /**
   * Strategy-specific template overrides.
   * Maps escalation strategy name to an alternate template name.
   * Example: { "context-enriched": "refinement-context-enriched" }
   */
  variants?: Record<string, string>
  /** Per-template retry configuration override */
  retry?: TemplateRetryConfig
  /** Per-template timeout configuration */
  timeout?: TemplateTimeoutConfig
  /**
   * Structured outputs this phase produces.
   * Keys are output names; values describe the output type and requirements.
   *
   * Outputs are extracted from agent session results using marker comments
   * and made available to downstream phases via {@link PhaseInputDeclaration.from}.
   *
   * When a phase runs inside a parallelism group, each parallel branch
   * produces its own output values. Downstream phases that declare inputs
   * referencing these outputs receive an aggregated array of all branch values
   * (e.g., an array of PR URLs from all parallel development branches).
   */
  outputs?: Record<string, PhaseOutputDeclaration>
  /**
   * Input dependencies on upstream phase outputs.
   * Keys are local input names; values reference upstream outputs
   * using "phaseName.outputKey" dot-notation in the `from` field.
   *
   * The orchestrator resolves these references before phase execution,
   * injecting the upstream output values into the agent session context.
   * If the upstream phase is part of a parallelism group, the input receives
   * the collected array of all branch outputs rather than a single value.
   */
  inputs?: Record<string, PhaseInputDeclaration>
}

// ---------------------------------------------------------------------------
// Transition Definition
// ---------------------------------------------------------------------------

/**
 * A transition edge in the workflow graph. Maps a Linear status to a phase.
 */
export interface TransitionDefinition {
  /** Source Linear status (e.g., "Backlog", "Finished", "Rejected") */
  from: string
  /** Target phase name (must reference a defined phase) */
  to: string
  /**
   * Optional condition expression. When present, the transition only fires
   * if the condition evaluates to true. Stored as an opaque string in Phase 1;
   * evaluated by the condition engine in Phase 3.
   */
  condition?: string
  /**
   * Evaluation priority. Higher values are evaluated first.
   * Useful when multiple transitions share the same `from` status.
   * Default: 0
   */
  priority?: number
}

// ---------------------------------------------------------------------------
// Escalation Configuration
// ---------------------------------------------------------------------------

/**
 * A single rung on the escalation ladder. Maps a cycle count threshold
 * to an escalation strategy.
 */
export interface EscalationLadderRung {
  /** Cycle count at which this strategy activates */
  cycle: number
  /** Strategy to apply at this cycle count */
  strategy: string
}

/**
 * Escalation configuration controlling retry behavior and circuit breakers.
 */
export interface EscalationConfig {
  /**
   * Escalation ladder. Each rung maps a cycle count to a strategy.
   * The highest cycle count <= the current cycle is selected.
   */
  ladder: EscalationLadderRung[]
  /** Circuit breaker thresholds */
  circuitBreaker: {
    /** Max total sessions across all phases before halting (default: 8) */
    maxSessionsPerIssue: number
    /** Max sessions per status before circuit breaker trips (default: 3) */
    maxSessionsPerPhase?: number
  }
}

// ---------------------------------------------------------------------------
// Gate Definition (Phase 4 — schema only)
// ---------------------------------------------------------------------------

/**
 * An external gate that can pause workflow execution until a condition is met.
 */
export interface GateDefinition {
  /** Unique gate name */
  name: string
  /** Human-readable description */
  description?: string
  /** Gate type: signal (external event), timer (time-based), webhook (HTTP callback) */
  type: 'signal' | 'timer' | 'webhook'
  /** Type-specific trigger configuration */
  trigger: Record<string, unknown>
  /** Timeout configuration */
  timeout?: {
    /** Duration string or milliseconds */
    duration: string
    /** Action to take on timeout */
    action: 'escalate' | 'skip' | 'fail'
  }
  /** Phase names this gate applies to */
  appliesTo?: string[]
}

// ---------------------------------------------------------------------------
// Parallelism Group Definition (Phase 4 — schema only)
// ---------------------------------------------------------------------------

/**
 * Defines a group of phases that can execute concurrently.
 *
 * Parallelism groups allow the orchestrator to spawn multiple concurrent
 * executions of the listed phases (e.g., one per sub-issue). The strategy
 * controls how branches are dispatched and how their results are collected.
 *
 * **Strategies:**
 *
 * - **fan-out** -- Spawn one execution per work item and let them run
 *   independently. Use when downstream phases do not depend on the results
 *   of all branches completing (e.g., independent deploys).
 *
 * - **fan-in** -- Spawn one execution per work item and **wait for every
 *   branch to complete** before allowing downstream phases to proceed. Use
 *   when a subsequent phase (e.g., QA) needs the collected outputs from all
 *   branches (e.g., all PR URLs). This is the most common strategy for
 *   parallel sub-issue development.
 *
 * - **race** -- Spawn multiple executions but **only keep the first one
 *   that succeeds**, cancelling the rest. Use for speculative execution
 *   where multiple approaches are tried and the fastest wins (e.g.,
 *   competing solution strategies).
 *
 * **Output aggregation:** When phases inside a parallelism group declare
 * `outputs`, each branch produces its own values. Downstream phases that
 * reference those outputs via `inputs.from` receive an aggregated array
 * of all branch results (fan-in) or the winning branch's result (race).
 */
export interface ParallelismGroupDefinition {
  /** Unique group name used to reference this parallelism configuration */
  name: string
  /** Human-readable description of the parallelism group's purpose */
  description?: string
  /**
   * Phase names to execute in parallel. Each listed phase must be defined
   * in the top-level `phases` array. The orchestrator spawns concurrent
   * executions of these phases (e.g., one per sub-issue).
   */
  phases: string[]
  /**
   * Parallelism strategy controlling dispatch and result collection.
   *
   * - `fan-out`: fire-and-forget concurrent execution
   * - `fan-in`: concurrent execution with barrier -- wait for all branches
   * - `race`: concurrent execution -- keep first success, cancel the rest
   */
  strategy: 'fan-out' | 'fan-in' | 'race'
  /**
   * Maximum number of concurrent branch executions (default: unlimited).
   *
   * This limit applies **within this parallelism group only** and is
   * independent of the orchestrator-level `maxConcurrent` setting. The
   * effective concurrency is the minimum of both values. For example, if
   * the orchestrator allows 10 concurrent sessions and this group sets
   * `maxConcurrent: 5`, at most 5 branches run at once for this group.
   *
   * Values above 10 trigger a validation warning as they may overwhelm
   * downstream services or CI systems.
   */
  maxConcurrent?: number
  /**
   * Whether to wait for all parallel executions to complete before
   * proceeding to downstream phases. Defaults to `false`.
   *
   * Typically set to `true` with the `fan-in` strategy so that a
   * subsequent phase (e.g., QA) can consume outputs from every branch.
   */
  waitForAll?: boolean
}

// ---------------------------------------------------------------------------
// Template Retry & Timeout Configuration
// ---------------------------------------------------------------------------

/**
 * Per-template retry configuration. Overrides phase-level and global
 * escalation settings when attached to a phase or branching block.
 */
export interface TemplateRetryConfig {
  /** Max attempts before escalation action. Overrides circuitBreaker.maxSessionsPerPhase */
  maxAttempts?: number
  /** Override escalation ladder for this template */
  ladder?: EscalationLadderRung[]
}

/**
 * Per-template timeout configuration. When the duration elapses,
 * the specified action is taken.
 */
export interface TemplateTimeoutConfig {
  /** Duration string: "30m", "2h", "1d" */
  duration: string
  /** Action when timeout is reached */
  action: 'escalate' | 'skip' | 'fail'
}

// ---------------------------------------------------------------------------
// Branching Definition
// ---------------------------------------------------------------------------

/**
 * A branching block that conditionally selects a template.
 * Evaluated in order; the first matching branch wins.
 */
export interface BranchingDefinition {
  /** Unique name for this branching rule */
  name: string
  /** Condition expression (Handlebars-style, e.g., "{{ isParentIssue }}") */
  condition: string
  /** Template to select when condition is true */
  then: { template: string; retry?: TemplateRetryConfig; timeout?: TemplateTimeoutConfig }
  /** Optional template to select when condition is false */
  else?: { template: string; retry?: TemplateRetryConfig; timeout?: TemplateTimeoutConfig }
}

// ---------------------------------------------------------------------------
// v2 Trigger Definition
// ---------------------------------------------------------------------------

/**
 * Declares an event that can initiate workflow execution.
 * Triggers define the source, event type, and optional payload filter.
 */
export interface WorkflowTriggerDefinition {
  /** Unique trigger name */
  name: string
  /** Trigger type: webhook (external event), schedule (cron), manual (user-initiated) */
  type: 'webhook' | 'schedule' | 'manual'
  /** Provider name (e.g., 'linear') — identifies the event source */
  source?: string
  /** Event type (e.g., 'issue.status_changed') */
  event?: string
  /** Event payload filter — only fire when payload matches */
  filter?: Record<string, unknown>
  /** Cron expression (for type: schedule) */
  schedule?: string
}

// ---------------------------------------------------------------------------
// v2 Provider Requirement
// ---------------------------------------------------------------------------

/**
 * Declares an external service provider that nodes can reference.
 * The name is used as a local reference in node.provider fields.
 */
export interface ProviderRequirement {
  /** Local reference name (used in node.provider) */
  name: string
  /** Provider type (e.g., 'claude', 'linear', 'github') */
  type: string
  /** Provider-specific configuration */
  config?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// v2 Workflow Config
// ---------------------------------------------------------------------------

/**
 * Workspace-level configuration for v2 workflows.
 * Extensible with arbitrary keys beyond the known fields.
 */
export interface WorkflowConfig {
  /** Maps project names to repository paths */
  projectMapping?: Record<string, string>
  /** Extensible configuration */
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// v2 Step Definition
// ---------------------------------------------------------------------------

/**
 * A single step within a v2 node's execution sequence.
 * Steps execute in order and can reference outputs from earlier steps
 * via {{ steps.<id>.output.<key> }} interpolation.
 */
export interface StepDefinition {
  /** Unique step ID within the node */
  id: string
  /** Provider action (e.g., 'spawn-session', 'tracker.create-comment') */
  action: string
  /** Action parameters — supports {{ }} interpolation markers */
  with?: Record<string, unknown>
  /** Optional condition for this step */
  when?: string
  /** Declared outputs from this step */
  output?: Record<string, PhaseOutputDeclaration>
}

// ---------------------------------------------------------------------------
// v2 Node Definition
// ---------------------------------------------------------------------------

/**
 * An action-based node in a v2 workflow. Nodes reference a provider and
 * contain ordered multi-step sequences with template expression interpolation.
 */
export interface NodeDefinition {
  /** Unique node name */
  name: string
  /** Human-readable description */
  description?: string
  /** Provider reference (must match a name in the providers section) */
  provider?: string
  /** v1-style template reference (backwards compat) */
  template?: string
  /** Multi-step execution sequence */
  steps?: StepDefinition[]
  /** Condition expression — node only executes when this evaluates to true */
  when?: string
  /** Retry configuration */
  retry?: TemplateRetryConfig
  /** Timeout configuration */
  timeout?: TemplateTimeoutConfig
  /** Input dependencies on upstream outputs */
  inputs?: Record<string, PhaseInputDeclaration>
  /** Structured outputs this node produces */
  outputs?: Record<string, PhaseOutputDeclaration>
}

// ---------------------------------------------------------------------------
// v2 Workflow Definition
// ---------------------------------------------------------------------------

/**
 * v2 workflow definition with event-driven triggers, provider declarations,
 * workspace config, and multi-step action nodes. Supports v1.1 phases and
 * transitions alongside v2 nodes for backwards compatibility.
 */
export interface WorkflowDefinitionV2 {
  apiVersion: 'v2'
  kind: 'WorkflowDefinition'
  metadata: {
    name: string
    description?: string
  }
  /** Event triggers that initiate workflow execution */
  triggers?: WorkflowTriggerDefinition[]
  /** External service providers that nodes can reference */
  providers?: ProviderRequirement[]
  /** Workspace-level configuration */
  config?: WorkflowConfig
  /** v2 action-based nodes with multi-step sequences */
  nodes?: NodeDefinition[]
  /** v1.1 phase definitions (backwards compat) */
  phases?: PhaseDefinition[]
  /** Workflow graph edges: status-to-phase transitions */
  transitions?: TransitionDefinition[]
  /** Escalation ladder and circuit breaker configuration */
  escalation?: EscalationConfig
  /** External gates that can pause workflow execution */
  gates?: GateDefinition[]
  /** Parallelism groups for concurrent phase execution */
  parallelism?: ParallelismGroupDefinition[]
  /** Branching blocks for conditional template selection */
  branching?: BranchingDefinition[]
}

/**
 * Union type for consumers that handle both v1.1 and v2 workflow definitions.
 * Discriminated on the `apiVersion` field.
 */
export type AnyWorkflowDefinition = WorkflowDefinition | WorkflowDefinitionV2

// ---------------------------------------------------------------------------
// Workflow Definition (v1.1)
// ---------------------------------------------------------------------------

/**
 * A declarative workflow definition. This is the primary document kind
 * introduced in schema v1.1, replacing the hard-coded workflow graph
 * in decision-engine.ts and agent-tracking.ts.
 */
export interface WorkflowDefinition {
  apiVersion: 'v1.1'
  kind: 'WorkflowDefinition'
  metadata: {
    name: string
    description?: string
  }
  /** Available phases and their template bindings */
  phases: PhaseDefinition[]
  /** Workflow graph edges: status-to-phase transitions */
  transitions: TransitionDefinition[]
  /** Escalation ladder and circuit breaker configuration */
  escalation?: EscalationConfig
  /** External gates that can pause workflow execution (Phase 4) */
  gates?: GateDefinition[]
  /** Parallelism groups for concurrent phase execution (Phase 4) */
  parallelism?: ParallelismGroupDefinition[]
  /** Branching blocks for conditional template selection */
  branching?: BranchingDefinition[]
}

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

export const PhaseOutputDeclarationSchema = z.object({
  type: z.enum(['string', 'json', 'url', 'boolean']),
  description: z.string().optional(),
  required: z.boolean().optional(),
})

export const PhaseInputDeclarationSchema = z.object({
  from: z.string().min(1),
  description: z.string().optional(),
})

export const TransitionDefinitionSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  condition: z.string().optional(),
  priority: z.number().int().optional(),
})

export const EscalationLadderRungSchema = z.object({
  cycle: z.number().int().nonnegative(),
  strategy: z.string().min(1),
})

export const TemplateRetryConfigSchema = z.object({
  maxAttempts: z.number().int().positive().optional(),
  ladder: z.array(EscalationLadderRungSchema).min(1).optional(),
})

export const TemplateTimeoutConfigSchema = z.object({
  duration: z.string().min(1),
  action: z.enum(['escalate', 'skip', 'fail']),
})

export const PhaseDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  template: z.string().min(1),
  variants: z.record(z.string(), z.string()).optional(),
  retry: TemplateRetryConfigSchema.optional(),
  timeout: TemplateTimeoutConfigSchema.optional(),
  outputs: z.record(z.string(), PhaseOutputDeclarationSchema).optional(),
  inputs: z.record(z.string(), PhaseInputDeclarationSchema).optional(),
})

export const EscalationConfigSchema = z.object({
  ladder: z.array(EscalationLadderRungSchema).min(1),
  circuitBreaker: z.object({
    maxSessionsPerIssue: z.number().int().positive(),
    maxSessionsPerPhase: z.number().int().positive().optional(),
  }),
})

export const GateDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.enum(['signal', 'timer', 'webhook']),
  trigger: z.record(z.string(), z.unknown()),
  timeout: z.object({
    duration: z.string().min(1),
    action: z.enum(['escalate', 'skip', 'fail']),
  }).optional(),
  appliesTo: z.array(z.string().min(1)).optional(),
})

export const ParallelismGroupDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  phases: z.array(z.string().min(1)).min(1),
  strategy: z.enum(['fan-out', 'fan-in', 'race']),
  maxConcurrent: z.number().int().positive().optional(),
  waitForAll: z.boolean().optional(),
})

export const BranchingDefinitionSchema = z.object({
  name: z.string().min(1),
  condition: z.string().min(1),
  then: z.object({
    template: z.string().min(1),
    retry: TemplateRetryConfigSchema.optional(),
    timeout: TemplateTimeoutConfigSchema.optional(),
  }),
  else: z.object({
    template: z.string().min(1),
    retry: TemplateRetryConfigSchema.optional(),
    timeout: TemplateTimeoutConfigSchema.optional(),
  }).optional(),
})

export const WorkflowDefinitionSchema = z.object({
  apiVersion: z.literal('v1.1'),
  kind: z.literal('WorkflowDefinition'),
  metadata: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
  }),
  phases: z.array(PhaseDefinitionSchema),
  transitions: z.array(TransitionDefinitionSchema),
  escalation: EscalationConfigSchema.optional(),
  gates: z.array(GateDefinitionSchema).optional(),
  parallelism: z.array(ParallelismGroupDefinitionSchema).optional(),
  branching: z.array(BranchingDefinitionSchema).optional(),
})

// ---------------------------------------------------------------------------
// v2 Zod Schemas
// ---------------------------------------------------------------------------

export const WorkflowTriggerDefinitionSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['webhook', 'schedule', 'manual']),
  source: z.string().optional(),
  event: z.string().optional(),
  filter: z.record(z.string(), z.unknown()).optional(),
  schedule: z.string().optional(),
})

export const ProviderRequirementSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
})

export const WorkflowConfigSchema = z.object({
  projectMapping: z.record(z.string(), z.string()).optional(),
}).passthrough()

export const StepDefinitionSchema = z.object({
  id: z.string().min(1),
  action: z.string().min(1),
  with: z.record(z.string(), z.unknown()).optional(),
  when: z.string().optional(),
  output: z.record(z.string(), PhaseOutputDeclarationSchema).optional(),
})

export const NodeDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  provider: z.string().optional(),
  template: z.string().optional(),
  steps: z.array(StepDefinitionSchema).optional(),
  when: z.string().optional(),
  retry: TemplateRetryConfigSchema.optional(),
  timeout: TemplateTimeoutConfigSchema.optional(),
  inputs: z.record(z.string(), PhaseInputDeclarationSchema).optional(),
  outputs: z.record(z.string(), PhaseOutputDeclarationSchema).optional(),
})

export const WorkflowDefinitionV2Schema = z.object({
  apiVersion: z.literal('v2'),
  kind: z.literal('WorkflowDefinition'),
  metadata: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
  }),
  triggers: z.array(WorkflowTriggerDefinitionSchema).optional(),
  providers: z.array(ProviderRequirementSchema).optional(),
  config: WorkflowConfigSchema.optional(),
  nodes: z.array(NodeDefinitionSchema).optional(),
  phases: z.array(PhaseDefinitionSchema).optional(),
  transitions: z.array(TransitionDefinitionSchema).optional(),
  escalation: EscalationConfigSchema.optional(),
  gates: z.array(GateDefinitionSchema).optional(),
  parallelism: z.array(ParallelismGroupDefinitionSchema).optional(),
  branching: z.array(BranchingDefinitionSchema).optional(),
})

/**
 * Discriminated union schema that accepts both v1.1 and v2 workflow definitions.
 * Dispatches to the correct schema based on the `apiVersion` field.
 */
export const AnyWorkflowDefinitionSchema = z.discriminatedUnion('apiVersion', [
  WorkflowDefinitionSchema,
  WorkflowDefinitionV2Schema,
])

// ---------------------------------------------------------------------------
// Validation Helpers
// ---------------------------------------------------------------------------

/**
 * Validate a parsed YAML object as a WorkflowDefinition (v1.1).
 * Throws ZodError with detailed messages on failure.
 *
 * After Zod schema validation succeeds, performs cross-validation to ensure:
 * - Parallelism group phase names reference defined phases
 * - Phase input `from` references point to valid phase.output declarations
 * - Warns (via console.warn) if maxConcurrent exceeds 10
 */
export function validateWorkflowDefinition(data: unknown, filePath?: string): WorkflowDefinition {
  try {
    const workflow = WorkflowDefinitionSchema.parse(data)

    // Cross-validation after schema parse succeeds
    crossValidateWorkflow(workflow, filePath)

    return workflow
  } catch (error) {
    if (filePath && error instanceof z.ZodError) {
      throw new Error(`Invalid workflow definition at ${filePath}: ${error.message}`, { cause: error })
    }
    throw error
  }
}

/**
 * Validate a parsed YAML object as either a v1.1 or v2 WorkflowDefinition.
 * Uses the `apiVersion` field to dispatch to the correct schema.
 * Throws on invalid schema or cross-validation failure.
 */
export function validateAnyWorkflowDefinition(data: unknown, filePath?: string): AnyWorkflowDefinition {
  try {
    const workflow = AnyWorkflowDefinitionSchema.parse(data)

    if (workflow.apiVersion === 'v1.1') {
      crossValidateWorkflow(workflow, filePath)
    } else {
      crossValidateWorkflowV2(workflow, filePath)
    }

    return workflow
  } catch (error) {
    if (filePath && error instanceof z.ZodError) {
      throw new Error(`Invalid workflow definition at ${filePath}: ${error.message}`, { cause: error })
    }
    throw error
  }
}

/**
 * Perform cross-validation for v2 workflow definitions.
 * Validates referential integrity for triggers, providers, nodes, and steps.
 *
 * Checks:
 * - Node names must be unique
 * - node.provider must reference a declared provider name
 * - Step IDs must be unique within a node
 * - {{ steps.<id>.output.<key> }} references must point to valid step IDs within the same node
 * - {{ trigger.* }} references require at least one trigger to be declared
 * - config.projectMapping values must be non-empty strings
 * - when expressions must have balanced {{ }} brackets
 */
export function crossValidateWorkflowV2(workflow: WorkflowDefinitionV2, filePath?: string): void {
  const loc = filePath ? ` in ${filePath}` : ''
  const providerNames = new Set((workflow.providers ?? []).map(p => p.name))
  const hasTriggers = (workflow.triggers ?? []).length > 0

  // --- Node name uniqueness ---
  const nodeNames = new Set<string>()
  for (const node of workflow.nodes ?? []) {
    if (nodeNames.has(node.name)) {
      throw new Error(`Duplicate node name "${node.name}"${loc}`)
    }
    nodeNames.add(node.name)
  }

  // --- Per-node validation ---
  for (const node of workflow.nodes ?? []) {
    // Provider reference validation
    if (node.provider && !providerNames.has(node.provider)) {
      throw new Error(
        `Node "${node.name}" references undefined provider "${node.provider}"${loc}`
      )
    }

    // Step ID uniqueness within node
    const stepIds = new Set<string>()
    for (const step of node.steps ?? []) {
      if (stepIds.has(step.id)) {
        throw new Error(
          `Node "${node.name}" has duplicate step ID "${step.id}"${loc}`
        )
      }
      stepIds.add(step.id)
    }

    // Step output reference validation: {{ steps.<id>.output.<key> }} in with params
    for (const step of node.steps ?? []) {
      const refs = extractStepReferences(step.with)
      for (const refId of refs) {
        if (!stepIds.has(refId)) {
          throw new Error(
            `Node "${node.name}" step "${step.id}" references undefined step "${refId}"${loc}`
          )
        }
      }
      // Check when condition for step references too
      if (step.when) {
        const whenRefs = extractStepReferencesFromString(step.when)
        for (const refId of whenRefs) {
          if (!stepIds.has(refId)) {
            throw new Error(
              `Node "${node.name}" step "${step.id}" references undefined step "${refId}"${loc}`
            )
          }
        }
      }
    }

    // Trigger reference validation: {{ trigger.* }} requires at least one trigger
    if (!hasTriggers) {
      const usesTriggerRef = nodeUsesTriggerReferences(node)
      if (usesTriggerRef) {
        throw new Error(
          `Node "${node.name}" uses trigger references but no triggers are declared${loc}`
        )
      }
    }

    // When condition syntax check (basic {{ }} bracket matching)
    if (node.when) {
      validateBracketSyntax(node.when, `Node "${node.name}" when condition`, loc)
    }
    for (const step of node.steps ?? []) {
      if (step.when) {
        validateBracketSyntax(step.when, `Node "${node.name}" step "${step.id}" when condition`, loc)
      }
    }
  }

  // --- Config validation ---
  if (workflow.config?.projectMapping) {
    for (const [key, value] of Object.entries(workflow.config.projectMapping)) {
      if (!value || value.trim() === '') {
        throw new Error(
          `config.projectMapping["${key}"] has empty value${loc}`
        )
      }
    }
  }

  // --- v1.1 compat: validate phases/parallelism if present ---
  if (workflow.phases && workflow.parallelism) {
    const phaseNames = new Set(workflow.phases.map(p => p.name))
    for (const group of workflow.parallelism) {
      for (const phaseName of group.phases) {
        if (!phaseNames.has(phaseName)) {
          throw new Error(
            `Parallelism group "${group.name}" references undefined phase "${phaseName}"${loc}`
          )
        }
      }
      if (group.maxConcurrent && group.maxConcurrent > 10) {
        console.warn(
          `[workflow] Parallelism group "${group.name}" has maxConcurrent=${group.maxConcurrent} which may be excessive`
        )
      }
    }
  }
}

/**
 * Extract step ID references from {{ steps.<id>.output.<key> }} patterns
 * in a record of parameters (the `with` block).
 */
function extractStepReferences(params: Record<string, unknown> | undefined): Set<string> {
  const refs = new Set<string>()
  if (!params) return refs
  for (const value of Object.values(params)) {
    if (typeof value === 'string') {
      for (const ref of extractStepReferencesFromString(value)) {
        refs.add(ref)
      }
    }
  }
  return refs
}

/**
 * Extract step ID references from {{ steps.<id>.* }} patterns in a string.
 */
function extractStepReferencesFromString(str: string): Set<string> {
  const refs = new Set<string>()
  const pattern = /\{\{\s*steps\.([a-zA-Z0-9_-]+)\./g
  let match
  while ((match = pattern.exec(str)) !== null) {
    refs.add(match[1])
  }
  return refs
}

/**
 * Check if a node uses {{ trigger.* }} references in when conditions or step with params.
 */
function nodeUsesTriggerReferences(node: NodeDefinition): boolean {
  const triggerPattern = /\{\{\s*trigger\./
  if (node.when && triggerPattern.test(node.when)) return true
  for (const step of node.steps ?? []) {
    if (step.when && triggerPattern.test(step.when)) return true
    if (step.with) {
      for (const value of Object.values(step.with)) {
        if (typeof value === 'string' && triggerPattern.test(value)) return true
      }
    }
  }
  return false
}

/**
 * Validate that {{ }} brackets are balanced in an expression string.
 */
function validateBracketSyntax(expr: string, context: string, loc: string): void {
  const opens = (expr.match(/\{\{/g) ?? []).length
  const closes = (expr.match(/\}\}/g) ?? []).length
  if (opens !== closes) {
    throw new Error(
      `${context} has unbalanced brackets: ${opens} opening vs ${closes} closing${loc}`
    )
  }
}

/**
 * Perform cross-validation checks that go beyond what Zod schema can enforce.
 * Validates referential integrity between phases, parallelism groups, and input/output declarations.
 */
function crossValidateWorkflow(workflow: WorkflowDefinition, filePath?: string): void {
  const phaseNames = new Set(workflow.phases.map(p => p.name))
  const phaseOutputs = new Map<string, Set<string>>()

  // Build map of phase outputs
  for (const phase of workflow.phases) {
    if (phase.outputs) {
      phaseOutputs.set(phase.name, new Set(Object.keys(phase.outputs)))
    }
  }

  // Validate parallelism group phase references
  if (workflow.parallelism) {
    for (const group of workflow.parallelism) {
      for (const phaseName of group.phases) {
        if (!phaseNames.has(phaseName)) {
          const loc = filePath ? ` in ${filePath}` : ''
          throw new Error(
            `Parallelism group "${group.name}" references undefined phase "${phaseName}"${loc}`
          )
        }
      }
      // Warn if maxConcurrent is very high
      if (group.maxConcurrent && group.maxConcurrent > 10) {
        console.warn(
          `[workflow] Parallelism group "${group.name}" has maxConcurrent=${group.maxConcurrent} which may be excessive`
        )
      }
    }
  }

  // Validate phase input references
  for (const phase of workflow.phases) {
    if (phase.inputs) {
      for (const [inputName, decl] of Object.entries(phase.inputs)) {
        const parts = decl.from.split('.')
        if (parts.length !== 2) {
          const loc = filePath ? ` in ${filePath}` : ''
          throw new Error(
            `Phase "${phase.name}" input "${inputName}" has invalid from reference "${decl.from}" — expected "phaseName.outputKey" format${loc}`
          )
        }
        const [sourcePhaseName, sourceOutputKey] = parts
        if (!phaseNames.has(sourcePhaseName)) {
          const loc = filePath ? ` in ${filePath}` : ''
          throw new Error(
            `Phase "${phase.name}" input "${inputName}" references undefined phase "${sourcePhaseName}"${loc}`
          )
        }
        const sourceOutputs = phaseOutputs.get(sourcePhaseName)
        if (sourceOutputs && !sourceOutputs.has(sourceOutputKey)) {
          const loc = filePath ? ` in ${filePath}` : ''
          throw new Error(
            `Phase "${phase.name}" input "${inputName}" references undefined output "${sourceOutputKey}" on phase "${sourcePhaseName}"${loc}`
          )
        }
      }
    }
  }
}
