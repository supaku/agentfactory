import { describe, it, expect } from 'vitest'
import { parseOverrideDirective, findLatestOverride } from './override-parser.js'
import type { CommentInfo, OverrideDirective } from './override-parser.js'

// ============================================
// Helpers
// ============================================

function makeComment(overrides: Partial<CommentInfo> = {}): CommentInfo {
  return {
    id: 'comment-1',
    body: '',
    userId: 'user-1',
    isBot: false,
    createdAt: Date.now(),
    ...overrides,
  }
}

// ============================================
// Tests
// ============================================

describe('parseOverrideDirective', () => {
  describe('HOLD directive', () => {
    it('parses plain HOLD', () => {
      const comment = makeComment({ body: 'HOLD' })
      const result = parseOverrideDirective(comment)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('hold')
      expect(result!.reason).toBeUndefined()
    })

    it('parses HOLD with em-dash reason', () => {
      const comment = makeComment({ body: 'HOLD — waiting for design review' })
      const result = parseOverrideDirective(comment)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('hold')
      expect(result!.reason).toBe('waiting for design review')
    })

    it('parses HOLD with regular dash reason', () => {
      const comment = makeComment({ body: 'HOLD - need more info' })
      const result = parseOverrideDirective(comment)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('hold')
      expect(result!.reason).toBe('need more info')
    })

    it('parses HOLD with en-dash reason', () => {
      const comment = makeComment({ body: 'HOLD – performance concerns' })
      const result = parseOverrideDirective(comment)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('hold')
      expect(result!.reason).toBe('performance concerns')
    })

    it('parses HOLD case-insensitively', () => {
      const comment = makeComment({ body: 'hold' })
      const result = parseOverrideDirective(comment)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('hold')
    })

    it('parses Hold (mixed case)', () => {
      const comment = makeComment({ body: 'Hold — mixed case' })
      const result = parseOverrideDirective(comment)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('hold')
      expect(result!.reason).toBe('mixed case')
    })
  })

  describe('RESUME directive', () => {
    it('parses RESUME', () => {
      const comment = makeComment({ body: 'RESUME' })
      const result = parseOverrideDirective(comment)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('resume')
    })

    it('parses resume (lowercase)', () => {
      const comment = makeComment({ body: 'resume' })
      const result = parseOverrideDirective(comment)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('resume')
    })
  })

  describe('SKIP QA directive', () => {
    it('parses SKIP QA', () => {
      const comment = makeComment({ body: 'SKIP QA' })
      const result = parseOverrideDirective(comment)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('skip-qa')
    })

    it('parses skip qa (lowercase)', () => {
      const comment = makeComment({ body: 'skip qa' })
      const result = parseOverrideDirective(comment)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('skip-qa')
    })

    it('handles extra whitespace between SKIP and QA', () => {
      const comment = makeComment({ body: 'SKIP   QA' })
      const result = parseOverrideDirective(comment)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('skip-qa')
    })

    it('parses SKIP-QA (hyphenated)', () => {
      const comment = makeComment({ body: 'SKIP-QA' })
      const result = parseOverrideDirective(comment)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('skip-qa')
    })

    it('parses skip-qa (hyphenated lowercase)', () => {
      const comment = makeComment({ body: 'skip-qa' })
      const result = parseOverrideDirective(comment)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('skip-qa')
    })
  })

  describe('DECOMPOSE directive', () => {
    it('parses DECOMPOSE', () => {
      const comment = makeComment({ body: 'DECOMPOSE' })
      const result = parseOverrideDirective(comment)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('decompose')
    })

    it('parses decompose (lowercase)', () => {
      const comment = makeComment({ body: 'decompose' })
      const result = parseOverrideDirective(comment)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('decompose')
    })
  })

  describe('REASSIGN directive', () => {
    it('parses REASSIGN', () => {
      const comment = makeComment({ body: 'REASSIGN' })
      const result = parseOverrideDirective(comment)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('reassign')
    })

    it('parses Reassign (mixed case)', () => {
      const comment = makeComment({ body: 'Reassign' })
      const result = parseOverrideDirective(comment)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('reassign')
    })
  })

  describe('PRIORITY directive', () => {
    it('parses PRIORITY: high', () => {
      const comment = makeComment({ body: 'PRIORITY: high' })
      const result = parseOverrideDirective(comment)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('priority')
      expect(result!.priority).toBe('high')
    })

    it('parses PRIORITY: medium', () => {
      const comment = makeComment({ body: 'PRIORITY: medium' })
      const result = parseOverrideDirective(comment)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('priority')
      expect(result!.priority).toBe('medium')
    })

    it('parses PRIORITY: low', () => {
      const comment = makeComment({ body: 'PRIORITY: low' })
      const result = parseOverrideDirective(comment)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('priority')
      expect(result!.priority).toBe('low')
    })

    it('parses priority case-insensitively', () => {
      const comment = makeComment({ body: 'priority: HIGH' })
      const result = parseOverrideDirective(comment)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('priority')
      expect(result!.priority).toBe('high')
    })

    it('handles extra whitespace after colon', () => {
      const comment = makeComment({ body: 'PRIORITY:   high' })
      const result = parseOverrideDirective(comment)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('priority')
      expect(result!.priority).toBe('high')
    })
  })

  describe('bot filtering', () => {
    it('ignores bot comments', () => {
      const comment = makeComment({ body: 'HOLD', isBot: true })
      const result = parseOverrideDirective(comment)
      expect(result).toBeNull()
    })

    it('ignores bot comments for all directive types', () => {
      const directives = ['HOLD', 'RESUME', 'SKIP QA', 'DECOMPOSE', 'REASSIGN', 'PRIORITY: high']
      for (const body of directives) {
        const comment = makeComment({ body, isBot: true })
        const result = parseOverrideDirective(comment)
        expect(result).toBeNull()
      }
    })
  })

  describe('no directive found', () => {
    it('returns null for empty body', () => {
      const comment = makeComment({ body: '' })
      expect(parseOverrideDirective(comment)).toBeNull()
    })

    it('returns null for regular comment text', () => {
      const comment = makeComment({ body: 'This looks good, nice work!' })
      expect(parseOverrideDirective(comment)).toBeNull()
    })

    it('returns null for directive-like text not at start', () => {
      const comment = makeComment({ body: 'I think we should HOLD on this' })
      expect(parseOverrideDirective(comment)).toBeNull()
    })

    it('returns null for unsupported directives', () => {
      const comment = makeComment({ body: 'CANCEL' })
      expect(parseOverrideDirective(comment)).toBeNull()
    })

    it('returns null for PRIORITY with invalid level', () => {
      const comment = makeComment({ body: 'PRIORITY: urgent' })
      expect(parseOverrideDirective(comment)).toBeNull()
    })
  })

  describe('metadata extraction', () => {
    it('captures commentId and userId', () => {
      const comment = makeComment({
        id: 'comment-42',
        body: 'HOLD',
        userId: 'user-99',
        createdAt: 1700000000000,
      })
      const result = parseOverrideDirective(comment)
      expect(result).not.toBeNull()
      expect(result!.commentId).toBe('comment-42')
      expect(result!.userId).toBe('user-99')
      expect(result!.timestamp).toBe(1700000000000)
    })
  })

  describe('multiline comments', () => {
    it('only checks the first line for directives', () => {
      const comment = makeComment({
        body: 'HOLD — security concern\nThis needs review from the security team.\nPlease check the auth flow.',
      })
      const result = parseOverrideDirective(comment)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('hold')
      expect(result!.reason).toBe('security concern')
    })

    it('ignores directives on subsequent lines', () => {
      const comment = makeComment({
        body: 'Great work on this!\nHOLD\nNot really.',
      })
      expect(parseOverrideDirective(comment)).toBeNull()
    })
  })

  describe('whitespace handling', () => {
    it('trims leading whitespace from body', () => {
      const comment = makeComment({ body: '  HOLD  ' })
      const result = parseOverrideDirective(comment)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('hold')
    })

    it('trims whitespace-only body', () => {
      const comment = makeComment({ body: '   ' })
      expect(parseOverrideDirective(comment)).toBeNull()
    })
  })
})

