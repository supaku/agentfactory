/**
 * Deployment Provider Types
 *
 * Shared types and provider interface for deployment status checking.
 * Platform-specific providers (Vercel, Netlify, etc.) implement DeployProvider.
 */

/**
 * Individual deployment status for an app
 */
export interface DeploymentStatus {
  /** The app name (e.g., "renseiai-social") */
  app: string
  /** Deployment state */
  state: 'success' | 'pending' | 'error' | 'failure'
  /** Status description (e.g., "Deployment has completed") */
  description: string
  /** Preview URL if available */
  targetUrl: string | null
  /** Full context string from the deployment platform */
  context: string
}

/**
 * Result of checking deployment status for a commit
 */
export interface DeploymentCheckResult {
  /** Whether all deployments succeeded */
  allSucceeded: boolean
  /** Whether any deployment failed */
  anyFailed: boolean
  /** Whether any deployment is still pending */
  anyPending: boolean
  /** Individual deployment statuses */
  statuses: DeploymentStatus[]
  /** The commit SHA that was checked */
  commitSha: string
  /** Overall state from the platform */
  overallState: string
}

/**
 * Options for checking deployment status
 */
export interface DeploymentCheckOptions {
  /** GitHub repository owner */
  owner?: string
  /** GitHub repository name */
  repo?: string
  /** Timeout for API calls in milliseconds */
  timeout?: number
}

/**
 * PR information found for an issue
 */
export interface IssuePRInfo {
  /** PR number */
  number: number
  /** Head commit SHA */
  headSha: string
  /** Branch name */
  branch: string
  /** PR title */
  title: string
  /** PR URL */
  url: string
}

/**
 * Deployment provider interface.
 *
 * Abstracts platform-specific deployment status checking.
 * Follows the AgentProvider pattern from providers/types.ts.
 */
export interface DeployProvider {
  /** Provider identifier (e.g., 'vercel', 'netlify') */
  readonly name: string

  /** Check deployment status for a specific commit SHA */
  checkDeployment(commitSha: string, options?: DeploymentCheckOptions): Promise<DeploymentCheckResult>

  /** Check deployment status for a PR number */
  checkPRDeployment(prNumber: number, options?: DeploymentCheckOptions): Promise<DeploymentCheckResult | null>

  /** Check deployment status for a Linear issue identifier */
  checkIssueDeployment(issueIdentifier: string, options?: DeploymentCheckOptions): Promise<(DeploymentCheckResult & { pr: IssuePRInfo }) | null>
}
