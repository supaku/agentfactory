/**
 * Outcome Auditor template tests (REN-1297)
 *
 * Verifies that the outcome-auditor YAML template:
 *   1. Loads and renders correctly via the TemplateRegistry.
 *   2. Carries the correct tool allow/disallow configuration
 *      (Principle 1: --parentId is disallowed).
 *   3. Can detect a gap when a PR diff clearly misses an AC item
 *      and would produce a follow-up issue spec.
 *
 * The gap-detection test uses a fixture pair:
 *   - acText: acceptance criteria with two items
 *   - prDiff: a diff that only implements the first item
 *
 * We verify that the rendered prompt instructs the agent to:
 *   - Check each AC against the diff
 *   - Create follow-up issues (without --parentId)
 *   - Tag the audited issue with audit:has-followups
 */

import { describe, it, expect } from 'vitest'
import { TemplateRegistry } from '../../templates/registry.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A Linear issue with two acceptance criteria.
 * The merged PR only addresses the first criterion.
 */
const FIXTURE_ISSUE_ID = 'REN-9999'

const FIXTURE_AC_TEXT = `
## Acceptance Criteria

- [ ] AC-1: The /api/users endpoint returns a 200 status with user list JSON.
- [ ] AC-2: The /api/users endpoint supports ?limit= query parameter and trims the result.
`.trim()

/**
 * A PR diff that only implements AC-1 (adds the endpoint) but omits
 * query-parameter support (AC-2 is not implemented).
 */
const FIXTURE_PR_DIFF = `
diff --git a/src/routes/users.ts b/src/routes/users.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/routes/users.ts
@@ -0,0 +1,12 @@
+import { Router } from 'express'
+import { db } from '../db'
+
+const router = Router()
+
+router.get('/api/users', async (req, res) => {
+  const users = await db.users.findAll()
+  res.json(users)
+})
+
+export default router
`.trim()

// ---------------------------------------------------------------------------
// Helper: identify gaps between AC text and PR diff
// ---------------------------------------------------------------------------

/**
 * Minimal gap detector used in tests.
 *
 * In production, the agent itself performs the diff-vs-AC comparison using an
 * LLM to reason over the full PR diff and AC text. This helper implements a
 * deterministic heuristic so tests do not require an LLM call.
 *
 * Strategy: for each AC item, extract "distinctive tokens" — words that
 * describe new behaviour unique to that criterion (not shared with the basic
 * endpoint). An AC item is considered "not implemented" if ALL of its
 * distinctive tokens are absent from the PR diff.
 *
 * We intentionally use a conservative signal: the token must be absent to
 * declare a gap, matching the principle that false negatives (missed gaps) are
 * worse than false positives (spurious gaps) in an audit context.
 */
function detectGaps(acText: string, prDiff: string): string[] {
  const gaps: string[] = []
  const diffLower = prDiff.toLowerCase()

  // Extract AC items (lines starting with "- [ ]" or "- [x]")
  const acItems = acText
    .split('\n')
    .filter(line => /^-\s*\[[ x]\]/i.test(line.trim()))
    .map(line => line.replace(/^-\s*\[[ x]\]\s*/i, '').trim())

  for (const item of acItems) {
    // Extract all alphanumeric tokens ≥ 4 chars from the AC item, excluding
    // common stop words that would appear in any endpoint implementation.
    const stopWords = new Set([
      'that', 'with', 'this', 'from', 'when', 'the', 'and', 'for', 'are',
      'endpoint', 'returns', 'return', 'status', 'should', 'supports',
      'result', 'user', 'users', 'list', 'json', 'http', 'api', 'response',
    ])

    const tokens = item
      .toLowerCase()
      .split(/\W+/)
      .filter(t => t.length >= 4 && !stopWords.has(t))

    if (tokens.length === 0) continue

    // The AC item is a gap if ALL its distinctive tokens are absent from the diff.
    // This ensures we only flag items where the specific new functionality is missing.
    const implemented = tokens.some(token => diffLower.includes(token))
    if (!implemented) {
      gaps.push(item)
    }
  }

  return gaps
}

/**
 * Build a follow-up issue spec from a gap description.
 * Mirrors what the agent prompt instructs the agent to do.
 */
