'use client'

import { cn } from '../../lib/utils'
import { useSessions } from '../../hooks/use-sessions'
import { StatusDot } from '../../components/fleet/status-dot'
import { Badge } from '../../components/ui/badge'
import { Skeleton } from '../../components/ui/skeleton'
import { EmptyState } from '../../components/shared/empty-state'
import { formatDuration, formatCost, formatRelativeTime } from '../../lib/format'
import { getWorkTypeConfig } from '../../lib/work-type-config'
import { getStatusConfig } from '../../lib/status-config'

interface SessionListProps {
  onSelect?: (sessionId: string) => void
  className?: string
}

export function SessionList({ onSelect, className }: SessionListProps) {
  const { data, isLoading } = useSessions()
  const sessions = data?.sessions ?? []

  if (isLoading) {
    return (
      <div className={cn('space-y-2 p-5', className)}>
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-14 rounded-lg" />
        ))}
      </div>
    )
  }

  if (sessions.length === 0) {
    return (
      <div className="p-5">
        <EmptyState
          title="No sessions"
          description="Agent sessions will appear here once they start."
        />
      </div>
    )
  }

  return (
    <div className={cn('p-5', className)}>
      <div className="rounded-lg border border-af-surface-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-af-surface-border bg-af-bg-secondary">
              <th className="px-4 py-2.5 text-left text-xs font-medium text-af-text-secondary">Issue</th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-af-text-secondary">Status</th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-af-text-secondary">Type</th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-af-text-secondary">Duration</th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-af-text-secondary">Cost</th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-af-text-secondary">Started</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => {
              const statusConfig = getStatusConfig(session.status)
              const workTypeConfig = getWorkTypeConfig(session.workType)
              return (
                <tr
                  key={session.id}
                  className="border-b border-af-surface-border last:border-0 hover:bg-af-surface/50 cursor-pointer transition-colors"
                  onClick={() => onSelect?.(session.id)}
                >
                  <td className="px-4 py-2.5">
                    <span className="font-mono text-sm text-af-text-primary">{session.identifier}</span>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <StatusDot status={session.status} />
                      <span className={cn('text-xs', statusConfig.textColor)}>
                        {statusConfig.label}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge
                      variant="outline"
                      className={cn('text-xs', workTypeConfig.bgColor, workTypeConfig.color, 'border-transparent')}
                    >
                      {workTypeConfig.label}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="text-xs text-af-text-secondary tabular-nums">
                      {formatDuration(session.duration)}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="text-xs text-af-text-secondary tabular-nums font-mono">
                      {formatCost(session.costUsd)}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="text-xs text-af-text-secondary">
                      {formatRelativeTime(session.startedAt)}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
