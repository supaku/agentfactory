import { describe, it, expect, beforeEach } from 'vitest'
import {
  ObservationSchema,
  InMemoryObservationSink,
  NoopObservationSink,
} from '../observations.js'
import type { Observation } from '../observations.js'
import {
  createObservationHook,
  extractObservation,
  resetIdCounter,
} from '../observation-hook.js'
import type { ToolEvent } from '../observation-hook.js'

// ── Observation Schema Tests ─────────────────────────────────────────

describe('ObservationSchema', () => {
  it('validates a valid file_operation observation', () => {
    const obs: Observation = {
      id: 'obs_1',
      type: 'file_operation',
      content: 'read /src/index.ts',
      sessionId: 'session-1',
      projectScope: 'github.com/org/repo',
      timestamp: Date.now(),
      source: 'auto_capture',
      weight: 1.0,
      detail: {
        filePath: '/src/index.ts',
        operationType: 'read',
        summary: 'Read file',
      },
    }
    const result = ObservationSchema.safeParse(obs)
    expect(result.success).toBe(true)
  })

  it('validates a valid error_encountered observation', () => {
    const obs: Observation = {
      id: 'obs_2',
      type: 'error_encountered',
      content: 'Error in Bash: command not found',
      sessionId: 'session-1',
      projectScope: 'github.com/org/repo',
      timestamp: Date.now(),
      source: 'auto_capture',
      weight: 1.5,
      detail: {
        error: 'command not found',
        fix: 'install the missing package',
      },
    }
    const result = ObservationSchema.safeParse(obs)
    expect(result.success).toBe(true)
  })

  it('is JSON serializable (round-trip)', () => {
    const obs: Observation = {
      id: 'obs_3',
      type: 'file_operation',
      content: 'edit /src/app.ts',
      sessionId: 'session-2',
      projectScope: 'my-project',
      timestamp: 1700000000000,
      source: 'auto_capture',
      weight: 1.0,
      detail: {
        filePath: '/src/app.ts',
        operationType: 'edit',
        summary: 'Edited function signature',
      },
      tags: ['refactor'],
    }
    const json = JSON.stringify(obs)
    const parsed = JSON.parse(json)
    // Compare without BigInt issues
    expect(parsed.id).toBe(obs.id)
    expect(parsed.type).toBe(obs.type)
    expect(parsed.content).toBe(obs.content)
    expect(parsed.sessionId).toBe(obs.sessionId)
    expect(parsed.projectScope).toBe(obs.projectScope)
    expect(parsed.timestamp).toBe(obs.timestamp)
    expect(parsed.tags).toEqual(obs.tags)
  })

  it('rejects invalid observation type', () => {
    const result = ObservationSchema.safeParse({
      id: 'obs_1',
      type: 'invalid_type',
      content: 'test',
      sessionId: 'session-1',
      projectScope: 'project',
      timestamp: Date.now(),
    })
    expect(result.success).toBe(false)
  })
})

// ── Observation Sink Tests ───────────────────────────────────────────

describe('InMemoryObservationSink', () => {
  it('collects emitted observations', async () => {
    const sink = new InMemoryObservationSink()
    const obs: Observation = {
      id: 'obs_1',
      type: 'file_operation',
      content: 'read /src/index.ts',
      sessionId: 'session-1',
      projectScope: 'project',
      timestamp: Date.now(),
      source: 'auto_capture',
      weight: 1.0,
    }
    await sink.emit(obs)
    expect(sink.observations).toHaveLength(1)
    expect(sink.observations[0]).toEqual(obs)
  })

  it('clears observations', async () => {
    const sink = new InMemoryObservationSink()
    await sink.emit({
      id: 'obs_1',
      type: 'file_operation',
      content: 'test',
      sessionId: 's',
      projectScope: 'p',
      timestamp: Date.now(),
      source: 'auto_capture',
      weight: 1.0,
    })
    sink.clear()
    expect(sink.observations).toHaveLength(0)
  })
})

describe('NoopObservationSink', () => {
  it('does not store observations', async () => {
    const sink = new NoopObservationSink()
    await sink.emit({
      id: 'obs_1',
      type: 'file_operation',
      content: 'test',
      sessionId: 's',
      projectScope: 'p',
      timestamp: Date.now(),
      source: 'auto_capture',
      weight: 1.0,
    })
    // NoopSink has no observations property — just verifying it doesn't throw
    expect(true).toBe(true)
  })
})

// ── Observation Hook Tests ───────────────────────────────────────────

