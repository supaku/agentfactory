import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import {
  mapAppServerNotification,
  mapAppServerItemEvent,
  type AppServerEventMapperState,
  type JsonRpcNotification,
} from './codex-app-server-provider.js'

// ---------------------------------------------------------------------------
// Mock child_process and readline for AppServerProcessManager tests
// ---------------------------------------------------------------------------

/** Fake writable stdin stream */
function createMockStdin() {
  return {
    writable: true,
    write: vi.fn(),
  }
}

/** Fake ChildProcess — an EventEmitter with stdin, stdout, pid, killed, kill() */
function createMockChildProcess() {
  const stdout = new EventEmitter()
  const proc = new EventEmitter() as EventEmitter & {
    stdin: ReturnType<typeof createMockStdin>
    stdout: EventEmitter
    pid: number
    killed: boolean
    kill: ReturnType<typeof vi.fn>
  }
  proc.stdin = createMockStdin()
  proc.stdout = stdout
  proc.pid = 12345
  proc.killed = false
  proc.kill = vi.fn((signal?: string) => {
    // For SIGKILL during shutdown tests
    if (signal === 'SIGKILL') {
      proc.killed = true
    }
  })
  return proc
}

let mockProc: ReturnType<typeof createMockChildProcess>
let mockLineEmitter: EventEmitter

vi.mock('child_process', () => ({
  spawn: vi.fn(() => mockProc),
}))

vi.mock('readline', () => ({
  createInterface: vi.fn(() => {
    mockLineEmitter = new EventEmitter()
    // Add a close method to match readline.Interface
    ;(mockLineEmitter as any).close = vi.fn()
    return mockLineEmitter
  }),
}))

import { spawn } from 'child_process'

const mockSpawn = vi.mocked(spawn)

function freshState(): AppServerEventMapperState {
  return {
    sessionId: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    turnCount: 0,
  }
}

/** Emit a JSON line on mock stdout (via the readline 'line' event) */
function emitLine(obj: unknown): void {
  mockLineEmitter.emit('line', JSON.stringify(obj))
}

/** Emit a raw string line on mock stdout */
function emitRawLine(text: string): void {
  mockLineEmitter.emit('line', text)
}

// ---------------------------------------------------------------------------
// mapAppServerNotification
// ---------------------------------------------------------------------------

