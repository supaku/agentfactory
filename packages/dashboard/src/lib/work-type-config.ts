export interface WorkTypeConfig {
  label: string
  color: string
  bgColor: string
  borderColor: string
}

const workTypes: Record<string, WorkTypeConfig> = {
  development: {
    label: 'Development',
    color: 'text-blue-400',
    bgColor: 'bg-blue-400/10',
    borderColor: 'border-blue-400/15',
  },
  bugfix: {
    label: 'Bug Fix',
    color: 'text-red-400',
    bgColor: 'bg-red-400/10',
    borderColor: 'border-red-400/15',
  },
  feature: {
    label: 'Feature',
    color: 'text-emerald-400',
    bgColor: 'bg-emerald-400/10',
    borderColor: 'border-emerald-400/15',
  },
  qa: {
    label: 'QA',
    color: 'text-purple-400',
    bgColor: 'bg-purple-400/10',
    borderColor: 'border-purple-400/15',
  },
  refactor: {
    label: 'Refactor',
    color: 'text-amber-400',
    bgColor: 'bg-amber-400/10',
    borderColor: 'border-amber-400/15',
  },
  review: {
    label: 'Review',
    color: 'text-cyan-400',
    bgColor: 'bg-cyan-400/10',
    borderColor: 'border-cyan-400/15',
  },
  docs: {
    label: 'Docs',
    color: 'text-indigo-400',
    bgColor: 'bg-indigo-400/10',
    borderColor: 'border-indigo-400/15',
  },
}

const defaultWorkType: WorkTypeConfig = {
  label: 'Development',
  color: 'text-af-text-secondary',
  bgColor: 'bg-af-text-secondary/8',
  borderColor: 'border-af-text-secondary/10',
}

export function getWorkTypeConfig(workType: string): WorkTypeConfig {
  return workTypes[workType.toLowerCase()] ?? defaultWorkType
}
