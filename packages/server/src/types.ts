/**
 * Shared types for the server package
 *
 * AgentWorkType is re-exported from here until @supaku/agentfactory-linear
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
  | 'qa'
  | 'acceptance'
  | 'refinement'
  | 'coordination'
  | 'qa-coordination'
  | 'acceptance-coordination'
