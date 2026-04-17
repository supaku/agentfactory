import { describe, it, expect } from 'vitest'
import {
  evaluateCommandSafety,
  buildSafetyInstructions,
  SAFETY_DENY_PATTERNS,
} from './safety-rules.js'

// ---------------------------------------------------------------------------
// evaluateCommandSafety
// ---------------------------------------------------------------------------

describe('evaluateCommandSafety', () => {
  describe('deny patterns', () => {
    it('blocks rm of filesystem root', () => {
      const result = evaluateCommandSafety('rm -rf / ')
      expect(result.denied).toBe(true)
      expect(result.reason).toContain('rm of filesystem root')
    })

    it('blocks rm -f /', () => {
      const result = evaluateCommandSafety('rm -f / ')
      expect(result.denied).toBe(true)
    })

    it('allows rm of normal directories', () => {
      const result = evaluateCommandSafety('rm -rf /tmp/test')
      expect(result.denied).toBe(false)
    })

    it('blocks git worktree remove', () => {
      const result = evaluateCommandSafety('git worktree remove /path/to/worktree')
      expect(result.denied).toBe(true)
      expect(result.reason).toContain('worktree remove/prune')
    })

    it('blocks git worktree prune', () => {
      const result = evaluateCommandSafety('git worktree prune')
      expect(result.denied).toBe(true)
    })

    it('allows git worktree add', () => {
      const result = evaluateCommandSafety('git worktree add /path/to/worktree')
      expect(result.denied).toBe(false)
    })

    it('blocks git reset --hard', () => {
      const result = evaluateCommandSafety('git reset --hard HEAD')
      expect(result.denied).toBe(true)
      expect(result.reason).toContain('reset --hard')
    })

    it('allows git reset --soft', () => {
      const result = evaluateCommandSafety('git reset --soft HEAD~1')
      expect(result.denied).toBe(false)
    })

    it('blocks git checkout', () => {
      const result = evaluateCommandSafety('git checkout main')
      expect(result.denied).toBe(true)
      expect(result.reason).toContain('checkout/switch')
    })

    it('blocks git switch', () => {
      const result = evaluateCommandSafety('git switch feature-branch')
      expect(result.denied).toBe(true)
    })
  })

  describe('force push handling', () => {
    it('blocks plain force push', () => {
      const result = evaluateCommandSafety('git push --force origin feature')
      expect(result.denied).toBe(true)
      expect(result.reason).toContain('force push blocked')
    })

    it('blocks -f shorthand', () => {
      const result = evaluateCommandSafety('git push -f origin feature')
      expect(result.denied).toBe(true)
    })

    it('allows --force-with-lease on feature branches', () => {
      const result = evaluateCommandSafety('git push --force-with-lease origin feature-branch')
      expect(result.denied).toBe(false)
    })

    it('blocks --force-with-lease to main', () => {
      const result = evaluateCommandSafety('git push --force-with-lease origin main')
      expect(result.denied).toBe(true)
      expect(result.reason).toContain('main/master')
    })

    it('blocks --force-with-lease to master', () => {
      const result = evaluateCommandSafety('git push --force-with-lease origin master')
      expect(result.denied).toBe(true)
    })

    it('allows normal push', () => {
      const result = evaluateCommandSafety('git push origin feature-branch')
      expect(result.denied).toBe(false)
    })
  })

  describe('edge cases', () => {
    it('allows empty command', () => {
      const result = evaluateCommandSafety('')
      expect(result.denied).toBe(false)
    })

    it('allows whitespace-only command', () => {
      const result = evaluateCommandSafety('   ')
      expect(result.denied).toBe(false)
    })

    it('allows safe commands', () => {
      expect(evaluateCommandSafety('pnpm test').denied).toBe(false)
      expect(evaluateCommandSafety('git status').denied).toBe(false)
      expect(evaluateCommandSafety('git commit -m "fix"').denied).toBe(false)
      expect(evaluateCommandSafety('git push origin feature').denied).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// SAFETY_DENY_PATTERNS
// ---------------------------------------------------------------------------

describe('SAFETY_DENY_PATTERNS', () => {
  it('exports 4 base patterns (excluding force push which has special handling)', () => {
    expect(SAFETY_DENY_PATTERNS).toHaveLength(4)
  })

  it('each pattern has a reason', () => {
    for (const p of SAFETY_DENY_PATTERNS) {
      expect(p.reason).toBeTruthy()
      expect(p.pattern).toBeInstanceOf(RegExp)
    }
  })
})

// ---------------------------------------------------------------------------
// buildSafetyInstructions
// ---------------------------------------------------------------------------

describe('buildSafetyInstructions', () => {
  it('returns non-empty string', () => {
    const instructions = buildSafetyInstructions()
    expect(instructions).toBeTruthy()
    expect(typeof instructions).toBe('string')
  })

  it('covers all deny patterns in natural language', () => {
    const instructions = buildSafetyInstructions()
    expect(instructions).toContain('rm -rf')
    expect(instructions).toContain('worktree')
    expect(instructions).toContain('reset --hard')
    expect(instructions).toContain('push --force')
    expect(instructions).toContain('checkout')
    expect(instructions).toContain('.git')
  })
})
