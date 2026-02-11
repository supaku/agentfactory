import { cn } from '../../lib/utils'
import { formatTokens } from '../../lib/format'

interface TokenChartProps {
  inputTokens?: number
  outputTokens?: number
  className?: string
}

export function TokenChart({ inputTokens = 0, outputTokens = 0, className }: TokenChartProps) {
  const total = inputTokens + outputTokens
  if (total === 0) return null

  const inputPct = (inputTokens / total) * 100
  const outputPct = (outputTokens / total) * 100

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center justify-between text-xs text-af-text-secondary">
        <span>Token Usage</span>
        <span className="tabular-nums font-mono">{formatTokens(total)} total</span>
      </div>

      {/* Bar */}
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-af-bg-primary">
        <div
          className="bg-blue-400 transition-all"
          style={{ width: `${inputPct}%` }}
        />
        <div
          className="bg-af-accent transition-all"
          style={{ width: `${outputPct}%` }}
        />
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs">
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-blue-400" />
          <span className="text-af-text-secondary">Input</span>
          <span className="tabular-nums font-mono text-af-text-primary">{formatTokens(inputTokens)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-af-accent" />
          <span className="text-af-text-secondary">Output</span>
          <span className="tabular-nums font-mono text-af-text-primary">{formatTokens(outputTokens)}</span>
        </div>
      </div>
    </div>
  )
}
