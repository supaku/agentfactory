/**
 * Shared Safety Rules
 *
 * Single source of truth for destructive command patterns that must be blocked
 * across all agent providers. Both Claude's `autonomousCanUseTool` callback and
 * Codex's approval bridge import from here.
 *
 * Adding a pattern here automatically enforces it for every provider.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SafetyDenyPattern {
  pattern: RegExp
  reason: string
}

export interface SafetyEvaluation {
  denied: boolean
  reason?: string
}

// ---------------------------------------------------------------------------
// Deny Patterns
// ---------------------------------------------------------------------------

/**
 * Hardcoded safety deny patterns — always active regardless of template config.
 * These protect agent-managed worktrees from accidental destruction.
 */
export const SAFETY_DENY_PATTERNS: SafetyDenyPattern[] = [
  // rm of filesystem root
  { pattern: /rm\s+(-[a-z]*f[a-z]*\s+)?\/\s*$/, reason: 'rm of filesystem root blocked' },
  // worktree remove/prune — orchestrator manages worktree lifecycle
  { pattern: /git\s+worktree\s+(remove|prune)/, reason: 'worktree remove/prune blocked per project rules' },
  // hard reset
  { pattern: /git\s+reset\s+--hard/, reason: 'reset --hard blocked' },
  // branch switching — agents must not change the checked-out branch
  { pattern: /git\s+(checkout|switch)\b/, reason: 'git checkout/switch blocked — agents must not change the checked-out branch' },
]

// ---------------------------------------------------------------------------
// Command Safety Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a shell command against the shared safety deny patterns.
 *
 * This covers the hardcoded patterns (rm root, worktree management, hard reset,
 * branch switching) and force-push logic (allow --force-with-lease on feature
 * branches, deny all other force pushes).
 *
 * Provider-specific logic (template permissions, code intelligence enforcement,
 * Linear MCP blocking, etc.) is NOT included here — each provider adds its own
 * layer on top.
 */
export function evaluateCommandSafety(command: string): SafetyEvaluation {
  const cmd = command.trim()
  if (!cmd) return { denied: false }

  // Check basic deny patterns
  for (const { pattern, reason } of SAFETY_DENY_PATTERNS) {
    if (pattern.test(cmd)) {
      return { denied: true, reason }
    }
  }

  // Force push — special handling for --force-with-lease exception
  if (/git\s+push\b/.test(cmd) && /(--force\b|-f\b)/.test(cmd)) {
    if (/--force-with-lease/.test(cmd)) {
      // --force-with-lease to main/master is still blocked
      if (/\b(main|master)\b/.test(cmd)) {
        return { denied: true, reason: 'force push to main/master blocked' }
      }
      // --force-with-lease on feature branches is allowed
      return { denied: false }
    }
    return { denied: true, reason: 'force push blocked — use --force-with-lease for safety' }
  }

  return { denied: false }
}

// ---------------------------------------------------------------------------
// Natural-Language Safety Instructions
// ---------------------------------------------------------------------------

/**
 * Build natural-language safety instructions for providers that need them
 * as persistent base instructions (e.g., Codex App Server).
 *
 * These mirror the programmatic deny patterns above in human-readable form.
 */
export function buildSafetyInstructions(): string {
  return `# Safety Rules

You are running in an AgentFactory-managed worktree. Follow these rules strictly:

1. NEVER run: rm -rf / (or any rm of the filesystem root)
2. NEVER run: git worktree remove, git worktree prune
3. NEVER run: git reset --hard
4. NEVER run: git push --force (use --force-with-lease on feature branches if needed)
5. NEVER run: git checkout <branch>, git switch <branch> (do not change the checked-out branch)
6. NEVER modify files in the .git directory
7. Commit changes with descriptive messages before reporting completion`
}
