import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { resolveProfileForSpawn, resolveSubAgentFromProfile } from './profile-resolution.js'
import type { ProfileResolutionContext } from './profile-resolution.js'
import type { ProfileConfig, DispatchConfig } from './profiles.js'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const profiles: Record<string, ProfileConfig> = {
  'codex-dev': {
    provider: 'codex',
    model: 'gpt-5.4',
    effort: 'high',
    openai: { serviceTier: 'fast' },
    subAgent: {
      model: 'gpt-5.4-mini',
      effort: 'low',
    },
  },
  'claude-coord': {
    provider: 'claude',
    model: 'claude-opus-4-7',
    effort: 'xhigh',
    anthropic: { speed: 'fast' },
    subAgent: {
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      effort: 'high',
    },
  },
  'codex-qa': {
    provider: 'codex',
    model: 'gpt-5.4-mini',
    effort: 'low',
  },
}

const dispatch: DispatchConfig = {
  default: 'codex-dev',
  byWorkType: {
    coordination: 'claude-coord',
    qa: 'codex-qa',
  },
  byProject: {
    Social: 'codex-dev',
  },
}

function makeContext(overrides?: Partial<ProfileResolutionContext>): ProfileResolutionContext {
  return {
    profiles,
    dispatch,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveProfileForSpawn', () => {
  const envBackup = { ...process.env }

  beforeEach(() => {
    // Clean relevant env vars
    delete process.env.AGENT_PROVIDER
    delete process.env.AGENT_MODEL
    delete process.env.AGENT_PROVIDER_QA
    delete process.env.AGENT_MODEL_QA
    delete process.env.AGENT_PROVIDER_COORDINATION
    delete process.env.AGENT_MODEL_COORDINATION
    delete process.env.AGENT_PROVIDER_SOCIAL
    delete process.env.AGENT_MODEL_SOCIAL
    delete process.env.AGENT_SUB_MODEL
  })

  afterEach(() => {
    process.env = { ...envBackup }
  })

  // -----------------------------------------------------------------------
  // Dispatch cascade
  // -----------------------------------------------------------------------

  describe('dispatch cascade', () => {
    it('uses dispatch.default when no workType or project', () => {
      const result = resolveProfileForSpawn(makeContext())
      expect(result.provider).toBe('codex')
      expect(result.model).toBe('gpt-5.4')
      expect(result.effort).toBe('high')
      expect(result.source).toContain('dispatch.default')
    })

    it('uses dispatch.byWorkType when workType matches', () => {
      const result = resolveProfileForSpawn(makeContext({ workType: 'coordination' }))
      expect(result.provider).toBe('claude')
      expect(result.model).toBe('claude-opus-4-7')
      expect(result.effort).toBe('xhigh')
      expect(result.source).toContain('dispatch.byWorkType.coordination')
    })

    it('uses dispatch.byProject when project matches and no workType match', () => {
      const result = resolveProfileForSpawn(makeContext({ project: 'Social' }))
      expect(result.provider).toBe('codex')
      expect(result.model).toBe('gpt-5.4')
      expect(result.source).toContain('dispatch.byProject.Social')
    })

    it('byWorkType takes precedence over byProject', () => {
      const result = resolveProfileForSpawn(makeContext({
        workType: 'qa',
        project: 'Social',
      }))
      expect(result.provider).toBe('codex')
      expect(result.model).toBe('gpt-5.4-mini')
      expect(result.effort).toBe('low')
      expect(result.source).toContain('dispatch.byWorkType.qa')
    })

    it('falls back to default when workType has no match', () => {
      const result = resolveProfileForSpawn(makeContext({ workType: 'research' }))
      expect(result.provider).toBe('codex')
      expect(result.model).toBe('gpt-5.4')
    })

    it('returns hardcoded default when profile name not found', () => {
      const result = resolveProfileForSpawn(makeContext({
        dispatch: { default: 'nonexistent' },
      }))
      expect(result.provider).toBe('claude')
      expect(result.source).toContain('not found')
    })
  })

  // -----------------------------------------------------------------------
  // Override hierarchy
  // -----------------------------------------------------------------------

  describe('overrides', () => {
    it('dispatch model overrides profile model (highest priority)', () => {
      const result = resolveProfileForSpawn(makeContext({
        dispatchModel: 'custom-model-1',
      }))
      expect(result.model).toBe('custom-model-1')
      expect(result.provider).toBe('codex') // unknown model — provider unchanged
    })

    it('dispatch model auto-switches provider when it matches a declared profile', () => {
      // codex-dev is the default profile (provider=codex). claude-coord declares
      // model=claude-opus-4-7. A dispatchModel of claude-opus-4-7 must flip the
      // provider to claude — otherwise codex would receive a claude model.
      const result = resolveProfileForSpawn(makeContext({
        dispatchModel: 'claude-opus-4-7',
      }))
      expect(result.model).toBe('claude-opus-4-7')
      expect(result.provider).toBe('claude')
      expect(result.source).toContain('→provider:claude')
    })

    it('dispatch model auto-switches provider via well-known prefix (claude-*)', () => {
      const result = resolveProfileForSpawn(makeContext({
        dispatchModel: 'claude-future-model-99',
      }))
      expect(result.provider).toBe('claude')
    })

    it('dispatch model auto-switches provider via well-known prefix (gpt-*)', () => {
      // Force a non-codex profile so the switch is observable
      const result = resolveProfileForSpawn(makeContext({
        workType: 'coordination', // resolves to claude-coord
        dispatchModel: 'gpt-5-codex',
      }))
      expect(result.provider).toBe('codex')
    })

    it('dispatch model leaves provider alone when already matching', () => {
      const result = resolveProfileForSpawn(makeContext({
        dispatchModel: 'gpt-5.4-mini', // codex profile, codex provider — same family
      }))
      expect(result.provider).toBe('codex')
      expect(result.source).not.toContain('→provider:')
    })

    it('label provider: overrides profile provider', () => {
      const result = resolveProfileForSpawn(makeContext({
        labels: ['provider:claude'],
      }))
      expect(result.provider).toBe('claude')
      expect(result.model).toBe('gpt-5.4') // model unchanged
    })

    it('label model: overrides profile model', () => {
      const result = resolveProfileForSpawn(makeContext({
        labels: ['model:special-model'],
      }))
      expect(result.model).toBe('special-model')
    })

    it('mention context overrides provider', () => {
      const result = resolveProfileForSpawn(makeContext({
        mentionContext: 'use claude for this',
      }))
      expect(result.provider).toBe('claude')
    })

    it('dispatch model beats label model', () => {
      const result = resolveProfileForSpawn(makeContext({
        dispatchModel: 'dispatch-model',
        labels: ['model:label-model'],
      }))
      expect(result.model).toBe('dispatch-model')
    })

    it('label provider beats mention provider', () => {
      const result = resolveProfileForSpawn(makeContext({
        labels: ['provider:amp'],
        mentionContext: 'use codex',
      }))
      expect(result.provider).toBe('amp')
    })
  })

  // -----------------------------------------------------------------------
  // Env var overrides
  // -----------------------------------------------------------------------

  describe('env var overrides', () => {
    it('AGENT_PROVIDER overrides profile provider (low priority)', () => {
      process.env.AGENT_PROVIDER = 'amp'
      const result = resolveProfileForSpawn(makeContext())
      expect(result.provider).toBe('amp')
    })

    it('AGENT_MODEL overrides profile model (low priority)', () => {
      process.env.AGENT_MODEL = 'env-model'
      const result = resolveProfileForSpawn(makeContext())
      expect(result.model).toBe('env-model')
    })

    it('AGENT_PROVIDER_{WORKTYPE} overrides AGENT_PROVIDER', () => {
      process.env.AGENT_PROVIDER = 'amp'
      process.env.AGENT_PROVIDER_QA = 'claude'
      const result = resolveProfileForSpawn(makeContext({ workType: 'qa' }))
      expect(result.provider).toBe('claude')
    })

    it('AGENT_MODEL_{WORKTYPE} overrides AGENT_MODEL', () => {
      process.env.AGENT_MODEL = 'global-model'
      process.env.AGENT_MODEL_QA = 'qa-model'
      const result = resolveProfileForSpawn(makeContext({ workType: 'qa' }))
      expect(result.model).toBe('qa-model')
    })

    it('label overrides env var', () => {
      process.env.AGENT_PROVIDER = 'amp'
      const result = resolveProfileForSpawn(makeContext({
        labels: ['provider:claude'],
      }))
      expect(result.provider).toBe('claude')
    })

    it('hyphenated work types normalize to underscores in env key', () => {
      process.env.AGENT_PROVIDER_QA_COORDINATION = 'amp'
      const result = resolveProfileForSpawn(makeContext({ workType: 'qa-coordination' }))
      expect(result.provider).toBe('amp')
    })
  })

  // -----------------------------------------------------------------------
  // Provider-specific config extraction
  // -----------------------------------------------------------------------

  describe('provider config extraction', () => {
    it('extracts openai config for codex provider', () => {
      const result = resolveProfileForSpawn(makeContext())
      expect(result.providerConfig).toEqual({ serviceTier: 'fast' })
    })

    it('extracts anthropic config for claude provider', () => {
      const result = resolveProfileForSpawn(makeContext({ workType: 'coordination' }))
      expect(result.providerConfig).toEqual({ speed: 'fast' })
    })

    it('returns undefined when no matching config block', () => {
      const result = resolveProfileForSpawn(makeContext({ workType: 'qa' }))
      expect(result.providerConfig).toBeUndefined()
    })
  })
})

