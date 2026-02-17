import { cn } from '@supaku/agentfactory-dashboard'

interface SectionProps {
  id?: string
  className?: string
  children: React.ReactNode
  title?: string
  subtitle?: string
}

export function Section({ id, className, children, title, subtitle }: SectionProps) {
  return (
    <section id={id} className={cn('py-24 px-4 sm:px-6 lg:px-8', className)}>
      <div className="mx-auto max-w-7xl">
        {(title || subtitle) && (
          <div className="mb-16 text-center">
            {title && (
              <h2 className="font-display text-3xl sm:text-4xl font-bold text-af-text-primary mb-4">
                {title}
              </h2>
            )}
            {subtitle && (
              <p className="text-lg text-af-text-secondary max-w-2xl mx-auto font-body">
                {subtitle}
              </p>
            )}
          </div>
        )}
        {children}
      </div>
    </section>
  )
}
