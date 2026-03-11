/**
 * Integration tests for Spring AI Provider
 *
 * Tests the full provider lifecycle using mock subprocess that emits
 * Spring AI JSONL events, covering:
 * - Happy path spawn + complete
 * - Session resume
 * - Error handling (missing JAR, missing Java, agent crash)
 * - Cost data extraction accuracy
 * - Tool permission adapter output
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SpringAiProvider } from './spring-ai-provider.js'
import { SpringAiToolPermissionAdapter, createToolPermissionAdapter } from '../templates/adapters.js'
import type { AgentSpawnConfig, AgentEvent } from './types.js'
import { PassThrough } from 'stream'
import { EventEmitter } from 'events'

// ---------------------------------------------------------------------------
// Mock child_process
// ---------------------------------------------------------------------------

interface MockChildProcess extends EventEmitter {
  pid: number
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  exitCode: number | null
  kill: ReturnType<typeof vi.fn>
}

function createMockChild(pid = 1234): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess
  child.pid = pid
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = null
  child.kill = vi.fn()
  return child
}

let mockChild: MockChildProcess

vi.mock('child_process', () => ({
  spawn: vi.fn(() => mockChild),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<AgentSpawnConfig>): AgentSpawnConfig {
  return {
    prompt: 'Test prompt',
    cwd: '/tmp/test',
    env: { SPRING_AI_AGENT_JAR: '/path/to/agent.jar' },
    abortController: new AbortController(),
    autonomous: true,
    sandboxEnabled: false,
    ...overrides,
  }
}

function writeLine(child: MockChildProcess, data: Record<string, unknown>) {
  child.stdout.write(JSON.stringify(data) + '\n')
}

function endProcess(child: MockChildProcess, exitCode = 0) {
  child.stdout.end()
  child.exitCode = exitCode
  child.emit('exit', exitCode)
}

async function collectEvents(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of stream) {
    events.push(event)
  }
  return events
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SpringAiProvider integration', () => {
  let provider: SpringAiProvider

  beforeEach(() => {
    mockChild = createMockChild()
    provider = new SpringAiProvider()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('happy path spawn + complete', () => {
    it('produces init, assistant_text, and result events', async () => {
      const handle = provider.spawn(makeConfig())
      expect(handle.sessionId).toBeNull()

      // Emit events asynchronously
      setTimeout(() => {
        writeLine(mockChild, { type: 'session.started', session_id: 'sess-001' })
        writeLine(mockChild, { type: 'turn.started' })
        writeLine(mockChild, { type: 'assistant.message', id: 'msg-1', text: 'Hello world' })
        writeLine(mockChild, {
          type: 'turn.completed',
          usage: { input_tokens: 150, output_tokens: 75, model: 'gpt-4' },
        })
        endProcess(mockChild, 0)
      }, 10)

      const events = await collectEvents(handle.stream)

      expect(events).toHaveLength(4)
      expect(events[0]).toMatchObject({ type: 'init', sessionId: 'sess-001' })
      expect(events[1]).toMatchObject({ type: 'system', subtype: 'turn_started', message: 'Turn 1 started' })
      expect(events[2]).toMatchObject({ type: 'assistant_text', text: 'Hello world' })
      expect(events[3]).toMatchObject({
        type: 'result',
        success: true,
        cost: { inputTokens: 150, outputTokens: 75, numTurns: 1 },
      })

      // sessionId should be set after init event
      expect(handle.sessionId).toBe('sess-001')
    })

    it('handles multi-turn sessions with accumulated cost', async () => {
      const handle = provider.spawn(makeConfig())

      setTimeout(() => {
        writeLine(mockChild, { type: 'session.started', session_id: 'sess-002' })
        writeLine(mockChild, { type: 'turn.started' })
        writeLine(mockChild, { type: 'assistant.message', id: 'msg-1', text: 'Analyzing...' })
        writeLine(mockChild, {
          type: 'turn.completed',
          usage: { input_tokens: 100, output_tokens: 50 },
        })
        writeLine(mockChild, { type: 'turn.started' })
        writeLine(mockChild, { type: 'assistant.message', id: 'msg-2', text: 'Done!' })
        writeLine(mockChild, {
          type: 'turn.completed',
          usage: { input_tokens: 200, output_tokens: 80 },
        })
        endProcess(mockChild, 0)
      }, 10)

      const events = await collectEvents(handle.stream)
      const resultEvents = events.filter(e => e.type === 'result')

      expect(resultEvents).toHaveLength(2)
      // Second result should have accumulated totals
      expect(resultEvents[1]).toMatchObject({
        type: 'result',
        success: true,
        cost: { inputTokens: 300, outputTokens: 130, numTurns: 2 },
      })
    })
  })

  describe('tool use events', () => {
    it('maps tool invocation and result events', async () => {
      const handle = provider.spawn(makeConfig())

      setTimeout(() => {
        writeLine(mockChild, { type: 'session.started', session_id: 'sess-003' })
        writeLine(mockChild, { type: 'turn.started' })
        writeLine(mockChild, {
          type: 'tool.invocation',
          id: 'tool-1',
          tool_name: 'shell',
          input: { command: 'ls -la' },
        })
        writeLine(mockChild, {
          type: 'tool.result',
          id: 'tool-1',
          tool_name: 'shell',
          content: 'file1.txt\nfile2.txt',
          is_error: false,
        })
        writeLine(mockChild, { type: 'turn.completed' })
        endProcess(mockChild, 0)
      }, 10)

      const events = await collectEvents(handle.stream)
      const toolUse = events.find(e => e.type === 'tool_use')
      const toolResult = events.find(e => e.type === 'tool_result')

      expect(toolUse).toMatchObject({
        type: 'tool_use',
        toolName: 'shell',
        toolUseId: 'tool-1',
        input: { command: 'ls -la' },
      })
      expect(toolResult).toMatchObject({
        type: 'tool_result',
        toolName: 'shell',
        toolUseId: 'tool-1',
        content: 'file1.txt\nfile2.txt',
        isError: false,
      })
    })
  })

  describe('session resume', () => {
    it('passes resume session ID to CLI args', async () => {
      const { spawn: mockSpawn } = await import('child_process')

      const handle = provider.resume('sess-previous', makeConfig())

      // Verify spawn was called with --resume flag
      expect(mockSpawn).toHaveBeenCalled()
      const callArgs = (mockSpawn as ReturnType<typeof vi.fn>).mock.calls[0]
      const args: string[] = callArgs[1]

      expect(args).toContain('--resume')
      expect(args).toContain('sess-previous')

      // Complete the process to avoid hanging
      setTimeout(() => {
        writeLine(mockChild, { type: 'session.started', session_id: 'sess-previous' })
        writeLine(mockChild, { type: 'turn.completed' })
        endProcess(mockChild, 0)
      }, 10)

      const events = await collectEvents(handle.stream)
      expect(events[0]).toMatchObject({ type: 'init', sessionId: 'sess-previous' })
    })
  })

  describe('error handling', () => {
    it('handles missing SPRING_AI_AGENT_JAR gracefully', async () => {
      const config = makeConfig({ env: {} }) // No JAR path
      const handle = provider.spawn(config)

      const events = await collectEvents(handle.stream)

      expect(events).toHaveLength(2)
      expect(events[0]).toMatchObject({
        type: 'error',
        message: 'SPRING_AI_AGENT_JAR environment variable is not set',
      })
      expect(events[1]).toMatchObject({
        type: 'result',
        success: false,
        errorSubtype: 'configuration_error',
      })
    })

    it('handles agent crash (non-zero exit)', async () => {
      const handle = provider.spawn(makeConfig())

      setTimeout(() => {
        writeLine(mockChild, { type: 'session.started', session_id: 'sess-crash' })
        mockChild.stderr.write('Exception in thread "main" java.lang.OutOfMemoryError\n')
        endProcess(mockChild, 1)
      }, 10)

      const events = await collectEvents(handle.stream)
      const resultEvent = events.find(e => e.type === 'result')

      expect(resultEvent).toMatchObject({
        type: 'result',
        success: false,
        errorSubtype: 'process_exit',
      })
    })

    it('detects missing Java runtime', async () => {
      const handle = provider.spawn(makeConfig())

      setTimeout(() => {
        mockChild.stderr.write('java: not found\n')
        endProcess(mockChild, 127)
      }, 10)

      const events = await collectEvents(handle.stream)
      const resultEvent = events.find(e => e.type === 'result')

      expect(resultEvent).toMatchObject({
        type: 'result',
        success: false,
        errorSubtype: 'java_not_found',
      })
    })

    it('detects missing JAR file', async () => {
      const handle = provider.spawn(makeConfig())

      setTimeout(() => {
        mockChild.stderr.write('Error: Unable to access jarfile /path/to/agent.jar\n')
        endProcess(mockChild, 1)
      }, 10)

      const events = await collectEvents(handle.stream)
      const resultEvent = events.find(e => e.type === 'result')

      expect(resultEvent).toMatchObject({
        type: 'result',
        success: false,
        errorSubtype: 'jar_not_found',
      })
    })

    it('maps error events from the agent', async () => {
      const handle = provider.spawn(makeConfig())

      setTimeout(() => {
        writeLine(mockChild, { type: 'session.started', session_id: 'sess-err' })
        writeLine(mockChild, { type: 'error', message: 'Rate limit exceeded', code: 'RATE_LIMIT' })
        writeLine(mockChild, {
          type: 'turn.failed',
          error: { message: 'Rate limit exceeded' },
        })
        endProcess(mockChild, 1)
      }, 10)

      const events = await collectEvents(handle.stream)
      const errorEvent = events.find(e => e.type === 'error')
      const resultEvent = events.find(e => e.type === 'result')

      expect(errorEvent).toMatchObject({
        type: 'error',
        message: 'Rate limit exceeded',
        code: 'RATE_LIMIT',
      })
      expect(resultEvent).toMatchObject({
        type: 'result',
        success: false,
        errors: ['Rate limit exceeded'],
      })
    })
  })

  describe('abort / stop', () => {
    it('kills process on stop()', async () => {
      const handle = provider.spawn(makeConfig())

      // Start the stream but don't consume it yet
      setTimeout(async () => {
        writeLine(mockChild, { type: 'session.started', session_id: 'sess-stop' })
        await handle.stop()
        endProcess(mockChild, 0)
      }, 10)

      const events = await collectEvents(handle.stream)
      expect(events.length).toBeGreaterThanOrEqual(1)
    })

    it('injectMessage throws (not supported)', async () => {
      const handle = provider.spawn(makeConfig())
      await expect(handle.injectMessage('test')).rejects.toThrow(
        'Spring AI provider does not support mid-session message injection'
      )

      // Clean up process
      setTimeout(() => endProcess(mockChild, 0), 10)
      await collectEvents(handle.stream)
    })
  })

  describe('process spawned callback', () => {
    it('calls onProcessSpawned with PID', () => {
      const onProcessSpawned = vi.fn()
      provider.spawn(makeConfig({ onProcessSpawned }))
      expect(onProcessSpawned).toHaveBeenCalledWith(1234)
    })
  })

  describe('non-JSON output handling', () => {
    it('emits system events for non-JSON lines', async () => {
      const handle = provider.spawn(makeConfig())

      setTimeout(() => {
        mockChild.stdout.write('Spring AI Agent v0.1.0 starting...\n')
        writeLine(mockChild, { type: 'session.started', session_id: 'sess-log' })
        writeLine(mockChild, { type: 'turn.completed' })
        endProcess(mockChild, 0)
      }, 10)

      const events = await collectEvents(handle.stream)
      const systemEvent = events.find(e => e.type === 'system' && 'subtype' in e && e.subtype === 'raw_output')

      expect(systemEvent).toMatchObject({
        type: 'system',
        subtype: 'raw_output',
        message: 'Spring AI Agent v0.1.0 starting...',
      })
    })
  })
})

describe('SpringAiToolPermissionAdapter integration', () => {
  it('factory returns SpringAiToolPermissionAdapter for spring-ai', () => {
    const adapter = createToolPermissionAdapter('spring-ai')
    expect(adapter).toBeInstanceOf(SpringAiToolPermissionAdapter)
  })

  it('translates full permission set for Spring AI agent', () => {
    const adapter = createToolPermissionAdapter('spring-ai')
    const result = adapter.translatePermissions([
      { shell: 'pnpm *' },
      { shell: 'git commit *' },
      { shell: 'gh pr *' },
      'user-input',
      'Read',
      'Write',
    ])

    expect(result).toEqual([
      'spring-tool:shell:pnpm *',
      'spring-tool:shell:git commit *',
      'spring-tool:shell:gh pr *',
      'user-input',
      'Read',
      'Write',
    ])
  })
})

describe('createProvider integration', () => {
  it('creates SpringAiProvider via factory', async () => {
    const { createProvider } = await import('./index.js')
    const provider = createProvider('spring-ai')
    expect(provider.name).toBe('spring-ai')
  })
})
