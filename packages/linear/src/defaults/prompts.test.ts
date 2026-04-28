import { describe, it, expect } from 'vitest'
import { buildFailureContextBlock, defaultGeneratePrompt, PERSISTENCE_DIRECTIVES, type WorkflowContext } from './prompts.js'

describe('buildFailureContextBlock', () => {
  const baseContext: WorkflowContext = {
    cycleCount: 2,
    strategy: 'context-enriched',
    failureSummary: '--- Cycle 1, qa (2024-01-01) ---\nTests failed: TypeError in UserService',
  }

  describe('refinement work type', () => {
    it('returns empty string for cycleCount 0', () => {
      expect(buildFailureContextBlock('refinement', { ...baseContext, cycleCount: 0 })).toBe('')
    })

    it('includes failure history for cycle 1+', () => {
      const result = buildFailureContextBlock('refinement', baseContext)
      expect(result).toContain('Previous Failure Context')
      expect(result).toContain('2 development-QA cycle(s)')
      expect(result).toContain('TypeError in UserService')
      expect(result).toContain('Do NOT repeat approaches that already failed')
    })

    it('includes decomposition instructions for decompose strategy', () => {
      const decomposeCtx: WorkflowContext = {
        ...baseContext,
        cycleCount: 3,
        strategy: 'decompose',
      }
      const result = buildFailureContextBlock('refinement', decomposeCtx)
      expect(result).toContain('Decomposition Required')
      expect(result).toContain('DECOMPOSE this issue')
      expect(result).toContain('smaller sub-issues')
      expect(result).not.toContain('Previous Failure Context')
    })

    it('handles null failure summary gracefully', () => {
      const result = buildFailureContextBlock('refinement', { ...baseContext, failureSummary: null })
      expect(result).toContain('No details recorded')
    })
  })

  describe('development work type', () => {
    it('returns empty string for cycleCount 0', () => {
      expect(buildFailureContextBlock('development', { ...baseContext, cycleCount: 0 })).toBe('')
    })

    it('includes retry context for cycle 1+', () => {
      const result = buildFailureContextBlock('development', baseContext)
      expect(result).toContain('Retry Context')
      expect(result).toContain('retry #2')
      expect(result).toContain('TypeError in UserService')
    })
  })

  describe('inflight work type', () => {
    it('includes retry context same as development', () => {
      const result = buildFailureContextBlock('inflight', baseContext)
      expect(result).toContain('Retry Context')
      expect(result).toContain('retry #2')
    })
  })

  describe('qa work type', () => {
    it('returns empty string when no failure summary', () => {
      expect(buildFailureContextBlock('qa', { ...baseContext, failureSummary: null })).toBe('')
    })

    it('includes previous QA results when failure summary exists', () => {
      const qaCtx: WorkflowContext = {
        ...baseContext,
        qaAttemptCount: 2,
      }
      const result = buildFailureContextBlock('qa', qaCtx)
      expect(result).toContain('Previous QA Results')
      expect(result).toContain('QA\'d 2 times previously')
      expect(result).toContain('TypeError in UserService')
    })

    it('falls back to cycleCount when qaAttemptCount not provided', () => {
      const result = buildFailureContextBlock('qa', baseContext)
      expect(result).toContain('QA\'d 2 times previously')
    })
  })

  describe('other work types', () => {
    it('returns empty string for acceptance', () => {
      expect(buildFailureContextBlock('acceptance', baseContext)).toBe('')
    })

    it('returns empty string for research', () => {
      expect(buildFailureContextBlock('research', baseContext)).toBe('')
    })

    it('returns empty string for backlog-creation', () => {
      expect(buildFailureContextBlock('backlog-creation', baseContext)).toBe('')
    })
  })
})

