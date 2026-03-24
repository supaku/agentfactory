import type { AgentProviderName } from '../providers/types.js'
import type { AgentWorkType } from '../orchestrator/work-types.js'
import type { RoutingPosterior } from './types.js'

export interface PosteriorStore {
  getPosterior(provider: AgentProviderName, workType: AgentWorkType): Promise<RoutingPosterior>
  updatePosterior(provider: AgentProviderName, workType: AgentWorkType, reward: number): Promise<RoutingPosterior>
  getAllPosteriors(): Promise<RoutingPosterior[]>
  resetPosterior(provider: AgentProviderName, workType: AgentWorkType): Promise<void>
}

/** Default Beta(1,1) prior -- uniform distribution (optimistic cold start) */
export function defaultPosterior(provider: AgentProviderName, workType: AgentWorkType): RoutingPosterior {
  return {
    provider,
    workType,
    alpha: 1,
    beta: 1,
    totalObservations: 0,
    avgReward: 0,
    avgCostUsd: 0,
    lastUpdated: Date.now(),
  }
}