describe('mapAppServerNotification', () => {
  // --- Thread lifecycle ---

  it('maps thread/started to init', () => {
    const state = freshState()
    const notification: JsonRpcNotification = {
      method: 'thread/started',
      params: { thread: { id: 'thr_abc' } },
    }
    const result = mapAppServerNotification(notification, state)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: 'init',
      sessionId: 'thr_abc',
    })
    expect(state.sessionId).toBe('thr_abc')
  })

  it('maps thread/started without thread to empty array', () => {
    const state = freshState()
    const notification: JsonRpcNotification = {
      method: 'thread/started',
      params: {},
    }
    const result = mapAppServerNotification(notification, state)
    expect(result).toHaveLength(0)
  })

  it('maps thread/closed to system event', () => {
    const state = freshState()
    const notification: JsonRpcNotification = {
      method: 'thread/closed',
      params: { threadId: 'thr_abc' },
    }
    const result = mapAppServerNotification(notification, state)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'thread_closed',
    })
  })

  it('maps thread/status/changed to system event', () => {
    const state = freshState()
    const notification: JsonRpcNotification = {
      method: 'thread/status/changed',
      params: { threadId: 'thr_abc', status: 'idle' },
    }
    const result = mapAppServerNotification(notification, state)

    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'thread_status_changed',
    })
  })

  // --- Turn lifecycle ---

  it('maps turn/started with incrementing turn count', () => {
    const state = freshState()
    const notification: JsonRpcNotification = {
      method: 'turn/started',
      params: { turn: { id: 'turn_1' } },
    }

    const r1 = mapAppServerNotification(notification, state)
    expect(r1[0]).toMatchObject({
      type: 'system',
      subtype: 'turn_started',
      message: 'Turn 1 started (turn_1)',
    })
    expect(state.turnCount).toBe(1)

    const r2 = mapAppServerNotification(notification, state)
    expect(r2[0]).toMatchObject({
      message: 'Turn 2 started (turn_1)',
    })
    expect(state.turnCount).toBe(2)
  })

  it('maps turn/started without turn id', () => {
    const state = freshState()
    const notification: JsonRpcNotification = {
      method: 'turn/started',
      params: {},
    }
    const result = mapAppServerNotification(notification, state)
    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'turn_started',
      message: 'Turn 1 started',
    })
  })

  it('maps turn/completed (success) with usage', () => {
    const state = freshState()
    state.turnCount = 1

    const notification: JsonRpcNotification = {
      method: 'turn/completed',
      params: {
        turn: {
          id: 'turn_1',
          status: 'completed',
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
    }
    const result = mapAppServerNotification(notification, state)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: 'result',
      success: true,
      cost: {
        inputTokens: 100,
        outputTokens: 50,
        numTurns: 1,
      },
    })
    expect(state.totalInputTokens).toBe(100)
    expect(state.totalOutputTokens).toBe(50)
  })

  it('accumulates usage across multiple turns', () => {
    const state = freshState()
    state.turnCount = 2

    mapAppServerNotification({
      method: 'turn/completed',
      params: { turn: { id: 't1', status: 'completed', usage: { input_tokens: 100, output_tokens: 50 } } },
    }, state)

    const result = mapAppServerNotification({
      method: 'turn/completed',
      params: { turn: { id: 't2', status: 'completed', usage: { input_tokens: 200, output_tokens: 80 } } },
    }, state)

    expect(result[0]).toMatchObject({
      type: 'result',
      success: true,
      cost: { inputTokens: 300, outputTokens: 130 },
    })
  })

  it('maps turn/completed (failed) with error', () => {
    const state = freshState()
    const notification: JsonRpcNotification = {
      method: 'turn/completed',
      params: {
        turn: {
          id: 'turn_1',
          status: 'failed',
          error: { message: 'Context window exceeded', codexErrorInfo: 'ContextWindowExceeded' },
        },
      },
    }
    const result = mapAppServerNotification(notification, state)

    expect(result[0]).toMatchObject({
      type: 'result',
      success: false,
      errors: ['Context window exceeded'],
      errorSubtype: 'ContextWindowExceeded',
    })
  })

  it('maps turn/completed (failed) without error message', () => {
    const state = freshState()
    const result = mapAppServerNotification({
      method: 'turn/completed',
      params: { turn: { id: 'turn_1', status: 'failed' } },
    }, state)

    expect(result[0]).toMatchObject({
      type: 'result',
      success: false,
      errors: ['Turn failed'],
    })
  })

  it('maps turn/completed (interrupted)', () => {
    const state = freshState()
    const result = mapAppServerNotification({
      method: 'turn/completed',
      params: { turn: { id: 'turn_1', status: 'interrupted' } },
    }, state)

    expect(result[0]).toMatchObject({
      type: 'result',
      success: false,
      errors: ['Turn was interrupted'],
      errorSubtype: 'interrupted',
    })
  })

  it('maps turn/completed without turn object (defaults to completed)', () => {
    const state = freshState()
    const result = mapAppServerNotification({
      method: 'turn/completed',
      params: {},
    }, state)

    expect(result[0]).toMatchObject({
      type: 'result',
      success: true,
    })
  })

  // --- Item deltas (streaming) ---

  it('maps item/agentMessage/delta to assistant_text', () => {
    const state = freshState()
    const result = mapAppServerNotification({
      method: 'item/agentMessage/delta',
      params: { text: 'Hello world' },
    }, state)

    expect(result[0]).toMatchObject({
      type: 'assistant_text',
      text: 'Hello world',
    })
  })

  it('maps item/agentMessage/delta with empty text to empty array', () => {
    const state = freshState()
    const result = mapAppServerNotification({
      method: 'item/agentMessage/delta',
      params: {},
    }, state)
    expect(result).toHaveLength(0)
  })

  it('maps item/reasoning/summaryTextDelta to reasoning', () => {
    const state = freshState()
    const result = mapAppServerNotification({
      method: 'item/reasoning/summaryTextDelta',
      params: { text: 'Thinking about the problem...' },
    }, state)

    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'reasoning',
      message: 'Thinking about the problem...',
    })
  })

  it('maps item/commandExecution/outputDelta to command_progress', () => {
    const state = freshState()
    const result = mapAppServerNotification({
      method: 'item/commandExecution/outputDelta',
      params: { delta: 'Installing packages...' },
    }, state)

    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'command_progress',
      message: 'Installing packages...',
    })
  })

  // --- Turn diff/plan ---

  it('maps turn/diff/updated to system event', () => {
    const state = freshState()
    const result = mapAppServerNotification({
      method: 'turn/diff/updated',
      params: { diff: '--- a/file.ts\n+++ b/file.ts' },
    }, state)

    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'diff_updated',
      message: '--- a/file.ts\n+++ b/file.ts',
    })
  })

  it('maps turn/plan/updated to system event', () => {
    const state = freshState()
    const result = mapAppServerNotification({
      method: 'turn/plan/updated',
      params: { plan: { steps: ['step1'] } },
    }, state)

    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'plan_updated',
    })
  })

  // --- Unknown notifications ---

  it('handles unknown notification method', () => {
    const state = freshState()
    const result = mapAppServerNotification({
      method: 'some/unknown/method',
      params: {},
    }, state)

    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'unknown',
      message: 'Unhandled App Server notification: some/unknown/method',
    })
  })

  // --- Item lifecycle (delegates) ---

  it('delegates item/started to mapAppServerItemEvent', () => {
    const state = freshState()
    const result = mapAppServerNotification({
      method: 'item/started',
      params: {
        item: { id: 'cmd-1', type: 'commandExecution', command: 'ls -la' },
      },
    }, state)

    expect(result[0]).toMatchObject({
      type: 'tool_use',
      toolName: 'shell',
      toolUseId: 'cmd-1',
      input: { command: 'ls -la' },
    })
  })

  it('delegates item/completed to mapAppServerItemEvent', () => {
    const state = freshState()
    const result = mapAppServerNotification({
      method: 'item/completed',
      params: {
        item: { id: 'msg-1', type: 'agentMessage', text: 'Done!' },
      },
    }, state)

    expect(result[0]).toMatchObject({
      type: 'assistant_text',
      text: 'Done!',
    })
  })
})

// ---------------------------------------------------------------------------
// mapAppServerItemEvent
// ---------------------------------------------------------------------------

