import { cn } from '../../lib/utils'
import { ScrollArea } from '../../components/ui/scroll-area'
import { PipelineCard } from './pipeline-card'
import type { PublicSessionResponse } from '../../types/api'

interface PipelineColumnProps {
  title: string
  sessions: PublicSessionResponse[]
  count: number
  accentColor?: string
  className?: string
}

export function PipelineColumn({ title, sessions, count, accentColor, className }: PipelineColumnProps) {
  return (
    <div
      className={cn(
        'flex w-72 shrink-0 flex-col rounded-lg border border-af-surface-border bg-af-bg-secondary',
        className
      )}
    >
      <div className="flex items-center justify-between px-3 py-2.5">
        <div className="flex items-center gap-2">
          {accentColor && (
            <span className={cn('h-2 w-2 rounded-full', accentColor)} />
          )}
          <span className="text-xs font-medium text-af-text-primary">{title}</span>
        </div>
        <span className="text-xs tabular-nums text-af-text-secondary">{count}</span>
      </div>
      <ScrollArea className="flex-1 px-2 pb-2">
        <div className="space-y-2">
          {sessions.map((session) => (
            <PipelineCard key={session.id} session={session} />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}
