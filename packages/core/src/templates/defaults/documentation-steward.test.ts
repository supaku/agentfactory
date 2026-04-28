/**
 * Documentation Steward Agent Tests — REN-1329
 *
 * Verifies that the documentation-steward template (012 Archetype 7):
 *   1. Loads and renders correctly through the TemplateRegistry.
 *   2. Contains the required doc-gap detection language (stale/undocumented/drift).
 *   3. Enforces Principle 1 (no sub-issue creation).
 *   4. Branches on the allowDirectCommits tenant policy flag.
 *   5. References Architectural Intelligence synthesize() for content questions.
 *   6. Completion contract matches expected shape (comment_posted required).
 *
 * "Stale doc fixture" test: exercises the template with representative
 * stale-doc scenarios and verifies the rendered prompt contains the correct
 * guidance for each scenario. No LLM is invoked — we verify the rendered prompt
 * instructs the model correctly.
 */

import { describe, it, expect } from 'vitest'
import { TemplateRegistry } from '../registry.js'
import { getCompletionContract } from '../../orchestrator/completion-contracts.js'
import type { TemplateContext } from '../types.js'

// ---------------------------------------------------------------------------
// Fixture: stale doc scenarios
// ---------------------------------------------------------------------------

/**
 * Each fixture represents a doc state fed into a steward invocation.
 * The rendered prompt must contain guidance that would lead the agent to
 * detect the described gap and take the right action.
 */
interface DocStaleFixture {
  id: string
  description: string
  /** The gap type the prompt must guide the agent to detect */
  expectedGapType: 'stale' | 'undocumented' | 'drift'
  /** Whether the fixture assumes allowDirectCommits is enabled */
  allowDirectCommits: boolean
  context: TemplateContext & { allowDirectCommits?: boolean }
}

