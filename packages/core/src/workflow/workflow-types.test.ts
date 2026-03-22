import { describe, it, expect } from 'vitest'
import {
  PhaseDefinitionSchema,
  TransitionDefinitionSchema,
  EscalationLadderRungSchema,
  EscalationConfigSchema,
  GateDefinitionSchema,
  ParallelismGroupDefinitionSchema,
  WorkflowDefinitionSchema,
  validateWorkflowDefinition,
} from './workflow-types.js'

describe('PhaseDefinitionSchema', () => {
  it('validates a minimal phase', () => {
    const result = PhaseDefinitionSchema.parse({
      name: 'development',
      template: 'development',
    })
    expect(result.name).toBe('development')
    expect(result.template).toBe('development')
    expect(result.description).toBeUndefined()
    expect(result.variants).toBeUndefined()
  })

  it('validates a phase with all optional fields', () => {
    const result = PhaseDefinitionSchema.parse({
      name: 'refinement',
      description: 'Address rejection feedback',
      template: 'refinement',
      variants: {
        'context-enriched': 'refinement-context-enriched',
        'decompose': 'refinement-decompose',
      },
    })
    expect(result.variants).toEqual({
      'context-enriched': 'refinement-context-enriched',
      'decompose': 'refinement-decompose',
    })
  })

  it('rejects phase without name', () => {
    expect(() => PhaseDefinitionSchema.parse({
      template: 'development',
    })).toThrow()
  })

  it('rejects phase without template', () => {
    expect(() => PhaseDefinitionSchema.parse({
      name: 'development',
    })).toThrow()
  })

  it('rejects empty name', () => {
    expect(() => PhaseDefinitionSchema.parse({
      name: '',
      template: 'development',
    })).toThrow()
  })

  it('rejects empty template', () => {
    expect(() => PhaseDefinitionSchema.parse({
      name: 'development',
      template: '',
    })).toThrow()
  })
})

describe('TransitionDefinitionSchema', () => {
  it('validates a minimal transition', () => {
    const result = TransitionDefinitionSchema.parse({
      from: 'Backlog',
      to: 'development',
    })
    expect(result.from).toBe('Backlog')
    expect(result.to).toBe('development')
    expect(result.condition).toBeUndefined()
    expect(result.priority).toBeUndefined()
  })

  it('validates a transition with condition and priority', () => {
    const result = TransitionDefinitionSchema.parse({
      from: 'Icebox',
      to: 'research',
      condition: '{{ not researchCompleted }}',
      priority: 10,
    })
    expect(result.condition).toBe('{{ not researchCompleted }}')
    expect(result.priority).toBe(10)
  })

  it('rejects transition without from', () => {
    expect(() => TransitionDefinitionSchema.parse({
      to: 'development',
    })).toThrow()
  })

  it('rejects transition without to', () => {
    expect(() => TransitionDefinitionSchema.parse({
      from: 'Backlog',
    })).toThrow()
  })

  it('rejects empty from', () => {
    expect(() => TransitionDefinitionSchema.parse({
      from: '',
      to: 'development',
    })).toThrow()
  })

  it('rejects empty to', () => {
    expect(() => TransitionDefinitionSchema.parse({
      from: 'Backlog',
      to: '',
    })).toThrow()
  })

  it('rejects non-integer priority', () => {
    expect(() => TransitionDefinitionSchema.parse({
      from: 'Backlog',
      to: 'development',
      priority: 1.5,
    })).toThrow()
  })
})

describe('EscalationLadderRungSchema', () => {
  it('validates a ladder rung', () => {
    const result = EscalationLadderRungSchema.parse({
      cycle: 1,
      strategy: 'normal',
    })
    expect(result.cycle).toBe(1)
    expect(result.strategy).toBe('normal')
  })

  it('accepts cycle 0', () => {
    const result = EscalationLadderRungSchema.parse({
      cycle: 0,
      strategy: 'normal',
    })
    expect(result.cycle).toBe(0)
  })

  it('rejects negative cycle', () => {
    expect(() => EscalationLadderRungSchema.parse({
      cycle: -1,
      strategy: 'normal',
    })).toThrow()
  })

  it('rejects empty strategy', () => {
    expect(() => EscalationLadderRungSchema.parse({
      cycle: 1,
      strategy: '',
    })).toThrow()
  })
})

