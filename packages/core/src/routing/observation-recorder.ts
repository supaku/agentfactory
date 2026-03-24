import { randomUUID } from 'crypto'
import type { AgentProcess, OrchestratorEvents } from '../orchestrator/types.js'
import type { RoutingObservation } from './types.js'
import type { ObservationStore } from './observation-store.js'
import type { PosteriorStore } from './posterior-store.js'
import { computeReward, extractRewardFromProcess } from './reward.js'

export interface RoutingRecorderOptions {
  observationStore: ObservationStore
  posteriorStore: PosteriorStore
}

/**
 * Create a routing observation from an AgentProcess.
 * Returns null if provider or workType is missing (can't record without them).
 */
export function buildObservation(agent: AgentProcess): RoutingObservation | null {
  if (!agent.providerName || !agent.workType) {
    return null
  }

  const rewardInput = extractRewardFromProcess(agent)
  const reward = computeReward(rewardInput)

  return {
    id: randomUUID(),
    provider: agent.providerName,
    workType: agent.workType,
    project: undefined, // will be populated when integrated
    issueIdentifier: agent.identifier,
    sessionId: agent.sessionId ?? '',
    reward,
    taskCompleted: agent.status === 'completed',
    prCreated: agent.pullRequestUrl !== undefined,
    qaResult: agent.workResult ?? 'unknown',
    totalCostUsd: agent.totalCostUsd ?? 0,
    wallClockMs:
      agent.completedAt && agent.startedAt
        ? agent.completedAt.getTime() - agent.startedAt.getTime()
        : 0,
    timestamp: Date.now(),
    confidence: 0, // populated once routing engine is active
    explorationReason: undefined,
  }
}

/**
 * Wrap OrchestratorEvents to record routing observations on agent completion.
 * Best-effort: failures are logged but don't block agent completion flow.
 */
export function wrapEventsWithRecorder(
  events: OrchestratorEvents,
  options: RoutingRecorderOptions,
): OrchestratorEvents {
  const { observationStore, posteriorStore } = options

  async function recordObservation(agent: AgentProcess): Promise<void> {
    const obs = buildObservation(agent)
    if (!obs) return

    try {
      await observationStore.recordObservation(obs)
      await posteriorStore.updatePosterior(obs.provider, obs.workType, obs.reward)
    } catch (error) {
      console.error('[routing] Failed to record observation', {
        error: error instanceof Error ? error.message : String(error),
        identifier: agent.identifier,
      })
    }
  }

  return {
    ...events,
    onAgentComplete: (agent) => {
      events.onAgentComplete?.(agent)
      void recordObservation(agent)
    },
    onAgentStopped: (agent) => {
      events.onAgentStopped?.(agent)
      void recordObservation(agent)
    },
    onAgentError: (agent, error) => {
      events.onAgentError?.(agent, error)
      void recordObservation(agent)
    },
    onAgentIncomplete: (agent) => {
      events.onAgentIncomplete?.(agent)
      void recordObservation(agent)
    },
  }
}
