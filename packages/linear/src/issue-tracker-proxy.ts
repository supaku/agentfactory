/**
 * Platform-Agnostic Issue Tracker Proxy Interface
 *
 * Defines the contract between agents/governors and the centralized proxy.
 * Agents call these methods without knowing whether the backend is Linear,
 * Jira, GitHub Issues, or any future platform.
 *
 * The proxy translates these generic operations into platform-specific API calls.
 */

// ============================================================================
// Request / Response Types
// ============================================================================

/**
 * Every proxy request carries authentication and workspace context.
 */
export interface ProxyRequest {
  /** The operation to perform */
  method: IssueTrackerMethod
  /** Arguments for the operation (method-specific) */
  args: unknown[]
  /** Workspace/organization ID for multi-tenant routing */
  organizationId?: string
}

/**
 * Standard proxy response envelope.
 */
export interface ProxyResponse<T = unknown> {
  success: boolean
  data?: T
  error?: {
    code: string
    message: string
    retryable: boolean
  }
  /** Rate limit info from the upstream platform */
  quota?: {
    requestsRemaining?: number
    complexityRemaining?: number
    resetAt?: number
  }
}

// ============================================================================
// Supported Operations
// ============================================================================

/**
 * All operations that can be routed through the proxy.
 *
 * Named generically (not Linear-specific) so future platforms
 * can implement the same interface.
 */
export type IssueTrackerMethod =
  // Issue CRUD
  | 'getIssue'
  | 'updateIssue'
  | 'createIssue'
  // Comments
  | 'createComment'
  | 'getIssueComments'
  // Status management
  | 'getTeamStatuses'
  | 'updateIssueStatus'
  // Agent session management (platform-specific but abstracted)
  | 'createAgentActivity'
  | 'updateAgentSession'
  | 'createAgentSessionOnIssue'
  // Issue relations
  | 'createIssueRelation'
  | 'getIssueRelations'
  | 'deleteIssueRelation'
  // Sub-issues
  | 'getSubIssues'
  | 'getSubIssueStatuses'
  | 'getSubIssueGraph'
  | 'isParentIssue'
  | 'isChildIssue'
  // Project queries
  | 'listProjectIssues'
  | 'getProjectRepositoryUrl'
  // Identity
  | 'getViewer'
  | 'getTeam'
  // Unassign
  | 'unassignIssue'

// ============================================================================
// Serialized Data Types (plain JSON, no lazy-loaded relations)
// ============================================================================

/**
 * Serialized issue — all relations pre-resolved to plain JSON.
 * No SDK-specific Promise fields or lazy loaders.
 */
export interface SerializedIssue {
  id: string
  identifier: string
  title: string
  description?: string
  url: string
  priority: number
  state?: { id: string; name: string; type: string }
  labels: Array<{ id: string; name: string }>
  assignee?: { id: string; name: string; email?: string } | null
  team?: { id: string; name: string; key: string }
  parent?: { id: string; identifier: string } | null
  project?: { id: string; name: string } | null
  createdAt: string
  updatedAt: string
}

/**
 * Serialized comment.
 */
export interface SerializedComment {
  id: string
  body: string
  createdAt: string
  updatedAt: string
  user?: { id: string; name: string } | null
}

/**
 * Serialized viewer (authenticated user).
 */
export interface SerializedViewer {
  id: string
  name: string
  email: string
}

/**
 * Serialized team.
 */
export interface SerializedTeam {
  id: string
  name: string
  key: string
}

// ============================================================================
// Proxy Health
// ============================================================================

/**
 * Health status for the proxy endpoint.
 */
export interface ProxyHealthStatus {
  /** Whether the proxy can process requests */
  healthy: boolean
  /** Circuit breaker state */
  circuitBreaker: {
    state: string
    failures: number
    msSinceOpened: number | null
  }
  /** Rate limiter status */
  rateLimiter: {
    availableTokens: number
  }
  /** Upstream platform quota from response headers */
  quota: {
    requestsRemaining: number | null
    complexityRemaining: number | null
    resetAt: number | null
    updatedAt: number
  }
}