const DOC_STALE_FIXTURES: DocStaleFixture[] = [
  {
    id: 'DS-FIX-01',
    description: 'README references a removed CLI command — stale doc',
    expectedGapType: 'stale',
    allowDirectCommits: false,
    context: {
      identifier: 'DS-FIX-01',
      mentionContext: 'README still references `pnpm af-legacy` which was removed in v3.',
    },
  },
  {
    id: 'DS-FIX-02',
    description: 'New exported function has no docs — undocumented surface',
    expectedGapType: 'undocumented',
    allowDirectCommits: false,
    context: {
      identifier: 'DS-FIX-02',
      mentionContext: 'exportPublicFunction() was added but has no JSDoc or README entry.',
    },
  },
  {
    id: 'DS-FIX-03',
    description: 'PR changed config schema but docs/config.md was not updated — doc drift',
    expectedGapType: 'drift',
    allowDirectCommits: false,
    context: {
      identifier: 'DS-FIX-03',
      mentionContext: 'PR #456 added new config keys but docs/config.md was not updated.',
    },
  },
  {
    id: 'DS-FIX-04',
    description: 'Typo in README — direct PR allowed (allowDirectCommits: true)',
    expectedGapType: 'stale',
    allowDirectCommits: true,
    context: {
      identifier: 'DS-FIX-04',
      allowDirectCommits: true,
      mentionContext: 'README has a typo in the installation section.',
    } as TemplateContext & { allowDirectCommits: boolean },
  },
  {
    id: 'DS-FIX-05',
    description: 'Architecture doc references deleted module — stale, no direct commit',
    expectedGapType: 'stale',
    allowDirectCommits: false,
    context: {
      identifier: 'DS-FIX-05',
      mentionContext: 'docs/architecture/seams.md references packages/legacy-seam which was deleted.',
    },
  },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal doc-gap detector.
 *
 * Given a list of symbols mentioned in docs and a set of symbols that exist
 * in the current codebase, returns the doc symbols that appear stale (not
 * present in the codebase).
 *
 * Used in tests without requiring an LLM call — mirrors what the agent would do.
 */
function detectStaleDocSymbols(
  docSymbols: string[],
  codebaseSymbols: string[]
): string[] {
  const codebaseLower = codebaseSymbols.map(s => s.toLowerCase())
  return docSymbols.filter(sym => !codebaseLower.includes(sym.toLowerCase()))
}

/**
 * Build a refinement issue spec for a documentation gap.
 * Mirrors what the prompt instructs the agent to produce.
 */
function buildDocRefinementSpec(
  issueId: string,
  gapType: 'stale' | 'undocumented' | 'drift',
  affectedDoc: string
): {
  title: string
  state: string
  hasParentId: false
} {
  return {
    title: `Docs: ${gapType} — ${affectedDoc} (from ${issueId})`,
    state: 'Backlog',
    hasParentId: false as const,
  }
}

function buildRegistry(): TemplateRegistry {
  return TemplateRegistry.create({ useBuiltinDefaults: true })
}

function render(
  registry: TemplateRegistry,
  context: TemplateContext & { allowDirectCommits?: boolean }
): string {
  const result = registry.renderPrompt('documentation-steward' as never, context)
  expect(result, 'documentation-steward template must be registered and renderable').not.toBeNull()
  return result as string
}

// ---------------------------------------------------------------------------
// Template presence
// ---------------------------------------------------------------------------

describe('documentation-steward template — registration', () => {
  it('is registered in the default TemplateRegistry', () => {
    const registry = buildRegistry()
    expect(registry.hasTemplate('documentation-steward' as never)).toBe(true)
  })

  it('appears in getRegisteredWorkTypes()', () => {
    const registry = buildRegistry()
    expect(registry.getRegisteredWorkTypes()).toContain('documentation-steward')
  })
})

// ---------------------------------------------------------------------------
// Template rendering — structure
// ---------------------------------------------------------------------------

describe('documentation-steward template — structure', () => {
  it('renders with a minimal context (identifier only)', () => {
    const registry = buildRegistry()
    const result = render(registry, { identifier: 'REN-1329' })
    expect(result).not.toBeNull()
    expect(result).toContain('REN-1329')
  })

  it('has a non-empty prompt', () => {
    const registry = buildRegistry()
    const template = registry.getTemplate('documentation-steward' as never)
    expect(template?.prompt.trim().length).toBeGreaterThan(100)
  })

  it('instructs agent to scan the docs directory', () => {
    const registry = buildRegistry()
    const result = render(registry, { identifier: 'REN-1329' })
    expect(result).toMatch(/\.md|docs|markdown/i)
  })

  it('instructs agent to cross-reference docs against codebase symbols', () => {
    const registry = buildRegistry()
    const result = render(registry, { identifier: 'REN-1329' })
    expect(result).toMatch(/search-symbols|search-code/i)
  })

  it('instructs agent to identify undocumented public surfaces', () => {
    const registry = buildRegistry()
    const result = render(registry, { identifier: 'REN-1329' })
    expect(result).toMatch(/undocumented|public surface/i)
  })

  it('instructs agent to check recent PRs for doc drift', () => {
    const registry = buildRegistry()
    const result = render(registry, { identifier: 'REN-1329' })
    expect(result).toMatch(/drift|recent.*PR|git log/i)
  })

  it('instructs agent to use synthesize() for content questions', () => {
    const registry = buildRegistry()
    const result = render(registry, { identifier: 'REN-1329' })
    expect(result).toMatch(/af-ai synthesize|synthesize/i)
  })

  it('prohibits sub-issue creation (Principle 1)', () => {
    const registry = buildRegistry()
    const result = render(registry, { identifier: 'REN-1329' })
    expect(result).toContain('NEVER create Linear sub-issues')
  })

  it('prohibits asking user for input (headless)', () => {
    const registry = buildRegistry()
    const result = render(registry, { identifier: 'REN-1329' })
    expect(result).toMatch(/do not ask the user for input|headless/i)
  })

  it('instructs agent to post a summary comment (DOC_STEWARD_REPORT marker)', () => {
    const registry = buildRegistry()
    const result = render(registry, { identifier: 'REN-1329' })
    expect(result).toContain('DOC_STEWARD_REPORT')
  })

  it('instructs agent to author standalone refinement issues (no --parentId)', () => {
    const registry = buildRegistry()
    const result = render(registry, { identifier: 'REN-1329' })
    expect(result).toMatch(/create-issue/i)
    expect(result).toMatch(/do not.*--parentId|MANDATORY.*--parentId|--parentId.*not/i)
  })

  it('contains WORK_RESULT:passed marker instruction', () => {
    const registry = buildRegistry()
    const result = render(registry, { identifier: 'REN-1329' })
    expect(result).toContain('WORK_RESULT:passed')
  })

  it('contains WORK_RESULT:failed marker instruction', () => {
    const registry = buildRegistry()
    const result = render(registry, { identifier: 'REN-1329' })
    expect(result).toContain('WORK_RESULT:failed')
  })

  it('injects mentionContext when provided', () => {
    const registry = buildRegistry()
    const result = render(registry, {
      identifier: 'REN-1329',
      mentionContext: 'Focus on docs/ directory only.',
    })
    expect(result).toContain('Focus on docs/ directory only.')
    expect(result).toContain('Additional context')
  })

  it('omits mentionContext section when not provided', () => {
    const registry = buildRegistry()
    const result = render(registry, { identifier: 'REN-1329' })
    expect(result).not.toContain('Additional context')
  })
})

// ---------------------------------------------------------------------------
// Tenant policy branching: allowDirectCommits
// ---------------------------------------------------------------------------

describe('documentation-steward template — tenant policy', () => {
  it('does NOT mention direct PRs when allowDirectCommits is false (default)', () => {
    const registry = buildRegistry()
    const result = render(registry, {
      identifier: 'REN-1329',
      // allowDirectCommits not set → default false
    })
    // The direct-commit section should not render
    expect(result).not.toMatch(/direct commits are enabled/i)
  })

  it('mentions direct PRs when allowDirectCommits is true', () => {
    const registry = buildRegistry()
    const result = render(registry, {
      identifier: 'REN-1329',
      allowDirectCommits: true,
    } as TemplateContext & { allowDirectCommits: boolean })
    expect(result).toMatch(/direct commits are ENABLED/i)
  })

  it('instructs gh pr create when allowDirectCommits is true', () => {
    const registry = buildRegistry()
    const result = render(registry, {
      identifier: 'REN-1329',
      allowDirectCommits: true,
    } as TemplateContext & { allowDirectCommits: boolean })
    expect(result).toContain('gh pr create')
  })

  it('restricts direct PRs to typo-class fixes when allowDirectCommits is true', () => {
    const registry = buildRegistry()
    const result = render(registry, {
      identifier: 'REN-1329',
      allowDirectCommits: true,
    } as TemplateContext & { allowDirectCommits: boolean })
    expect(result).toMatch(/typo|typo-class/i)
    expect(result).toMatch(/complex.*refinement issue|complex.*always/i)
  })
})

// ---------------------------------------------------------------------------
// Tool permissions
// ---------------------------------------------------------------------------

describe('documentation-steward template — tool permissions', () => {
  it('has allowed tool permissions defined', () => {
    const registry = buildRegistry()
    const perms = registry.getToolPermissions('documentation-steward' as never)
    expect(perms).toBeDefined()
    expect(perms!.length).toBeGreaterThan(0)
  })

  it('allows af-linear create-issue (standalone refinement issues)', () => {
    const registry = buildRegistry()
    const { allow } = registry.getRawToolPermissions('documentation-steward' as never)
    const shellPatterns = allow
      .filter((p): p is { shell: string } => typeof p === 'object' && 'shell' in p)
      .map(p => p.shell)
    expect(shellPatterns.some(p => p.includes('create-issue'))).toBe(true)
  })

  it('allows af-ai synthesize (pairs with Architectural Intelligence)', () => {
    const registry = buildRegistry()
    const { allow } = registry.getRawToolPermissions('documentation-steward' as never)
    const shellPatterns = allow
      .filter((p): p is { shell: string } => typeof p === 'object' && 'shell' in p)
      .map(p => p.shell)
    expect(shellPatterns.some(p => p.includes('af-ai synthesize'))).toBe(true)
  })

  it('allows gh pr create (needed for direct-PR path)', () => {
    const registry = buildRegistry()
    const { allow } = registry.getRawToolPermissions('documentation-steward' as never)
    const shellPatterns = allow
      .filter((p): p is { shell: string } => typeof p === 'object' && 'shell' in p)
      .map(p => p.shell)
    expect(shellPatterns.some(p => p.includes('gh pr create'))).toBe(true)
  })

  it('disallows user-input (fully autonomous, cron-safe)', () => {
    const registry = buildRegistry()
    const { disallow } = registry.getRawToolPermissions('documentation-steward' as never)
    expect(disallow).toContain('user-input')
  })

  it('disallows af-linear create-issue --parentId * (no sub-issues per Principle 1)', () => {
    const registry = buildRegistry()
    const { disallow } = registry.getRawToolPermissions('documentation-steward' as never)
    const shellDisallowed = disallow
      .filter((p): p is { shell: string } => typeof p === 'object' && 'shell' in p)
      .map(p => p.shell)
    expect(shellDisallowed.some(p => p.includes('--parentId'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Completion contract
// ---------------------------------------------------------------------------

describe('documentation-steward — completion contract', () => {
  it('has a completion contract defined', () => {
    const contract = getCompletionContract('documentation-steward' as never)
    expect(contract).toBeDefined()
    expect(contract!.workType).toBe('documentation-steward')
  })

  it('requires comment_posted (scan summary evidence)', () => {
    const contract = getCompletionContract('documentation-steward' as never)!
    const requiredTypes = contract.required.map(f => f.type)
    expect(requiredTypes).toContain('comment_posted')
  })

  it('does NOT require PR or commits in the required fields', () => {
    const contract = getCompletionContract('documentation-steward' as never)!
    const requiredTypes = contract.required.map(f => f.type)
    expect(requiredTypes).not.toContain('pr_url')
    expect(requiredTypes).not.toContain('commits_present')
    expect(requiredTypes).not.toContain('branch_pushed')
  })

  it('does NOT require sub_issues_created (Principle 1)', () => {
    const contract = getCompletionContract('documentation-steward' as never)!
    const allTypes = [
      ...contract.required.map(f => f.type),
      ...contract.optional.map(f => f.type),
    ]
    expect(allTypes).not.toContain('sub_issues_created')
  })

  it('has issue_updated as optional (source issue may be updated)', () => {
    const contract = getCompletionContract('documentation-steward' as never)!
    const optionalTypes = contract.optional.map(f => f.type)
    expect(optionalTypes).toContain('issue_updated')
  })
})

// ---------------------------------------------------------------------------
// Stale doc fixture — gap detection and issue spec generation
// ---------------------------------------------------------------------------

describe('documentation-steward — stale doc fixture (gap detection)', () => {
  // -------------------------------------------------------------------------
  // Unit tests for the detectStaleDocSymbols helper
  // -------------------------------------------------------------------------

  describe('detectStaleDocSymbols helper', () => {
    it('returns no stale symbols when all doc symbols exist in codebase', () => {
      const docSymbols = ['createAgent', 'runOrchestrator', 'AgentWorkType']
      const codebaseSymbols = ['createAgent', 'runOrchestrator', 'AgentWorkType', 'TemplateRegistry']
      const stale = detectStaleDocSymbols(docSymbols, codebaseSymbols)
      expect(stale).toHaveLength(0)
    })

    it('detects stale symbol when it no longer exists in codebase', () => {
      const docSymbols = ['createAgent', 'legacyBootstrap', 'AgentWorkType']
      const codebaseSymbols = ['createAgent', 'AgentWorkType']
      const stale = detectStaleDocSymbols(docSymbols, codebaseSymbols)
      expect(stale).toContain('legacyBootstrap')
      expect(stale).not.toContain('createAgent')
    })

    it('detects multiple stale symbols', () => {
      const docSymbols = ['removedA', 'removedB', 'existingC']
      const codebaseSymbols = ['existingC', 'newD']
      const stale = detectStaleDocSymbols(docSymbols, codebaseSymbols)
      expect(stale).toHaveLength(2)
      expect(stale).toContain('removedA')
      expect(stale).toContain('removedB')
    })

    it('is case-insensitive', () => {
      const docSymbols = ['CreateAgent']
      const codebaseSymbols = ['createAgent']
      const stale = detectStaleDocSymbols(docSymbols, codebaseSymbols)
      expect(stale).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // Unit tests for the buildDocRefinementSpec helper
  // -------------------------------------------------------------------------

  describe('buildDocRefinementSpec helper', () => {
    it('builds a valid stale refinement spec', () => {
      const spec = buildDocRefinementSpec('DS-001', 'stale', 'README.md')
      expect(spec.title).toContain('DS-001')
      expect(spec.title).toContain('stale')
      expect(spec.state).toBe('Backlog')
      expect(spec.hasParentId).toBe(false)
    })

    it('builds a valid undocumented refinement spec', () => {
      const spec = buildDocRefinementSpec('DS-002', 'undocumented', 'packages/core/src/index.ts')
      expect(spec.title).toContain('undocumented')
      expect(spec.hasParentId).toBe(false)
    })

    it('builds a valid drift refinement spec', () => {
      const spec = buildDocRefinementSpec('DS-003', 'drift', 'docs/config.md')
      expect(spec.title).toContain('drift')
      expect(spec.hasParentId).toBe(false)
    })

    it('refinement spec never carries a parentId (Principle 1 hard constraint)', () => {
      for (const gapType of ['stale', 'undocumented', 'drift'] as const) {
        const spec = buildDocRefinementSpec('DS-TEST', gapType, 'docs/test.md')
        expect(spec.hasParentId).toBe(false)
        expect(spec.title).not.toContain('--parentId')
      }
    })
  })

  // -------------------------------------------------------------------------
  // Fixture scenarios — rendered prompt must contain correct guidance
  // -------------------------------------------------------------------------

  const registry = buildRegistry()

  for (const fixture of DOC_STALE_FIXTURES) {
    it(`[${fixture.id}] ${fixture.description}`, () => {
      const result = render(registry, fixture.context)
      expect(result, `Template rendered null for ${fixture.id}`).not.toBeNull()

      // Identifier must be interpolated
      expect(result, `Identifier not interpolated for ${fixture.id}`)
        .toContain(fixture.id)

      // Prompt must contain guidance for the expected gap type
      if (fixture.expectedGapType === 'stale') {
        expect(result, `Missing stale-doc guidance for ${fixture.id}`)
          .toMatch(/stale|stale.*reference|removed.*API/i)
      } else if (fixture.expectedGapType === 'undocumented') {
        expect(result, `Missing undocumented-surface guidance for ${fixture.id}`)
          .toMatch(/undocumented|public surface/i)
      } else if (fixture.expectedGapType === 'drift') {
        expect(result, `Missing doc-drift guidance for ${fixture.id}`)
          .toMatch(/drift|PR.*doc|doc.*not updated/i)
      }

      // Principle 1 enforcement must always be present
      expect(result, `Missing Principle 1 enforcement for ${fixture.id}`)
        .toContain('NEVER create Linear sub-issues')

      // Completion markers must be present
      expect(result, `Missing WORK_RESULT for ${fixture.id}`)
        .toContain('WORK_RESULT:passed')

      // Direct-commit guidance must appear when allowDirectCommits is true
      if (fixture.allowDirectCommits) {
        expect(result, `Missing direct-commit guidance for ${fixture.id}`)
          .toMatch(/direct commits are ENABLED/i)
      }
    })
  }
})

// ---------------------------------------------------------------------------
// AgentWorkTypeSchema accepts documentation-steward
// ---------------------------------------------------------------------------

describe('documentation-steward — AgentWorkTypeSchema', () => {
  it('documentation-steward is a valid AgentWorkType (accepted by Zod schema)', async () => {
    const { AgentWorkTypeSchema } = await import('../types.js')
    expect(() => AgentWorkTypeSchema.parse('documentation-steward')).not.toThrow()
    expect(AgentWorkTypeSchema.parse('documentation-steward')).toBe('documentation-steward')
  })
})
