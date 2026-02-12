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
    <span className={cn('relative inline-flex h-2 w-2', className)}>
      {/* Outer glow ring for active states */}
      {config.animate && showHeartbeat && (
        <span
          className={cn(
            'absolute inset-0 rounded-full animate-heartbeat',
            config.dotColor
          )}
        />
      )}
      {/* Core dot */}
      <span
        className={cn(
          'relative inline-flex h-2 w-2 rounded-full',
          config.dotColor,
          config.animate && 'animate-pulse-dot',
          config.glowClass
        )}
      />
    </span>
  )
}