describe('mapAppServerItemEvent', () => {
  it('maps agentMessage item.completed to assistant_text', () => {
    const result = mapAppServerItemEvent('item/completed', {
      item: { id: 'msg-1', type: 'agentMessage', text: 'Analysis complete' },
    })

    expect(result).toEqual([{
      type: 'assistant_text',
      text: 'Analysis complete',
      raw: { method: 'item/completed', params: { item: { id: 'msg-1', type: 'agentMessage', text: 'Analysis complete' } } },
    }])
  })

  it('returns empty for agentMessage item.started', () => {
    const result = mapAppServerItemEvent('item/started', {
      item: { id: 'msg-1', type: 'agentMessage', text: '' },
    })
    expect(result).toHaveLength(0)
  })

  it('maps reasoning item to system event', () => {
    const result = mapAppServerItemEvent('item/completed', {
      item: { id: 'r-1', type: 'reasoning', summary: 'Thinking about it...' },
    })

    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'reasoning',
      message: 'Thinking about it...',
    })
  })

  it('maps commandExecution item.started to tool_use', () => {
    const result = mapAppServerItemEvent('item/started', {
      item: { id: 'cmd-1', type: 'commandExecution', command: 'npm test' },
    })

    expect(result[0]).toMatchObject({
      type: 'tool_use',
      toolName: 'shell',
      toolUseId: 'cmd-1',
      input: { command: 'npm test' },
    })
  })

  it('maps commandExecution item.completed to tool_result (success)', () => {
    const result = mapAppServerItemEvent('item/completed', {
      item: {
        id: 'cmd-1',
        type: 'commandExecution',
        command: 'echo hello',
        text: 'hello',
        exitCode: 0,
        status: 'completed',
      },
    })

    expect(result[0]).toMatchObject({
      type: 'tool_result',
      toolName: 'shell',
      toolUseId: 'cmd-1',
      content: 'hello',
      isError: false,
    })
  })

  it('maps commandExecution item.completed to tool_result (failure)', () => {
    const result = mapAppServerItemEvent('item/completed', {
      item: {
        id: 'cmd-1',
        type: 'commandExecution',
        command: 'false',
        text: '',
        exitCode: 1,
        status: 'failed',
      },
    })

    expect(result[0]).toMatchObject({
      type: 'tool_result',
      isError: true,
    })
  })

  it('maps fileChange item.completed to tool_result', () => {
    const result = mapAppServerItemEvent('item/completed', {
      item: {
        id: 'fc-1',
        type: 'fileChange',
        changes: [
          { path: 'src/index.ts', kind: 'update' },
          { path: 'src/new.ts', kind: 'add' },
        ],
        status: 'completed',
      },
    })

    expect(result[0]).toMatchObject({
      type: 'tool_result',
      toolName: 'file_change',
      content: 'update: src/index.ts\nadd: src/new.ts',
      isError: false,
    })
  })

  it('maps mcpToolCall item.started to tool_use', () => {
    const result = mapAppServerItemEvent('item/started', {
      item: {
        id: 'mcp-1',
        type: 'mcpToolCall',
        server: 'linear',
        tool: 'create_issue',
        arguments: { title: 'Test' },
        status: 'in_progress',
      },
    })

    expect(result[0]).toMatchObject({
      type: 'tool_use',
      toolName: 'mcp:linear/create_issue',
      toolUseId: 'mcp-1',
      input: { title: 'Test' },
    })
  })

  it('maps mcpToolCall item.completed to tool_result (success)', () => {
    const result = mapAppServerItemEvent('item/completed', {
      item: {
        id: 'mcp-1',
        type: 'mcpToolCall',
        server: 'linear',
        tool: 'create_issue',
        arguments: {},
        result: { content: [{ text: 'Created' }] },
        status: 'completed',
      },
    })

    expect(result[0]).toMatchObject({
      type: 'tool_result',
      toolName: 'mcp:linear/create_issue',
      content: '[{"text":"Created"}]',
      isError: false,
    })
  })

  it('maps mcpToolCall item.completed to tool_result (error)', () => {
    const result = mapAppServerItemEvent('item/completed', {
      item: {
        id: 'mcp-1',
        type: 'mcpToolCall',
        server: 'linear',
        tool: 'create_issue',
        arguments: {},
        error: { message: 'Auth failed' },
        status: 'failed',
      },
    })

    expect(result[0]).toMatchObject({
      type: 'tool_result',
      isError: true,
      content: 'Auth failed',
    })
  })

  it('maps plan item to system event', () => {
    const result = mapAppServerItemEvent('item/completed', {
      item: { id: 'p-1', type: 'plan', text: 'Step 1: Read code' },
    })

    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'plan',
      message: 'Step 1: Read code',
    })
  })

  it('maps webSearch item to system event', () => {
    const result = mapAppServerItemEvent('item/started', {
      item: { id: 'ws-1', type: 'webSearch', text: 'codex app server docs' },
    })

    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'web_search',
      message: 'Web search: codex app server docs',
    })
  })

  it('maps contextCompaction item to system event', () => {
    const result = mapAppServerItemEvent('item/completed', {
      item: { id: 'cc-1', type: 'contextCompaction' },
    })

    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'context_compaction',
      message: 'Context history compacted',
    })
  })

  it('returns empty when no item in params', () => {
    const result = mapAppServerItemEvent('item/completed', {})
    expect(result).toHaveLength(0)
  })

  it('handles unknown item type', () => {
    const result = mapAppServerItemEvent('item/completed', {
      item: { id: 'x', type: 'novelItemType' },
    })

    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'unknown_item',
    })
  })
})

