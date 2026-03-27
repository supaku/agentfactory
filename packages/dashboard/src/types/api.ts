export interface PublicStatsResponse {
  workersOnline: number
  agentsWorking: number
  queueDepth: number
  completedToday: number
  availableCapacity: number
  totalCostToday?: number
  totalCostAllTime?: number
  sessionCountToday?: number
  timestamp: string
}

export type SessionStatus = 'queued' | 'parked' | 'working' | 'completed' | 'failed' | 'stopped'

export interface PublicSessionResponse {
  id: string
  identifier: string
  status: SessionStatus
  workType: string
  startedAt: string
  duration: number
  costUsd?: number
  provider?: string
}

export interface PublicSessionsListResponse {
  sessions: PublicSessionResponse[]
  count: number
  timestamp: string
}

export interface WorkerResponse {
  id: string
  status: 'active' | 'draining' | 'offline'
  capacity: number
  activeSessions: number
  lastHeartbeat: string
  provider?: string
  hostname?: string
}

export interface WorkersListResponse {
  workers: WorkerResponse[]
  count: number
  timestamp: string
}

export type PipelineStatus = 'backlog' | 'started' | 'finished' | 'delivered' | 'accepted'

export interface RoutingPosteriorResponse {
  provider: string
  workType: string
  alpha: number
  beta: number
  expectedReward: number
  confidence: number
  totalObservations: number
  avgCostUsd: number
}

export interface RoutingDecisionResponse {
  timestamp: number
  provider: string
  workType: string
  reward: number
  taskCompleted: boolean
  confidence: number
  explorationReason?: string
}

export interface RoutingSummaryResponse {
  totalObservations: number
  routingEnabled: boolean
  explorationRate: number
  avgConfidence: number
}

export interface PublicRoutingMetricsResponse {
  posteriors: RoutingPosteriorResponse[]
  recentDecisions: RoutingDecisionResponse[]
  summary: RoutingSummaryResponse
  timestamp: string
}

export type WorkflowPhase = 'development' | 'qa' | 'refinement' | 'acceptance'
export type EscalationStrategy = 'normal' | 'context-enriched' | 'decompose' | 'escalate-human'

export interface PhaseMetricsDetail {
  avgCycleTimeMs: number
  avgCostUsd: number
  avgAttempts: number
  totalRecords: number
}

export interface PhaseMetricsResponse {
  timeRange: '7d' | '30d' | '90d'
  phases: Record<WorkflowPhase, PhaseMetricsDetail>
  reworkRate: number
  escalationDistribution: Record<EscalationStrategy, number>
  issueCount: number
  timestamp: string
}
