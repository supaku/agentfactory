/**
 * Workflow Registry
 *
 * In-memory registry that manages WorkflowDefinition resolution with
 * layered overrides, following the same pattern as TemplateRegistry.
 *
 * Resolution order (later sources override earlier):
 *   1. Built-in default (workflow/defaults/workflow.yaml)
 *   2. Project-level override (e.g., .agentfactory/workflow.yaml)
 *   3. Inline config override (programmatic)
 */

import fs from 'node:fs'
import type { WorkflowDefinition, EscalationConfig } from './workflow-types.js'
import { loadWorkflowDefinitionFile, getBuiltinWorkflowPath } from './workflow-loader.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface WorkflowRegistryConfig {
  /** Path to a project-level workflow definition YAML override */
  workflowPath?: string
  /** Inline workflow definition override (highest priority) */
  workflow?: WorkflowDefinition
  /** Whether to load the built-in default workflow (default: true) */
  useBuiltinDefault?: boolean
}

// ---------------------------------------------------------------------------
// Fallback constants (match the hard-coded values in decision-engine.ts
// and agent-tracking.ts for backward compatibility)
// ---------------------------------------------------------------------------

const DEFAULT_MAX_SESSIONS_PER_ISSUE = 8
const DEFAULT_MAX_SESSIONS_PER_PHASE = 3

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class WorkflowRegistry {
  private workflow: WorkflowDefinition | null = null

  constructor() {}

  /**
   * Create and initialize a registry from configuration.
   */
  static create(config: WorkflowRegistryConfig = {}): WorkflowRegistry {
    const registry = new WorkflowRegistry()
    registry.initialize(config)
    return registry
  }

  /**
   * Initialize the registry by loading workflow definition from
   * configured sources. Later sources override earlier ones.
   */
  initialize(config: WorkflowRegistryConfig = {}): void {
    const { workflowPath, workflow, useBuiltinDefault = true } = config

    // Layer 1: Built-in default
    if (useBuiltinDefault) {
      const builtinPath = getBuiltinWorkflowPath()
      if (fs.existsSync(builtinPath)) {
        this.workflow = loadWorkflowDefinitionFile(builtinPath)
      }
    }

    // Layer 2: Project-level override
    if (workflowPath && fs.existsSync(workflowPath)) {
      this.workflow = loadWorkflowDefinitionFile(workflowPath)
    }

    // Layer 3: Inline override (highest priority)
    if (workflow) {
      this.workflow = workflow
    }
  }

  /**
   * Get the currently loaded workflow definition.
   */
  getWorkflow(): WorkflowDefinition | null {
    return this.workflow
  }

  /**
   * Get the escalation configuration, or null if none defined.
   */
  getEscalation(): EscalationConfig | null {
    return this.workflow?.escalation ?? null
  }

  /**
   * Compute escalation strategy from the workflow's escalation ladder.
   *
   * Selects the highest cycle threshold that is <= the given cycleCount.
   * Falls back to 'normal' if no match or no escalation config.
   */
  getEscalationStrategy(cycleCount: number): string {
    const escalation = this.workflow?.escalation
    if (!escalation) {
      return computeStrategyFallback(cycleCount)
    }

    const ladder = escalation.ladder
    // Sort descending by cycle so we can find the first match
    const sorted = [...ladder].sort((a, b) => b.cycle - a.cycle)
    const match = sorted.find(rung => cycleCount >= rung.cycle)

    return match?.strategy ?? 'normal'
  }

  /**
   * Get circuit breaker limits from the workflow definition.
   */
  getCircuitBreakerLimits(): { maxSessionsPerIssue: number; maxSessionsPerPhase: number } {
    const cb = this.workflow?.escalation?.circuitBreaker
    return {
      maxSessionsPerIssue: cb?.maxSessionsPerIssue ?? DEFAULT_MAX_SESSIONS_PER_ISSUE,
      maxSessionsPerPhase: cb?.maxSessionsPerPhase ?? DEFAULT_MAX_SESSIONS_PER_PHASE,
    }
  }
}

// ---------------------------------------------------------------------------
// Fallback (mirrors agent-tracking.ts:computeStrategy())
// ---------------------------------------------------------------------------

function computeStrategyFallback(cycleCount: number): string {
  if (cycleCount <= 1) return 'normal'
  if (cycleCount === 2) return 'context-enriched'
  if (cycleCount === 3) return 'decompose'
  return 'escalate-human'
}
