import { describe, it, expect } from 'vitest'
import { PhaseOutputCollector } from './phase-output-collector.js'
import type { PhaseOutputDeclaration } from './workflow-types.js'

describe('PhaseOutputCollector', () => {
  const collector = new PhaseOutputCollector()

  describe('string marker parsing', () => {
    it('extracts a single string output', () => {
      const output = 'Some text <!-- PHASE_OUTPUT:prUrl=https://github.com/org/repo/pull/42 --> more text'
      const result = collector.collect(output)
      expect(result).toEqual({
        prUrl: 'https://github.com/org/repo/pull/42',
      })
    })

    it('extracts multiple string outputs', () => {
      const output = [
        '<!-- PHASE_OUTPUT:prUrl=https://github.com/org/repo/pull/42 -->',
        '<!-- PHASE_OUTPUT:branch=feature/my-branch -->',
        '<!-- PHASE_OUTPUT:status=success -->',
      ].join('\n')
      const result = collector.collect(output)
      expect(result).toEqual({
        prUrl: 'https://github.com/org/repo/pull/42',
        branch: 'feature/my-branch',
        status: 'success',
      })
    })

    it('handles empty value', () => {
      const output = '<!-- PHASE_OUTPUT:empty= -->'
      const result = collector.collect(output)
      expect(result).toEqual({ empty: '' })
    })

    it('handles whitespace in marker', () => {
      const output = '<!--  PHASE_OUTPUT:key=value  -->'
      const result = collector.collect(output)
      expect(result).toEqual({ key: 'value' })
    })

    it('uses last value when same key appears multiple times', () => {
      const output = [
        '<!-- PHASE_OUTPUT:key=first -->',
        '<!-- PHASE_OUTPUT:key=second -->',
      ].join('\n')
      const result = collector.collect(output)
      expect(result.key).toBe('second')
    })
  })

  describe('JSON marker parsing', () => {
    it('extracts a JSON object output', () => {
      const output = '<!-- PHASE_OUTPUT_JSON:config={"port":3000,"host":"localhost"} -->'
      const result = collector.collect(output)
      expect(result).toEqual({
        config: { port: 3000, host: 'localhost' },
      })
    })

    it('extracts a JSON array output', () => {
      const output = '<!-- PHASE_OUTPUT_JSON:files=["a.ts","b.ts","c.ts"] -->'
      const result = collector.collect(output)
      expect(result).toEqual({
        files: ['a.ts', 'b.ts', 'c.ts'],
      })
    })

    it('falls back to raw string on invalid JSON', () => {
      const output = '<!-- PHASE_OUTPUT_JSON:bad={not valid json} -->'
      const result = collector.collect(output)
      expect(result.bad).toBe('{not valid json}')
    })

    it('JSON marker overrides string marker for same key', () => {
      const output = [
        '<!-- PHASE_OUTPUT:data=string-value -->',
        '<!-- PHASE_OUTPUT_JSON:data={"complex":true} -->',
      ].join('\n')
      const result = collector.collect(output)
      expect(result.data).toEqual({ complex: true })
    })
  })

  describe('mixed markers', () => {
    it('extracts both string and JSON markers from same output', () => {
      const output = [
        'Agent completed successfully.',
        '<!-- PHASE_OUTPUT:prUrl=https://github.com/org/repo/pull/42 -->',
        '<!-- PHASE_OUTPUT:branch=feat/new-feature -->',
        '<!-- PHASE_OUTPUT_JSON:testResults={"passed":10,"failed":0} -->',
        'Done.',
      ].join('\n')
      const result = collector.collect(output)
      expect(result).toEqual({
        prUrl: 'https://github.com/org/repo/pull/42',
        branch: 'feat/new-feature',
        testResults: { passed: 10, failed: 0 },
      })
    })

    it('returns empty record when no markers present', () => {
      const output = 'Just some plain text with no markers at all.'
      const result = collector.collect(output)
      expect(result).toEqual({})
    })

    it('handles empty input', () => {
      const result = collector.collect('')
      expect(result).toEqual({})
    })
  })

  describe('validation with declarations', () => {
    it('passes validation for correct types', () => {
      const declarations: Record<string, PhaseOutputDeclaration> = {
        prUrl: { type: 'url', required: true },
        message: { type: 'string' },
      }
      const output = [
        '<!-- PHASE_OUTPUT:prUrl=https://github.com/org/repo/pull/42 -->',
        '<!-- PHASE_OUTPUT:message=All tests passed -->',
      ].join('\n')
      const result = collector.collect(output, declarations)
      expect(result.prUrl).toBe('https://github.com/org/repo/pull/42')
      expect(result.message).toBe('All tests passed')
    })

    it('throws on missing required output', () => {
      const declarations: Record<string, PhaseOutputDeclaration> = {
        prUrl: { type: 'url', required: true },
      }
      expect(() => collector.collect('no markers here', declarations)).toThrow(
        'Required phase output "prUrl" is missing',
      )
    })

    it('does not throw for missing optional output', () => {
      const declarations: Record<string, PhaseOutputDeclaration> = {
        prUrl: { type: 'url', required: false },
        message: { type: 'string' },
      }
      const result = collector.collect('no markers', declarations)
      expect(result).toEqual({})
    })

    it('throws on invalid URL format', () => {
      const declarations: Record<string, PhaseOutputDeclaration> = {
        prUrl: { type: 'url', required: true },
      }
      const output = '<!-- PHASE_OUTPUT:prUrl=not-a-url -->'
      expect(() => collector.collect(output, declarations)).toThrow(
        'expected a valid URL',
      )
    })

    it('throws on invalid boolean value', () => {
      const declarations: Record<string, PhaseOutputDeclaration> = {
        passed: { type: 'boolean', required: true },
      }
      const output = '<!-- PHASE_OUTPUT:passed=maybe -->'
      expect(() => collector.collect(output, declarations)).toThrow(
        'expected boolean',
      )
    })

    it('accepts string boolean "true"', () => {
      const declarations: Record<string, PhaseOutputDeclaration> = {
        passed: { type: 'boolean' },
      }
      const output = '<!-- PHASE_OUTPUT:passed=true -->'
      const result = collector.collect(output, declarations)
      expect(result.passed).toBe(true)
    })

    it('coerces string boolean "false"', () => {
      const declarations: Record<string, PhaseOutputDeclaration> = {
        passed: { type: 'boolean' },
      }
      const output = '<!-- PHASE_OUTPUT:passed=false -->'
      const result = collector.collect(output, declarations)
      expect(result.passed).toBe(false)
    })

    it('validates json type accepts objects', () => {
      const declarations: Record<string, PhaseOutputDeclaration> = {
        data: { type: 'json', required: true },
      }
      const output = '<!-- PHASE_OUTPUT_JSON:data={"key":"value"} -->'
      const result = collector.collect(output, declarations)
      expect(result.data).toEqual({ key: 'value' })
    })

    it('allows undeclared outputs to pass through', () => {
      const declarations: Record<string, PhaseOutputDeclaration> = {
        declared: { type: 'string' },
      }
      const output = [
        '<!-- PHASE_OUTPUT:declared=yes -->',
        '<!-- PHASE_OUTPUT:undeclared=also-yes -->',
      ].join('\n')
      const result = collector.collect(output, declarations)
      expect(result.declared).toBe('yes')
      expect(result.undeclared).toBe('also-yes')
    })
  })
})
