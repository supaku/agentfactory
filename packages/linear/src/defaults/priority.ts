/**
 * Default priority values for each work type.
 *
 * Lower values = higher priority in the work queue.
 */

import type { AgentWorkType } from '../types.js'

/**
 * Get the default priority for a work type.
 *
 * Priority scale:
 *   1 = Urgent (reserved for future use)
 *   2 = High (QA, acceptance, coordination, inflight, refinement)
 *   3 = Normal (development, backlog-creation)
 *   4 = Low (research)
 *
 * @param workType - The work type to get priority for
 * @returns Priority value (lower = higher priority)
 */
export function defaultGetPriority(workType: AgentWorkType): number {
  switch (workType) {
    case 'qa':
    case 'acceptance':
    case 'refinement':
    case 'inflight':
    case 'coordination':
    case 'qa-coordination':
    case 'acceptance-coordination':
      return 2
    case 'backlog-creation':
    case 'development':
      return 3
    case 'research':
      return 4
  }
}
