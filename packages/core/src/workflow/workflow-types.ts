/**
 * Workflow Definition Types
 *
 * TypeScript interfaces and Zod schemas for the WorkflowDefinition document kind.
 * A WorkflowDefinition declares the workflow graph — phases, transitions,
 * escalation ladder, gates, and parallelism — in YAML rather than hard-coded
 * TypeScript.
 *
 * This is an additive v1.1 schema extension. Existing v1 WorkflowTemplate
 * and PartialTemplate documents remain valid and unchanged.
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
 */
export interface ParallelismGroupDefinition {
  /** Unique group name */
  name: string
  /** Human-readable description */
  description?: string
  /** Phase names to execute in parallel */
  phases: string[]
  /** Parallelism strategy: fan-out, fan-in, or race */
  strategy: 'fan-out' | 'fan-in' | 'race'
  /** Maximum concurrent executions (default: unlimited) */
  maxConcurrent?: number
  /** Whether to wait for all parallel executions to complete */
  waitForAll?: boolean
}

// ---------------------------------------------------------------------------
// Workflow Definition
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
}

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

export const PhaseDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  template: z.string().min(1),
  variants: z.record(z.string(), z.string()).optional(),
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
})

// ---------------------------------------------------------------------------
// Validation Helpers
// ---------------------------------------------------------------------------

/**
 * Validate a parsed YAML object as a WorkflowDefinition.
 * Throws ZodError with detailed messages on failure.
 */
export function validateWorkflowDefinition(data: unknown, filePath?: string): WorkflowDefinition {
  try {
    return WorkflowDefinitionSchema.parse(data)
  } catch (error) {
    if (filePath && error instanceof z.ZodError) {
      throw new Error(`Invalid workflow definition at ${filePath}: ${error.message}`, { cause: error })
    }
    throw error
  }
}