// ---------------------------------------------------------------------------
// Sub-agent resolution
// ---------------------------------------------------------------------------

describe('resolveSubAgentFromProfile', () => {
  const envBackup = { ...process.env }

  beforeEach(() => {
    delete process.env.AGENT_SUB_MODEL
  })

  afterEach(() => {
    process.env = { ...envBackup }
  })

  it('returns profile subAgent values', () => {
    const result = resolveSubAgentFromProfile(profiles['codex-dev'], {})
    expect(result?.model).toBe('gpt-5.4-mini')
    expect(result?.effort).toBe('low')
    expect(result?.provider).toBe('codex') // inherited from parent
  })

  it('returns overridden provider from subAgent block', () => {
    const result = resolveSubAgentFromProfile(profiles['claude-coord'], {})
    expect(result?.provider).toBe('claude')
    expect(result?.model).toBe('claude-sonnet-4-6')
    expect(result?.effort).toBe('high')
  })

  it('inherits from parent when no subAgent block', () => {
    const result = resolveSubAgentFromProfile(profiles['codex-qa'], {})
    expect(result?.provider).toBe('codex')
    expect(result?.model).toBe('gpt-5.4-mini')
    expect(result?.effort).toBe('low')
  })

  it('AGENT_SUB_MODEL overrides profile subAgent model', () => {
    process.env.AGENT_SUB_MODEL = 'env-sub-model'
    const result = resolveSubAgentFromProfile(profiles['codex-dev'], {})
    expect(result?.model).toBe('env-sub-model')
    expect(result?.effort).toBe('low') // effort unchanged
  })

  it('dispatch sub-agent model beats env var', () => {
    process.env.AGENT_SUB_MODEL = 'env-sub-model'
    const result = resolveSubAgentFromProfile(profiles['codex-dev'], {
      dispatchSubAgentModel: 'dispatch-sub-model',
    })
    expect(result?.model).toBe('dispatch-sub-model')
  })
})
