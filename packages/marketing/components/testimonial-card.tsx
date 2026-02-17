import { cn } from '@supaku/agentfactory-dashboard'

interface TestimonialCardProps {
  quote: string
  name: string
  role: string
  className?: string
}

export function TestimonialCard({ quote, name, role, className }: TestimonialCardProps) {
  return (
    <div
      className={cn(
        'glass-subtle border border-af-surface-border rounded-xl p-6 glow-soft transition-all duration-300 hover:border-af-teal/20',
        className
      )}
    >
      <div className="mb-4 text-af-teal text-2xl font-display">&ldquo;</div>
      <blockquote className="text-sm text-af-text-secondary font-body leading-relaxed mb-6">
        {quote}
      </blockquote>
      <div className="flex items-center gap-3">
        <div className="h-9 w-9 rounded-full bg-af-surface-raised flex items-center justify-center text-af-text-tertiary text-xs font-display font-bold">
          {name.split(' ').map(n => n[0]).join('')}
        </div>
        <div>
          <p className="text-sm font-medium text-af-text-primary font-body">{name}</p>
          <p className="text-xs text-af-text-tertiary font-body">{role}</p>
        </div>
      </div>
    </div>
  )
}
