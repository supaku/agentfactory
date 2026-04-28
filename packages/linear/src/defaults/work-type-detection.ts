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
  'backlog-groomer': [
    'groom backlog', 'groom icebox', 'backlog groomer', 'backlog-groomer',
    'process icebox', 'triage icebox', 'icebox grooming',
  ],
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
    'coordinate', 'orchestrate', 'run sub-issues', 'run children',
    'run all sub-issues', 'execute sub-issues', 'work on this',
  ],
  'refinement-coordination': [
    'refinement coordination', 'refine sub-issues', 'refine all sub-issues',
    'triage failures', 'route feedback',
  ],
  'merge': [
    'merge queue', 'add to merge queue', 'enqueue merge', 'merge this',
  ],
  'security': [
    'security scan', 'security audit', 'vulnerability scan', 'sast',
    'dependency audit', 'run security', 'scan for vulnerabilities',
  ],
  'outcome-auditor': [
    'outcome audit', 'audit outcomes', 'audit accepted', 'delivery audit',
    'check delivered', 'verify delivery', 'outcome-auditor',
  ],
  'improvement-loop': [
    'improvement loop', 'run improvement loop', 'find patterns',
    'systemic patterns', 'meta-issues', 'improvement cycle',
  ],
  'ga-readiness': [
    'ga readiness', 'ga-readiness', 'ga ready', 'assess ga', 'ga check',
    'production readiness', 'ready for ga', 'ga assessment', 'pre-ga',
  ],
}

/**
 * Priority order for work type detection.
 * More specific work types come first to ensure correct matching.
 */
const WORK_TYPE_PRIORITY_ORDER: AgentWorkType[] = [
  'backlog-groomer',
  'backlog-creation',
  'research',
  'qa',
  'acceptance',
  'inflight',
  'refinement-coordination',
  'refinement',
  'ga-readiness',
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
