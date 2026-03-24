import { describe, it, expect } from 'vitest'
import { computeReward, extractRewardFromProcess, MAX_EXPECTED_COST } from './reward.js'
import type { RoutingReward } from './reward.js'
import type { AgentProcess } from '../orchestrator/types.js'

function makeReward(overrides: Partial<RoutingReward> = {}): RoutingReward {
  return {
    taskCompleted: false,
    prCreated: false,
    qaResult: 'unknown',
    totalCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    wallClockTimeMs: 0,
    requiredRefinements: 0,
    humanEscalations: 0,
    ...overrides,
  }
}

function makeProcess(overrides: Partial<AgentProcess> = {}): AgentProcess {
  return {
    issueId: 'issue-1',
    identifier: 'SUP-100',
    pid: 1234,
    status: 'running',
    startedAt: new Date('2024-01-01T00:00:00Z'),
    lastActivityAt: new Date('2024-01-01T00:01:00Z'),
    ...overrides,
  }
}

describe('computeReward', () => {
  it('returns ~1.0 for full success with zero cost', () => {
    const reward = computeReward(
      makeReward({
        taskCompleted: true,
        prCreated: true,
        qaResult: 'passed',
        totalCostUsd: 0,
      }),
    )
    // 0.5 + 0.2 + 0.3 - 0 = 1.0
    expect(reward).toBe(1.0)
  })

  it('returns 0.0 for full failure', () => {
    const reward = computeReward(makeReward())
    expect(reward).toBe(0.0)
  })

  it('returns 0.5 for taskCompleted only', () => {
    const reward = computeReward(makeReward({ taskCompleted: true }))
    expect(reward).toBe(0.5)
  })

  it('returns 0.2 for prCreated only', () => {
    const reward = computeReward(makeReward({ prCreated: true }))
    expect(reward).toBe(0.2)
  })

  it('returns 0.3 for qaResult passed only', () => {
    const reward = computeReward(makeReward({ qaResult: 'passed' }))
    expect(reward).toBe(0.3)
  })

  it('returns 0.7 for taskCompleted + prCreated', () => {
    const reward = computeReward(makeReward({ taskCompleted: true, prCreated: true }))
    expect(reward).toBe(0.7)
  })

  it('applies full cost penalty of 0.1 when cost equals MAX_EXPECTED_COST', () => {
    const reward = computeReward(
      makeReward({
        taskCompleted: true,
        prCreated: true,
        qaResult: 'passed',
        totalCostUsd: MAX_EXPECTED_COST,
      }),
    )
    // 0.5 + 0.2 + 0.3 - 0.1 * 1.0 = 0.9
    expect(reward).toBeCloseTo(0.9)
  })

  it('caps cost penalty when cost exceeds MAX_EXPECTED_COST', () => {
    const reward = computeReward(
      makeReward({
        taskCompleted: true,
        prCreated: true,
        qaResult: 'passed',
        totalCostUsd: 100,
      }),
    )
    // Cost penalty capped at 0.1, so 1.0 - 0.1 = 0.9
    expect(reward).toBeCloseTo(0.9)
  })

  it('applies proportional cost penalty', () => {
    const reward = computeReward(
      makeReward({
        taskCompleted: true,
        totalCostUsd: MAX_EXPECTED_COST / 2,
      }),
    )
    // 0.5 - 0.1 * 0.5 = 0.45
    expect(reward).toBeCloseTo(0.45)
  })

  it('clamps reward to minimum of 0', () => {
    // Only cost, no success signals: 0 - 0.1 = -0.1 => clamped to 0
    const reward = computeReward(makeReward({ totalCostUsd: MAX_EXPECTED_COST }))
    expect(reward).toBe(0)
  })

  it('clamps reward to maximum of 1', () => {
    // Full success with zero cost should be exactly 1.0 (0.5 + 0.2 + 0.3)
    const reward = computeReward(
      makeReward({
        taskCompleted: true,
        prCreated: true,
        qaResult: 'passed',
        totalCostUsd: 0,
      }),
    )
    expect(reward).toBeLessThanOrEqual(1)
    expect(reward).toBeGreaterThanOrEqual(0)
  })

  it('does not add reward for qaResult failed', () => {
    const reward = computeReward(makeReward({ qaResult: 'failed' }))
    expect(reward).toBe(0)
  })

  it('does not add reward for qaResult unknown', () => {
    const reward = computeReward(makeReward({ qaResult: 'unknown' }))
    expect(reward).toBe(0)
  })
})

