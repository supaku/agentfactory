import { describe, it, expect } from 'vitest'
import {
  mapCodexEvent,
  mapCodexItemEvent,
  type CodexEvent,
  type CodexItemEvent,
  type CodexEventMapperState,
} from './codex-provider.js'

function freshState(): CodexEventMapperState {
  return {
    sessionId: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
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
        numTurns: 1,
      },
    })
    expect(state.totalInputTokens).toBe(100)
    expect(state.totalOutputTokens).toBe(50)
  })

  it('accumulates usage across multiple turns', () => {
    const state = freshState()
    state.turnCount = 2

    mapCodexEvent(
      { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50 } },
      state,
    )
    const result = mapCodexEvent(
      { type: 'turn.completed', usage: { input_tokens: 200, output_tokens: 80 } },
      state,
    )

    expect(result[0]).toMatchObject({
      type: 'result',
      success: true,
      cost: { inputTokens: 300, outputTokens: 130 },
    })
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
