import { describe, it, expect } from 'vitest'
import { effortToClaudeOptions, effortToCodexOptions, effortToGeminiOptions, extractProviderConfig } from './effort.js'
import type { EffortLevel } from './profiles.js'

describe('effortToClaudeOptions', () => {
  it.each<[EffortLevel, string]>([
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['xhigh', 'xhigh'],
  ])('maps %s to Claude effort %s', (input, expected) => {
    expect(effortToClaudeOptions(input)).toEqual({ effort: expected })
  })
})

describe('effortToCodexOptions', () => {
  it.each<[EffortLevel, string]>([
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['xhigh', 'xhigh'],
  ])('maps %s to Codex reasoningEffort %s', (input, expected) => {
    expect(effortToCodexOptions(input)).toEqual({ reasoningEffort: expected })
  })
})

describe('effortToGeminiOptions', () => {
  it.each<[EffortLevel, number]>([
    ['low', 4096],
    ['medium', 16384],
    ['high', 32768],
    ['xhigh', 65536],
  ])('maps %s to Gemini thinkingBudget %d', (input, expected) => {
    expect(effortToGeminiOptions(input)).toEqual({ thinkingBudget: expected })
  })
})

describe('extractProviderConfig', () => {
  const profile = {
    openai: { serviceTier: 'fast' },
    anthropic: { speed: 'fast' },
    gemini: { temperature: 0.2 },
  }

  it('maps codex to openai config', () => {
    expect(extractProviderConfig(profile, 'codex')).toEqual({ serviceTier: 'fast' })
  })

  it('maps claude to anthropic config', () => {
    expect(extractProviderConfig(profile, 'claude')).toEqual({ speed: 'fast' })
  })

  it('maps a2a to gemini config', () => {
    expect(extractProviderConfig(profile, 'a2a')).toEqual({ temperature: 0.2 })
  })

  it('returns undefined for unknown provider', () => {
    expect(extractProviderConfig(profile, 'unknown')).toBeUndefined()
  })

  it('returns undefined when config block is missing', () => {
    expect(extractProviderConfig({}, 'codex')).toBeUndefined()
  })
})
