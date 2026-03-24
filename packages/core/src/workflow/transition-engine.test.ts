import { describe, it, expect } from 'vitest'
import { evaluateTransitions, type TransitionContext } from './transition-engine.js'
import { WorkflowRegistry } from './workflow-registry.js'
import type { WorkflowDefinition } from './workflow-types.js'
import type { GovernorIssue } from '../governor/governor-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(overrides: Partial<GovernorIssue> = {}): GovernorIssue {
  return {
    id: 'issue-1',
    identifier: 'SUP-100',
    title: 'Test Issue',
    status: 'Backlog',
    labels: [],
    createdAt: Date.now() - 2 * 60 * 60 * 1000,
    ...overrides,
  }
}

function makeWorkflow(overrides?: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    apiVersion: 'v1.1',
    kind: 'WorkflowDefinition',
    metadata: { name: 'test' },
    phases: [
      { name: 'development', template: 'development' },
      { name: 'qa', template: 'qa' },
      { name: 'acceptance', template: 'acceptance' },
      { name: 'refinement', template: 'refinement' },
      { name: 'research', template: 'research' },
      { name: 'backlog-creation', template: 'backlog-creation' },
    ],
    transitions: [
      { from: 'Backlog', to: 'development' },
      { from: 'Finished', to: 'qa' },
      { from: 'Delivered', to: 'acceptance' },
      { from: 'Rejected', to: 'refinement' },
    ],
    ...overrides,
  }
}

function makeContext(overrides: Partial<TransitionContext> = {}): TransitionContext {
  const registry = WorkflowRegistry.create({ workflow: makeWorkflow() })
  return {
    issue: makeIssue(),
    registry,
    isParentIssue: false,
    ...overrides,
  }
}

