import { describe, it, expect, beforeEach } from 'vitest'
import {
  InMemoryProcessingStateStorage,
  type ProcessingStateStorage,
  type ProcessingPhase,
} from './processing-state.js'

// ---------------------------------------------------------------------------
// ProcessingStateStorage interface contract tests
// ---------------------------------------------------------------------------
// These tests exercise the interface through the InMemoryProcessingStateStorage
// implementation but validate the contract that any implementation must honour.

describe('ProcessingStateStorage (InMemoryProcessingStateStorage)', () => {
  let storage: ProcessingStateStorage & InMemoryProcessingStateStorage

  beforeEach(() => {
    storage = new InMemoryProcessingStateStorage()
  })

  // -- isPhaseCompleted --

  it('returns false for a phase that has not been completed', async () => {
    const completed = await storage.isPhaseCompleted('issue-1', 'research')
    expect(completed).toBe(false)
  })

  it('returns true after marking a phase as completed', async () => {
    await storage.markPhaseCompleted('issue-1', 'research')
    const completed = await storage.isPhaseCompleted('issue-1', 'research')
    expect(completed).toBe(true)
  })

  // -- markPhaseCompleted --

  it('records a phase completion with optional sessionId', async () => {
    await storage.markPhaseCompleted('issue-1', 'research', 'session-abc')
    const record = await storage.getPhaseRecord('issue-1', 'research')
    expect(record).not.toBeNull()
    expect(record!.issueId).toBe('issue-1')
    expect(record!.phase).toBe('research')
    expect(record!.sessionId).toBe('session-abc')
    expect(record!.completedAt).toBeGreaterThan(0)
  })

  it('is idempotent — re-marking overwrites the record', async () => {
    await storage.markPhaseCompleted('issue-1', 'research', 'session-1')
    const first = await storage.getPhaseRecord('issue-1', 'research')

    await storage.markPhaseCompleted('issue-1', 'research', 'session-2')
    const second = await storage.getPhaseRecord('issue-1', 'research')

    expect(second!.sessionId).toBe('session-2')
    expect(second!.completedAt).toBeGreaterThanOrEqual(first!.completedAt)
  })

  // -- clearPhase --

  it('clears a completed phase', async () => {
    await storage.markPhaseCompleted('issue-1', 'research')
    expect(await storage.isPhaseCompleted('issue-1', 'research')).toBe(true)

    await storage.clearPhase('issue-1', 'research')
    expect(await storage.isPhaseCompleted('issue-1', 'research')).toBe(false)
  })

  it('clearing an already-absent phase is a no-op', async () => {
    // Should not throw
    await storage.clearPhase('issue-1', 'research')
    expect(await storage.isPhaseCompleted('issue-1', 'research')).toBe(false)
  })

  // -- getPhaseRecord --

  it('returns null for an absent record', async () => {
    const record = await storage.getPhaseRecord('issue-1', 'backlog-creation')
    expect(record).toBeNull()
  })

  it('returns the stored record', async () => {
    await storage.markPhaseCompleted('issue-1', 'backlog-creation', 'sess-x')
    const record = await storage.getPhaseRecord('issue-1', 'backlog-creation')
    expect(record).toEqual(
      expect.objectContaining({
        issueId: 'issue-1',
        phase: 'backlog-creation',
        sessionId: 'sess-x',
      }),
    )
  })

  // -- Phase isolation --

  it('different phases for the same issue are independent', async () => {
    await storage.markPhaseCompleted('issue-1', 'research')
    expect(await storage.isPhaseCompleted('issue-1', 'research')).toBe(true)
    expect(await storage.isPhaseCompleted('issue-1', 'backlog-creation')).toBe(false)
  })

  it('same phase for different issues are independent', async () => {
    await storage.markPhaseCompleted('issue-1', 'research')
    expect(await storage.isPhaseCompleted('issue-1', 'research')).toBe(true)
    expect(await storage.isPhaseCompleted('issue-2', 'research')).toBe(false)
  })

  // -- All phases --

  it('supports both defined processing phases', async () => {
    const phases: ProcessingPhase[] = ['research', 'backlog-creation']
    for (const phase of phases) {
      await storage.markPhaseCompleted('issue-x', phase, `sess-${phase}`)
      expect(await storage.isPhaseCompleted('issue-x', phase)).toBe(true)
      const record = await storage.getPhaseRecord('issue-x', phase)
      expect(record!.phase).toBe(phase)
    }
  })

  // -- InMemory-specific: clear all --

  it('clear() removes all records', async () => {
    await storage.markPhaseCompleted('issue-1', 'research')
    await storage.markPhaseCompleted('issue-2', 'backlog-creation')

    storage.clear()

    expect(await storage.isPhaseCompleted('issue-1', 'research')).toBe(false)
    expect(await storage.isPhaseCompleted('issue-2', 'backlog-creation')).toBe(false)
  })
})
