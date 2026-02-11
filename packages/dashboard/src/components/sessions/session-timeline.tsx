import { cn } from '../../lib/utils'

export interface TimelineEvent {
  id: string
  label: string
  timestamp: string
  detail?: string
  type?: 'info' | 'success' | 'warning' | 'error'
}

interface SessionTimelineProps {
  events: TimelineEvent[]
  className?: string
}

const typeColors = {
  info: 'bg-blue-400',
  success: 'bg-af-status-success',
  warning: 'bg-af-status-warning',
  error: 'bg-af-status-error',
}

export function SessionTimeline({ events, className }: SessionTimelineProps) {
  return (
    <div className={cn('relative space-y-0', className)}>
      {/* Vertical line */}
      <div className="absolute left-[7px] top-2 bottom-2 w-px bg-af-surface-border" />

      {events.map((event, i) => (
        <div key={event.id} className="relative flex gap-3 py-2">
          {/* Dot */}
          <span
            className={cn(
              'relative z-10 mt-1 h-[14px] w-[14px] shrink-0 rounded-full border-2 border-af-bg-primary',
              typeColors[event.type ?? 'info']
            )}
          />

          <div className="flex-1 min-w-0">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm text-af-text-primary">{event.label}</span>
              <span className="text-xs text-af-text-secondary whitespace-nowrap">
                {new Date(event.timestamp).toLocaleTimeString()}
              </span>
            </div>
            {event.detail && (
              <p className="mt-0.5 text-xs text-af-text-secondary">{event.detail}</p>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
