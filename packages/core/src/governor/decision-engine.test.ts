import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { decideAction, type DecisionContext } from './decision-engine.js'
import type { GovernorConfig, GovernorIssue } from './governor-types.js'
import { DEFAULT_GOVERNOR_CONFIG } from './governor-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal GovernorIssue with sensible defaults. */
function makeIssue(overrides: Partial<GovernorIssue> = {}): GovernorIssue {
  return {
    id: 'issue-1',
    identifier: 'SUP-100',
    title: 'Test Issue',
    description: undefined,
    status: 'Backlog',
    labels: [],
    createdAt: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago
    ...overrides,
  }
}

/** Build a well-researched description (long + structured header). */
function wellResearchedDescription(): string {
  return (
    '## Acceptance Criteria\n' +
    '- The system should handle X\n' +
    '- The system should handle Y\n' +
    '\n' +
    '## Technical Approach\n' +
    'We will implement this by modifying the governor module to add top-of-funnel ' +
    'triggers that automatically research issues in the Icebox. This approach ' +
    'ensures issues are enriched before entering the active backlog.'
  )
}

/** Build a sparse description (too short / no headers). */
function sparseDescription(): string {
  return 'Fix the thing.'
}

/** Build a default DecisionContext for testing. */
function makeContext(overrides: Partial<DecisionContext> = {}): DecisionContext {
  return {
    issue: makeIssue(),
    config: { ...DEFAULT_GOVERNOR_CONFIG, projects: ['TestProject'] },
    hasActiveSession: false,
    isHeld: false,
    isWithinCooldown: false,
    isParentIssue: false,
    workflowStrategy: undefined,
    researchCompleted: false,
    backlogCreationCompleted: false,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Universal skip conditions
// ---------------------------------------------------------------------------

describe('decideAction — universal skip conditions', () => {
  it('returns none when issue has an active session', () => {
    const ctx = makeContext({ hasActiveSession: true })
    const result = decideAction(ctx)
    expect(result.action).toBe('none')
    expect(result.reason).toContain('active agent session')
  })

  it('returns none when issue is within cooldown', () => {
    const ctx = makeContext({ isWithinCooldown: true })
    const result = decideAction(ctx)
    expect(result.action).toBe('none')
    expect(result.reason).toContain('cooldown')
  })

  it('returns none when issue is held', () => {
    const ctx = makeContext({ isHeld: true })
    const result = decideAction(ctx)
    expect(result.action).toBe('none')
    expect(result.reason).toContain('HOLD')
  })

  it('evaluates skip conditions in order: active session before cooldown', () => {
    const ctx = makeContext({ hasActiveSession: true, isWithinCooldown: true, isHeld: true })
    const result = decideAction(ctx)
    expect(result.reason).toContain('active agent session')
  })

  it('evaluates skip conditions in order: cooldown before hold', () => {
    const ctx = makeContext({ isWithinCooldown: true, isHeld: true })
    const result = decideAction(ctx)
    expect(result.reason).toContain('cooldown')
  })
})

// ---------------------------------------------------------------------------
// Terminal statuses
// ---------------------------------------------------------------------------

describe('decideAction — terminal statuses', () => {
  it('returns none for Accepted status', () => {
    const ctx = makeContext({ issue: makeIssue({ status: 'Accepted' }) })
    const result = decideAction(ctx)
    expect(result.action).toBe('none')
    expect(result.reason).toContain('terminal status')
    expect(result.reason).toContain('Accepted')
  })

  it('returns none for Canceled status', () => {
    const ctx = makeContext({ issue: makeIssue({ status: 'Canceled' }) })
    const result = decideAction(ctx)
    expect(result.action).toBe('none')
    expect(result.reason).toContain('terminal status')
  })

  it('returns none for Duplicate status', () => {
    const ctx = makeContext({ issue: makeIssue({ status: 'Duplicate' }) })
    const result = decideAction(ctx)
    expect(result.action).toBe('none')
    expect(result.reason).toContain('terminal status')
  })
})

// ---------------------------------------------------------------------------
// Icebox (top-of-funnel delegation)
// ---------------------------------------------------------------------------

describe('decideAction — Icebox (top-of-funnel)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-06-01T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('triggers research for sparse Icebox issue', () => {
    const ctx = makeContext({
      issue: makeIssue({
        status: 'Icebox',
        description: sparseDescription(),
        createdAt: Date.now() - 2 * 60 * 60 * 1000,
      }),
    })
    const result = decideAction(ctx)
    expect(result.action).toBe('trigger-research')
  })

  it('triggers backlog-creation for well-researched Icebox issue', () => {
    const ctx = makeContext({
      issue: makeIssue({
        status: 'Icebox',
        description: wellResearchedDescription(),
        createdAt: Date.now() - 2 * 60 * 60 * 1000,
      }),
    })
    const result = decideAction(ctx)
    expect(result.action).toBe('trigger-backlog-creation')
  })

  it('returns none for Icebox parent issue', () => {
    const ctx = makeContext({
      issue: makeIssue({
        status: 'Icebox',
        description: sparseDescription(),
        createdAt: Date.now() - 2 * 60 * 60 * 1000,
      }),
      isParentIssue: true,
    })
    const result = decideAction(ctx)
    expect(result.action).toBe('none')
    expect(result.reason).toContain('coordination')
  })

  it('returns none when auto-research is disabled and description is sparse', () => {
    const ctx = makeContext({
      issue: makeIssue({
        status: 'Icebox',
        description: sparseDescription(),
        createdAt: Date.now() - 2 * 60 * 60 * 1000,
      }),
      config: {
        ...DEFAULT_GOVERNOR_CONFIG,
        projects: ['TestProject'],
        enableAutoResearch: false,
      },
    })
    const result = decideAction(ctx)
    expect(result.action).toBe('none')
  })

  it('returns none when auto-backlog-creation is disabled', () => {
    const ctx = makeContext({
      issue: makeIssue({
        status: 'Icebox',
        description: wellResearchedDescription(),
        createdAt: Date.now() - 2 * 60 * 60 * 1000,
      }),
      config: {
        ...DEFAULT_GOVERNOR_CONFIG,
        projects: ['TestProject'],
        enableAutoBacklogCreation: false,
      },
    })
    const result = decideAction(ctx)
    expect(result.action).toBe('none')
  })

  it('skips research when research already completed', () => {
    const ctx = makeContext({
      issue: makeIssue({
        status: 'Icebox',
        description: sparseDescription(),
        createdAt: Date.now() - 2 * 60 * 60 * 1000,
      }),
      researchCompleted: true,
    })
    const result = decideAction(ctx)
    // Research completed but description still sparse -- none
    expect(result.action).toBe('none')
  })

  it('returns none for Icebox issue created too recently', () => {
    const ctx = makeContext({
      issue: makeIssue({
        status: 'Icebox',
        description: sparseDescription(),
        createdAt: Date.now() - 10 * 60 * 1000, // 10 minutes ago
      }),
    })
    const result = decideAction(ctx)
    expect(result.action).toBe('none')
    expect(result.reason).toContain('not been in Icebox long enough')
  })

  it('respects topOfFunnel config overrides', () => {
    const ctx = makeContext({
      issue: makeIssue({
        status: 'Icebox',
        description: sparseDescription(),
        createdAt: Date.now() - 10 * 60 * 1000, // 10 minutes ago
      }),
      config: {
        ...DEFAULT_GOVERNOR_CONFIG,
        projects: ['TestProject'],
        topOfFunnel: {
          iceboxResearchDelayMs: 5 * 60 * 1000, // 5 minutes
        },
      },
    })
    const result = decideAction(ctx)
    expect(result.action).toBe('trigger-research')
  })
})