describe('extractRewardFromProcess', () => {
  it('maps completed process with PR and passed QA', () => {
    const process = makeProcess({
      status: 'completed',
      pullRequestUrl: 'https://github.com/org/repo/pull/1',
      workResult: 'passed',
      totalCostUsd: 1.5,
      inputTokens: 10000,
      outputTokens: 5000,
      startedAt: new Date('2024-01-01T00:00:00Z'),
      completedAt: new Date('2024-01-01T00:05:00Z'),
    })
    const result = extractRewardFromProcess(process)
    expect(result.taskCompleted).toBe(true)
    expect(result.prCreated).toBe(true)
    expect(result.qaResult).toBe('passed')
    expect(result.totalCostUsd).toBe(1.5)
    expect(result.inputTokens).toBe(10000)
    expect(result.outputTokens).toBe(5000)
    expect(result.wallClockTimeMs).toBe(300000) // 5 minutes
    expect(result.requiredRefinements).toBe(0)
    expect(result.humanEscalations).toBe(0)
  })

  it('maps failed process', () => {
    const process = makeProcess({
      status: 'failed',
    })
    const result = extractRewardFromProcess(process)
    expect(result.taskCompleted).toBe(false)
    expect(result.prCreated).toBe(false)
    expect(result.qaResult).toBe('unknown')
  })

  it('maps running process as not completed', () => {
    const result = extractRewardFromProcess(makeProcess({ status: 'running' }))
    expect(result.taskCompleted).toBe(false)
  })

  it('maps incomplete process as not completed', () => {
    const result = extractRewardFromProcess(makeProcess({ status: 'incomplete' }))
    expect(result.taskCompleted).toBe(false)
  })

  it('maps stopped process as not completed', () => {
    const result = extractRewardFromProcess(makeProcess({ status: 'stopped' }))
    expect(result.taskCompleted).toBe(false)
  })

  it('handles undefined pullRequestUrl', () => {
    const result = extractRewardFromProcess(makeProcess({ pullRequestUrl: undefined }))
    expect(result.prCreated).toBe(false)
  })

  it('handles undefined workResult', () => {
    const result = extractRewardFromProcess(makeProcess({ workResult: undefined }))
    expect(result.qaResult).toBe('unknown')
  })

  it('handles undefined totalCostUsd', () => {
    const result = extractRewardFromProcess(makeProcess({ totalCostUsd: undefined }))
    expect(result.totalCostUsd).toBe(0)
  })

  it('handles undefined inputTokens', () => {
    const result = extractRewardFromProcess(makeProcess({ inputTokens: undefined }))
    expect(result.inputTokens).toBe(0)
  })

  it('handles undefined outputTokens', () => {
    const result = extractRewardFromProcess(makeProcess({ outputTokens: undefined }))
    expect(result.outputTokens).toBe(0)
  })

  it('handles undefined completedAt (wallClockTimeMs is 0)', () => {
    const result = extractRewardFromProcess(
      makeProcess({
        startedAt: new Date('2024-01-01T00:00:00Z'),
        completedAt: undefined,
      }),
    )
    expect(result.wallClockTimeMs).toBe(0)
  })

  it('computes correct wallClockTimeMs from startedAt and completedAt', () => {
    const result = extractRewardFromProcess(
      makeProcess({
        startedAt: new Date('2024-01-01T00:00:00Z'),
        completedAt: new Date('2024-01-01T01:00:00Z'),
      }),
    )
    expect(result.wallClockTimeMs).toBe(3600000) // 1 hour
  })

  it('end-to-end: extractRewardFromProcess feeds into computeReward correctly', () => {
    const process = makeProcess({
      status: 'completed',
      pullRequestUrl: 'https://github.com/org/repo/pull/1',
      workResult: 'passed',
      totalCostUsd: 0,
    })
    const routingReward = extractRewardFromProcess(process)
    const reward = computeReward(routingReward)
    expect(reward).toBe(1.0)
  })

  it('end-to-end: failed process with high cost yields 0', () => {
    const process = makeProcess({
      status: 'failed',
      totalCostUsd: 10,
    })
    const routingReward = extractRewardFromProcess(process)
    const reward = computeReward(routingReward)
    expect(reward).toBe(0)
  })
})
