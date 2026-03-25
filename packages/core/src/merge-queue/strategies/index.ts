/**
 * Merge Strategies Module
 *
 * Factory and exports for pluggable merge strategies (rebase, merge, squash).
 */

export type { MergeStrategy, MergeContext, PrepareResult, MergeResult } from './types.js'
export { RebaseStrategy } from './rebase-strategy.js'
export { MergeCommitStrategy } from './merge-commit-strategy.js'
export { SquashStrategy } from './squash-strategy.js'

import type { MergeStrategy } from './types.js'
import { RebaseStrategy } from './rebase-strategy.js'
import { MergeCommitStrategy } from './merge-commit-strategy.js'
import { SquashStrategy } from './squash-strategy.js'

/**
 * Create a merge strategy by name.
 *
 * @param name - Strategy name: 'rebase', 'merge', or 'squash'
 * @returns MergeStrategy instance
 * @throws Error if strategy name is unknown
 */
export function createMergeStrategy(name: 'rebase' | 'merge' | 'squash'): MergeStrategy {
  switch (name) {
    case 'rebase':
      return new RebaseStrategy()
    case 'merge':
      return new MergeCommitStrategy()
    case 'squash':
      return new SquashStrategy()
    default:
      throw new Error(`Unknown merge strategy: ${name}`)
  }
}
