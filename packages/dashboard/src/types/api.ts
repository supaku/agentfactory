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
  nextCursor?: string
  summary: RoutingSummaryResponse
  timestamp: string
}
