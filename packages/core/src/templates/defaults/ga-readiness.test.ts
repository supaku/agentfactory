/**
 * GA-Readiness Assessor template tests (REN-1327)
 *
 * Verifies that the ga-readiness YAML template:
 *   1. Loads and renders correctly via the TemplateRegistry.
 *   2. Carries the correct tool allow/disallow configuration
 *      (Principle 1: --parentId is disallowed).
 *   3. Instructs the agent to consume Architectural Intelligence assess() output.
 *   4. Instructs the agent to check observability hooks.
 *   5. Includes a placeholder for the future security-review check (010).
 *   6. Produces a structured GA-readiness report comment (not a new issue).
 *   7. Authors standalone blocker issues using add-relation (not --parentId).
 *
 * The Architectural Intelligence assess() invocation is NOT run during tests.
 * We verify only that the rendered prompt instructs the model to consume the
 * assess output — no actual AI call is made.
 */

import { describe, it, expect } from 'vitest'
import { TemplateRegistry } from '../../templates/registry.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a registry with built-in defaults and render the ga-readiness prompt.
 */
function buildRegistry(): TemplateRegistry {
  return TemplateRegistry.create({ useBuiltinDefaults: true })
}

function render(registry: TemplateRegistry, extras: Record<string, unknown> = {}): string {
  const result = registry.renderPrompt('ga-readiness' as never, {
    identifier: 'REN-FEAT',
    ...extras,
  })
  expect(result, 'ga-readiness template must be registered and renderable').not.toBeNull()
  return result as string
}

// ---------------------------------------------------------------------------
// AC coverage gap detector (mirrors outcome-auditor's pattern for tests)
// ---------------------------------------------------------------------------

/**
 * Minimal GA-readiness gap detector.
 *
 * Given a list of AC items and a set of "implemented" tokens found in merged
 * PRs for that feature, returns the AC items that appear unimplemented.
 * Used in tests without requiring an LLM call.
 */
function detectGaGaps(
  acItems: string[],
  implementedTokens: string[]
): string[] {
  const implementedLower = implementedTokens.map(t => t.toLowerCase())
  const stopWords = new Set([
    'that', 'with', 'this', 'from', 'when', 'the', 'and', 'for', 'are',
    'should', 'must', 'returns', 'return', 'status', 'supports', 'result',
    'feature', 'issue', 'issues',
  ])

  return acItems.filter(item => {
    const tokens = item
      .toLowerCase()
      .split(/\W+/)
      .filter(t => t.length >= 4 && !stopWords.has(t))

    if (tokens.length === 0) return false

    // Gap if NO distinctive token appears in the implemented set
    return !tokens.some(token => implementedLower.some(impl => impl.includes(token)))
  })
}

/**
 * Build a blocker issue spec from a GA gap. Mirrors what the prompt instructs.
 */
