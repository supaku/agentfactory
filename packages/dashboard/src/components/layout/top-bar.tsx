'use client'

import { cn } from '../../lib/utils'
import { StatusDot } from '../../components/fleet/status-dot'
import { useStats } from '../../hooks/use-stats'
import { Skeleton } from '../../components/ui/skeleton'

interface TopBarProps {
  className?: string
}

export function TopBar({ className }: TopBarProps) {
  const { data, isLoading } = useStats()

  return (
    <header
      className={cn(
        'flex h-11 items-center justify-between border-b border-af-surface-border bg-af-bg-secondary px-5',
        className
      )}
    >
      <div className="flex items-center gap-4">
        {isLoading ? (
          <>
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-20" />
          </>
        ) : (
          <>
            <div className="flex items-center gap-1.5">
              <StatusDot status={data?.workersOnline ? 'working' : 'stopped'} showHeartbeat />
              <span className="text-xs text-af-text-secondary">
                <span className="font-medium text-af-text-primary">{data?.workersOnline ?? 0}</span>{' '}
                {data?.workersOnline === 1 ? 'worker' : 'workers'} online
              </span>
            </div>
            <div className="text-xs text-af-text-secondary">
              <span className="font-medium text-af-text-primary">{data?.agentsWorking ?? 0}</span> working
            </div>
            <div className="text-xs text-af-text-secondary">
              <span className="font-medium text-af-text-primary">{data?.queueDepth ?? 0}</span> queued
            </div>
          </>
        )}
      </div>

      <div className="text-xs text-af-text-secondary">
        {data?.timestamp && (
          <span>Updated {new Date(data.timestamp).toLocaleTimeString()}</span>
        )}
      </div>
    </header>
  )
}
