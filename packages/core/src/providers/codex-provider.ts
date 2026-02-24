/**
 * OpenAI Codex Agent Provider
 *
 * Spawns the `codex` CLI (from @openai/codex) as a child process and parses
 * its JSONL event stream into normalized AgentEvents.
 *
 * CLI invocation patterns:
 *   New session:  codex exec --json --full-auto -C <cwd> "<prompt>"
 *   Resume:       codex exec resume --json --full-auto <session_id> "<prompt>"
 *
 * JSONL event types:
 *   thread.started  → init (sessionId)
 *   turn.started    → system (turn_started)
 *   turn.completed  → result (success, usage)
 *   turn.failed     → result (failure)
 *   item.*          → tool_use / tool_result / assistant_text / system
 *   error           → error
 */

import { spawn, type ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import type {
  AgentProvider,
  AgentSpawnConfig,
  AgentHandle,
  AgentEvent,
} from './types.js'

// ---------------------------------------------------------------------------
// Codex JSONL event types (subset we care about)
// ---------------------------------------------------------------------------

interface CodexThreadStarted {
  type: 'thread.started'
  thread_id: string
}

interface CodexTurnStarted {
  type: 'turn.started'
}

interface CodexTurnCompleted {
  type: 'turn.completed'
  usage?: {
    input_tokens?: number
    cached_input_tokens?: number
    output_tokens?: number
  }
}

interface CodexTurnFailed {
  type: 'turn.failed'
  error?: { message?: string }
}

interface CodexItemEvent {
  type: 'item.started' | 'item.updated' | 'item.completed'
  item: CodexItem
}

interface CodexErrorEvent {
  type: 'error'
  message?: string
}

type CodexEvent =
  | CodexThreadStarted
  | CodexTurnStarted
  | CodexTurnCompleted
  | CodexTurnFailed
  | CodexItemEvent
  | CodexErrorEvent

// ---------------------------------------------------------------------------
// Codex item types (nested in item events)
// ---------------------------------------------------------------------------

interface CodexAgentMessage {
  id: string
  type: 'agent_message'
  text: string
}

interface CodexReasoning {
  id: string
  type: 'reasoning'
  text: string
}

interface CodexCommandExecution {
  id: string
  type: 'command_execution'
  command: string
  aggregated_output: string
  exit_code?: number
  status: 'in_progress' | 'completed' | 'failed' | 'declined'
}

interface CodexFileChange {
  id: string
  type: 'file_change'
  changes: Array<{ path: string; kind: string }>
  status: string
}

interface CodexMcpToolCall {
  id: string
  type: 'mcp_tool_call'
  server: string
  tool: string
  arguments: unknown
  result?: { content?: unknown[] }
  error?: { message?: string }
  status: string
}

interface CodexTodoList {
  id: string
  type: 'todo_list'
  items: Array<{ text: string; completed: boolean }>
}

interface CodexErrorItem {
  id: string
  type: 'error'
  message: string
}

type CodexItem =
  | CodexAgentMessage
  | CodexReasoning
  | CodexCommandExecution
  | CodexFileChange
  | CodexMcpToolCall
  | CodexTodoList
  | CodexErrorItem

/** Exported for testing */
export type { CodexEvent, CodexItem, CodexItemEvent }

// ---------------------------------------------------------------------------
// Event Mapping (exported for unit testing)
// ---------------------------------------------------------------------------

export interface CodexEventMapperState {
  sessionId: string | null
  totalInputTokens: number
  totalOutputTokens: number
  turnCount: number
}

/**
 * Map a single Codex JSONL event to one or more normalized AgentEvents.
 * Exported for unit testing — the AgentHandle uses this internally.
 */
export function mapCodexEvent(
  event: CodexEvent,
  state: CodexEventMapperState,
): AgentEvent[] {
  switch (event.type) {
    case 'thread.started':
      state.sessionId = event.thread_id
      return [{
        type: 'init',
        sessionId: event.thread_id,
        raw: event,
      }]

    case 'turn.started':
      state.turnCount++
      return [{
        type: 'system',
        subtype: 'turn_started',
        message: `Turn ${state.turnCount} started`,
        raw: event,
      }]

    case 'turn.completed':
      if (event.usage) {
        state.totalInputTokens += event.usage.input_tokens ?? 0
        state.totalOutputTokens += event.usage.output_tokens ?? 0
      }
      return [{
        type: 'result',
        success: true,
        cost: {
          inputTokens: state.totalInputTokens || undefined,
          outputTokens: state.totalOutputTokens || undefined,
          numTurns: state.turnCount || undefined,
        },
        raw: event,
      }]

    case 'turn.failed':
      return [{
        type: 'result',
        success: false,
        errors: [event.error?.message ?? 'Turn failed'],
        errorSubtype: 'turn_failed',
        raw: event,
      }]

    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      return mapCodexItemEvent(event)

    case 'error':
      return [{
        type: 'error',
        message: event.message ?? 'Unknown error',
        raw: event,
      }]

    default:
      return [{
        type: 'system',
        subtype: 'unknown',
        message: `Unhandled Codex event type: ${(event as { type: string }).type}`,
        raw: event,
      }]
  }
}

/**
 * Map a Codex item event to AgentEvents.
 * Exported for unit testing.
 */
export function mapCodexItemEvent(event: CodexItemEvent): AgentEvent[] {
  const item = event.item
  const eventType = event.type

  switch (item.type) {
    case 'agent_message':
      return [{
        type: 'assistant_text',
        text: item.text,
        raw: event,
      }]

    case 'reasoning':
      return [{
        type: 'system',
        subtype: 'reasoning',
        message: item.text,
        raw: event,
      }]

    case 'command_execution':
      if (eventType === 'item.started') {
        return [{
          type: 'tool_use',
          toolName: 'shell',
          toolUseId: item.id,
          input: { command: item.command },
          raw: event,
        }]
      }
      if (eventType === 'item.completed') {
        return [{
          type: 'tool_result',
          toolName: 'shell',
          toolUseId: item.id,
          content: item.aggregated_output || '',
          isError: item.status === 'failed' || (item.exit_code !== undefined && item.exit_code !== 0),
          raw: event,
        }]
      }
      return [{
        type: 'system',
        subtype: 'command_progress',
        message: `Command: ${item.command} (${item.status})`,
        raw: event,
      }]

    case 'file_change':
      return [{
        type: 'tool_result',
        toolName: 'file_change',
        toolUseId: item.id,
        content: item.changes.map((c) => `${c.kind}: ${c.path}`).join('\n'),
        isError: item.status === 'failed',
        raw: event,
      }]

    case 'mcp_tool_call':
      if (eventType === 'item.started') {
        return [{
          type: 'tool_use',
          toolName: `mcp:${item.server}/${item.tool}`,
          toolUseId: item.id,
          input: (item.arguments ?? {}) as Record<string, unknown>,
          raw: event,
        }]
      }
      if (eventType === 'item.completed') {
        const isError = item.status === 'failed' || !!item.error
        const content = item.error?.message
          ?? (item.result?.content ? JSON.stringify(item.result.content) : '')
        return [{
          type: 'tool_result',
          toolName: `mcp:${item.server}/${item.tool}`,
          toolUseId: item.id,
          content,
          isError,
          raw: event,
        }]
      }
      return []

    case 'todo_list':
      return [{
        type: 'system',
        subtype: 'todo_list',
        message: item.items.map((t) => `${t.completed ? '[x]' : '[ ]'} ${t.text}`).join('\n'),
        raw: event,
      }]

    case 'error':
      return [{
        type: 'error',
        message: item.message,
        raw: event,
      }]

    default:
      return [{
        type: 'system',
        subtype: 'unknown_item',
        message: `Unhandled Codex item type: ${(item as { type: string }).type}`,
        raw: event,
      }]
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class CodexProvider implements AgentProvider {
  readonly name = 'codex' as const

  spawn(config: AgentSpawnConfig): AgentHandle {
    return this.createHandle(config)
  }

  resume(sessionId: string, config: AgentSpawnConfig): AgentHandle {
    return this.createHandle(config, sessionId)
  }

  private createHandle(config: AgentSpawnConfig, resumeSessionId?: string): AgentHandle {
    const abortController = config.abortController

    // Resolve the codex binary — prefer CODEX_BIN env var, then fall back to 'codex'
    const codexBin = config.env.CODEX_BIN || process.env.CODEX_BIN || 'codex'

    // Build args
    const args: string[] = ['exec']

    if (resumeSessionId) {
      args.push('resume', '--json')
      // Sandbox and approval mode
      if (config.autonomous) {
        args.push('--full-auto')
      } else {
        // Non-autonomous: use suggest-equivalent approval mode
        args.push('--approval-mode', 'untrusted')
        if (config.sandboxEnabled) {
          args.push('--sandbox', 'workspace-write')
        }
      }
      args.push(resumeSessionId)
      // Prompt is the final positional arg
      if (config.prompt) {
        args.push(config.prompt)
      }
    } else {
      args.push('--json')
      // Sandbox and approval mode
      if (config.autonomous) {
        // --full-auto sets sandbox=workspace-write + approval=on-request
        args.push('--full-auto')
      } else {
        args.push('--approval-mode', 'untrusted')
        if (config.sandboxEnabled) {
          args.push('--sandbox', 'workspace-write')
        }
      }
      // Working directory
      args.push('-C', config.cwd)
      // Prompt is the final positional arg
      args.push(config.prompt)
    }

    // Spawn the codex process
    const child = spawn(codexBin, args, {
      cwd: config.cwd,
      env: {
        ...process.env,
        ...config.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    config.onProcessSpawned?.(child.pid)

    // Wire up abort
    const abortHandler = () => {
      child.kill('SIGTERM')
    }
    abortController.signal.addEventListener('abort', abortHandler)
    child.once('exit', () => {
      abortController.signal.removeEventListener('abort', abortHandler)
    })

    child.on('error', (err) => {
      console.error('[CodexProvider] Child process error:', err.message)
    })

    return new CodexAgentHandle(child, abortController)
  }
}

// ---------------------------------------------------------------------------
// AgentHandle implementation
// ---------------------------------------------------------------------------

class CodexAgentHandle implements AgentHandle {
  sessionId: string | null = null
  private readonly child: ChildProcess
  private readonly abortController: AbortController
  private readonly mapperState: CodexEventMapperState = {
    sessionId: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    turnCount: 0,
  }

  constructor(child: ChildProcess, abortController: AbortController) {
    this.child = child
    this.abortController = abortController
  }

  get stream(): AsyncIterable<AgentEvent> {
    return this.createEventStream()
  }

  async injectMessage(_text: string): Promise<void> {
    // Codex exec mode doesn't support mid-session message injection.
    // The prompt is provided at spawn time. Injection would require
    // stopping and resuming with a new prompt.
    throw new Error(
      'Codex provider does not support mid-session message injection. ' +
      'Stop and resume with a new prompt instead.'
    )
  }

  async stop(): Promise<void> {
    this.abortController.abort()
  }

  private async *createEventStream(): AsyncGenerator<AgentEvent> {
    const stdout = this.child.stdout
    if (!stdout) {
      yield {
        type: 'error',
        message: 'Codex process has no stdout',
        raw: null,
      }
      return
    }

    // Collect stderr for error reporting
    let stderr = ''
    this.child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    // Parse JSONL lines from stdout
    const rl = createInterface({ input: stdout })
    let hasResult = false

    for await (const line of rl) {
      const trimmed = line.trim()
      if (!trimmed) continue

      let event: CodexEvent
      try {
        event = JSON.parse(trimmed) as CodexEvent
      } catch {
        // Non-JSON output — emit as system event
        yield {
          type: 'system',
          subtype: 'raw_output',
          message: trimmed,
          raw: trimmed,
        }
        continue
      }

      const mapped = mapCodexEvent(event, this.mapperState)
      for (const agentEvent of mapped) {
        if (agentEvent.type === 'init') {
          this.sessionId = this.mapperState.sessionId
        }
        if (agentEvent.type === 'result') {
          hasResult = true
        }
        yield agentEvent
      }
    }

    // Wait for process exit
    const exitCode = await new Promise<number | null>((resolve) => {
      if (this.child.exitCode !== null) {
        resolve(this.child.exitCode)
      } else {
        this.child.once('exit', (code) => resolve(code))
      }
    })

    // If we never got a result event, synthesize one from exit code
    if (!hasResult) {
      if (exitCode === 0) {
        yield {
          type: 'result',
          success: true,
          cost: {
            inputTokens: this.mapperState.totalInputTokens || undefined,
            outputTokens: this.mapperState.totalOutputTokens || undefined,
            numTurns: this.mapperState.turnCount || undefined,
          },
          raw: { exitCode },
        }
      } else {
        yield {
          type: 'result',
          success: false,
          errors: [stderr.trim() || `Codex process exited with code ${exitCode}`],
          errorSubtype: 'process_exit',
          raw: { exitCode, stderr },
        }
      }
    }
  }

}

/**
 * Create a new Codex provider instance
 */
export function createCodexProvider(): CodexProvider {
  return new CodexProvider()
}
