/**
 * Session Logger
 *
 * Verbose logging of agent sessions for analysis and improvement.
 * Uses JSON Lines format for append efficiency and easy parsing.
 *
 * Logs are stored at: .agent-logs/sessions/{session-id}/
 *   - metadata.json: Session metadata
 *   - events.jsonl: Event log (JSON Lines)
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
} from 'fs'
import { resolve, dirname } from 'path'
import type { AgentWorkType } from '@supaku/agentfactory-linear'

/**
 * Session event types for categorization
 */
export type SessionEventType =
  | 'init' // Session initialized
  | 'tool_use' // Tool was called
  | 'tool_result' // Tool returned result
  | 'assistant' // Assistant message/thought
  | 'user' // User message (e.g., tool result)
  | 'error' // Error occurred
  | 'warning' // Warning (non-fatal issue)
  | 'status' // Status change
  | 'complete' // Session completed
  | 'stop' // Session stopped

/**
 * A single logged event
 */
export interface SessionEvent {
  /** Unix timestamp (milliseconds) */
  timestamp: number
  /** Event type for categorization */
  type: SessionEventType
  /** Tool name (for tool_use/tool_result events) */
  tool?: string
  /** Event content/details */
  content: string | object
  /** Whether this was an error */
  isError?: boolean
  /** Additional metadata */
  metadata?: Record<string, unknown>
}

/**
 * Session metadata stored in metadata.json
 */
export interface SessionMetadata {
  /** Unique session ID */
  sessionId: string
  /** Linear issue ID */
  issueId: string
  /** Human-readable issue identifier */
  issueIdentifier: string
  /** Type of work being performed */
  workType: AgentWorkType
  /** Initial prompt */
  prompt: string
  /** Unix timestamp when session started */
  startedAt: number
  /** Unix timestamp when session ended */
  endedAt?: number
  /** Final status */
  status: 'running' | 'completed' | 'failed' | 'stopped'
  /** Error message if failed */
  errorMessage?: string
  /** PR URL if created */
  pullRequestUrl?: string
  /** Total tool calls count */
  toolCallsCount: number
  /** Total errors count */
  errorsCount: number
  /** Worker ID if remote */
  workerId?: string
}

/**
 * Configuration for SessionLogger
 */
export interface SessionLoggerConfig {
  /** Session ID (used for directory name) */
  sessionId: string
  /** Linear issue ID */
  issueId: string
  /** Human-readable issue identifier */
  issueIdentifier: string
  /** Type of work being performed */
  workType: AgentWorkType
  /** Initial prompt */
  prompt: string
  /** Base directory for logs (default: .agent-logs) */
  logsDir?: string
  /** Worker ID if remote */
  workerId?: string
}

/**
 * SessionLogger handles verbose logging of agent sessions
 */
export class SessionLogger {
  private readonly config: Required<Omit<SessionLoggerConfig, 'workerId'>> & { workerId?: string }
  private readonly sessionDir: string
  private readonly metadataPath: string
  private readonly eventsPath: string
  private metadata: SessionMetadata
  private stopped = false

  constructor(config: SessionLoggerConfig) {
    this.config = {
      ...config,
      logsDir: config.logsDir ?? '.agent-logs',
    }

    // Create session directory path
    this.sessionDir = resolve(this.config.logsDir, 'sessions', this.config.sessionId)
    this.metadataPath = resolve(this.sessionDir, 'metadata.json')
    this.eventsPath = resolve(this.sessionDir, 'events.jsonl')

    // Initialize metadata
    this.metadata = {
      sessionId: this.config.sessionId,
      issueId: this.config.issueId,
      issueIdentifier: this.config.issueIdentifier,
      workType: this.config.workType,
      prompt: this.config.prompt,
      startedAt: Date.now(),
      status: 'running',
      toolCallsCount: 0,
      errorsCount: 0,
      workerId: this.config.workerId,
    }
  }

  /**
   * Initialize the logger - create directory and write initial metadata
   */
  initialize(): void {
    try {
      // Create directory
      if (!existsSync(this.sessionDir)) {
        mkdirSync(this.sessionDir, { recursive: true })
      }

      // Write initial metadata
      this.writeMetadata()

      // Log init event
      this.logEvent({
        timestamp: Date.now(),
        type: 'init',
        content: {
          issueIdentifier: this.config.issueIdentifier,
          workType: this.config.workType,
          promptPreview: this.config.prompt.substring(0, 200),
        },
      })
    } catch (error) {
      // Silently fail - logging is best-effort
      console.warn('SessionLogger: Failed to initialize:', error)
    }
  }

  /**
   * Log a generic event
   */
  logEvent(event: SessionEvent): void {
    if (this.stopped) return

    try {
      const line = JSON.stringify(event) + '\n'
      appendFileSync(this.eventsPath, line)
    } catch {
      // Silently fail
    }
  }

