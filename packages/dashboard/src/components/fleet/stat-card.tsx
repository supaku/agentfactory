import { cn } from '../../lib/utils'
import { Skeleton } from '../../components/ui/skeleton'

interface StatCardProps {
  label: string
  value: string | number
  detail?: string
  icon?: React.ReactNode
  trend?: 'up' | 'down' | 'neutral'
  accent?: boolean
  loading?: boolean
  className?: string
}

export function StatCard({ label, value, detail, icon, accent, loading, className }: StatCardProps) {
  if (loading) {
    return (
      <div className={cn(
        'rounded-xl border border-af-surface-border/50 bg-af-surface/50 p-4',
        className
      )}>
        <div className="flex items-center justify-between">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-4 w-4 rounded" />
        </div>
        <Skeleton className="mt-3 h-8 w-16" />
        <Skeleton className="mt-1.5 h-3 w-20" />
      </div>
    )
  }

  return (
    <div className={cn(
      'group rounded-xl border border-af-surface-border/50 bg-af-surface/40 p-4 transition-all duration-300 hover-glow',
      accent && 'border-af-accent/15 bg-af-accent/[0.03]',
      className
    )}>
      <div className="flex items-center justify-between">
        <span className="text-2xs font-body font-medium uppercase tracking-wider text-af-text-tertiary">
          {label}
        </span>
        {icon && (
          <span className={cn(
            'text-af-text-tertiary transition-colors duration-300 group-hover:text-af-text-secondary',
            accent && 'text-af-accent/40 group-hover:text-af-accent/70'
          )}>
            {icon}
          </span>
        )}
      </div>
      <div className={cn(
        'mt-2 font-display text-2xl font-bold tabular-nums tracking-tight',
        accent ? 'text-af-accent' : 'text-af-text-primary'
      )}>
        {value}
      </div>
      {detail && (
        <p className="mt-1 text-2xs font-body text-af-text-tertiary">{detail}</p>
      )}
    </div>
  )
}
