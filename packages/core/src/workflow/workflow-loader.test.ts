import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  loadWorkflowDefinitionFile,
  getBuiltinWorkflowDir,
  getBuiltinWorkflowPath,
} from './workflow-loader.js'

describe('getBuiltinWorkflowDir', () => {
  it('returns an existing directory', () => {
    const dir = getBuiltinWorkflowDir()
    expect(fs.existsSync(dir)).toBe(true)
  })
})

describe('getBuiltinWorkflowPath', () => {
  it('returns a path to an existing workflow.yaml', () => {
    const workflowPath = getBuiltinWorkflowPath()
    expect(workflowPath).toContain('workflow.yaml')
    expect(fs.existsSync(workflowPath)).toBe(true)
  })
})

describe('loadWorkflowDefinitionFile', () => {
  it('loads and validates the built-in default workflow', () => {
    const workflow = loadWorkflowDefinitionFile(getBuiltinWorkflowPath())
    expect(workflow.apiVersion).toBe('v1.1')
    expect(workflow.kind).toBe('WorkflowDefinition')
    expect(workflow.metadata.name).toBe('default-workflow')
  })

  it('built-in workflow has expected phases', () => {
    const workflow = loadWorkflowDefinitionFile(getBuiltinWorkflowPath())
    const phaseNames = workflow.phases.map(p => p.name)

    expect(phaseNames).toContain('research')
    expect(phaseNames).toContain('backlog-creation')
    expect(phaseNames).toContain('development')
    expect(phaseNames).toContain('qa')
    expect(phaseNames).toContain('acceptance')
    expect(phaseNames).toContain('refinement')
    expect(phaseNames).toContain('refinement-coordination')
    expect(phaseNames).not.toContain('coordination')
    expect(phaseNames).not.toContain('qa-coordination')
    expect(phaseNames).not.toContain('acceptance-coordination')
    expect(phaseNames).not.toContain('inflight-coordination')
  })

  it('built-in workflow has expected transitions', () => {
    const workflow = loadWorkflowDefinitionFile(getBuiltinWorkflowPath())

    // Check standard pipeline transitions exist
    const transitionMap = new Map(
      workflow.transitions
        .filter(t => !t.condition) // Only unconditional transitions
        .map(t => [t.from, t.to])
    )

    expect(transitionMap.get('Backlog')).toBe('development')
    expect(transitionMap.get('Finished')).toBe('qa')
    expect(transitionMap.get('Delivered')).toBe('acceptance')
    expect(transitionMap.get('Rejected')).toBe('refinement')
  })

  it('built-in workflow has Icebox transitions with conditions', () => {
    const workflow = loadWorkflowDefinitionFile(getBuiltinWorkflowPath())

    const iceboxTransitions = workflow.transitions.filter(t => t.from === 'Icebox')
    expect(iceboxTransitions.length).toBeGreaterThanOrEqual(2)

    const researchTransition = iceboxTransitions.find(t => t.to === 'research')
    expect(researchTransition).toBeDefined()
    expect(researchTransition!.condition).toBeDefined()
    expect(researchTransition!.priority).toBeDefined()

    const backlogTransition = iceboxTransitions.find(t => t.to === 'backlog-creation')
    expect(backlogTransition).toBeDefined()
    expect(backlogTransition!.condition).toBeDefined()
  })

  it('built-in escalation ladder matches computeStrategy() values', () => {
    const workflow = loadWorkflowDefinitionFile(getBuiltinWorkflowPath())
    expect(workflow.escalation).toBeDefined()

    const ladder = workflow.escalation!.ladder
    // Verify the escalation ladder matches the hard-coded computeStrategy()
    // from agent-tracking.ts: cycle 1→normal, 2→context-enriched, 3→decompose, 4+→escalate-human
    const strategyByCycle = new Map(ladder.map(r => [r.cycle, r.strategy]))
    expect(strategyByCycle.get(1)).toBe('normal')
    expect(strategyByCycle.get(2)).toBe('context-enriched')
    expect(strategyByCycle.get(3)).toBe('decompose')
    expect(strategyByCycle.get(4)).toBe('escalate-human')
  })

  it('built-in circuit breaker matches hard-coded constants', () => {
    const workflow = loadWorkflowDefinitionFile(getBuiltinWorkflowPath())
    expect(workflow.escalation).toBeDefined()

    const cb = workflow.escalation!.circuitBreaker
    // MAX_TOTAL_SESSIONS = 8 from agent-tracking.ts
    expect(cb.maxSessionsPerIssue).toBe(8)
    // MAX_SESSION_ATTEMPTS = 3 from decision-engine.ts
    expect(cb.maxSessionsPerPhase).toBe(3)
  })

  it('built-in refinement phase has strategy variants', () => {
    const workflow = loadWorkflowDefinitionFile(getBuiltinWorkflowPath())
    const refinement = workflow.phases.find(p => p.name === 'refinement')
    expect(refinement).toBeDefined()
    expect(refinement!.variants).toBeDefined()
    expect(refinement!.variants!['context-enriched']).toBe('refinement-context-enriched')
    expect(refinement!.variants!['decompose']).toBe('refinement-decompose')
  })

  it('throws on non-existent file', () => {
    expect(() => loadWorkflowDefinitionFile('/non/existent/file.yaml')).toThrow()
  })

  it('throws on invalid YAML syntax', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-test-'))
    const tmpPath = path.join(tmpDir, 'bad-yaml.yaml')
    fs.writeFileSync(tmpPath, '{ invalid yaml syntax :::\n  broken: [')
    try {
      expect(() => loadWorkflowDefinitionFile(tmpPath)).toThrow('Failed to load workflow definition')
    } finally {
      fs.rmSync(tmpDir, { recursive: true })
    }
  })

  it('throws on schema validation failure with file path', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-test-'))
    const tmpPath = path.join(tmpDir, 'invalid-schema.yaml')
    fs.writeFileSync(tmpPath, 'apiVersion: v1\nkind: WorkflowTemplate\nmetadata:\n  name: test\n')
    try {
      expect(() => loadWorkflowDefinitionFile(tmpPath)).toThrow(tmpPath)
    } finally {
      fs.rmSync(tmpDir, { recursive: true })
    }
  })

  it('throws on valid YAML but invalid workflow schema', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-test-'))
    const tmpPath = path.join(tmpDir, 'wrong-kind.yaml')
    fs.writeFileSync(tmpPath, [
      'apiVersion: v1.1',
      'kind: WorkflowDefinition',
      'metadata:',
      '  name: test',
      '# missing phases and transitions',
    ].join('\n'))
    try {
      expect(() => loadWorkflowDefinitionFile(tmpPath)).toThrow('Invalid workflow definition')
    } finally {
      fs.rmSync(tmpDir, { recursive: true })
    }
  })
})
