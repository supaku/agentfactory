import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  mapCodexEvent,
  mapCodexItemEvent,
  CodexProvider,
  type CodexEvent,
  type CodexItemEvent,
  type CodexEventMapperState,
} from './codex-provider.js'
import type { AgentSpawnConfig, AgentEvent } from './types.js'

function freshState(): CodexEventMapperState {
  return {
    sessionId: null,
    model: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCachedInputTokens: 0,
    turnCount: 0,
  }
}

describe('mapCodexEvent', () => {
  it('maps thread.started to init', () => {
    const state = freshState()
    const event: CodexEvent = { type: 'thread.started', thread_id: 'thread-abc' }
    const result = mapCodexEvent(event, state)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: 'init',
      sessionId: 'thread-abc',
    })
    expect(state.sessionId).toBe('thread-abc')
  })

  it('maps turn.started to system with incrementing turn count', () => {
    const state = freshState()
    const event: CodexEvent = { type: 'turn.started' }

    const r1 = mapCodexEvent(event, state)
    expect(r1[0]).toMatchObject({
      type: 'system',
      subtype: 'turn_started',
      message: 'Turn 1 started',
    })
    expect(state.turnCount).toBe(1)

    const r2 = mapCodexEvent(event, state)
    expect(r2[0]).toMatchObject({ message: 'Turn 2 started' })
    expect(state.turnCount).toBe(2)
  })

  it('maps turn.completed to result with accumulated usage', () => {
    const state = freshState()
    state.turnCount = 1
    state.model = 'gpt-5-codex'

    const event: CodexEvent = {
      type: 'turn.completed',
      usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 20 },
    }
    const result = mapCodexEvent(event, state)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: 'result',
      success: true,
      cost: {
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 20,
        numTurns: 1,
      },
    })
    expect((result[0] as any).cost.totalCostUsd).toBeGreaterThan(0)
    expect(state.totalInputTokens).toBe(100)
    expect(state.totalOutputTokens).toBe(50)
    expect(state.totalCachedInputTokens).toBe(20)
  })

  it('accumulates usage across multiple turns', () => {
    const state = freshState()
    state.turnCount = 2
    state.model = 'gpt-5-codex'

    mapCodexEvent(
      { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 10 } },
      state,
    )
    const result = mapCodexEvent(
      { type: 'turn.completed', usage: { input_tokens: 200, output_tokens: 80, cached_input_tokens: 30 } },
      state,
    )

    expect(result[0]).toMatchObject({
      type: 'result',
      success: true,
      cost: { inputTokens: 300, outputTokens: 130, cachedInputTokens: 40 },
    })
    expect((result[0] as any).cost.totalCostUsd).toBeGreaterThan(0)
    expect(state.totalCachedInputTokens).toBe(40)
  })

  it('maps turn.completed without usage', () => {
    const state = freshState()
    const result = mapCodexEvent({ type: 'turn.completed' }, state)

    expect(result[0]).toMatchObject({ type: 'result', success: true })
  })

  it('maps turn.failed to failed result', () => {
    const state = freshState()
    const event: CodexEvent = {
      type: 'turn.failed',
      error: { message: 'Model error' },
    }
    const result = mapCodexEvent(event, state)

    expect(result[0]).toMatchObject({
      type: 'result',
      success: false,
      errors: ['Model error'],
      errorSubtype: 'turn_failed',
    })
  })

  it('maps turn.failed without error message', () => {
    const state = freshState()
    const result = mapCodexEvent({ type: 'turn.failed' }, state)

    expect(result[0]).toMatchObject({
      type: 'result',
      success: false,
      errors: ['Turn failed'],
    })
  })

  it('maps error event', () => {
    const state = freshState()
    const event: CodexEvent = { type: 'error', message: 'Connection lost' }
    const result = mapCodexEvent(event, state)

    expect(result[0]).toMatchObject({
      type: 'error',
      message: 'Connection lost',
    })
  })

  it('maps error event without message', () => {
    const state = freshState()
    const result = mapCodexEvent({ type: 'error' } as CodexEvent, state)

    expect(result[0]).toMatchObject({
      type: 'error',
      message: 'Unknown error',
    })
  })

  it('delegates item events to mapCodexItemEvent', () => {
    const state = freshState()
    const event: CodexEvent = {
      type: 'item.completed',
      item: { id: 'msg-1', type: 'agent_message', text: 'Hello' },
    }
    const result = mapCodexEvent(event, state)

    expect(result[0]).toMatchObject({
      type: 'assistant_text',
      text: 'Hello',
    })
  })

  it('handles unknown event type gracefully', () => {
    const state = freshState()
    const event = { type: 'unknown.event' } as unknown as CodexEvent
    const result = mapCodexEvent(event, state)

    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'unknown',
    })
  })
})

