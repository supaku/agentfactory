/**
 * Operational Scanner — Audit template tests (REN-1328)
 *
 * Verifies that the operational-scanner-audit YAML template:
 *   1. Loads and renders correctly via the TemplateRegistry.
 *   2. Carries the correct tool allow/disallow configuration
 *      (Principle 1: --parentId is disallowed).
 *   3. Instructs the agent to detect audit-chain anomalies per 006 Seam 6:
 *      missing entries, broken chains, unexpected actors, out-of-order events.
 *   4. Instructs the agent to dedupe against existing issues before authoring.
 *   5. Instructs to tag issues with source:audit and provenance.
 *
 * All tests are fixture-driven; no LLM calls are made.
 */

import { describe, it, expect } from 'vitest'
import { TemplateRegistry } from '../../templates/registry.js'

// ---------------------------------------------------------------------------
// Fixtures — mock audit chain events (006 Seam 6)
// ---------------------------------------------------------------------------

/** An audit chain event fixture. */
interface AuditEvent {
  eventId: string
  chainId: string
  actor: string
  eventType: string
  sequenceNumber: number
  timestamp: string
}

/** Fixture: a chain with a sequence gap (3 → 5, missing 4). */
const FIXTURE_BROKEN_CHAIN: AuditEvent[] = [
  { eventId: 'evt_001', chainId: 'chain_A', actor: 'system', eventType: 'state_transition', sequenceNumber: 1, timestamp: '2026-04-26T10:00:00Z' },
  { eventId: 'evt_002', chainId: 'chain_A', actor: 'system', eventType: 'issue_updated', sequenceNumber: 2, timestamp: '2026-04-26T10:01:00Z' },
  { eventId: 'evt_003', chainId: 'chain_A', actor: 'system', eventType: 'state_transition', sequenceNumber: 3, timestamp: '2026-04-26T10:02:00Z' },
  // Sequence number 4 is missing — broken chain
  { eventId: 'evt_005', chainId: 'chain_A', actor: 'system', eventType: 'comment_posted', sequenceNumber: 5, timestamp: '2026-04-26T10:04:00Z' },
]

/** Fixture: an event attributed to an unexpected actor (haiku creating a sub-issue). */
const FIXTURE_UNEXPECTED_ACTOR: AuditEvent = {
  eventId: 'evt_bad_001',
  chainId: 'chain_B',
  actor: 'agent:haiku:session-xyz',
  eventType: 'create_issue_with_parentId',
  sequenceNumber: 1,
  timestamp: '2026-04-26T11:00:00Z',
}

/** Fixture: out-of-order events (timestamp precedes earlier sequence number). */
const FIXTURE_OUT_OF_ORDER: AuditEvent[] = [
  { eventId: 'evt_100', chainId: 'chain_C', actor: 'system', eventType: 'state_transition', sequenceNumber: 1, timestamp: '2026-04-26T12:00:00Z' },
  // seq=2 has a timestamp earlier than seq=1 — clock skew / replay signal
  { eventId: 'evt_101', chainId: 'chain_C', actor: 'system', eventType: 'issue_updated', sequenceNumber: 2, timestamp: '2026-04-26T11:59:00Z' },
]

// ---------------------------------------------------------------------------
// Helpers — minimal audit anomaly detectors
// ---------------------------------------------------------------------------

type AuditAnomalyType = 'broken-chain' | 'unexpected-actor' | 'out-of-order'

interface AuditAnomaly {
  type: AuditAnomalyType
  chainId: string
  description: string
}

/**
 * Detect sequence gaps in an audit chain.
 */
