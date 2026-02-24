/**
 * Tool Permission Adapters
 *
 * Translate abstract tool permissions to provider-native format.
 */

import type { ToolPermission, ToolPermissionAdapter } from './types.js'
import type { AgentProviderName } from '../providers/types.js'

/**
 * Claude Code tool permission adapter.
 *
 * Translates abstract permissions to Claude Code's format:
 *   { shell: "pnpm *" }  → "Bash(pnpm:*)"
 *   { shell: "git commit *" } → "Bash(git commit:*)"
 *   "user-input" → "AskUserQuestion"
 */
export class ClaudeToolPermissionAdapter implements ToolPermissionAdapter {
  translatePermissions(permissions: ToolPermission[]): string[] {
    return permissions.map(p => this.translateOne(p))
  }

  private translateOne(permission: ToolPermission): string {
    if (typeof permission === 'string') {
      if (permission === 'user-input') {
        return 'AskUserQuestion'
      }
      // Pass through other string permissions as-is
      return permission
    }

    if ('shell' in permission) {
      // Convert "pnpm *" → "Bash(pnpm:*)"
      // Convert "git commit *" → "Bash(git commit:*)"
      const pattern = permission.shell
      const spaceIndex = pattern.lastIndexOf(' ')
      if (spaceIndex === -1) {
        return `Bash(${pattern}:*)`
      }
      const command = pattern.substring(0, spaceIndex)
      const glob = pattern.substring(spaceIndex + 1)
      return `Bash(${command}:${glob})`
    }

    return String(permission)
  }
}

/**
 * OpenAI Codex tool permission adapter.
 *
 * Codex uses sandbox policies (--full-auto / workspace-write / read-only)
 * and TOML-based sandbox_permissions rather than per-tool allowlists.
 * Shell permissions are passed through as command patterns for documentation
 * and future granular support.
 *
 *   { shell: "pnpm *" }  → "shell:pnpm *"
 *   "user-input" → "user-input" (no-op — Codex exec is non-interactive)
 */
export class CodexToolPermissionAdapter implements ToolPermissionAdapter {
  translatePermissions(permissions: ToolPermission[]): string[] {
    return permissions.map(p => this.translateOne(p))
  }

  private translateOne(permission: ToolPermission): string {
    if (typeof permission === 'string') {
      return permission
    }

    if ('shell' in permission) {
      return `shell:${permission.shell}`
    }

    return String(permission)
  }
}

/**
 * Create a tool permission adapter for the given provider.
 */
export function createToolPermissionAdapter(provider: AgentProviderName): ToolPermissionAdapter {
  switch (provider) {
    case 'claude':
      return new ClaudeToolPermissionAdapter()
    case 'codex':
      return new CodexToolPermissionAdapter()
    case 'amp':
      return new ClaudeToolPermissionAdapter()
    default:
      return new ClaudeToolPermissionAdapter()
  }
}
