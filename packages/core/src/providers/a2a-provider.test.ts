import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  mapA2aTaskEvent,
  fetchAgentCard,
  type A2aTaskEvent,
  type A2aEventMapperState,
  type A2aAgentCard,
} from './a2a-provider.js'

function freshState(): A2aEventMapperState {
  return {
    sessionId: null,
    taskId: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    turnCount: 0,
  }
}

describe('mapA2aTaskEvent', () => {
  // -----------------------------------------------------------------------
  // TaskStatusUpdate — submitted
  // -----------------------------------------------------------------------

  it('maps submitted status to init event', () => {
    const state = freshState()
    const event: A2aTaskEvent = {
      type: 'TaskStatusUpdate',
      id: 'task-123',
      sessionId: 'sess-456',
      status: { state: 'submitted' },
    }
    const result = mapA2aTaskEvent(event, state)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: 'init',
      sessionId: 'sess-456',
    })
    expect(state.sessionId).toBe('sess-456')
    expect(state.taskId).toBe('task-123')
  })

  it('uses task id as sessionId when sessionId is not present', () => {
    const state = freshState()
    const event: A2aTaskEvent = {
      type: 'TaskStatusUpdate',
      id: 'task-789',
      status: { state: 'submitted' },
    }
    const result = mapA2aTaskEvent(event, state)

    expect(result[0]).toMatchObject({
      type: 'init',
      sessionId: 'task-789',
    })
    expect(state.sessionId).toBe('task-789')
  })

  // -----------------------------------------------------------------------
  // TaskStatusUpdate — working
  // -----------------------------------------------------------------------

  it('maps working status with message to assistant_text', () => {
    const state = freshState()
    const event: A2aTaskEvent = {
      type: 'TaskStatusUpdate',
      id: 'task-123',
      status: {
        state: 'working',
        message: {
          role: 'agent',
          parts: [{ type: 'text', text: 'Analyzing the codebase...' }],
        },
      },
    }
    const result = mapA2aTaskEvent(event, state)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: 'assistant_text',
      text: 'Analyzing the codebase...',
    })
    expect(state.turnCount).toBe(1)
  })

  it('maps working status without message to system event', () => {
    const state = freshState()
    const event: A2aTaskEvent = {
      type: 'TaskStatusUpdate',
      id: 'task-123',
      status: { state: 'working' },
    }
    const result = mapA2aTaskEvent(event, state)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'working',
      message: 'Task task-123 is working (turn 1)',
    })
    expect(state.turnCount).toBe(1)
  })

  it('increments turn count on each working event', () => {
    const state = freshState()
    const event: A2aTaskEvent = {
      type: 'TaskStatusUpdate',
      id: 'task-123',
      status: { state: 'working' },
    }

    mapA2aTaskEvent(event, state)
    expect(state.turnCount).toBe(1)

    mapA2aTaskEvent(event, state)
    expect(state.turnCount).toBe(2)

    const result = mapA2aTaskEvent(event, state)
    expect(state.turnCount).toBe(3)
    expect(result[0]).toMatchObject({
      message: 'Task task-123 is working (turn 3)',
    })
  })

  // -----------------------------------------------------------------------
  // TaskStatusUpdate — input-required
  // -----------------------------------------------------------------------

  it('maps input-required status to system event with input_required subtype', () => {
    const state = freshState()
    const event: A2aTaskEvent = {
      type: 'TaskStatusUpdate',
      id: 'task-123',
      status: {
        state: 'input-required',
        message: {
          role: 'agent',
          parts: [{ type: 'text', text: 'Please provide the API key' }],
        },
      },
    }
    const result = mapA2aTaskEvent(event, state)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'input_required',
      message: 'Please provide the API key',
    })
  })

  it('maps input-required without message to default message', () => {
    const state = freshState()
    const event: A2aTaskEvent = {
      type: 'TaskStatusUpdate',
      id: 'task-123',
      status: { state: 'input-required' },
    }
    const result = mapA2aTaskEvent(event, state)

    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'input_required',
      message: 'Agent requires additional input',
    })
  })

  // -----------------------------------------------------------------------
  // TaskStatusUpdate — completed
  // -----------------------------------------------------------------------

  it('maps completed status to success result', () => {
    const state = freshState()
    state.turnCount = 3
    state.totalInputTokens = 500
    state.totalOutputTokens = 200

    const event: A2aTaskEvent = {
      type: 'TaskStatusUpdate',
      id: 'task-123',
      status: {
        state: 'completed',
        message: {
          role: 'agent',
          parts: [{ type: 'text', text: 'All done!' }],
        },
      },
    }
    const result = mapA2aTaskEvent(event, state)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: 'result',
      success: true,
      message: 'All done!',
      cost: {
        inputTokens: 500,
        outputTokens: 200,
        numTurns: 3,
      },
    })
  })

  it('maps completed status without message', () => {
    const state = freshState()
    const event: A2aTaskEvent = {
      type: 'TaskStatusUpdate',
      id: 'task-123',
      status: { state: 'completed' },
    }
    const result = mapA2aTaskEvent(event, state)

    expect(result[0]).toMatchObject({
      type: 'result',
      success: true,
    })
    expect((result[0] as { message?: string }).message).toBeUndefined()
  })

  it('omits zero-value cost fields', () => {
    const state = freshState()
    const event: A2aTaskEvent = {
      type: 'TaskStatusUpdate',
      id: 'task-123',
      status: { state: 'completed' },
    }
    const result = mapA2aTaskEvent(event, state)

    expect((result[0] as { cost?: object }).cost).toEqual({
      inputTokens: undefined,
      outputTokens: undefined,
      numTurns: undefined,
    })
  })

  // -----------------------------------------------------------------------
  // TaskStatusUpdate — failed
  // -----------------------------------------------------------------------

  it('maps failed status to failure result', () => {
    const state = freshState()
    const event: A2aTaskEvent = {
      type: 'TaskStatusUpdate',
      id: 'task-123',
      status: {
        state: 'failed',
        message: {
          role: 'agent',
          parts: [{ type: 'text', text: 'Model rate limit exceeded' }],
        },
      },
    }
    const result = mapA2aTaskEvent(event, state)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: 'result',
      success: false,
      errors: ['Model rate limit exceeded'],
      errorSubtype: 'task_failed',
    })
  })

  it('maps failed status without message to default error', () => {
    const state = freshState()
    const event: A2aTaskEvent = {
      type: 'TaskStatusUpdate',
      id: 'task-123',
      status: { state: 'failed' },
    }
    const result = mapA2aTaskEvent(event, state)

    expect(result[0]).toMatchObject({
      type: 'result',
      success: false,
      errors: ['Task failed'],
      errorSubtype: 'task_failed',
    })
  })

  // -----------------------------------------------------------------------
  // TaskStatusUpdate — canceled
  // -----------------------------------------------------------------------

  it('maps canceled status to failure result with canceled subtype', () => {
    const state = freshState()
    const event: A2aTaskEvent = {
      type: 'TaskStatusUpdate',
      id: 'task-123',
      status: {
        state: 'canceled',
        message: {
          role: 'agent',
          parts: [{ type: 'text', text: 'User requested cancellation' }],
        },
      },
    }
    const result = mapA2aTaskEvent(event, state)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: 'result',
      success: false,
      errors: ['User requested cancellation'],
      errorSubtype: 'canceled',
    })
  })

  it('maps canceled status without message to default', () => {
    const state = freshState()
    const event: A2aTaskEvent = {
      type: 'TaskStatusUpdate',
      id: 'task-123',
      status: { state: 'canceled' },
    }
    const result = mapA2aTaskEvent(event, state)

    expect(result[0]).toMatchObject({
      type: 'result',
      success: false,
      errors: ['Task canceled'],
      errorSubtype: 'canceled',
    })
  })

  // -----------------------------------------------------------------------
  // TaskStatusUpdate — unknown state
  // -----------------------------------------------------------------------

  it('handles unknown status state gracefully', () => {
    const state = freshState()
    const event: A2aTaskEvent = {
      type: 'TaskStatusUpdate',
      id: 'task-123',
      status: { state: 'paused' as never },
    }
    const result = mapA2aTaskEvent(event, state)

    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'unknown',
      message: 'Unknown A2A task status: paused',
    })
  })

  // -----------------------------------------------------------------------
  // TaskArtifactUpdate
  // -----------------------------------------------------------------------

  it('maps artifact update with text parts to assistant_text', () => {
    const state = freshState()
    const event: A2aTaskEvent = {
      type: 'TaskArtifactUpdate',
      id: 'task-123',
      artifact: {
        name: 'analysis-report',
        description: 'Code analysis report',
        parts: [{ type: 'text', text: 'Found 3 issues in the codebase.' }],
      },
    }
    const result = mapA2aTaskEvent(event, state)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: 'assistant_text',
      text: 'Found 3 issues in the codebase.',
    })
  })

  it('maps artifact update with data parts to JSON text', () => {
    const state = freshState()
    const event: A2aTaskEvent = {
      type: 'TaskArtifactUpdate',
      id: 'task-123',
      artifact: {
        parts: [{ type: 'data', data: { issues: 3, severity: 'high' } }],
      },
    }
    const result = mapA2aTaskEvent(event, state)

    expect(result[0]).toMatchObject({
      type: 'assistant_text',
      text: '{"issues":3,"severity":"high"}',
    })
  })

  it('maps artifact update with file parts', () => {
    const state = freshState()
    const event: A2aTaskEvent = {
      type: 'TaskArtifactUpdate',
      id: 'task-123',
      artifact: {
        parts: [{ type: 'file', file: { name: 'report.pdf', mimeType: 'application/pdf' } }],
      },
    }
    const result = mapA2aTaskEvent(event, state)

    expect(result[0]).toMatchObject({
      type: 'assistant_text',
      text: '[File: report.pdf]',
    })
  })

  it('maps artifact update with empty parts to artifact name', () => {
    const state = freshState()
    const event: A2aTaskEvent = {
      type: 'TaskArtifactUpdate',
      id: 'task-123',
      artifact: {
        name: 'my-artifact',
        parts: [],
      },
    }
    const result = mapA2aTaskEvent(event, state)

    expect(result[0]).toMatchObject({
      type: 'assistant_text',
      text: '[Artifact: my-artifact]',
    })
  })

  it('maps artifact update with unnamed empty parts', () => {
    const state = freshState()
    const event: A2aTaskEvent = {
      type: 'TaskArtifactUpdate',
      id: 'task-123',
      artifact: {
        parts: [],
      },
    }
    const result = mapA2aTaskEvent(event, state)

    expect(result[0]).toMatchObject({
      type: 'assistant_text',
      text: '[Artifact: unnamed]',
    })
  })

  // -----------------------------------------------------------------------
  // State tracking
  // -----------------------------------------------------------------------

  it('tracks taskId from first event', () => {
    const state = freshState()
    const event: A2aTaskEvent = {
      type: 'TaskStatusUpdate',
      id: 'task-abc',
      status: { state: 'submitted' },
    }
    mapA2aTaskEvent(event, state)

    expect(state.taskId).toBe('task-abc')
  })

  it('tracks sessionId from first event', () => {
    const state = freshState()
    const event: A2aTaskEvent = {
      type: 'TaskStatusUpdate',
      id: 'task-abc',
      sessionId: 'sess-xyz',
      status: { state: 'submitted' },
    }
    mapA2aTaskEvent(event, state)

    expect(state.sessionId).toBe('sess-xyz')
  })

  it('does not overwrite taskId once set', () => {
    const state = freshState()
    state.taskId = 'existing-task'

    const event: A2aTaskEvent = {
      type: 'TaskArtifactUpdate',
      id: 'new-task',
      artifact: {
        parts: [{ type: 'text', text: 'hello' }],
      },
    }
    mapA2aTaskEvent(event, state)

    expect(state.taskId).toBe('existing-task')
  })

  it('does not overwrite sessionId once set', () => {
    const state = freshState()
    state.sessionId = 'existing-session'

    const event: A2aTaskEvent = {
      type: 'TaskArtifactUpdate',
      id: 'task-123',
      sessionId: 'new-session',
      artifact: {
        parts: [{ type: 'text', text: 'hello' }],
      },
    }
    mapA2aTaskEvent(event, state)

    expect(state.sessionId).toBe('existing-session')
  })

  // -----------------------------------------------------------------------
  // Unknown event type
  // -----------------------------------------------------------------------

  it('handles unknown event type gracefully', () => {
    const state = freshState()
    const event = { type: 'TaskSomethingElse', id: 'task-1' } as unknown as A2aTaskEvent
    const result = mapA2aTaskEvent(event, state)

    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'unknown',
    })
  })

  // -----------------------------------------------------------------------
  // Multi-part messages
  // -----------------------------------------------------------------------

  it('concatenates multiple text parts', () => {
    const state = freshState()
    const event: A2aTaskEvent = {
      type: 'TaskStatusUpdate',
      id: 'task-123',
      status: {
        state: 'working',
        message: {
          role: 'agent',
          parts: [
            { type: 'text', text: 'Part 1' },
            { type: 'text', text: 'Part 2' },
          ],
        },
      },
    }
    const result = mapA2aTaskEvent(event, state)

    expect(result[0]).toMatchObject({
      type: 'assistant_text',
      text: 'Part 1\nPart 2',
    })
  })

  it('mixes text and data parts in message', () => {
    const state = freshState()
    const event: A2aTaskEvent = {
      type: 'TaskStatusUpdate',
      id: 'task-123',
      status: {
        state: 'working',
        message: {
          role: 'agent',
          parts: [
            { type: 'text', text: 'Results:' },
            { type: 'data', data: { count: 42 } },
          ],
        },
      },
    }
    const result = mapA2aTaskEvent(event, state)

    expect(result[0]).toMatchObject({
      type: 'assistant_text',
      text: 'Results:\n{"count":42}',
    })
  })

  // -----------------------------------------------------------------------
  // raw event preservation
  // -----------------------------------------------------------------------

  it('preserves the raw event on all mapped events', () => {
    const state = freshState()
    const event: A2aTaskEvent = {
      type: 'TaskStatusUpdate',
      id: 'task-123',
      status: { state: 'submitted' },
    }
    const result = mapA2aTaskEvent(event, state)

    expect(result[0].raw).toBe(event)
  })
})