  /**
   * Log a tool use event
   */
  logToolUse(toolName: string, input?: unknown): void {
    this.metadata.toolCallsCount++
    this.logEvent({
      timestamp: Date.now(),
      type: 'tool_use',
      tool: toolName,
      content: {
        tool: toolName,
        input: input ? JSON.stringify(input).substring(0, 2000) : undefined,
      },
    })
  }

  /**
   * Log a tool result event
   */
  logToolResult(toolName: string, result: unknown, isError = false): void {
    if (isError) {
      this.metadata.errorsCount++
    }
    this.logEvent({
      timestamp: Date.now(),
      type: 'tool_result',
      tool: toolName,
      content: {
        tool: toolName,
        result: typeof result === 'string' ? result.substring(0, 2000) : JSON.stringify(result).substring(0, 2000),
      },
      isError,
    })
  }

  /**
   * Log an assistant message/thought
   */
  logAssistant(content: string): void {
    this.logEvent({
      timestamp: Date.now(),
      type: 'assistant',
      content: content.substring(0, 2000),
    })
  }

  /**
   * Log an error
   */
  logError(message: string, error?: unknown, metadata?: Record<string, unknown>): void {
    this.metadata.errorsCount++
    this.logEvent({
      timestamp: Date.now(),
      type: 'error',
      content: {
        message,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack?.substring(0, 500) : undefined,
      },
      isError: true,
      metadata,
    })
  }

  /**
   * Log a warning (non-fatal issue)
   */
  logWarning(message: string, details?: Record<string, unknown>): void {
    this.logEvent({
      timestamp: Date.now(),
      type: 'warning',
      content: {
        message,
        ...details,
      },
    })
  }

  /**
   * Log a status change
   */
  logStatus(status: string, details?: Record<string, unknown>): void {
    this.logEvent({
      timestamp: Date.now(),
      type: 'status',
      content: {
        status,
        ...details,
      },
    })
  }

  /**
   * Finalize the session with a final status
   */
  finalize(
    status: 'completed' | 'failed' | 'stopped',
    options?: {
      errorMessage?: string
      pullRequestUrl?: string
    }
  ): void {
    if (this.stopped) return
    this.stopped = true

    const now = Date.now()

    // Update metadata
    this.metadata.endedAt = now
    this.metadata.status = status
    if (options?.errorMessage) {
      this.metadata.errorMessage = options.errorMessage
    }
    if (options?.pullRequestUrl) {
      this.metadata.pullRequestUrl = options.pullRequestUrl
    }

    // Log completion event
    this.logEvent({
      timestamp: now,
      type: status === 'completed' ? 'complete' : 'stop',
      content: {
        status,
        duration: now - this.metadata.startedAt,
        toolCallsCount: this.metadata.toolCallsCount,
        errorsCount: this.metadata.errorsCount,
        ...options,
      },
    })

    // Write final metadata
    this.writeMetadata()
  }

  /**
   * Get the session directory path
   */
  getSessionDir(): string {
    return this.sessionDir
  }

  /**
   * Get current metadata
   */
  getMetadata(): SessionMetadata {
    return { ...this.metadata }
  }

  /**
   * Write metadata to file
   */
  private writeMetadata(): void {
    try {
      writeFileSync(this.metadataPath, JSON.stringify(this.metadata, null, 2))
    } catch {
      // Silently fail
    }
  }
}

/**
 * Create and initialize a session logger
 */
export function createSessionLogger(config: SessionLoggerConfig): SessionLogger {
  const logger = new SessionLogger(config)
  logger.initialize()
  return logger
}

/**
 * Read session metadata from a session directory
 */
export function readSessionMetadata(sessionDir: string): SessionMetadata | null {
  const metadataPath = resolve(sessionDir, 'metadata.json')
  try {
    if (!existsSync(metadataPath)) return null
    const content = readFileSync(metadataPath, 'utf-8')
    return JSON.parse(content) as SessionMetadata
  } catch {
    return null
  }
}

/**
 * Read events from a session directory
 * Returns an async generator for memory efficiency
 */
export function* readSessionEvents(sessionDir: string): Generator<SessionEvent> {
  const eventsPath = resolve(sessionDir, 'events.jsonl')
  try {
    if (!existsSync(eventsPath)) return
    const content = readFileSync(eventsPath, 'utf-8')
    const lines = content.split('\n').filter((line) => line.trim())
    for (const line of lines) {
      try {
        yield JSON.parse(line) as SessionEvent
      } catch {
        // Skip invalid lines
      }
    }
  } catch {
    // Return empty if file doesn't exist or can't be read
  }
}
