'use client'

import { cn } from '../../lib/utils'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Separator } from '../../components/ui/separator'
import { useStats } from '../../hooks/use-stats'
import { useWorkers } from '../../hooks/use-workers'
import { ProviderIcon } from '../../components/fleet/provider-icon'
import { StatusDot } from '../../components/fleet/status-dot'
import { CheckCircle2, AlertCircle, Settings2 } from 'lucide-react'

interface SettingsViewProps {
  className?: string
}

export function SettingsView({ className }: SettingsViewProps) {
  const { data: stats } = useStats()
  const { data: workersData } = useWorkers()

  const workers = workersData?.workers ?? []
  const hasWorkerAuth = workersData !== null

  return (
    <div className={cn('space-y-6 p-5 max-w-3xl', className)}>
      <div>
        <h1 className="text-lg font-semibold text-af-text-primary">Settings</h1>
        <p className="text-sm text-af-text-secondary">
          Configuration and integration status for your AgentFactory instance.
        </p>
      </div>

      {/* Integration Status */}
      <Card>
        <CardHeader>
          <CardTitle>Integration Status</CardTitle>
          <CardDescription>Connected services and API endpoints</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-4 w-4 text-af-status-success" />
              <div>
                <p className="text-sm text-af-text-primary">Linear Webhook</p>
                <p className="text-xs text-af-text-secondary font-mono">/webhook</p>
              </div>
            </div>
            <Badge variant="success">Connected</Badge>
          </div>

          <Separator />

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-4 w-4 text-af-status-success" />
              <div>
                <p className="text-sm text-af-text-primary">Public API</p>
                <p className="text-xs text-af-text-secondary font-mono">/api/public/stats</p>
              </div>
            </div>
            <Badge variant="success">Active</Badge>
          </div>

          <Separator />

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {hasWorkerAuth ? (
                <CheckCircle2 className="h-4 w-4 text-af-status-success" />
              ) : (
                <AlertCircle className="h-4 w-4 text-af-text-secondary" />
              )}
              <div>
                <p className="text-sm text-af-text-primary">Worker API</p>
                <p className="text-xs text-af-text-secondary font-mono">/api/workers</p>
              </div>
            </div>
            <Badge variant={hasWorkerAuth ? 'success' : 'secondary'}>
              {hasWorkerAuth ? 'Authenticated' : 'No Auth Key'}
            </Badge>
          </div>
        </CardContent>
      </Card>

      {/* Workers */}
      <Card>
        <CardHeader>
          <CardTitle>Workers</CardTitle>
          <CardDescription>
            {workers.length > 0
              ? `${workers.length} worker${workers.length !== 1 ? 's' : ''} registered`
              : 'No workers connected'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {workers.length === 0 ? (
            <p className="text-sm text-af-text-secondary">
              Workers will appear here once they register with the server.
            </p>
          ) : (
            <div className="space-y-3">
              {workers.map((worker) => (
                <div key={worker.id} className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <StatusDot status={worker.status === 'active' ? 'working' : 'stopped'} />
                    <div>
                      <p className="text-sm font-mono text-af-text-primary">
                        {worker.hostname ?? worker.id.slice(0, 8)}
                      </p>
                      <p className="text-xs text-af-text-secondary">
                        {worker.activeSessions}/{worker.capacity} slots
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <ProviderIcon provider={worker.provider} size={14} />
                    <Badge variant={worker.status === 'active' ? 'success' : 'secondary'}>
                      {worker.status}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Fleet Stats */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings2 className="h-4 w-4" />
            Fleet Configuration
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-af-text-secondary">Total Capacity</dt>
              <dd className="mt-0.5 text-af-text-primary font-medium">
                {stats?.availableCapacity ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-af-text-secondary">Workers Online</dt>
              <dd className="mt-0.5 text-af-text-primary font-medium">
                {stats?.workersOnline ?? '—'}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>
    </div>
  )
}
