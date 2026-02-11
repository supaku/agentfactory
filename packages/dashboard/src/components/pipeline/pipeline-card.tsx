import { cn } from '../../lib/utils'
import { StatusDot } from '../../components/fleet/status-dot'
import { Badge } from '../../components/ui/badge'
import { formatDuration } from '../../lib/format'
import { getWorkTypeConfig } from '../../lib/work-type-config'
import type { PublicSessionResponse } from '../../types/api'

interface PipelineCardProps {
  session: PublicSessionResponse
  className?: string
}

export function PipelineCard({ session, className }: PipelineCardProps) {
  const workTypeConfig = getWorkTypeConfig(session.workType)

  return (
    <div
      className={cn(
        'rounded-md border border-af-surface-border bg-af-surface p-3 transition-colors hover:border-af-surface-border/80',
        className
      )}
    >
      <div className="flex items-center gap-2">
        <StatusDot status={session.status} />
        <span className="text-xs font-medium text-af-text-primary font-mono truncate">
          {session.identifier}
        </span>
      </div>
      <div className="mt-2 flex items-center justify-between">
        <Badge
          variant="outline"
          className={cn('text-xs', workTypeConfig.bgColor, workTypeConfig.color, 'border-transparent')}
        >
          {workTypeConfig.label}
        </Badge>
        <span className="text-xs text-af-text-secondary tabular-nums">
          {formatDuration(session.duration)}
        </span>
      </div>
    </div>
  )
}
