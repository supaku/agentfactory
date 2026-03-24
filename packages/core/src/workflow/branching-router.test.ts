import { describe, it, expect } from 'vitest'
import { evaluateBranching } from './branching-router.js'
import type { BranchingDefinition } from './workflow-types.js'
import type { EvaluationContext } from './expression/index.js'
import { buildEvaluationContext } from './expression/index.js'
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

function makeContext(
  phaseState?: Record<string, boolean>,
  opts?: { hasSubIssues?: boolean; issue?: Partial<GovernorIssue> },
): EvaluationContext {
  const issue = makeIssue(opts?.issue)
  return buildEvaluationContext(issue, phaseState, { hasSubIssues: opts?.hasSubIssues ?? false })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('evaluateBranching', () => {
  it('returns then.template when condition is true', () => {
    const branching: BranchingDefinition[] = [
      {
        name: 'parent-check',
        condition: '{{ isParentIssue }}',
        then: { template: 'coordination' },
      },
    ]
    const ctx = makeContext(undefined, { hasSubIssues: true })
    const result = evaluateBranching(branching, ctx)

    expect(result.template).toBe('coordination')
    expect(result.reason).toContain('parent-check')
    expect(result.reason).toContain('coordination')
  })

  it('returns else.template when condition is false and else is present', () => {
    const branching: BranchingDefinition[] = [
      {
        name: 'parent-check',
        condition: '{{ isParentIssue }}',
        then: { template: 'coordination' },
        else: { template: 'development' },
      },
    ]
    const ctx = makeContext(undefined, { hasSubIssues: false })
    const result = evaluateBranching(branching, ctx)

    expect(result.template).toBe('development')
    expect(result.reason).toContain('parent-check')
    expect(result.reason).toContain('else')
    expect(result.reason).toContain('development')
  })

  it('falls through when condition is false and no else present', () => {
    const branching: BranchingDefinition[] = [
      {
        name: 'parent-check',
        condition: '{{ isParentIssue }}',
        then: { template: 'coordination' },
        // No else
      },
    ]
    const ctx = makeContext(undefined, { hasSubIssues: false })
    const result = evaluateBranching(branching, ctx)

    expect(result.template).toBeNull()
    expect(result.reason).toContain('No branching block matched')
  })

  it('first matching branch wins (short-circuit)', () => {
    const branching: BranchingDefinition[] = [
      {
        name: 'first',
        condition: '{{ true }}',
        then: { template: 'template-a' },
      },
      {
        name: 'second',
        condition: '{{ true }}',
        then: { template: 'template-b' },
      },
    ]
    const ctx = makeContext()
    const result = evaluateBranching(branching, ctx)

    expect(result.template).toBe('template-a')
    expect(result.reason).toContain('first')
  })

  it('falls through to second branch when first is false and has no else', () => {
    const branching: BranchingDefinition[] = [
      {
        name: 'first',
        condition: '{{ false }}',
        then: { template: 'template-a' },
      },
      {
        name: 'second',
        condition: '{{ true }}',
        then: { template: 'template-b' },
      },
    ]
    const ctx = makeContext()
    const result = evaluateBranching(branching, ctx)

    expect(result.template).toBe('template-b')
    expect(result.reason).toContain('second')
  })

  it('returns null when no branches match', () => {
    const branching: BranchingDefinition[] = [
      {
        name: 'first',
        condition: '{{ false }}',
        then: { template: 'template-a' },
      },
      {
        name: 'second',
        condition: '{{ false }}',
        then: { template: 'template-b' },
      },
    ]
    const ctx = makeContext()
    const result = evaluateBranching(branching, ctx)

    expect(result.template).toBeNull()
    expect(result.reason).toBe('No branching block matched')
  })

  it('returns null for empty branching array', () => {
    const ctx = makeContext()
    const result = evaluateBranching([], ctx)

    expect(result.template).toBeNull()
    expect(result.reason).toBe('No branching block matched')
  })

  it('evaluates real expressions using phaseState variables', () => {
    const branching: BranchingDefinition[] = [
      {
        name: 'research-gate',
        condition: '{{ not researchCompleted }}',
        then: { template: 'research' },
        else: { template: 'backlog-creation' },
      },
    ]

    // Research not completed → research template
    const ctx1 = makeContext({ researchCompleted: false })
    const result1 = evaluateBranching(branching, ctx1)
    expect(result1.template).toBe('research')

    // Research completed → else branch (backlog-creation)
    const ctx2 = makeContext({ researchCompleted: true })
    const result2 = evaluateBranching(branching, ctx2)
    expect(result2.template).toBe('backlog-creation')
  })

  it('evaluates compound expressions with and/or', () => {
    const branching: BranchingDefinition[] = [
      {
        name: 'ready-for-backlog',
        condition: '{{ researchCompleted and not backlogCreationCompleted }}',
        then: { template: 'backlog-creation' },
      },
    ]

    // Both conditions met
    const ctx1 = makeContext({ researchCompleted: true, backlogCreationCompleted: false })
    const result1 = evaluateBranching(branching, ctx1)
    expect(result1.template).toBe('backlog-creation')

    // Research not completed → condition false
    const ctx2 = makeContext({ researchCompleted: false, backlogCreationCompleted: false })
    const result2 = evaluateBranching(branching, ctx2)
    expect(result2.template).toBeNull()

    // Both completed → condition false (not backlogCreationCompleted is false)
    const ctx3 = makeContext({ researchCompleted: true, backlogCreationCompleted: true })
    const result3 = evaluateBranching(branching, ctx3)
    expect(result3.template).toBeNull()
  })

  it('uses hasLabel() helper from evaluation context', () => {
    const branching: BranchingDefinition[] = [
      {
        name: 'bug-route',
        condition: "{{ hasLabel('bug') }}",
        then: { template: 'bug-fix' },
        else: { template: 'feature' },
      },
    ]

    // Issue has 'bug' label
    const ctx1 = makeContext(undefined, { issue: { labels: ['bug', 'critical'] } })
    const result1 = evaluateBranching(branching, ctx1)
    expect(result1.template).toBe('bug-fix')

    // Issue does not have 'bug' label
    const ctx2 = makeContext(undefined, { issue: { labels: ['feature'] } })
    const result2 = evaluateBranching(branching, ctx2)
    expect(result2.template).toBe('feature')
  })

  it('first branch else takes precedence over second branch match', () => {
    // When the first branch condition is false and it has an else,
    // the else template is returned immediately — second branch is NOT evaluated.
    const branching: BranchingDefinition[] = [
      {
        name: 'first',
        condition: '{{ false }}',
        then: { template: 'template-a' },
        else: { template: 'template-fallback' },
      },
      {
        name: 'second',
        condition: '{{ true }}',
        then: { template: 'template-b' },
      },
    ]
    const ctx = makeContext()
    const result = evaluateBranching(branching, ctx)

    expect(result.template).toBe('template-fallback')
    expect(result.reason).toContain('first')
    expect(result.reason).toContain('else')
  })
})