function buildBlockerSpec(featureEpicId: string, gap: string): {
  title: string
  state: string
  relationType: string
  hasParentId: false
} {
  return {
    title: `GA-Blocker: ${gap.slice(0, 60)} (from ${featureEpicId})`,
    state: 'Backlog',
    relationType: 'blocks',
    hasParentId: false as const,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ga-readiness template (REN-1327)', () => {
  // -------------------------------------------------------------------------
  // 1. Template loading and rendering
  // -------------------------------------------------------------------------
  describe('template loading and rendering', () => {
    it('loads via TemplateRegistry built-in defaults', () => {
      const registry = buildRegistry()
      expect(registry.hasTemplate('ga-readiness' as never)).toBe(true)
    })

    it('renders with identifier variable', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toContain('REN-FEAT')
    })

    it('rendered prompt instructs the agent to list accepted issues', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toContain('list-issues')
      expect(result).toContain('Accepted')
    })

    it('rendered prompt includes mentionContext when provided', () => {
      const registry = buildRegistry()
      const result = render(registry, { mentionContext: 'Focus on REN-9876 only' })
      expect(result).toContain('Focus on REN-9876 only')
    })

    it('rendered prompt omits mentionContext section when not provided', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).not.toContain('Additional context from the user')
    })

    it('has a non-empty prompt', () => {
      const registry = buildRegistry()
      const template = registry.getTemplate('ga-readiness' as never)
      expect(template?.prompt.trim().length).toBeGreaterThan(100)
    })
  })

  // -------------------------------------------------------------------------
  // 2. Tool permissions (Principle 1 enforcement)
  // -------------------------------------------------------------------------
  describe('tool permissions (Principle 1 enforcement)', () => {
    it('allows af-linear create-issue (standalone blocker issues)', () => {
      const registry = buildRegistry()
      const { allow } = registry.getRawToolPermissions('ga-readiness' as never)
      const shellPatterns = allow
        .filter((p): p is { shell: string } => typeof p === 'object' && 'shell' in p)
        .map(p => p.shell)
      expect(shellPatterns.some(p => p.includes('create-issue'))).toBe(true)
    })

    it('disallows af-linear create-issue --parentId * (no sub-issues per Principle 1)', () => {
      const registry = buildRegistry()
      const { disallow } = registry.getRawToolPermissions('ga-readiness' as never)
      const shellDisallowed = disallow
        .filter((p): p is { shell: string } => typeof p === 'object' && 'shell' in p)
        .map(p => p.shell)
      expect(shellDisallowed.some(p => p.includes('--parentId'))).toBe(true)
    })

    it('disallows user-input (fully autonomous, cron-safe)', () => {
      const registry = buildRegistry()
      const { disallow } = registry.getRawToolPermissions('ga-readiness' as never)
      expect(disallow).toContain('user-input')
    })

    it('allows af-linear add-relation (needed for blocker relations)', () => {
      const registry = buildRegistry()
      const { allow } = registry.getRawToolPermissions('ga-readiness' as never)
      const shellPatterns = allow
        .filter((p): p is { shell: string } => typeof p === 'object' && 'shell' in p)
        .map(p => p.shell)
      expect(shellPatterns.some(p => p.includes('add-relation'))).toBe(true)
    })

    it('allows af-linear create-comment (needed for GA report comment)', () => {
      const registry = buildRegistry()
      const { allow } = registry.getRawToolPermissions('ga-readiness' as never)
      const shellPatterns = allow
        .filter((p): p is { shell: string } => typeof p === 'object' && 'shell' in p)
        .map(p => p.shell)
      expect(shellPatterns.some(p => p.includes('create-comment'))).toBe(true)
    })

    it('allows af-ai assess (needed for Architectural Intelligence drift check)', () => {
      const registry = buildRegistry()
      const { allow } = registry.getRawToolPermissions('ga-readiness' as never)
      const shellPatterns = allow
        .filter((p): p is { shell: string } => typeof p === 'object' && 'shell' in p)
        .map(p => p.shell)
      expect(shellPatterns.some(p => p.includes('af-ai assess'))).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // 3. Architectural Intelligence consumption
  // -------------------------------------------------------------------------
  describe('Architectural Intelligence drift check', () => {
    it('prompt instructs agent to call assess for drift detection', () => {
      const registry = buildRegistry()
      const result = render(registry)
      // The prompt must reference assess() usage
      expect(result).toMatch(/assess/i)
    })

    it('prompt references hasCriticalDrift from assess output', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toContain('hasCriticalDrift')
    })

    it('prompt instructs to create a blocker issue if hasCriticalDrift is true', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toMatch(/architectural drift/i)
      expect(result).toMatch(/create.*blocker|blocker.*create/i)
    })

    it('prompt includes graceful skip if assess is not available', () => {
      const registry = buildRegistry()
      const result = render(registry)
      // Should mention fallback/skip when assess is not available
      expect(result).toMatch(/not yet available|skip|if assess/i)
    })
  })

  // -------------------------------------------------------------------------
  // 4. Observability check
  // -------------------------------------------------------------------------
  describe('observability hooks check', () => {
    it('prompt instructs agent to check for observability instrumentation', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toMatch(/observabil/i)
    })

    it('prompt references HookBus or equivalent hook mechanism', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toMatch(/HookBus|hookBus|hook.*emit/i)
    })

    it('prompt instructs to create a blocker issue if observability is missing', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toContain('Missing observability')
    })
  })

  // -------------------------------------------------------------------------
  // 5. Security review placeholder (010)
  // -------------------------------------------------------------------------
  describe('security review status (010 placeholder)', () => {
    it('prompt includes security review placeholder section', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toMatch(/security review/i)
    })

    it('prompt mentions 010-security-architecture or equivalent as future gate', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toMatch(/010|security-architecture/i)
    })

    it('prompt instructs to skip security check gracefully until 010 lands', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toMatch(/pending|skip.*gracefully|not yet landed/i)
    })
  })

  // -------------------------------------------------------------------------
  // 6. Structured GA-readiness report as a COMMENT (not a new issue)
  // -------------------------------------------------------------------------
  describe('GA-readiness report output', () => {
    it('prompt instructs to produce report as a comment on the feature epic', () => {
      const registry = buildRegistry()
      const result = render(registry)
      // Must use create-comment, NOT create-issue for the report
      expect(result).toContain('create-comment')
      expect(result).toContain('GA-Readiness Report')
    })

    it('prompt report includes AC coverage section', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toMatch(/AC Coverage/i)
    })

    it('prompt report includes Architectural Intelligence drift section', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toMatch(/Architectural Intelligence Drift/i)
    })

    it('prompt report includes Observability section', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toMatch(/Observability/i)
    })

    it('prompt report includes Security Review section', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toMatch(/Security Review/i)
    })

    it('prompt includes GA_READINESS_REPORT structured marker', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toContain('GA_READINESS_REPORT')
    })
  })

  // -------------------------------------------------------------------------
  // 7. WORK_RESULT markers
  // -------------------------------------------------------------------------
  describe('WORK_RESULT marker', () => {
    it('rendered prompt contains WORK_RESULT:passed marker', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toContain('WORK_RESULT:passed')
    })

    it('rendered prompt contains WORK_RESULT:failed marker', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toContain('WORK_RESULT:failed')
    })
  })

  // -------------------------------------------------------------------------
  // 8. Blocker issue pattern (add-relation, NOT --parentId)
  // -------------------------------------------------------------------------
  describe('blocker issues use add-relation (Principle 1)', () => {
    it('prompt instructs to use add-relation blocks for blocker issues', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toContain('add-relation')
      expect(result).toContain('blocks')
    })

    it('prompt explicitly says NOT to use --parentId', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toMatch(/not.*--parentId|--parentId.*not|do not.*--parentId/i)
    })
  })

  // -------------------------------------------------------------------------
  // 9. Gap detection fixture (unit test for test helper — no LLM needed)
  // -------------------------------------------------------------------------
  describe('GA gap detection fixture', () => {
    const FEATURE_ID = 'REN-FEAT'

    const AC_ITEMS = [
      'The feature exposes a /api/ga-check endpoint returning 200 with structured JSON.',
      'The feature emits observability metrics via HookBus on every request.',
      'The feature supports pagination via a ?cursor= query parameter.',
    ]

    it('detects no gaps when all AC tokens are in implemented set', () => {
      const implementedTokens = ['endpoint', 'metrics', 'hookbus', 'pagination', 'cursor', 'structured', 'exposes']
      const gaps = detectGaGaps(AC_ITEMS, implementedTokens)
      expect(gaps).toHaveLength(0)
    })

    it('detects a gap when pagination is absent from implemented tokens', () => {
      const implementedTokens = ['endpoint', 'metrics', 'hookbus', 'structured', 'exposes']
      const gaps = detectGaGaps(AC_ITEMS, implementedTokens)
      expect(gaps.length).toBeGreaterThan(0)
      expect(gaps.join(' ').toLowerCase()).toContain('cursor')
    })

    it('builds a valid blocker spec from a detected GA gap', () => {
      const implementedTokens = ['endpoint', 'metrics', 'structured']
      const gaps = detectGaGaps(AC_ITEMS, implementedTokens)
      expect(gaps.length).toBeGreaterThan(0)

      const blocker = buildBlockerSpec(FEATURE_ID, gaps[0])

      // Title must reference the feature epic
      expect(blocker.title).toContain(FEATURE_ID)
      // Must start with GA-Blocker prefix
      expect(blocker.title).toMatch(/^GA-Blocker/)
      // Must be Backlog state (standalone, not sub-issue)
      expect(blocker.state).toBe('Backlog')
      // Relation type must be blocks
      expect(blocker.relationType).toBe('blocks')
      // Must NOT carry a parentId (Principle 1)
      expect(blocker.hasParentId).toBe(false)
    })

    it('blocker spec never carries a parentId (Principle 1 hard constraint)', () => {
      const implementedTokens: string[] = []
      const gaps = detectGaGaps(AC_ITEMS, implementedTokens)

      for (const gap of gaps) {
        const spec = buildBlockerSpec(FEATURE_ID, gap)
        expect(spec.hasParentId).toBe(false)
        expect(spec.title).not.toContain('--parentId')
      }
    })
  })
})
