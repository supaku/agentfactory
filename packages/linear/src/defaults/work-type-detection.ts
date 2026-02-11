/**
 * Default work type detection from prompt keywords.
 *
 * Scans prompt text for keywords that map to specific work types,
 * constrained to the set of valid work types for the current issue status.
 */

import type { AgentWorkType } from '../types.js'

/**
 * Default keywords that map to each work type.
 * More specific phrases come before generic ones within each work type.
 */
const DEFAULT_WORK_TYPE_KEYWORDS: Record<AgentWorkType, string[]> = {
  'backlog-creation': [
    'create backlog', 'write stories', 'create stories', 'create issues',
    'generate issues', 'make issues', 'turn into issues', 'break down',
    'break this down', 'split into issues', 'backlog writer', 'backlog-writer',
    'write backlog', 'populate backlog', 'write issues',
  ],
  'research': [
    'research', 'flesh out', 'write story', 'story details',
    'analyze requirements', 'acceptance criteria',
  ],
  'qa': [
    'qa ', 'test this', 'verify', 'validate', 'review the pr', 'check the pr',
  ],
  'inflight': [
    'continue', 'resume', 'pick up where', 'keep going',
  ],
  'acceptance': [
    'acceptance', 'final test', 'preview deploy', 'merge pr', 'merge the pr',
    'complete acceptance', 'finalize',
  ],
  'refinement': [
    'refine', 'rejection', 'feedback', 'rework',
  ],
  'development': [
    'implement', 'develop', 'build', 'code', 'work',
  ],
  'coordination': [
    'coordinate', 'orchestrate', 'run sub-issues', 'run children',
    'run all sub-issues', 'execute sub-issues', 'work on this',
  ],
  'qa-coordination': [
    'qa coordination', 'qa sub-issues', 'qa all sub-issues', 'qa this', 'qa issue',
  ],
  'acceptance-coordination': [
    'acceptance coordination', 'accept sub-issues', 'accept all sub-issues',
    'perform acceptance', 'complete acceptance',
  ],
}

/**
 * Priority order for work type detection.
 * More specific work types come first to ensure correct matching.
 */
const WORK_TYPE_PRIORITY_ORDER: AgentWorkType[] = [
  'coordination',
  'backlog-creation',
  'research',
  'qa',
  'inflight',
  'acceptance',
  'refinement',
  'development',
]

/**
 * Detect work type from prompt text, constrained to valid options.
 *
 * Scans the prompt for keywords and returns the first matching work type
 * that is also in the set of valid work types for the current issue status.
 *
 * @param prompt - The prompt text to scan
 * @param validWorkTypes - Work types valid for the current issue status
 * @returns The detected work type, or undefined if no match
 */
export function defaultDetectWorkTypeFromPrompt(
  prompt: string,
  validWorkTypes: AgentWorkType[]
): AgentWorkType | undefined {
  if (!prompt || validWorkTypes.length === 0) return undefined

  const lowerPrompt = prompt.toLowerCase()

  for (const workType of WORK_TYPE_PRIORITY_ORDER) {
    if (!validWorkTypes.includes(workType)) continue

    const keywords = DEFAULT_WORK_TYPE_KEYWORDS[workType]
    if (keywords?.some(keyword => lowerPrompt.includes(keyword))) {
      return workType
    }
  }

  return undefined
}
