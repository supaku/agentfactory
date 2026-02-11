'use client'

import { cn } from '../../lib/utils'
import { useStats } from '../../hooks/use-stats'
import { formatCost } from '../../lib/format'

interface BottomBarProps {
  className?: string
}

export function BottomBar({ className }: BottomBarProps) {
  const { data } = useStats()

  return (
    <footer
      className={cn(
        'flex h-8 items-center justify-between border-t border-af-surface-border bg-af-bg-secondary px-5',
        className
      )}
    >
      <div className="flex items-center gap-4 text-xs text-af-text-secondary">
        <span>
          Completed today:{' '}
          <span className="font-medium text-af-text-primary">{data?.completedToday ?? 0}</span>
        </span>
        <span>
          Capacity:{' '}
          <span className="font-medium text-af-text-primary">{data?.availableCapacity ?? 0}</span>
        </span>
        {data?.totalCostToday != null && (
          <span>
            Cost today:{' '}
            <span className="font-medium text-af-text-primary">
              {formatCost(data.totalCostToday)}
            </span>
          </span>
        )}
      </div>

      <a
        href="https://github.com/supaku/agentfactory"
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-af-text-secondary hover:text-af-text-primary transition-colors"
      >
        Powered by AgentFactory
      </a>
    </footer>
  )
}