describe('createObservationHook', () => {
  let sink: InMemoryObservationSink

  beforeEach(() => {
    sink = new InMemoryObservationSink()
    resetIdCounter()
  })

  it('registers and fires on tool events', async () => {
    const hook = createObservationHook({
      sessionId: 'session-1',
      projectScope: 'project-1',
      sink,
    })
    await hook({
      toolName: 'Read',
      input: { file_path: '/src/index.ts' },
      output: 'file contents here',
    })
    expect(sink.observations).toHaveLength(1)
    expect(sink.observations[0].type).toBe('file_operation')
  })

  it('produces file_operation for Read tool', async () => {
    const hook = createObservationHook({
      sessionId: 'session-1',
      projectScope: 'project-1',
      sink,
    })
    await hook({
      toolName: 'Read',
      input: { file_path: '/src/app.ts' },
      output: 'content',
    })
    const obs = sink.observations[0]
    expect(obs.type).toBe('file_operation')
    expect(obs.detail).toBeDefined()
    const detail = obs.detail as any
    expect(detail.filePath).toBe('/src/app.ts')
    expect(detail.operationType).toBe('read')
  })

  it('produces file_operation for Write tool', async () => {
    const hook = createObservationHook({
      sessionId: 'session-1',
      projectScope: 'project-1',
      sink,
    })
    await hook({
      toolName: 'Write',
      input: { file_path: '/src/new-file.ts', content: 'export const x = 1' },
      output: 'File written',
    })
    const obs = sink.observations[0]
    expect(obs.type).toBe('file_operation')
    const detail = obs.detail as any
    expect(detail.filePath).toBe('/src/new-file.ts')
    expect(detail.operationType).toBe('write')
  })

  it('produces file_operation for Edit tool', async () => {
    const hook = createObservationHook({
      sessionId: 'session-1',
      projectScope: 'project-1',
      sink,
    })
    await hook({
      toolName: 'Edit',
      input: { file_path: '/src/app.ts', old_string: 'const x = 1', new_string: 'const x = 2' },
      output: 'File edited',
    })
    const obs = sink.observations[0]
    expect(obs.type).toBe('file_operation')
    const detail = obs.detail as any
    expect(detail.filePath).toBe('/src/app.ts')
    expect(detail.operationType).toBe('edit')
    expect(detail.summary).toContain('const x = 1')
  })

  it('produces error_encountered for error tool results', async () => {
    const hook = createObservationHook({
      sessionId: 'session-1',
      projectScope: 'project-1',
      sink,
    })
    await hook({
      toolName: 'Bash',
      input: { command: 'pnpm test' },
      output: 'Error: test failed - Cannot find module',
      isError: true,
    })
    const obs = sink.observations[0]
    expect(obs.type).toBe('error_encountered')
    const detail = obs.detail as any
    expect(detail.error).toContain('Cannot find module')
  })

  it('includes session ID and timestamp on every observation', async () => {
    const hook = createObservationHook({
      sessionId: 'my-session-42',
      projectScope: 'my-project',
      sink,
    })
    const before = Date.now()
    await hook({
      toolName: 'Read',
      input: { file_path: '/src/index.ts' },
      output: 'content',
    })
    const after = Date.now()
    const obs = sink.observations[0]
    expect(obs.sessionId).toBe('my-session-42')
    expect(obs.projectScope).toBe('my-project')
    expect(obs.timestamp).toBeGreaterThanOrEqual(before)
    expect(obs.timestamp).toBeLessThanOrEqual(after)
  })

  it('includes project scope on every observation', async () => {
    const hook = createObservationHook({
      sessionId: 'session-1',
      projectScope: 'github.com/org/repo',
      sink,
    })
    await hook({
      toolName: 'Write',
      input: { file_path: '/src/test.ts', content: 'test' },
      output: 'ok',
    })
    expect(sink.observations[0].projectScope).toBe('github.com/org/repo')
  })

  it('does not throw on extraction errors', async () => {
    const hook = createObservationHook({
      sessionId: 'session-1',
      projectScope: 'project-1',
      sink,
    })
    // Pass malformed event — should not throw
    await hook({
      toolName: 'Read',
      input: null as any,
      output: 'content',
    })
    // No observations emitted, but no error thrown
    expect(sink.observations).toHaveLength(0)
  })

  it('is no-op when memory is disabled', async () => {
    const hook = createObservationHook({
      sessionId: 'session-1',
      projectScope: 'project-1',
      sink,
      enabled: false,
    })
    await hook({
      toolName: 'Read',
      input: { file_path: '/src/index.ts' },
      output: 'content',
    })
    expect(sink.observations).toHaveLength(0)
  })

  it('multiple tool calls produce chronologically ordered observations', async () => {
    const hook = createObservationHook({
      sessionId: 'session-1',
      projectScope: 'project-1',
      sink,
    })
    await hook({ toolName: 'Read', input: { file_path: '/a.ts' }, output: 'a' })
    await hook({ toolName: 'Write', input: { file_path: '/b.ts', content: 'b' }, output: 'ok' })
    await hook({ toolName: 'Edit', input: { file_path: '/c.ts', old_string: 'x', new_string: 'y' }, output: 'ok' })

    expect(sink.observations).toHaveLength(3)
    // Chronologically ordered
    for (let i = 1; i < sink.observations.length; i++) {
      expect(sink.observations[i].timestamp).toBeGreaterThanOrEqual(
        sink.observations[i - 1].timestamp,
      )
    }
  })

  it('extracts Grep observations', async () => {
    const hook = createObservationHook({
      sessionId: 'session-1',
      projectScope: 'project-1',
      sink,
    })
    await hook({
      toolName: 'Grep',
      input: { pattern: 'MemoryStore', path: '/src' },
      output: 'found 5 matches',
    })
    expect(sink.observations).toHaveLength(1)
    const detail = sink.observations[0].detail as any
    expect(detail.operationType).toBe('grep')
    expect(detail.summary).toContain('MemoryStore')
  })

  it('extracts Glob observations', async () => {
    const hook = createObservationHook({
      sessionId: 'session-1',
      projectScope: 'project-1',
      sink,
    })
    await hook({
      toolName: 'Glob',
      input: { pattern: '**/*.test.ts' },
      output: 'found files',
    })
    expect(sink.observations).toHaveLength(1)
    const detail = sink.observations[0].detail as any
    expect(detail.operationType).toBe('glob')
  })

  it('extracts Bash git command observations', async () => {
    const hook = createObservationHook({
      sessionId: 'session-1',
      projectScope: 'project-1',
      sink,
    })
    await hook({
      toolName: 'Bash',
      input: { command: 'git commit -m "fix: update types"' },
      output: '[main abc123] fix: update types',
    })
    expect(sink.observations).toHaveLength(1)
    expect(sink.observations[0].content).toContain('git commit')
  })

  it('extracts Bash test/build command observations', async () => {
    const hook = createObservationHook({
      sessionId: 'session-1',
      projectScope: 'project-1',
      sink,
    })
    await hook({
      toolName: 'Bash',
      input: { command: 'pnpm test' },
      output: 'All tests passed',
    })
    expect(sink.observations).toHaveLength(1)
    expect(sink.observations[0].detail).toBeDefined()
    const detail = sink.observations[0].detail as any
    expect(detail.summary).toContain('Build/test')
  })

  it('skips unrecognized Bash commands', async () => {
    const hook = createObservationHook({
      sessionId: 'session-1',
      projectScope: 'project-1',
      sink,
    })
    await hook({
      toolName: 'Bash',
      input: { command: 'echo hello' },
      output: 'hello',
    })
    expect(sink.observations).toHaveLength(0)
  })
})

