import { describe, it, expect } from 'vitest'
import { detectWorkType } from './orchestrator.js'

describe('detectWorkType', () => {
  describe('leaf issues (isParent=false)', () => {
    it('maps Backlog status to development', () => {
      expect(detectWorkType('Backlog', false)).toBe('development')
    })

    it('maps Finished status to qa', () => {
      expect(detectWorkType('Finished', false)).toBe('qa')
    })

    it('maps Delivered status to acceptance', () => {
      expect(detectWorkType('Delivered', false)).toBe('acceptance')
    })

    it('maps Rejected status to refinement', () => {
      expect(detectWorkType('Rejected', false)).toBe('refinement')
    })

    it('maps Icebox status to research', () => {
      expect(detectWorkType('Icebox', false)).toBe('research')
    })

    it('maps Started status to inflight', () => {
      expect(detectWorkType('Started', false)).toBe('inflight')
    })

    it('defaults unknown status to development', () => {
      expect(detectWorkType('SomeUnknownStatus', false)).toBe('development')
    })
  })

  describe('parent issues (isParent=true)', () => {
    it('upgrades Backlog/development to coordination', () => {
      expect(detectWorkType('Backlog', true)).toBe('coordination')
    })

    it('upgrades Finished/qa to qa-coordination', () => {
      expect(detectWorkType('Finished', true)).toBe('qa-coordination')
    })

    it('upgrades Delivered/acceptance to acceptance-coordination', () => {
      expect(detectWorkType('Delivered', true)).toBe('acceptance-coordination')
    })

    it('upgrades Rejected/refinement to refinement-coordination', () => {
      expect(detectWorkType('Rejected', true)).toBe('refinement-coordination')
    })

    it('does not upgrade research (Icebox) — no coordination variant', () => {
      expect(detectWorkType('Icebox', true)).toBe('research')
    })

    it('does not upgrade inflight (Started) — no coordination variant', () => {
      expect(detectWorkType('Started', true)).toBe('inflight')
    })

    it('upgrades unknown status (defaults to development → coordination)', () => {
      expect(detectWorkType('SomeUnknownStatus', true)).toBe('coordination')
    })
  })

  describe('post-refinement rework scenario (SUP-1116 bug)', () => {
    it('parent issue returning to Backlog after refinement gets coordination, not development', () => {
      // This is the exact scenario that caused SUP-1116 to fail:
      // After refinement-coordination completed, the parent moved to Backlog.
      // The orchestrator's run() previously hardcoded 'development', which loaded
      // the wrong template and the agent asked for human input instead of
      // autonomously dispatching sub-agents.
      const workType = detectWorkType('Backlog', true)
      expect(workType).toBe('coordination')
      expect(workType).not.toBe('development')
    })
  })
})