// ---------------------------------------------------------------------------
// fetchAgentCard
// ---------------------------------------------------------------------------

describe('fetchAgentCard', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('fetches and parses a valid agent card', async () => {
    const card: A2aAgentCard = {
      name: 'Test Agent',
      url: 'https://agent.example.com',
      description: 'A test A2A agent',
      version: '1.0.0',
      skills: [
        { id: 'code-review', name: 'Code Review', description: 'Reviews code' },
      ],
      capabilities: {
        streaming: true,
        multiTurn: true,
      },
    }

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(card),
    }) as unknown as typeof fetch

    const result = await fetchAgentCard('https://agent.example.com')

    expect(result).toEqual(card)
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://agent.example.com/.well-known/agent-card.json',
      expect.objectContaining({
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      }),
    )
  })

  it('strips trailing slashes from base URL', async () => {
    const card: A2aAgentCard = {
      name: 'Test Agent',
      url: 'https://agent.example.com',
    }

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(card),
    }) as unknown as typeof fetch

    await fetchAgentCard('https://agent.example.com/')

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://agent.example.com/.well-known/agent-card.json',
      expect.anything(),
    )
  })

  it('throws on HTTP error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    }) as unknown as typeof fetch

    await expect(fetchAgentCard('https://agent.example.com'))
      .rejects.toThrow('Failed to fetch A2A agent card')
  })

  it('throws on invalid agent card (missing name)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ url: 'https://agent.example.com' }),
    }) as unknown as typeof fetch

    await expect(fetchAgentCard('https://agent.example.com'))
      .rejects.toThrow('missing required fields')
  })

  it('throws on invalid agent card (missing url)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ name: 'Test' }),
    }) as unknown as typeof fetch

    await expect(fetchAgentCard('https://agent.example.com'))
      .rejects.toThrow('missing required fields')
  })
})