// ---------------------------------------------------------------------------
// Backlog (development)
// ---------------------------------------------------------------------------

describe('decideAction — Backlog', () => {
  it('triggers development for Backlog issue', () => {
    const ctx = makeContext({
      issue: makeIssue({ status: 'Backlog' }),
    })
    const result = decideAction(ctx)
    expect(result.action).toBe('trigger-development')
    expect(result.reason).toContain('triggering development')
  })

  it('triggers development for parent Backlog issue (coordination)', () => {
    const ctx = makeContext({
      issue: makeIssue({ status: 'Backlog' }),
      isParentIssue: true,
    })
    const result = decideAction(ctx)
    expect(result.action).toBe('trigger-development')
    expect(result.reason).toContain('coordination')
  })

  it('returns none when auto-development is disabled', () => {
    const ctx = makeContext({
      issue: makeIssue({ status: 'Backlog' }),
      config: {
        ...DEFAULT_GOVERNOR_CONFIG,
        projects: ['TestProject'],
        enableAutoDevelopment: false,
      },
    })
    const result = decideAction(ctx)
    expect(result.action).toBe('none')
    expect(result.reason).toContain('disabled')
  })
})

// ---------------------------------------------------------------------------
// Started
// ---------------------------------------------------------------------------

describe('decideAction — Started', () => {
  it('returns none for Started status (agent already working)', () => {
    const ctx = makeContext({
      issue: makeIssue({ status: 'Started' }),
    })
    const result = decideAction(ctx)
    expect(result.action).toBe('none')
    expect(result.reason).toContain('Started')
  })
})

