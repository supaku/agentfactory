import { describe, it, expect } from 'vitest'
import {
  parseAgentDefinition,
  AgentDefinitionFrontmatterSchema,
} from './agent-definition.js'

describe('AgentDefinitionFrontmatterSchema', () => {
  it('validates a minimal frontmatter', () => {
    const result = AgentDefinitionFrontmatterSchema.parse({ name: 'developer' })
    expect(result.name).toBe('developer')
    expect(result.build_commands).toBeUndefined()
    expect(result.test_commands).toBeUndefined()
    expect(result.af_linear).toBeUndefined()
  })

  it('validates a complete frontmatter', () => {
    const result = AgentDefinitionFrontmatterSchema.parse({
      name: 'developer',
      description: 'General-purpose development agent',
      tools: 'Read, Edit, Write, Grep, Glob, Bash',
      model: 'opus',
      build_commands: {
        verify: 'cmake --build build/',
        full: 'cmake --build build/ --target all',
      },
      test_commands: {
        unit: 'ctest --test-dir build/',
        integration: '',
      },
      af_linear: 'bash tools/af-linear.sh',
    })
    expect(result.name).toBe('developer')
    expect(result.model).toBe('opus')
    expect(result.build_commands).toEqual({
      verify: 'cmake --build build/',
      full: 'cmake --build build/ --target all',
    })
    expect(result.test_commands).toEqual({
      unit: 'ctest --test-dir build/',
      integration: '',
    })
    expect(result.af_linear).toBe('bash tools/af-linear.sh')
  })

  it('rejects invalid model', () => {
    expect(() =>
      AgentDefinitionFrontmatterSchema.parse({ name: 'test', model: 'gpt-4' })
    ).toThrow()
  })

  it('rejects empty name', () => {
    expect(() =>
      AgentDefinitionFrontmatterSchema.parse({ name: '' })
    ).toThrow()
  })
})

describe('parseAgentDefinition', () => {
  it('parses a simple agent definition', () => {
    const content = `---
name: developer
description: Implements features
tools: Read, Edit, Write
model: opus
---

# Developer Agent

Implements features and fixes bugs.
`
    const result = parseAgentDefinition(content)
    expect(result.frontmatter.name).toBe('developer')
    expect(result.frontmatter.description).toBe('Implements features')
    expect(result.frontmatter.tools).toBe('Read, Edit, Write')
    expect(result.frontmatter.model).toBe('opus')
    expect(result.rawBody).toContain('# Developer Agent')
    expect(result.renderedBody).toContain('# Developer Agent')
  })

  it('parses and interpolates build_commands in body', () => {
    const content = `---
name: developer
build_commands:
  verify: "cmake --build build/"
  full: "make all"
---

## Build

Verify build: \`{{build_commands.verify}}\`
Full build: \`{{build_commands.full}}\`
`
    const result = parseAgentDefinition(content)
    expect(result.frontmatter.build_commands).toEqual({
      verify: 'cmake --build build/',
      full: 'make all',
    })
    expect(result.renderedBody).toContain('Verify build: `cmake --build build/`')
    expect(result.renderedBody).toContain('Full build: `make all`')
  })

  it('parses and interpolates test_commands in body', () => {
    const content = `---
name: qa
test_commands:
  unit: "cargo test"
  integration: "cargo test -- --ignored"
---

Run unit tests: \`{{test_commands.unit}}\`
Run integration tests: \`{{test_commands.integration}}\`
`
    const result = parseAgentDefinition(content)
    expect(result.renderedBody).toContain('Run unit tests: `cargo test`')
    expect(result.renderedBody).toContain('Run integration tests: `cargo test -- --ignored`')
  })

  it('parses and interpolates af_linear in body', () => {
    const content = `---
name: developer
af_linear: "bash tools/af-linear.sh"
---

Use \`{{af_linear}}\` for all Linear operations.
`
    const result = parseAgentDefinition(content)
    expect(result.renderedBody).toContain('Use `bash tools/af-linear.sh` for all Linear operations.')
  })

  it('preserves raw body without modifying it', () => {
    const content = `---
name: developer
build_commands:
  verify: "cmake --build build/"
---

Build: \`{{build_commands.verify}}\`
`
    const result = parseAgentDefinition(content)
    expect(result.rawBody).toContain('{{build_commands.verify}}')
    expect(result.renderedBody).toContain('cmake --build build/')
  })

  it('handles body with no Handlebars expressions', () => {
    const content = `---
name: developer
tools: Read, Edit
---

# Simple Agent

No interpolation here.
`
    const result = parseAgentDefinition(content)
    expect(result.renderedBody).toContain('No interpolation here.')
  })

  it('handles empty build_commands gracefully', () => {
    const content = `---
name: developer
build_commands: {}
test_commands: {}
---

# Agent
`
    const result = parseAgentDefinition(content)
    expect(result.frontmatter.build_commands).toEqual({})
    expect(result.frontmatter.test_commands).toEqual({})
  })

  it('throws on missing frontmatter delimiters', () => {
    const content = `# No frontmatter here

Just a regular markdown file.
`
    expect(() => parseAgentDefinition(content)).toThrow('must start with YAML frontmatter')
  })

  it('throws on invalid frontmatter schema', () => {
    const content = `---
model: gpt-4
---

# Agent
`
    expect(() => parseAgentDefinition(content)).toThrow()
  })

  it('works with existing TypeScript agent definitions (backward compat)', () => {
    // This mimics the existing developer.md format
    const content = `---
name: developer
description: General-purpose development agent. Implements features, fixes bugs, and writes tests.
tools: Read, Edit, Write, Grep, Glob, Bash
model: opus
---

# Developer Agent

Implements features and fixes bugs based on Linear issue requirements.

## Testing

\`\`\`bash
pnpm turbo run test --filter=[package-name]
pnpm turbo run typecheck --filter=[package-name]
pnpm turbo run build --filter=[package-name]
\`\`\`
`
    const result = parseAgentDefinition(content)
    expect(result.frontmatter.name).toBe('developer')
    expect(result.frontmatter.build_commands).toBeUndefined()
    expect(result.frontmatter.test_commands).toBeUndefined()
    expect(result.frontmatter.af_linear).toBeUndefined()
    expect(result.renderedBody).toContain('pnpm turbo run test')
  })

  it('interpolates name and other basic fields in body', () => {
    const content = `---
name: my-agent
description: A special agent
model: sonnet
---

This is the {{name}} agent. Model: {{model}}.
`
    const result = parseAgentDefinition(content)
    expect(result.renderedBody).toContain('This is the my-agent agent. Model: sonnet.')
  })
})
