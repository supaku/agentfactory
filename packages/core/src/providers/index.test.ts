import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  resolveProviderName,
  resolveProviderWithSource,
  extractProviderFromLabels,
  extractProviderFromMention,
  PROVIDER_ALIASES,
  isValidProviderName,
} from './index.js'

describe('extractProviderFromLabels', () => {
  it('extracts provider from "provider:<name>" label', () => {
    expect(extractProviderFromLabels(['Bug', 'provider:codex', 'Feature'])).toBe('codex')
  })

  it('returns null when no provider label present', () => {
    expect(extractProviderFromLabels(['Bug', 'Feature'])).toBeNull()
  })

  it('resolves aliases in labels', () => {
    expect(extractProviderFromLabels(['provider:opus'])).toBe('claude')
    expect(extractProviderFromLabels(['provider:sonnet'])).toBe('claude')
    expect(extractProviderFromLabels(['provider:gemini'])).toBe('a2a')
  })

  it('is case-insensitive', () => {
    expect(extractProviderFromLabels(['Provider:Codex'])).toBe('codex')
    expect(extractProviderFromLabels(['PROVIDER:AMP'])).toBe('amp')
  })

  it('ignores invalid provider names', () => {
    expect(extractProviderFromLabels(['provider:invalid'])).toBeNull()
  })

  it('returns first match when multiple provider labels exist', () => {
    expect(extractProviderFromLabels(['provider:codex', 'provider:amp'])).toBe('codex')
  })

  it('handles empty array', () => {
    expect(extractProviderFromLabels([])).toBeNull()
  })
})

describe('extractProviderFromMention', () => {
  it('matches "use <provider>" pattern', () => {
    expect(extractProviderFromMention('please use codex for this')).toBe('codex')
  })

  it('matches "@<provider>" pattern', () => {
    expect(extractProviderFromMention('@codex handle this')).toBe('codex')
  })

  it('matches "provider:<provider>" pattern', () => {
    expect(extractProviderFromMention('run with provider:amp')).toBe('amp')
  })

  it('resolves aliases in mentions', () => {
    expect(extractProviderFromMention('use opus')).toBe('claude')
    expect(extractProviderFromMention('@sonnet')).toBe('claude')
    expect(extractProviderFromMention('provider:gemini')).toBe('a2a')
  })

  it('is case-insensitive', () => {
    expect(extractProviderFromMention('use Codex')).toBe('codex')
    expect(extractProviderFromMention('USE AMP')).toBe('amp')
  })

  it('returns null for invalid provider names', () => {
    expect(extractProviderFromMention('use invalid')).toBeNull()
  })

  it('returns null when no pattern matches', () => {
    expect(extractProviderFromMention('fix the bug in login')).toBeNull()
  })

  it('handles empty string', () => {
    expect(extractProviderFromMention('')).toBeNull()
  })
})

