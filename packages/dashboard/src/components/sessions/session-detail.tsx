'use client'

import { cn } from '../../lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { StatusDot } from '../../components/fleet/status-dot'
import { SessionTimeline, type TimelineEvent } from './session-timeline'
import { TokenChart } from './token-chart'
import { formatDuration, formatCost } from '../../lib/format'
import { getStatusConfig } from '../../lib/status-config'
import { getWorkTypeConfig } from '../../lib/work-type-config'
import type { PublicSessionResponse } from '../../types/api'
import { ArrowLeft } from 'lucide-react'
import { Button } from '../../components/ui/button'

interface SessionDetailProps {
  session: PublicSessionResponse
  onBack?: () => void
  className?: string
}

export function SessionDetail({ session, onBack, className }: SessionDetailProps) {
  const statusConfig = getStatusConfig(session.status)
  const workTypeConfig = getWorkTypeConfig(session.workType)

  // Synthesize timeline from available data
  const events: TimelineEvent[] = [
    {
      id: 'started',
      label: 'Session started',
      timestamp: session.startedAt,
      type: 'info',
    },
  ]

  if (session.status === 'completed') {
    const endTime = new Date(new Date(session.startedAt).getTime() + session.duration * 1000)
    events.push({
      id: 'completed',
      label: 'Session completed',
      timestamp: endTime.toISOString(),
      type: 'success',
    })
  } else if (session.status === 'failed') {
    const endTime = new Date(new Date(session.startedAt).getTime() + session.duration * 1000)
    events.push({
      id: 'failed',
      label: 'Session failed',
      timestamp: endTime.toISOString(),
      type: 'error',
    })
  }

  return (
    <div className={cn('space-y-4 p-5', className)}>
      {onBack && (
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5 text-af-text-secondary">
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </Button>
      )}

      {/* Header */}
      <div className="flex items-center gap-3">
        <StatusDot status={session.status} showHeartbeat={session.status === 'working'} />
        <h1 className="text-lg font-semibold font-mono text-af-text-primary">
          {session.identifier}
        </h1>
        <Badge
          variant="outline"
          className={cn('text-xs', statusConfig.bgColor, statusConfig.textColor, 'border-transparent')}
        >
          {statusConfig.label}
        </Badge>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Left: Details */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Session Details</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div>
                <dt className="text-af-text-secondary">Work Type</dt>
                <dd className="mt-0.5">
                  <Badge
                    variant="outline"
                    className={cn(workTypeConfig.bgColor, workTypeConfig.color, 'border-transparent')}
                  >
                    {workTypeConfig.label}
                  </Badge>
                </dd>
              </div>
              <div>
                <dt className="text-af-text-secondary">Duration</dt>
                <dd className="mt-0.5 tabular-nums text-af-text-primary">{formatDuration(session.duration)}</dd>
              </div>
              <div>
                <dt className="text-af-text-secondary">Cost</dt>
                <dd className="mt-0.5 tabular-nums font-mono text-af-text-primary">
                  {formatCost(session.costUsd)}
                </dd>
              </div>
              <div>
                <dt className="text-af-text-secondary">Started</dt>
                <dd className="mt-0.5 text-af-text-primary">
                  {new Date(session.startedAt).toLocaleString()}
                </dd>
              </div>
            </dl>

            <div className="mt-6">
              <TokenChart />
            </div>
          </CardContent>
        </Card>

        {/* Right: Timeline */}
        <Card>
          <CardHeader>
            <CardTitle>Timeline</CardTitle>
          </CardHeader>
          <CardContent>
            <SessionTimeline events={events} />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
