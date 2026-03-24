import { describe, it, expect } from 'vitest'
import { PhaseContextInjector } from './phase-context-injector.js'
import type { TemplateContext } from '../templates/types.js'

describe('PhaseContextInjector', () => {
  const injector = new PhaseContextInjector()

  function makeContext(overrides?: Partial<TemplateContext>): TemplateContext {
    return {
      identifier: 'SUP-100',
      ...overrides,
    }
  }

  describe('inject', () => {
    it('sets phaseOutputs on a fresh context', () => {
      const context = makeContext()
      const phaseOutputs = {
        development: {
          prUrl: 'https://github.com/org/repo/pull/42',
          branch: 'feat/new-feature',
        },
      }
      const result = injector.inject(context, phaseOutputs)
      expect(result.phaseOutputs).toEqual({
        development: {
          prUrl: 'https://github.com/org/repo/pull/42',
          branch: 'feat/new-feature',
        },
      })
    })

    it('returns the same context reference (mutates in place)', () => {
      const context = makeContext()
      const result = injector.inject(context, { dev: { key: 'value' } })
      expect(result).toBe(context)
    })

    it('merges outputs from multiple phases', () => {
      const context = makeContext()
      const phaseOutputs = {
        development: { prUrl: 'https://github.com/org/repo/pull/42' },
        qa: { testsPassed: true, coverage: 85 },
      }
      const result = injector.inject(context, phaseOutputs)
      expect(result.phaseOutputs).toEqual({
        development: { prUrl: 'https://github.com/org/repo/pull/42' },
        qa: { testsPassed: true, coverage: 85 },
      })
    })

    it('preserves existing phaseOutputs on context', () => {
      const context = makeContext({
        phaseOutputs: {
          development: { prUrl: 'https://github.com/org/repo/pull/42' },
        },
      })
      const newOutputs = {
        qa: { testsPassed: true },
      }
      const result = injector.inject(context, newOutputs)
      expect(result.phaseOutputs).toEqual({
        development: { prUrl: 'https://github.com/org/repo/pull/42' },
        qa: { testsPassed: true },
      })
    })

    it('merges output keys within same phase', () => {
      const context = makeContext({
        phaseOutputs: {
          development: { prUrl: 'https://github.com/org/repo/pull/42' },
        },
      })
      const newOutputs = {
        development: { branch: 'feat/new-feature' },
      }
      const result = injector.inject(context, newOutputs)
      expect(result.phaseOutputs).toEqual({
        development: {
          prUrl: 'https://github.com/org/repo/pull/42',
          branch: 'feat/new-feature',
        },
      })
    })

    it('overwrites existing key within same phase', () => {
      const context = makeContext({
        phaseOutputs: {
          development: { prUrl: 'https://github.com/old/url' },
        },
      })
      const newOutputs = {
        development: { prUrl: 'https://github.com/new/url' },
      }
      const result = injector.inject(context, newOutputs)
      expect(result.phaseOutputs!.development.prUrl).toBe('https://github.com/new/url')
    })

    it('handles empty phaseOutputs input', () => {
      const context = makeContext()
      const result = injector.inject(context, {})
      expect(result.phaseOutputs).toEqual({})
    })

    it('handles complex nested JSON values', () => {
      const context = makeContext()
      const phaseOutputs = {
        analysis: {
          report: {
            files: ['a.ts', 'b.ts'],
            metrics: { lines: 500, coverage: 92.5 },
          },
        },
      }
      const result = injector.inject(context, phaseOutputs)
      expect(result.phaseOutputs!.analysis.report).toEqual({
        files: ['a.ts', 'b.ts'],
        metrics: { lines: 500, coverage: 92.5 },
      })
    })

    it('preserves other context fields untouched', () => {
      const context = makeContext({
        mentionContext: 'some mention',
        cycleCount: 2,
        strategy: 'normal',
      })
      injector.inject(context, { dev: { key: 'value' } })
      expect(context.identifier).toBe('SUP-100')
      expect(context.mentionContext).toBe('some mention')
      expect(context.cycleCount).toBe(2)
      expect(context.strategy).toBe('normal')
    })
  })
})