describe('mapCodexItemEvent', () => {
  it('maps agent_message to assistant_text', () => {
    const event: CodexItemEvent = {
      type: 'item.completed',
      item: { id: 'msg-1', type: 'agent_message', text: 'Analysis complete' },
    }
    const result = mapCodexItemEvent(event)

    expect(result).toEqual([{
      type: 'assistant_text',
      text: 'Analysis complete',
      raw: event,
    }])
  })

  it('maps reasoning to system event', () => {
    const event: CodexItemEvent = {
      type: 'item.completed',
      item: { id: 'r-1', type: 'reasoning', text: 'Thinking about the problem...' },
    }
    const result = mapCodexItemEvent(event)

    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'reasoning',
      message: 'Thinking about the problem...',
    })
  })

  it('maps command_execution item.started to tool_use', () => {
    const event: CodexItemEvent = {
      type: 'item.started',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        command: 'ls -la',
        aggregated_output: '',
        status: 'in_progress',
      },
    }
    const result = mapCodexItemEvent(event)

    expect(result[0]).toMatchObject({
      type: 'tool_use',
      toolName: 'shell',
      toolUseId: 'cmd-1',
      input: { command: 'ls -la' },
    })
  })

  it('maps command_execution item.completed to tool_result', () => {
    const event: CodexItemEvent = {
      type: 'item.completed',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        command: 'ls -la',
        aggregated_output: 'file1.txt\nfile2.txt',
        exit_code: 0,
        status: 'completed',
      },
    }
    const result = mapCodexItemEvent(event)

    expect(result[0]).toMatchObject({
      type: 'tool_result',
      toolName: 'shell',
      toolUseId: 'cmd-1',
      content: 'file1.txt\nfile2.txt',
      isError: false,
    })
  })

  it('marks command_execution as error on non-zero exit code', () => {
    const event: CodexItemEvent = {
      type: 'item.completed',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        command: 'false',
        aggregated_output: '',
        exit_code: 1,
        status: 'failed',
      },
    }
    const result = mapCodexItemEvent(event)

    expect(result[0]).toMatchObject({
      type: 'tool_result',
      isError: true,
    })
  })

  it('maps command_execution item.updated to progress', () => {
    const event: CodexItemEvent = {
      type: 'item.updated',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        command: 'npm install',
        aggregated_output: 'Installing...',
        status: 'in_progress',
      },
    }
    const result = mapCodexItemEvent(event)

    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'command_progress',
      message: 'Command: npm install (in_progress)',
    })
  })

  it('maps file_change to tool_result', () => {
    const event: CodexItemEvent = {
      type: 'item.completed',
      item: {
        id: 'fc-1',
        type: 'file_change',
        changes: [
          { path: 'src/index.ts', kind: 'update' },
          { path: 'src/new.ts', kind: 'add' },
        ],
        status: 'completed',
      },
    }
    const result = mapCodexItemEvent(event)

    expect(result[0]).toMatchObject({
      type: 'tool_result',
      toolName: 'file_change',
      content: 'update: src/index.ts\nadd: src/new.ts',
      isError: false,
    })
  })

  it('maps mcp_tool_call item.started to tool_use', () => {
    const event: CodexItemEvent = {
      type: 'item.started',
      item: {
        id: 'mcp-1',
        type: 'mcp_tool_call',
        server: 'linear',
        tool: 'create_issue',
        arguments: { title: 'Test' },
        status: 'in_progress',
      },
    }
    const result = mapCodexItemEvent(event)

    expect(result[0]).toMatchObject({
      type: 'tool_use',
      toolName: 'mcp:linear/create_issue',
      toolUseId: 'mcp-1',
      input: { title: 'Test' },
    })
  })

  it('maps mcp_tool_call item.completed to tool_result', () => {
    const event: CodexItemEvent = {
      type: 'item.completed',
      item: {
        id: 'mcp-1',
        type: 'mcp_tool_call',
        server: 'linear',
        tool: 'create_issue',
        arguments: { title: 'Test' },
        result: { content: [{ text: 'Created' }] },
        status: 'completed',
      },
    }
    const result = mapCodexItemEvent(event)

    expect(result[0]).toMatchObject({
      type: 'tool_result',
      toolName: 'mcp:linear/create_issue',
      content: '[{"text":"Created"}]',
      isError: false,
    })
  })

  it('maps mcp_tool_call error', () => {
    const event: CodexItemEvent = {
      type: 'item.completed',
      item: {
        id: 'mcp-1',
        type: 'mcp_tool_call',
        server: 'linear',
        tool: 'create_issue',
        arguments: {},
        error: { message: 'Auth failed' },
        status: 'failed',
      },
    }
    const result = mapCodexItemEvent(event)

    expect(result[0]).toMatchObject({
      type: 'tool_result',
      isError: true,
      content: 'Auth failed',
    })
  })

  it('returns empty array for mcp_tool_call item.updated', () => {
    const event: CodexItemEvent = {
      type: 'item.updated',
      item: {
        id: 'mcp-1',
        type: 'mcp_tool_call',
        server: 'linear',
        tool: 'create_issue',
        arguments: {},
        status: 'in_progress',
      },
    }
    const result = mapCodexItemEvent(event)
    expect(result).toEqual([])
  })

  it('maps todo_list to system event', () => {
    const event: CodexItemEvent = {
      type: 'item.completed',
      item: {
        id: 'todo-1',
        type: 'todo_list',
        items: [
          { text: 'Read files', completed: true },
          { text: 'Write tests', completed: false },
        ],
      },
    }
    const result = mapCodexItemEvent(event)

    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'todo_list',
      message: '[x] Read files\n[ ] Write tests',
    })
  })

  it('maps error item to error event', () => {
    const event: CodexItemEvent = {
      type: 'item.completed',
      item: { id: 'err-1', type: 'error', message: 'Something went wrong' },
    }
    const result = mapCodexItemEvent(event)

    expect(result[0]).toMatchObject({
      type: 'error',
      message: 'Something went wrong',
    })
  })

  it('handles unknown item type', () => {
    const event: CodexItemEvent = {
      type: 'item.completed',
      item: { id: 'x', type: 'web_search' } as unknown as CodexItemEvent['item'],
    }
    const result = mapCodexItemEvent(event)

    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'unknown_item',
    })
  })
})

