import { cn } from '../../lib/utils'
import { Inbox } from 'lucide-react'

interface EmptyStateProps {
  title?: string
  description?: string
  icon?: React.ReactNode
  className?: string
  children?: React.ReactNode
}

export function EmptyState({
  title = 'No data',
  description = 'Nothing to show yet.',
  icon,
  className,
  children,
}: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center py-12 text-center', className)}>
      <div className="mb-4 text-af-text-secondary">
        {icon ?? <Inbox className="h-10 w-10" />}
      </div>
      <h3 className="text-sm font-medium text-af-text-primary">{title}</h3>
      <p className="mt-1 text-sm text-af-text-secondary">{description}</p>
      {children && <div className="mt-4">{children}</div>}
    </div>
  )
}
