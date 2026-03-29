/**
 * Codex App Server Provider
 *
 * Manages a long-lived `codex app-server` process communicating via JSON-RPC 2.0
 * over stdio. Supports multiple concurrent threads on a single process.
 *
 * Architecture:
 *   orchestrator → codex app-server (long-lived, one process)
 *                    ├── thread_1 (agent session A)
 *                    ├── thread_2 (agent session B)
 *                    └── thread_3 (agent session C)
 *
 * Falls back to `codex exec` CLI mode when app-server is unavailable.
 *
 * JSON-RPC 2.0 protocol (over stdio JSONL):
 *   1. initialize + initialized handshake
 *   2. thread/start or thread/resume
 *   3. turn/start with prompt
 *   4. Stream item/*, turn/*, thread/* notifications
 *   5. thread/unsubscribe on completion
 *
 * @see https://developers.openai.com/codex/app-server
 */

import { spawn, type ChildProcess } from 'child_process'
import { createInterface, type Interface } from 'readline'
import type {
  AgentProvider,
  AgentSpawnConfig,
  AgentHandle,
  AgentEvent,
} from './types.js'
import { classifyTool } from '../tools/tool-category.js'

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  method: string
  id?: number
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  id: number
  result?: unknown
  error?: { code: number; message: string }
}

interface JsonRpcNotification {
  method: string
  params?: Record<string, unknown>
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification

function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return 'id' in msg && typeof (msg as JsonRpcResponse).id === 'number'
}

function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return 'method' in msg && !('id' in msg)
}

// ---------------------------------------------------------------------------
// MCP Server Status (SUP-1744)
// ---------------------------------------------------------------------------

/** Status of a registered MCP server as reported by mcpServerStatus/list */
export interface McpServerStatusResult {
  name: string
  status: 'connected' | 'connecting' | 'disconnected' | 'error'
  toolCount?: number
  error?: string
}

// ---------------------------------------------------------------------------
// App Server notification types
// ---------------------------------------------------------------------------

interface AppServerItem {
  id: string
  type: string
  text?: string
  summary?: string
  content?: string
  command?: string
  cwd?: string
  status?: string
  exitCode?: number
  durationMs?: number
  changes?: Array<{ path: string; kind: string }>
  server?: string
  tool?: string
  arguments?: unknown
  result?: { content?: unknown[] }
  error?: { message?: string }
  items?: Array<{ text: string; completed: boolean }>
  phase?: string
}

interface AppServerTurn {
  id: string
  status?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cached_input_tokens?: number
  }
  error?: {
    message?: string
    codexErrorInfo?: string
    httpStatusCode?: number
  }
}

interface AppServerThread {
  id: string
  status?: string
}

// ---------------------------------------------------------------------------
// App Server Process Manager (SUP-1755)
// ---------------------------------------------------------------------------

/** Pending JSON-RPC request awaiting a response */
interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Manages a single long-lived `codex app-server` process.
 *
 * Handles:
 * - Process spawning and stdio communication
 * - JSON-RPC 2.0 initialization handshake
 * - Request/response correlation
 * - Notification routing to thread subscribers
 * - Health monitoring and graceful shutdown
 */
export class AppServerProcessManager {
  private process: ChildProcess | null = null
  private readline: Interface | null = null
  private nextId = 1
  private pendingRequests = new Map<number, PendingRequest>()
  private initialized = false
  private shutdownPromise: Promise<void> | null = null

  /** Notification listeners keyed by threadId */
  private threadListeners = new Map<string, (notification: JsonRpcNotification) => void>()

  /** Global notification listeners (for notifications without a threadId) */
  private globalListeners = new Set<(notification: JsonRpcNotification) => void>()

  private readonly codexBin: string
  private readonly cwd: string
  private readonly env: Record<string, string>

