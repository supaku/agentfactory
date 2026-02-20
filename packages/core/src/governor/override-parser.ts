/**
 * Override Parser Module
 *
 * Parses issue comments for structured human override directives.
 * Directives must appear at the start of a comment (case-insensitive)
 * and only non-bot comments are processed.
 */

// ============================================
// Types
// ============================================

/**
 * Supported override directive types
 */
export type OverrideDirectiveType = 'hold' | 'resume' | 'skip-qa' | 'decompose' | 'reassign' | 'priority'

/**
 * Priority levels for the PRIORITY directive
 */
export type OverridePriority = 'high' | 'medium' | 'low'

/**
 * A parsed override directive extracted from a comment
 */
export interface OverrideDirective {
  type: OverrideDirectiveType
  reason?: string
  priority?: OverridePriority
  commentId?: string
  userId?: string
  timestamp: number
}

/**
 * Information about a comment to be parsed for directives
 */
export interface CommentInfo {
  id: string
  body: string
  userId: string
  isBot: boolean
  createdAt: number
}

// ============================================
// Directive Patterns
// ============================================

/**
 * Regex patterns for each directive type.
 * All patterns are anchored to the start of the comment body (after trimming).
 * The HOLD pattern captures an optional reason after a dash or em-dash.
 * The PRIORITY pattern captures the priority level.
 */
const DIRECTIVE_PATTERNS: Array<{
  type: OverrideDirectiveType
  pattern: RegExp
}> = [
  // HOLD or HOLD — reason or HOLD - reason
  { type: 'hold', pattern: /^hold(?:\s*[—–-]\s*(.+))?$/i },
  // RESUME
  { type: 'resume', pattern: /^resume$/i },
  // SKIP QA or SKIP-QA
  { type: 'skip-qa', pattern: /^skip[\s-]+qa$/i },
  // DECOMPOSE
  { type: 'decompose', pattern: /^decompose$/i },
  // REASSIGN
  { type: 'reassign', pattern: /^reassign$/i },
  // PRIORITY: high|medium|low
  { type: 'priority', pattern: /^priority:\s*(high|medium|low)$/i },
]

// ============================================
// Parser Functions
// ============================================

/**
 * Parse a single comment for an override directive.
 *
 * Rules:
 * - Bot comments are always ignored (returns null)
 * - Only the first line of the comment is checked for a directive
 * - Directives are case-insensitive
 * - Returns null if no directive is found
 *
 * @param comment - The comment to parse
 * @returns The parsed directive, or null if no directive found
 */
export function parseOverrideDirective(comment: CommentInfo): OverrideDirective | null {
  // Ignore bot comments
  if (comment.isBot) {
    return null
  }

  // Take the first line of the comment body, trimmed
  const firstLine = comment.body.trim().split('\n')[0]?.trim()
  if (!firstLine) {
    return null
  }

  for (const { type, pattern } of DIRECTIVE_PATTERNS) {
    const match = firstLine.match(pattern)
    if (match) {
      const directive: OverrideDirective = {
        type,
        commentId: comment.id,
        userId: comment.userId,
        timestamp: comment.createdAt,
      }

      // Extract reason for HOLD directive
      if (type === 'hold' && match[1]) {
        directive.reason = match[1].trim()
      }

      // Extract priority level for PRIORITY directive
      if (type === 'priority' && match[1]) {
        directive.priority = match[1].toLowerCase() as OverridePriority
      }

      return directive
    }
  }

  return null
}

/**
 * Find the most recent override directive from a list of comments.
 *
 * Parses all comments (skipping bots) and returns the directive with
 * the latest timestamp. If no directive is found, returns null.
 *
 * @param comments - Array of comments to scan, in any order
 * @returns The most recent directive, or null if none found
 */
export function findLatestOverride(comments: CommentInfo[]): OverrideDirective | null {
  let latest: OverrideDirective | null = null

  for (const comment of comments) {
    const directive = parseOverrideDirective(comment)
    if (directive) {
      if (!latest || directive.timestamp > latest.timestamp) {
        latest = directive
      }
    }
  }

  return latest
}
