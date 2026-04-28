/**
 * Active Backlog Management Workflow Tests — REN-1300
 *
 * Verifies that the active-backlog-management.workflow.yaml:
 *   1. Loads and validates against the v2 WorkflowDefinition schema.
 *   2. Has the correct cron trigger (hourly default) and a manual trigger.
 *   3. Declares the four PM agent steps in the correct sequential order:
 *      backlog-groomer-step → outcome-auditor-step → improvement-loop-step →
 *      operational-scanner-step.
 *   4. Each step references a distinct agent (agentId in with params).
 *   5. Inter-node output piping is declared (outcome-auditor consumes groomer output,
 *      improvement-loop consumes auditor output).
 *   6. The operational-scanner-step is present but marked as a placeholder pending REN-1328.
 *   7. Provider model does not include Opus (haiku/sonnet only per 012 PM agent pattern).
 *   8. Dry-run agent stub: records which steps fire and in what order; assertions
 *      verify the sequence backlog-groomer → outcome-auditor → improvement-loop.
 *
 * Dry-run approach: we stub the spawn-session action (no real network calls) and
 * drive the workflow graph by simulating outputs at each node; then assert the
 * invocation log matches the expected sequence.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  validateAnyWorkflowDefinition,
  WorkflowDefinitionV2Schema,
} from '../../workflow/workflow-types.js'
import type { WorkflowDefinitionV2, NodeDefinition } from '../../workflow/workflow-types.js'

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const WORKFLOW_PATH = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  'active-backlog-management.workflow.yaml',
)

// ---------------------------------------------------------------------------
// Fixture project for dry-run simulation
// ---------------------------------------------------------------------------

/**
 * Minimal fixture project context consumed by the dry-run simulator.
 * Represents a real tenant project that has opted into active backlog management.
 */
const FIXTURE_PROJECT = {
  name: 'REN-Fixture',
  linearProject: 'Agent',
  enabled: true,
  schedule: '0 * * * *', // hourly
}

// ---------------------------------------------------------------------------
// Dry-run agent runtime stub
// ---------------------------------------------------------------------------

/**
 * Simulates the workflow engine's agent dispatch without spawning real sessions.
 * Records which agent IDs were invoked and in what order, along with any
 * inter-node output values that were threaded through.
 */
interface AgentInvocation {
  nodeName: string
  stepId: string
  agentId: string
  project: string
  receivedInputs: Record<string, unknown>
}

interface DryRunResult {
  invocations: AgentInvocation[]
  /** Names of all nodes that were "executed" (all steps ran) */
  executedNodes: string[]
  /** Whether the scan_operations placeholder was reached */
  operationalScannerReached: boolean
}

/**
 * Simulate one full run of the active-backlog-management workflow against the
 * fixture project. Stubs the spawn-session action to record invocations without
 * making network calls. Threads plausible inter-node outputs to verify piping.
 *
 * The simulator walks the `nodes` array in declaration order (sequential for
 * this workflow) and "executes" each spawn-session step, recording inputs and
 * emitting synthetic outputs consumed by the next node.
 */
