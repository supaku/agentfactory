import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WorkflowRegistry } from './workflow-registry.js'
import type { WorkflowDefinition } from './workflow-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkflow(overrides?: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    apiVersion: 'v1.1',
    kind: 'WorkflowDefinition',
    metadata: { name: 'test-workflow' },
    phases: [
      { name: 'development', template: 'development' },
      { name: 'qa', template: 'qa' },
    ],
    transitions: [
      { from: 'Backlog', to: 'development' },
      { from: 'Finished', to: 'qa' },
    ],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowRegistry', () => {
  describe('create()', () => {
    it('loads built-in default workflow', () => {
      const registry = WorkflowRegistry.create()
      const workflow = registry.getWorkflow()

      expect(workflow).not.toBeNull()
      expect(workflow!.metadata.name).toBe('default-workflow')
    })

    it('accepts inline workflow override (highest priority)', () => {
      const custom = makeWorkflow({ metadata: { name: 'custom' } })
      const registry = WorkflowRegistry.create({ workflow: custom })
      const workflow = registry.getWorkflow()

      expect(workflow!.metadata.name).toBe('custom')
    })

    it('project-level YAML overrides built-in default', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-reg-'))
      const tmpPath = path.join(tmpDir, 'workflow.yaml')
      fs.writeFileSync(tmpPath, [
        'apiVersion: v1.1',
        'kind: WorkflowDefinition',
        'metadata:',
        '  name: project-override',
        'phases:',
        '  - name: dev',
        '    template: development',
        'transitions:',
        '  - from: Backlog',
        '    to: dev',
        'escalation:',
        '  ladder:',
        '    - cycle: 1',
        '      strategy: normal',
        '  circuitBreaker:',
        '    maxSessionsPerIssue: 5',
      ].join('\n'))

      try {
        const registry = WorkflowRegistry.create({ workflowPath: tmpPath })
        const workflow = registry.getWorkflow()

        expect(workflow!.metadata.name).toBe('project-override')
        expect(workflow!.escalation!.circuitBreaker.maxSessionsPerIssue).toBe(5)
      } finally {
        fs.rmSync(tmpDir, { recursive: true })
      }
    })

    it('inline override beats project-level YAML', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-reg-'))
      const tmpPath = path.join(tmpDir, 'workflow.yaml')
      fs.writeFileSync(tmpPath, [
        'apiVersion: v1.1',
        'kind: WorkflowDefinition',
        'metadata:',
        '  name: project-override',
        'phases: []',
        'transitions: []',
        'escalation:',
        '  ladder:',
        '    - cycle: 1',
        '      strategy: normal',
        '  circuitBreaker:',
        '    maxSessionsPerIssue: 5',
      ].join('\n'))

      try {
        const custom = makeWorkflow({ metadata: { name: 'inline-wins' } })
        const registry = WorkflowRegistry.create({
          workflowPath: tmpPath,
          workflow: custom,
        })

        expect(registry.getWorkflow()!.metadata.name).toBe('inline-wins')
      } finally {
        fs.rmSync(tmpDir, { recursive: true })
      }
    })

    it('can disable built-in default', () => {
      const registry = WorkflowRegistry.create({ useBuiltinDefault: false })
      expect(registry.getWorkflow()).toBeNull()
    })

    it('ignores non-existent project-level path', () => {
      const registry = WorkflowRegistry.create({
        workflowPath: '/non/existent/workflow.yaml',
      })
      // Falls back to built-in default
      expect(registry.getWorkflow()!.metadata.name).toBe('default-workflow')
    })
  })

  describe('getEscalationStrategy()', () => {
    it('returns strategy from the built-in ladder', () => {
      const registry = WorkflowRegistry.create()

      expect(registry.getEscalationStrategy(0)).toBe('normal')
      expect(registry.getEscalationStrategy(1)).toBe('normal')
      expect(registry.getEscalationStrategy(2)).toBe('context-enriched')
      expect(registry.getEscalationStrategy(3)).toBe('decompose')
      expect(registry.getEscalationStrategy(4)).toBe('escalate-human')
      expect(registry.getEscalationStrategy(10)).toBe('escalate-human')
    })

    it('returns strategy from custom ladder', () => {
      const custom = makeWorkflow({
        escalation: {
          ladder: [
            { cycle: 1, strategy: 'normal' },
            { cycle: 5, strategy: 'custom-strategy' },
          ],
          circuitBreaker: { maxSessionsPerIssue: 10 },
        },
      })
      const registry = WorkflowRegistry.create({ workflow: custom })

      expect(registry.getEscalationStrategy(1)).toBe('normal')
      expect(registry.getEscalationStrategy(4)).toBe('normal')
      expect(registry.getEscalationStrategy(5)).toBe('custom-strategy')
      expect(registry.getEscalationStrategy(99)).toBe('custom-strategy')
    })

    it('falls back to hard-coded strategy when no escalation config', () => {
      const custom = makeWorkflow() // No escalation
      const registry = WorkflowRegistry.create({ workflow: custom })

      expect(registry.getEscalationStrategy(0)).toBe('normal')
      expect(registry.getEscalationStrategy(1)).toBe('normal')
      expect(registry.getEscalationStrategy(2)).toBe('context-enriched')
      expect(registry.getEscalationStrategy(3)).toBe('decompose')
      expect(registry.getEscalationStrategy(4)).toBe('escalate-human')
    })

    it('returns "normal" for cycle 0 when ladder starts at 1', () => {
      const registry = WorkflowRegistry.create()
      // The built-in ladder starts at cycle 1, so cycle 0 should still match
      // cycle 1's strategy (normal) since 0 < 1 means no match, falling back.
      // Actually: sorted desc [4,3,2,1], find first where 0 >= rung.cycle → none
      // So returns 'normal' (fallback).
      expect(registry.getEscalationStrategy(0)).toBe('normal')
    })
  })

  describe('getCircuitBreakerLimits()', () => {
    it('returns built-in limits matching hard-coded constants', () => {
      const registry = WorkflowRegistry.create()
      const limits = registry.getCircuitBreakerLimits()

      expect(limits.maxSessionsPerIssue).toBe(8)  // MAX_TOTAL_SESSIONS
      expect(limits.maxSessionsPerPhase).toBe(3)   // MAX_SESSION_ATTEMPTS
    })

    it('returns custom limits from workflow definition', () => {
      const custom = makeWorkflow({
        escalation: {
          ladder: [{ cycle: 1, strategy: 'normal' }],
          circuitBreaker: {
            maxSessionsPerIssue: 12,
            maxSessionsPerPhase: 5,
          },
        },
      })
      const registry = WorkflowRegistry.create({ workflow: custom })
      const limits = registry.getCircuitBreakerLimits()

      expect(limits.maxSessionsPerIssue).toBe(12)
      expect(limits.maxSessionsPerPhase).toBe(5)
    })

    it('returns defaults when no escalation config', () => {
      const custom = makeWorkflow() // No escalation
      const registry = WorkflowRegistry.create({ workflow: custom })
      const limits = registry.getCircuitBreakerLimits()

      expect(limits.maxSessionsPerIssue).toBe(8)
      expect(limits.maxSessionsPerPhase).toBe(3)
    })
  })

  describe('getEscalation()', () => {
    it('returns escalation config from workflow', () => {
      const registry = WorkflowRegistry.create()
      const escalation = registry.getEscalation()

      expect(escalation).not.toBeNull()
      expect(escalation!.ladder.length).toBeGreaterThanOrEqual(4)
    })

    it('returns null when no escalation defined', () => {
      const custom = makeWorkflow()
      const registry = WorkflowRegistry.create({ workflow: custom })
      expect(registry.getEscalation()).toBeNull()
    })
  })
})