// ---------------------------------------------------------------------------
// Finished (QA)
// ---------------------------------------------------------------------------

describe('decideAction — Finished (QA)', () => {
  it('triggers QA for Finished issue', () => {
    const ctx = makeContext({
      issue: makeIssue({ status: 'Finished' }),
    })
    const result = decideAction(ctx)
    expect(result.action).toBe('trigger-qa')
    expect(result.reason).toContain('triggering QA')
  })

  it('returns none when auto-QA is disabled', () => {
    const ctx = makeContext({
      issue: makeIssue({ status: 'Finished' }),
      config: {
        ...DEFAULT_GOVERNOR_CONFIG,
        projects: ['TestProject'],
        enableAutoQA: false,
      },
    })
    const result = decideAction(ctx)
    expect(result.action).toBe('none')
    expect(result.reason).toContain('disabled')
  })

  it('escalates to human when strategy is escalate-human', () => {
    const ctx = makeContext({
      issue: makeIssue({ status: 'Finished' }),
      workflowStrategy: 'escalate-human',
    })
    const result = decideAction(ctx)
    expect(result.action).toBe('escalate-human')
    expect(result.reason).toContain('human review')
  })

  it('triggers decompose when strategy is decompose', () => {
    const ctx = makeContext({
      issue: makeIssue({ status: 'Finished' }),
      workflowStrategy: 'decompose',
    })
    const result = decideAction(ctx)
    expect(result.action).toBe('decompose')
    expect(result.reason).toContain('decomposition')
  })

  it('triggers normal QA when strategy is normal', () => {
    const ctx = makeContext({
      issue: makeIssue({ status: 'Finished' }),
      workflowStrategy: 'normal',
    })
    const result = decideAction(ctx)
    expect(result.action).toBe('trigger-qa')
  })

  it('triggers normal QA when strategy is context-enriched', () => {
    const ctx = makeContext({
      issue: makeIssue({ status: 'Finished' }),
      workflowStrategy: 'context-enriched',
    })
    const result = decideAction(ctx)
    expect(result.action).toBe('trigger-qa')
  })
})

// ---------------------------------------------------------------------------
// Delivered (acceptance)
// ---------------------------------------------------------------------------