function runDryRun(workflow: WorkflowDefinitionV2): DryRunResult {
  const invocations: AgentInvocation[] = []
  const executedNodes: string[] = []
  let operationalScannerReached = false

  // Synthetic inter-node state threaded between steps
  let groomerDigest: Record<string, unknown> | null = null
  let auditSummary: Record<string, unknown> | null = null
  let improvementSummary: Record<string, unknown> | null = null

  for (const node of workflow.nodes ?? []) {
    const spawnStep = (node.steps ?? []).find(s => s.action === 'spawn-session')
    if (!spawnStep) {
      // Placeholder / non-agent node (e.g. operational-scanner-step comment-only)
      if (node.name === 'operational-scanner-step') {
        operationalScannerReached = true
      }
      executedNodes.push(node.name)
      continue
    }

    const withParams = (spawnStep.with ?? {}) as Record<string, unknown>
    const agentId = (withParams.agentId ?? withParams.workType ?? 'unknown') as string

    // Build received inputs based on what the step's `with` references.
    // Detect cross-node piping via {{ nodes.<name>.output.<key> }} pattern.
    const receivedInputs: Record<string, unknown> = {
      project: FIXTURE_PROJECT.linearProject,
    }
    const refsGroomer = Object.values(withParams).some(
      v => typeof v === 'string' && v.includes('nodes.backlog-groomer-step.output')
    )
    const refsAuditor = Object.values(withParams).some(
      v => typeof v === 'string' && v.includes('nodes.outcome-auditor-step.output')
    )
    const refsImprovement = Object.values(withParams).some(
      v => typeof v === 'string' && v.includes('nodes.improvement-loop-step.output')
    )
    if (withParams.groomerDigest !== undefined || refsGroomer) {
      receivedInputs.groomerDigest = groomerDigest
    }
    if (withParams.auditSummary !== undefined || refsAuditor) {
      receivedInputs.auditSummary = auditSummary
    }
    if (withParams.improvementSummary !== undefined || refsImprovement) {
      receivedInputs.improvementSummary = improvementSummary
    }

    invocations.push({
      nodeName: node.name,
      stepId: spawnStep.id,
      agentId,
      project: FIXTURE_PROJECT.linearProject,
      receivedInputs,
    })
    executedNodes.push(node.name)

    // Emit synthetic outputs for downstream consumption
    if (node.name === 'backlog-groomer-step') {
      groomerDigest = {
        labelsApplied: ['pm:needs-refine', 'pm:stale'],
        issuesClosed: 2,
        issuesFlagged: 5,
      }
    } else if (node.name === 'outcome-auditor-step') {
      auditSummary = {
        totalAudited: 10,
        clean: 8,
        hasFollowups: 2,
        followupIds: ['REN-FIX-01', 'REN-FIX-02'],
      }
    } else if (node.name === 'improvement-loop-step') {
      improvementSummary = {
        patternsFound: 3,
        metaIssuesAuthored: 2,
        metaIssueIds: ['REN-META-01', 'REN-META-02'],
      }
      operationalScannerReached = false // reset for operational scanner detection below
    } else if (node.name === 'operational-scanner-step') {
      operationalScannerReached = true
    }
  }

  return { invocations, executedNodes, operationalScannerReached }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('active-backlog-management workflow — file presence', () => {
  it('workflow YAML file exists at the expected path', () => {
    expect(fs.existsSync(WORKFLOW_PATH), `Expected file at ${WORKFLOW_PATH}`).toBe(true)
  })
})

describe('active-backlog-management workflow — schema validation', () => {
  it('parses as valid YAML', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8')
    expect(() => parseYaml(content)).not.toThrow()
  })

  it('validates against AnyWorkflowDefinition schema (apiVersion v2)', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8')
    const data = parseYaml(content)
    const result = validateAnyWorkflowDefinition(data, WORKFLOW_PATH)
    expect(result.apiVersion).toBe('v2')
    expect(result.kind).toBe('WorkflowDefinition')
  })

  it('validates against WorkflowDefinitionV2Schema directly', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8')
    const data = parseYaml(content)
    const result = WorkflowDefinitionV2Schema.parse(data)
    expect(result.apiVersion).toBe('v2')
  })

  it('has the expected workflow name', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8')
    const data = parseYaml(content)
    const workflow = WorkflowDefinitionV2Schema.parse(data)
    expect(workflow.metadata.name).toBe('active-backlog-management')
  })
})

// ---------------------------------------------------------------------------
// Trigger tests
// ---------------------------------------------------------------------------

