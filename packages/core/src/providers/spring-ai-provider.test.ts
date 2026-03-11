import { describe, it, expect } from 'vitest'
import {
  mapSpringAiEvent,
  type SpringAiEvent,
  type SpringAiEventMapperState,
} from './spring-ai-provider.js'

function freshState(): SpringAiEventMapperState {
  return {
    sessionId: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    turnCount: 0,
  }
}

describe('mapSpringAiEvent', () => {
  it('maps session.started to init', () => {
    const state = freshState()
    const event: SpringAiEvent = { type: 'session.started', session_id: 'sess-abc' }
    const result = mapSpringAiEvent(event, state)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: 'init',
      sessionId: 'sess-abc',
    })
    expect(state.sessionId).toBe('sess-abc')
  })

  it('maps turn.started to system with incrementing turn count', () => {
    const state = freshState()
    const event: SpringAiEvent = { type: 'turn.started' }

    const r1 = mapSpringAiEvent(event, state)
    expect(r1[0]).toMatchObject({
      type: 'system',
      subtype: 'turn_started',
      message: 'Turn 1 started',
    })
    expect(state.turnCount).toBe(1)

    const r2 = mapSpringAiEvent(event, state)
    expect(r2[0]).toMatchObject({ message: 'Turn 2 started' })
    expect(state.turnCount).toBe(2)
  })

  it('maps turn.completed to result with accumulated usage', () => {
    const state = freshState()
    state.turnCount = 1

    const event: SpringAiEvent = {
      type: 'turn.completed',
      usage: { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
    }
    const result = mapSpringAiEvent(event, state)

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

    mapSpringAiEvent(
      { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50 } },
      state,
    )
    const result = mapSpringAiEvent(
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
    const result = mapSpringAiEvent({ type: 'turn.completed' }, state)

    expect(result[0]).toMatchObject({ type: 'result', success: true })
  })

  it('maps turn.failed to failed result', () => {
    const state = freshState()
    const event: SpringAiEvent = {
      type: 'turn.failed',
      error: { message: 'Model error', code: 'MODEL_ERROR' },
    }
    const result = mapSpringAiEvent(event, state)

    expect(result[0]).toMatchObject({
      type: 'result',
      success: false,
      errors: ['Model error'],
      errorSubtype: 'turn_failed',
    })
  })

  it('maps turn.failed without error message', () => {
    const state = freshState()
    const result = mapSpringAiEvent({ type: 'turn.failed' }, state)

    expect(result[0]).toMatchObject({
      type: 'result',
      success: false,
      errors: ['Turn failed'],
    })
  })

  it('maps assistant.message to assistant_text', () => {
    const state = freshState()
    const event: SpringAiEvent = {
      type: 'assistant.message',
      id: 'msg-1',
      text: 'Analysis complete',
    }
    const result = mapSpringAiEvent(event, state)

    expect(result).toEqual([{
      type: 'assistant_text',
      text: 'Analysis complete',
      raw: event,
    }])
  })

  it('maps tool.invocation to tool_use', () => {
    const state = freshState()
    const event: SpringAiEvent = {
      type: 'tool.invocation',
      id: 'tool-1',
      tool_name: 'shell',
      input: { command: 'ls -la' },
    }
    const result = mapSpringAiEvent(event, state)

    expect(result[0]).toMatchObject({
      type: 'tool_use',
      toolName: 'shell',
      toolUseId: 'tool-1',
      input: { command: 'ls -la' },
    })
  })

  it('maps tool.result to tool_result', () => {
    const state = freshState()
    const event: SpringAiEvent = {
      type: 'tool.result',
      id: 'tool-1',
      tool_name: 'shell',
      content: 'file1.txt\nfile2.txt',
      is_error: false,
    }
    const result = mapSpringAiEvent(event, state)

    expect(result[0]).toMatchObject({
      type: 'tool_result',
      toolName: 'shell',
      toolUseId: 'tool-1',
      content: 'file1.txt\nfile2.txt',
      isError: false,
    })
  })

  it('maps tool.result with error', () => {
    const state = freshState()
    const event: SpringAiEvent = {
      type: 'tool.result',
      id: 'tool-1',
      tool_name: 'shell',
      content: 'command not found',
      is_error: true,
    }
    const result = mapSpringAiEvent(event, state)

    expect(result[0]).toMatchObject({
      type: 'tool_result',
      isError: true,
      content: 'command not found',
    })
  })

  it('maps error event', () => {
    const state = freshState()
    const event: SpringAiEvent = { type: 'error', message: 'Connection lost', code: 'CONN_ERROR' }
    const result = mapSpringAiEvent(event, state)

    expect(result[0]).toMatchObject({
      type: 'error',
      message: 'Connection lost',
      code: 'CONN_ERROR',
    })
  })

  it('maps error event without message', () => {
    const state = freshState()
    const result = mapSpringAiEvent({ type: 'error' } as SpringAiEvent, state)

    expect(result[0]).toMatchObject({
      type: 'error',
      message: 'Unknown error',
    })
  })

  it('handles unknown event type gracefully', () => {
    const state = freshState()
    const event = { type: 'unknown.event' } as unknown as SpringAiEvent
    const result = mapSpringAiEvent(event, state)

    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'unknown',
    })
  })
})

describe('SpringAiProvider', () => {
  it('exports SpringAiProvider class', async () => {
    const { SpringAiProvider } = await import('./spring-ai-provider.js')
    const provider = new SpringAiProvider()
    expect(provider.name).toBe('spring-ai')
  })

  it('exports createSpringAiProvider factory', async () => {
    const { createSpringAiProvider } = await import('./spring-ai-provider.js')
    const provider = createSpringAiProvider()
    expect(provider.name).toBe('spring-ai')
  })
})
