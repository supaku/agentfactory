import { describe, it, expect } from 'vitest'
import { detectWorkType } from './orchestrator.js'
import type { AgentWorkType } from './work-types.js'

// Linear status mapping for tests (same as what LinearIssueTrackerClient provides)
const STATUS_TO_WORK_TYPE: Record<string, AgentWorkType> = {
  'Icebox': 'research',
  'Backlog': 'development',
  'Started': 'inflight',
  'Finished': 'qa',
  'Delivered': 'acceptance',
  'Rejected': 'refinement',
}

describe('detectWorkType', () => {
  describe('leaf issues (isParent=false)', () => {
    it('maps Backlog status to development', () => {
      expect(detectWorkType('Backlog', false, STATUS_TO_WORK_TYPE)).toBe('development')
    })

    it('maps Finished status to qa', () => {
      expect(detectWorkType('Finished', false, STATUS_TO_WORK_TYPE)).toBe('qa')
    })

    it('maps Delivered status to acceptance', () => {
      expect(detectWorkType('Delivered', false, STATUS_TO_WORK_TYPE)).toBe('acceptance')
    })

    it('maps Rejected status to refinement', () => {
      expect(detectWorkType('Rejected', false, STATUS_TO_WORK_TYPE)).toBe('refinement')
    })

    it('maps Icebox status to research', () => {
      expect(detectWorkType('Icebox', false, STATUS_TO_WORK_TYPE)).toBe('research')
    })

    it('maps Started status to inflight', () => {
      expect(detectWorkType('Started', false, STATUS_TO_WORK_TYPE)).toBe('inflight')
    })

    it('defaults unknown status to development', () => {
      expect(detectWorkType('SomeUnknownStatus', false, STATUS_TO_WORK_TYPE)).toBe('development')
    })
  })

  describe('parent issues (isParent=true)', () => {
    it('upgrades Backlog/development to coordination', () => {
      expect(detectWorkType('Backlog', true, STATUS_TO_WORK_TYPE)).toBe('coordination')
    })

    it('upgrades Finished/qa to qa-coordination', () => {
      expect(detectWorkType('Finished', true, STATUS_TO_WORK_TYPE)).toBe('qa-coordination')
    })

    it('upgrades Delivered/acceptance to acceptance-coordination', () => {
      expect(detectWorkType('Delivered', true, STATUS_TO_WORK_TYPE)).toBe('acceptance-coordination')
    })

    it('upgrades Rejected/refinement to refinement-coordination', () => {
      expect(detectWorkType('Rejected', true, STATUS_TO_WORK_TYPE)).toBe('refinement-coordination')
    })

    it('does not upgrade research (Icebox) — no coordination variant', () => {
      expect(detectWorkType('Icebox', true, STATUS_TO_WORK_TYPE)).toBe('research')
    })

    it('upgrades Started/inflight to inflight-coordination', () => {
      expect(detectWorkType('Started', true, STATUS_TO_WORK_TYPE)).toBe('inflight-coordination')
    })

    it('upgrades unknown status (defaults to development → coordination)', () => {
      expect(detectWorkType('SomeUnknownStatus', true, STATUS_TO_WORK_TYPE)).toBe('coordination')
    })
  })

  describe('post-refinement rework scenario (SUP-1116 bug)', () => {
    it('parent issue returning to Backlog after refinement gets coordination, not development', () => {
      // This is the exact scenario that caused SUP-1116 to fail:
      // After refinement-coordination completed, the parent moved to Backlog.
      // The orchestrator's run() previously hardcoded 'development', which loaded
      // the wrong template and the agent asked for human input instead of
      // autonomously dispatching sub-agents.
      const workType = detectWorkType('Backlog', true, STATUS_TO_WORK_TYPE)
      expect(workType).toBe('coordination')
      expect(workType).not.toBe('development')
    })
  })
})