// ── extractObservation Unit Tests ────────────────────────────────────

describe('extractObservation', () => {
  beforeEach(() => {
    resetIdCounter()
  })

  it('returns null for unknown tool names', () => {
    const result = extractObservation(
      { toolName: 'UnknownTool', input: { foo: 'bar' } },
      'session-1',
      'project-1',
    )
    expect(result).toBeNull()
  })

  it('returns file_operation for Read with correct fields', () => {
    const result = extractObservation(
      { toolName: 'Read', input: { file_path: '/src/index.ts' }, output: 'content' },
      'session-1',
      'project-1',
    )
    expect(result).not.toBeNull()
    expect(result!.type).toBe('file_operation')
    expect(result!.sessionId).toBe('session-1')
    expect(result!.projectScope).toBe('project-1')
    expect(result!.id).toMatch(/^obs_/)
  })

  it('returns error_encountered for error events', () => {
    const result = extractObservation(
      { toolName: 'Bash', input: { command: 'fail' }, output: 'ENOENT: no such file', isError: true },
      'session-1',
      'project-1',
    )
    expect(result).not.toBeNull()
    expect(result!.type).toBe('error_encountered')
    expect(result!.weight).toBe(1.5) // Errors have higher weight
  })

  it('returns null for Read with no file_path', () => {
    const result = extractObservation(
      { toolName: 'Read', input: {} },
      'session-1',
      'project-1',
    )
    expect(result).toBeNull()
  })

  it('handles Read with offset parameter', () => {
    const result = extractObservation(
      { toolName: 'Read', input: { file_path: '/src/big.ts', offset: 100 } },
      'session-1',
      'project-1',
    )
    expect(result).not.toBeNull()
    const detail = result!.detail as any
    expect(detail.summary).toContain('line 100')
  })
})
