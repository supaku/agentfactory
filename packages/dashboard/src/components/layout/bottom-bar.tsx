'use client'

import { cn } from '../../lib/utils'
import { useStats } from '../../hooks/use-stats'
import { formatCost } from '../../lib/format'
import { Zap } from 'lucide-react'

interface BottomBarProps {
  className?: string
}

export function BottomBar({ className }: BottomBarProps) {
  const { data } = useStats()

  return (
    <footer
      className={cn(
        'flex h-8 items-center justify-between border-t border-af-surface-border/40 bg-af-bg-secondary/30 backdrop-blur-sm px-5',
        className
      )}
    >
      <div className="flex items-center gap-5 text-2xs font-body text-af-text-tertiary">
        <span>
          <span className="text-af-text-secondary tabular-nums">{data?.completedToday ?? 0}</span> completed
        </span>
        <span>
          <span className="text-af-text-secondary tabular-nums">{data?.availableCapacity ?? 0}</span> capacity
        </span>
        {data?.totalCostToday != null && (
          <span>
            <span className="text-af-accent font-mono tabular-nums">{formatCost(data.totalCostToday)}</span> today
          </span>
        )}
      </div>

      <a
        href="https://github.com/supaku/agentfactory"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1 text-2xs font-body text-af-text-tertiary hover:text-af-text-secondary transition-colors"
      >
        <Zap className="h-2.5 w-2.5" />
        AgentFactory
      </a>
    </footer>
  )
}