describe('active-backlog-management workflow — triggers', () => {
  let workflow: WorkflowDefinitionV2

  beforeAll(() => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8')
    const data = parseYaml(content)
    workflow = WorkflowDefinitionV2Schema.parse(data)
  })

  it('declares at least one trigger', () => {
    expect(workflow.triggers).toBeDefined()
    expect(workflow.triggers!.length).toBeGreaterThanOrEqual(1)
  })

  it('has a cron (schedule) trigger', () => {
    const cronTrigger = workflow.triggers!.find(t => t.type === 'schedule')
    expect(cronTrigger).toBeDefined()
    expect(cronTrigger!.schedule).toBeDefined()
  })

  it('cron trigger uses hourly schedule by default ("0 * * * *")', () => {
    const cronTrigger = workflow.triggers!.find(t => t.type === 'schedule')!
    expect(cronTrigger.schedule).toBe('0 * * * *')
  })

  it('has a manual trigger (for ad-hoc / testing)', () => {
    const manualTrigger = workflow.triggers!.find(t => t.type === 'manual')
    expect(manualTrigger).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Provider tests
// ---------------------------------------------------------------------------

describe('active-backlog-management workflow — providers', () => {
  let workflow: WorkflowDefinitionV2

  beforeAll(() => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8')
    const data = parseYaml(content)
    workflow = WorkflowDefinitionV2Schema.parse(data)
  })

  it('declares at least one provider', () => {
    expect(workflow.providers).toBeDefined()
    expect(workflow.providers!.length).toBeGreaterThanOrEqual(1)
  })

  it('pm-agent provider uses claude type', () => {
    const pmAgent = workflow.providers!.find(p => p.name === 'pm-agent')
    expect(pmAgent).toBeDefined()
    expect(pmAgent!.type).toBe('claude')
  })

  it('pm-agent model does NOT include Opus (haiku/sonnet only per 012)', () => {
    const pmAgent = workflow.providers!.find(p => p.name === 'pm-agent')!
    const model = (pmAgent.config as Record<string, string> | undefined)?.model ?? ''
    expect(model.toLowerCase()).not.toContain('opus')
  })

  it('pm-agent model is haiku or sonnet', () => {
    const pmAgent = workflow.providers!.find(p => p.name === 'pm-agent')!
    const model = ((pmAgent.config ?? {}) as Record<string, string>).model ?? ''
    const isHaikuOrSonnet = model.toLowerCase().includes('haiku') || model.toLowerCase().includes('sonnet')
    expect(isHaikuOrSonnet, `Expected haiku or sonnet model, got: ${model}`).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Node (step) sequence tests
// ---------------------------------------------------------------------------

describe('active-backlog-management workflow — node sequence', () => {
  let workflow: WorkflowDefinitionV2

  beforeAll(() => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8')
    const data = parseYaml(content)
    workflow = WorkflowDefinitionV2Schema.parse(data)
  })

  it('declares exactly 4 nodes', () => {
    expect(workflow.nodes).toBeDefined()
    expect(workflow.nodes!.length).toBe(4)
  })

  it('first node is backlog-groomer-step', () => {
    expect(workflow.nodes![0].name).toBe('backlog-groomer-step')
  })

  it('second node is outcome-auditor-step', () => {
    expect(workflow.nodes![1].name).toBe('outcome-auditor-step')
  })

  it('third node is improvement-loop-step', () => {
    expect(workflow.nodes![2].name).toBe('improvement-loop-step')
  })

  it('fourth node is operational-scanner-step', () => {
    expect(workflow.nodes![3].name).toBe('operational-scanner-step')
  })

  it('all nodes reference the pm-agent provider', () => {
    for (const node of workflow.nodes!) {
      expect(node.provider, `Node "${node.name}" should use pm-agent`).toBe('pm-agent')
    }
  })
})

// ---------------------------------------------------------------------------
// Per-node spawn-session step tests
// ---------------------------------------------------------------------------

describe('active-backlog-management workflow — backlog-groomer-step', () => {
  let node: NodeDefinition

  beforeAll(() => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8')
    const data = parseYaml(content)
    const workflow = WorkflowDefinitionV2Schema.parse(data)
    node = workflow.nodes!.find(n => n.name === 'backlog-groomer-step')!
  })

  it('has at least one step', () => {
    expect(node.steps).toBeDefined()
    expect(node.steps!.length).toBeGreaterThanOrEqual(1)
  })

  it('has a spawn-session step', () => {
    const spawnStep = node.steps!.find(s => s.action === 'spawn-session')
    expect(spawnStep).toBeDefined()
  })

  it('spawn-session step references backlog-groomer agentId', () => {
    const spawnStep = node.steps!.find(s => s.action === 'spawn-session')!
    const withParams = spawnStep.with as Record<string, unknown>
    const agentId = withParams.agentId ?? withParams.workType
    expect(agentId).toBe('backlog-groomer')
  })

  it('node declares linearStateDigest output', () => {
    expect(node.outputs).toBeDefined()
    expect(node.outputs!.linearStateDigest).toBeDefined()
  })
})

describe('active-backlog-management workflow — outcome-auditor-step', () => {
  let node: NodeDefinition

  beforeAll(() => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8')
    const data = parseYaml(content)
    const workflow = WorkflowDefinitionV2Schema.parse(data)
    node = workflow.nodes!.find(n => n.name === 'outcome-auditor-step')!
  })

  it('has a spawn-session step', () => {
    const spawnStep = node.steps!.find(s => s.action === 'spawn-session')
    expect(spawnStep).toBeDefined()
  })

  it('spawn-session step references outcome-auditor agentId', () => {
    const spawnStep = node.steps!.find(s => s.action === 'spawn-session')!
    const withParams = spawnStep.with as Record<string, unknown>
    const agentId = withParams.agentId ?? withParams.workType
    expect(agentId).toBe('outcome-auditor')
  })

  it('consumes groomer output via inter-node piping (groomerDigest in with)', () => {
    const spawnStep = node.steps!.find(s => s.action === 'spawn-session')!
    const withParams = spawnStep.with as Record<string, string>
    // Must reference groomer node's output via cross-node {{ nodes.<name>.output.<key> }} syntax
    const refsGroomerOutput = Object.values(withParams).some(
      v => typeof v === 'string' && v.includes('nodes.backlog-groomer-step.output')
    )
    expect(refsGroomerOutput, 'outcome-auditor-step must pipe groomer output to its spawn step').toBe(true)
  })

  it('node declares auditSummary output', () => {
    expect(node.outputs).toBeDefined()
    expect(node.outputs!.auditSummary).toBeDefined()
  })
})

describe('active-backlog-management workflow — improvement-loop-step', () => {
  let node: NodeDefinition

  beforeAll(() => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8')
    const data = parseYaml(content)
    const workflow = WorkflowDefinitionV2Schema.parse(data)
    node = workflow.nodes!.find(n => n.name === 'improvement-loop-step')!
  })

  it('has a spawn-session step', () => {
    const spawnStep = node.steps!.find(s => s.action === 'spawn-session')
    expect(spawnStep).toBeDefined()
  })

  it('spawn-session step references improvement-loop agentId', () => {
    const spawnStep = node.steps!.find(s => s.action === 'spawn-session')!
    const withParams = spawnStep.with as Record<string, unknown>
    const agentId = withParams.agentId ?? withParams.workType
    expect(agentId).toBe('improvement-loop')
  })

  it('consumes audit output via inter-node piping (auditSummary in with)', () => {
    const spawnStep = node.steps!.find(s => s.action === 'spawn-session')!
    const withParams = spawnStep.with as Record<string, string>
    // Must reference auditor node's output via cross-node {{ nodes.<name>.output.<key> }} syntax
    const refsAuditOutput = Object.values(withParams).some(
      v => typeof v === 'string' && v.includes('nodes.outcome-auditor-step.output')
    )
    expect(refsAuditOutput, 'improvement-loop-step must pipe audit output to its spawn step').toBe(true)
  })

  it('node declares improvementSummary output', () => {
    expect(node.outputs).toBeDefined()
    expect(node.outputs!.improvementSummary).toBeDefined()
  })
})

describe('active-backlog-management workflow — operational-scanner-step', () => {
  let node: NodeDefinition

  beforeAll(() => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8')
    const data = parseYaml(content)
    const workflow = WorkflowDefinitionV2Schema.parse(data)
    node = workflow.nodes!.find(n => n.name === 'operational-scanner-step')!
  })

  it('exists as a node (deferred placeholder present)', () => {
    expect(node).toBeDefined()
  })

  it('description mentions REN-1328 deferral', () => {
    const desc = node.description ?? ''
    expect(desc.toLowerCase()).toContain('ren-1328')
  })

  it('does NOT invoke operational-scanner agent (not yet shipped)', () => {
    const spawnStep = (node.steps ?? []).find(s => s.action === 'spawn-session')
    expect(spawnStep).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Dry-run simulation — sequence and output piping verification
// ---------------------------------------------------------------------------

describe('active-backlog-management workflow — dry-run simulation', () => {
  let workflow: WorkflowDefinitionV2
  let dryRunResult: DryRunResult

  beforeAll(() => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8')
    const data = parseYaml(content)
    workflow = WorkflowDefinitionV2Schema.parse(data) as WorkflowDefinitionV2
    dryRunResult = runDryRun(workflow)
  })

  it('all 4 nodes execute in the dry run', () => {
    expect(dryRunResult.executedNodes).toHaveLength(4)
  })

  it('nodes execute in the correct sequence', () => {
    expect(dryRunResult.executedNodes[0]).toBe('backlog-groomer-step')
    expect(dryRunResult.executedNodes[1]).toBe('outcome-auditor-step')
    expect(dryRunResult.executedNodes[2]).toBe('improvement-loop-step')
    expect(dryRunResult.executedNodes[3]).toBe('operational-scanner-step')
  })

  it('exactly 3 agent invocations (groomer, auditor, improvement — scanner is placeholder)', () => {
    expect(dryRunResult.invocations).toHaveLength(3)
  })

  it('first invocation is backlog-groomer', () => {
    expect(dryRunResult.invocations[0].agentId).toBe('backlog-groomer')
    expect(dryRunResult.invocations[0].nodeName).toBe('backlog-groomer-step')
  })

  it('second invocation is outcome-auditor', () => {
    expect(dryRunResult.invocations[1].agentId).toBe('outcome-auditor')
    expect(dryRunResult.invocations[1].nodeName).toBe('outcome-auditor-step')
  })

  it('third invocation is improvement-loop', () => {
    expect(dryRunResult.invocations[2].agentId).toBe('improvement-loop')
    expect(dryRunResult.invocations[2].nodeName).toBe('improvement-loop-step')
  })

  it('outcome-auditor receives groomer digest (inter-node piping)', () => {
    const auditorInvocation = dryRunResult.invocations[1]
    // The simulator threads groomerDigest into receivedInputs when the step's
    // with-params reference the groomer's output.
    expect(auditorInvocation.receivedInputs.groomerDigest).toBeDefined()
    expect(auditorInvocation.receivedInputs.groomerDigest).not.toBeNull()
  })

  it('improvement-loop receives audit summary (inter-node piping)', () => {
    const loopInvocation = dryRunResult.invocations[2]
    expect(loopInvocation.receivedInputs.auditSummary).toBeDefined()
    expect(loopInvocation.receivedInputs.auditSummary).not.toBeNull()
  })

  it('all invocations are scoped to the fixture project', () => {
    for (const invocation of dryRunResult.invocations) {
      expect(invocation.project).toBe(FIXTURE_PROJECT.linearProject)
    }
  })

  it('operational-scanner-step is reached (placeholder registered)', () => {
    expect(dryRunResult.operationalScannerReached).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Config schema — pmWorkflows opt-in flag
// ---------------------------------------------------------------------------

describe('active-backlog-management workflow — RepositoryConfig pmWorkflows schema', () => {
  it('RepositoryConfig schema accepts pmWorkflows.activeBacklogManagement', async () => {
    const { RepositoryConfigSchema } = await import('../../config/repository-config.js')
    const config = {
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      repository: 'github.com/renseiai/agentfactory',
      allowedProjects: ['Agent'],
      pmWorkflows: {
        activeBacklogManagement: {
          enabled: true,
          schedule: '0 * * * *',
        },
      },
    }
    const result = RepositoryConfigSchema.parse(config)
    expect(result.pmWorkflows?.activeBacklogManagement?.enabled).toBe(true)
    expect(result.pmWorkflows?.activeBacklogManagement?.schedule).toBe('0 * * * *')
  })

  it('pmWorkflows.activeBacklogManagement is optional (opt-in semantics)', async () => {
    const { RepositoryConfigSchema } = await import('../../config/repository-config.js')
    const config = {
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      repository: 'github.com/renseiai/agentfactory',
      allowedProjects: ['Agent'],
      // pmWorkflows absent
    }
    const result = RepositoryConfigSchema.parse(config)
    expect(result.pmWorkflows).toBeUndefined()
  })

  it('enabled defaults to false when not explicitly set', async () => {
    const { RepositoryConfigSchema } = await import('../../config/repository-config.js')
    const config = {
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      repository: 'github.com/renseiai/agentfactory',
      allowedProjects: ['Agent'],
      pmWorkflows: {
        activeBacklogManagement: {},
      },
    }
    const result = RepositoryConfigSchema.parse(config)
    expect(result.pmWorkflows?.activeBacklogManagement?.enabled).toBe(false)
  })

  it('schedule field is optional (falls back to workflow default)', async () => {
    const { RepositoryConfigSchema } = await import('../../config/repository-config.js')
    const config = {
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      repository: 'github.com/renseiai/agentfactory',
      allowedProjects: ['Agent'],
      pmWorkflows: {
        activeBacklogManagement: {
          enabled: true,
          // schedule absent — uses workflow default (0 * * * *)
        },
      },
    }
    const result = RepositoryConfigSchema.parse(config)
    expect(result.pmWorkflows?.activeBacklogManagement?.enabled).toBe(true)
    expect(result.pmWorkflows?.activeBacklogManagement?.schedule).toBeUndefined()
  })

  it('accepts a non-default cron schedule override', async () => {
    const { RepositoryConfigSchema } = await import('../../config/repository-config.js')
    const config = {
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      repository: 'github.com/renseiai/agentfactory',
      allowedProjects: ['Agent'],
      pmWorkflows: {
        activeBacklogManagement: {
          enabled: true,
          schedule: '0 */6 * * *', // every 6 hours
        },
      },
    }
    const result = RepositoryConfigSchema.parse(config)
    expect(result.pmWorkflows?.activeBacklogManagement?.schedule).toBe('0 */6 * * *')
  })
})

// ---------------------------------------------------------------------------
// v1.1 backwards-compat sections
// ---------------------------------------------------------------------------

describe('active-backlog-management workflow — v1.1 compat sections', () => {
  let workflow: WorkflowDefinitionV2

  beforeAll(() => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8')
    const data = parseYaml(content)
    workflow = WorkflowDefinitionV2Schema.parse(data) as WorkflowDefinitionV2
  })

  it('phases section is present for v1.1 compat', () => {
    expect(workflow.phases).toBeDefined()
    expect(workflow.phases!.length).toBeGreaterThanOrEqual(3)
  })

  it('phases include backlog-groomer, outcome-auditor, improvement-loop', () => {
    const phaseNames = workflow.phases!.map(p => p.name)
    expect(phaseNames).toContain('backlog-groomer')
    expect(phaseNames).toContain('outcome-auditor')
    expect(phaseNames).toContain('improvement-loop')
  })

  it('escalation section is present', () => {
    expect(workflow.escalation).toBeDefined()
    expect(workflow.escalation!.ladder).toBeDefined()
    expect(workflow.escalation!.circuitBreaker).toBeDefined()
  })

  it('escalation circuit breaker maxSessionsPerIssue is >= 2', () => {
    expect(workflow.escalation!.circuitBreaker.maxSessionsPerIssue).toBeGreaterThanOrEqual(2)
  })
})
