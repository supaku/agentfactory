/**
 * Shared types for the server package
 *
 * AgentWorkType is re-exported from here until @renseiai/plugin-linear
 * provides it. Consumers should import from this module.
 */

/**
 * Type of agent work being performed based on issue status
 */
export type AgentWorkType =
  | 'research'
  | 'backlog-creation'
  | 'development'
  | 'inflight'
  | 'inflight-coordination'
  | 'qa'
  | 'acceptance'
  | 'refinement'
  | 'refinement-coordination'
  | 'coordination'
  | 'qa-coordination'
  | 'acceptance-coordination'
  | 'merge'
  | 'security'
