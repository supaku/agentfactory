import { describe, it, expect } from 'vitest'
import {
  WorkflowTemplateSchema,
  PartialTemplateSchema,
  TemplateContextSchema,
  AgentWorkTypeSchema,
  ToolPermissionSchema,
  validateWorkflowTemplate,
  validatePartialTemplate,
} from './types.js'

describe('WorkflowTemplateSchema', () => {
  it('validates a complete workflow template', () => {
    const template = {
      apiVersion: 'v1',
      kind: 'WorkflowTemplate',
      metadata: {
        name: 'development',
        description: 'Standard development workflow',
        workType: 'development',
      },
      tools: {
        allow: [
          { shell: 'pnpm *' },
          { shell: 'git commit *' },
        ],
        disallow: ['user-input'],
      },
      prompt: 'Start work on {{identifier}}.',
    }

    const result = WorkflowTemplateSchema.parse(template)
    expect(result.apiVersion).toBe('v1')
    expect(result.metadata.workType).toBe('development')
    expect(result.tools?.allow).toHaveLength(2)
  })

  it('validates a minimal workflow template', () => {
    const template = {
      apiVersion: 'v1',
      kind: 'WorkflowTemplate',
      metadata: {
        name: 'research',
        workType: 'research',
      },
      prompt: 'Research {{identifier}}.',
    }

    const result = WorkflowTemplateSchema.parse(template)
    expect(result.metadata.name).toBe('research')
    expect(result.tools).toBeUndefined()
  })

  it('rejects invalid apiVersion', () => {
    const template = {
      apiVersion: 'v2',
      kind: 'WorkflowTemplate',
      metadata: { name: 'test', workType: 'development' },
      prompt: 'test',
    }
    expect(() => WorkflowTemplateSchema.parse(template)).toThrow()
  })

  it('rejects invalid workType', () => {
    const template = {
      apiVersion: 'v1',
      kind: 'WorkflowTemplate',
      metadata: { name: 'test', workType: 'invalid' },
      prompt: 'test',
    }
    expect(() => WorkflowTemplateSchema.parse(template)).toThrow()
  })

  it('rejects empty prompt', () => {
    const template = {
      apiVersion: 'v1',
      kind: 'WorkflowTemplate',
      metadata: { name: 'test', workType: 'development' },
      prompt: '',
    }
    expect(() => WorkflowTemplateSchema.parse(template)).toThrow()
  })
})

describe('PartialTemplateSchema', () => {
  it('validates a partial template', () => {
    const partial = {
      apiVersion: 'v1',
      kind: 'PartialTemplate',
      metadata: {
        name: 'cli-instructions',
        description: 'CLI instructions',
      },
      content: 'Use pnpm af-linear for all operations.',
    }

    const result = PartialTemplateSchema.parse(partial)
    expect(result.metadata.name).toBe('cli-instructions')
    expect(result.metadata.frontend).toBeUndefined()
  })

  it('validates a frontend-specific partial', () => {
    const partial = {
      apiVersion: 'v1',
      kind: 'PartialTemplate',
      metadata: {
        name: 'linear-cli',
        frontend: 'linear',
      },
      content: 'pnpm af-linear get-issue <id>',
    }

    const result = PartialTemplateSchema.parse(partial)
    expect(result.metadata.frontend).toBe('linear')
  })

  it('rejects empty content', () => {
    const partial = {
      apiVersion: 'v1',
      kind: 'PartialTemplate',
      metadata: { name: 'test' },
      content: '',
    }
    expect(() => PartialTemplateSchema.parse(partial)).toThrow()
  })
})

describe('AgentWorkTypeSchema', () => {
  it('accepts all 10 work types', () => {
    const workTypes = [
      'research', 'backlog-creation', 'development', 'inflight',
      'qa', 'acceptance', 'refinement', 'coordination',
      'qa-coordination', 'acceptance-coordination',
    ]
    for (const wt of workTypes) {
      expect(AgentWorkTypeSchema.parse(wt)).toBe(wt)
    }
  })

  it('rejects invalid work type', () => {
    expect(() => AgentWorkTypeSchema.parse('invalid')).toThrow()
  })
})

describe('ToolPermissionSchema', () => {
  it('accepts shell permission', () => {
    expect(ToolPermissionSchema.parse({ shell: 'pnpm *' })).toEqual({ shell: 'pnpm *' })
  })

  it('accepts user-input literal', () => {
    expect(ToolPermissionSchema.parse('user-input')).toBe('user-input')
  })

  it('accepts string permission', () => {
    expect(ToolPermissionSchema.parse('Read')).toBe('Read')
  })
})

describe('TemplateContextSchema', () => {
  it('validates minimal context', () => {
    const result = TemplateContextSchema.parse({ identifier: 'SUP-123' })
    expect(result.identifier).toBe('SUP-123')
  })

  it('validates full context', () => {
    const result = TemplateContextSchema.parse({
      identifier: 'SUP-123',
      mentionContext: 'user mention',
      startStatus: 'Started',
      completeStatus: 'Finished',
      parentContext: 'parent context',
      subIssueList: '- SUP-124: Sub 1',
    })
    expect(result.mentionContext).toBe('user mention')
  })

  it('validates context with strategy/WorkflowState fields', () => {
    const result = TemplateContextSchema.parse({
      identifier: 'SUP-123',
      cycleCount: 3,
      strategy: 'context-enriched',
      failureSummary: 'Tests failing on auth module',
      attemptNumber: 2,
      previousFailureReasons: ['reason1', 'reason2'],
      totalCostUsd: 1.50,
      blockerIdentifier: 'SUP-999',
      team: 'Engineering',
    })
    expect(result.cycleCount).toBe(3)
    expect(result.strategy).toBe('context-enriched')
    expect(result.failureSummary).toBe('Tests failing on auth module')
    expect(result.attemptNumber).toBe(2)
    expect(result.previousFailureReasons).toEqual(['reason1', 'reason2'])
    expect(result.totalCostUsd).toBe(1.50)
    expect(result.blockerIdentifier).toBe('SUP-999')
    expect(result.team).toBe('Engineering')
  })

  it('rejects negative cycleCount', () => {
    expect(() => TemplateContextSchema.parse({
      identifier: 'SUP-123',
      cycleCount: -1,
    })).toThrow()
  })

  it('rejects non-positive attemptNumber', () => {
    expect(() => TemplateContextSchema.parse({
      identifier: 'SUP-123',
      attemptNumber: 0,
    })).toThrow()
  })

  it('rejects negative totalCostUsd', () => {
    expect(() => TemplateContextSchema.parse({
      identifier: 'SUP-123',
      totalCostUsd: -5,
    })).toThrow()
  })

  it('rejects empty identifier', () => {
    expect(() => TemplateContextSchema.parse({ identifier: '' })).toThrow()
  })
})

describe('validateWorkflowTemplate', () => {
  it('adds file path to error message', () => {
    try {
      validateWorkflowTemplate({ invalid: true }, '/path/to/file.yaml')
      expect.fail('should throw')
    } catch (error) {
      expect((error as Error).message).toContain('/path/to/file.yaml')
    }
  })
})

describe('validatePartialTemplate', () => {
  it('adds file path to error message', () => {
    try {
      validatePartialTemplate({ invalid: true }, '/path/to/partial.yaml')
      expect.fail('should throw')
    } catch (error) {
      expect((error as Error).message).toContain('/path/to/partial.yaml')
    }
  })
})
