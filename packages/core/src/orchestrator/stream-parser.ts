/**
 * Claude Stream-JSON Parser
 *
 * @deprecated This module is dead code — providers now emit normalized AgentEvents
 * directly (see providers/types.ts). Activity emitters consume AgentEvent streams,
 * not ClaudeStreamEvent. Retained for backward compatibility of public type exports.
 * Will be removed in v1.0.
 *
 * Parses Claude's stream-json output format and maps events to handler callbacks.
 * The stream-json format emits newline-delimited JSON events during execution.
 *
 * Event types:
 * - init: Initial message with configuration
 * - system: System messages and prompts
 * - assistant: Assistant text output (partial/streaming)
 * - tool_use: Tool being invoked
 * - tool_result: Result from tool execution
 * - result: Final result when complete
 * - error: Error events
 */

/** Base event structure */
export interface ClaudeStreamEvent {
  type: string
  timestamp?: string
}

/** Initialization event */
export interface ClaudeInitEvent extends ClaudeStreamEvent {
  type: 'init'
  message: string
  sessionId?: string
}

/** System message event */
export interface ClaudeSystemEvent extends ClaudeStreamEvent {
  type: 'system'
  message: string
  subtype?: 'prompt' | 'info' | 'warning'
}

/** Assistant text output event */
export interface ClaudeAssistantEvent extends ClaudeStreamEvent {
  type: 'assistant'
  message: string
  partial?: boolean
}

/** Tool use event - when Claude invokes a tool */
export interface ClaudeToolUseEvent extends ClaudeStreamEvent {
  type: 'tool_use'
  tool: string
  input: Record<string, unknown>
  tool_use_id?: string
}

/** Tool result event - when tool execution completes */
export interface ClaudeToolResultEvent extends ClaudeStreamEvent {
  type: 'tool_result'
  tool: string
  output: string
  tool_use_id?: string
  is_error?: boolean
}

/** Final result event */
export interface ClaudeResultEvent extends ClaudeStreamEvent {
  type: 'result'
  result: string
  cost?: {
    input_tokens: number
    output_tokens: number
  }
  duration_ms?: number
}

/** Error event */
export interface ClaudeErrorEvent extends ClaudeStreamEvent {
  type: 'error'
  error: {
    message: string
    code?: string
    details?: unknown
  }
}

/** Todo item in a user event */
export interface ClaudeTodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm: string
}

/** User event - contains tool results including todo updates */
export interface ClaudeUserEvent extends ClaudeStreamEvent {
  type: 'user'
  message?: {
    role: 'user'
    content?: Array<{
      tool_use_id?: string
      type?: string
      content?: string
    }>
  }
  tool_use_result?: {
    oldTodos?: ClaudeTodoItem[]
    newTodos?: ClaudeTodoItem[]
  }
}

/** Union of all Claude stream event types */
export type ClaudeEvent =
  | ClaudeInitEvent
  | ClaudeSystemEvent
  | ClaudeAssistantEvent
  | ClaudeToolUseEvent
  | ClaudeToolResultEvent
  | ClaudeResultEvent
  | ClaudeErrorEvent
  | ClaudeUserEvent
  | ClaudeStreamEvent // Fallback for unknown events

/** Event handlers for Claude stream events */
export interface ClaudeStreamHandlers {
  onInit?: (event: ClaudeInitEvent) => void | Promise<void>
  onSystem?: (event: ClaudeSystemEvent) => void | Promise<void>
  onAssistant?: (event: ClaudeAssistantEvent) => void | Promise<void>
  onToolUse?: (event: ClaudeToolUseEvent) => void | Promise<void>
  onToolResult?: (event: ClaudeToolResultEvent) => void | Promise<void>
  onResult?: (event: ClaudeResultEvent) => void | Promise<void>
  onError?: (event: ClaudeErrorEvent) => void | Promise<void>
  onUser?: (event: ClaudeUserEvent) => void | Promise<void>
  onTodo?: (
    newTodos: ClaudeTodoItem[],
    oldTodos: ClaudeTodoItem[]
  ) => void | Promise<void>
  onUnknown?: (event: ClaudeStreamEvent) => void | Promise<void>
}

/**
 * Claude Stream Parser
 *
 * @deprecated Providers now emit normalized AgentEvents directly.
 * Activity emitters consume AgentEvent streams, not ClaudeStreamEvent.
 * This class is retained for backward compatibility and will be removed in v1.0.
 */
export class ClaudeStreamParser {
  private buffer = ''
  private handlers: ClaudeStreamHandlers

  constructor(handlers: ClaudeStreamHandlers = {}) {
    this.handlers = handlers
  }

  /**
   * Feed raw data from stdout into the parser
   */
  async feed(data: Buffer | string): Promise<void> {
    this.buffer += data.toString()

    // Process complete lines
    const lines = this.buffer.split('\n')
    // Keep the last incomplete line in buffer
    this.buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (line.trim()) {
        await this.parseLine(line)
      }
    }
  }

  /**
   * Flush any remaining buffered data
   */
  async flush(): Promise<void> {
    if (this.buffer.trim()) {
      await this.parseLine(this.buffer)
      this.buffer = ''
    }
  }

  /**
   * Parse a single JSON line and dispatch to appropriate handler
   */
  private async parseLine(line: string): Promise<void> {
    let event: ClaudeEvent

    try {
      event = JSON.parse(line)
    } catch (error) {
      // Log JSON parse errors with context for debugging
      // This helps diagnose truncated or malformed messages
      const errorMessage = error instanceof Error ? error.message : String(error)
      const linePreview = line.length > 200
        ? line.substring(0, 200) + `... (${line.length} chars total)`
        : line
      console.warn('JSON parse error in stream', {
        error: errorMessage,
        lineLength: line.length,
        linePreview,
      })
      return
    }

    await this.dispatchEvent(event)
  }

  /**
   * Dispatch an event to the appropriate handler
   */
  private async dispatchEvent(event: ClaudeEvent): Promise<void> {
    try {
      switch (event.type) {
        case 'init':
          await this.handlers.onInit?.(event as ClaudeInitEvent)
          break
        case 'system':
          await this.handlers.onSystem?.(event as ClaudeSystemEvent)
          break
        case 'assistant':
          await this.handlers.onAssistant?.(event as ClaudeAssistantEvent)
          break
        case 'tool_use':
          await this.handlers.onToolUse?.(event as ClaudeToolUseEvent)
          break
        case 'tool_result':
          await this.handlers.onToolResult?.(event as ClaudeToolResultEvent)
          break
        case 'result':
          await this.handlers.onResult?.(event as ClaudeResultEvent)
          break
        case 'error':
          await this.handlers.onError?.(event as ClaudeErrorEvent)
          break
        case 'user':
          await this.handleUserEvent(event as ClaudeUserEvent)
          break
        default:
          await this.handlers.onUnknown?.(event)
      }
    } catch (error) {
      console.error(`Error handling ${event.type} event:`, error)
    }
  }

  /**
   * Handle user events, extracting todo updates if present
   */
  private async handleUserEvent(event: ClaudeUserEvent): Promise<void> {
    // Always call onUser if registered
    await this.handlers.onUser?.(event)

    // Check for todo updates in tool_use_result
    if (event.tool_use_result?.newTodos) {
      await this.handlers.onTodo?.(
        event.tool_use_result.newTodos,
        event.tool_use_result.oldTodos ?? []
      )
    }
  }
}

/**
 * Create a new Claude stream parser instance
 */
export function createStreamParser(
  handlers: ClaudeStreamHandlers
): ClaudeStreamParser {
  return new ClaudeStreamParser(handlers)
}
