'use client'

import { cn } from '../../lib/utils'
import { useSessions } from '../../hooks/use-sessions'
import { PipelineColumn } from './pipeline-column'
import { EmptyState } from '../../components/shared/empty-state'
import { Skeleton } from '../../components/ui/skeleton'
import type { PublicSessionResponse, SessionStatus } from '../../types/api'

interface ColumnDef {
  title: string
  statuses: SessionStatus[]
  accentColor: string
}

const columns: ColumnDef[] = [
  { title: 'Backlog', statuses: ['queued', 'parked'], accentColor: 'bg-af-text-secondary' },
  { title: 'Started', statuses: ['working'], accentColor: 'bg-af-status-success' },
  { title: 'Finished', statuses: ['completed'], accentColor: 'bg-blue-400' },
  { title: 'Failed', statuses: ['failed'], accentColor: 'bg-af-status-error' },
  { title: 'Stopped', statuses: ['stopped'], accentColor: 'bg-af-status-warning' },
]

function groupByColumn(sessions: PublicSessionResponse[]) {
  return columns.map((col) => ({
    ...col,
    sessions: sessions.filter((s) => col.statuses.includes(s.status)),
  }))
}

interface PipelineViewProps {
  className?: string
}

export function PipelineView({ className }: PipelineViewProps) {
  const { data, isLoading } = useSessions()
  const sessions = data?.sessions ?? []

  if (isLoading) {
    return (
      <div className={cn('flex gap-4 overflow-x-auto p-5', className)}>
        {columns.map((col) => (
          <Skeleton key={col.title} className="h-96 w-72 shrink-0 rounded-lg" />
        ))}
      </div>
    )
  }

  if (sessions.length === 0) {
    return (
      <div className="p-5">
        <EmptyState
          title="No pipeline data"
          description="Sessions will populate the pipeline as agents work on issues."
        />
      </div>
    )
  }

  const grouped = groupByColumn(sessions)

  return (
    <div className={cn('flex gap-4 overflow-x-auto p-5', className)}>
      {grouped.map((col) => (
        <PipelineColumn
          key={col.title}
          title={col.title}
          sessions={col.sessions}
          count={col.sessions.length}
          accentColor={col.accentColor}
        />
      ))}
    </div>
  )
}
