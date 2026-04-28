import { describe, it, expect, vi } from 'vitest'
import { buildAgentCard, createA2aRequestHandler, formatSseEvent } from './a2a-server.js'
import type { A2aServerConfig, A2aHandlerOptions } from './a2a-server.js'
import type {
  A2aTask,
  A2aMessage,
  A2aTaskStatusUpdateEvent,
  A2aTaskArtifactUpdateEvent,
  JsonRpcRequest,
} from './a2a-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(
  method: string,
  params?: Record<string, unknown>,
  id: string | number = 1,
): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method, params }
}

function makeMessage(text: string, role: 'user' | 'agent' = 'user'): A2aMessage {
  return { role, parts: [{ type: 'text', text }] }
}

function makeTask(overrides: Partial<A2aTask> = {}): A2aTask {
  return {
    id: 'task-1',
    status: 'submitted',
    messages: [],
    artifacts: [],
    ...overrides,
  }
}

/** Build a handler with permissive auth and controllable callbacks */
function createTestHandler(opts: Partial<A2aHandlerOptions> = {}) {
  const onSendMessage = opts.onSendMessage ?? vi.fn(async () => makeTask())
  const onGetTask = opts.onGetTask ?? vi.fn(async () => makeTask())
  const onCancelTask = opts.onCancelTask ?? vi.fn(async () => makeTask())
  const verifyAuth = opts.verifyAuth ?? (() => true)

  const handler = createA2aRequestHandler({
    onSendMessage,
    onGetTask,
    onCancelTask,
    verifyAuth,
  })

  return { handler, onSendMessage, onGetTask, onCancelTask }
}

// ---------------------------------------------------------------------------
// buildAgentCard
// ---------------------------------------------------------------------------