function detectBrokenChains(events: AuditEvent[]): AuditAnomaly[] {
  const chainMap = new Map<string, number[]>()
  for (const ev of events) {
    const seqs = chainMap.get(ev.chainId) ?? []
    seqs.push(ev.sequenceNumber)
    chainMap.set(ev.chainId, seqs)
  }

  const anomalies: AuditAnomaly[] = []
  for (const [chainId, seqs] of chainMap.entries()) {
    const sorted = [...seqs].sort((a, b) => a - b)
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] !== sorted[i - 1] + 1) {
        anomalies.push({
          type: 'broken-chain',
          chainId,
          description: `Gap between sequence ${sorted[i - 1]} and ${sorted[i]}`,
        })
      }
    }
  }
  return anomalies
}

/**
 * Detect events attributed to unexpected actors.
 * Here "unexpected" means an agent actor performing a create_issue_with_parentId event.
 */
function detectUnexpectedActors(events: AuditEvent[]): AuditAnomaly[] {
  return events
    .filter(ev =>
      ev.actor.startsWith('agent:') &&
      ev.eventType === 'create_issue_with_parentId'
    )
    .map(ev => ({
      type: 'unexpected-actor' as const,
      chainId: ev.chainId,
      description: `Actor ${ev.actor} performed forbidden event ${ev.eventType}`,
    }))
}

/**
 * Detect out-of-order events (timestamp decreases while sequence increases).
 */
function detectOutOfOrder(events: AuditEvent[]): AuditAnomaly[] {
  const chainMap = new Map<string, AuditEvent[]>()
  for (const ev of events) {
    const evs = chainMap.get(ev.chainId) ?? []
    evs.push(ev)
    chainMap.set(ev.chainId, evs)
  }

  const anomalies: AuditAnomaly[] = []
  for (const [chainId, evs] of chainMap.entries()) {
    const sorted = [...evs].sort((a, b) => a.sequenceNumber - b.sequenceNumber)
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].timestamp < sorted[i - 1].timestamp) {
        anomalies.push({
          type: 'out-of-order',
          chainId,
          description: `seq ${sorted[i].sequenceNumber} has timestamp before seq ${sorted[i - 1].sequenceNumber}`,
        })
      }
    }
  }
  return anomalies
}

/**
 * Build a bug-report issue spec from an audit anomaly.
 * Mirrors what the agent prompt instructs — no --parentId.
 */