describe('EscalationConfigSchema', () => {
  it('validates a full escalation config', () => {
    const result = EscalationConfigSchema.parse({
      ladder: [
        { cycle: 1, strategy: 'normal' },
        { cycle: 2, strategy: 'context-enriched' },
        { cycle: 3, strategy: 'decompose' },
        { cycle: 4, strategy: 'escalate-human' },
      ],
      circuitBreaker: {
        maxSessionsPerIssue: 8,
        maxSessionsPerPhase: 3,
      },
    })
    expect(result.ladder).toHaveLength(4)
    expect(result.circuitBreaker.maxSessionsPerIssue).toBe(8)
    expect(result.circuitBreaker.maxSessionsPerPhase).toBe(3)
  })

  it('validates config without optional maxSessionsPerPhase', () => {
    const result = EscalationConfigSchema.parse({
      ladder: [{ cycle: 1, strategy: 'normal' }],
      circuitBreaker: {
        maxSessionsPerIssue: 5,
      },
    })
    expect(result.circuitBreaker.maxSessionsPerPhase).toBeUndefined()
  })

  it('rejects empty ladder', () => {
    expect(() => EscalationConfigSchema.parse({
      ladder: [],
      circuitBreaker: { maxSessionsPerIssue: 8 },
    })).toThrow()
  })

  it('rejects zero maxSessionsPerIssue', () => {
    expect(() => EscalationConfigSchema.parse({
      ladder: [{ cycle: 1, strategy: 'normal' }],
      circuitBreaker: { maxSessionsPerIssue: 0 },
    })).toThrow()
  })

  it('rejects negative maxSessionsPerIssue', () => {
    expect(() => EscalationConfigSchema.parse({
      ladder: [{ cycle: 1, strategy: 'normal' }],
      circuitBreaker: { maxSessionsPerIssue: -1 },
    })).toThrow()
  })

  it('rejects zero maxSessionsPerPhase', () => {
    expect(() => EscalationConfigSchema.parse({
      ladder: [{ cycle: 1, strategy: 'normal' }],
      circuitBreaker: { maxSessionsPerIssue: 8, maxSessionsPerPhase: 0 },
    })).toThrow()
  })
})

describe('GateDefinitionSchema', () => {
  it('validates a signal gate', () => {
    const result = GateDefinitionSchema.parse({
      name: 'human-review',
      description: 'Wait for human approval',
      type: 'signal',
      trigger: { source: 'comment', match: 'RESUME' },
      timeout: { duration: '4h', action: 'escalate' },
      appliesTo: ['refinement'],
    })
    expect(result.name).toBe('human-review')
    expect(result.type).toBe('signal')
    expect(result.timeout?.action).toBe('escalate')
    expect(result.appliesTo).toEqual(['refinement'])
  })

  it('validates a timer gate', () => {
    const result = GateDefinitionSchema.parse({
      name: 'scheduled-release',
      type: 'timer',
      trigger: { cron: '0 9 * * 1-5' },
    })
    expect(result.type).toBe('timer')
    expect(result.timeout).toBeUndefined()
  })

  it('validates a webhook gate', () => {
    const result = GateDefinitionSchema.parse({
      name: 'external-approval',
      type: 'webhook',
      trigger: { endpoint: '/api/approve' },
      timeout: { duration: '24h', action: 'fail' },
    })
    expect(result.type).toBe('webhook')
  })

  it('rejects invalid gate type', () => {
    expect(() => GateDefinitionSchema.parse({
      name: 'test',
      type: 'invalid',
      trigger: {},
    })).toThrow()
  })

  it('rejects invalid timeout action', () => {
    expect(() => GateDefinitionSchema.parse({
      name: 'test',
      type: 'signal',
      trigger: {},
      timeout: { duration: '1h', action: 'invalid' },
    })).toThrow()
  })
})

describe('ParallelismGroupDefinitionSchema', () => {
  it('validates a fan-out group', () => {
    const result = ParallelismGroupDefinitionSchema.parse({
      name: 'sub-issue-fan-out',
      description: 'Coordinate sub-issues in parallel',
      phases: ['development'],
      strategy: 'fan-out',
      maxConcurrent: 5,
      waitForAll: true,
    })
    expect(result.name).toBe('sub-issue-fan-out')
    expect(result.strategy).toBe('fan-out')
    expect(result.maxConcurrent).toBe(5)
    expect(result.waitForAll).toBe(true)
  })

  it('validates a minimal group', () => {
    const result = ParallelismGroupDefinitionSchema.parse({
      name: 'parallel-qa',
      phases: ['qa'],
      strategy: 'race',
    })
    expect(result.maxConcurrent).toBeUndefined()
    expect(result.waitForAll).toBeUndefined()
  })

  it('rejects empty phases array', () => {
    expect(() => ParallelismGroupDefinitionSchema.parse({
      name: 'test',
      phases: [],
      strategy: 'fan-out',
    })).toThrow()
  })

  it('rejects invalid strategy', () => {
    expect(() => ParallelismGroupDefinitionSchema.parse({
      name: 'test',
      phases: ['dev'],
      strategy: 'invalid',
    })).toThrow()
  })

  it('rejects zero maxConcurrent', () => {
    expect(() => ParallelismGroupDefinitionSchema.parse({
      name: 'test',
      phases: ['dev'],
      strategy: 'fan-out',
      maxConcurrent: 0,
    })).toThrow()
  })
})

