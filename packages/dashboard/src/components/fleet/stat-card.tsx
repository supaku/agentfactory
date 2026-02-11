import { cn } from '../../lib/utils'
import { Card } from '../../components/ui/card'
import { Skeleton } from '../../components/ui/skeleton'

interface StatCardProps {
  label: string
  value: string | number
  detail?: string
  icon?: React.ReactNode
  trend?: 'up' | 'down' | 'neutral'
  loading?: boolean
  className?: string
}

export function StatCard({ label, value, detail, icon, loading, className }: StatCardProps) {
  if (loading) {
    return (
      <Card className={cn('p-4', className)}>
        <div className="flex items-center justify-between">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-4 w-4 rounded" />
        </div>
        <Skeleton className="mt-2 h-7 w-12" />
        <Skeleton className="mt-1 h-3 w-20" />
      </Card>
    )
  }

  return (
    <Card className={cn('p-4', className)}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-af-text-secondary">{label}</span>
        {icon && <span className="text-af-text-secondary">{icon}</span>}
      </div>
      <div className="mt-1.5 text-2xl font-bold tabular-nums text-af-text-primary">
        {value}
      </div>
      {detail && (
        <p className="mt-0.5 text-xs text-af-text-secondary">{detail}</p>
      )}
    </Card>
  )
}
