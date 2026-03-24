import { describe, it, expect } from 'vitest'
import { classifyQuery } from '../query-classifier.js'

describe('classifyQuery', () => {
  // ── Identifier detection ──────────────────────────────────────────

  describe('camelCase detection', () => {
    it('classifies camelCase as identifier', () => {
      const result = classifyQuery('handleRequest')
      expect(result.type).toBe('identifier')
      expect(result.alpha).toBe(0.25)
    })

    it('classifies multi-word camelCase as identifier', () => {
      const result = classifyQuery('getUserById')
      expect(result.type).toBe('identifier')
      expect(result.alpha).toBe(0.25)
    })
  })

  describe('snake_case detection', () => {
    it('classifies snake_case as identifier', () => {
      const result = classifyQuery('get_user_by_id')
      expect(result.type).toBe('identifier')
      expect(result.alpha).toBe(0.25)
    })

    it('classifies double snake_case as identifier', () => {
      const result = classifyQuery('handle_http_request')
      expect(result.type).toBe('identifier')
      expect(result.alpha).toBe(0.25)
    })
  })

  describe('PascalCase detection', () => {
    it('classifies PascalCase as identifier', () => {
      const result = classifyQuery('UserService')
      expect(result.type).toBe('identifier')
      expect(result.alpha).toBe(0.25)
    })

    it('classifies multi-word PascalCase as identifier', () => {
      const result = classifyQuery('HttpRequestHandler')
      expect(result.type).toBe('identifier')
      expect(result.alpha).toBe(0.25)
    })
  })

  describe('CONSTANT_CASE detection', () => {
    it('classifies CONSTANT_CASE as identifier', () => {
      const result = classifyQuery('MAX_RETRIES')
      expect(result.type).toBe('identifier')
      expect(result.alpha).toBe(0.25)
    })

    it('classifies single CONSTANT as identifier', () => {
      const result = classifyQuery('HTTP_TIMEOUT')
      expect(result.type).toBe('identifier')
      expect(result.alpha).toBe(0.25)
    })
  })

  describe('dot.notation detection', () => {
    it('classifies dot notation as identifier', () => {
      const result = classifyQuery('req.body')
      expect(result.type).toBe('identifier')
      expect(result.alpha).toBe(0.25)
    })

    it('classifies chained dot notation as identifier', () => {
      const result = classifyQuery('this.service.getUser')
      expect(result.type).toBe('identifier')
      expect(result.alpha).toBe(0.25)
    })
  })

  describe('operator tokens', () => {
    it('classifies :: operator token as identifier', () => {
      const result = classifyQuery('std::vector')
      expect(result.type).toBe('identifier')
      expect(result.alpha).toBe(0.25)
    })

    it('classifies -> operator token as identifier', () => {
      const result = classifyQuery('node->next')
      expect(result.type).toBe('identifier')
      expect(result.alpha).toBe(0.25)
    })
  })

  // ── Natural language detection ────────────────────────────────────

  describe('natural language queries', () => {
    it('classifies plain English as natural', () => {
      const result = classifyQuery('how to handle errors')
      expect(result.type).toBe('natural')
      expect(result.alpha).toBe(0.75)
    })

    it('classifies question-style query as natural', () => {
      const result = classifyQuery('authentication middleware for express')
      expect(result.type).toBe('natural')
      expect(result.alpha).toBe(0.75)
    })

    it('classifies descriptive query as natural', () => {
      const result = classifyQuery('database connection pooling strategy')
      expect(result.type).toBe('natural')
      expect(result.alpha).toBe(0.75)
    })

    it('classifies short natural query as natural', () => {
      const result = classifyQuery('error handling')
      expect(result.type).toBe('natural')
      expect(result.alpha).toBe(0.75)
    })
  })

  // ── Mixed queries ─────────────────────────────────────────────────

  describe('mixed queries', () => {
    it('classifies query with one identifier in natural context as mixed', () => {
      const result = classifyQuery('fix handleRequest error')
      expect(result.type).toBe('mixed')
      expect(result.alpha).toBe(0.55)
    })

    it('classifies query with identifier and natural words as mixed', () => {
      const result = classifyQuery('where is UserService defined')
      expect(result.type).toBe('mixed')
      expect(result.alpha).toBe(0.55)
    })

    it('classifies query mixing snake_case with natural as mixed', () => {
      const result = classifyQuery('update get_user_by_id function')
      expect(result.type).toBe('mixed')
      expect(result.alpha).toBe(0.55)
    })
  })

  // ── Edge cases ────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty query', () => {
      const result = classifyQuery('')
      expect(result.type).toBe('natural')
      expect(result.alpha).toBe(0.75)
    })

    it('handles single word that is not an identifier', () => {
      const result = classifyQuery('search')
      expect(result.type).toBe('natural')
      expect(result.alpha).toBe(0.75)
    })

    it('handles multiple identifiers', () => {
      const result = classifyQuery('handleRequest processData getUserById')
      expect(result.type).toBe('identifier')
      expect(result.alpha).toBe(0.25)
    })
  })
})
