/**
 * Integration tests for the A2A Client Provider
 *
 * Exercises the full provider lifecycle by mocking global.fetch to simulate
 * an A2A-compliant server. Tests SSE streaming, single JSON responses,
 * error handling, resume, stop/cancel, and message injection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { A2aProvider } from './a2a-provider.js'
import type { AgentSpawnConfig, AgentEvent } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<AgentSpawnConfig>): AgentSpawnConfig {
  return {
    prompt: 'Test prompt',
    cwd: '/tmp/test',
    env: { A2A_AGENT_URL: 'http://test-agent:8080' },
    abortController: new AbortController(),
    autonomous: true,
    sandboxEnabled: false,
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

/** Build an SSE-formatted event string */
function sseEvent(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
}

/** Create a Response that streams SSE events */
function createSSEResponse(events: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event))
      }
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

/** Create a JSON-RPC success response */
function createJsonRpcResponse(id: string, result: unknown): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id, result }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  )
}

/** Create a JSON-RPC error response */
function createJsonRpcErrorResponse(
  id: string,
  code: number,
  message: string,
): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('A2aProvider integration', () => {
  let provider: A2aProvider
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    provider = new A2aProvider()
    mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // 1. Happy path — SSE streaming
  // -------------------------------------------------------------------------

  describe('happy path with SSE streaming', () => {
    it('produces init, assistant_text, and result events from SSE stream', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          sseEvent('TaskStatusUpdate', {
            id: 'task-1',
            sessionId: 'sess-1',
            status: { state: 'submitted' },
          }),
          sseEvent('TaskStatusUpdate', {
            id: 'task-1',
            sessionId: 'sess-1',
            status: {
              state: 'working',
              message: { role: 'agent', parts: [{ type: 'text', text: 'Thinking...' }] },
            },
          }),
          sseEvent('TaskStatusUpdate', {
            id: 'task-1',
            sessionId: 'sess-1',
            status: {
              state: 'completed',
              message: { role: 'agent', parts: [{ type: 'text', text: 'All done!' }] },
            },
            final: true,
          }),
        ]),
      )

      const handle = provider.spawn(makeConfig())
      const events = await collectEvents(handle.stream)

      // init from submitted
      expect(events[0]).toMatchObject({ type: 'init', sessionId: 'sess-1' })

      // assistant_text from working
      const textEvents = events.filter(e => e.type === 'assistant_text')
      expect(textEvents.length).toBeGreaterThanOrEqual(1)
      expect(textEvents[0]).toMatchObject({ type: 'assistant_text', text: 'Thinking...' })

      // result from completed
      const resultEvent = events.find(e => e.type === 'result')
      expect(resultEvent).toMatchObject({ type: 'result', success: true })

      // sessionId is set on the handle
      expect(handle.sessionId).toBe('sess-1')
    })

    it('sends the correct JSON-RPC request', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          sseEvent('TaskStatusUpdate', {
            id: 'task-1',
            sessionId: 'sess-1',
            status: { state: 'submitted' },
          }),
          sseEvent('TaskStatusUpdate', {
            id: 'task-1',
            status: { state: 'completed' },
            final: true,
          }),
        ]),
      )

      const handle = provider.spawn(makeConfig())
      await collectEvents(handle.stream)

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [url, opts] = mockFetch.mock.calls[0]
      expect(url).toBe('http://test-agent:8080/a2a')

      const body = JSON.parse(opts.body)
      expect(body.jsonrpc).toBe('2.0')
      expect(body.method).toBe('message/stream')
      expect(body.params.message).toMatchObject({
        role: 'user',
        parts: [{ type: 'text', text: 'Test prompt' }],
      })
    })
  })

  // -------------------------------------------------------------------------
  // 2. Happy path — single JSON response (non-streaming fallback)
  // -------------------------------------------------------------------------

  describe('happy path with single JSON response', () => {
    it('falls back to message/send and emits init + result', async () => {
      // First call (message/stream) fails
      mockFetch.mockRejectedValueOnce(new Error('Streaming not supported'))

      // Second call (message/send) returns a completed task
      mockFetch.mockResolvedValueOnce(
        createJsonRpcResponse('rpc-1', {
          id: 'task-2',
          sessionId: 'sess-2',
          status: {
            state: 'completed',
            message: { role: 'agent', parts: [{ type: 'text', text: 'Result text' }] },
          },
        }),
      )

      const handle = provider.spawn(makeConfig())
      const events = await collectEvents(handle.stream)

      const initEvent = events.find(e => e.type === 'init')
      expect(initEvent).toMatchObject({ type: 'init', sessionId: 'sess-2' })

      const resultEvent = events.find(e => e.type === 'result')
      expect(resultEvent).toMatchObject({ type: 'result', success: true })

      // Verify two fetch calls: first stream, then send
      expect(mockFetch).toHaveBeenCalledTimes(2)
      const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(firstBody.method).toBe('message/stream')
      const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body)
      expect(secondBody.method).toBe('message/send')
    })
  })

  // -------------------------------------------------------------------------
  // 3. Task with artifacts
  // -------------------------------------------------------------------------

  describe('task with artifacts', () => {
    it('emits assistant_text for artifacts in SSE stream', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          sseEvent('TaskStatusUpdate', {
            id: 'task-3',
            sessionId: 'sess-3',
            status: { state: 'submitted' },
          }),
          sseEvent('TaskStatusUpdate', {
            id: 'task-3',
            status: { state: 'working' },
          }),
          sseEvent('TaskArtifactUpdate', {
            id: 'task-3',
            sessionId: 'sess-3',
            artifact: {
              name: 'report.md',
              parts: [{ type: 'text', text: '# Analysis Report\n\nFindings here.' }],
            },
          }),
          sseEvent('TaskStatusUpdate', {
            id: 'task-3',
            status: { state: 'completed' },
            final: true,
          }),
        ]),
      )

      const handle = provider.spawn(makeConfig())
      const events = await collectEvents(handle.stream)

      const textEvents = events.filter(e => e.type === 'assistant_text')
      const artifactText = textEvents.find(
        e => e.type === 'assistant_text' && e.text.includes('Analysis Report'),
      )
      expect(artifactText).toBeDefined()
      expect(artifactText!.text).toContain('# Analysis Report')
    })

    it('emits artifact text from single JSON response', async () => {
      mockFetch.mockRejectedValueOnce(new Error('no stream'))
      mockFetch.mockResolvedValueOnce(
        createJsonRpcResponse('rpc-1', {
          id: 'task-3b',
          sessionId: 'sess-3b',
          status: { state: 'completed' },
          artifacts: [
            {
              name: 'output.txt',
              parts: [{ type: 'text', text: 'Generated content' }],
            },
          ],
        }),
      )

      const handle = provider.spawn(makeConfig())
      const events = await collectEvents(handle.stream)

      const textEvents = events.filter(e => e.type === 'assistant_text')
      expect(textEvents.some(e => e.type === 'assistant_text' && e.text === 'Generated content')).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // 4. Input-required status
  // -------------------------------------------------------------------------

  describe('input-required status', () => {
    it('emits system event with subtype input_required', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          sseEvent('TaskStatusUpdate', {
            id: 'task-4',
            sessionId: 'sess-4',
            status: { state: 'submitted' },
          }),
          sseEvent('TaskStatusUpdate', {
            id: 'task-4',
            status: { state: 'working' },
          }),
          sseEvent('TaskStatusUpdate', {
            id: 'task-4',
            status: {
              state: 'input-required',
              message: {
                role: 'agent',
                parts: [{ type: 'text', text: 'Please provide the API key' }],
              },
            },
          }),
        ]),
      )

      const handle = provider.spawn(makeConfig())
      const events = await collectEvents(handle.stream)

      const inputEvent = events.find(
        e => e.type === 'system' && 'subtype' in e && e.subtype === 'input_required',
      )
      expect(inputEvent).toBeDefined()
      expect(inputEvent).toMatchObject({
        type: 'system',
        subtype: 'input_required',
        message: 'Please provide the API key',
      })
    })
  })

  // -------------------------------------------------------------------------
  // 5. Task failure
  // -------------------------------------------------------------------------

  describe('task failure', () => {
    it('emits result with success: false on failed status', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          sseEvent('TaskStatusUpdate', {
            id: 'task-5',
            sessionId: 'sess-5',
            status: { state: 'submitted' },
          }),
          sseEvent('TaskStatusUpdate', {
            id: 'task-5',
            status: {
              state: 'failed',
              message: {
                role: 'agent',
                parts: [{ type: 'text', text: 'Out of memory' }],
              },
            },
            final: true,
          }),
        ]),
      )

      const handle = provider.spawn(makeConfig())
      const events = await collectEvents(handle.stream)

      const resultEvent = events.find(e => e.type === 'result')
      expect(resultEvent).toMatchObject({
        type: 'result',
        success: false,
        errors: ['Out of memory'],
        errorSubtype: 'task_failed',
      })
    })
  })

  // -------------------------------------------------------------------------
  // 6. Task cancellation
  // -------------------------------------------------------------------------

  describe('task cancellation', () => {
    it('emits result with errorSubtype canceled', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          sseEvent('TaskStatusUpdate', {
            id: 'task-6',
            sessionId: 'sess-6',
            status: { state: 'submitted' },
          }),
          sseEvent('TaskStatusUpdate', {
            id: 'task-6',
            status: {
              state: 'canceled',
              message: {
                role: 'agent',
                parts: [{ type: 'text', text: 'Task was canceled by user' }],
              },
            },
            final: true,
          }),
        ]),
      )

      const handle = provider.spawn(makeConfig())
      const events = await collectEvents(handle.stream)

      const resultEvent = events.find(e => e.type === 'result')
      expect(resultEvent).toMatchObject({
        type: 'result',
        success: false,
        errorSubtype: 'canceled',
        errors: ['Task was canceled by user'],
      })
    })
  })

  // -------------------------------------------------------------------------
  // 7. Missing A2A_AGENT_URL
  // -------------------------------------------------------------------------

  describe('missing A2A_AGENT_URL', () => {
    it('emits error and result with configuration_error when no URL configured', async () => {
      const config = makeConfig({ env: {} })
      const handle = provider.spawn(config)
      const events = await collectEvents(handle.stream)

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

      // fetch should never be called
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // 8. Network error
  // -------------------------------------------------------------------------

  describe('network error', () => {
    it('emits error and connection_error when both stream and send fail', async () => {
      // Both message/stream and message/send throw
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))

      const handle = provider.spawn(makeConfig())
      const events = await collectEvents(handle.stream)

      const errorEvent = events.find(e => e.type === 'error')
      expect(errorEvent).toMatchObject({
        type: 'error',
        message: expect.stringContaining('ECONNREFUSED'),
      })

      const resultEvent = events.find(e => e.type === 'result')
      expect(resultEvent).toMatchObject({
        type: 'result',
        success: false,
        errorSubtype: 'connection_error',
      })
    })
  })

  // -------------------------------------------------------------------------
  // 9. JSON-RPC error response
  // -------------------------------------------------------------------------

  describe('JSON-RPC error response', () => {
    it('emits error event with jsonrpc_error subtype', async () => {
      // message/stream fails, message/send returns JSON-RPC error
      mockFetch.mockRejectedValueOnce(new Error('no stream'))
      mockFetch.mockResolvedValueOnce(
        createJsonRpcErrorResponse('rpc-1', -32603, 'Internal error: agent crashed'),
      )

      const handle = provider.spawn(makeConfig())
      const events = await collectEvents(handle.stream)

      const errorEvent = events.find(e => e.type === 'error')
      expect(errorEvent).toMatchObject({
        type: 'error',
        message: 'Internal error: agent crashed',
      })

      const resultEvent = events.find(e => e.type === 'result')
      expect(resultEvent).toMatchObject({
        type: 'result',
        success: false,
        errorSubtype: 'jsonrpc_error',
        errors: ['Internal error: agent crashed'],
      })
    })
  })

  // -------------------------------------------------------------------------
  // 10. Resume session
  // -------------------------------------------------------------------------

  describe('resume session', () => {
    it('includes sessionId in JSON-RPC params', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          sseEvent('TaskStatusUpdate', {
            id: 'task-prev',
            sessionId: 'task-previous',
            status: { state: 'submitted' },
          }),
          sseEvent('TaskStatusUpdate', {
            id: 'task-prev',
            status: { state: 'completed' },
            final: true,
          }),
        ]),
      )

      const handle = provider.resume('task-previous', makeConfig())
      await collectEvents(handle.stream)

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.params.sessionId).toBe('task-previous')

      // Handle should have sessionId set before streaming
      expect(handle.sessionId).toBe('task-previous')
    })
  })

  // -------------------------------------------------------------------------
  // 11. Stop / cancel
  // -------------------------------------------------------------------------

  describe('stop / cancel', () => {
    it('sends tasks/cancel when stop() is called after init', async () => {
      // Use a stream that stays open so we can call stop() mid-stream
      let streamController: ReadableStreamDefaultController<Uint8Array>
      const encoder = new TextEncoder()
      const readableStream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller
          // Immediately emit submitted + working
          controller.enqueue(
            encoder.encode(
              sseEvent('TaskStatusUpdate', {
                id: 'task-stop',
                sessionId: 'sess-stop',
                status: { state: 'submitted' },
              }),
            ),
          )
          controller.enqueue(
            encoder.encode(
              sseEvent('TaskStatusUpdate', {
                id: 'task-stop',
                status: { state: 'working' },
              }),
            ),
          )
        },
      })

      const sseResponse = new Response(readableStream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })

      // First call returns the SSE stream
      mockFetch.mockResolvedValueOnce(sseResponse)
      // Second call is the cancel request
      mockFetch.mockResolvedValueOnce(
        createJsonRpcResponse('rpc-cancel', {
          id: 'task-stop',
          status: { state: 'canceled' },
        }),
      )

      const handle = provider.spawn(makeConfig())

      // Collect events asynchronously — will resolve once the stream closes
      const eventsPromise = collectEvents(handle.stream)

      // Give the stream a moment to emit the initial events
      await new Promise(resolve => setTimeout(resolve, 50))

      // Call stop — this should send a cancel request and abort
      await handle.stop()

      // Close the stream controller so the reader finishes
      try {
        streamController!.close()
      } catch {
        // Already closed by abort — that's fine
      }

      const events = await eventsPromise

      // Should have an init event at minimum
      const initEvent = events.find(e => e.type === 'init')
      expect(initEvent).toBeDefined()

      // Verify cancel request was made (second fetch call)
      const cancelCall = mockFetch.mock.calls.find((call) => {
        try {
          const body = JSON.parse(call[1].body)
          return body.method === 'tasks/cancel'
        } catch {
          return false
        }
      })
      expect(cancelCall).toBeDefined()
      const cancelBody = JSON.parse(cancelCall![1].body)
      expect(cancelBody.params.id).toBe('task-stop')
    })
  })

  // -------------------------------------------------------------------------
  // 12. InjectMessage
  // -------------------------------------------------------------------------

  describe('injectMessage', () => {
    it('sends a follow-up message/send request', async () => {
      // Set up SSE stream that emits submitted + input-required
      let streamController: ReadableStreamDefaultController<Uint8Array>
      const encoder = new TextEncoder()
      const readableStream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller
          controller.enqueue(
            encoder.encode(
              sseEvent('TaskStatusUpdate', {
                id: 'task-inject',
                sessionId: 'sess-inject',
                status: { state: 'submitted' },
              }),
            ),
          )
          controller.enqueue(
            encoder.encode(
              sseEvent('TaskStatusUpdate', {
                id: 'task-inject',
                status: {
                  state: 'input-required',
                  message: { role: 'agent', parts: [{ type: 'text', text: 'Need more info' }] },
                },
              }),
            ),
          )
        },
      })

      const sseResponse = new Response(readableStream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })

      // First call: SSE stream
      mockFetch.mockResolvedValueOnce(sseResponse)

      // Second call: injectMessage response
      mockFetch.mockResolvedValueOnce(
        createJsonRpcResponse('rpc-inject', {
          id: 'task-inject',
          sessionId: 'sess-inject',
          status: { state: 'working' },
        }),
      )

      const config = makeConfig()
      const handle = provider.spawn(config)

      // Start consuming the stream in the background
      const eventsPromise = collectEvents(handle.stream)

      // Wait for events to arrive
      await new Promise(resolve => setTimeout(resolve, 50))

      // Inject a follow-up message
      await handle.injectMessage('Here is the additional info')

      // Verify injectMessage was sent as message/send
      const injectCall = mockFetch.mock.calls.find((call) => {
        try {
          const body = JSON.parse(call[1].body)
          return body.method === 'message/send' && body.params?.message?.parts?.[0]?.text === 'Here is the additional info'
        } catch {
          return false
        }
      })
      expect(injectCall).toBeDefined()

      const injectBody = JSON.parse(injectCall![1].body)
      expect(injectBody.params.message).toMatchObject({
        role: 'user',
        parts: [{ type: 'text', text: 'Here is the additional info' }],
      })
      // Should include sessionId from the stream
      expect(injectBody.params.sessionId).toBe('sess-inject')

      // Clean up: close the stream and abort
      try {
        streamController!.close()
      } catch {
        // Already closed
      }
      config.abortController.abort()
      await eventsPromise.catch(() => {})
    })
  })

  // -------------------------------------------------------------------------
  // Additional: Auth headers
  // -------------------------------------------------------------------------

  describe('auth headers', () => {
    it('sends x-api-key header when A2A_API_KEY is set', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          sseEvent('TaskStatusUpdate', {
            id: 'task-auth',
            sessionId: 'sess-auth',
            status: { state: 'submitted' },
          }),
          sseEvent('TaskStatusUpdate', {
            id: 'task-auth',
            status: { state: 'completed' },
            final: true,
          }),
        ]),
      )

      const config = makeConfig({
        env: {
          A2A_AGENT_URL: 'http://test-agent:8080',
          A2A_API_KEY: 'test-key-123',
        },
      })
      const handle = provider.spawn(config)
      await collectEvents(handle.stream)

      const headers = mockFetch.mock.calls[0][1].headers
      expect(headers['x-api-key']).toBe('test-key-123')
    })

    it('sends Authorization Bearer header when A2A_BEARER_TOKEN is set', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          sseEvent('TaskStatusUpdate', {
            id: 'task-bearer',
            sessionId: 'sess-bearer',
            status: { state: 'submitted' },
          }),
          sseEvent('TaskStatusUpdate', {
            id: 'task-bearer',
            status: { state: 'completed' },
            final: true,
          }),
        ]),
      )

      const config = makeConfig({
        env: {
          A2A_AGENT_URL: 'http://test-agent:8080',
          A2A_BEARER_TOKEN: 'my-bearer-token',
        },
      })
      const handle = provider.spawn(config)
      await collectEvents(handle.stream)

      const headers = mockFetch.mock.calls[0][1].headers
      expect(headers['Authorization']).toBe('Bearer my-bearer-token')
    })
  })

  // -------------------------------------------------------------------------
  // Additional: Work-type URL resolution
  // -------------------------------------------------------------------------

  describe('work-type-specific URL resolution', () => {
    it('uses A2A_AGENT_URL_RESEARCH when present', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          sseEvent('TaskStatusUpdate', {
            id: 'task-wt',
            sessionId: 'sess-wt',
            status: { state: 'submitted' },
          }),
          sseEvent('TaskStatusUpdate', {
            id: 'task-wt',
            status: { state: 'completed' },
            final: true,
          }),
        ]),
      )

      const config = makeConfig({
        env: {
          A2A_AGENT_URL_RESEARCH: 'http://research-agent:9090',
        },
      })
      const handle = provider.spawn(config)
      await collectEvents(handle.stream)

      const url = mockFetch.mock.calls[0][0]
      expect(url).toBe('http://research-agent:9090/a2a')
    })
  })

  // -------------------------------------------------------------------------
  // Additional: createProvider factory
  // -------------------------------------------------------------------------

  describe('createProvider integration', () => {
    it('creates A2aProvider via factory', async () => {
      const { createProvider } = await import('./index.js')
      const p = createProvider('a2a')
      expect(p.name).toBe('a2a')
    })
  })
})
