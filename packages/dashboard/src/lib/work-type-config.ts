export interface WorkTypeConfig {
  label: string
  color: string
  bgColor: string
}

const workTypes: Record<string, WorkTypeConfig> = {
  development: {
    label: 'Development',
    color: 'text-blue-400',
    bgColor: 'bg-blue-400/10',
  },
  bugfix: {
    label: 'Bug Fix',
    color: 'text-red-400',
    bgColor: 'bg-red-400/10',
  },
  feature: {
    label: 'Feature',
    color: 'text-emerald-400',
    bgColor: 'bg-emerald-400/10',
  },
  qa: {
    label: 'QA',
    color: 'text-purple-400',
    bgColor: 'bg-purple-400/10',
  },
  refactor: {
    label: 'Refactor',
    color: 'text-amber-400',
    bgColor: 'bg-amber-400/10',
  },
  review: {
    label: 'Review',
    color: 'text-cyan-400',
    bgColor: 'bg-cyan-400/10',
  },
  docs: {
    label: 'Docs',
    color: 'text-indigo-400',
    bgColor: 'bg-indigo-400/10',
  },
}

const defaultWorkType: WorkTypeConfig = {
  label: 'Development',
  color: 'text-af-text-secondary',
  bgColor: 'bg-af-text-secondary/10',
}

export function getWorkTypeConfig(workType: string): WorkTypeConfig {
  return workTypes[workType.toLowerCase()] ?? defaultWorkType
}
