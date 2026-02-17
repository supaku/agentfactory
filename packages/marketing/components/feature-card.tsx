import { cn } from '@supaku/agentfactory-dashboard'
import type { LucideIcon } from 'lucide-react'

interface FeatureCardProps {
  icon: LucideIcon
  title: string
  description: string
  children?: React.ReactNode
  className?: string
}

export function FeatureCard({ icon: Icon, title, description, children, className }: FeatureCardProps) {
  return (
    <div
      className={cn(
        'glass border border-af-surface-border rounded-xl p-6 hover-glow group',
        className
      )}
    >
      <div className="flex items-center gap-3 mb-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-af-accent/10 text-af-accent">
          <Icon className="h-5 w-5" />
        </div>
        <h3 className="font-display text-lg font-semibold text-af-text-primary">{title}</h3>
      </div>
      <p className="text-sm text-af-text-secondary font-body leading-relaxed mb-5">
        {description}
      </p>
      {children && (
        <div className="mt-auto">
          {children}
        </div>
      )}
    </div>
  )
}