describe('buildAgentCard', () => {
  const baseConfig: A2aServerConfig = {
    name: 'TestAgent',
    description: 'A test agent',
    url: 'https://example.com/a2a',
  }

  it('generates a valid card from minimal config', () => {
    const card = buildAgentCard(baseConfig)

    expect(card.name).toBe('TestAgent')
    expect(card.description).toBe('A test agent')
    expect(card.url).toBe('https://example.com/a2a')
    expect(card.version).toBe('1.0.0')
    expect(card.capabilities.streaming).toBe(false)
    expect(card.capabilities.pushNotifications).toBe(false)
    expect(card.capabilities.stateTransitionHistory).toBe(false)
    expect(card.defaultInputContentTypes).toEqual(['text/plain'])
    expect(card.defaultOutputContentTypes).toEqual(['text/plain'])
  })

  it('uses the provided version', () => {
    const card = buildAgentCard({ ...baseConfig, version: '2.3.1' })
    expect(card.version).toBe('2.3.1')
  })

  it('sets streaming capability when configured', () => {
    const card = buildAgentCard({ ...baseConfig, streaming: true })
    expect(card.capabilities.streaming).toBe(true)
  })

  it('includes authentication schemes when provided', () => {
    const card = buildAgentCard({
      ...baseConfig,
      authSchemes: [{ type: 'http', scheme: 'bearer' }],
    })
    expect(card.authentication).toEqual([{ type: 'http', scheme: 'bearer' }])
  })

  it('does not include authentication when not provided', () => {
    const card = buildAgentCard(baseConfig)
    expect(card.authentication).toBeUndefined()
  })

  it('auto-generates skills from AgentWorkType values when none provided', () => {
    const card = buildAgentCard(baseConfig)
    expect(card.skills.length).toBeGreaterThan(0)

    const ids = card.skills.map((s) => s.id)
    expect(ids).toContain('code-development')
    expect(ids).toContain('quality-assurance')
    expect(ids).toContain('research-analysis')
    expect(ids).toContain('backlog-creation')
    expect(ids).toContain('refinement-coordination')
    expect(ids).not.toContain('coordination')
    expect(ids).not.toContain('inflight-coordination')
  })

  it('uses explicit skills when provided, ignoring auto-generation', () => {
    const customSkills = [
      { id: 'custom-skill', name: 'Custom', description: 'A custom skill' },
    ]
    const card = buildAgentCard({ ...baseConfig, skills: customSkills })
    expect(card.skills).toEqual(customSkills)
    expect(card.skills).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// createA2aRequestHandler — method routing
// ---------------------------------------------------------------------------

describe('createA2aRequestHandler', () => {
  describe('message/send', () => {
    it('routes message/send and returns the task', async () => {
      const task = makeTask({ id: 'task-42', status: 'working' })
      const onSendMessage = vi.fn(async () => task)
      const { handler } = createTestHandler({ onSendMessage })

      const message = makeMessage('Hello agent')
      const res = await handler(
        makeRequest('message/send', { message }),
      )

      expect(res.error).toBeUndefined()
      expect(res.result).toEqual(task)
      expect(onSendMessage).toHaveBeenCalledWith(message, undefined)
    })

    it('passes taskId to onSendMessage when provided', async () => {
      const onSendMessage = vi.fn(async () => makeTask())
      const { handler } = createTestHandler({ onSendMessage })

      const message = makeMessage('Continue working')
      await handler(
        makeRequest('message/send', { message, taskId: 'existing-task' }),
      )

      expect(onSendMessage).toHaveBeenCalledWith(message, 'existing-task')
    })

    it('returns -32602 when message param is missing', async () => {
      const { handler } = createTestHandler()
      const res = await handler(makeRequest('message/send', {}))

      expect(res.error?.code).toBe(-32602)
      expect(res.error?.message).toContain('message is required')
    })

    it('returns -32602 when params are missing entirely', async () => {
      const { handler } = createTestHandler()
      const res = await handler(makeRequest('message/send'))

      expect(res.error?.code).toBe(-32602)
    })

    it('returns -32603 when onSendMessage throws', async () => {
      const onSendMessage = vi.fn(async () => {
        throw new Error('Queue full')
      })
      const { handler } = createTestHandler({ onSendMessage })

      const res = await handler(
        makeRequest('message/send', { message: makeMessage('hi') }),
      )

      expect(res.error?.code).toBe(-32603)
      expect(res.error?.message).toBe('Queue full')
    })
  })

  describe('tasks/get', () => {
    it('returns the task when found', async () => {
      const task = makeTask({ id: 'task-99', status: 'completed' })
      const onGetTask = vi.fn(async () => task)
      const { handler } = createTestHandler({ onGetTask })

      const res = await handler(makeRequest('tasks/get', { taskId: 'task-99' }))

      expect(res.error).toBeUndefined()
      expect(res.result).toEqual(task)
      expect(onGetTask).toHaveBeenCalledWith('task-99')
    })

    it('returns -32001 when task is not found', async () => {
      const onGetTask = vi.fn(async () => null)
      const { handler } = createTestHandler({ onGetTask })

      const res = await handler(makeRequest('tasks/get', { taskId: 'missing' }))

      expect(res.error?.code).toBe(-32001)
      expect(res.error?.message).toBe('Task not found')
    })

    it('returns -32602 when taskId is missing', async () => {
      const { handler } = createTestHandler()
      const res = await handler(makeRequest('tasks/get', {}))

      expect(res.error?.code).toBe(-32602)
      expect(res.error?.message).toContain('taskId is required')
    })

    it('returns -32602 when taskId is not a string', async () => {
      const { handler } = createTestHandler()
      const res = await handler(makeRequest('tasks/get', { taskId: 123 }))

      expect(res.error?.code).toBe(-32602)
    })
  })

  describe('tasks/cancel', () => {
    it('returns the canceled task', async () => {
      const task = makeTask({ id: 'task-5', status: 'canceled' })
      const onCancelTask = vi.fn(async () => task)
      const { handler } = createTestHandler({ onCancelTask })

      const res = await handler(makeRequest('tasks/cancel', { taskId: 'task-5' }))

      expect(res.error).toBeUndefined()
      expect(res.result).toEqual(task)
      expect(onCancelTask).toHaveBeenCalledWith('task-5')
    })

    it('returns -32001 when task is not found', async () => {
      const onCancelTask = vi.fn(async () => null)
      const { handler } = createTestHandler({ onCancelTask })

      const res = await handler(makeRequest('tasks/cancel', { taskId: 'no-such' }))

      expect(res.error?.code).toBe(-32001)
      expect(res.error?.message).toBe('Task not found')
    })

    it('returns -32602 when taskId is missing', async () => {
      const { handler } = createTestHandler()
      const res = await handler(makeRequest('tasks/cancel'))

      expect(res.error?.code).toBe(-32602)
    })
  })

  describe('unknown method', () => {
    it('returns -32601 for an unrecognised method', async () => {
      const { handler } = createTestHandler()
      const res = await handler(makeRequest('foo/bar'))

      expect(res.error?.code).toBe(-32601)
      expect(res.error?.message).toContain('Method not found')
      expect(res.error?.message).toContain('foo/bar')
    })
  })

  describe('authentication', () => {
    it('returns -32000 when verifyAuth rejects', async () => {
      const verifyAuth = () => false
      const { handler } = createTestHandler({ verifyAuth })

      const res = await handler(makeRequest('tasks/get', { taskId: 'x' }))

      expect(res.error?.code).toBe(-32000)
      expect(res.error?.message).toBe('Unauthorized')
    })

    it('passes the auth header to verifyAuth', async () => {
      const verifyAuth = vi.fn(() => true)
      const { handler } = createTestHandler({ verifyAuth })

      await handler(makeRequest('tasks/get', { taskId: 'x' }), 'Bearer tok-123')

      expect(verifyAuth).toHaveBeenCalledWith('Bearer tok-123')
    })

    it('passes undefined when no auth header is provided', async () => {
      const verifyAuth = vi.fn(() => true)
      const { handler } = createTestHandler({ verifyAuth })

      await handler(makeRequest('tasks/get', { taskId: 'x' }))

      expect(verifyAuth).toHaveBeenCalledWith(undefined)
    })
  })

  describe('response format', () => {
    it('always includes jsonrpc 2.0 version', async () => {
      const { handler } = createTestHandler()
      const res = await handler(makeRequest('tasks/get', { taskId: 'x' }))
      expect(res.jsonrpc).toBe('2.0')
    })

    it('echoes back the request id', async () => {
      const { handler } = createTestHandler()
      const res = await handler(makeRequest('tasks/get', { taskId: 'x' }, 42))
      expect(res.id).toBe(42)
    })

    it('echoes string ids correctly', async () => {
      const { handler } = createTestHandler()
      const res = await handler(makeRequest('tasks/get', { taskId: 'x' }, 'req-abc'))
      expect(res.id).toBe('req-abc')
    })
  })
})

// ---------------------------------------------------------------------------
// formatSseEvent
// ---------------------------------------------------------------------------

describe('formatSseEvent', () => {
  it('formats a TaskStatusUpdate event', () => {
    const event: A2aTaskStatusUpdateEvent = {
      type: 'TaskStatusUpdate',
      taskId: 'task-1',
      status: 'working',
      final: false,
    }

    const result = formatSseEvent(event)

    expect(result).toBe(
      'event: TaskStatusUpdate\n' +
      `data: ${JSON.stringify(event)}\n\n`,
    )
  })

  it('formats a TaskStatusUpdate with message', () => {
    const event: A2aTaskStatusUpdateEvent = {
      type: 'TaskStatusUpdate',
      taskId: 'task-2',
      status: 'completed',
      message: makeMessage('Done!', 'agent'),
      final: true,
    }

    const result = formatSseEvent(event)

    expect(result).toContain('event: TaskStatusUpdate\n')
    expect(result).toContain('"final":true')
    expect(result).toContain('"text":"Done!"')
    expect(result.endsWith('\n\n')).toBe(true)
  })

  it('formats a TaskArtifactUpdate event', () => {
    const event: A2aTaskArtifactUpdateEvent = {
      type: 'TaskArtifactUpdate',
      taskId: 'task-3',
      artifact: {
        name: 'report.md',
        parts: [{ type: 'text', text: '# Report' }],
      },
    }

    const result = formatSseEvent(event)

    expect(result).toBe(
      'event: TaskArtifactUpdate\n' +
      `data: ${JSON.stringify(event)}\n\n`,
    )
  })

  it('uses the event type as the SSE event name', () => {
    const event: A2aTaskStatusUpdateEvent = {
      type: 'TaskStatusUpdate',
      taskId: 'task-1',
      status: 'failed',
      final: true,
    }

    const lines = formatSseEvent(event).split('\n')
    expect(lines[0]).toBe('event: TaskStatusUpdate')
  })

  it('puts the full JSON payload on the data line', () => {
    const event: A2aTaskStatusUpdateEvent = {
      type: 'TaskStatusUpdate',
      taskId: 'task-1',
      status: 'submitted',
      final: false,
    }

    const lines = formatSseEvent(event).split('\n')
    const dataLine = lines[1]
    const parsed = JSON.parse(dataLine.replace('data: ', ''))
    expect(parsed.taskId).toBe('task-1')
    expect(parsed.status).toBe('submitted')
  })

  it('ends with double newline', () => {
    const event: A2aTaskStatusUpdateEvent = {
      type: 'TaskStatusUpdate',
      taskId: 't',
      status: 'working',
      final: false,
    }

    expect(formatSseEvent(event)).toMatch(/\n\n$/)
  })
})
