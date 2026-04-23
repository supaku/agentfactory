/**
 * Integration tests for the Codex App Server Provider
 *
 * Exercises the full AppServerAgentHandle lifecycle by mocking the
 * `codex app-server` child process. Unlike the unit tests which test individual
 * functions in isolation, these tests verify the end-to-end flow:
 *   process start -> handshake -> thread creation -> turn execution
 *   -> notification streaming -> event mapping -> message injection -> shutdown
 *
 * Uses a MockAppServer helper that captures JSON-RPC stdin writes and pushes
 * fake stdout lines (responses + notifications) to exercise the real code path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import type { AgentSpawnConfig, AgentEvent } from './types.js'

// ---------------------------------------------------------------------------
// Mock child_process and readline BEFORE importing the module under test
// ---------------------------------------------------------------------------

/** Fake writable stdin stream */
function createMockStdin() {
  return {
    writable: true,
    write: vi.fn(),
    end: vi.fn(),
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
  proc.pid = 99999
  proc.killed = false
  proc.kill = vi.fn((signal?: string) => {
    if (signal === 'SIGKILL') {
      proc.killed = true
    }
    if (signal === 'SIGTERM') {
      // Simulate graceful exit
      setTimeout(() => proc.emit('exit', 0, 'SIGTERM'), 0)
    }
  })
  return proc
}

let mockProc: ReturnType<typeof createMockChildProcess>
let mockLineEmitter: EventEmitter

vi.mock('child_process', () => ({
  spawn: vi.fn(() => mockProc),
  // CodexProvider.probeAppServerAvailable() uses execFileSync to check
  // whether the codex binary supports `app-server --help`. The integration
  // test suite mocks the app-server process with mockProc, so we simulate a
  // successful probe (returns empty stdout). Tests that need a failing probe
  // can override via mockImplementation on the imported spy.
  execFileSync: vi.fn(() => Buffer.from('')),
}))

vi.mock('readline', () => ({
  createInterface: vi.fn(() => {
    mockLineEmitter = new EventEmitter()
    ;(mockLineEmitter as any).close = vi.fn()
    return mockLineEmitter
  }),
}))

// ---------------------------------------------------------------------------
// MockAppServer — reusable test helper
// ---------------------------------------------------------------------------

/**
 * Methods that should be auto-responded to immediately when received as
 * JSON-RPC requests. The mock sends back `{ id, result: {} }` automatically.
 */
const AUTO_RESPOND_METHODS = new Set([
  'turn/interrupt',
  'thread/unsubscribe',
  'turn/steer',
  'model/list',
])

/**
 * MockAppServer wraps the mocked child_process to provide a high-level API
 * for integration tests. It captures JSON-RPC requests written to stdin,
 * can push responses/notifications to the fake stdout, and auto-responds
 * to certain housekeeping requests (turn/interrupt, thread/unsubscribe, turn/steer)
 * so that tests don't hang waiting for responses.
 */
class MockAppServer {
  /** All JSON-RPC messages written to stdin, parsed */
  readonly requests: Array<{ method: string; id?: number; params?: Record<string, unknown> }> = []
  private proc: ReturnType<typeof createMockChildProcess>

  constructor(proc: ReturnType<typeof createMockChildProcess>) {
    this.proc = proc
    // Intercept stdin writes to capture requests and auto-respond to housekeeping
    this.proc.stdin.write = vi.fn((data: string) => {
      try {
        const parsed = JSON.parse(data.trim())
        this.requests.push(parsed)

        // Auto-respond to housekeeping requests so stop()/steer don't hang
        if (parsed.id && parsed.method && AUTO_RESPOND_METHODS.has(parsed.method)) {
          // Use queueMicrotask so the response arrives after the write completes
          queueMicrotask(() => {
            this.pushResponse(parsed.id, {})
          })
        }
      } catch {
        // Non-JSON data — ignore
      }
    }) as any
  }

  /** Wait until N requests have been captured */
  async waitForRequests(count: number, timeoutMs = 3000): Promise<void> {
    await vi.waitFor(() => {
      expect(this.requests.length).toBeGreaterThanOrEqual(count)
    }, { timeout: timeoutMs })
  }

  /** Get all requests with a specific method */
  requestsByMethod(method: string) {
    return this.requests.filter((r) => r.method === method)
  }

  /** Get the last request with a specific method */
  lastRequestByMethod(method: string) {
    const matches = this.requestsByMethod(method)
    return matches[matches.length - 1]
  }

  /** Push a JSON-RPC response to the mock stdout (readline line event) */
  pushResponse(id: number, result: unknown): void {
    mockLineEmitter.emit('line', JSON.stringify({ id, result }))
  }

  /** Push a JSON-RPC error response */
  pushErrorResponse(id: number, code: number, message: string): void {
    mockLineEmitter.emit('line', JSON.stringify({ id, error: { code, message } }))
  }

  /** Push a JSON-RPC notification (no id) */
  pushNotification(method: string, params: Record<string, unknown>): void {
    mockLineEmitter.emit('line', JSON.stringify({ method, params }))
  }

  /**
   * Complete the initialize handshake automatically.
   * Waits for the `initialize` request, sends back a success response,
   * then waits for the `initialized` notification.
   */
  async completeHandshake(): Promise<void> {
    // Wait for initialize request (id=1)
    await this.waitForRequests(1)
    const initReq = this.requests[0]
    expect(initReq?.method).toBe('initialize')
    this.pushResponse(initReq!.id!, { capabilities: {} })

    // Wait for the `initialized` notification + model/list request (auto-responded)
    await this.waitForRequests(3)
    expect(this.requests[1]?.method).toBe('initialized')
    expect(this.requests[2]?.method).toBe('model/list')
  }

  /**
   * Complete the handshake + respond to thread/start + turn/start.
   * Returns the threadId used.
   */
  async completeHandshakeAndThreadStart(threadId = 'thr_integ_001'): Promise<string> {
    await this.completeHandshake()

    // Wait for thread/start request
    await this.waitForRequests(4)
    const threadStartReq = this.requests[3]
    expect(threadStartReq?.method).toBe('thread/start')
    this.pushResponse(threadStartReq!.id!, { thread: { id: threadId } })

    // Wait for turn/start request
    await this.waitForRequests(5)
    expect(this.requests[4]?.method).toBe('turn/start')
    this.pushResponse(this.requests[4]!.id!, {})

    return threadId
  }

  /**
   * Complete the handshake + respond to thread/resume + turn/start.
   * Returns the threadId used.
   */
  async completeHandshakeAndThreadResume(threadId: string): Promise<string> {
    await this.completeHandshake()

    // Wait for thread/resume request
    await this.waitForRequests(4)
    const threadResumeReq = this.requests[3]
    expect(threadResumeReq?.method).toBe('thread/resume')
    this.pushResponse(threadResumeReq!.id!, { thread: { id: threadId } })

    // Wait for turn/start request
    await this.waitForRequests(5)
    expect(this.requests[4]?.method).toBe('turn/start')
    this.pushResponse(this.requests[4]!.id!, {})

    return threadId
  }

  /** Push a turn/started notification */
  pushTurnStarted(threadId: string, turnId: string): void {
    this.pushNotification('turn/started', {
      threadId,
      turn: { id: turnId },
    })
  }

  /** Push an item/agentMessage/delta notification */
  pushAgentMessageDelta(threadId: string, text: string): void {
    this.pushNotification('item/agentMessage/delta', { threadId, text })
  }

  /** Push an item/started notification */
  pushItemStarted(threadId: string, item: Record<string, unknown>): void {
    this.pushNotification('item/started', { threadId, item })
  }

  /** Push an item/completed notification */
  pushItemCompleted(threadId: string, item: Record<string, unknown>): void {
    this.pushNotification('item/completed', { threadId, item })
  }

  /** Push a turn/completed notification */
  pushTurnCompleted(
    threadId: string,
    turnId: string,
    options: {
      status?: string
      usage?: { input_tokens?: number; output_tokens?: number }
      error?: { message?: string; codexErrorInfo?: string }
    } = {},
  ): void {
    const turn: Record<string, unknown> = {
      id: turnId,
      status: options.status ?? 'completed',
    }
    if (options.usage) turn.usage = options.usage
    if (options.error) turn.error = options.error
    this.pushNotification('turn/completed', { threadId, turn })
  }

  /** Simulate the process exiting */
  emitExit(code: number | null, signal: string | null = null): void {
    this.proc.emit('exit', code, signal)
  }

  /** Simulate a process error */
  emitError(err: Error): void {
    this.proc.emit('error', err)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<AgentSpawnConfig>): AgentSpawnConfig {
  return {
    prompt: 'Implement the feature',
    cwd: '/project/workspace',
    env: {},
    abortController: new AbortController(),
    autonomous: true,
    sandboxEnabled: false,
    ...overrides,
  }
}

async function collectEvents(
  stream: AsyncIterable<AgentEvent>,
  maxEvents = 100,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of stream) {
    events.push(event)
    if (events.length >= maxEvents) break
  }
  return events
}

/** Collect events with a timeout — prevents hanging on infinite streams */
async function collectEventsWithTimeout(
  stream: AsyncIterable<AgentEvent>,
  timeoutMs = 2000,
  maxEvents = 100,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  const iter = stream[Symbol.asyncIterator]()

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && events.length < maxEvents) {
    const result = await Promise.race([
      iter.next(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), Math.max(0, deadline - Date.now())),
      ),
    ])
    if (result.done) break
    events.push(result.value as AgentEvent)
  }

  return events
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CodexAppServerProvider integration', () => {
  let CodexAppServerProvider: typeof import('./codex-app-server-provider.js').CodexAppServerProvider
  let mock: MockAppServer

  beforeEach(async () => {
    vi.clearAllMocks()
    mockProc = createMockChildProcess()
    const mod = await import('./codex-app-server-provider.js')
    CodexAppServerProvider = mod.CodexAppServerProvider
    mock = new MockAppServer(mockProc)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // -------------------------------------------------------------------------
  // 1. Happy Path — Full Session Lifecycle
  // -------------------------------------------------------------------------

  describe('1. Happy Path — Full Session Lifecycle', () => {
    it('exercises spawn -> handshake -> thread/start -> turn/start -> notifications -> stop -> result', async () => {
      const provider = new CodexAppServerProvider()
      const config = makeConfig()
      const handle = provider.spawn(config)

      // Start consuming the stream
      const eventsPromise = collectEventsWithTimeout(handle.stream, 5000)

      // Complete handshake and thread start
      const threadId = await mock.completeHandshakeAndThreadStart('thr_happy_001')

      // Push notification sequence
      mock.pushTurnStarted(threadId, 'turn_001')
      mock.pushAgentMessageDelta(threadId, 'Analyzing the codebase...')
      mock.pushItemStarted(threadId, {
        id: 'cmd_001', type: 'commandExecution', command: 'ls -la',
      })
      mock.pushItemCompleted(threadId, {
        id: 'cmd_001', type: 'commandExecution', command: 'ls -la',
        text: 'total 16\ndrwxr-xr-x  4 user  staff  128 Jan  1 00:00 .',
        exitCode: 0, status: 'completed',
      })
      mock.pushTurnCompleted(threadId, 'turn_001', {
        status: 'completed',
        usage: { input_tokens: 500, output_tokens: 150 },
      })

      // Give time for events to be processed
      await new Promise((r) => setTimeout(r, 100))

      // Stop the handle to end the stream
      await handle.stop()

      const events = await eventsPromise

      // Verify event sequence
      const eventTypes = events.map((e) => e.type)

      // Should have init from thread/start response
      expect(eventTypes).toContain('init')
      const initEvent = events.find((e) => e.type === 'init')
      expect(initEvent).toMatchObject({ type: 'init', sessionId: threadId })

      // Should have system turn_started
      const turnStarted = events.find(
        (e) => e.type === 'system' && 'subtype' in e && e.subtype === 'turn_started',
      )
      expect(turnStarted).toBeDefined()

      // Should have assistant_text
      const textEvent = events.find((e) => e.type === 'assistant_text')
      expect(textEvent).toMatchObject({ type: 'assistant_text', text: 'Analyzing the codebase...' })

      // Should have tool_use and tool_result for command execution
      const toolUse = events.find((e) => e.type === 'tool_use')
      expect(toolUse).toMatchObject({
        type: 'tool_use',
        toolName: 'shell',
        toolUseId: 'cmd_001',
        input: { command: 'ls -la' },
      })
      const toolResult = events.find((e) => e.type === 'tool_result')
      expect(toolResult).toMatchObject({
        type: 'tool_result',
        toolName: 'shell',
        toolUseId: 'cmd_001',
        isError: false,
      })

      // In autonomous mode, turn/completed emits a real result event directly
      // (stream ends without needing stop()). No turn_result system event.
      const resultEvent = events.find((e) => e.type === 'result')
      expect(resultEvent).toMatchObject({
        type: 'result',
        success: true,
        cost: {
          inputTokens: 500,
          outputTokens: 150,
          numTurns: 1,
        },
      })

      // Regression: autonomous-mode sessions must emit EXACTLY ONE result event.
      // Prior bug double-emitted (once from turn/completed, once from stream-end
      // synthesizer) which surfaced as a duplicate "Agent completed" log line.
      const resultEvents = events.filter((e) => e.type === 'result')
      expect(resultEvents).toHaveLength(1)

      // Verify JSON-RPC requests sent to stdin
      expect(mock.requestsByMethod('thread/start')).toHaveLength(1)
      const threadStartReq = mock.lastRequestByMethod('thread/start')!
      expect(threadStartReq.params).toMatchObject({
        cwd: '/project/workspace',
        approvalPolicy: 'on-request',
      })

      expect(mock.requestsByMethod('turn/start')).toHaveLength(1)
      const turnStartReq = mock.lastRequestByMethod('turn/start')!
      expect(turnStartReq.params?.input).toEqual([{ type: 'text', text: 'Implement the feature' }])

      // stop() should have sent turn/interrupt and thread/unsubscribe
      expect(mock.requestsByMethod('turn/interrupt').length).toBeGreaterThanOrEqual(1)
      expect(mock.requestsByMethod('thread/unsubscribe').length).toBeGreaterThanOrEqual(1)
    })
  })

  // -------------------------------------------------------------------------
  // 2. Message Injection — Mid-Turn Steering
  // -------------------------------------------------------------------------

  describe('2. Message Injection — Mid-Turn Steering', () => {
    it('calls turn/steer when injectMessage() is called during an active turn', async () => {
      const provider = new CodexAppServerProvider()
      const handle = provider.spawn(makeConfig())

      const eventsPromise = collectEventsWithTimeout(handle.stream, 5000)

      const threadId = await mock.completeHandshakeAndThreadStart('thr_steer_001')

      // Push turn/started so activeTurnId is set
      mock.pushTurnStarted(threadId, 'turn_steer_1')

      // Wait for the turn/started event to be processed
      await new Promise((r) => setTimeout(r, 100))

      // Inject a message mid-turn — turn/steer is auto-responded
      await handle.injectMessage('additional context for the current task')

      const steerReq = mock.lastRequestByMethod('turn/steer')
      expect(steerReq).toBeDefined()
      expect(steerReq!.params).toMatchObject({
        threadId: 'thr_steer_001',
        expectedTurnId: 'turn_steer_1',
        input: [{ type: 'text', text: 'additional context for the current task' }],
      })

      // Cleanup — turn/interrupt and thread/unsubscribe are auto-responded
      await handle.stop()
      await eventsPromise
    })
  })

  // -------------------------------------------------------------------------
  // 3. Message Injection — Between-Turn New Turn
  // -------------------------------------------------------------------------

  describe('3. Message Injection — Between-Turn New Turn', () => {
    it('starts a new turn via turn/start when injectMessage() is called after turn completion', async () => {
      const provider = new CodexAppServerProvider()
      const handle = provider.spawn(makeConfig({ autonomous: false }))

      const eventsPromise = collectEventsWithTimeout(handle.stream, 5000)

      const threadId = await mock.completeHandshakeAndThreadStart('thr_inject_001')

      // Complete the first turn
      mock.pushTurnStarted(threadId, 'turn_first')
      mock.pushTurnCompleted(threadId, 'turn_first', {
        status: 'completed',
        usage: { input_tokens: 100, output_tokens: 50 },
      })

      // Wait for turn completion to be processed
      await new Promise((r) => setTimeout(r, 100))

      // Inject a message between turns — should start a new turn.
      // injectMessage calls startNewTurn which calls processManager.request('turn/start', ...)
      // We need to respond to this. Since 'turn/start' is NOT auto-responded, we set up
      // a waiter to respond to it as soon as it arrives.
      const requestCountBefore = mock.requests.length

      // Start injectMessage (it will block until turn/start is responded to)
      const injectPromise = handle.injectMessage('follow-up question')

      // Wait for the new turn/start request to appear
      await mock.waitForRequests(requestCountBefore + 1)

      const newTurnReqs = mock.requestsByMethod('turn/start')
      // Should have two turn/start requests total (initial + injected)
      expect(newTurnReqs.length).toBe(2)

      const secondTurnReq = newTurnReqs[1]!
      expect(secondTurnReq.params).toMatchObject({
        threadId: 'thr_inject_001',
        input: [{ type: 'text', text: 'follow-up question' }],
        cwd: '/project/workspace',
        approvalPolicy: 'untrusted',
      })

      // Respond to the new turn/start
      mock.pushResponse(secondTurnReq.id!, {})
      await injectPromise

      // Mock pushes new turn sequence
      mock.pushTurnStarted(threadId, 'turn_second')
      mock.pushAgentMessageDelta(threadId, 'Addressing follow-up...')
      mock.pushTurnCompleted(threadId, 'turn_second', {
        status: 'completed',
        usage: { input_tokens: 200, output_tokens: 80 },
      })

      // Wait for events
      await new Promise((r) => setTimeout(r, 100))

      await handle.stop()
      const events = await eventsPromise

      // Verify new turn events appear
      const textEvents = events.filter((e) => e.type === 'assistant_text')
      expect(textEvents.some((e) => e.type === 'assistant_text' && e.text === 'Addressing follow-up...')).toBe(true)

      // Verify accumulated tokens in the final result
      const resultEvent = events.find((e) => e.type === 'result')
      expect(resultEvent).toMatchObject({
        type: 'result',
        success: true,
        cost: {
          inputTokens: 300, // 100 + 200
          outputTokens: 130, // 50 + 80
          numTurns: 2,
        },
      })
    })
  })

  // -------------------------------------------------------------------------
  // 4. Session Resume
  // -------------------------------------------------------------------------

  describe('4. Session Resume', () => {
    it('sends thread/resume (not thread/start) when provider.resume() is called', async () => {
      const provider = new CodexAppServerProvider()
      const handle = provider.resume('thr_existing_session', makeConfig())

      const eventsPromise = collectEventsWithTimeout(handle.stream, 5000)

      // Complete handshake and thread/resume
      await mock.completeHandshake()

      // Wait for thread/resume request (after initialize, initialized, model/list)
      await mock.waitForRequests(4)
      const threadResumeReq = mock.requests[3]
      expect(threadResumeReq?.method).toBe('thread/resume')
      expect(threadResumeReq?.params?.threadId).toBe('thr_existing_session')

      // Respond to thread/resume
      mock.pushResponse(threadResumeReq!.id!, { thread: { id: 'thr_existing_session' } })

      // Wait for turn/start
      await mock.waitForRequests(5)
      expect(mock.requests[4]?.method).toBe('turn/start')
      mock.pushResponse(mock.requests[4]!.id!, {})

      // Push some notifications and stop
      mock.pushTurnStarted('thr_existing_session', 'turn_resume_1')
      mock.pushTurnCompleted('thr_existing_session', 'turn_resume_1', { status: 'completed' })

      await new Promise((r) => setTimeout(r, 100))
      await handle.stop()

      const events = await eventsPromise

      // Verify init event has the resumed session ID
      const initEvent = events.find((e) => e.type === 'init')
      expect(initEvent).toMatchObject({ type: 'init', sessionId: 'thr_existing_session' })

      // Verify no thread/start was sent
      expect(mock.requestsByMethod('thread/start')).toHaveLength(0)
      expect(mock.requestsByMethod('thread/resume')).toHaveLength(1)
    })
  })

  // -------------------------------------------------------------------------
  // 5. Error Handling — Turn Failure
  // -------------------------------------------------------------------------

  describe('5. Error Handling — Turn Failure', () => {
    it('emits result event with failure info when turn/completed has status failed (autonomous)', async () => {
      const provider = new CodexAppServerProvider()
      const handle = provider.spawn(makeConfig())

      const eventsPromise = collectEventsWithTimeout(handle.stream, 5000)

      const threadId = await mock.completeHandshakeAndThreadStart('thr_fail_001')

      // Push a failed turn
      mock.pushTurnStarted(threadId, 'turn_fail_1')
      mock.pushTurnCompleted(threadId, 'turn_fail_1', {
        status: 'failed',
        error: { message: 'Context window exceeded', codexErrorInfo: 'ContextWindowExceeded' },
      })

      await new Promise((r) => setTimeout(r, 100))

      const events = await eventsPromise

      // In autonomous mode, turn failure emits a direct result event
      const resultEvent = events.find((e) => e.type === 'result')
      expect(resultEvent).toMatchObject({
        type: 'result',
        success: false,
        errors: ['Context window exceeded'],
      })
    })
  })

  // -------------------------------------------------------------------------
  // 6. Error Handling — Process Crash
  // -------------------------------------------------------------------------

  describe('6. Error Handling — Process Crash', () => {
    it('emits error and result events when the process exits unexpectedly', async () => {
      const provider = new CodexAppServerProvider()
      const handle = provider.spawn(makeConfig())

      const eventsPromise = collectEventsWithTimeout(handle.stream, 5000)

      // Complete handshake
      await mock.completeHandshake()

      // Wait for thread/start request
      await mock.waitForRequests(3)

      // Simulate process crash before thread/start can be responded to
      mockProc.emit('exit', 1, null)

      const events = await eventsPromise

      // Should have an error event from the crashed process
      const errorEvent = events.find((e) => e.type === 'error')
      expect(errorEvent).toBeDefined()
      expect(errorEvent).toMatchObject({
        type: 'error',
        message: expect.stringContaining('App Server error'),
      })

      // Should have a result event indicating failure
      const resultEvent = events.find((e) => e.type === 'result')
      expect(resultEvent).toMatchObject({
        type: 'result',
        success: false,
      })
    })
  })

  // -------------------------------------------------------------------------
  // 7. Error Handling — Request Timeout
  // -------------------------------------------------------------------------

  describe('7. Error Handling — Request Timeout', () => {
    it('emits error events when thread/start request times out', async () => {
      vi.useFakeTimers()

      const provider = new CodexAppServerProvider()
      const handle = provider.spawn(makeConfig())

      const eventsPromise = collectEvents(handle.stream)

      // Complete handshake
      await mock.waitForRequests(1)
      mock.pushResponse(mock.requests[0]!.id!, { capabilities: {} })
      // model/list is auto-responded
      await mock.waitForRequests(3)

      // Wait for thread/start request — but never respond
      await mock.waitForRequests(4)
      expect(mock.requests[3]?.method).toBe('thread/start')

      // Advance past the timeout (default 30s)
      vi.advanceTimersByTime(31000)

      const events = await eventsPromise

      vi.useRealTimers()

      // Should have error event from timeout
      const errorEvent = events.find((e) => e.type === 'error')
      expect(errorEvent).toBeDefined()
      expect(errorEvent).toMatchObject({
        type: 'error',
        message: expect.stringContaining('timed out'),
      })

      // Should have result indicating failure
      const resultEvent = events.find((e) => e.type === 'result')
      expect(resultEvent).toMatchObject({
        type: 'result',
        success: false,
        errorSubtype: 'app_server_error',
      })
    })
  })

  // -------------------------------------------------------------------------
  // 8. Approval Bridge Mapping
  // -------------------------------------------------------------------------

  describe('8. Approval Bridge Mapping', () => {
    /**
     * Helper to drive the stream far enough that thread/start is written,
     * then return the parsed request params.
     */
    async function getThreadStartParams(handle: import('./types.js').AgentHandle) {
      const iter = handle.stream[Symbol.asyncIterator]()

      // Kick off the generator
      const firstNext = iter.next()

      // Complete the handshake
      await mock.waitForRequests(1)
      mock.pushResponse(mock.requests[0]!.id!, { capabilities: {} })
      // model/list is auto-responded
      await mock.waitForRequests(3)

      // Wait for thread/start
      await mock.waitForRequests(4)
      const threadStartReq = mock.requests[3]
      expect(threadStartReq?.method).toBe('thread/start')

      // Clean up (don't wait — just prevent unhandled rejection)
      firstNext.catch(() => {})

      return threadStartReq!.params!
    }

    it('autonomous: true resolves approvalPolicy to "onRequest"', async () => {
      const provider = new CodexAppServerProvider()
      const handle = provider.spawn(makeConfig({ autonomous: true, sandboxEnabled: false }))

      const params = await getThreadStartParams(handle)
      expect(params.approvalPolicy).toBe('on-request')
    })

    it('autonomous: false resolves approvalPolicy to "unlessTrusted"', async () => {
      const provider = new CodexAppServerProvider()
      // Reset mock for a fresh process
      mockProc = createMockChildProcess()
      mock = new MockAppServer(mockProc)

      const handle = provider.spawn(makeConfig({ autonomous: false }))

      const params = await getThreadStartParams(handle)
      expect(params.approvalPolicy).toBe('untrusted')
    })

    it('sandboxEnabled: true includes sandbox mode string on thread/start', async () => {
      const provider = new CodexAppServerProvider()
      mockProc = createMockChildProcess()
      mock = new MockAppServer(mockProc)

      const handle = provider.spawn(makeConfig({ sandboxEnabled: true, cwd: '/my/project' }))

      const params = await getThreadStartParams(handle)
      expect(params.sandbox).toBe('workspace-write')
    })

    it('sandboxEnabled: false does not include sandbox on thread/start', async () => {
      const provider = new CodexAppServerProvider()
      mockProc = createMockChildProcess()
      mock = new MockAppServer(mockProc)

      const handle = provider.spawn(makeConfig({ sandboxEnabled: false }))

      const params = await getThreadStartParams(handle)
      expect(params.sandbox).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // 9. MCP Tool Event Mapping (End-to-End)
  // -------------------------------------------------------------------------

  describe('9. MCP Tool Event Mapping (End-to-End)', () => {
    it('maps mcpToolCall item/started -> tool_use and item/completed -> tool_result', async () => {
      const provider = new CodexAppServerProvider()
      const handle = provider.spawn(makeConfig())

      const eventsPromise = collectEventsWithTimeout(handle.stream, 5000)

      const threadId = await mock.completeHandshakeAndThreadStart('thr_mcp_001')

      mock.pushTurnStarted(threadId, 'turn_mcp_1')

      // Push MCP tool call start
      mock.pushItemStarted(threadId, {
        id: 'mcp_001',
        type: 'mcpToolCall',
        server: 'linear',
        tool: 'create_issue',
        arguments: { title: 'New feature', description: 'Build it' },
        status: 'in_progress',
      })

      // Push MCP tool call completion
      mock.pushItemCompleted(threadId, {
        id: 'mcp_001',
        type: 'mcpToolCall',
        server: 'linear',
        tool: 'create_issue',
        arguments: { title: 'New feature', description: 'Build it' },
        result: { content: [{ text: 'Issue LIN-123 created' }] },
        status: 'completed',
      })

      mock.pushTurnCompleted(threadId, 'turn_mcp_1', { status: 'completed' })

      await new Promise((r) => setTimeout(r, 100))
      await handle.stop()

      const events = await eventsPromise

      // Verify tool_use event with correct toolName format
      const toolUseEvent = events.find((e) => e.type === 'tool_use')
      expect(toolUseEvent).toMatchObject({
        type: 'tool_use',
        toolName: 'mcp__linear__create_issue',
        toolUseId: 'mcp_001',
        input: { title: 'New feature', description: 'Build it' },
      })

      // Verify tool_result event
      const toolResultEvent = events.find((e) => e.type === 'tool_result')
      expect(toolResultEvent).toMatchObject({
        type: 'tool_result',
        toolName: 'mcp__linear__create_issue',
        toolUseId: 'mcp_001',
        content: '[{"text":"Issue LIN-123 created"}]',
        isError: false,
      })
    })
  })

  // -------------------------------------------------------------------------
  // 10. Concurrent Thread Multiplexing
  // -------------------------------------------------------------------------

  describe('10. Concurrent Thread Multiplexing', () => {
    it('each handle only receives events for its own thread when notifications are interleaved', async () => {
      const provider = new CodexAppServerProvider()

      // Spawn first handle
      const handle1 = provider.spawn(makeConfig({ prompt: 'Task A' }))
      const events1Promise = collectEventsWithTimeout(handle1.stream, 5000)

      // Complete handshake + thread start for handle1
      await mock.completeHandshake()
      await mock.waitForRequests(4)
      const threadStart1 = mock.requests[3]
      expect(threadStart1?.method).toBe('thread/start')
      mock.pushResponse(threadStart1!.id!, { thread: { id: 'thr_A' } })

      // Wait for turn/start from handle1
      await mock.waitForRequests(5)
      expect(mock.requests[4]?.method).toBe('turn/start')
      mock.pushResponse(mock.requests[4]!.id!, {})

      // Spawn second handle (reuses same process manager since PM is healthy)
      const handle2 = provider.spawn(makeConfig({ prompt: 'Task B' }))
      const events2Promise = collectEventsWithTimeout(handle2.stream, 5000)

      // Handle2 will call processManager.start() (idempotent) then thread/start
      await mock.waitForRequests(6)
      const threadStart2 = mock.requests[5]
      expect(threadStart2?.method).toBe('thread/start')
      mock.pushResponse(threadStart2!.id!, { thread: { id: 'thr_B' } })

      // Wait for turn/start from handle2
      await mock.waitForRequests(7)
      expect(mock.requests[6]?.method).toBe('turn/start')
      mock.pushResponse(mock.requests[6]!.id!, {})

      // Push interleaved notifications for both threads
      mock.pushTurnStarted('thr_A', 'turn_A1')
      mock.pushTurnStarted('thr_B', 'turn_B1')
      mock.pushAgentMessageDelta('thr_A', 'Working on Task A')
      mock.pushAgentMessageDelta('thr_B', 'Working on Task B')
      mock.pushTurnCompleted('thr_A', 'turn_A1', { status: 'completed' })
      mock.pushTurnCompleted('thr_B', 'turn_B1', { status: 'completed' })

      await new Promise((r) => setTimeout(r, 200))

      await handle1.stop()
      await handle2.stop()

      const events1 = await events1Promise
      const events2 = await events2Promise

      // Handle1 should only have events from thr_A
      const text1 = events1.filter((e) => e.type === 'assistant_text')
      expect(text1).toHaveLength(1)
      expect(text1[0]).toMatchObject({ text: 'Working on Task A' })

      // Handle2 should only have events from thr_B
      const text2 = events2.filter((e) => e.type === 'assistant_text')
      expect(text2).toHaveLength(1)
      expect(text2[0]).toMatchObject({ text: 'Working on Task B' })
    })
  })

  // -------------------------------------------------------------------------
  // 11. Provider Resolution Paths
  // -------------------------------------------------------------------------

  describe('11. Provider Resolution Paths', () => {
    it('CODEX_USE_APP_SERVER=1 delegates to CodexAppServerProvider', async () => {
      const { CodexProvider } = await import('./codex-provider.js')
      const provider = new CodexProvider()

      const config = makeConfig({
        env: { CODEX_USE_APP_SERVER: '1' },
      })

      const handle = provider.spawn(config)

      // Access internal appServerProvider
      const appServerProvider = (provider as any).appServerProvider
      expect(appServerProvider).toBeDefined()
      expect(appServerProvider).toBeInstanceOf(CodexAppServerProvider)

      expect(handle).toBeDefined()
      expect(handle.stream).toBeDefined()
    })

    it('CODEX_USE_APP_SERVER=0 delegates to exec mode (no appServerProvider created)', async () => {
      const { CodexProvider } = await import('./codex-provider.js')
      const provider = new CodexProvider()

      const config = makeConfig({
        env: { CODEX_USE_APP_SERVER: '0' },
      })

      const handle = provider.spawn(config)

      // appServerProvider should NOT be created
      const appServerProvider = (provider as any).appServerProvider
      expect(appServerProvider).toBeNull()

      expect(handle).toBeDefined()
    })

    it('CODEX_USE_APP_SERVER not set defaults to app-server mode (since v0.9)', async () => {
      const { CodexProvider } = await import('./codex-provider.js')
      const provider = new CodexProvider()

      // Remove CODEX_USE_APP_SERVER from process.env if present
      const origVal = process.env.CODEX_USE_APP_SERVER
      delete process.env.CODEX_USE_APP_SERVER

      try {
        const config = makeConfig({ env: {} })
        const handle = provider.spawn(config)

        // App-server is the default — provider should be instantiated
        // once the health probe succeeds (mocked to succeed via execFileSync).
        const appServerProvider = (provider as any).appServerProvider
        expect(appServerProvider).toBeDefined()
        expect(appServerProvider).toBeInstanceOf(CodexAppServerProvider)

        expect(handle).toBeDefined()
      } finally {
        // Restore
        if (origVal !== undefined) {
          process.env.CODEX_USE_APP_SERVER = origVal
        }
      }
    })
  })

  // -------------------------------------------------------------------------
  // Additional: Thread/start returns no thread ID
  // -------------------------------------------------------------------------

  describe('Additional: thread/start returns no thread ID', () => {
    it('emits an error event when thread/start response has no thread ID', async () => {
      const provider = new CodexAppServerProvider()
      const handle = provider.spawn(makeConfig())

      const eventsPromise = collectEventsWithTimeout(handle.stream, 5000)

      // Complete handshake
      await mock.completeHandshake()

      // Wait for thread/start (after initialize, initialized, model/list)
      await mock.waitForRequests(4)
      // Respond without a thread ID
      mock.pushResponse(mock.requests[3]!.id!, { thread: {} })

      const events = await eventsPromise

      const errorEvent = events.find((e) => e.type === 'error')
      expect(errorEvent).toBeDefined()
      expect(errorEvent).toMatchObject({
        type: 'error',
        message: expect.stringContaining('no thread ID'),
      })
    })
  })

  // -------------------------------------------------------------------------
  // Additional: Stop sends turn/interrupt and thread/unsubscribe
  // -------------------------------------------------------------------------

  describe('Additional: stop() cleanup', () => {
    it('sends turn/interrupt and thread/unsubscribe when stop() is called', async () => {
      const provider = new CodexAppServerProvider()
      const handle = provider.spawn(makeConfig())

      const eventsPromise = collectEventsWithTimeout(handle.stream, 5000)

      const threadId = await mock.completeHandshakeAndThreadStart('thr_stop_test')

      mock.pushTurnStarted(threadId, 'turn_stop_1')
      await new Promise((r) => setTimeout(r, 50))

      // stop() sends turn/interrupt and thread/unsubscribe — both are auto-responded
      await handle.stop()

      // Verify turn/interrupt was sent
      const interruptReqs = mock.requestsByMethod('turn/interrupt')
      expect(interruptReqs.length).toBeGreaterThanOrEqual(1)
      expect(interruptReqs[0]!.params?.threadId).toBe('thr_stop_test')

      // Verify thread/unsubscribe was sent
      const unsubReqs = mock.requestsByMethod('thread/unsubscribe')
      expect(unsubReqs.length).toBeGreaterThanOrEqual(1)
      expect(unsubReqs[0]!.params?.threadId).toBe('thr_stop_test')

      await eventsPromise
    })
  })

  // -------------------------------------------------------------------------
  // Additional: InjectMessage before session is active throws
  // -------------------------------------------------------------------------

  describe('Additional: injectMessage before session', () => {
    it('throws when injectMessage() is called before session is established', async () => {
      const provider = new CodexAppServerProvider()
      const handle = provider.spawn(makeConfig())

      // Don't start consuming the stream — sessionId is null
      await expect(handle.injectMessage('too early')).rejects.toThrow(
        'No active session for message injection',
      )
    })
  })

  // -------------------------------------------------------------------------
  // Additional: Multiple event types in a turn
  // -------------------------------------------------------------------------

  describe('Additional: Rich notification sequence', () => {
    it('maps reasoning, file changes, and agent messages correctly', async () => {
      const provider = new CodexAppServerProvider()
      const handle = provider.spawn(makeConfig())

      const eventsPromise = collectEventsWithTimeout(handle.stream, 5000)

      const threadId = await mock.completeHandshakeAndThreadStart('thr_rich_001')

      mock.pushTurnStarted(threadId, 'turn_rich_1')

      // Reasoning delta
      mock.pushNotification('item/reasoning/summaryTextDelta', {
        threadId,
        text: 'Analyzing project structure...',
      })

      // Agent message
      mock.pushAgentMessageDelta(threadId, 'I will create the file.')

      // File change completed
      mock.pushItemCompleted(threadId, {
        id: 'fc_001',
        type: 'fileChange',
        changes: [
          { path: 'src/new-file.ts', kind: 'add' },
          { path: 'src/existing.ts', kind: 'update' },
        ],
        status: 'completed',
      })

      mock.pushTurnCompleted(threadId, 'turn_rich_1', { status: 'completed' })

      await new Promise((r) => setTimeout(r, 100))
      await handle.stop()

      const events = await eventsPromise

      // Verify reasoning event
      const reasoningEvent = events.find(
        (e) => e.type === 'system' && 'subtype' in e && e.subtype === 'reasoning',
      )
      expect(reasoningEvent).toBeDefined()
      expect(reasoningEvent).toMatchObject({
        type: 'system',
        subtype: 'reasoning',
        message: 'Analyzing project structure...',
      })

      // Verify file change tool_result
      const fileResult = events.find(
        (e) => e.type === 'tool_result' && 'toolName' in e && e.toolName === 'file_change',
      )
      expect(fileResult).toMatchObject({
        type: 'tool_result',
        toolName: 'file_change',
        content: 'add: src/new-file.ts\nupdate: src/existing.ts',
        isError: false,
      })
    })
  })

  // -------------------------------------------------------------------------
  // Additional: Provider capabilities
  // -------------------------------------------------------------------------

  describe('Additional: Provider capabilities', () => {
    it('reports supportsMessageInjection and supportsSessionResume as true', () => {
      const provider = new CodexAppServerProvider()
      expect(provider.capabilities.supportsMessageInjection).toBe(true)
      expect(provider.capabilities.supportsSessionResume).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Reasoning delta coalescing (REN-74 follow-up)
  // -------------------------------------------------------------------------

  describe('Additional: Reasoning delta coalescing', () => {
    it('coalesces consecutive reasoning deltas into a single system event', async () => {
      const provider = new CodexAppServerProvider()
      const handle = provider.spawn(makeConfig({ autonomous: true }))

      const eventsPromise = collectEventsWithTimeout(handle.stream, 5000)

      const threadId = await mock.completeHandshakeAndThreadStart('thr_coalesce')

      mock.pushTurnStarted(threadId, 'turn_1')

      // Push many small reasoning deltas — each would historically become
      // its own log line with character-by-character spacing.
      const deltas = ['Verif', 'ied ', 'on ', 'branch ', '`REN-74`.']
      for (const delta of deltas) {
        mock.pushNotification('item/reasoning/textDelta', { threadId, text: delta })
      }

      // A non-reasoning event triggers the flush.
      mock.pushAgentMessageDelta(threadId, 'Done.')
      mock.pushTurnCompleted(threadId, 'turn_1', {
        status: 'completed',
        usage: { input_tokens: 10, output_tokens: 5 },
      })

      const events = await eventsPromise

      const reasoningEvents = events.filter(
        (e) => e.type === 'system' && 'subtype' in e && e.subtype === 'reasoning',
      )
      // Exactly one coalesced reasoning event, not five.
      expect(reasoningEvents).toHaveLength(1)
      expect(reasoningEvents[0]).toMatchObject({
        type: 'system',
        subtype: 'reasoning',
        message: 'Verified on branch `REN-74`.',
      })
    })
  })
})