describe('WorkflowDefinitionSchema', () => {
  it('validates a minimal workflow definition', () => {
    const result = WorkflowDefinitionSchema.parse({
      apiVersion: 'v1.1',
      kind: 'WorkflowDefinition',
      metadata: { name: 'test-workflow' },
      phases: [
        { name: 'development', template: 'development' },
      ],
      transitions: [
        { from: 'Backlog', to: 'development' },
      ],
    })
    expect(result.apiVersion).toBe('v1.1')
    expect(result.kind).toBe('WorkflowDefinition')
    expect(result.metadata.name).toBe('test-workflow')
    expect(result.phases).toHaveLength(1)
    expect(result.transitions).toHaveLength(1)
    expect(result.escalation).toBeUndefined()
    expect(result.gates).toBeUndefined()
    expect(result.parallelism).toBeUndefined()
  })

  it('validates a full workflow definition with all sections', () => {
    const result = WorkflowDefinitionSchema.parse({
      apiVersion: 'v1.1',
      kind: 'WorkflowDefinition',
      metadata: {
        name: 'full-workflow',
        description: 'Complete workflow with all features',
      },
      phases: [
        { name: 'dev', template: 'development' },
        {
          name: 'refinement',
          template: 'refinement',
          variants: { 'context-enriched': 'refinement-context-enriched' },
        },
      ],
      transitions: [
        { from: 'Backlog', to: 'dev' },
        { from: 'Rejected', to: 'refinement', condition: '{{ true }}', priority: 5 },
      ],
      escalation: {
        ladder: [
          { cycle: 1, strategy: 'normal' },
          { cycle: 4, strategy: 'escalate-human' },
        ],
        circuitBreaker: { maxSessionsPerIssue: 8, maxSessionsPerPhase: 3 },
      },
      gates: [
        {
          name: 'approval',
          type: 'signal',
          trigger: { source: 'comment' },
          timeout: { duration: '4h', action: 'escalate' },
        },
      ],
      parallelism: [
        {
          name: 'fan-out',
          phases: ['dev'],
          strategy: 'fan-out',
          maxConcurrent: 3,
        },
      ],
    })
    expect(result.phases).toHaveLength(2)
    expect(result.transitions).toHaveLength(2)
    expect(result.escalation?.ladder).toHaveLength(2)
    expect(result.gates).toHaveLength(1)
    expect(result.parallelism).toHaveLength(1)
  })

  it('accepts empty phases and transitions arrays', () => {
    const result = WorkflowDefinitionSchema.parse({
      apiVersion: 'v1.1',
      kind: 'WorkflowDefinition',
      metadata: { name: 'empty' },
      phases: [],
      transitions: [],
    })
    expect(result.phases).toHaveLength(0)
    expect(result.transitions).toHaveLength(0)
  })

  it('rejects invalid apiVersion', () => {
    expect(() => WorkflowDefinitionSchema.parse({
      apiVersion: 'v1',
      kind: 'WorkflowDefinition',
      metadata: { name: 'test' },
      phases: [],
      transitions: [],
    })).toThrow()
  })

  it('rejects invalid kind', () => {
    expect(() => WorkflowDefinitionSchema.parse({
      apiVersion: 'v1.1',
      kind: 'WorkflowTemplate',
      metadata: { name: 'test' },
      phases: [],
      transitions: [],
    })).toThrow()
  })

  it('rejects missing metadata.name', () => {
    expect(() => WorkflowDefinitionSchema.parse({
      apiVersion: 'v1.1',
      kind: 'WorkflowDefinition',
      metadata: {},
      phases: [],
      transitions: [],
    })).toThrow()
  })

  it('rejects empty metadata.name', () => {
    expect(() => WorkflowDefinitionSchema.parse({
      apiVersion: 'v1.1',
      kind: 'WorkflowDefinition',
      metadata: { name: '' },
      phases: [],
      transitions: [],
    })).toThrow()
  })

  it('rejects missing phases', () => {
    expect(() => WorkflowDefinitionSchema.parse({
      apiVersion: 'v1.1',
      kind: 'WorkflowDefinition',
      metadata: { name: 'test' },
      transitions: [],
    })).toThrow()
  })

  it('rejects missing transitions', () => {
    expect(() => WorkflowDefinitionSchema.parse({
      apiVersion: 'v1.1',
      kind: 'WorkflowDefinition',
      metadata: { name: 'test' },
      phases: [],
    })).toThrow()
  })
})

describe('validateWorkflowDefinition', () => {
  it('returns validated workflow for valid input', () => {
    const result = validateWorkflowDefinition({
      apiVersion: 'v1.1',
      kind: 'WorkflowDefinition',
      metadata: { name: 'test' },
      phases: [{ name: 'dev', template: 'development' }],
      transitions: [{ from: 'Backlog', to: 'dev' }],
    })
    expect(result.metadata.name).toBe('test')
  })

  it('includes file path in error message when provided', () => {
    try {
      validateWorkflowDefinition({ invalid: true }, '/path/to/workflow.yaml')
      expect.fail('should throw')
    } catch (error) {
      expect((error as Error).message).toContain('/path/to/workflow.yaml')
      expect((error as Error).message).toContain('Invalid workflow definition')
    }
  })

  it('throws ZodError directly when no file path provided', () => {
    expect(() => validateWorkflowDefinition({ invalid: true })).toThrow()
  })
})