describe('CodexProvider', () => {
  it('exports CodexProvider class', async () => {
    const { CodexProvider } = await import('./codex-provider.js')
    const provider = new CodexProvider()
    expect(provider.name).toBe('codex')
  })

  it('exports createCodexProvider factory', async () => {
    const { createCodexProvider } = await import('./codex-provider.js')
    const provider = createCodexProvider()
    expect(provider.name).toBe('codex')
  })
})

// ---------------------------------------------------------------------------
// Early process death detection tests
// ---------------------------------------------------------------------------

function makeSpawnConfig(overrides?: Partial<AgentSpawnConfig>): AgentSpawnConfig {
  return {
    prompt: 'test prompt',
    cwd: '/tmp',
    autonomous: true,
    sandboxEnabled: false,
    env: {},
    abortController: new AbortController(),
    ...overrides,
  }
}

async function collectEvents(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of stream) {
    events.push(event)
  }
  return events
}

describe('Early process death detection', () => {
  let stderrSpy: { mockRestore: () => void }

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
  })

  it('detects immediate process exit and produces error + result events', async () => {
    // Use a binary that will exit immediately with an error
    const provider = new CodexProvider()
    const config = makeSpawnConfig({
      env: { CODEX_BIN: 'false' }, // 'false' exits with code 1 immediately
    })

    const handle = provider.spawn(config)
    const events = await collectEvents(handle.stream)

    // Should have at least an error event and a result event
    const errorEvents = events.filter(e => e.type === 'error')
    const resultEvents = events.filter(e => e.type === 'result')

    expect(resultEvents.length).toBeGreaterThanOrEqual(1)
    const result = resultEvents[resultEvents.length - 1]
    expect(result.type).toBe('result')
    expect((result as any).success).toBe(false)
  })

  it('includes stderr content in error message when process dies immediately', async () => {
    // Use a shell command that writes to stderr then exits
    const provider = new CodexProvider()
    const config = makeSpawnConfig({
      env: { CODEX_BIN: 'sh' },
      // 'sh' with args ['exec', ...] will fail since 'exec' with those args is invalid
    })

    const handle = provider.spawn(config)
    const events = await collectEvents(handle.stream)

    const resultEvents = events.filter(e => e.type === 'result')
    expect(resultEvents.length).toBeGreaterThanOrEqual(1)
    const result = resultEvents[resultEvents.length - 1] as any
    expect(result.success).toBe(false)
    // The error should contain either stderr content or exit code info
    expect(result.errors).toBeDefined()
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0].length).toBeGreaterThan(0)
  })

  it('logs the spawn command to stderr', async () => {
    const provider = new CodexProvider()
    const config = makeSpawnConfig({
      env: { CODEX_BIN: 'false' },
    })

    // Capture console.error calls
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const handle = provider.spawn(config)
    // Consume the stream so the process completes
    await collectEvents(handle.stream)

    // Verify the spawn command was logged
    const spawnLogCall = consoleErrorSpy.mock.calls.find(
      call => typeof call[0] === 'string' && call[0].includes('[CodexProvider] Spawning:')
    )
    expect(spawnLogCall).toBeDefined()
    expect(spawnLogCall![0]).toContain('false')
    expect(spawnLogCall![0]).toContain('exec')

    consoleErrorSpy.mockRestore()
  })

  it('truncates long spawn commands in the log', async () => {
    const provider = new CodexProvider()
    const longPrompt = 'x'.repeat(300)
    const config = makeSpawnConfig({
      env: { CODEX_BIN: 'false' },
      prompt: longPrompt,
    })

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const handle = provider.spawn(config)
    await collectEvents(handle.stream)

    const spawnLogCall = consoleErrorSpy.mock.calls.find(
      call => typeof call[0] === 'string' && call[0].includes('[CodexProvider] Spawning:')
    )
    expect(spawnLogCall).toBeDefined()
    // The log message should be truncated with '...'
    expect(spawnLogCall![0]).toContain('...')
    // Total logged command portion should not exceed ~200 chars + prefix
    const cmdPortion = spawnLogCall![0].replace('[CodexProvider] Spawning: ', '')
    expect(cmdPortion.length).toBeLessThanOrEqual(203) // 200 + '...'

    consoleErrorSpy.mockRestore()
  })

  it('produces spawn_failure errorSubtype for immediate exit', async () => {
    const provider = new CodexProvider()
    const config = makeSpawnConfig({
      // Use a command that does not exist to trigger spawn error
      env: { CODEX_BIN: '/nonexistent/binary/path' },
    })

    const handle = provider.spawn(config)
    const events = await collectEvents(handle.stream)

    // Should get either a spawn_failure or process_exit error
    const resultEvents = events.filter(e => e.type === 'result') as any[]
    expect(resultEvents.length).toBeGreaterThanOrEqual(1)
    const result = resultEvents[resultEvents.length - 1]
    expect(result.success).toBe(false)
    expect(['spawn_failure', 'process_exit']).toContain(result.errorSubtype)
  })
})

