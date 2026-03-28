import { describe, it, expect } from 'vitest'
import { generateTemplateSchema, extractTemplateVariables } from './schema.js'
import { TemplateRegistry } from './registry.js'
import type { WorkflowTemplate } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTemplate(prompt: string, overrides: Partial<WorkflowTemplate> = {}): WorkflowTemplate {
  return {
    apiVersion: 'v1',
    kind: 'WorkflowTemplate',
    metadata: {
      name: 'test-template',
      description: 'A test template',
      workType: 'development',
    },
    prompt,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// extractTemplateVariables
// ---------------------------------------------------------------------------

describe('extractTemplateVariables', () => {
  it('extracts simple variable references', () => {
    const vars = extractTemplateVariables('Hello {{ identifier }}, your status is {{ startStatus }}')
    expect(vars).toContain('identifier')
    expect(vars).toContain('startStatus')
  })

  it('extracts dotted variable references (top-level only)', () => {
    const vars = extractTemplateVariables('{{ phaseOutputs.dev.prUrl }}')
    expect(vars).toContain('phaseOutputs')
    expect(vars).not.toContain('dev')
  })

  it('extracts variables from #if blocks', () => {
    const vars = extractTemplateVariables('{{#if parentContext}}Parent: {{ parentContext }}{{/if}}')
    expect(vars).toContain('parentContext')
  })

  it('extracts variables from #unless blocks', () => {
    const vars = extractTemplateVariables('{{#unless useToolPlugins}}Use CLI{{/unless}}')
    expect(vars).toContain('useToolPlugins')
  })

  it('extracts variables from #each blocks', () => {
    const vars = extractTemplateVariables('{{#each previousFailureReasons}}Reason: {{this}}{{/each}}')
    expect(vars).toContain('previousFailureReasons')
    // 'this' should be excluded
    expect(vars).not.toContain('this')
  })

  it('extracts variables from eq/neq helpers', () => {
    const vars = extractTemplateVariables('{{#if (eq strategy "decompose")}}Decompose{{/if}}')
    expect(vars).toContain('strategy')
  })

  it('returns empty set for prompt with no variables', () => {
    const vars = extractTemplateVariables('Plain text with no expressions')
    expect(vars.size).toBe(0)
  })

  it('handles whitespace in expressions', () => {
    const vars = extractTemplateVariables('{{  identifier  }}')
    expect(vars).toContain('identifier')
  })
})

// ---------------------------------------------------------------------------
// generateTemplateSchema
// ---------------------------------------------------------------------------

describe('generateTemplateSchema', () => {
  it('generates valid JSON Schema 7', () => {
    const template = makeTemplate('{{ identifier }} - {{ strategy }}')
    const schema = generateTemplateSchema(template)
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#')
    expect(schema.type).toBe('object')
  })

  it('includes only referenced fields by default', () => {
    const template = makeTemplate('Issue {{ identifier }} with strategy {{ strategy }}')
    const schema = generateTemplateSchema(template)
    expect(schema.properties).toHaveProperty('identifier')
    expect(schema.properties).toHaveProperty('strategy')
    expect(schema.properties).not.toHaveProperty('buildCommand')
    expect(schema.properties).not.toHaveProperty('testCommand')
  })

  it('includes all fields when includeAllFields is true', () => {
    const template = makeTemplate('{{ identifier }}')
    const schema = generateTemplateSchema(template, { includeAllFields: true })
    expect(schema.properties).toHaveProperty('identifier')
    expect(schema.properties).toHaveProperty('strategy')
    expect(schema.properties).toHaveProperty('buildCommand')
    expect(schema.properties).toHaveProperty('testCommand')
  })

  it('marks identifier as required', () => {
    const template = makeTemplate('{{ identifier }}')
    const schema = generateTemplateSchema(template)
    expect(schema.required).toContain('identifier')
  })

  it('uses template name and description in schema', () => {
    const template = makeTemplate('{{ identifier }}', {
      metadata: {
        name: 'my-template',
        description: 'My custom template',
        workType: 'development',
      },
    })
    const schema = generateTemplateSchema(template)
    expect(schema.title).toBe('my-template config')
    expect(schema.description).toBe('My custom template')
  })

  it('sets additionalProperties to true (extensible)', () => {
    const template = makeTemplate('{{ identifier }}')
    const schema = generateTemplateSchema(template)
    expect(schema.additionalProperties).toBe(true)
  })

  it('generates correct types for known fields', () => {
    const template = makeTemplate(
      '{{ identifier }} {{ cycleCount }} {{ useToolPlugins }} {{ previousFailureReasons }} {{ totalCostUsd }}'
    )
    const schema = generateTemplateSchema(template)
    const props = schema.properties!

    expect((props.identifier as any).type).toBe('string')
    expect((props.cycleCount as any).type).toBe('integer')
    expect((props.useToolPlugins as any).type).toBe('boolean')
    expect((props.previousFailureReasons as any).type).toBe('array')
    expect((props.totalCostUsd as any).type).toBe('number')
  })
})

// ---------------------------------------------------------------------------
// TemplateRegistry.getSchema()
// ---------------------------------------------------------------------------

describe('TemplateRegistry.getSchema', () => {
  it('returns null for unknown template', () => {
    const registry = new TemplateRegistry()
    expect(registry.getSchema('nonexistent')).toBeNull()
  })

  it('returns JSON Schema for registered template', () => {
    const registry = new TemplateRegistry()
    registry.initialize({
      useBuiltinDefaults: false,
      templates: {
        development: makeTemplate('Work on {{ identifier }} using {{ buildCommand }}'),
      },
    })
    const schema = registry.getSchema('development')
    expect(schema).not.toBeNull()
    expect(schema?.properties).toHaveProperty('identifier')
    expect(schema?.properties).toHaveProperty('buildCommand')
  })

  it('passes options through to schema generator', () => {
    const registry = new TemplateRegistry()
    registry.initialize({
      useBuiltinDefaults: false,
      templates: {
        development: makeTemplate('{{ identifier }}'),
      },
    })

    const defaultSchema = registry.getSchema('development')
    const fullSchema = registry.getSchema('development', { includeAllFields: true })

    expect(Object.keys(defaultSchema!.properties!).length).toBeLessThan(
      Object.keys(fullSchema!.properties!).length
    )
  })
})

// ---------------------------------------------------------------------------
// TemplateRegistry.validateConfig()
// ---------------------------------------------------------------------------

describe('TemplateRegistry.validateConfig', () => {
  function createRegistryWithTemplate(prompt: string): TemplateRegistry {
    const registry = new TemplateRegistry()
    registry.initialize({
      useBuiltinDefaults: false,
      templates: {
        development: makeTemplate(prompt),
      },
    })
    return registry
  }

  it('returns invalid for unknown template', () => {
    const registry = new TemplateRegistry()
    const result = registry.validateConfig('nonexistent', { identifier: 'SUP-1' })
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('not found')
  })

  it('validates required fields', () => {
    const registry = createRegistryWithTemplate('{{ identifier }}')
    const result = registry.validateConfig('development', {})
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('identifier'))).toBe(true)
  })

  it('accepts valid config', () => {
    const registry = createRegistryWithTemplate('{{ identifier }} {{ strategy }}')
    const result = registry.validateConfig('development', {
      identifier: 'SUP-123',
      strategy: 'normal',
    })
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('treats template expressions as valid for any field', () => {
    const registry = createRegistryWithTemplate('{{ identifier }} {{ cycleCount }}')
    const result = registry.validateConfig('development', {
      identifier: '{{ issue.identifier }}',
      cycleCount: '{{ escalation.cycleCount }}',
    })
    expect(result.valid).toBe(true)
  })

  it('detects type mismatches', () => {
    const registry = createRegistryWithTemplate('{{ identifier }} {{ cycleCount }}')
    const result = registry.validateConfig('development', {
      identifier: 123, // should be string
      cycleCount: 'not-a-number', // should be integer
    })
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('identifier'))).toBe(true)
    expect(result.errors.some(e => e.includes('cycleCount'))).toBe(true)
  })

  it('allows additional properties not in schema', () => {
    const registry = createRegistryWithTemplate('{{ identifier }}')
    const result = registry.validateConfig('development', {
      identifier: 'SUP-123',
      customField: 'custom-value',
    })
    expect(result.valid).toBe(true)
  })
})