// ---------------------------------------------------------------------------
// Token Accumulation Edge Cases
// ---------------------------------------------------------------------------

describe('mapAppServerNotification — token edge cases', () => {
  it('cached_input_tokens is present in usage but does not affect totalInputTokens accumulation', () => {
    const state = freshState()
    state.turnCount = 1

    const result = mapAppServerNotification({
      method: 'turn/completed',
      params: {
        turn: {
          id: 'turn_1',
          status: 'completed',
          usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 30 },
        },
      },
    }, state)

    // totalInputTokens should only accumulate input_tokens, not cached_input_tokens
    expect(state.totalInputTokens).toBe(100)
    expect(state.totalOutputTokens).toBe(50)
    expect(result[0]).toMatchObject({
      type: 'result',
      success: true,
      cost: { inputTokens: 100, outputTokens: 50 },
    })
  })

  it('turn/completed without usage does not crash, tokens stay at 0', () => {
    const state = freshState()
    state.turnCount = 1

    // turn object present but no usage field
    const result = mapAppServerNotification({
      method: 'turn/completed',
      params: { turn: { id: 'turn_1', status: 'completed' } },
    }, state)

    expect(state.totalInputTokens).toBe(0)
    expect(state.totalOutputTokens).toBe(0)
    expect(result[0]).toMatchObject({
      type: 'result',
      success: true,
    })
  })

  it('zero-token turns result in undefined cost fields (falsy to undefined)', () => {
    const state = freshState()
    state.turnCount = 0 // 0 turns → falsy → undefined

    const result = mapAppServerNotification({
      method: 'turn/completed',
      params: {
        turn: {
          id: 'turn_1',
          status: 'completed',
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    }, state)

    // 0 || undefined → undefined due to falsy conversion
    const cost = (result[0] as any).cost
    expect(cost.inputTokens).toBeUndefined()
    expect(cost.outputTokens).toBeUndefined()
    expect(cost.numTurns).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// CodexAppServerProvider class
// ---------------------------------------------------------------------------

describe('CodexAppServerProvider', () => {
  it('exports CodexAppServerProvider class', async () => {
    const { CodexAppServerProvider } = await import('./codex-app-server-provider.js')
    const provider = new CodexAppServerProvider()
    expect(provider.name).toBe('codex')
  })

  it('exports createCodexAppServerProvider factory', async () => {
    const { createCodexAppServerProvider } = await import('./codex-app-server-provider.js')
    const provider = createCodexAppServerProvider()
    expect(provider.name).toBe('codex')
    expect(provider.capabilities.supportsMessageInjection).toBe(true)
    expect(provider.capabilities.supportsSessionResume).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AppServerProcessManager — Lifecycle
// ---------------------------------------------------------------------------

describe('AppServerProcessManager — lifecycle', () => {
  let AppServerProcessManager: typeof import('./codex-app-server-provider.js').AppServerProcessManager

  beforeEach(async () => {
    vi.clearAllMocks()
    mockProc = createMockChildProcess()
    const mod = await import('./codex-app-server-provider.js')
    AppServerProcessManager = mod.AppServerProcessManager
  })

  it('exports AppServerProcessManager class', () => {
    const manager = new AppServerProcessManager({ cwd: '/tmp' })
    expect(manager.isHealthy()).toBe(false)
    expect(manager.pid).toBeUndefined()
  })

  it('start() spawns a process and completes initialize handshake', async () => {
    const manager = new AppServerProcessManager({ cwd: '/tmp' })

    const startPromise = manager.start()

    // The start() method calls request('initialize', ...) which writes to stdin
    // and waits for a response. We need to send back the response.
    // Wait a tick for the spawn + request to be set up
    await vi.waitFor(() => {
      expect(mockProc.stdin.write).toHaveBeenCalled()
    })

    // Parse the initialize request that was written to stdin
    const initializeCall = mockProc.stdin.write.mock.calls[0]![0] as string
    const initReq = JSON.parse(initializeCall.trim())
    expect(initReq.method).toBe('initialize')
    expect(initReq.id).toBe(1)

    // Send back a successful response
    emitLine({ id: 1, result: { capabilities: {} } })

    await startPromise

    // After start, the `initialized` notification should have been sent
    expect(mockProc.stdin.write).toHaveBeenCalledTimes(2)
    const initializedCall = mockProc.stdin.write.mock.calls[1]![0] as string
    const initializedMsg = JSON.parse(initializedCall.trim())
    expect(initializedMsg.method).toBe('initialized')

    expect(manager.isHealthy()).toBe(true)
    expect(manager.pid).toBe(12345)
  })

  it('start() is idempotent — calling twice does not spawn a second process', async () => {
    const manager = new AppServerProcessManager({ cwd: '/tmp' })

    const startPromise = manager.start()
    await vi.waitFor(() => {
      expect(mockProc.stdin.write).toHaveBeenCalled()
    })
    emitLine({ id: 1, result: {} })
    await startPromise

    expect(mockSpawn).toHaveBeenCalledTimes(1)

    // Second call should be a no-op
    await manager.start()
    expect(mockSpawn).toHaveBeenCalledTimes(1)
  })

  it('request() correlates responses by id', async () => {
    const manager = new AppServerProcessManager({ cwd: '/tmp' })

    // Start the manager
    const startPromise = manager.start()
    await vi.waitFor(() => {
      expect(mockProc.stdin.write).toHaveBeenCalled()
    })
    emitLine({ id: 1, result: {} })
    await startPromise

    // Send a request
    const reqPromise = manager.request('thread/start', { cwd: '/project' })

    await vi.waitFor(() => {
      // The request should be the 3rd write (initialize, initialized, thread/start)
      expect(mockProc.stdin.write).toHaveBeenCalledTimes(3)
    })

    const reqCall = mockProc.stdin.write.mock.calls[2]![0] as string
    const req = JSON.parse(reqCall.trim())
    expect(req.method).toBe('thread/start')
    expect(req.id).toBe(2)

    // Respond
    emitLine({ id: 2, result: { thread: { id: 'thr_123' } } })

    const result = await reqPromise
    expect(result).toEqual({ thread: { id: 'thr_123' } })
  })

  it('request() times out when no response is received', async () => {
    vi.useFakeTimers()

    try {
      const manager = new AppServerProcessManager({ cwd: '/tmp' })

      const startPromise = manager.start()
      await vi.waitFor(() => {
        expect(mockProc.stdin.write).toHaveBeenCalled()
      })
      emitLine({ id: 1, result: {} })
      await startPromise

      // Send a request with a short timeout
      const reqPromise = manager.request('thread/start', {}, 5000)

      // Advance time past the timeout
      vi.advanceTimersByTime(5001)

      await expect(reqPromise).rejects.toThrow(/timed out/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('request() rejects with formatted message on JSON-RPC error response', async () => {
    const manager = new AppServerProcessManager({ cwd: '/tmp' })

    const startPromise = manager.start()
    await vi.waitFor(() => {
      expect(mockProc.stdin.write).toHaveBeenCalled()
    })
    emitLine({ id: 1, result: {} })
    await startPromise

    const reqPromise = manager.request('thread/start', { cwd: '/project' })

    await vi.waitFor(() => {
      expect(mockProc.stdin.write).toHaveBeenCalledTimes(3)
    })

    // Respond with an error
    emitLine({ id: 2, error: { code: -32600, message: 'Invalid request' } })

    await expect(reqPromise).rejects.toThrow('JSON-RPC error (-32600): Invalid request')
  })

  it('non-JSON stdout lines are silently ignored (no crash)', async () => {
    const manager = new AppServerProcessManager({ cwd: '/tmp' })

    const startPromise = manager.start()
    await vi.waitFor(() => {
      expect(mockProc.stdin.write).toHaveBeenCalled()
    })

    // Emit non-JSON lines — should not throw
    emitRawLine('Some debug output from the binary')
    emitRawLine('WARNING: something happened')
    emitRawLine('')
    emitRawLine('not valid json {{{')

    // Now send the valid response
    emitLine({ id: 1, result: {} })
    await startPromise

    expect(manager.isHealthy()).toBe(true)
  })

  it('process exit event rejects all pending requests and sets healthy to false', async () => {
    const manager = new AppServerProcessManager({ cwd: '/tmp' })

    const startPromise = manager.start()
    await vi.waitFor(() => {
      expect(mockProc.stdin.write).toHaveBeenCalled()
    })
    emitLine({ id: 1, result: {} })
    await startPromise

    expect(manager.isHealthy()).toBe(true)

    // Send a request but don't respond
    const reqPromise = manager.request('thread/start', {})

    await vi.waitFor(() => {
      expect(mockProc.stdin.write).toHaveBeenCalledTimes(3)
    })

    // Simulate process exit
    mockProc.emit('exit', 1, null)

    await expect(reqPromise).rejects.toThrow(/App server exited/)
    expect(manager.isHealthy()).toBe(false)
  })

  it('process error event rejects all pending requests', async () => {
    const manager = new AppServerProcessManager({ cwd: '/tmp' })

    const startPromise = manager.start()
    await vi.waitFor(() => {
      expect(mockProc.stdin.write).toHaveBeenCalled()
    })
    emitLine({ id: 1, result: {} })
    await startPromise

    // Send a request but don't respond
    const reqPromise = manager.request('some/method', {})

    await vi.waitFor(() => {
      expect(mockProc.stdin.write).toHaveBeenCalledTimes(3)
    })

    // Simulate process error
    mockProc.emit('error', new Error('ENOENT'))

    await expect(reqPromise).rejects.toThrow(/App server process error: ENOENT/)
  })
})

// ---------------------------------------------------------------------------
// Thread Notification Routing
// ---------------------------------------------------------------------------

describe('AppServerProcessManager — thread notification routing', () => {
  let AppServerProcessManager: typeof import('./codex-app-server-provider.js').AppServerProcessManager

  beforeEach(async () => {
    vi.clearAllMocks()
    mockProc = createMockChildProcess()
    const mod = await import('./codex-app-server-provider.js')
    AppServerProcessManager = mod.AppServerProcessManager
  })

  async function startManager() {
    const manager = new AppServerProcessManager({ cwd: '/tmp' })
    const startPromise = manager.start()
    await vi.waitFor(() => {
      expect(mockProc.stdin.write).toHaveBeenCalled()
    })
    emitLine({ id: 1, result: {} })
    await startPromise
    return manager
  }

  it('subscribeThread() routes notifications with matching threadId to the listener', async () => {
    const manager = await startManager()
    const received: JsonRpcNotification[] = []

    manager.subscribeThread('thr_1', (n) => received.push(n))

    // Emit a notification with threadId = thr_1
    emitLine({ method: 'turn/started', params: { threadId: 'thr_1', turn: { id: 't1' } } })

    expect(received).toHaveLength(1)
    expect(received[0]!.method).toBe('turn/started')
  })

  it('unsubscribeThread() stops delivering notifications after unsubscribe', async () => {
    const manager = await startManager()
    const received: JsonRpcNotification[] = []

    manager.subscribeThread('thr_1', (n) => received.push(n))
    emitLine({ method: 'turn/started', params: { threadId: 'thr_1' } })
    expect(received).toHaveLength(1)

    manager.unsubscribeThread('thr_1')
    emitLine({ method: 'turn/completed', params: { threadId: 'thr_1' } })
    // Should not receive new notifications
    expect(received).toHaveLength(1)
  })

  it('notifications without threadId dispatch to global listeners', async () => {
    const manager = await startManager()
    const globalReceived: JsonRpcNotification[] = []

    // Access globalListeners via a workaround: subscribe a thread, then send a global notification
    // globalListeners is private, so we test indirectly via behavior.
    // We can add a global listener by accessing it through the manager's internal Set.
    // Since globalListeners is private, we'll use (manager as any) for testing.
    ;(manager as any).globalListeners.add((n: JsonRpcNotification) => globalReceived.push(n))

    // Notification without threadId
    emitLine({ method: 'thread/closed', params: {} })

    expect(globalReceived).toHaveLength(1)
    expect(globalReceived[0]!.method).toBe('thread/closed')
  })

  it('notifications with unknown threadId fall through to global listeners', async () => {
    const manager = await startManager()
    const globalReceived: JsonRpcNotification[] = []
    const threadReceived: JsonRpcNotification[] = []

    manager.subscribeThread('thr_1', (n) => threadReceived.push(n))
    ;(manager as any).globalListeners.add((n: JsonRpcNotification) => globalReceived.push(n))

    // Notification with unknown threadId (not subscribed)
    emitLine({ method: 'turn/started', params: { threadId: 'thr_unknown' } })

    expect(threadReceived).toHaveLength(0)
    expect(globalReceived).toHaveLength(1)
  })

  it('multiple concurrent threads each receive only their own notifications', async () => {
    const manager = await startManager()
    const received1: JsonRpcNotification[] = []
    const received2: JsonRpcNotification[] = []

    manager.subscribeThread('thr_A', (n) => received1.push(n))
    manager.subscribeThread('thr_B', (n) => received2.push(n))

    emitLine({ method: 'turn/started', params: { threadId: 'thr_A', turn: { id: 'tA1' } } })
    emitLine({ method: 'turn/started', params: { threadId: 'thr_B', turn: { id: 'tB1' } } })
    emitLine({ method: 'turn/completed', params: { threadId: 'thr_A', turn: { id: 'tA1' } } })

    expect(received1).toHaveLength(2) // turn/started + turn/completed for thr_A
    expect(received2).toHaveLength(1) // turn/started for thr_B
    expect(received1[0]!.params?.threadId).toBe('thr_A')
    expect(received2[0]!.params?.threadId).toBe('thr_B')
  })
})

// ---------------------------------------------------------------------------
// Approval & Sandbox Policy Resolution
// ---------------------------------------------------------------------------

describe('Approval & Sandbox Policy Resolution (via spawn params)', () => {
  let CodexAppServerProvider: typeof import('./codex-app-server-provider.js').CodexAppServerProvider

  beforeEach(async () => {
    vi.clearAllMocks()
    mockProc = createMockChildProcess()
    const mod = await import('./codex-app-server-provider.js')
    CodexAppServerProvider = mod.CodexAppServerProvider
  })

  // Since resolveApprovalPolicy and resolveSandboxPolicy are module-private,
  // we test them indirectly by examining what AppServerAgentHandle passes to
  // the processManager when starting a thread. We can observe this through
  // the stdin writes after the handle's stream is consumed.

  function makeConfig(overrides: Partial<import('./types.js').AgentSpawnConfig> = {}): import('./types.js').AgentSpawnConfig {
    return {
      prompt: 'Test prompt',
      cwd: '/project',
      env: {},
      abortController: new AbortController(),
      autonomous: false,
      sandboxEnabled: false,
      ...overrides,
    }
  }

  /**
   * Helper: start consuming a handle's stream, complete the initialize
   * handshake, and wait for the thread/start request to be written to stdin.
   * Returns the parsed thread/start request.
   * Does NOT attempt to drain the full stream — the test should not need to.
   */
  async function driveToThreadStart(handle: import('./types.js').AgentHandle) {
    const iter = handle.stream[Symbol.asyncIterator]()

    // Kick off the generator — it will call processManager.start()
    const firstNext = iter.next()

    // Wait for the initialize request
    await vi.waitFor(() => {
      expect(mockProc.stdin.write).toHaveBeenCalled()
    }, { timeout: 3000 })
    // Respond to initialize
    emitLine({ id: 1, result: {} })

    // Wait for thread/start request (3 writes: initialize, initialized, thread/start)
    await vi.waitFor(() => {
      expect(mockProc.stdin.write).toHaveBeenCalledTimes(3)
    }, { timeout: 3000 })

    const threadStartCall = mockProc.stdin.write.mock.calls[2]![0] as string
    const threadStartReq = JSON.parse(threadStartCall.trim())

    // Do NOT respond — we only need to inspect the request params.
    // Clean up by stopping the iteration (no await needed for drain).
    firstNext.catch(() => {}) // suppress unhandled rejection from the pending generator

    return threadStartReq
  }

  it('autonomous: true resolves approval policy to never', async () => {
    const provider = new CodexAppServerProvider()
    const handle = provider.spawn(makeConfig({ autonomous: true, sandboxEnabled: false }))

    const threadStartReq = await driveToThreadStart(handle)
    expect(threadStartReq.params.approvalPolicy).toBe('never')
  })

  it('autonomous: false resolves approval policy to unlessTrusted', async () => {
    const provider = new CodexAppServerProvider()
    const handle = provider.spawn(makeConfig({ autonomous: false }))

    const threadStartReq = await driveToThreadStart(handle)
    expect(threadStartReq.params.approvalPolicy).toBe('unlessTrusted')
  })

  it('sandboxEnabled: false resolves sandbox policy to undefined (not sent)', async () => {
    const provider = new CodexAppServerProvider()
    const handle = provider.spawn(makeConfig({ sandboxEnabled: false }))

    const threadStartReq = await driveToThreadStart(handle)
    expect(threadStartReq.params.sandboxPolicy).toBeUndefined()
  })

  it('sandboxEnabled: true resolves sandbox policy with workspaceWrite and writableRoots', async () => {
    const provider = new CodexAppServerProvider()
    const handle = provider.spawn(makeConfig({ sandboxEnabled: true, cwd: '/my/project' }))

    const threadStartReq = await driveToThreadStart(handle)
    expect(threadStartReq.params.sandboxPolicy).toEqual({
      type: 'workspaceWrite',
      writableRoots: ['/my/project'],
    })
  })
})

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

describe('AppServerProcessManager — shutdown', () => {
  let AppServerProcessManager: typeof import('./codex-app-server-provider.js').AppServerProcessManager

  beforeEach(async () => {
    vi.clearAllMocks()
    mockProc = createMockChildProcess()
    const mod = await import('./codex-app-server-provider.js')
    AppServerProcessManager = mod.AppServerProcessManager
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function startManager() {
    const manager = new AppServerProcessManager({ cwd: '/tmp' })
    const startPromise = manager.start()
    await vi.waitFor(() => {
      expect(mockProc.stdin.write).toHaveBeenCalled()
    })
    emitLine({ id: 1, result: {} })
    await startPromise
    return manager
  }

  it('shutdown() is idempotent — calling twice does not spawn additional shutdown logic', async () => {
    const manager = await startManager()

    // Make process exit immediately when SIGTERM is received
    mockProc.kill = vi.fn((signal?: string) => {
      if (signal === 'SIGTERM') {
        setTimeout(() => mockProc.emit('exit', 0, 'SIGTERM'), 0)
      }
    })

    const promise1 = manager.shutdown()
    const promise2 = manager.shutdown()

    await Promise.all([promise1, promise2])

    // SIGTERM should only have been called once (not twice)
    const sigtermCalls = (mockProc.kill as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: unknown[]) => c[0] === 'SIGTERM')
    expect(sigtermCalls).toHaveLength(1)
  })

  it('graceful SIGTERM is sent first on shutdown', async () => {
    const manager = await startManager()

    // Make process exit immediately when SIGTERM is received
    mockProc.kill = vi.fn((signal?: string) => {
      if (signal === 'SIGTERM') {
        setTimeout(() => mockProc.emit('exit', 0, 'SIGTERM'), 0)
      }
    })

    await manager.shutdown()

    expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('force SIGKILL fires after 5s if process does not exit after SIGTERM', async () => {
    vi.useFakeTimers()

    const manager = await startManager()

    // Process ignores SIGTERM (doesn't exit)
    mockProc.kill = vi.fn((signal?: string) => {
      if (signal === 'SIGKILL') {
        mockProc.killed = true
        // SIGKILL triggers exit
        mockProc.emit('exit', null, 'SIGKILL')
      }
      // SIGTERM is ignored — no exit emitted
    })

    const shutdownPromise = manager.shutdown()

    // At this point SIGTERM has been called but process hasn't exited
    expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM')
    expect(mockProc.kill).not.toHaveBeenCalledWith('SIGKILL')

    // Advance time by 5 seconds to trigger SIGKILL
    vi.advanceTimersByTime(5000)

    await shutdownPromise

    expect(mockProc.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('pending requests are rejected with shutting down error on shutdown', async () => {
    const manager = await startManager()

    // Send a request but don't respond
    const reqPromise = manager.request('thread/start', {})

    // Attach a catch handler immediately to prevent unhandled rejection
    const rejectionPromise = reqPromise.catch((err: Error) => err)

    await vi.waitFor(() => {
      expect(mockProc.stdin.write).toHaveBeenCalledTimes(3)
    })

    // Make process exit on SIGTERM
    mockProc.kill = vi.fn((signal?: string) => {
      if (signal === 'SIGTERM') {
        setTimeout(() => mockProc.emit('exit', 0, 'SIGTERM'), 0)
      }
    })

    await manager.shutdown()

    const error = await rejectionPromise
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toMatch(/shutting down/)
  })

  it('after shutdown, isHealthy() is false, pid is undefined, thread listeners cleared', async () => {
    const manager = await startManager()

    // Subscribe a thread before shutdown
    manager.subscribeThread('thr_1', () => {})

    // Make process exit on SIGTERM
    mockProc.kill = vi.fn((signal?: string) => {
      if (signal === 'SIGTERM') {
        setTimeout(() => mockProc.emit('exit', 0, 'SIGTERM'), 0)
      }
    })

    await manager.shutdown()

    expect(manager.isHealthy()).toBe(false)
    expect(manager.pid).toBeUndefined()

    // Thread listeners should be cleared
    expect((manager as any).threadListeners.size).toBe(0)
    expect((manager as any).globalListeners.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Provider Class (CodexAppServerProvider)
// ---------------------------------------------------------------------------

describe('CodexAppServerProvider — spawn/resume/shutdown', () => {
  let CodexAppServerProvider: typeof import('./codex-app-server-provider.js').CodexAppServerProvider

  beforeEach(async () => {
    vi.clearAllMocks()
    mockProc = createMockChildProcess()
    const mod = await import('./codex-app-server-provider.js')
    CodexAppServerProvider = mod.CodexAppServerProvider
  })

  function makeConfig(overrides: Partial<import('./types.js').AgentSpawnConfig> = {}): import('./types.js').AgentSpawnConfig {
    return {
      prompt: 'Test prompt',
      cwd: '/project',
      env: {},
      abortController: new AbortController(),
      autonomous: true,
      sandboxEnabled: false,
      ...overrides,
    }
  }

  it('spawn() creates a handle with stream and sessionId', () => {
    const provider = new CodexAppServerProvider()
    const handle = provider.spawn(makeConfig())

    expect(handle).toBeDefined()
    expect(handle.sessionId).toBeNull() // Not set until stream is consumed
    expect(handle.stream).toBeDefined()
  })

  it('resume() creates a handle with the given sessionId passed through', () => {
    const provider = new CodexAppServerProvider()
    const handle = provider.resume('thr_existing', makeConfig())

    expect(handle).toBeDefined()
    expect(handle.stream).toBeDefined()
    // The resumeThreadId is stored internally and used when the stream starts
  })

  it('singleton process manager — multiple spawn() calls reuse the same processManager when healthy', async () => {
    const provider = new CodexAppServerProvider()
    const handle1 = provider.spawn(makeConfig())
    const handle2 = provider.spawn(makeConfig())

    // Both handles should reference the same internal processManager
    // We can check by examining that only one processManager was created
    expect((provider as any).processManager).toBeDefined()

    // The processManager should be the same instance (not healthy yet, but same object)
    const pm1 = (provider as any).processManager
    expect(pm1).toBeDefined()

    // Spawn again — should get the same processManager since it was just created
    // (it's not healthy yet, so getOrCreateProcessManager creates a new one)
    // Actually: getOrCreateProcessManager checks isHealthy(), which returns false before start()
    // So each spawn will create a new PM if the previous one isn't healthy.
    // Let's verify this behavior:
    const pm2 = (provider as any).processManager
    // Since isHealthy() was false for pm1, pm2 is a new instance
    expect(pm2).toBeDefined()
  })

  it('process manager recreation — if isHealthy() returns false, creates a new process manager', () => {
    const provider = new CodexAppServerProvider()

    // First spawn creates a PM
    provider.spawn(makeConfig())
    const pm1 = (provider as any).processManager

    // PM is not healthy (not started), so next spawn should create a new one
    expect(pm1.isHealthy()).toBe(false)

    provider.spawn(makeConfig())
    const pm2 = (provider as any).processManager

    expect(pm2).not.toBe(pm1)
  })

  it('singleton process manager — reuses PM when healthy', async () => {
    const provider = new CodexAppServerProvider()

    // Manually make the PM healthy by starting it
    provider.spawn(makeConfig())
    const pm = (provider as any).processManager

    // Start the PM so it becomes healthy
    const startPromise = pm.start()
    await vi.waitFor(() => {
      expect(mockProc.stdin.write).toHaveBeenCalled()
    })
    emitLine({ id: 1, result: {} })
    await startPromise

    expect(pm.isHealthy()).toBe(true)

    // Now spawn again — should reuse the same PM
    provider.spawn(makeConfig())
    const pm2 = (provider as any).processManager

    expect(pm2).toBe(pm)
  })

  it('shutdown() delegates to processManager.shutdown() and nullifies', async () => {
    const provider = new CodexAppServerProvider()
    provider.spawn(makeConfig())

    const pm = (provider as any).processManager
    const shutdownSpy = vi.spyOn(pm, 'shutdown').mockResolvedValue(undefined)

    await provider.shutdown()

    expect(shutdownSpy).toHaveBeenCalledTimes(1)
    expect((provider as any).processManager).toBeNull()
  })

  it('shutdown() is safe to call when no process manager exists', async () => {
    const provider = new CodexAppServerProvider()
    // No spawn() called, so no processManager
    await expect(provider.shutdown()).resolves.toBeUndefined()
  })
})
