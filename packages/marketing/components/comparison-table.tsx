import { cn } from '@supaku/agentfactory-dashboard'
import { Check, X } from 'lucide-react'

interface ComparisonRow {
  feature: string
  supaku: string | boolean
  spreadsheets: string | boolean
  freeCrms: string | boolean
}

const comparisonData: ComparisonRow[] = [
  {
    feature: 'Relationship health tracking',
    supaku: true,
    spreadsheets: false,
    freeCrms: false,
  },
  {
    feature: 'Smart reminders',
    supaku: true,
    spreadsheets: 'Manual',
    freeCrms: 'Basic',
  },
  {
    feature: 'AI messaging suggestions',
    supaku: true,
    spreadsheets: false,
    freeCrms: false,
  },
  {
    feature: 'Gift list management',
    supaku: true,
    spreadsheets: false,
    freeCrms: false,
  },
  {
    feature: 'Meeting prep briefings',
    supaku: true,
    spreadsheets: false,
    freeCrms: false,
  },
  {
    feature: 'Contact enrichment',
    supaku: true,
    spreadsheets: 'Manual',
    freeCrms: 'Partial',
  },
  {
    feature: 'Data privacy guarantee',
    supaku: true,
    spreadsheets: 'Depends',
    freeCrms: false,
  },
  {
    feature: 'Full data export',
    supaku: true,
    spreadsheets: true,
    freeCrms: 'Limited',
  },
]

function CellValue({ value }: { value: string | boolean }) {
  if (value === true) {
    return (
      <span className="inline-flex items-center justify-center h-6 w-6 rounded-full bg-af-teal/10">
        <Check className="h-4 w-4 text-af-teal" />
      </span>
    )
  }
  if (value === false) {
    return (
      <span className="inline-flex items-center justify-center h-6 w-6 rounded-full bg-red-500/10">
        <X className="h-4 w-4 text-red-400" />
      </span>
    )
  }
  return (
    <span className="text-sm text-af-text-tertiary font-body">{value}</span>
  )
}

export function ComparisonTable() {
  return (
    <>
      {/* Desktop Table */}
      <div className="hidden md:block">
        <div className="glass border border-af-surface-border rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-af-surface-border/50">
                <th className="text-left px-6 py-4 text-sm font-display font-semibold text-af-text-primary">
                  Feature
                </th>
                <th className="text-center px-6 py-4 text-sm font-display font-semibold text-af-accent">
                  Supaku Family
                </th>
                <th className="text-center px-6 py-4 text-sm font-display font-semibold text-af-text-secondary">
                  Spreadsheets
                </th>
                <th className="text-center px-6 py-4 text-sm font-display font-semibold text-af-text-secondary">
                  Free CRMs
                </th>
              </tr>
            </thead>
            <tbody>
              {comparisonData.map((row, i) => (
                <tr
                  key={row.feature}
                  className={cn(
                    'border-b border-af-surface-border/30 last:border-b-0',
                    i % 2 === 0 ? 'bg-transparent' : 'bg-af-surface/20'
                  )}
                >
                  <td className="px-6 py-4 text-sm text-af-text-primary font-body">
                    {row.feature}
                  </td>
                  <td className="px-6 py-4 text-center">
                    <div className="flex justify-center">
                      <CellValue value={row.supaku} />
                    </div>
                  </td>
                  <td className="px-6 py-4 text-center">
                    <div className="flex justify-center">
                      <CellValue value={row.spreadsheets} />
                    </div>
                  </td>
                  <td className="px-6 py-4 text-center">
                    <div className="flex justify-center">
                      <CellValue value={row.freeCrms} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile Cards */}
      <div className="md:hidden space-y-3">
        {comparisonData.map((row) => (
          <div
            key={row.feature}
            className="glass border border-af-surface-border/50 rounded-xl p-4"
          >
            <p className="text-sm font-display font-semibold text-af-text-primary mb-3">
              {row.feature}
            </p>
            <div className="grid grid-cols-3 gap-2">
              <div className="text-center">
                <p className="text-2xs text-af-accent font-body mb-1.5 uppercase tracking-wider">
                  Supaku
                </p>
                <div className="flex justify-center">
                  <CellValue value={row.supaku} />
                </div>
              </div>
              <div className="text-center">
                <p className="text-2xs text-af-text-tertiary font-body mb-1.5 uppercase tracking-wider">
                  Sheets
                </p>
                <div className="flex justify-center">
                  <CellValue value={row.spreadsheets} />
                </div>
              </div>
              <div className="text-center">
                <p className="text-2xs text-af-text-tertiary font-body mb-1.5 uppercase tracking-wider">
                  Free CRM
                </p>
                <div className="flex justify-center">
                  <CellValue value={row.freeCrms} />
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
