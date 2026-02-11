export interface PublicStatsResponse {
  workersOnline: number
  agentsWorking: number
  queueDepth: number
  completedToday: number
  availableCapacity: number
  totalCostToday?: number
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