  constructor(options: {
    codexBin?: string
    cwd: string
    env?: Record<string, string>
  }) {
    this.codexBin = options.codexBin || process.env.CODEX_BIN || 'codex'
    this.cwd = options.cwd
    this.env = options.env || {}
  }

  /**
   * Start the app-server process and complete the initialization handshake.
   * Idempotent — returns immediately if already initialized.
   */
  async start(): Promise<void> {
    if (this.initialized && this.process && !this.process.killed) {
      return
    }

    this.process = spawn(this.codexBin, ['app-server'], {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.readline = createInterface({ input: this.process.stdout! })

    // Parse incoming JSONL messages
    this.readline.on('line', (line: string) => {
      const trimmed = line.trim()
      if (!trimmed) return

      let msg: JsonRpcMessage
      try {
        msg = JSON.parse(trimmed) as JsonRpcMessage
      } catch {
        // Non-JSON output — ignore
        return
      }

      if (isResponse(msg)) {
        this.handleResponse(msg)
      } else if (isNotification(msg)) {
        this.handleNotification(msg)
      }
    })

    // Handle process errors
    this.process.on('error', (err) => {
      console.error('[CodexAppServer] Process error:', err.message)
      this.rejectAllPending(new Error(`App server process error: ${err.message}`))
    })

    this.process.on('exit', (code, signal) => {
      console.error(`[CodexAppServer] Process exited: code=${code} signal=${signal}`)
      this.initialized = false
      this.rejectAllPending(new Error(`App server exited: code=${code} signal=${signal}`))
    })

    // Perform initialization handshake
    await this.initialize()
  }

  /**
   * JSON-RPC 2.0 initialization handshake:
   * 1. Send `initialize` request
   * 2. Receive response
   * 3. Send `initialized` notification
   */
  private async initialize(): Promise<void> {
    // Step 1: Send initialize request
    await this.request('initialize', {
      clientInfo: {
        name: 'agentfactory',
        title: 'AgentFactory Orchestrator',
        version: '0.8.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    })

    // Step 2: Send initialized notification
    this.send({ method: 'initialized', params: {} })

    this.initialized = true
  }

  /**
   * Send a JSON-RPC request and wait for the response.
   */
  async request(method: string, params?: Record<string, unknown>, timeoutMs = 30000): Promise<unknown> {
    if (!this.process || this.process.killed) {
      throw new Error('App server process is not running')
    }

    const id = this.nextId++
    const message: JsonRpcRequest = { method, id }
    if (params) message.params = params

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`JSON-RPC request timed out: ${method} (id=${id})`))
      }, timeoutMs)

      this.pendingRequests.set(id, { resolve, reject, timer })
      this.send(message)
    })
  }

  /**
   * Send a JSON-RPC message (request or notification) to the app-server.
   */
  private send(message: JsonRpcRequest): void {
    if (!this.process?.stdin?.writable) {
      throw new Error('App server stdin is not writable')
    }
    this.process.stdin.write(JSON.stringify(message) + '\n')
  }

  /**
   * Handle an incoming JSON-RPC response.
   */
  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(response.id)
    if (!pending) return

    this.pendingRequests.delete(response.id)
    clearTimeout(pending.timer)

    if (response.error) {
      pending.reject(new Error(`JSON-RPC error (${response.error.code}): ${response.error.message}`))
    } else {
      pending.resolve(response.result)
    }
  }

  /**
   * Handle an incoming JSON-RPC notification.
   * Routes to the appropriate thread listener based on threadId in params.
   */
  private handleNotification(notification: JsonRpcNotification): void {
    const threadId = notification.params?.threadId as string | undefined

    if (threadId) {
      const listener = this.threadListeners.get(threadId)
      if (listener) {
        listener(notification)
        return
      }
    }

    // Dispatch to global listeners
    for (const listener of this.globalListeners) {
      listener(notification)
    }
  }

  /**
   * Subscribe to notifications for a specific thread.
   */
  subscribeThread(threadId: string, listener: (notification: JsonRpcNotification) => void): void {
    this.threadListeners.set(threadId, listener)
  }

  /**
   * Unsubscribe from notifications for a specific thread.
   */
  unsubscribeThread(threadId: string): void {
    this.threadListeners.delete(threadId)
  }

  /**
   * Check if the app-server process is alive and initialized.
   */
  isHealthy(): boolean {
    return this.initialized && !!this.process && !this.process.killed
  }

  // ─── MCP Server Configuration (SUP-1744) ──────────────────────────

  /** Whether MCP servers have been configured on this process */
  private mcpConfigured = false

  /**
   * Register MCP servers with the app-server via config/batchWrite.
   * Called once after initialization to tell Codex about the stdio
   * MCP tool servers (af-linear, af-code-intelligence, etc.).
   *
   * Uses the Codex app-server `config/batchWrite` JSON-RPC method
   * to register multiple MCP server configurations in a single call.
   */
  async configureMcpServers(
    servers: Array<{ name: string; command: string; args: string[]; env?: Record<string, string> }>,
  ): Promise<void> {
    if (!this.initialized || this.mcpConfigured) return
    if (servers.length === 0) return

    const mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {}
    for (const server of servers) {
      mcpServers[server.name] = {
        command: server.command,
        args: server.args,
        env: server.env,
      }
    }

    try {
      await this.request('config/batchWrite', {
        entries: [
          { key: 'mcpServers', value: mcpServers },
        ],
      })
      this.mcpConfigured = true
      console.error(`[CodexAppServer] Configured ${servers.length} MCP servers: ${servers.map(s => s.name).join(', ')}`)
    } catch (err) {
      // config/batchWrite may not be supported in all Codex versions
      console.error(`[CodexAppServer] Failed to configure MCP servers: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Query MCP server health via mcpServerStatus/list.
   * Returns the status of all registered MCP servers.
   */
  async getMcpServerStatus(): Promise<McpServerStatusResult[]> {
    if (!this.initialized) return []

    try {
      const result = await this.request('mcpServerStatus/list') as {
        servers?: McpServerStatusResult[]
      }
      return result?.servers ?? []
    } catch {
      // mcpServerStatus/list may not be supported
      return []
    }
  }

  /**
   * Get the PID of the app-server process.
   */
  get pid(): number | undefined {
    return this.process?.pid
  }

  /**
   * Graceful shutdown: unsubscribe all threads, kill process.
   */
  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise

    this.shutdownPromise = this.performShutdown()
    return this.shutdownPromise
  }

  private async performShutdown(): Promise<void> {
    this.initialized = false

    // Clear all pending requests
    this.rejectAllPending(new Error('App server shutting down'))

    // Kill the process
    if (this.process && !this.process.killed) {
      const exitPromise = new Promise<void>((resolve) => {
        this.process!.once('exit', () => resolve())
        // Force kill after 5 seconds
        setTimeout(() => {
          if (this.process && !this.process.killed) {
            this.process.kill('SIGKILL')
          }
          resolve()
        }, 5000)
      })

      this.process.kill('SIGTERM')
      await exitPromise
    }

    this.readline?.close()
    this.threadListeners.clear()
    this.globalListeners.clear()
    this.process = null
    this.readline = null
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pendingRequests.delete(id)
    }
  }
}

// ---------------------------------------------------------------------------
// Event Mapping — App Server notifications → AgentEvent (SUP-1738)
// ---------------------------------------------------------------------------

export interface AppServerEventMapperState {
  sessionId: string | null
  totalInputTokens: number
  totalOutputTokens: number
  turnCount: number
}

/**
 * Map an App Server notification to normalized AgentEvents.
 * Exported for unit testing.
 */
export function mapAppServerNotification(
  notification: JsonRpcNotification,
  state: AppServerEventMapperState,
): AgentEvent[] {
  const method = notification.method
  const params = notification.params ?? {}

  switch (method) {
    // --- Thread lifecycle ---
    case 'thread/started': {
      const thread = params.thread as AppServerThread | undefined
      if (thread?.id) {
        state.sessionId = thread.id
        return [{
          type: 'init',
          sessionId: thread.id,
          raw: notification,
        }]
      }
      return []
    }

    case 'thread/closed':
    case 'thread/status/changed':
      return [{
        type: 'system',
        subtype: method.replace(/\//g, '_'),
        message: `Thread ${method}: ${JSON.stringify(params)}`,
        raw: notification,
      }]

    // --- Turn lifecycle ---
    case 'turn/started': {
      state.turnCount++
      const turn = params.turn as AppServerTurn | undefined
      return [{
        type: 'system',
        subtype: 'turn_started',
        message: `Turn ${state.turnCount} started${turn?.id ? ` (${turn.id})` : ''}`,
        raw: notification,
      }]
    }

    case 'turn/completed': {
      const turn = params.turn as AppServerTurn | undefined
      const turnStatus = turn?.status ?? 'completed'

      // Accumulate usage
      if (turn?.usage) {
        state.totalInputTokens += turn.usage.input_tokens ?? 0
        state.totalOutputTokens += turn.usage.output_tokens ?? 0
      }

      if (turnStatus === 'completed') {
        return [{
          type: 'result',
          success: true,
          cost: {
            inputTokens: state.totalInputTokens || undefined,
            outputTokens: state.totalOutputTokens || undefined,
            numTurns: state.turnCount || undefined,
          },
          raw: notification,
        }]
      }

      if (turnStatus === 'failed') {
        return [{
          type: 'result',
          success: false,
          errors: [turn?.error?.message ?? 'Turn failed'],
          errorSubtype: turn?.error?.codexErrorInfo ?? 'turn_failed',
          cost: {
            inputTokens: state.totalInputTokens || undefined,
            outputTokens: state.totalOutputTokens || undefined,
            numTurns: state.turnCount || undefined,
          },
          raw: notification,
        }]
      }

      if (turnStatus === 'interrupted') {
        return [{
          type: 'result',
          success: false,
          errors: ['Turn was interrupted'],
          errorSubtype: 'interrupted',
          raw: notification,
        }]
      }

      return [{
        type: 'system',
        subtype: 'turn_completed',
        message: `Turn completed with status: ${turnStatus}`,
        raw: notification,
      }]
    }

    // --- Item lifecycle ---
    case 'item/started':
    case 'item/completed':
      return mapAppServerItemEvent(method, params)

    // --- Item deltas (streaming) ---
    case 'item/agentMessage/delta': {
      const text = params.text as string | undefined
      if (text) {
        return [{
          type: 'assistant_text',
          text,
          raw: notification,
        }]
      }
      return []
    }

    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/textDelta': {
      const text = (params.text ?? params.delta) as string | undefined
      if (text) {
        return [{
          type: 'system',
          subtype: 'reasoning',
          message: text,
          raw: notification,
        }]
      }
      return []
    }

    case 'item/commandExecution/outputDelta':
      return [{
        type: 'system',
        subtype: 'command_progress',
        message: (params.delta ?? params.output) as string ?? '',
        raw: notification,
      }]

    // --- Turn diff/plan ---
    case 'turn/diff/updated':
      return [{
        type: 'system',
        subtype: 'diff_updated',
        message: params.diff as string ?? '',
        raw: notification,
      }]

    case 'turn/plan/updated':
      return [{
        type: 'system',
        subtype: 'plan_updated',
        message: JSON.stringify(params.plan),
        raw: notification,
      }]

    default:
      return [{
        type: 'system',
        subtype: 'unknown',
        message: `Unhandled App Server notification: ${method}`,
        raw: notification,
      }]
  }
}

/**
 * Map item/started and item/completed notifications to AgentEvents.
 * Exported for unit testing.
 */
export function mapAppServerItemEvent(
  method: string,
  params: Record<string, unknown>,
): AgentEvent[] {
  const item = params.item as AppServerItem | undefined
  if (!item) return []

  const isStarted = method === 'item/started'
  const isCompleted = method === 'item/completed'

  switch (item.type) {
    case 'agentMessage':
      if (isCompleted && item.text) {
        return [{
          type: 'assistant_text',
          text: item.text,
          raw: { method, params },
        }]
      }
      return []

    case 'reasoning':
      if (item.summary || item.content) {
        return [{
          type: 'system',
          subtype: 'reasoning',
          message: item.summary || item.content || '',
          raw: { method, params },
        }]
      }
      return []

    case 'commandExecution':
      if (isStarted) {
        return [{
          type: 'tool_use',
          toolName: 'shell',
          toolUseId: item.id,
          input: { command: item.command ?? '' },
          raw: { method, params },
        }]
      }
      if (isCompleted) {
        return [{
          type: 'tool_result',
          toolName: 'shell',
          toolUseId: item.id,
          content: item.text ?? '',
          isError: item.status === 'failed' || (item.exitCode !== undefined && item.exitCode !== 0),
          raw: { method, params },
        }]
      }
      return []

    case 'fileChange':
      if (isCompleted) {
        const changes = item.changes ?? []
        return [{
          type: 'tool_result',
          toolName: 'file_change',
          toolUseId: item.id,
          content: changes.map((c) => `${c.kind}: ${c.path}`).join('\n'),
          isError: item.status === 'failed',
          raw: { method, params },
        }]
      }
      return []

    case 'mcpToolCall': {
      // Normalize tool name to mcp__{server}__{tool} format (SUP-1745)
      // This matches the convention used by the Claude provider for
      // in-process MCP tools, enabling consistent tool tracking.
      const mcpToolName = normalizeMcpToolName(item.server, item.tool)

      if (isStarted) {
        return [{
          type: 'tool_use',
          toolName: mcpToolName,
          toolUseId: item.id,
          input: (item.arguments ?? {}) as Record<string, unknown>,
          toolCategory: classifyTool(mcpToolName),
          raw: { method, params },
        }]
      }
      if (isCompleted) {
        const isError = item.status === 'failed' || !!item.error
        const content = item.error?.message
          ?? (item.result?.content ? JSON.stringify(item.result.content) : '')
        return [{
          type: 'tool_result',
          toolName: mcpToolName,
          toolUseId: item.id,
          content,
          isError,
          raw: { method, params },
        }]
      }
      return []
    }

    case 'plan':
      return [{
        type: 'system',
        subtype: 'plan',
        message: item.text ?? '',
        raw: { method, params },
      }]

    case 'webSearch':
      return [{
        type: 'system',
        subtype: 'web_search',
        message: `Web search: ${item.text ?? ''}`,
        raw: { method, params },
      }]

    case 'contextCompaction':
      return [{
        type: 'system',
        subtype: 'context_compaction',
        message: 'Context history compacted',
        raw: { method, params },
      }]

    default:
      return [{
        type: 'system',
        subtype: 'unknown_item',
        message: `Unhandled App Server item type: ${item.type}`,
        raw: { method, params },
      }]
  }
}

// ---------------------------------------------------------------------------
// MCP tool name normalization (SUP-1745)
// ---------------------------------------------------------------------------

/**
 * Normalize Codex MCP tool names to the `mcp__{server}__{tool}` format
 * used by the orchestrator and Claude provider for consistent tool tracking.
 *
 * Codex reports MCP tools as `server` + `tool` (e.g., server='af-linear',
 * tool='af_linear_get_issue'). We normalize to 'mcp__af-linear__af_linear_get_issue'.
 */
export function normalizeMcpToolName(server?: string, tool?: string): string {
  if (server && tool) {
    return `mcp__${server}__${tool}`
  }
  // Fallback for missing server/tool
  return `mcp:${server ?? 'unknown'}/${tool ?? 'unknown'}`
}

// ---------------------------------------------------------------------------
// Resolve approval policy from AgentSpawnConfig
// ---------------------------------------------------------------------------

function resolveApprovalPolicy(config: AgentSpawnConfig): string {
  if (config.autonomous) return 'never'
  return 'unlessTrusted'
}

function resolveSandboxPolicy(config: AgentSpawnConfig): Record<string, unknown> | undefined {
  if (!config.sandboxEnabled) return undefined
  return {
    type: 'workspaceWrite',
    writableRoots: [config.cwd],
  }
}

// ---------------------------------------------------------------------------
// AgentHandle for App Server threads (SUP-1737)
// ---------------------------------------------------------------------------

class AppServerAgentHandle implements AgentHandle {
  sessionId: string | null = null
  private readonly processManager: AppServerProcessManager
  private readonly config: AgentSpawnConfig
  private readonly resumeThreadId?: string
  private readonly mapperState: AppServerEventMapperState = {
    sessionId: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    turnCount: 0,
  }
  private activeTurnId: string | null = null
  private notificationQueue: JsonRpcNotification[] = []
  private notificationResolve: (() => void) | null = null
  private streamEnded = false
  /** True while we're waiting for a possible injected turn between turns */
  private awaitingInjection = false

  constructor(
    processManager: AppServerProcessManager,
    config: AgentSpawnConfig,
    resumeThreadId?: string,
  ) {
    this.processManager = processManager
    this.config = config
    this.resumeThreadId = resumeThreadId
  }

  get stream(): AsyncIterable<AgentEvent> {
    return this.createEventStream()
  }

  async injectMessage(text: string): Promise<void> {
    if (!this.sessionId) {
      throw new Error('No active session for message injection')
    }

    if (this.activeTurnId) {
      // Mid-turn injection: steer the active turn (SUP-1740)
      await this.steerTurn(text)
    } else {
      // Between-turn injection: start a new turn on the existing thread (SUP-1741)
      await this.startNewTurn(text)
    }
  }

  async stop(): Promise<void> {
    if (this.sessionId) {
      try {
        // Interrupt any active turn
        await this.processManager.request('turn/interrupt', {
          threadId: this.sessionId,
          turnId: 'current',
        }).catch(() => { /* turn may not be active */ })

        // Unsubscribe from the thread
        await this.processManager.request('thread/unsubscribe', {
          threadId: this.sessionId,
        }).catch(() => { /* best effort */ })
      } catch {
        // Best effort cleanup
      }

      this.processManager.unsubscribeThread(this.sessionId)
    }

    this.streamEnded = true
    this.notificationResolve?.()
  }

  /**
   * Steer an active turn with additional user input (SUP-1740).
   * Sends a `turn/steer` JSON-RPC request to inject a message mid-turn.
   */
  private async steerTurn(text: string): Promise<void> {
    if (!this.sessionId || !this.activeTurnId) {
      throw new Error('No active turn to steer')
    }
    await this.processManager.request('turn/steer', {
      threadId: this.sessionId,
      turnId: this.activeTurnId,
      input: [{ type: 'text', text }],
    })
  }

  /**
   * Start a new turn on the existing thread with additional user input (SUP-1741).
   * Used for between-turn injection when no turn is currently active.
   */
  private async startNewTurn(text: string): Promise<void> {
    if (!this.sessionId) {
      throw new Error('No active session to start new turn')
    }

    const turnParams: Record<string, unknown> = {
      threadId: this.sessionId,
      input: [{ type: 'text', text }],
      cwd: this.config.cwd,
      approvalPolicy: resolveApprovalPolicy(this.config),
    }

    if (this.config.maxTurns) {
      turnParams.maxTurns = this.config.maxTurns
    }

    const sandboxPolicy = resolveSandboxPolicy(this.config)
    if (sandboxPolicy) {
      turnParams.sandboxPolicy = sandboxPolicy
    }

    // Mark that we're no longer waiting between turns
    this.awaitingInjection = false

    await this.processManager.request('turn/start', turnParams)

    // Wake up the notification loop so it processes the new turn's events
    this.notificationResolve?.()
  }

  private async *createEventStream(): AsyncGenerator<AgentEvent> {
    try {
      // Ensure the app-server is running
      await this.processManager.start()

      // Configure MCP servers if provided (SUP-1744)
      // This registers stdio MCP tool servers (af-linear, af-code-intelligence)
      // with the Codex app-server so it can discover and invoke them.
      if (this.config.mcpStdioServers && this.config.mcpStdioServers.length > 0) {
        await this.processManager.configureMcpServers(this.config.mcpStdioServers)
      }

      // Start or resume the thread
      let threadId: string

      if (this.resumeThreadId) {
        // Resume existing thread
        const result = await this.processManager.request('thread/resume', {
          threadId: this.resumeThreadId,
          personality: 'concise',
        }) as { thread?: { id: string } }

        threadId = result?.thread?.id ?? this.resumeThreadId
      } else {
        // Start new thread
        const threadParams: Record<string, unknown> = {
          cwd: this.config.cwd,
          approvalPolicy: resolveApprovalPolicy(this.config),
          serviceName: 'agentfactory',
        }

        const sandboxPolicy = resolveSandboxPolicy(this.config)
        if (sandboxPolicy) {
          threadParams.sandboxPolicy = sandboxPolicy
        }

        const result = await this.processManager.request('thread/start', threadParams) as {
          thread?: { id: string }
        }

        threadId = result?.thread?.id ?? ''
        if (!threadId) {
          yield {
            type: 'error',
            message: 'Failed to start thread: no thread ID returned',
            raw: result,
          }
          return
        }
      }

      this.sessionId = threadId
      this.mapperState.sessionId = threadId

      // Subscribe to thread notifications
      this.processManager.subscribeThread(threadId, (notification) => {
        this.notificationQueue.push(notification)
        this.notificationResolve?.()
      })

      // Emit init event
      yield {
        type: 'init',
        sessionId: threadId,
        raw: { threadId },
      }

      // Start the turn with the prompt
      const turnInput: Array<{ type: string; text?: string }> = [
        { type: 'text', text: this.config.prompt },
      ]

      const turnParams: Record<string, unknown> = {
        threadId,
        input: turnInput,
        cwd: this.config.cwd,
        approvalPolicy: resolveApprovalPolicy(this.config),
      }

      if (this.config.maxTurns) {
        turnParams.maxTurns = this.config.maxTurns
      }

      const sandboxPolicy = resolveSandboxPolicy(this.config)
      if (sandboxPolicy) {
        turnParams.sandboxPolicy = sandboxPolicy
      }

      await this.processManager.request('turn/start', turnParams)

      // Stream notifications until explicitly stopped.
      // After a turn completes, we enter "awaiting injection" mode — the stream
      // stays alive to allow injectMessage() to start a new turn. The stream
      // only terminates when stop() is called or the process dies.
      //
      // turn/completed `result` events are intercepted and re-emitted as `system`
      // events so the orchestrator doesn't interpret them as the agent finishing.
      // A single `result` event is emitted when the stream actually ends.
      let lastTurnSuccess = true
      let lastTurnErrors: string[] | undefined

      while (!this.streamEnded) {
        // Wait for notifications
        if (this.notificationQueue.length === 0) {
          await new Promise<void>((resolve) => {
            this.notificationResolve = resolve
            // Timeout to prevent hanging indefinitely
            setTimeout(resolve, 60000)
          })
          this.notificationResolve = null
        }

        // Drain the queue
        while (this.notificationQueue.length > 0) {
          const notification = this.notificationQueue.shift()!

          // Track active turn ID for mid-turn steering (SUP-1740)
          if (notification.method === 'turn/started') {
            const turn = notification.params?.turn as AppServerTurn | undefined
            if (turn?.id) {
              this.activeTurnId = turn.id
            }
            this.awaitingInjection = false
          } else if (notification.method === 'turn/completed') {
            this.activeTurnId = null
            // Enter awaiting-injection mode — the stream stays alive
            this.awaitingInjection = true
          }

          const events = mapAppServerNotification(notification, this.mapperState)

          for (const event of events) {
            // Intercept turn/completed result events — convert to system events
            // so the orchestrator doesn't think the agent is done. Track the last
            // turn's outcome so we can emit a proper result when the stream ends.
            if (event.type === 'result') {
              lastTurnSuccess = event.success
              lastTurnErrors = event.errors
              yield {
                type: 'system',
                subtype: 'turn_result',
                message: `Turn ${event.success ? 'succeeded' : 'failed'}${event.errors?.length ? ': ' + event.errors[0] : ''}`,
                raw: event.raw,
              }
            } else {
              yield event
            }
          }
        }
      }

      // Cleanup: unsubscribe from the thread
      this.processManager.unsubscribeThread(threadId)
      try {
        await this.processManager.request('thread/unsubscribe', { threadId }).catch(() => {})
      } catch {
        // Best effort
      }

      // Emit the final result event when the stream ends
      yield {
        type: 'result',
        success: lastTurnSuccess,
        errors: lastTurnErrors,
        cost: {
          inputTokens: this.mapperState.totalInputTokens || undefined,
          outputTokens: this.mapperState.totalOutputTokens || undefined,
          numTurns: this.mapperState.turnCount || undefined,
        },
        raw: null,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      yield {
        type: 'error',
        message: `App Server error: ${message}`,
        raw: err,
      }
      yield {
        type: 'result',
        success: false,
        errors: [message],
        errorSubtype: 'app_server_error',
        raw: err,
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Provider (SUP-1731)
// ---------------------------------------------------------------------------

/**
 * Codex App Server Provider
 *
 * Uses a long-lived `codex app-server` process with JSON-RPC 2.0 over stdio.
 * Falls back to `codex exec` CLI mode when CODEX_USE_APP_SERVER is not set
 * or when the app-server binary is unavailable.
 */
export class CodexAppServerProvider implements AgentProvider {
  readonly name = 'codex' as const
  readonly capabilities = {
    supportsMessageInjection: true,
    supportsSessionResume: true,
  } as const

  /** Shared process manager — one app-server process serves all threads */
  private processManager: AppServerProcessManager | null = null

  spawn(config: AgentSpawnConfig): AgentHandle {
    const pm = this.getOrCreateProcessManager(config)
    return new AppServerAgentHandle(pm, config)
  }

  resume(sessionId: string, config: AgentSpawnConfig): AgentHandle {
    const pm = this.getOrCreateProcessManager(config)
    return new AppServerAgentHandle(pm, config, sessionId)
  }

  /**
   * Shut down the shared app-server process.
   * Called when the orchestrator is done with this provider.
   */
  async shutdown(): Promise<void> {
    if (this.processManager) {
      await this.processManager.shutdown()
      this.processManager = null
    }
  }

  private getOrCreateProcessManager(config: AgentSpawnConfig): AppServerProcessManager {
    if (this.processManager?.isHealthy()) {
      return this.processManager
    }

    this.processManager = new AppServerProcessManager({
      codexBin: config.env.CODEX_BIN || process.env.CODEX_BIN,
      cwd: config.cwd,
      env: config.env,
    })

    return this.processManager
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCodexAppServerProvider(): CodexAppServerProvider {
  return new CodexAppServerProvider()
}

/** Exported for testing */
export type { JsonRpcNotification, AppServerItem, AppServerTurn, AppServerThread }