describe('decideAction — Delivered (acceptance)', () => {
  it('triggers acceptance for Delivered issue', () => {
    const ctx = makeContext({
      issue: makeIssue({ status: 'Delivered' }),
    })
    const result = decideAction(ctx)
    expect(result.action).toBe('trigger-acceptance')
    expect(result.reason).toContain('triggering acceptance')
  })

  it('returns none when auto-acceptance is disabled', () => {
    const ctx = makeContext({
      issue: makeIssue({ status: 'Delivered' }),
      config: {
        ...DEFAULT_GOVERNOR_CONFIG,
        projects: ['TestProject'],
        enableAutoAcceptance: false,
      },
    })
    const result = decideAction(ctx)
    expect(result.action).toBe('none')
    expect(result.reason).toContain('disabled')
  })
})

// ---------------------------------------------------------------------------
// Rejected (refinement)
// ---------------------------------------------------------------------------

describe('decideAction — Rejected (refinement)', () => {
  it('triggers refinement for Rejected issue', () => {
    const ctx = makeContext({
      issue: makeIssue({ status: 'Rejected' }),
    })
    const result = decideAction(ctx)
    expect(result.action).toBe('trigger-refinement')
    expect(result.reason).toContain('triggering refinement')
  })

  it('escalates to human when strategy is escalate-human', () => {
    const ctx = makeContext({
      issue: makeIssue({ status: 'Rejected' }),
      workflowStrategy: 'escalate-human',
    })
    const result = decideAction(ctx)
    expect(result.action).toBe('escalate-human')
    expect(result.reason).toContain('human intervention')
  })

  it('triggers decompose when strategy is decompose', () => {
    const ctx = makeContext({
      issue: makeIssue({ status: 'Rejected' }),
      workflowStrategy: 'decompose',
    })
    const result = decideAction(ctx)
    expect(result.action).toBe('decompose')
    expect(result.reason).toContain('decomposition')
  })

  it('triggers normal refinement when strategy is normal', () => {
    const ctx = makeContext({
      issue: makeIssue({ status: 'Rejected' }),
      workflowStrategy: 'normal',
    })
    const result = decideAction(ctx)
    expect(result.action).toBe('trigger-refinement')
  })

  it('triggers normal refinement when strategy is context-enriched', () => {
    const ctx = makeContext({
      issue: makeIssue({ status: 'Rejected' }),
      workflowStrategy: 'context-enriched',
    })
    const result = decideAction(ctx)
    expect(result.action).toBe('trigger-refinement')
  })
})

// ---------------------------------------------------------------------------
// Unknown status
// ---------------------------------------------------------------------------

describe('decideAction — unknown status', () => {
  it('returns none for unrecognized status', () => {
    const ctx = makeContext({
      issue: makeIssue({ status: 'CustomStatus' }),
    })
    const result = decideAction(ctx)
    expect(result.action).toBe('none')
    expect(result.reason).toContain('unrecognized status')
    expect(result.reason).toContain('CustomStatus')
  })
})

// ---------------------------------------------------------------------------
// Config enable/disable flags across statuses
// ---------------------------------------------------------------------------

describe('decideAction — config flags integration', () => {
  it('disabling all flags causes all non-terminal statuses to return none', () => {
    const config: GovernorConfig = {
      ...DEFAULT_GOVERNOR_CONFIG,
      projects: ['TestProject'],
      enableAutoResearch: false,
      enableAutoBacklogCreation: false,
      enableAutoDevelopment: false,
      enableAutoQA: false,
      enableAutoAcceptance: false,
    }

    const statuses = ['Backlog', 'Finished', 'Delivered']
    for (const status of statuses) {
      const ctx = makeContext({
        issue: makeIssue({ status }),
        config,
      })
      const result = decideAction(ctx)
      expect(result.action).toBe('none')
    }
  })

  it('Rejected issues always trigger refinement (no disable flag)', () => {
    const config: GovernorConfig = {
      ...DEFAULT_GOVERNOR_CONFIG,
      projects: ['TestProject'],
      enableAutoResearch: false,
      enableAutoBacklogCreation: false,
      enableAutoDevelopment: false,
      enableAutoQA: false,
      enableAutoAcceptance: false,
    }
    const ctx = makeContext({
      issue: makeIssue({ status: 'Rejected' }),
      config,
    })
    const result = decideAction(ctx)
    expect(result.action).toBe('trigger-refinement')
  })
})

