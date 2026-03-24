import type { AgentProviderName } from '../providers/types.js'
import type { AgentWorkType } from '../orchestrator/work-types.js'
import type { RoutingObservation } from './types.js'

/**
 * Observation Store Interface
 *
 * Append-only log of routing observations for the MAB router.
 * Implementations may use Redis Streams, SQLite, or in-memory storage.
 * Core defines only the interface — concrete stores live in server or plugin packages.
 */
export interface ObservationStore {
  /**
   * Append a single observation to the store.
   */
  recordObservation(obs: RoutingObservation): Promise<void>

  /**
   * Query observations with optional filters.
   *
   * @param opts.provider  - Filter by agent provider
   * @param opts.workType  - Filter by work type
   * @param opts.limit     - Maximum number of observations to return
   * @param opts.since     - Only return observations with timestamp >= since (epoch ms)
   */
  getObservations(opts: {
    provider?: AgentProviderName
    workType?: AgentWorkType
    limit?: number
    since?: number
  }): Promise<RoutingObservation[]>

  /**
   * Get the most recent observations for a specific provider + work type pair.
   * Results are returned newest-first, up to `windowSize` entries.
   *
   * @param provider   - Agent provider name
   * @param workType   - Agent work type
   * @param windowSize - Maximum number of recent observations to return
   */
  getRecentObservations(
    provider: AgentProviderName,
    workType: AgentWorkType,
    windowSize: number
  ): Promise<RoutingObservation[]>
}
