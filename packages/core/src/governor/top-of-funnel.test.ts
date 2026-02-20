import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  needsResearch,
  isReadyForBacklogCreation,
  isWellResearched,
  determineTopOfFunnelAction,
  DEFAULT_TOP_OF_FUNNEL_CONFIG,
  type IssueInfo,
  type TopOfFunnelConfig,
  type TopOfFunnelContext,
} from './top-of-funnel.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal IssueInfo with sensible defaults. */
function makeIssue(overrides: Partial<IssueInfo> = {}): IssueInfo {
  return {
    id: 'issue-1',
    identifier: 'SUP-100',
    title: 'Test Issue',
    description: undefined,
    status: 'Icebox',
    labels: [],
    createdAt: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago (past delay)
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

/** Default context where nothing blocks the action. */
function defaultContext(overrides: Partial<TopOfFunnelContext> = {}): TopOfFunnelContext {
  return {
    hasActiveSession: false,
    isHeld: false,
    researchCompleted: false,
    backlogCreationCompleted: false,
    isParentIssue: false,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// isWellResearched
// ---------------------------------------------------------------------------

describe('isWellResearched', () => {
  it('returns false for undefined description', () => {
    expect(isWellResearched(undefined)).toBe(false)
  })

  it('returns false for empty description', () => {
    expect(isWellResearched('')).toBe(false)
  })

  it('returns false for short description even with a header', () => {
    expect(isWellResearched('## Acceptance Criteria\nDone.')).toBe(false)
  })

  it('returns false for long description without structured headers', () => {
    const longNoHeaders = 'A'.repeat(300)
    expect(isWellResearched(longNoHeaders)).toBe(false)
  })

  it('returns true for description meeting both length and header criteria', () => {
    expect(isWellResearched(wellResearchedDescription())).toBe(true)
  })

  it('recognises all configured headers', () => {
    for (const header of DEFAULT_TOP_OF_FUNNEL_CONFIG.researchedHeaders) {
      const desc = `${header}\n${'x'.repeat(250)}`
      expect(isWellResearched(desc)).toBe(true)
    }
  })

  it('respects custom config with different length threshold', () => {
    const config: TopOfFunnelConfig = {
      ...DEFAULT_TOP_OF_FUNNEL_CONFIG,
      minResearchedDescriptionLength: 10,
    }
    // Short but has a header and meets reduced threshold
    expect(isWellResearched('## Summary\nShort text', config)).toBe(true)
  })

  it('respects custom config with different headers', () => {
    const config: TopOfFunnelConfig = {
      ...DEFAULT_TOP_OF_FUNNEL_CONFIG,
      researchedHeaders: ['## Custom Header'],
    }
    const desc = `## Custom Header\n${'x'.repeat(250)}`
    expect(isWellResearched(desc, config)).toBe(true)
    // Default headers should no longer match
    expect(isWellResearched(wellResearchedDescription(), config)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// needsResearch
// ---------------------------------------------------------------------------

describe('needsResearch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-06-01T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns false if issue is not in Icebox', () => {
    const issue = makeIssue({ status: 'Backlog' })
    expect(needsResearch(issue)).toBe(false)
  })

  it('returns false if issue has not been in Icebox long enough', () => {
    // Created 30 minutes ago — default delay is 1 hour
    const issue = makeIssue({ createdAt: Date.now() - 30 * 60 * 1000 })
    expect(needsResearch(issue)).toBe(false)
  })

  it('returns true for old Icebox issue with sparse description', () => {
    const issue = makeIssue({ description: sparseDescription() })
    expect(needsResearch(issue)).toBe(true)
  })

  it('returns true for old Icebox issue with no description', () => {
    const issue = makeIssue({ description: undefined })
    expect(needsResearch(issue)).toBe(true)
  })

  it('returns false for old Icebox issue with well-researched description', () => {
    const issue = makeIssue({ description: wellResearchedDescription() })
    expect(needsResearch(issue)).toBe(false)
  })

  it('returns true when issue has "Needs Research" label even with well-researched description', () => {
    const issue = makeIssue({
      description: wellResearchedDescription(),
      labels: ['Needs Research'],
    })
    expect(needsResearch(issue)).toBe(true)
  })

  it('returns false for parent issues (they use coordination)', () => {
    const issue = makeIssue({ parentId: 'parent-1', description: sparseDescription() })
    expect(needsResearch(issue)).toBe(false)
  })

  it('respects custom delay threshold', () => {
    const config: TopOfFunnelConfig = {
      ...DEFAULT_TOP_OF_FUNNEL_CONFIG,
      iceboxResearchDelayMs: 10 * 60 * 1000, // 10 minutes
    }
    // Created 15 minutes ago — should pass reduced threshold
    const issue = makeIssue({
      createdAt: Date.now() - 15 * 60 * 1000,
      description: sparseDescription(),
    })
    expect(needsResearch(issue, config)).toBe(true)
  })

  it('respects custom research request labels', () => {
    const config: TopOfFunnelConfig = {
      ...DEFAULT_TOP_OF_FUNNEL_CONFIG,
      researchRequestLabels: ['Research Me'],
    }
    const issue = makeIssue({
      description: wellResearchedDescription(),
      labels: ['Research Me'],
    })
    expect(needsResearch(issue, config)).toBe(true)

    // Default label should NOT trigger with custom config
    const issueDefault = makeIssue({
      description: wellResearchedDescription(),
      labels: ['Needs Research'],
    })
    expect(needsResearch(issueDefault, config)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isReadyForBacklogCreation
// ---------------------------------------------------------------------------

describe('isReadyForBacklogCreation', () => {
  it('returns false if issue is not in Icebox', () => {
    const issue = makeIssue({
      status: 'Backlog',
      description: wellResearchedDescription(),
    })
    expect(isReadyForBacklogCreation(issue)).toBe(false)
  })

  it('returns false for sparse description', () => {
    const issue = makeIssue({ description: sparseDescription() })
    expect(isReadyForBacklogCreation(issue)).toBe(false)
  })

  it('returns true for well-researched Icebox issue', () => {
    const issue = makeIssue({ description: wellResearchedDescription() })
    expect(isReadyForBacklogCreation(issue)).toBe(true)
  })

  it('returns false for parent issues', () => {
    const issue = makeIssue({
      parentId: 'parent-1',
      description: wellResearchedDescription(),
    })
    expect(isReadyForBacklogCreation(issue)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// determineTopOfFunnelAction
// ---------------------------------------------------------------------------

describe('determineTopOfFunnelAction', () => {
  const config = DEFAULT_TOP_OF_FUNNEL_CONFIG

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-06-01T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // -- Guard rails --

  it('returns none when issue is not in Icebox', () => {
    const issue = makeIssue({ status: 'Backlog' })
    const action = determineTopOfFunnelAction(issue, config, defaultContext())
    expect(action.type).toBe('none')
    expect(action.reason).toContain('not in Icebox')
  })

  it('returns none when issue has an active session', () => {
    const issue = makeIssue()
    const action = determineTopOfFunnelAction(
      issue,
      config,
      defaultContext({ hasActiveSession: true }),
    )
    expect(action.type).toBe('none')
    expect(action.reason).toContain('active agent session')
  })

  it('returns none when issue is held', () => {
    const issue = makeIssue()
    const action = determineTopOfFunnelAction(
      issue,
      config,
      defaultContext({ isHeld: true }),
    )
    expect(action.type).toBe('none')
    expect(action.reason).toContain('held')
  })

  it('returns none for parent/coordinator issues', () => {
    const issue = makeIssue()
    const action = determineTopOfFunnelAction(
      issue,
      config,
      defaultContext({ isParentIssue: true }),
    )
    expect(action.type).toBe('none')
    expect(action.reason).toContain('coordination')
  })

  // -- Research triggers --

  it('triggers research for sparse description after delay', () => {
    const issue = makeIssue({ description: sparseDescription() })
    const action = determineTopOfFunnelAction(issue, config, defaultContext())
    expect(action.type).toBe('trigger-research')
    expect(action.reason).toContain('lacks sufficient detail')
  })

  it('triggers research when research label is present', () => {
    const issue = makeIssue({
      description: wellResearchedDescription(),
      labels: ['Needs Research'],
    })
    const action = determineTopOfFunnelAction(issue, config, defaultContext())
    expect(action.type).toBe('trigger-research')
    expect(action.reason).toContain('research-request label')
  })

  it('returns none when research is needed but delay not met', () => {
    const issue = makeIssue({
      description: sparseDescription(),
      createdAt: Date.now() - 30 * 60 * 1000, // 30 min
    })
    const action = determineTopOfFunnelAction(issue, config, defaultContext())
    expect(action.type).toBe('none')
    expect(action.reason).toContain('not been in Icebox long enough')
  })

  it('skips research when research already completed', () => {
    const issue = makeIssue({ description: sparseDescription() })
    const action = determineTopOfFunnelAction(
      issue,
      config,
      defaultContext({ researchCompleted: true }),
    )
    // Research completed but description still sparse — should not trigger
    // backlog creation either because description is not well-researched
    expect(action.type).toBe('none')
  })

  // -- Backlog-creation triggers --

  it('triggers backlog creation for well-researched issue', () => {
    const issue = makeIssue({ description: wellResearchedDescription() })
    const action = determineTopOfFunnelAction(issue, config, defaultContext())
    expect(action.type).toBe('trigger-backlog-creation')
    expect(action.reason).toContain('ready for backlog creation')
  })

  it('triggers backlog creation when research completed and description is now rich', () => {
    const issue = makeIssue({ description: wellResearchedDescription() })
    const action = determineTopOfFunnelAction(
      issue,
      config,
      defaultContext({ researchCompleted: true }),
    )
    expect(action.type).toBe('trigger-backlog-creation')
  })

  it('skips backlog creation when already completed', () => {
    const issue = makeIssue({ description: wellResearchedDescription() })
    const action = determineTopOfFunnelAction(
      issue,
      config,
      defaultContext({ backlogCreationCompleted: true }),
    )
    expect(action.type).toBe('none')
    expect(action.reason).toContain('already completed')
  })

  it('returns none when both phases completed', () => {
    const issue = makeIssue({ description: wellResearchedDescription() })
    const action = determineTopOfFunnelAction(
      issue,
      config,
      defaultContext({ researchCompleted: true, backlogCreationCompleted: true }),
    )
    expect(action.type).toBe('none')
    expect(action.reason).toContain('already completed')
  })

  // -- Disabled flags --

  it('skips research when enableAutoResearch is false', () => {
    const disabledConfig: TopOfFunnelConfig = {
      ...config,
      enableAutoResearch: false,
    }
    const issue = makeIssue({ description: sparseDescription() })
    const action = determineTopOfFunnelAction(
      issue,
      disabledConfig,
      defaultContext(),
    )
    expect(action.type).toBe('none')
    expect(action.reason).toContain('not well-researched')
  })

  it('skips backlog creation when enableAutoBacklogCreation is false', () => {
    const disabledConfig: TopOfFunnelConfig = {
      ...config,
      enableAutoBacklogCreation: false,
    }
    const issue = makeIssue({ description: wellResearchedDescription() })
    const action = determineTopOfFunnelAction(
      issue,
      disabledConfig,
      defaultContext(),
    )
    expect(action.type).toBe('none')
    expect(action.reason).toContain('disabled')
  })

  it('still triggers research even when backlog creation is disabled', () => {
    const disabledConfig: TopOfFunnelConfig = {
      ...config,
      enableAutoBacklogCreation: false,
    }
    const issue = makeIssue({ description: sparseDescription() })
    const action = determineTopOfFunnelAction(
      issue,
      disabledConfig,
      defaultContext(),
    )
    expect(action.type).toBe('trigger-research')
  })

  // -- Config override combos --

  it('respects a custom iceboxResearchDelayMs', () => {
    const customConfig: TopOfFunnelConfig = {
      ...config,
      iceboxResearchDelayMs: 5 * 60 * 1000, // 5 minutes
    }
    const issue = makeIssue({
      description: sparseDescription(),
      createdAt: Date.now() - 10 * 60 * 1000, // 10 min
    })
    const action = determineTopOfFunnelAction(
      issue,
      customConfig,
      defaultContext(),
    )
    expect(action.type).toBe('trigger-research')
  })
})
