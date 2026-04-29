/**
 * Tests for resume-from-journal (REN-1398).
 *
 * Pure-data tests over `computeResumeMarker` + an integration test that
 * mocks `listSessionJournal`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./journal.js', () => ({
  listSessionJournal: vi.fn(async () => []),
}))

import { listSessionJournal, type JournalEntry } from './journal.js'
import {
  computeResumeMarker,
  filterUnfinishedSteps,
  resumeSessionFromJournal,
} from './session-resume.js'

beforeEach(() => {
  vi.clearAllMocks()
})

function entry(over: Partial<JournalEntry>): JournalEntry {
  return {
    sessionId: 'sess-1',
    stepId: 'step-x',
    status: 'completed',
    inputHash: 'h',
    outputCAS: 'cas',
    startedAt: 0,
    completedAt: 0,
    attempt: 0,
    ...over,
  }
}

describe('computeResumeMarker', () => {
  it('returns an empty marker for a fresh session', () => {
    const marker = computeResumeMarker('sess-1', [])
    expect(marker).toEqual({
      sessionId: 'sess-1',
      inflightStepIds: [],
      failedStepIds: [],
      totalEntries: 0,
    })
  })

  it('returns the latest completedAt as the lastCompletedStepId', () => {
    const entries: JournalEntry[] = [
      entry({ stepId: 'step-1', status: 'completed', completedAt: 100 }),
      entry({ stepId: 'step-2', status: 'completed', completedAt: 300 }),
      entry({ stepId: 'step-3', status: 'completed', completedAt: 200 }),
    ]
    const marker = computeResumeMarker('sess-1', entries)
    expect(marker.lastCompletedStepId).toBe('step-2')
    expect(marker.lastCompletedAt).toBe(300)
    expect(marker.totalEntries).toBe(3)
  })

  it('captures running entries as in-flight (worker crash candidates)', () => {
    const entries: JournalEntry[] = [
      entry({ stepId: 'step-1', status: 'completed', completedAt: 100 }),
      entry({ stepId: 'step-2', status: 'running', completedAt: 0 }),
    ]
    const marker = computeResumeMarker('sess-1', entries)
    expect(marker.lastCompletedStepId).toBe('step-1')
    expect(marker.inflightStepIds).toEqual(['step-2'])
  })

  it('captures failed entries separately from in-flight', () => {
    const entries: JournalEntry[] = [
      entry({ stepId: 'step-1', status: 'failed', error: 'boom' }),
      entry({ stepId: 'step-2', status: 'completed', completedAt: 200 }),
    ]
    const marker = computeResumeMarker('sess-1', entries)
    expect(marker.failedStepIds).toEqual(['step-1'])
    expect(marker.lastCompletedStepId).toBe('step-2')
  })

  it('breaks ties on completedAt by preferring lexically larger stepId', () => {
    const entries: JournalEntry[] = [
      entry({ stepId: 'a', status: 'completed', completedAt: 100 }),
      entry({ stepId: 'b', status: 'completed', completedAt: 100 }),
    ]
    const marker = computeResumeMarker('sess-1', entries)
    expect(marker.lastCompletedStepId).toBe('b')
  })
})

describe('resumeSessionFromJournal (integration with listSessionJournal)', () => {
  it('reads journal entries and produces a marker', async () => {
    vi.mocked(listSessionJournal).mockResolvedValueOnce([
      entry({ stepId: 'step-1', status: 'completed', completedAt: 50 }),
      entry({ stepId: 'step-2', status: 'completed', completedAt: 150 }),
    ])
    const marker = await resumeSessionFromJournal('sess-1')
    expect(marker.lastCompletedStepId).toBe('step-2')
    expect(marker.totalEntries).toBe(2)
  })

  it('returns a fresh-session marker for unknown sessions', async () => {
    vi.mocked(listSessionJournal).mockResolvedValueOnce([])
    const marker = await resumeSessionFromJournal('sess-fresh')
    expect(marker.totalEntries).toBe(0)
    expect(marker.lastCompletedStepId).toBeUndefined()
  })
})

describe('filterUnfinishedSteps', () => {
  it('returns the input list when no steps are completed', () => {
    const marker = computeResumeMarker('s', [])
    expect(filterUnfinishedSteps(marker, ['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('returns only steps after the last completed step', () => {
    const marker = computeResumeMarker('s', [
      entry({ stepId: 'a', status: 'completed', completedAt: 1 }),
      entry({ stepId: 'b', status: 'completed', completedAt: 2 }),
    ])
    expect(filterUnfinishedSteps(marker, ['a', 'b', 'c', 'd'])).toEqual(['c', 'd'])
  })

  it('returns the full list when last completed step is not in nextSteps', () => {
    const marker = computeResumeMarker('s', [
      entry({ stepId: 'unknown', status: 'completed', completedAt: 1 }),
    ])
    expect(filterUnfinishedSteps(marker, ['a', 'b'])).toEqual(['a', 'b'])
  })
})