// ---------------------------------------------------------------------------
// Parent issue handling
// ---------------------------------------------------------------------------

describe('decideAction — parent issue handling', () => {
  it('parent Backlog issue triggers development (coordination template)', () => {
    const ctx = makeContext({
      issue: makeIssue({ status: 'Backlog' }),
      isParentIssue: true,
    })
    const result = decideAction(ctx)
    expect(result.action).toBe('trigger-development')
    expect(result.reason).toContain('Parent issue')
    expect(result.reason).toContain('coordination')
  })

  it('parent Icebox issue returns none (coordination, no top-of-funnel)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-06-01T12:00:00Z'))

    const ctx = makeContext({
      issue: makeIssue({
        status: 'Icebox',
        description: sparseDescription(),
        createdAt: Date.now() - 2 * 60 * 60 * 1000,
      }),
      isParentIssue: true,
    })
    const result = decideAction(ctx)
    expect(result.action).toBe('none')

    vi.useRealTimers()
  })

  it('parent Finished issue triggers QA normally', () => {
    const ctx = makeContext({
      issue: makeIssue({ status: 'Finished' }),
      isParentIssue: true,
    })
    const result = decideAction(ctx)
    expect(result.action).toBe('trigger-qa')
  })

  it('parent Delivered issue triggers acceptance normally', () => {
    const ctx = makeContext({
      issue: makeIssue({ status: 'Delivered' }),
      isParentIssue: true,
    })
    const result = decideAction(ctx)
    expect(result.action).toBe('trigger-acceptance')
  })
})

// ---------------------------------------------------------------------------
// Escalation strategy effects across statuses
// ---------------------------------------------------------------------------

describe('decideAction — escalation strategy effects', () => {
  it('escalate-human on Finished yields escalate-human', () => {
    const ctx = makeContext({
      issue: makeIssue({ status: 'Finished' }),
      workflowStrategy: 'escalate-human',
    })
    expect(decideAction(ctx).action).toBe('escalate-human')
  })

  it('escalate-human on Rejected yields escalate-human', () => {
    const ctx = makeContext({
      issue: makeIssue({ status: 'Rejected' }),
      workflowStrategy: 'escalate-human',
    })
    expect(decideAction(ctx).action).toBe('escalate-human')
  })

  it('decompose on Finished yields decompose', () => {
    const ctx = makeContext({
      issue: makeIssue({ status: 'Finished' }),
      workflowStrategy: 'decompose',
    })
    expect(decideAction(ctx).action).toBe('decompose')
  })

  it('decompose on Rejected yields decompose', () => {
    const ctx = makeContext({
      issue: makeIssue({ status: 'Rejected' }),
      workflowStrategy: 'decompose',
    })
    expect(decideAction(ctx).action).toBe('decompose')
  })

  it('escalate-human on Backlog has no effect (Backlog uses enableAutoDevelopment)', () => {
    const ctx = makeContext({
      issue: makeIssue({ status: 'Backlog' }),
      workflowStrategy: 'escalate-human',
    })
    expect(decideAction(ctx).action).toBe('trigger-development')
  })

  it('escalate-human on Delivered has no effect (Delivered uses enableAutoAcceptance)', () => {
    const ctx = makeContext({
      issue: makeIssue({ status: 'Delivered' }),
      workflowStrategy: 'escalate-human',
    })
    expect(decideAction(ctx).action).toBe('trigger-acceptance')
  })
})
