'use client'

import { cn } from '../../lib/utils'
import { useStats } from '../../hooks/use-stats'
import { useSessions } from '../../hooks/use-sessions'
import { StatCard } from './stat-card'
import { AgentCard } from './agent-card'
import { EmptyState } from '../../components/shared/empty-state'
import { Skeleton } from '../../components/ui/skeleton'
import { formatCost } from '../../lib/format'
import { Users, Cpu, ListTodo, CheckCircle2, Gauge, DollarSign } from 'lucide-react'

interface FleetOverviewProps {
  className?: string
}

export function FleetOverview({ className }: FleetOverviewProps) {
  const { data: stats, isLoading: statsLoading } = useStats()
  const { data: sessionsData, isLoading: sessionsLoading } = useSessions()

  const sessions = sessionsData?.sessions ?? []
  const activeSessions = sessions.filter((s) => s.status === 'working' || s.status === 'queued')

  return (
    <div className={cn('space-y-8 p-6', className)}>
      {/* Section: Fleet Metrics */}
      <div>
        <div className="mb-4 flex items-center gap-3">
          <h2 className="font-display text-lg font-bold text-af-text-primary tracking-tight">
            Fleet Overview
          </h2>
          {!statsLoading && stats && (
            <span className="text-2xs font-body text-af-text-tertiary tabular-nums">
              {stats.workersOnline} worker{stats.workersOnline !== 1 ? 's' : ''} online
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard
            label="Workers"
            value={stats?.workersOnline ?? 0}
            icon={<Users className="h-3.5 w-3.5" />}
            loading={statsLoading}
          />
          <StatCard
            label="Active"
            value={stats?.agentsWorking ?? 0}
            icon={<Cpu className="h-3.5 w-3.5" />}
            accent
            loading={statsLoading}
          />
          <StatCard
            label="Queued"
            value={stats?.queueDepth ?? 0}
            icon={<ListTodo className="h-3.5 w-3.5" />}
            loading={statsLoading}
          />
          <StatCard
            label="Completed"
            value={stats?.completedToday ?? 0}
            icon={<CheckCircle2 className="h-3.5 w-3.5" />}
            loading={statsLoading}
          />
          <StatCard
            label="Capacity"
            value={stats?.availableCapacity ?? 0}
            icon={<Gauge className="h-3.5 w-3.5" />}
            loading={statsLoading}
          />
          <StatCard
            label="Cost"
            value={formatCost(stats?.totalCostToday)}
            icon={<DollarSign className="h-3.5 w-3.5" />}
            loading={statsLoading}
          />
        </div>
      </div>

      {/* Section: Active Sessions */}
      <div>
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="font-display text-lg font-bold text-af-text-primary tracking-tight">
              Sessions
            </h2>
            <span className="rounded-full bg-af-surface/60 px-2 py-0.5 text-2xs font-body font-medium tabular-nums text-af-text-secondary">
              {sessions.length}
            </span>
          </div>
          {activeSessions.length > 0 && (
            <span className="text-2xs font-body text-af-teal">
              {activeSessions.length} active
            </span>
          )}
        </div>

        {sessionsLoading ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[130px] rounded-xl" />
            ))}
          </div>
        ) : sessions.length === 0 ? (
          <EmptyState
            title="No active sessions"
            description="Sessions will appear here when agents start working."
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {sessions.map((session, i) => (
              <div
                key={session.id}
                className="animate-fade-in"
                style={{ animationDelay: `${i * 50}ms` }}
              >
                <AgentCard session={session} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
