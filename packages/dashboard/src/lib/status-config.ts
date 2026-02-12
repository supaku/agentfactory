export type SessionStatus = 'queued' | 'parked' | 'working' | 'completed' | 'failed' | 'stopped'

export interface StatusConfig {
  label: string
  dotColor: string
  textColor: string
  bgColor: string
  borderColor: string
  glowClass: string
  animate: boolean
}

const statuses: Record<SessionStatus, StatusConfig> = {
  working: {
    label: 'Working',
    dotColor: 'bg-af-status-success',
    textColor: 'text-af-status-success',
    bgColor: 'bg-af-status-success/10',
    borderColor: 'border-af-status-success/20',
    glowClass: 'glow-dot-green',
    animate: true,
  },
  queued: {
    label: 'Queued',
    dotColor: 'bg-af-status-warning',
    textColor: 'text-af-status-warning',
    bgColor: 'bg-af-status-warning/10',
    borderColor: 'border-af-status-warning/20',
    glowClass: 'glow-dot-yellow',
    animate: true,
  },
  parked: {
    label: 'Parked',
    dotColor: 'bg-af-text-tertiary',
    textColor: 'text-af-text-secondary',
    bgColor: 'bg-af-text-secondary/8',
    borderColor: 'border-af-text-secondary/10',
    glowClass: '',
    animate: false,
  },
  completed: {
    label: 'Completed',
    dotColor: 'bg-af-status-success',
    textColor: 'text-af-status-success',
    bgColor: 'bg-af-status-success/10',
    borderColor: 'border-af-status-success/15',
    glowClass: '',
    animate: false,
  },
  failed: {
    label: 'Failed',
    dotColor: 'bg-af-status-error',
    textColor: 'text-af-status-error',
    bgColor: 'bg-af-status-error/10',
    borderColor: 'border-af-status-error/20',
    glowClass: 'glow-dot-red',
    animate: false,
  },
  stopped: {
    label: 'Stopped',
    dotColor: 'bg-af-text-tertiary',
    textColor: 'text-af-text-secondary',
    bgColor: 'bg-af-text-secondary/8',
    borderColor: 'border-af-text-secondary/10',
    glowClass: '',
    animate: false,
  },
}

export function getStatusConfig(status: SessionStatus): StatusConfig {
  return statuses[status] ?? statuses.queued
}
