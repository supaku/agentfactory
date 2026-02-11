'use client'

import { cn } from '../../lib/utils'
import { Card } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { StatusDot } from './status-dot'
import { ProviderIcon } from './provider-icon'
import { formatDuration, formatCost } from '../../lib/format'
import { getWorkTypeConfig } from '../../lib/work-type-config'
import { getStatusConfig } from '../../lib/status-config'
import type { PublicSessionResponse } from '../../types/api'

interface AgentCardProps {
  session: PublicSessionResponse
  className?: string
}

export function AgentCard({ session, className }: AgentCardProps) {
  const statusConfig = getStatusConfig(session.status)
  const workTypeConfig = getWorkTypeConfig(session.workType)

  return (
    <Card
      className={cn(
        'relative p-4 transition-colors hover:border-af-surface-border/80',
        className
      )}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <StatusDot status={session.status} showHeartbeat={session.status === 'working'} />
          <span className="text-sm font-medium text-af-text-primary font-mono">
            {session.identifier}
          </span>
        </div>
        <ProviderIcon size={14} />
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Badge
          variant="outline"
          className={cn('text-xs', workTypeConfig.bgColor, workTypeConfig.color, 'border-transparent')}
        >
          {workTypeConfig.label}
        </Badge>
        <Badge
          variant="outline"
          className={cn('text-xs', statusConfig.bgColor, statusConfig.textColor, 'border-transparent')}
        >
          {statusConfig.label}
        </Badge>
      </div>

      <div className="mt-3 flex items-center justify-between text-xs text-af-text-secondary">
        <span className="tabular-nums">{formatDuration(session.duration)}</span>
        {session.costUsd != null && (
          <span className="tabular-nums font-mono">{formatCost(session.costUsd)}</span>
        )}
      </div>
    </Card>
  )
}