// ---------------------------------------------------------------------------
// A2aProvider class and factory
// ---------------------------------------------------------------------------

describe('A2aProvider', () => {
  it('exports A2aProvider class', async () => {
    const { A2aProvider } = await import('./a2a-provider.js')
    const provider = new A2aProvider()
    expect(provider.name).toBe('a2a')
  })

  it('exports createA2aProvider factory', async () => {
    const { createA2aProvider } = await import('./a2a-provider.js')
    const provider = createA2aProvider()
    expect(provider.name).toBe('a2a')
  })

  it('spawn returns a handle with error when A2A_AGENT_URL is not set', async () => {
    const { A2aProvider } = await import('./a2a-provider.js')
    const provider = new A2aProvider()

    // Save and clear env
    const savedUrl = process.env.A2A_AGENT_URL
    delete process.env.A2A_AGENT_URL
    // Clear any A2A_AGENT_URL_* vars
    const savedUrlVars: Record<string, string | undefined> = {}
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('A2A_AGENT_URL_')) {
        savedUrlVars[key] = process.env[key]
        delete process.env[key]
      }
    }

    try {
      const handle = provider.spawn({
        prompt: 'test',
        cwd: '/tmp',
        env: {},
        abortController: new AbortController(),
        autonomous: true,
        sandboxEnabled: false,
      })

      expect(handle.sessionId).toBeNull()

      // Consume the stream to check error events
      const events = []
      for await (const event of handle.stream) {
        events.push(event)
      }

      expect(events).toHaveLength(2)
      expect(events[0]).toMatchObject({
        type: 'error',
        message: expect.stringContaining('A2A_AGENT_URL'),
      })
      expect(events[1]).toMatchObject({
        type: 'result',
        success: false,
        errorSubtype: 'configuration_error',
      })
    } finally {
      // Restore env
      if (savedUrl !== undefined) {
        process.env.A2A_AGENT_URL = savedUrl
      }
      for (const [key, value] of Object.entries(savedUrlVars)) {
        if (value !== undefined) {
          process.env[key] = value
        }
      }
    }
  })

  it('resume sets sessionId on the handle', async () => {
    const { A2aProvider } = await import('./a2a-provider.js')
    const provider = new A2aProvider()

    // Save and clear env
    const savedUrl = process.env.A2A_AGENT_URL
    delete process.env.A2A_AGENT_URL
    const savedUrlVars: Record<string, string | undefined> = {}
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('A2A_AGENT_URL_')) {
        savedUrlVars[key] = process.env[key]
        delete process.env[key]
      }
    }

    try {
      const handle = provider.spawn({
        prompt: 'test',
        cwd: '/tmp',
        env: { A2A_AGENT_URL: 'https://agent.example.com' },
        abortController: new AbortController(),
        autonomous: true,
        sandboxEnabled: false,
      })

      // When the URL is set, sessionId starts null (until init event)
      expect(handle.sessionId).toBeNull()
    } finally {
      if (savedUrl !== undefined) {
        process.env.A2A_AGENT_URL = savedUrl
      }
      for (const [key, value] of Object.entries(savedUrlVars)) {
        if (value !== undefined) {
          process.env[key] = value
        }
      }
    }
  })
})