function buildAuditBugSpec(anomaly: AuditAnomaly, scanRunId: string): {
  title: string
  state: string
  labels: string[]
  hasParentId: false
} {
  return {
    title: `Audit anomaly: ${anomaly.type} in ${anomaly.chainId}`,
    state: 'Backlog',
    labels: ['bug', 'source:audit', `provenance:scan-${scanRunId}`],
    hasParentId: false as const,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRegistry(): TemplateRegistry {
  return TemplateRegistry.create({ useBuiltinDefaults: true })
}

function render(registry: TemplateRegistry, extras: Record<string, unknown> = {}): string {
  const result = registry.renderPrompt('operational-scanner-audit' as never, {
    identifier: 'REN-SCAN-AUDIT',
    ...extras,
  })
  expect(result, 'operational-scanner-audit template must be registered and renderable').not.toBeNull()
  return result as string
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('operational-scanner-audit template (REN-1328)', () => {
  // -------------------------------------------------------------------------
  // 1. Template loading and rendering
  // -------------------------------------------------------------------------
  describe('template loading and rendering', () => {
    it('loads via TemplateRegistry built-in defaults', () => {
      const registry = buildRegistry()
      expect(registry.hasTemplate('operational-scanner-audit' as never)).toBe(true)
    })

    it('renders with identifier variable', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toContain('REN-SCAN-AUDIT')
    })

    it('has a non-empty prompt', () => {
      const registry = buildRegistry()
      const template = registry.getTemplate('operational-scanner-audit' as never)
      expect(template?.prompt.trim().length).toBeGreaterThan(100)
    })

    it('rendered prompt includes mentionContext when provided', () => {
      const registry = buildRegistry()
      const result = render(registry, { mentionContext: 'Focus on production chains' })
      expect(result).toContain('Focus on production chains')
    })

    it('rendered prompt omits mentionContext section when not provided', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).not.toContain('Additional context from the user')
    })
  })

  // -------------------------------------------------------------------------
  // 2. Tool permissions (Principle 1 enforcement)
  // -------------------------------------------------------------------------
  describe('tool permissions (Principle 1 enforcement)', () => {
    it('allows af-linear create-issue (standalone bug-report issues)', () => {
      const registry = buildRegistry()
      const { allow } = registry.getRawToolPermissions('operational-scanner-audit' as never)
      const shellPatterns = allow
        .filter((p): p is { shell: string } => typeof p === 'object' && 'shell' in p)
        .map(p => p.shell)
      expect(shellPatterns.some(p => p.includes('create-issue'))).toBe(true)
    })

    it('disallows af-linear create-issue --parentId * (no sub-issues per Principle 1)', () => {
      const registry = buildRegistry()
      const { disallow } = registry.getRawToolPermissions('operational-scanner-audit' as never)
      const shellDisallowed = disallow
        .filter((p): p is { shell: string } => typeof p === 'object' && 'shell' in p)
        .map(p => p.shell)
      expect(shellDisallowed.some(p => p.includes('--parentId'))).toBe(true)
    })

    it('disallows user-input (fully autonomous, cron-safe)', () => {
      const registry = buildRegistry()
      const { disallow } = registry.getRawToolPermissions('operational-scanner-audit' as never)
      expect(disallow).toContain('user-input')
    })

    it('allows af-linear list-issues (needed for dedupe check)', () => {
      const registry = buildRegistry()
      const { allow } = registry.getRawToolPermissions('operational-scanner-audit' as never)
      const shellPatterns = allow
        .filter((p): p is { shell: string } => typeof p === 'object' && 'shell' in p)
        .map(p => p.shell)
      expect(shellPatterns.some(p => p.includes('list-issues'))).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // 3. Anomaly types — prompt coverage
  // -------------------------------------------------------------------------
  describe('anomaly types covered in prompt', () => {
    it('prompt references 006 Seam 6 or audit chain architecture', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toMatch(/006|Seam 6|seam.*6|audit.*chain/i)
    })

    it('prompt references missing chain entries', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toMatch(/missing.*entr|broken.*chain|sequence.*gap/i)
    })

    it('prompt references unexpected actors', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toMatch(/unexpected.*actor|actor.*permission|forbidden/i)
    })

    it('prompt references out-of-order events', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toMatch(/out.of.order|clock skew|replay/i)
    })
  })

  // -------------------------------------------------------------------------
  // 4. Dedupe instruction
  // -------------------------------------------------------------------------
  describe('dedupe against existing issues', () => {
    it('prompt instructs agent to search Linear for existing issues before creating', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toContain('list-issues')
      expect(result).toMatch(/source:audit|audit.*chain.*id/i)
    })

    it('prompt instructs agent to comment (not create) when duplicate found', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toContain('create-comment')
      expect(result).toMatch(/duplicate|already.*exist|existing issue/i)
    })
  })

  // -------------------------------------------------------------------------
  // 5. Provenance tags
  // -------------------------------------------------------------------------
  describe('provenance tagging', () => {
    it('prompt instructs to tag issues with source:audit', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toContain('source:audit')
    })

    it('prompt instructs to tag issues with provenance:scan-', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toContain('provenance:scan-')
    })
  })

  // -------------------------------------------------------------------------
  // 6. WORK_RESULT markers
  // -------------------------------------------------------------------------
  describe('WORK_RESULT markers', () => {
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
  // 7. Fixture-driven anomaly detection tests (no LLM needed)
  // -------------------------------------------------------------------------
  describe('audit fixture: broken-chain detection', () => {
    it('detects sequence gap (3 → 5, missing 4) as a broken chain', () => {
      const anomalies = detectBrokenChains(FIXTURE_BROKEN_CHAIN)
      expect(anomalies).toHaveLength(1)
      expect(anomalies[0].type).toBe('broken-chain')
      expect(anomalies[0].chainId).toBe('chain_A')
      expect(anomalies[0].description).toContain('3')
      expect(anomalies[0].description).toContain('5')
    })

    it('does not flag a chain with no sequence gaps', () => {
      const intact: AuditEvent[] = [
        { eventId: 'e1', chainId: 'chain_OK', actor: 'system', eventType: 'start', sequenceNumber: 1, timestamp: '2026-04-26T10:00:00Z' },
        { eventId: 'e2', chainId: 'chain_OK', actor: 'system', eventType: 'end', sequenceNumber: 2, timestamp: '2026-04-26T10:01:00Z' },
      ]
      const anomalies = detectBrokenChains(intact)
      expect(anomalies).toHaveLength(0)
    })
  })

  describe('audit fixture: unexpected-actor detection', () => {
    it('flags an agent actor performing create_issue_with_parentId (Principle 1 violation)', () => {
      const anomalies = detectUnexpectedActors([FIXTURE_UNEXPECTED_ACTOR])
      expect(anomalies).toHaveLength(1)
      expect(anomalies[0].type).toBe('unexpected-actor')
      expect(anomalies[0].description).toContain('haiku')
      expect(anomalies[0].description).toContain('create_issue_with_parentId')
    })

    it('does not flag system actors (system is allowed to perform state transitions)', () => {
      const systemEvent: AuditEvent = {
        ...FIXTURE_UNEXPECTED_ACTOR,
        actor: 'system',
        eventType: 'state_transition',
      }
      const anomalies = detectUnexpectedActors([systemEvent])
      expect(anomalies).toHaveLength(0)
    })
  })

  describe('audit fixture: out-of-order detection', () => {
    it('detects out-of-order events when timestamp decreases while sequence increases', () => {
      const anomalies = detectOutOfOrder(FIXTURE_OUT_OF_ORDER)
      expect(anomalies).toHaveLength(1)
      expect(anomalies[0].type).toBe('out-of-order')
      expect(anomalies[0].chainId).toBe('chain_C')
    })

    it('does not flag correctly ordered events', () => {
      const ordered: AuditEvent[] = [
        { eventId: 'e1', chainId: 'chain_D', actor: 'system', eventType: 'start', sequenceNumber: 1, timestamp: '2026-04-26T10:00:00Z' },
        { eventId: 'e2', chainId: 'chain_D', actor: 'system', eventType: 'end', sequenceNumber: 2, timestamp: '2026-04-26T10:01:00Z' },
      ]
      const anomalies = detectOutOfOrder(ordered)
      expect(anomalies).toHaveLength(0)
    })
  })

  describe('audit fixture: bug-report issue spec', () => {
    it('builds a valid bug-report spec from a broken-chain anomaly', () => {
      const anomalies = detectBrokenChains(FIXTURE_BROKEN_CHAIN)
      expect(anomalies.length).toBeGreaterThan(0)

      const spec = buildAuditBugSpec(anomalies[0], 'REN-SCAN-AUDIT')

      expect(spec.state).toBe('Backlog')
      expect(spec.labels).toContain('bug')
      expect(spec.labels).toContain('source:audit')
      expect(spec.labels.some(l => l.startsWith('provenance:scan-'))).toBe(true)
      expect(spec.hasParentId).toBe(false)
    })

    it('bug-report spec never carries a parentId (Principle 1 hard constraint)', () => {
      const allAnomalies = [
        ...detectBrokenChains(FIXTURE_BROKEN_CHAIN),
        ...detectUnexpectedActors([FIXTURE_UNEXPECTED_ACTOR]),
        ...detectOutOfOrder(FIXTURE_OUT_OF_ORDER),
      ]
      for (const anomaly of allAnomalies) {
        const spec = buildAuditBugSpec(anomaly, 'REN-SCAN-AUDIT')
        expect(spec.hasParentId).toBe(false)
        expect(spec.title).not.toContain('--parentId')
      }
    })
  })
})
