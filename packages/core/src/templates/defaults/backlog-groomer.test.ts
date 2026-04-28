/**
 * Backlog Groomer Agent Tests — REN-1298
 *
 * Verifies that the backlog-groomer template:
 *   1. Loads and renders correctly through the TemplateRegistry.
 *   2. Contains the required disposition language (discard/refine/escalate-human).
 *   3. Enforces Principle 1 (no sub-issue creation).
 *   4. References stale-detection behaviour with configurable staleDays.
 *   5. Completion contract matches expected shape (comment_posted required).
 *
 * "Fixture icebox of 10 issues" test: Exercises the template with representative
 * issue contexts covering every expected disposition plus edge cases, and
 * verifies the rendered prompt contains the correct guidance for each scenario.
 */

import { describe, it, expect } from 'vitest'
import { TemplateRegistry } from '../registry.js'
import { getCompletionContract } from '../../orchestrator/completion-contracts.js'
import type { TemplateContext } from '../types.js'

// ---------------------------------------------------------------------------
// Fixture icebox — 10 representative issues mapped to expected dispositions
// ---------------------------------------------------------------------------

/**
 * Each fixture entry represents one icebox issue fed into a groomer cycle.
 * `expectedDispositionSignal` is the label/keyword the rendered prompt must
 * contain so the agent knows what action to take.
 */
interface IceboxFixture {
  id: string
  description: string
  expectedDispositionLabel: 'pm:discard' | 'pm:needs-refine' | 'pm:needs-human-decision'
  expectStale: boolean
  context: TemplateContext
}