describe('findLatestOverride', () => {
  it('returns null for empty comment list', () => {
    expect(findLatestOverride([])).toBeNull()
  })

  it('returns null when no comments contain directives', () => {
    const comments: CommentInfo[] = [
      makeComment({ body: 'Looks good!' }),
      makeComment({ body: 'Nice work' }),
    ]
    expect(findLatestOverride(comments)).toBeNull()
  })

  it('returns the only directive found', () => {
    const comments: CommentInfo[] = [
      makeComment({ body: 'Looks good!', createdAt: 1000 }),
      makeComment({ body: 'HOLD', createdAt: 2000 }),
      makeComment({ body: 'What about tests?', createdAt: 3000 }),
    ]
    const result = findLatestOverride(comments)
    expect(result).not.toBeNull()
    expect(result!.type).toBe('hold')
    expect(result!.timestamp).toBe(2000)
  })

  it('returns the most recent directive when multiple exist', () => {
    const comments: CommentInfo[] = [
      makeComment({ id: 'c1', body: 'HOLD', createdAt: 1000 }),
      makeComment({ id: 'c2', body: 'RESUME', createdAt: 2000 }),
      makeComment({ id: 'c3', body: 'HOLD — second hold', createdAt: 3000 }),
    ]
    const result = findLatestOverride(comments)
    expect(result).not.toBeNull()
    expect(result!.type).toBe('hold')
    expect(result!.reason).toBe('second hold')
    expect(result!.timestamp).toBe(3000)
  })

  it('returns the most recent directive regardless of order', () => {
    // Comments may be passed in any order
    const comments: CommentInfo[] = [
      makeComment({ id: 'c3', body: 'DECOMPOSE', createdAt: 3000 }),
      makeComment({ id: 'c1', body: 'HOLD', createdAt: 1000 }),
      makeComment({ id: 'c2', body: 'RESUME', createdAt: 5000 }),
    ]
    const result = findLatestOverride(comments)
    expect(result).not.toBeNull()
    expect(result!.type).toBe('resume')
    expect(result!.timestamp).toBe(5000)
  })

  it('skips bot comments when finding latest', () => {
    const comments: CommentInfo[] = [
      makeComment({ body: 'HOLD', createdAt: 1000, isBot: false }),
      makeComment({ body: 'RESUME', createdAt: 2000, isBot: true }),
    ]
    const result = findLatestOverride(comments)
    expect(result).not.toBeNull()
    expect(result!.type).toBe('hold')
    expect(result!.timestamp).toBe(1000)
  })
})
