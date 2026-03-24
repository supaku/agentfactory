import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { parse as parseYaml } from 'yaml'
import {
  PhaseDefinitionSchema,
  PhaseOutputDeclarationSchema,
  PhaseInputDeclarationSchema,
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

  it('validates phase with outputs', () => {
    const result = PhaseDefinitionSchema.parse({
      name: 'development',
      template: 'development',
      outputs: {
        prUrl: { type: 'url', description: 'Pull request URL', required: true },
        branch: { type: 'string' },
      },
    })
    expect(result.outputs).toEqual({
      prUrl: { type: 'url', description: 'Pull request URL', required: true },
      branch: { type: 'string' },
    })
  })

  it('validates phase with inputs', () => {
    const result = PhaseDefinitionSchema.parse({
      name: 'qa',
      template: 'qa',
      inputs: {
        prUrl: { from: 'development.prUrl', description: 'PR to test' },
      },
    })
    expect(result.inputs).toEqual({
      prUrl: { from: 'development.prUrl', description: 'PR to test' },
    })
  })

  it('validates phase with both outputs and inputs', () => {
    const result = PhaseDefinitionSchema.parse({
      name: 'qa',
      template: 'qa',
      inputs: {
        prUrl: { from: 'development.prUrl' },
      },
      outputs: {
        testsPassed: { type: 'boolean', required: true },
      },
    })
    expect(result.inputs).toBeDefined()
    expect(result.outputs).toBeDefined()
  })

  it('accepts phase without outputs and inputs (backwards compatible)', () => {
    const result = PhaseDefinitionSchema.parse({
      name: 'development',
      template: 'development',
    })
    expect(result.outputs).toBeUndefined()
    expect(result.inputs).toBeUndefined()
  })
})

describe('PhaseOutputDeclarationSchema', () => {
  it('validates all output types', () => {
    for (const type of ['string', 'json', 'url', 'boolean'] as const) {
      const result = PhaseOutputDeclarationSchema.parse({ type })
      expect(result.type).toBe(type)
    }
  })

  it('validates with all optional fields', () => {
    const result = PhaseOutputDeclarationSchema.parse({
      type: 'url',
      description: 'The pull request URL',
      required: true,
    })
    expect(result.type).toBe('url')
    expect(result.description).toBe('The pull request URL')
    expect(result.required).toBe(true)
  })

  it('validates minimal declaration', () => {
    const result = PhaseOutputDeclarationSchema.parse({ type: 'string' })
    expect(result.type).toBe('string')
    expect(result.description).toBeUndefined()
    expect(result.required).toBeUndefined()
  })

  it('rejects missing type', () => {
    expect(() => PhaseOutputDeclarationSchema.parse({})).toThrow()
  })

  it('rejects invalid type', () => {
    expect(() => PhaseOutputDeclarationSchema.parse({ type: 'number' })).toThrow()
  })

  it('rejects non-boolean required', () => {
    expect(() => PhaseOutputDeclarationSchema.parse({
      type: 'string',
      required: 'yes',
    })).toThrow()
  })
})

