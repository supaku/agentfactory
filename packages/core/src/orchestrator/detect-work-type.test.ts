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

  describe('parent issues (isParent=true) — no upgrade, same work type as leaf', () => {
    it('maps Backlog to development (not coordination)', () => {
      expect(detectWorkType('Backlog', true, STATUS_TO_WORK_TYPE)).toBe('development')
    })

    it('maps Finished to qa (not qa-coordination)', () => {
      expect(detectWorkType('Finished', true, STATUS_TO_WORK_TYPE)).toBe('qa')
    })

    it('maps Delivered to acceptance (not acceptance-coordination)', () => {
      expect(detectWorkType('Delivered', true, STATUS_TO_WORK_TYPE)).toBe('acceptance')
    })

    it('maps Rejected to refinement (not refinement-coordination)', () => {
      expect(detectWorkType('Rejected', true, STATUS_TO_WORK_TYPE)).toBe('refinement')
    })

    it('maps Icebox to research regardless of parent status', () => {
      expect(detectWorkType('Icebox', true, STATUS_TO_WORK_TYPE)).toBe('research')
    })

    it('maps Started to inflight (not inflight-coordination)', () => {
      expect(detectWorkType('Started', true, STATUS_TO_WORK_TYPE)).toBe('inflight')
    })

    it('defaults unknown status to development', () => {
      expect(detectWorkType('SomeUnknownStatus', true, STATUS_TO_WORK_TYPE)).toBe('development')
    })
  })

  describe('coordinator-shaped agent for parent issue (REN-1286)', () => {
    // After removing -coordination work types, parent issues use the same work type as leaf issues.
    // The agent's runtime decides whether to spawn sub-agents based on whether sub-issues exist,
    // not based on the work type label.
    it('parent issue with Backlog status gets development work type — agent decides sub-agent spawning at runtime', () => {
      const workType = detectWorkType('Backlog', true, STATUS_TO_WORK_TYPE)
      expect(workType).toBe('development')
      // Coordinator behavior is now a runtime concern, not encoded in the work type
      expect(workType).not.toBe('coordination')
    })

    it('parent issue with Finished status gets qa work type — agent decides sub-agent spawning at runtime', () => {
      const workType = detectWorkType('Finished', true, STATUS_TO_WORK_TYPE)
      expect(workType).toBe('qa')
      expect(workType).not.toBe('qa-coordination')
    })

    it('parent issue with Delivered status gets acceptance work type', () => {
      const workType = detectWorkType('Delivered', true, STATUS_TO_WORK_TYPE)
      expect(workType).toBe('acceptance')
      expect(workType).not.toBe('acceptance-coordination')
    })

    it('parent issue with Started status gets inflight work type', () => {
      const workType = detectWorkType('Started', true, STATUS_TO_WORK_TYPE)
      expect(workType).toBe('inflight')
      expect(workType).not.toBe('inflight-coordination')
    })

    it('parent Rejected issue gets refinement — refinement-coordination is still valid for parent triage', () => {
      // Note: refinement-coordination is still a valid work type but it is set
      // explicitly in STATUS_WORK_TYPE_MAP by the issue tracker adapter, not auto-upgraded.
      const workType = detectWorkType('Rejected', true, STATUS_TO_WORK_TYPE)
      expect(workType).toBe('refinement')
    })
  })
})