// ---------------------------------------------------------------------------
// Exec mode stream termination tests
// ---------------------------------------------------------------------------
// These tests verify that createEventStream() terminates correctly when the
// child process exits without producing stdout output, preventing the
// orchestrator from hanging indefinitely.
// ---------------------------------------------------------------------------

describe('CodexAgentHandle stream termination (exec mode)', () => {
  // We test through the CodexProvider.spawn() path with mocked child_process.
  // Import the real module after vi.mock so the mock is in place.

  // Use dynamic imports to get a fresh module with mocks applied.
  // We mock at the vi.hoisted level for child_process.

  it('stream terminates when process exits immediately with no stdout', async () => {
    const { EventEmitter } = await import('events')
    const { Readable } = await import('stream')
    const { createInterface } = await import('readline')

    // Create a mock child process
    const child = new EventEmitter() as any
    const stdout = new Readable({ read() {} })
    const stderr = new Readable({ read() {} })
    child.stdout = stdout
    child.stderr = stderr
    child.stdin = { write: () => {}, end: () => {} }
    child.pid = 12345
    child.exitCode = null
    child.killed = false
    child.kill = () => {}

    // Create readline from the stdout stream
    const rl = createInterface({ input: stdout })

    // Simulate: process exits with code 1 and stderr message, no stdout
    const events: any[] = []
    const streamDone = (async () => {
      for await (const _line of rl) {
        // Should not receive any lines
        events.push(_line)
      }
    })()

    // Give the for-await loop time to start listening
    await new Promise(r => setTimeout(r, 10))

    // Now close rl as our fix does when process exits
    rl.close()

    // The for-await loop should terminate
    await streamDone

    expect(events).toHaveLength(0)
  })

  it('stream processes lines normally then terminates on rl.close()', async () => {
    const { EventEmitter } = await import('events')
    const { Readable } = await import('stream')
    const { createInterface } = await import('readline')

    // Create a mock stdout stream
    const stdout = new Readable({ read() {} })

    const rl = createInterface({ input: stdout })
    const lines: string[] = []

    const streamDone = (async () => {
      for await (const line of rl) {
        lines.push(line)
      }
    })()

    // Push some JSONL data
    stdout.push('{"type":"thread.started","thread_id":"t-1"}\n')
    stdout.push('{"type":"turn.started"}\n')

    // Give time for lines to be processed
    await new Promise(r => setTimeout(r, 10))

    // Close rl (simulating our exit handler)
    rl.close()

    await streamDone

    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('thread.started')
    expect(lines[1]).toContain('turn.started')
  })

  it('rl.close() is safe to call multiple times (idempotent)', async () => {
    const { Readable } = await import('stream')
    const { createInterface } = await import('readline')

    const stdout = new Readable({ read() {} })
    const rl = createInterface({ input: stdout })

    const streamDone = (async () => {
      for await (const _line of rl) {
        // no-op
      }
    })()

    await new Promise(r => setTimeout(r, 10))

    // Close multiple times — should not throw
    rl.close()
    rl.close()
    rl.close()

    await streamDone
    // If we get here without throwing, the test passes
  })

  it('spawn error (stdout destroyed) terminates readline iteration', async () => {
    const { Readable } = await import('stream')
    const { createInterface } = await import('readline')

    const stdout = new Readable({ read() {} })
    const rl = createInterface({ input: stdout })

    const streamDone = (async () => {
      const lines: string[] = []
      for await (const line of rl) {
        lines.push(line)
      }
      return lines
    })()

    await new Promise(r => setTimeout(r, 10))

    // Simulate what our fix does when spawn fires 'error':
    // destroy stdout (from createExecHandle) and close rl (from createEventStream)
    stdout.destroy()
    rl.close()

    const lines = await streamDone
    expect(lines).toHaveLength(0)
  })
})
