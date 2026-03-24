import type { AgentProcess } from '../orchestrator/types.js'

export const MAX_EXPECTED_COST = 5.0 // USD

export interface RoutingReward {
  taskCompleted: boolean
  prCreated: boolean
  qaResult: 'passed' | 'failed' | 'unknown'
  totalCostUsd: number
  inputTokens: number
  outputTokens: number
  wallClockTimeMs: number
  requiredRefinements: number
  humanEscalations: number
}

export function computeReward(outcome: RoutingReward): number {
  let reward = 0
  if (outcome.taskCompleted) reward += 0.5
  if (outcome.prCreated) reward += 0.2
  if (outcome.qaResult === 'passed') reward += 0.3
  // Cost penalty (normalized)
  const costPenalty = Math.min(outcome.totalCostUsd / MAX_EXPECTED_COST, 1)
  reward -= 0.1 * costPenalty
  return Math.max(0, Math.min(1, reward))
}

export function extractRewardFromProcess(process: AgentProcess): RoutingReward {
  return {
    taskCompleted: process.status === 'completed',
    prCreated: process.pullRequestUrl !== undefined,
    qaResult: process.workResult ?? 'unknown',
    totalCostUsd: process.totalCostUsd ?? 0,
    inputTokens: process.inputTokens ?? 0,
    outputTokens: process.outputTokens ?? 0,
    wallClockTimeMs:
      process.completedAt && process.startedAt
        ? process.completedAt.getTime() - process.startedAt.getTime()
        : 0,
    requiredRefinements: 0,
    humanEscalations: 0,
  }
}