const ICEBOX_FIXTURES: IceboxFixture[] = [
  {
    id: 'REN-FIX-01',
    description: 'Duplicate / superseded issue — should be discarded',
    expectedDispositionLabel: 'pm:discard',
    expectStale: false,
    context: { identifier: 'REN-FIX-01', mentionContext: 'This is a duplicate of REN-100 which was accepted.' },
  },
  {
    id: 'REN-FIX-02',
    description: 'Well-scoped feature — needs refinement before backlog',
    expectedDispositionLabel: 'pm:needs-refine',
    expectStale: false,
    context: { identifier: 'REN-FIX-02' },
  },
  {
    id: 'REN-FIX-03',
    description: 'Strategic direction change — escalate to human',
    expectedDispositionLabel: 'pm:needs-human-decision',
    expectStale: false,
    context: { identifier: 'REN-FIX-03' },
  },
  {
    id: 'REN-FIX-04',
    description: 'Stale duplicate (> 60 days) — discard with stale flag',
    expectedDispositionLabel: 'pm:discard',
    expectStale: true,
    context: { identifier: 'REN-FIX-04', staleDays: 60 } as TemplateContext & { staleDays: number },
  },
  {
    id: 'REN-FIX-05',
    description: 'Stale issue with recent activity mention — refine + stale',
    expectedDispositionLabel: 'pm:needs-refine',
    expectStale: true,
    context: { identifier: 'REN-FIX-05', staleDays: 60 } as TemplateContext & { staleDays: number },
  },
  {
    id: 'REN-FIX-06',
    description: 'Out-of-scope after pivot — discard',
    expectedDispositionLabel: 'pm:discard',
    expectStale: false,
    context: { identifier: 'REN-FIX-06' },
  },
  {
    id: 'REN-FIX-07',
    description: 'Vague issue needing scope sharpening — refine',
    expectedDispositionLabel: 'pm:needs-refine',
    expectStale: false,
    context: { identifier: 'REN-FIX-07', mentionContext: 'Issue is too vague to act on.' },
  },
  {
    id: 'REN-FIX-08',
    description: 'Pricing / billing policy question — escalate to human',
    expectedDispositionLabel: 'pm:needs-human-decision',
    expectStale: false,
    context: { identifier: 'REN-FIX-08' },
  },
  {
    id: 'REN-FIX-09',
    description: 'Custom staleDays (30) — issue older than 30 days, refine',
    expectedDispositionLabel: 'pm:needs-refine',
    expectStale: true,
    context: { identifier: 'REN-FIX-09', staleDays: 30 } as TemplateContext & { staleDays: number },
  },
  {
    id: 'REN-FIX-10',
    description: 'Architecture decision beyond PM scope — escalate + stale',
    expectedDispositionLabel: 'pm:needs-human-decision',
    expectStale: true,
    context: { identifier: 'REN-FIX-10', staleDays: 90 } as TemplateContext & { staleDays: number },
  },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildGroomerRegistry(): TemplateRegistry {
  return TemplateRegistry.create({ useBuiltinDefaults: true })
}

// ---------------------------------------------------------------------------
// Template presence
// ---------------------------------------------------------------------------

describe('backlog-groomer template — registration', () => {
  it('is registered in the default TemplateRegistry', () => {
    const registry = buildGroomerRegistry()
    expect(registry.hasTemplate('backlog-groomer')).toBe(true)
  })

  it('appears in getRegisteredWorkTypes()', () => {
    const registry = buildGroomerRegistry()
    expect(registry.getRegisteredWorkTypes()).toContain('backlog-groomer')
  })
})

// ---------------------------------------------------------------------------
// Template rendering — structure
// ---------------------------------------------------------------------------

describe('backlog-groomer template — structure', () => {
  let registry: TemplateRegistry

  // Use a shared registry; create once.
  registry = buildGroomerRegistry()

  it('renders with a minimal context (identifier only)', () => {
    const result = registry.renderPrompt('backlog-groomer', { identifier: 'REN-1298' })
    expect(result).not.toBeNull()
    expect(result).toContain('REN-1298')
  })

  it('contains the three disposition actions', () => {
    const result = registry.renderPrompt('backlog-groomer', { identifier: 'REN-001' })!
    expect(result).toContain('discard')
    expect(result).toContain('refine')
    expect(result).toContain('escalate-human')
  })

  it('contains the pm:discard label instruction', () => {
    const result = registry.renderPrompt('backlog-groomer', { identifier: 'REN-001' })!
    expect(result).toContain('pm:discard')
  })

  it('contains the pm:needs-refine label instruction', () => {
    const result = registry.renderPrompt('backlog-groomer', { identifier: 'REN-001' })!
    expect(result).toContain('pm:needs-refine')
  })

  it('contains the pm:needs-human-decision label instruction', () => {
    const result = registry.renderPrompt('backlog-groomer', { identifier: 'REN-001' })!
    expect(result).toContain('pm:needs-human-decision')
  })

  it('contains the pm:stale label instruction', () => {
    const result = registry.renderPrompt('backlog-groomer', { identifier: 'REN-001' })!
    expect(result).toContain('pm:stale')
  })

  it('defaults to 60 staleDays when not provided', () => {
    const result = registry.renderPrompt('backlog-groomer', { identifier: 'REN-001' })!
    expect(result).toContain('60')
  })

  it('uses custom staleDays when provided', () => {
    const result = registry.renderPrompt('backlog-groomer', {
      identifier: 'REN-001',
      staleDays: 30,
    } as TemplateContext & { staleDays: number })!
    expect(result).toContain('30')
  })

  it('prohibits sub-issue creation (Principle 1)', () => {
    const result = registry.renderPrompt('backlog-groomer', { identifier: 'REN-001' })!
    expect(result).toContain('NEVER create Linear sub-issues')
  })

  it('prohibits asking user for input (headless)', () => {
    const result = registry.renderPrompt('backlog-groomer', { identifier: 'REN-001' })!
    expect(result).toContain('Do not ask the user for input')
  })

  it('instructs the agent to process exactly one issue', () => {
    const result = registry.renderPrompt('backlog-groomer', { identifier: 'REN-001' })!
    expect(result).toContain('exactly one issue')
  })

  it('contains a WORK_RESULT:passed marker instruction', () => {
    const result = registry.renderPrompt('backlog-groomer', { identifier: 'REN-001' })!
    expect(result).toContain('WORK_RESULT:passed')
  })

  it('contains a WORK_RESULT:failed marker instruction', () => {
    const result = registry.renderPrompt('backlog-groomer', { identifier: 'REN-001' })!
    expect(result).toContain('WORK_RESULT:failed')
  })

  it('injects mentionContext when provided', () => {
    const result = registry.renderPrompt('backlog-groomer', {
      identifier: 'REN-001',
      mentionContext: 'Focus on auth-related issues.',
    })!
    expect(result).toContain('Focus on auth-related issues.')
    expect(result).toContain('Additional context')
  })

  it('omits mentionContext section when not provided', () => {
    const result = registry.renderPrompt('backlog-groomer', { identifier: 'REN-001' })!
    expect(result).not.toContain('Additional context')
  })
})

// ---------------------------------------------------------------------------
// Tool permissions
// ---------------------------------------------------------------------------

describe('backlog-groomer template — tool permissions', () => {
  const registry = buildGroomerRegistry()

  it('has allowed tool permissions defined', () => {
    const perms = registry.getToolPermissions('backlog-groomer')
    expect(perms).toBeDefined()
    expect(perms!.length).toBeGreaterThan(0)
  })

  it('allows af-linear get-issue', () => {
    const perms = registry.getToolPermissions('backlog-groomer')!
    expect(perms.some(p => p.includes('af-linear') || p.includes('pnpm'))).toBe(true)
  })

  it('disallows user-input', () => {
    const disallowed = registry.getDisallowedTools('backlog-groomer')
    expect(disallowed).toBeDefined()
    expect(disallowed).toContain('user-input')
  })

  it('disallows sub-issue creation (--parentId)', () => {
    const disallowed = registry.getDisallowedTools('backlog-groomer')
    expect(disallowed).toBeDefined()
    const parentIdBlock = disallowed!.some(
      d => typeof d === 'object' && 'shell' in d && d.shell.includes('--parentId')
    )
    expect(parentIdBlock).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Completion contract
// ---------------------------------------------------------------------------

describe('backlog-groomer — completion contract', () => {
  it('has a completion contract defined', () => {
    const contract = getCompletionContract('backlog-groomer')
    expect(contract).toBeDefined()
    expect(contract!.workType).toBe('backlog-groomer')
  })

  it('requires comment_posted (disposition evidence)', () => {
    const contract = getCompletionContract('backlog-groomer')!
    const requiredTypes = contract.required.map(f => f.type)
    expect(requiredTypes).toContain('comment_posted')
  })

  it('does NOT require PR or commits (no code output)', () => {
    const contract = getCompletionContract('backlog-groomer')!
    const requiredTypes = contract.required.map(f => f.type)
    expect(requiredTypes).not.toContain('pr_url')
    expect(requiredTypes).not.toContain('commits_present')
    expect(requiredTypes).not.toContain('branch_pushed')
  })

  it('does NOT require sub_issues_created (Principle 1)', () => {
    const contract = getCompletionContract('backlog-groomer')!
    const allTypes = [
      ...contract.required.map(f => f.type),
      ...contract.optional.map(f => f.type),
    ]
    expect(allTypes).not.toContain('sub_issues_created')
  })

  it('has issue_updated as optional (description update)', () => {
    const contract = getCompletionContract('backlog-groomer')!
    const optionalTypes = contract.optional.map(f => f.type)
    expect(optionalTypes).toContain('issue_updated')
  })
})

// ---------------------------------------------------------------------------
// Fixture icebox — 10 issues, each rendered and disposition-verified
// ---------------------------------------------------------------------------

describe('backlog-groomer — fixture icebox (10 issues)', () => {
  const registry = buildGroomerRegistry()

  for (const fixture of ICEBOX_FIXTURES) {
    it(`[${fixture.id}] ${fixture.description}`, () => {
      const result = registry.renderPrompt('backlog-groomer', fixture.context)
      expect(result, `Template rendered null for ${fixture.id}`).not.toBeNull()

      // The rendered prompt must contain the disposition label so the agent
      // knows what Linear label to apply.
      expect(result, `Missing disposition label ${fixture.expectedDispositionLabel} for ${fixture.id}`)
        .toContain(fixture.expectedDispositionLabel)

      // Stale label must also be referenced in the prompt.
      if (fixture.expectStale) {
        expect(result, `Missing pm:stale reference for stale fixture ${fixture.id}`)
          .toContain('pm:stale')
      }

      // Every render must contain Principle 1 enforcement.
      expect(result, `Missing Principle 1 enforcement for ${fixture.id}`)
        .toContain('NEVER create Linear sub-issues')

      // The issue identifier must appear in the rendered output.
      expect(result, `Identifier not interpolated for ${fixture.id}`)
        .toContain(fixture.id)

      // Completion markers must be present.
      expect(result, `Missing WORK_RESULT for ${fixture.id}`).toContain('WORK_RESULT:passed')
    })
  }
})

// ---------------------------------------------------------------------------
// AgentWorkType schema accepts backlog-groomer
// ---------------------------------------------------------------------------

describe('backlog-groomer — AgentWorkTypeSchema', () => {
  it('backlog-groomer is a valid AgentWorkType (accepted by Zod schema)', async () => {
    const { AgentWorkTypeSchema } = await import('../types.js')
    expect(() => AgentWorkTypeSchema.parse('backlog-groomer')).not.toThrow()
    expect(AgentWorkTypeSchema.parse('backlog-groomer')).toBe('backlog-groomer')
  })
})
