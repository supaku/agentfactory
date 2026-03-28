import { cn } from '../../lib/utils'

interface DeprecationBannerProps {
  message?: string
  ctaHref?: string
  onDismiss?: () => void
  className?: string
}

export function DeprecationBanner({
  message = 'This pipeline view is deprecated and will be removed in a future version.',
  ctaHref,
  onDismiss,
  className,
}: DeprecationBannerProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex items-center justify-between gap-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-200',
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <svg
          className="h-4 w-4 shrink-0 text-yellow-400"
          viewBox="0 0 16 16"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.75 3.75a.75.75 0 011.5 0v3.5a.75.75 0 01-1.5 0v-3.5zM8 11a1 1 0 100 2 1 1 0 000-2z" />
        </svg>
        <span>{message}</span>
        {ctaHref && (
          <a
            href={ctaHref}
            className="font-medium text-yellow-300 underline underline-offset-2 hover:text-yellow-100"
          >
            Learn more
          </a>
        )}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded p-1 text-yellow-400 hover:bg-yellow-500/20 hover:text-yellow-200"
          aria-label="Dismiss deprecation notice"
        >
          <svg className="h-4 w-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
          </svg>
        </button>
      )}
    </div>
  )
}