describe('defaultGeneratePrompt with workflowContext', () => {
  it('does not modify prompt when workflowContext is undefined', () => {
    const withoutCtx = defaultGeneratePrompt('PROJ-123', 'development')
    const withUndefined = defaultGeneratePrompt('PROJ-123', 'development', undefined, undefined)
    expect(withoutCtx).toBe(withUndefined)
  })

  it('does not modify prompt when cycleCount is 0', () => {
    const withoutCtx = defaultGeneratePrompt('PROJ-123', 'development')
    const withZero = defaultGeneratePrompt('PROJ-123', 'development', undefined, {
      cycleCount: 0,
      strategy: 'normal',
      failureSummary: null,
    })
    expect(withoutCtx).toBe(withZero)
  })

  it('enriches refinement prompt with failure context', () => {
    const result = defaultGeneratePrompt('PROJ-123', 'refinement', undefined, {
      cycleCount: 2,
      strategy: 'context-enriched',
      failureSummary: 'Tests failed in UserService',
    })
    expect(result).toContain('Refine PROJ-123')
    expect(result).toContain('Previous Failure Context')
    expect(result).toContain('Tests failed in UserService')
  })

  it('enriches development prompt with retry context', () => {
    const result = defaultGeneratePrompt('PROJ-123', 'development', undefined, {
      cycleCount: 1,
      strategy: 'normal',
      failureSummary: 'Build error in core package',
    })
    expect(result).toContain('Start work on PROJ-123')
    expect(result).toContain('Retry Context')
    expect(result).toContain('Build error in core package')
  })

  it('preserves mentionContext alongside workflowContext', () => {
    const result = defaultGeneratePrompt('PROJ-123', 'development', 'Please focus on the API layer', {
      cycleCount: 1,
      strategy: 'normal',
      failureSummary: 'API tests failing',
    })
    expect(result).toContain('Retry Context')
    expect(result).toContain('Please focus on the API layer')
  })
})

describe('defaultGeneratePrompt read-only constraint', () => {
  const readOnlyWorkTypes = ['qa', 'acceptance'] as const

  for (const workType of readOnlyWorkTypes) {
    it(`includes READ-ONLY constraint for ${workType}`, () => {
      const result = defaultGeneratePrompt('PROJ-123', workType)
      expect(result).toContain('READ-ONLY ROLE')
      expect(result).toContain('MUST NOT modify any source code')
      expect(result).toContain('WORK_RESULT:failed')
    })
  }

  const writableWorkTypes = ['development', 'refinement', 'research', 'backlog-creation', 'inflight'] as const

  for (const workType of writableWorkTypes) {
    it(`does NOT include READ-ONLY constraint for ${workType}`, () => {
      const result = defaultGeneratePrompt('PROJ-123', workType)
      expect(result).not.toContain('READ-ONLY ROLE')
    })
  }
})


describe('defaultGeneratePrompt persistence directives (REN-74)', () => {
  const persistenceSignatures = [
    'PERSIST YOUR WORK',
    'git add',
    'git commit',
    'git push',
    'gh pr create',
  ]

  const codeProducingTypes = ['development', 'inflight'] as const

  for (const workType of codeProducingTypes) {
    it(`embeds commit/push/PR directives in ${workType} base prompt`, () => {
      const result = defaultGeneratePrompt('PROJ-123', workType)
      for (const signature of persistenceSignatures) {
        expect(result, `${workType} prompt missing signature: ${signature}`).toContain(signature)
      }
    })
  }


  it('does NOT embed persistence directives in read-only work types', () => {
    const readOnlyTypes = ['qa', 'acceptance', 'refinement', 'research', 'security'] as const
    for (const workType of readOnlyTypes) {
      const result = defaultGeneratePrompt('PROJ-123', workType)
      expect(result, `${workType} should not include persistence directives`).not.toContain('PERSIST YOUR WORK')
    }
  })

  it('does NOT embed persistence directives in backlog-creation', () => {
    const result = defaultGeneratePrompt('PROJ-123', 'backlog-creation')
    expect(result).not.toContain('PERSIST YOUR WORK')
  })

  it('exported PERSISTENCE_DIRECTIVES constant matches the embedded string', () => {
    const devPrompt = defaultGeneratePrompt('PROJ-123', 'development')
    expect(devPrompt).toContain(PERSISTENCE_DIRECTIVES.trim())
  })
})
