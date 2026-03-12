/**
 * Integration tests for the A2A Server
 *
 * Wires the A2A request handler to mock task callbacks and verifies
 * end-to-end JSON-RPC handling, AgentCard generation, SSE formatting,
 * and auth integration.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  buildAgentCard,
  createA2aRequestHandler,
  formatSseEvent,
} from './a2a-server.js'
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
  id: string | number = 'req-1',
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

// ---------------------------------------------------------------------------
// 1. Full message/send -> task lifecycle
// ---------------------------------------------------------------------------

describe('A2A Server — full task lifecycle', () => {
  it('creates a task via message/send, retrieves it, and cancels it', async () => {
    // In-memory task store
    const tasks = new Map<string, A2aTask>()

    const onSendMessage = vi.fn(async (message: A2aMessage, _taskId?: string): Promise<A2aTask> => {
      const task: A2aTask = {
        id: 'task-lifecycle-1',
        status: 'working',
        messages: [message],
        artifacts: [],
      }
      tasks.set(task.id, task)
      return task
    })

    const onGetTask = vi.fn(async (taskId: string): Promise<A2aTask | null> => {
      return tasks.get(taskId) ?? null
    })

    const onCancelTask = vi.fn(async (taskId: string): Promise<A2aTask | null> => {
      const task = tasks.get(taskId)
      if (!task) return null
      task.status = 'canceled'
      return task
    })

    const handler = createA2aRequestHandler({
      onSendMessage,
      onGetTask,
      onCancelTask,
      verifyAuth: () => true,
    })

    // Step 1: Send message
    const sendRes = await handler(
      makeRequest('message/send', { message: makeMessage('Build the feature') }),
    )

    expect(sendRes.error).toBeUndefined()
    const createdTask = sendRes.result as A2aTask
    expect(createdTask.id).toBe('task-lifecycle-1')
    expect(createdTask.status).toBe('working')
    expect(createdTask.messages).toHaveLength(1)
    expect(createdTask.messages[0].parts[0]).toMatchObject({ type: 'text', text: 'Build the feature' })
    expect(onSendMessage).toHaveBeenCalledWith(
      makeMessage('Build the feature'),
      undefined,
    )

    // Step 2: Get task
    const getRes = await handler(
      makeRequest('tasks/get', { taskId: 'task-lifecycle-1' }),
    )

    expect(getRes.error).toBeUndefined()
    const retrievedTask = getRes.result as A2aTask
    expect(retrievedTask.id).toBe('task-lifecycle-1')
    expect(retrievedTask.status).toBe('working')
    expect(onGetTask).toHaveBeenCalledWith('task-lifecycle-1')

    // Step 3: Cancel task
    const cancelRes = await handler(
      makeRequest('tasks/cancel', { taskId: 'task-lifecycle-1' }),
    )

    expect(cancelRes.error).toBeUndefined()
    const canceledTask = cancelRes.result as A2aTask
    expect(canceledTask.id).toBe('task-lifecycle-1')
    expect(canceledTask.status).toBe('canceled')
    expect(onCancelTask).toHaveBeenCalledWith('task-lifecycle-1')
  })

  it('returns -32001 when getting a non-existent task', async () => {
    const handler = createA2aRequestHandler({
      onSendMessage: vi.fn(async () => makeTask()),
      onGetTask: vi.fn(async () => null),
      onCancelTask: vi.fn(async () => null),
      verifyAuth: () => true,
    })

    const res = await handler(makeRequest('tasks/get', { taskId: 'nonexistent' }))
    expect(res.error?.code).toBe(-32001)
    expect(res.error?.message).toBe('Task not found')
  })

  it('returns -32001 when canceling a non-existent task', async () => {
    const handler = createA2aRequestHandler({
      onSendMessage: vi.fn(async () => makeTask()),
      onGetTask: vi.fn(async () => null),
      onCancelTask: vi.fn(async () => null),
      verifyAuth: () => true,
    })

    const res = await handler(makeRequest('tasks/cancel', { taskId: 'nonexistent' }))
    expect(res.error?.code).toBe(-32001)
    expect(res.error?.message).toBe('Task not found')
  })

  it('passes taskId to onSendMessage for follow-up messages', async () => {
    const onSendMessage = vi.fn(async () =>
      makeTask({ id: 'task-followup', status: 'working' }),
    )

    const handler = createA2aRequestHandler({
      onSendMessage,
      onGetTask: vi.fn(async () => null),
      onCancelTask: vi.fn(async () => null),
      verifyAuth: () => true,
    })

    await handler(
      makeRequest('message/send', {
        message: makeMessage('Continue working'),
        taskId: 'task-followup',
      }),
    )

    expect(onSendMessage).toHaveBeenCalledWith(
      makeMessage('Continue working'),
      'task-followup',
    )
  })

  it('returns -32603 when onSendMessage throws an error', async () => {
    const handler = createA2aRequestHandler({
      onSendMessage: vi.fn(async () => { throw new Error('Queue overflow') }),
      onGetTask: vi.fn(async () => null),
      onCancelTask: vi.fn(async () => null),
      verifyAuth: () => true,
    })

    const res = await handler(
      makeRequest('message/send', { message: makeMessage('hello') }),
    )

    expect(res.error?.code).toBe(-32603)
    expect(res.error?.message).toBe('Queue overflow')
  })

  it('returns -32601 for unknown methods', async () => {
    const handler = createA2aRequestHandler({
      onSendMessage: vi.fn(async () => makeTask()),
      onGetTask: vi.fn(async () => null),
      onCancelTask: vi.fn(async () => null),
      verifyAuth: () => true,
    })

    const res = await handler(makeRequest('tasks/unknown'))
    expect(res.error?.code).toBe(-32601)
    expect(res.error?.message).toContain('Method not found')
    expect(res.error?.message).toContain('tasks/unknown')
  })

  it('always returns JSON-RPC 2.0 version and echoes request id', async () => {
    const handler = createA2aRequestHandler({
      onSendMessage: vi.fn(async () => makeTask()),
      onGetTask: vi.fn(async () => makeTask()),
      onCancelTask: vi.fn(async () => null),
      verifyAuth: () => true,
    })

    const res = await handler(makeRequest('tasks/get', { taskId: 'task-1' }, 'my-req-42'))
    expect(res.jsonrpc).toBe('2.0')
    expect(res.id).toBe('my-req-42')
  })
})

// ---------------------------------------------------------------------------
// 2. AgentCard generation end-to-end
// ---------------------------------------------------------------------------

describe('A2A Server — AgentCard generation', () => {
  it('builds a complete agent card with all fields', () => {
    const config: A2aServerConfig = {
      name: 'FleetCoordinator',
      description: 'Coordinates work across multiple agents',
      url: 'https://fleet.example.com/a2a',
      version: '2.1.0',
      streaming: true,
      authSchemes: [
        { type: 'http', scheme: 'bearer' },
        { type: 'apiKey', in: 'header', name: 'x-api-key' },
      ],
    }

    const card = buildAgentCard(config)

    expect(card.name).toBe('FleetCoordinator')
    expect(card.description).toBe('Coordinates work across multiple agents')
    expect(card.url).toBe('https://fleet.example.com/a2a')
    expect(card.version).toBe('2.1.0')
    expect(card.capabilities.streaming).toBe(true)
    expect(card.capabilities.pushNotifications).toBe(false)
    expect(card.capabilities.stateTransitionHistory).toBe(false)
    expect(card.authentication).toEqual([
      { type: 'http', scheme: 'bearer' },
      { type: 'apiKey', in: 'header', name: 'x-api-key' },
    ])
    expect(card.defaultInputContentTypes).toEqual(['text/plain'])
    expect(card.defaultOutputContentTypes).toEqual(['text/plain'])
  })

  it('auto-generates skills from work types when none provided', () => {
    const card = buildAgentCard({
      name: 'Worker',
      description: 'Generic worker',
      url: 'https://worker.example.com/a2a',
    })

    expect(card.skills.length).toBeGreaterThan(0)

    const skillIds = card.skills.map(s => s.id)
    expect(skillIds).toContain('code-development')
    expect(skillIds).toContain('quality-assurance')
    expect(skillIds).toContain('research-analysis')
    expect(skillIds).toContain('backlog-creation')
    expect(skillIds).toContain('inflight-work')
    expect(skillIds).toContain('acceptance-review')
    expect(skillIds).toContain('refinement')
    expect(skillIds).toContain('coordination')
    expect(skillIds).toContain('qa-coordination')
    expect(skillIds).toContain('acceptance-coordination')

    // Each skill should have an id, name, and description
    for (const skill of card.skills) {
      expect(skill.id).toBeTruthy()
      expect(skill.name).toBeTruthy()
      expect(skill.description).toBeTruthy()
    }
  })

  it('uses explicit skills when provided', () => {
    const card = buildAgentCard({
      name: 'Specialist',
      description: 'A specialist agent',
      url: 'https://specialist.example.com/a2a',
      skills: [
        {
          id: 'data-analysis',
          name: 'Data Analysis',
          description: 'Analyze data sets and produce reports',
          tags: ['analysis'],
        },
      ],
    })

    expect(card.skills).toHaveLength(1)
    expect(card.skills[0].id).toBe('data-analysis')
    expect(card.skills[0].name).toBe('Data Analysis')
    expect(card.skills[0].tags).toEqual(['analysis'])
  })

  it('defaults version to 1.0.0 and streaming to false', () => {
    const card = buildAgentCard({
      name: 'Default',
      description: 'Defaults test',
      url: 'https://default.example.com/a2a',
    })

    expect(card.version).toBe('1.0.0')
    expect(card.capabilities.streaming).toBe(false)
  })

  it('omits authentication when no authSchemes provided', () => {
    const card = buildAgentCard({
      name: 'NoAuth',
      description: 'No auth agent',
      url: 'https://noauth.example.com/a2a',
    })

    expect(card.authentication).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 3. SSE event formatting round-trip
// ---------------------------------------------------------------------------

describe('A2A Server — SSE formatting round-trip', () => {
  it('formats and parses TaskStatusUpdate correctly', () => {
    const event: A2aTaskStatusUpdateEvent = {
      type: 'TaskStatusUpdate',
      taskId: 'task-rt-1',
      status: 'working',
      message: makeMessage('Processing your request...', 'agent'),
      final: false,
    }

    const formatted = formatSseEvent(event)

    // Parse the SSE output
    const lines = formatted.split('\n')
    expect(lines[0]).toBe('event: TaskStatusUpdate')

    const dataLine = lines[1]
    expect(dataLine.startsWith('data: ')).toBe(true)

    const parsed = JSON.parse(dataLine.slice(6))
    expect(parsed.type).toBe('TaskStatusUpdate')
    expect(parsed.taskId).toBe('task-rt-1')
    expect(parsed.status).toBe('working')
    expect(parsed.message.role).toBe('agent')
    expect(parsed.message.parts[0].text).toBe('Processing your request...')
    expect(parsed.final).toBe(false)

    // Ends with double newline
    expect(formatted.endsWith('\n\n')).toBe(true)
  })

  it('formats and parses TaskArtifactUpdate correctly', () => {
    const event: A2aTaskArtifactUpdateEvent = {
      type: 'TaskArtifactUpdate',
      taskId: 'task-rt-2',
      artifact: {
        name: 'output.json',
        parts: [{ type: 'data', data: { result: 42, status: 'ok' } }],
      },
    }

    const formatted = formatSseEvent(event)

    const lines = formatted.split('\n')
    expect(lines[0]).toBe('event: TaskArtifactUpdate')

    const parsed = JSON.parse(lines[1].slice(6))
    expect(parsed.type).toBe('TaskArtifactUpdate')
    expect(parsed.taskId).toBe('task-rt-2')
    expect(parsed.artifact.name).toBe('output.json')
    expect(parsed.artifact.parts[0].data).toEqual({ result: 42, status: 'ok' })
  })

  it('produces valid SSE format with event and data lines separated by double newline', () => {
    const event: A2aTaskStatusUpdateEvent = {
      type: 'TaskStatusUpdate',
      taskId: 'task-fmt',
      status: 'completed',
      final: true,
    }

    const formatted = formatSseEvent(event)

    // Should match the exact SSE spec: event line, data line, empty line
    const pattern = /^event: \w+\ndata: .+\n\n$/
    expect(formatted).toMatch(pattern)
  })

  it('round-trips a completed status event with final: true', () => {
    const original: A2aTaskStatusUpdateEvent = {
      type: 'TaskStatusUpdate',
      taskId: 'task-complete',
      status: 'completed',
      message: makeMessage('All done!', 'agent'),
      final: true,
    }

    const formatted = formatSseEvent(original)
    const dataLine = formatted.split('\n')[1]
    const roundTripped = JSON.parse(dataLine.slice(6)) as A2aTaskStatusUpdateEvent

    expect(roundTripped.type).toBe(original.type)
    expect(roundTripped.taskId).toBe(original.taskId)
    expect(roundTripped.status).toBe(original.status)
    expect(roundTripped.final).toBe(original.final)
    expect(roundTripped.message).toEqual(original.message)
  })
})

// ---------------------------------------------------------------------------
// 4. Auth integration
// ---------------------------------------------------------------------------

describe('A2A Server — auth integration', () => {
  function createAuthHandler(validTokens: string[]) {
    const verifyAuth = (authHeader: string | undefined): boolean => {
      if (!authHeader) return false
      const token = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : authHeader
      return validTokens.includes(token)
    }

    return createA2aRequestHandler({
      onSendMessage: vi.fn(async () => makeTask()),
      onGetTask: vi.fn(async () => makeTask()),
      onCancelTask: vi.fn(async () => makeTask({ status: 'canceled' })),
      verifyAuth,
    })
  }

  it('allows requests with a valid Bearer token', async () => {
    const handler = createAuthHandler(['valid-token-123'])

    const res = await handler(
      makeRequest('tasks/get', { taskId: 'task-1' }),
      'Bearer valid-token-123',
    )

    expect(res.error).toBeUndefined()
    expect(res.result).toBeDefined()
  })

  it('allows requests with a valid raw API key', async () => {
    const handler = createAuthHandler(['raw-api-key-456'])

    const res = await handler(
      makeRequest('tasks/get', { taskId: 'task-1' }),
      'raw-api-key-456',
    )

    expect(res.error).toBeUndefined()
    expect(res.result).toBeDefined()
  })

  it('rejects requests with an invalid token', async () => {
    const handler = createAuthHandler(['valid-token-123'])

    const res = await handler(
      makeRequest('tasks/get', { taskId: 'task-1' }),
      'Bearer wrong-token',
    )

    expect(res.error?.code).toBe(-32000)
    expect(res.error?.message).toBe('Unauthorized')
    expect(res.result).toBeUndefined()
  })

  it('rejects requests with no auth header', async () => {
    const handler = createAuthHandler(['valid-token-123'])

    const res = await handler(
      makeRequest('tasks/get', { taskId: 'task-1' }),
    )

    expect(res.error?.code).toBe(-32000)
    expect(res.error?.message).toBe('Unauthorized')
  })

  it('rejects requests with empty auth header', async () => {
    const handler = createAuthHandler(['valid-token-123'])

    const res = await handler(
      makeRequest('tasks/get', { taskId: 'task-1' }),
      '',
    )

    expect(res.error?.code).toBe(-32000)
    expect(res.error?.message).toBe('Unauthorized')
  })

  it('allows different methods when auth passes', async () => {
    const handler = createAuthHandler(['super-secret'])

    // message/send
    const sendRes = await handler(
      makeRequest('message/send', { message: makeMessage('hi') }),
      'Bearer super-secret',
    )
    expect(sendRes.error).toBeUndefined()

    // tasks/get
    const getRes = await handler(
      makeRequest('tasks/get', { taskId: 'task-1' }),
      'Bearer super-secret',
    )
    expect(getRes.error).toBeUndefined()

    // tasks/cancel
    const cancelRes = await handler(
      makeRequest('tasks/cancel', { taskId: 'task-1' }),
      'Bearer super-secret',
    )
    expect(cancelRes.error).toBeUndefined()
  })

  it('blocks all methods when auth fails', async () => {
    const handler = createAuthHandler(['good-key'])

    const sendRes = await handler(
      makeRequest('message/send', { message: makeMessage('hi') }),
      'Bearer bad-key',
    )
    expect(sendRes.error?.code).toBe(-32000)

    const getRes = await handler(
      makeRequest('tasks/get', { taskId: 'task-1' }),
      'Bearer bad-key',
    )
    expect(getRes.error?.code).toBe(-32000)

    const cancelRes = await handler(
      makeRequest('tasks/cancel', { taskId: 'task-1' }),
      'Bearer bad-key',
    )
    expect(cancelRes.error?.code).toBe(-32000)
  })
})