describe('PhaseInputDeclarationSchema', () => {
  it('validates a minimal input declaration', () => {
    const result = PhaseInputDeclarationSchema.parse({
      from: 'development.prUrl',
    })
    expect(result.from).toBe('development.prUrl')
    expect(result.description).toBeUndefined()
  })

  it('validates with description', () => {
    const result = PhaseInputDeclarationSchema.parse({
      from: 'development.prUrl',
      description: 'The PR URL from the development phase',
    })
    expect(result.description).toBe('The PR URL from the development phase')
  })

  it('rejects missing from', () => {
    expect(() => PhaseInputDeclarationSchema.parse({})).toThrow()
  })

  it('rejects empty from', () => {
    expect(() => PhaseInputDeclarationSchema.parse({ from: '' })).toThrow()
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

// ---------------------------------------------------------------------------
// Cross-validation tests
// ---------------------------------------------------------------------------

describe('validateWorkflowDefinition cross-validation', () => {
  /** Helper to build a minimal valid workflow with overrides */
  function makeWorkflow(overrides: Record<string, unknown> = {}) {
    return {
      apiVersion: 'v1.1',
      kind: 'WorkflowDefinition',
      metadata: { name: 'test-cross-validation' },
      phases: [
        { name: 'dev', template: 'development' },
        { name: 'qa', template: 'qa' },
      ],
      transitions: [
        { from: 'Backlog', to: 'dev' },
      ],
      ...overrides,
    }
  }

  it('validates example YAML against schema', () => {
    const examplePath = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      'defaults',
      'workflow-parallel-example.yaml',
    )
    const content = fs.readFileSync(examplePath, 'utf-8')
    const data = parseYaml(content)
    const result = validateWorkflowDefinition(data, examplePath)
    expect(result.metadata.name).toBe('parallel-development')
    expect(result.parallelism).toHaveLength(1)
    expect(result.parallelism![0].strategy).toBe('fan-in')
    expect(result.phases.find(p => p.name === 'development')?.outputs).toBeDefined()
    expect(result.phases.find(p => p.name === 'qa')?.inputs).toBeDefined()
  })

  it('rejects parallelism group referencing undefined phase', () => {
    expect(() => validateWorkflowDefinition(makeWorkflow({
      parallelism: [{
        name: 'bad-group',
        phases: ['nonexistent'],
        strategy: 'fan-out',
      }],
    }))).toThrow('Parallelism group "bad-group" references undefined phase "nonexistent"')
  })

  it('includes file path in parallelism group error', () => {
    expect(() => validateWorkflowDefinition(makeWorkflow({
      parallelism: [{
        name: 'bad-group',
        phases: ['nonexistent'],
        strategy: 'fan-out',
      }],
    }), '/some/path.yaml')).toThrow('in /some/path.yaml')
  })

  it('rejects phase input with invalid from format', () => {
    expect(() => validateWorkflowDefinition(makeWorkflow({
      phases: [
        { name: 'dev', template: 'development' },
        {
          name: 'qa',
          template: 'qa',
          inputs: { prUrl: { from: 'invalid-no-dot' } },
        },
      ],
    }))).toThrow('expected "phaseName.outputKey" format')
  })

  it('rejects phase input with too many dot segments', () => {
    expect(() => validateWorkflowDefinition(makeWorkflow({
      phases: [
        { name: 'dev', template: 'development' },
        {
          name: 'qa',
          template: 'qa',
          inputs: { prUrl: { from: 'a.b.c' } },
        },
      ],
    }))).toThrow('expected "phaseName.outputKey" format')
  })

  it('rejects phase input referencing undefined phase', () => {
    expect(() => validateWorkflowDefinition(makeWorkflow({
      phases: [
        { name: 'dev', template: 'development' },
        {
          name: 'qa',
          template: 'qa',
          inputs: { prUrl: { from: 'nonexistent.prUrl' } },
        },
      ],
    }))).toThrow('references undefined phase "nonexistent"')
  })

  it('rejects phase input referencing undefined output key', () => {
    expect(() => validateWorkflowDefinition(makeWorkflow({
      phases: [
        {
          name: 'dev',
          template: 'development',
          outputs: {
            branch: { type: 'string' },
          },
        },
        {
          name: 'qa',
          template: 'qa',
          inputs: { prUrl: { from: 'dev.prUrl' } },
        },
      ],
    }))).toThrow('references undefined output "prUrl" on phase "dev"')
  })

  it('allows phase input referencing phase without outputs declared', () => {
    // When the source phase has no outputs declared at all, we allow the
    // reference through — the outputs may be dynamic / not statically declared
    const result = validateWorkflowDefinition(makeWorkflow({
      phases: [
        { name: 'dev', template: 'development' },
        {
          name: 'qa',
          template: 'qa',
          inputs: { prUrl: { from: 'dev.prUrl' } },
        },
      ],
    }))
    expect(result.phases).toHaveLength(2)
  })

  it('warns on high maxConcurrent', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      validateWorkflowDefinition(makeWorkflow({
        parallelism: [{
          name: 'big-group',
          phases: ['dev'],
          strategy: 'fan-out',
          maxConcurrent: 20,
        }],
      }))
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('maxConcurrent=20 which may be excessive')
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('does not warn when maxConcurrent is at or below threshold', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      validateWorkflowDefinition(makeWorkflow({
        parallelism: [{
          name: 'ok-group',
          phases: ['dev'],
          strategy: 'fan-out',
          maxConcurrent: 10,
        }],
      }))
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('passes cross-validation for valid workflow with parallelism and inputs/outputs', () => {
    const result = validateWorkflowDefinition(makeWorkflow({
      phases: [
        {
          name: 'dev',
          template: 'development',
          outputs: {
            prUrl: { type: 'url', required: true },
          },
        },
        {
          name: 'qa',
          template: 'qa',
          inputs: {
            prUrls: { from: 'dev.prUrl' },
          },
        },
      ],
      parallelism: [{
        name: 'dev-fan-in',
        phases: ['dev'],
        strategy: 'fan-in',
        maxConcurrent: 5,
        waitForAll: true,
      }],
    }))
    expect(result.parallelism).toHaveLength(1)
    expect(result.phases.find(p => p.name === 'qa')?.inputs).toBeDefined()
  })
})