function registryWith(workflow: WorkflowDefinition): WorkflowRegistry {
  return WorkflowRegistry.create({ workflow })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('evaluateTransitions', () => {
  // --- Standard pipeline transitions (matching hard-coded switch) ---

  describe('standard pipeline transitions', () => {
    it('Backlog → trigger-development', () => {
      const ctx = makeContext({ issue: makeIssue({ status: 'Backlog' }) })
      const result = evaluateTransitions(ctx)

      expect(result.action).toBe('trigger-development')
      expect(result.reason).toContain('Backlog')
      expect(result.reason).toContain('development')
    })

    it('Finished → trigger-qa', () => {
      const ctx = makeContext({ issue: makeIssue({ status: 'Finished' }) })
      const result = evaluateTransitions(ctx)

      expect(result.action).toBe('trigger-qa')
      expect(result.reason).toContain('Finished')
    })

    it('Delivered → trigger-acceptance', () => {
      const ctx = makeContext({ issue: makeIssue({ status: 'Delivered' }) })
      const result = evaluateTransitions(ctx)

      expect(result.action).toBe('trigger-acceptance')
      expect(result.reason).toContain('Delivered')
    })

    it('Rejected → trigger-refinement', () => {
      const ctx = makeContext({ issue: makeIssue({ status: 'Rejected' }) })
      const result = evaluateTransitions(ctx)

      expect(result.action).toBe('trigger-refinement')
      expect(result.reason).toContain('Rejected')
    })
  })

  // --- Escalation strategy overrides ---

  describe('escalation strategy overrides', () => {
    it('escalate-human strategy overrides any transition', () => {
      const ctx = makeContext({
        issue: makeIssue({ status: 'Finished' }),
        workflowStrategy: 'escalate-human',
      })
      const result = evaluateTransitions(ctx)

      expect(result.action).toBe('escalate-human')
      expect(result.reason).toContain('escalate-human')
      expect(result.reason).toContain('human intervention')
    })

    it('decompose strategy overrides any transition', () => {
      const ctx = makeContext({
        issue: makeIssue({ status: 'Rejected' }),
        workflowStrategy: 'decompose',
      })
      const result = evaluateTransitions(ctx)

      expect(result.action).toBe('decompose')
      expect(result.reason).toContain('decompose')
      expect(result.reason).toContain('decomposition')
    })

    it('normal strategy does NOT override transitions', () => {
      const ctx = makeContext({
        issue: makeIssue({ status: 'Finished' }),
        workflowStrategy: 'normal',
      })
      const result = evaluateTransitions(ctx)

      expect(result.action).toBe('trigger-qa')
    })

    it('context-enriched strategy does NOT override transitions', () => {
      const ctx = makeContext({
        issue: makeIssue({ status: 'Rejected' }),
        workflowStrategy: 'context-enriched',
      })
      const result = evaluateTransitions(ctx)

      expect(result.action).toBe('trigger-refinement')
    })
  })

  // --- No matching transitions ---

  describe('no matching transitions', () => {
    it('returns none for unrecognized status', () => {
      const ctx = makeContext({ issue: makeIssue({ status: 'UnknownStatus' }) })
      const result = evaluateTransitions(ctx)

      expect(result.action).toBe('none')
      expect(result.reason).toContain('No transitions defined')
      expect(result.reason).toContain('UnknownStatus')
    })

    it('returns none when no workflow loaded', () => {
      const registry = WorkflowRegistry.create({ useBuiltinDefault: false })
      const ctx: TransitionContext = {
        issue: makeIssue({ status: 'Backlog' }),
        registry,
        isParentIssue: false,
      }
      const result = evaluateTransitions(ctx)

      expect(result.action).toBe('none')
      expect(result.reason).toContain('No workflow definition loaded')
    })
  })

  // --- Priority ordering ---

  describe('priority ordering', () => {
    it('evaluates higher priority transitions first', () => {
      const workflow = makeWorkflow({
        transitions: [
          { from: 'Backlog', to: 'qa', priority: 5 },
          { from: 'Backlog', to: 'development', priority: 10 },
        ],
      })
      const ctx = makeContext({
        issue: makeIssue({ status: 'Backlog' }),
        registry: registryWith(workflow),
      })
      const result = evaluateTransitions(ctx)

      expect(result.action).toBe('trigger-development')
    })

    it('uses definition order when priorities are equal', () => {
      const workflow = makeWorkflow({
        transitions: [
          { from: 'Backlog', to: 'development' },
          { from: 'Backlog', to: 'qa' },
        ],
      })
      const ctx = makeContext({
        issue: makeIssue({ status: 'Backlog' }),
        registry: registryWith(workflow),
      })
      const result = evaluateTransitions(ctx)

      // First match wins when priority is equal (both default to 0)
      expect(result.action).toBe('trigger-development')
    })
  })

  // --- Conditional transitions (conditions now evaluated) ---

  describe('conditional transitions', () => {
    it('evaluates condition and selects matching conditional transition', () => {
      const workflow = makeWorkflow({
        transitions: [
          { from: 'Backlog', to: 'qa', condition: '{{ isParentIssue }}', priority: 10 },
          { from: 'Backlog', to: 'development' },
        ],
      })
      const ctx = makeContext({
        issue: makeIssue({ status: 'Backlog' }),
        registry: registryWith(workflow),
        isParentIssue: true,
      })
      const result = evaluateTransitions(ctx)

      // isParentIssue is true, so conditional transition matches
      expect(result.action).toBe('trigger-qa')
    })

    it('skips conditional transition when condition is false and falls through to unconditional', () => {
      const workflow = makeWorkflow({
        transitions: [
          { from: 'Backlog', to: 'qa', condition: '{{ isParentIssue }}', priority: 10 },
          { from: 'Backlog', to: 'development' },
        ],
      })
      const ctx = makeContext({
        issue: makeIssue({ status: 'Backlog' }),
        registry: registryWith(workflow),
        isParentIssue: false,
      })
      const result = evaluateTransitions(ctx)

      // isParentIssue is false, so conditional transition skipped, falls through to unconditional
      expect(result.action).toBe('trigger-development')
    })

    it('selects first true condition when all transitions are conditional', () => {
      const workflow = makeWorkflow({
        transitions: [
          { from: 'Backlog', to: 'development', condition: '{{ true }}' },
          { from: 'Backlog', to: 'qa', condition: '{{ false }}' },
        ],
      })
      const ctx = makeContext({
        issue: makeIssue({ status: 'Backlog' }),
        registry: registryWith(workflow),
      })
      const result = evaluateTransitions(ctx)

      expect(result.action).toBe('trigger-development')
    })

    it('returns none when all conditional transitions evaluate to false', () => {
      const workflow = makeWorkflow({
        transitions: [
          { from: 'Backlog', to: 'development', condition: '{{ false }}' },
          { from: 'Backlog', to: 'qa', condition: '{{ false }}' },
        ],
      })
      const ctx = makeContext({
        issue: makeIssue({ status: 'Backlog' }),
        registry: registryWith(workflow),
      })
      const result = evaluateTransitions(ctx)

      expect(result.action).toBe('none')
      expect(result.reason).toContain('No transition conditions satisfied')
    })

    it('falls through conditional to next conditional when first is false', () => {
      const workflow = makeWorkflow({
        transitions: [
          { from: 'Backlog', to: 'development', condition: '{{ false }}', priority: 10 },
          { from: 'Backlog', to: 'qa', condition: '{{ true }}', priority: 5 },
        ],
      })
      const ctx = makeContext({
        issue: makeIssue({ status: 'Backlog' }),
        registry: registryWith(workflow),
      })
      const result = evaluateTransitions(ctx)

      // First condition false, second condition true
      expect(result.action).toBe('trigger-qa')
    })

    it('mix of conditional and unconditional transitions — conditional wins when true', () => {
      const workflow = makeWorkflow({
        transitions: [
          { from: 'Backlog', to: 'qa', condition: '{{ true }}', priority: 10 },
          { from: 'Backlog', to: 'development', priority: 5 },
        ],
      })
      const ctx = makeContext({
        issue: makeIssue({ status: 'Backlog' }),
        registry: registryWith(workflow),
      })
      const result = evaluateTransitions(ctx)

      expect(result.action).toBe('trigger-qa')
    })

    it('phaseState variables affect condition evaluation', () => {
      const workflow = makeWorkflow({
        transitions: [
          { from: 'Icebox', to: 'research', condition: '{{ not researchCompleted }}', priority: 10 },
          { from: 'Icebox', to: 'backlog-creation', condition: '{{ researchCompleted and not backlogCreationCompleted }}', priority: 5 },
        ],
      })

      // No research done yet
      const ctx1 = makeContext({
        issue: makeIssue({ status: 'Icebox' }),
        registry: registryWith(workflow),
        phaseState: { researchCompleted: false, backlogCreationCompleted: false },
      })
      const result1 = evaluateTransitions(ctx1)
      expect(result1.action).toBe('trigger-research')

      // Research done, backlog not done
      const ctx2 = makeContext({
        issue: makeIssue({ status: 'Icebox' }),
        registry: registryWith(workflow),
        phaseState: { researchCompleted: true, backlogCreationCompleted: false },
      })
      const result2 = evaluateTransitions(ctx2)
      expect(result2.action).toBe('trigger-backlog-creation')

      // Both done
      const ctx3 = makeContext({
        issue: makeIssue({ status: 'Icebox' }),
        registry: registryWith(workflow),
        phaseState: { researchCompleted: true, backlogCreationCompleted: true },
      })
      const result3 = evaluateTransitions(ctx3)
      expect(result3.action).toBe('none')
    })
  })

  // --- Parent issue annotation ---

  describe('parent issue annotation', () => {
    it('includes parent note in reason for parent issues', () => {
      const ctx = makeContext({
        issue: makeIssue({ status: 'Backlog' }),
        isParentIssue: true,
      })
      const result = evaluateTransitions(ctx)

      expect(result.action).toBe('trigger-development')
      expect(result.reason).toContain('coordination template')
    })

    it('does not include parent note for non-parent issues', () => {
      const ctx = makeContext({
        issue: makeIssue({ status: 'Backlog' }),
        isParentIssue: false,
      })
      const result = evaluateTransitions(ctx)

      expect(result.action).toBe('trigger-development')
      expect(result.reason).not.toContain('coordination template')
    })
  })

  // --- Parallelism group detection ---

  describe('parallelism group detection', () => {
    it('parent issue with phase in parallelism group returns trigger-parallel-group', () => {
      const workflow = makeWorkflow({
        parallelism: [
          {
            name: 'dev-parallel',
            phases: ['development'],
            strategy: 'fan-out',
          },
        ],
      })
      const ctx = makeContext({
        issue: makeIssue({ status: 'Backlog' }),
        registry: registryWith(workflow),
        isParentIssue: true,
      })
      const result = evaluateTransitions(ctx)

      expect(result.action).toBe('trigger-parallel-group')
      expect(result.reason).toContain('parallel group')
      expect(result.reason).toContain('dev-parallel')
      expect(result.reason).toContain('fan-out')
    })

    it('non-parent issue with phase in parallelism group returns normal action', () => {
      const workflow = makeWorkflow({
        parallelism: [
          {
            name: 'dev-parallel',
            phases: ['development'],
            strategy: 'fan-out',
          },
        ],
      })
      const ctx = makeContext({
        issue: makeIssue({ status: 'Backlog' }),
        registry: registryWith(workflow),
        isParentIssue: false,
      })
      const result = evaluateTransitions(ctx)

      expect(result.action).toBe('trigger-development')
      expect(result.reason).not.toContain('parallel group')
    })

    it('issue with no parallelism groups returns normal action', () => {
      const ctx = makeContext({
        issue: makeIssue({ status: 'Backlog' }),
        isParentIssue: true,
      })
      const result = evaluateTransitions(ctx)

      expect(result.action).toBe('trigger-development')
      expect(result.reason).not.toContain('parallel group')
    })

    it('parent issue with phase NOT in any parallelism group returns normal action', () => {
      const workflow = makeWorkflow({
        parallelism: [
          {
            name: 'qa-parallel',
            phases: ['qa'],
            strategy: 'fan-in',
          },
        ],
      })
      const ctx = makeContext({
        issue: makeIssue({ status: 'Backlog' }),
        registry: registryWith(workflow),
        isParentIssue: true,
      })
      const result = evaluateTransitions(ctx)

      // 'development' is not in the parallelism group, so normal action
      expect(result.action).toBe('trigger-development')
      expect(result.reason).toContain('coordination template')
    })

    it('escalation strategy overrides parallelism group detection', () => {
      const workflow = makeWorkflow({
        parallelism: [
          {
            name: 'dev-parallel',
            phases: ['development'],
            strategy: 'fan-out',
          },
        ],
      })
      const ctx = makeContext({
        issue: makeIssue({ status: 'Backlog' }),
        registry: registryWith(workflow),
        isParentIssue: true,
        workflowStrategy: 'escalate-human',
      })
      const result = evaluateTransitions(ctx)

      // Escalation takes priority over parallelism
      expect(result.action).toBe('escalate-human')
    })
  })

  // --- Phase-to-action mapping ---

  describe('phase-to-action mapping', () => {
    it('returns none for unknown phase name', () => {
      const workflow = makeWorkflow({
        transitions: [
          { from: 'Backlog', to: 'completely-unknown-phase' },
        ],
      })
      const ctx = makeContext({
        issue: makeIssue({ status: 'Backlog' }),
        registry: registryWith(workflow),
      })
      const result = evaluateTransitions(ctx)

      expect(result.action).toBe('none')
      expect(result.reason).toContain('does not map to a known GovernorAction')
    })
  })

  // --- Built-in default workflow parity ---

  describe('built-in default workflow parity', () => {
    // These tests verify that the built-in workflow.yaml transitions
    // produce the same GovernorActions as the hard-coded switch statement,
    // for the standard unconditional transitions.

    const builtinRegistry = WorkflowRegistry.create()

    it('Backlog → trigger-development (matches decideBacklog)', () => {
      const result = evaluateTransitions({
        issue: makeIssue({ status: 'Backlog' }),
        registry: builtinRegistry,
        isParentIssue: false,
      })
      expect(result.action).toBe('trigger-development')
    })

    it('Finished → trigger-qa (matches decideFinished)', () => {
      const result = evaluateTransitions({
        issue: makeIssue({ status: 'Finished' }),
        registry: builtinRegistry,
        isParentIssue: false,
      })
      expect(result.action).toBe('trigger-qa')
    })

    it('Delivered → trigger-acceptance (matches decideDelivered)', () => {
      const result = evaluateTransitions({
        issue: makeIssue({ status: 'Delivered' }),
        registry: builtinRegistry,
        isParentIssue: false,
      })
      expect(result.action).toBe('trigger-acceptance')
    })

    it('Rejected → trigger-refinement (matches decideRejected)', () => {
      const result = evaluateTransitions({
        issue: makeIssue({ status: 'Rejected' }),
        registry: builtinRegistry,
        isParentIssue: false,
      })
      expect(result.action).toBe('trigger-refinement')
    })

    it('Finished + escalate-human → escalate-human (matches decideFinished)', () => {
      const result = evaluateTransitions({
        issue: makeIssue({ status: 'Finished' }),
        registry: builtinRegistry,
        workflowStrategy: 'escalate-human',
        isParentIssue: false,
      })
      expect(result.action).toBe('escalate-human')
    })

    it('Rejected + decompose → decompose (matches decideRejected)', () => {
      const result = evaluateTransitions({
        issue: makeIssue({ status: 'Rejected' }),
        registry: builtinRegistry,
        workflowStrategy: 'decompose',
        isParentIssue: false,
      })
      expect(result.action).toBe('decompose')
    })

    it('Icebox with phaseState routes to research when researchCompleted is false', () => {
      const result = evaluateTransitions({
        issue: makeIssue({ status: 'Icebox' }),
        registry: builtinRegistry,
        isParentIssue: false,
        phaseState: { researchCompleted: false, backlogCreationCompleted: false },
      })
      // researchCompleted is false, so "not researchCompleted" is true → research phase
      expect(result.action).toBe('trigger-research')
    })

    it('Icebox with phaseState routes to backlog-creation when research done', () => {
      const result = evaluateTransitions({
        issue: makeIssue({ status: 'Icebox' }),
        registry: builtinRegistry,
        isParentIssue: false,
        phaseState: { researchCompleted: true, backlogCreationCompleted: false },
      })
      // researchCompleted is true and backlogCreationCompleted is false → backlog-creation
      expect(result.action).toBe('trigger-backlog-creation')
    })

    it('Icebox with no phaseState routes to research (undefined vars are falsy)', () => {
      const result = evaluateTransitions({
        issue: makeIssue({ status: 'Icebox' }),
        registry: builtinRegistry,
        isParentIssue: false,
      })
      // No phaseState → researchCompleted is undefined → falsy → "not researchCompleted" is true
      expect(result.action).toBe('trigger-research')
    })
  })
})
