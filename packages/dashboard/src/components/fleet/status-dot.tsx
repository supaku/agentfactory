import { cn } from '../../lib/utils'
import { getStatusConfig, type SessionStatus } from '../../lib/status-config'

interface StatusDotProps {
  status: SessionStatus
  className?: string
  showHeartbeat?: boolean
}

export function StatusDot({ status, className, showHeartbeat = false }: StatusDotProps) {
  const config = getStatusConfig(status)

  return (
    <span className={cn('relative inline-flex h-2.5 w-2.5', className)}>
      {config.animate && showHeartbeat && (
        <span
          className={cn(
            'absolute inset-0 rounded-full animate-heartbeat',
            config.dotColor
          )}
        />
      )}
      <span
        className={cn(
          'relative inline-flex h-2.5 w-2.5 rounded-full',
          config.dotColor,
          config.animate && 'animate-pulse-dot'
        )}
      />
    </span>
  )
}
