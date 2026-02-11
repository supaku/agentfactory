export type SessionStatus = 'queued' | 'parked' | 'working' | 'completed' | 'failed' | 'stopped'

export interface StatusConfig {
  label: string
  dotColor: string
  textColor: string
  bgColor: string
  animate: boolean
}

const statuses: Record<SessionStatus, StatusConfig> = {
  working: {
    label: 'Working',
    dotColor: 'bg-af-status-success',
    textColor: 'text-af-status-success',
    bgColor: 'bg-af-status-success/10',
    animate: true,
  },
  queued: {
    label: 'Queued',
    dotColor: 'bg-af-status-warning',
    textColor: 'text-af-status-warning',
    bgColor: 'bg-af-status-warning/10',
    animate: true,
  },
  parked: {
    label: 'Parked',
    dotColor: 'bg-af-text-secondary',
    textColor: 'text-af-text-secondary',
    bgColor: 'bg-af-text-secondary/10',
    animate: false,
  },
  completed: {
    label: 'Completed',
    dotColor: 'bg-af-status-success',
    textColor: 'text-af-status-success',
    bgColor: 'bg-af-status-success/10',
    animate: false,
  },
  failed: {
    label: 'Failed',
    dotColor: 'bg-af-status-error',
    textColor: 'text-af-status-error',
    bgColor: 'bg-af-status-error/10',
    animate: false,
  },
  stopped: {
    label: 'Stopped',
    dotColor: 'bg-af-text-secondary',
    textColor: 'text-af-text-secondary',
    bgColor: 'bg-af-text-secondary/10',
    animate: false,
  },
}

export function getStatusConfig(status: SessionStatus): StatusConfig {
  return statuses[status] ?? statuses.queued
}