describe('resolveProviderWithSource — full cascade', () => {
  const envBackup: Record<string, string | undefined> = {}

  beforeEach(() => {
    // Save and clear relevant env vars
    for (const key of ['AGENT_PROVIDER', 'AGENT_PROVIDER_QA', 'AGENT_PROVIDER_DEVELOPMENT', 'AGENT_PROVIDER_SOCIAL', 'AGENT_PROVIDER_AGENT']) {
      envBackup[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    // Restore env vars
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  it('defaults to claude when no context provided', () => {
    const result = resolveProviderWithSource()
    expect(result).toEqual({ name: 'claude', source: 'default' })
  })

  it('1. label overrides everything', () => {
    process.env.AGENT_PROVIDER = 'amp'
    process.env.AGENT_PROVIDER_QA = 'amp'
    const result = resolveProviderWithSource({
      labels: ['provider:codex'],
      mentionContext: 'use amp',
      workType: 'qa',
      project: 'Social',
      configProviders: {
        default: 'amp',
        byWorkType: { qa: 'amp' },
        byProject: { Social: 'amp' },
      },
    })
    expect(result.name).toBe('codex')
    expect(result.source).toContain('label')
  })

  it('2. mention overrides config and env', () => {
    process.env.AGENT_PROVIDER = 'amp'
    const result = resolveProviderWithSource({
      mentionContext: 'use codex',
      workType: 'qa',
      configProviders: { byWorkType: { qa: 'amp' } },
    })
    expect(result.name).toBe('codex')
    expect(result.source).toContain('mention')
  })

  it('3. config byWorkType overrides env and config defaults', () => {
    process.env.AGENT_PROVIDER_QA = 'amp'
    const result = resolveProviderWithSource({
      workType: 'qa',
      configProviders: { byWorkType: { qa: 'codex' }, default: 'amp' },
    })
    expect(result.name).toBe('codex')
    expect(result.source).toContain('config providers.byWorkType.qa')
  })

  it('4. config byProject overrides env vars', () => {
    process.env.AGENT_PROVIDER_SOCIAL = 'amp'
    const result = resolveProviderWithSource({
      project: 'Social',
      configProviders: { byProject: { Social: 'codex' } },
    })
    expect(result.name).toBe('codex')
    expect(result.source).toContain('config providers.byProject.Social')
  })

  it('5. env AGENT_PROVIDER_{WORKTYPE} overrides env project and defaults', () => {
    process.env.AGENT_PROVIDER_QA = 'codex'
    process.env.AGENT_PROVIDER_SOCIAL = 'amp'
    process.env.AGENT_PROVIDER = 'amp'
    const result = resolveProviderWithSource({
      workType: 'qa',
      project: 'Social',
    })
    expect(result.name).toBe('codex')
    expect(result.source).toBe('env AGENT_PROVIDER_QA')
  })

  it('6. env AGENT_PROVIDER_{PROJECT} overrides global default', () => {
    process.env.AGENT_PROVIDER_SOCIAL = 'codex'
    process.env.AGENT_PROVIDER = 'amp'
    const result = resolveProviderWithSource({
      project: 'Social',
    })
    expect(result.name).toBe('codex')
    expect(result.source).toBe('env AGENT_PROVIDER_SOCIAL')
  })

  it('7. config providers.default overrides env AGENT_PROVIDER', () => {
    process.env.AGENT_PROVIDER = 'amp'
    const result = resolveProviderWithSource({
      configProviders: { default: 'codex' },
    })
    expect(result.name).toBe('codex')
    expect(result.source).toBe('config providers.default')
  })

  it('8. env AGENT_PROVIDER overrides hardcoded default', () => {
    process.env.AGENT_PROVIDER = 'codex'
    const result = resolveProviderWithSource()
    expect(result.name).toBe('codex')
    expect(result.source).toBe('env AGENT_PROVIDER')
  })

  it('normalizes work type with hyphens to env var format', () => {
    process.env.AGENT_PROVIDER_QA_COORDINATION = 'codex'
    const result = resolveProviderWithSource({ workType: 'qa-coordination' })
    expect(result.name).toBe('codex')
    expect(result.source).toBe('env AGENT_PROVIDER_QA_COORDINATION')
    delete process.env.AGENT_PROVIDER_QA_COORDINATION
  })
})

describe('resolveProviderName — backwards compatibility', () => {
  const envBackup: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ['AGENT_PROVIDER', 'AGENT_PROVIDER_QA', 'AGENT_PROVIDER_SOCIAL']) {
      envBackup[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  it('returns claude by default', () => {
    expect(resolveProviderName()).toBe('claude')
  })

  it('respects old { project, workType } shape', () => {
    process.env.AGENT_PROVIDER_QA = 'codex'
    expect(resolveProviderName({ workType: 'qa' })).toBe('codex')
  })

  it('accepts new ProviderResolutionContext shape', () => {
    expect(resolveProviderName({ labels: ['provider:codex'] })).toBe('codex')
  })
})

describe('PROVIDER_ALIASES', () => {
  it('maps opus to claude', () => {
    expect(PROVIDER_ALIASES['opus']).toBe('claude')
  })

  it('maps sonnet to claude', () => {
    expect(PROVIDER_ALIASES['sonnet']).toBe('claude')
  })

  it('maps gemini to a2a', () => {
    expect(PROVIDER_ALIASES['gemini']).toBe('a2a')
  })

  it('maps codex to codex', () => {
    expect(PROVIDER_ALIASES['codex']).toBe('codex')
  })
})

describe('isValidProviderName', () => {
  it('accepts valid provider names', () => {
    expect(isValidProviderName('claude')).toBe(true)
    expect(isValidProviderName('codex')).toBe(true)
    expect(isValidProviderName('amp')).toBe(true)
    expect(isValidProviderName('spring-ai')).toBe(true)
    expect(isValidProviderName('a2a')).toBe(true)
  })

  it('rejects invalid names', () => {
    expect(isValidProviderName('invalid')).toBe(false)
    expect(isValidProviderName('')).toBe(false)
    expect(isValidProviderName('opus')).toBe(false) // alias, not a provider name
  })
})
