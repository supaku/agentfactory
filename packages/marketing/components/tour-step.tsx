import { cn } from '@supaku/agentfactory-dashboard'
import type { LucideIcon } from 'lucide-react'

interface TourStepProps {
  icon: LucideIcon
  stepNumber: number
  title: string
  description: string
  children: React.ReactNode
  reverse?: boolean
  className?: string
}

export function TourStep({ icon: Icon, stepNumber, title, description, children, reverse = false, className }: TourStepProps) {
  return (
    <div className={cn('flex flex-col gap-8 lg:flex-row items-center', reverse && 'lg:flex-row-reverse', className)}>
      {/* Text side */}
      <div className="space-y-4 lg:w-1/2">
        <div className="inline-flex items-center gap-2 text-af-accent">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-af-accent/10 text-xs font-bold font-display">
            {stepNumber}
          </span>
          <span className="text-xs font-medium font-body uppercase tracking-wider">Step {stepNumber}</span>
        </div>
        <div className="flex items-center gap-3">
          <Icon className="h-6 w-6 text-af-accent" />
          <h3 className="font-display text-2xl font-bold text-af-text-primary">{title}</h3>
        </div>
        <p className="text-af-text-secondary font-body leading-relaxed">
          {description}
        </p>
      </div>

      {/* Demo card side */}
      <div className="glass border border-af-surface-border rounded-xl p-6 glow-soft lg:w-1/2">
        {children}
      </div>
    </div>
  )
}