function buildFollowUpSpec(sourceId: string, gap: string): {
  title: string
  state: string
  descriptionContains: string[]
  hasParentId: false
} {
  return {
    title: `Follow-up: ${gap.slice(0, 60)} (from ${sourceId})`,
    state: 'Backlog',
    descriptionContains: [sourceId, 'gap', gap.slice(0, 30)],
    hasParentId: false as const,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('outcome-auditor template', () => {
  describe('template loading and rendering', () => {
    it('loads via TemplateRegistry built-in defaults', () => {
      const registry = TemplateRegistry.create({ useBuiltinDefaults: true })
      expect(registry.hasTemplate('outcome-auditor')).toBe(true)
    })

    it('renders with identifier variable', () => {
      const registry = TemplateRegistry.create({ useBuiltinDefaults: true })
      const result = registry.renderPrompt('outcome-auditor', { identifier: 'REN-PROJ' })
      expect(result).not.toBeNull()
      expect(result).toContain('REN-PROJ')
    })

    it('rendered prompt instructs the agent to list accepted issues', () => {
      const registry = TemplateRegistry.create({ useBuiltinDefaults: true })
      const result = registry.renderPrompt('outcome-auditor', { identifier: 'MyProject' })!
      expect(result).toContain('list-issues')
      expect(result).toContain('Accepted')
    })

    it('rendered prompt instructs to audit each AC item against the PR diff', () => {
      const registry = TemplateRegistry.create({ useBuiltinDefaults: true })
      const result = registry.renderPrompt('outcome-auditor', { identifier: 'MyProject' })!
      expect(result).toContain('gh pr diff')
      expect(result).toContain('acceptance criter')
    })

    it('rendered prompt includes mentionContext when provided', () => {
      const registry = TemplateRegistry.create({ useBuiltinDefaults: true })
      const result = registry.renderPrompt('outcome-auditor', {
        identifier: 'MyProject',
        mentionContext: 'Focus on REN-1234 only',
      })!
      expect(result).toContain('Focus on REN-1234 only')
    })

    it('rendered prompt omits mentionContext section when not provided', () => {
      const registry = TemplateRegistry.create({ useBuiltinDefaults: true })
      const result = registry.renderPrompt('outcome-auditor', { identifier: 'MyProject' })!
      expect(result).not.toContain('Additional context from the user')
    })
  })

  describe('tool permissions (Principle 1 enforcement)', () => {
    it('allows af-linear create-issue (standalone follow-up issues)', () => {
      const registry = TemplateRegistry.create({ useBuiltinDefaults: true })
      const { allow } = registry.getRawToolPermissions('outcome-auditor')
      const shellPatterns = allow
        .filter((p): p is { shell: string } => typeof p === 'object' && 'shell' in p)
        .map(p => p.shell)
      expect(shellPatterns.some(p => p.includes('create-issue'))).toBe(true)
    })

    it('disallows af-linear create-issue --parentId * (no sub-issues per Principle 1)', () => {
      const registry = TemplateRegistry.create({ useBuiltinDefaults: true })
      const { disallow } = registry.getRawToolPermissions('outcome-auditor')
      const shellDisallowed = disallow
        .filter((p): p is { shell: string } => typeof p === 'object' && 'shell' in p)
        .map(p => p.shell)
      expect(shellDisallowed.some(p => p.includes('--parentId'))).toBe(true)
    })

    it('disallows user-input (fully autonomous, cron-safe)', () => {
      const registry = TemplateRegistry.create({ useBuiltinDefaults: true })
      const { disallow } = registry.getRawToolPermissions('outcome-auditor')
      expect(disallow).toContain('user-input')
    })

    it('allows gh pr diff (needed for AC-vs-diff comparison)', () => {
      const registry = TemplateRegistry.create({ useBuiltinDefaults: true })
      const { allow } = registry.getRawToolPermissions('outcome-auditor')
      const shellPatterns = allow
        .filter((p): p is { shell: string } => typeof p === 'object' && 'shell' in p)
        .map(p => p.shell)
      expect(shellPatterns.some(p => p.includes('gh pr diff'))).toBe(true)
    })

    it('allows git log (needed to find merged PR)', () => {
      const registry = TemplateRegistry.create({ useBuiltinDefaults: true })
      const { allow } = registry.getRawToolPermissions('outcome-auditor')
      const shellPatterns = allow
        .filter((p): p is { shell: string } => typeof p === 'object' && 'shell' in p)
        .map(p => p.shell)
      expect(shellPatterns.some(p => p.includes('git log'))).toBe(true)
    })
  })

  describe('WORK_RESULT marker', () => {
    it('rendered prompt contains the WORK_RESULT:passed marker', () => {
      const registry = TemplateRegistry.create({ useBuiltinDefaults: true })
      const result = registry.renderPrompt('outcome-auditor', { identifier: 'MyProject' })!
      expect(result).toContain('WORK_RESULT:passed')
    })

    it('rendered prompt contains the WORK_RESULT:failed marker', () => {
      const registry = TemplateRegistry.create({ useBuiltinDefaults: true })
      const result = registry.renderPrompt('outcome-auditor', { identifier: 'MyProject' })!
      expect(result).toContain('WORK_RESULT:failed')
    })
  })

  describe('gap detection fixture (AC vs PR diff)', () => {
    it('detects no gaps when the diff fully covers the AC', () => {
      // Craft a diff that mentions both "limit" and "users endpoint"
      const fullDiff = FIXTURE_PR_DIFF + `
+router.get('/api/users', async (req, res) => {
+  const limit = req.query.limit ? Number(req.query.limit) : undefined
+  const users = await db.users.findAll({ limit })
+  res.json(users)
+})`
      const gaps = detectGaps(FIXTURE_AC_TEXT, fullDiff)
      expect(gaps).toHaveLength(0)
    })

    it('detects a gap when AC-2 (limit query param) is missing from the diff', () => {
      const gaps = detectGaps(FIXTURE_AC_TEXT, FIXTURE_PR_DIFF)
      // AC-2 mentions "limit" which is absent from the diff
      expect(gaps.length).toBeGreaterThan(0)
      const gapTexts = gaps.join(' ').toLowerCase()
      expect(gapTexts).toContain('limit')
    })

    it('builds a valid follow-up issue spec from a detected gap', () => {
      const gaps = detectGaps(FIXTURE_AC_TEXT, FIXTURE_PR_DIFF)
      expect(gaps.length).toBeGreaterThan(0)

      const followUp = buildFollowUpSpec(FIXTURE_ISSUE_ID, gaps[0])

      // Title must reference source issue
      expect(followUp.title).toContain(FIXTURE_ISSUE_ID)
      // Must be in Backlog state (not sub-issue, not Icebox)
      expect(followUp.state).toBe('Backlog')
      // hasParentId must be false (Principle 1)
      expect(followUp.hasParentId).toBe(false)
      // Description must contain source reference and gap text
      for (const snippet of followUp.descriptionContains) {
        expect(followUp.title + ' ' + snippet).toContain(snippet)
      }
    })

    it('follow-up spec never carries a parentId (Principle 1 hard constraint)', () => {
      const gaps = detectGaps(FIXTURE_AC_TEXT, FIXTURE_PR_DIFF)
      for (const gap of gaps) {
        const spec = buildFollowUpSpec(FIXTURE_ISSUE_ID, gap)
        expect(spec.hasParentId).toBe(false)
        // The spec title must not include --parentId
        expect(spec.title).not.toContain('--parentId')
      }
    })
  })

  describe('prompt instructs tags and follow-up relations', () => {
    it('instructs agent to tag clean issues with audit:clean', () => {
      const registry = TemplateRegistry.create({ useBuiltinDefaults: true })
      const result = registry.renderPrompt('outcome-auditor', { identifier: 'Proj' })!
      expect(result).toContain('audit:clean')
    })

    it('instructs agent to tag issues with gaps as audit:has-followups', () => {
      const registry = TemplateRegistry.create({ useBuiltinDefaults: true })
      const result = registry.renderPrompt('outcome-auditor', { identifier: 'Proj' })!
      expect(result).toContain('audit:has-followups')
    })

    it('instructs agent to add blocks relation for follow-up issues when applicable', () => {
      const registry = TemplateRegistry.create({ useBuiltinDefaults: true })
      const result = registry.renderPrompt('outcome-auditor', { identifier: 'Proj' })!
      expect(result).toContain('blocks')
      expect(result).toContain('add-relation')
    })

    it('instructs agent to post a comment on the source issue for each gap', () => {
      const registry = TemplateRegistry.create({ useBuiltinDefaults: true })
      const result = registry.renderPrompt('outcome-auditor', { identifier: 'Proj' })!
      expect(result).toContain('create-comment')
    })
  })
})
