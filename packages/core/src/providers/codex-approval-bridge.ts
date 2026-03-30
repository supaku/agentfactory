/**
 * Codex Approval Bridge (SUP-1747)
 *
 * Evaluates Codex App Server `requestApproval` events against deny patterns
 * ported from Claude's `autonomousCanUseTool` callback (claude-provider.ts:33-112).
 *
 * When the Codex App Server's `approvalPolicy` is set to `'onRequest'`, every
 * tool execution flows through this bridge. The bridge auto-approves safe commands
 * and declines destructive patterns — giving Codex the same safety guardrails as Claude
 * without requiring human interaction.
 *
 * Architecture:
 *   App Server emits → requestApproval notification
 *   Approval Bridge evaluates → deny patterns + permission config
 *   Bridge responds → accept | decline | acceptForSession
 */

import type { CodexPermissionConfig } from '../templates/adapters.js'

// ---------------------------------------------------------------------------
// Approval Decision
// ---------------------------------------------------------------------------

export interface ApprovalDecision {
  action: 'accept' | 'decline' | 'acceptForSession'
  reason?: string
}

// ---------------------------------------------------------------------------
// Safety Deny Patterns (ported from claude-provider.ts:33-112)
// ---------------------------------------------------------------------------

interface DenyPattern {
  pattern: RegExp
  reason: string
}

/**
 * Hardcoded safety deny patterns — always active regardless of template config.
 * These mirror the deny-list in Claude's `autonomousCanUseTool` callback.
 */
export const SAFETY_DENY_PATTERNS: DenyPattern[] = [
  // 1. rm of filesystem root
  { pattern: /rm\s+(-[a-z]*f[a-z]*\s+)?\/\s*$/, reason: 'rm of filesystem root blocked' },
  // 2. worktree remove/prune — orchestrator manages worktree lifecycle
  { pattern: /git\s+worktree\s+(remove|prune)/, reason: 'worktree remove/prune blocked per project rules' },
  // 3. hard reset
  { pattern: /git\s+reset\s+--hard/, reason: 'reset --hard blocked' },
  // 4. force push (evaluated separately for --force-with-lease exception)
  // Handled in evaluateCommandApproval directly
  // 5. branch switching — agents must not change the checked-out branch
  { pattern: /git\s+(checkout|switch)\b/, reason: 'git checkout/switch blocked — agents must not change the checked-out branch' },
]

// ---------------------------------------------------------------------------
// Command Approval
// ---------------------------------------------------------------------------

/**
 * Evaluate a shell command against safety deny patterns and optional
 * template-level permission patterns.
 *
 * Evaluation order:
 *   1. Safety deny patterns (always checked first, cannot be overridden)
 *   2. Template deny patterns (from `tools.disallow`)
 *   3. Template allow patterns (from `tools.allow`, if present)
 *   4. Default: acceptForSession
 */
export function evaluateCommandApproval(
  command: string,
  permissionConfig?: CodexPermissionConfig,
): ApprovalDecision {
  const cmd = command.trim()
  if (!cmd) return { action: 'acceptForSession' }

  // --- Safety deny patterns (always enforced) ---

  // Check basic deny patterns
  for (const { pattern, reason } of SAFETY_DENY_PATTERNS) {
    if (pattern.test(cmd)) {
      return { action: 'decline', reason }
    }
  }

  // Force push — special handling for --force-with-lease exception
  if (/git\s+push\b/.test(cmd) && /(--force\b|-f\b)/.test(cmd)) {
    if (/--force-with-lease/.test(cmd)) {
      // --force-with-lease to main/master is still blocked
      if (/\b(main|master)\b/.test(cmd)) {
        return { action: 'decline', reason: 'force push to main/master blocked' }
      }
      // --force-with-lease on feature branches is allowed
      return { action: 'acceptForSession', reason: '--force-with-lease on feature branch allowed' }
    }
    return { action: 'decline', reason: 'force push blocked — use --force-with-lease for safety' }
  }

  // --- Template deny patterns (from tools.disallow) ---
  if (permissionConfig?.deniedCommandPatterns) {
    for (const { pattern, reason } of permissionConfig.deniedCommandPatterns) {
      if (pattern.test(cmd)) {
        return { action: 'decline', reason }
      }
    }
  }

  // --- Template allow patterns (from tools.allow) ---
  // If allow patterns are defined, only matching commands are accepted.
  // Commands that don't match any allow pattern are declined.
  if (permissionConfig?.allowedCommandPatterns && permissionConfig.allowedCommandPatterns.length > 0) {
    for (const pattern of permissionConfig.allowedCommandPatterns) {
      if (pattern.test(cmd)) {
        return { action: 'acceptForSession' }
      }
    }
    return { action: 'decline', reason: 'command not in allowed list' }
  }

  // Default: accept for session (auto-approve for remainder of session)
  return { action: 'acceptForSession' }
}

// ---------------------------------------------------------------------------
// File Change Approval
// ---------------------------------------------------------------------------

/**
 * Evaluate a file change (write/edit) against safety rules and optional
 * template-level permissions.
 */
export function evaluateFileChangeApproval(
  filePath: string,
  cwd: string,
  permissionConfig?: CodexPermissionConfig,
): ApprovalDecision {
  // Block writes outside worktree root
  if (!filePath.startsWith(cwd)) {
    return { action: 'decline', reason: 'file change outside worktree blocked' }
  }

  // Block .git directory modifications
  if (/\/\.git(\/|$)/.test(filePath)) {
    return { action: 'decline', reason: '.git directory modification blocked' }
  }

  // Template-level file permission restrictions
  if (permissionConfig) {
    if (!permissionConfig.allowFileEdits && filePath !== cwd) {
      return { action: 'decline', reason: 'file edits blocked by template' }
    }
    if (!permissionConfig.allowFileWrites && filePath !== cwd) {
      return { action: 'decline', reason: 'file writes blocked by template' }
    }
  }

  return { action: 'acceptForSession' }
}

/** Exported for testing */
export type { DenyPattern }
