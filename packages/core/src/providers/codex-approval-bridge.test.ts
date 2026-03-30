import { describe, it, expect } from 'vitest'
import {
  evaluateCommandApproval,
  evaluateFileChangeApproval,
  SAFETY_DENY_PATTERNS,
} from './codex-approval-bridge.js'
import type { CodexPermissionConfig } from '../templates/adapters.js'

// ---------------------------------------------------------------------------
// evaluateCommandApproval — Safety Deny Patterns
// ---------------------------------------------------------------------------

describe('evaluateCommandApproval', () => {
  describe('safety deny patterns (always enforced)', () => {
    it('blocks rm of filesystem root', () => {
      const result = evaluateCommandApproval('rm -rf / ')
      expect(result.action).toBe('decline')
      expect(result.reason).toContain('rm of filesystem root')
    })

    it('blocks rm -f /', () => {
      const result = evaluateCommandApproval('rm -f / ')
      expect(result.action).toBe('decline')
    })

    it('allows rm of normal directories', () => {
      const result = evaluateCommandApproval('rm -rf /tmp/test')
      expect(result.action).toBe('acceptForSession')
    })

    it('blocks git worktree remove', () => {
      const result = evaluateCommandApproval('git worktree remove /path/to/worktree')
      expect(result.action).toBe('decline')
      expect(result.reason).toContain('worktree remove/prune')
    })

    it('blocks git worktree prune', () => {
      const result = evaluateCommandApproval('git worktree prune')
      expect(result.action).toBe('decline')
      expect(result.reason).toContain('worktree remove/prune')
    })

    it('allows git worktree add', () => {
      const result = evaluateCommandApproval('git worktree add /path/to/worktree')
      expect(result.action).toBe('acceptForSession')
    })

    it('blocks git reset --hard', () => {
      const result = evaluateCommandApproval('git reset --hard HEAD')
      expect(result.action).toBe('decline')
      expect(result.reason).toContain('reset --hard')
    })

    it('allows git reset --soft', () => {
      const result = evaluateCommandApproval('git reset --soft HEAD~1')
      expect(result.action).toBe('acceptForSession')
    })

    it('blocks git push --force', () => {
      const result = evaluateCommandApproval('git push --force origin feature')
      expect(result.action).toBe('decline')
      expect(result.reason).toContain('force push blocked')
    })

    it('blocks git push -f', () => {
      const result = evaluateCommandApproval('git push -f origin feature')
      expect(result.action).toBe('decline')
    })

    it('allows --force-with-lease on feature branches', () => {
      const result = evaluateCommandApproval('git push --force-with-lease origin feature-branch')
      expect(result.action).toBe('acceptForSession')
    })

    it('blocks --force-with-lease on main', () => {
      const result = evaluateCommandApproval('git push --force-with-lease origin main')
      expect(result.action).toBe('decline')
      expect(result.reason).toContain('main/master')
    })

    it('blocks --force-with-lease on master', () => {
      const result = evaluateCommandApproval('git push --force-with-lease origin master')
      expect(result.action).toBe('decline')
    })

    it('blocks git checkout', () => {
      const result = evaluateCommandApproval('git checkout main')
      expect(result.action).toBe('decline')
      expect(result.reason).toContain('checkout/switch blocked')
    })

    it('blocks git switch', () => {
      const result = evaluateCommandApproval('git switch develop')
      expect(result.action).toBe('decline')
      expect(result.reason).toContain('checkout/switch blocked')
    })
  })

  describe('safe commands (default accept)', () => {
    it('accepts empty command', () => {
      const result = evaluateCommandApproval('')
      expect(result.action).toBe('acceptForSession')
    })

    it('accepts pnpm install', () => {
      const result = evaluateCommandApproval('pnpm install')
      expect(result.action).toBe('acceptForSession')
    })

    it('accepts git commit', () => {
      const result = evaluateCommandApproval('git commit -m "fix: something"')
      expect(result.action).toBe('acceptForSession')
    })

    it('accepts git push (no force)', () => {
      const result = evaluateCommandApproval('git push origin feature-branch')
      expect(result.action).toBe('acceptForSession')
    })

    it('accepts ls, cat, grep', () => {
      expect(evaluateCommandApproval('ls -la').action).toBe('acceptForSession')
      expect(evaluateCommandApproval('cat file.txt').action).toBe('acceptForSession')
      expect(evaluateCommandApproval('grep -r pattern .').action).toBe('acceptForSession')
    })
  })

  describe('template permission patterns', () => {
    const permissionConfig: CodexPermissionConfig = {
      allowedCommandPatterns: [/^pnpm\b/, /^git\s+commit\b/, /^git\s+push\b/],
      deniedCommandPatterns: [
        { pattern: /^npm\b/, reason: 'npm blocked by template' },
      ],
      allowFileEdits: true,
      allowFileWrites: true,
    }

    it('declines commands matching template deny patterns', () => {
      const result = evaluateCommandApproval('npm install', permissionConfig)
      expect(result.action).toBe('decline')
      expect(result.reason).toContain('npm blocked by template')
    })

    it('accepts commands matching template allow patterns', () => {
      const result = evaluateCommandApproval('pnpm install', permissionConfig)
      expect(result.action).toBe('acceptForSession')
    })

    it('declines commands not in allow list when allow patterns are defined', () => {
      const result = evaluateCommandApproval('cargo build', permissionConfig)
      expect(result.action).toBe('decline')
      expect(result.reason).toContain('not in allowed list')
    })

    it('safety patterns take precedence over template allow patterns', () => {
      // git checkout is allowed by template (matches git push pattern? no)
      // but blocked by safety
      const result = evaluateCommandApproval('git checkout main', permissionConfig)
      expect(result.action).toBe('decline')
      expect(result.reason).toContain('checkout/switch blocked')
    })
  })

  it('has the expected number of safety deny patterns', () => {
    // 4 patterns in the array + force push handled separately = 5 total deny cases
    expect(SAFETY_DENY_PATTERNS.length).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// evaluateFileChangeApproval
// ---------------------------------------------------------------------------

describe('evaluateFileChangeApproval', () => {
  const cwd = '/home/user/worktree'

  it('accepts file changes within worktree', () => {
    const result = evaluateFileChangeApproval('/home/user/worktree/src/index.ts', cwd)
    expect(result.action).toBe('acceptForSession')
  })

  it('blocks file changes outside worktree', () => {
    const result = evaluateFileChangeApproval('/etc/passwd', cwd)
    expect(result.action).toBe('decline')
    expect(result.reason).toContain('outside worktree')
  })

  it('blocks .git directory modifications', () => {
    const result = evaluateFileChangeApproval('/home/user/worktree/.git/config', cwd)
    expect(result.action).toBe('decline')
    expect(result.reason).toContain('.git directory')
  })

  it('blocks .git file at root', () => {
    const result = evaluateFileChangeApproval('/home/user/worktree/.git', cwd)
    expect(result.action).toBe('decline')
    expect(result.reason).toContain('.git directory')
  })

  it('allows files with .git in the name but not .git directory', () => {
    const result = evaluateFileChangeApproval('/home/user/worktree/.gitignore', cwd)
    expect(result.action).toBe('acceptForSession')
  })

  describe('template permission restrictions', () => {
    it('blocks file edits when template disallows', () => {
      const config: CodexPermissionConfig = {
        allowedCommandPatterns: [],
        deniedCommandPatterns: [],
        allowFileEdits: false,
        allowFileWrites: true,
      }
      const result = evaluateFileChangeApproval('/home/user/worktree/src/index.ts', cwd, config)
      expect(result.action).toBe('decline')
      expect(result.reason).toContain('file edits blocked')
    })

    it('blocks file writes when template disallows', () => {
      const config: CodexPermissionConfig = {
        allowedCommandPatterns: [],
        deniedCommandPatterns: [],
        allowFileEdits: true,
        allowFileWrites: false,
      }
      const result = evaluateFileChangeApproval('/home/user/worktree/src/index.ts', cwd, config)
      expect(result.action).toBe('decline')
      expect(result.reason).toContain('file writes blocked')
    })
  })
})
