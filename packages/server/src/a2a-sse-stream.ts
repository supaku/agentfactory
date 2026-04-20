/**
 * A2A SSE Streaming
 *
 * Converts AgentFactory session events into A2A SSE events in real-time.
 * Subscribes to session state changes and maps them to:
 *
 * - `TaskStatusUpdate` — session state changes (queued, running, completed, failed)
 * - `TaskArtifactUpdate` — tool outputs / file artifacts
 *
 * Uses the existing `formatSseEvent()` function for SSE wire format.
 */

import { formatSseEvent } from './a2a-server.js'
import { getSessionState } from './session-storage.js'
import type { AgentSessionStatus } from './session-storage.js'
import type {
  A2aTaskStatusUpdateEvent,
  A2aTaskArtifactUpdateEvent,
  A2aTaskEvent,
  A2aTaskStatus,
  A2aMessage,
} from './a2a-types.js'
import { mapSessionStatusToA2a } from './a2a-callback-bridge.js'

const log = {
  info: (msg: string, data?: Record<string, unknown>) => console.log(`[a2a-sse] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) => console.warn(`[a2a-sse] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) => console.error(`[a2a-sse] ${msg}`, data ? JSON.stringify(data) : ''),
  debug: (_msg: string, _data?: Record<string, unknown>) => {},
}

// ---------------------------------------------------------------------------
// Event mapping
// ---------------------------------------------------------------------------

/** Terminal statuses that signal end of SSE stream */
const TERMINAL_STATUSES: Set<A2aTaskStatus> = new Set([
  'completed',
  'failed',
  'canceled',
])

/**
 * Determine if an A2A task status is terminal (stream should close).
 */
export function isTerminalStatus(status: A2aTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

/**
 * Create a TaskStatusUpdate SSE event from a session status change.
 */
export function createStatusUpdateEvent(
  taskId: string,
  sessionStatus: AgentSessionStatus,
  message?: A2aMessage,
): A2aTaskStatusUpdateEvent {
  const a2aStatus = mapSessionStatusToA2a(sessionStatus)
  return {
    type: 'TaskStatusUpdate',
    taskId,
    status: a2aStatus,
    ...(message && { message }),
    final: isTerminalStatus(a2aStatus),
  }
}

/**
 * Create a TaskArtifactUpdate SSE event from a tool output or file artifact.
 */
export function createArtifactUpdateEvent(
  taskId: string,
  name: string,
  content: string,
  mimeType?: string,
): A2aTaskArtifactUpdateEvent {
  return {
    type: 'TaskArtifactUpdate',
    taskId,
    artifact: {
      name,
      parts: mimeType
        ? [{ type: 'file', file: { name, mimeType, uri: undefined, bytes: content } }]
        : [{ type: 'text', text: content }],
    },
  }
}

// ---------------------------------------------------------------------------
// SSE stream types
// ---------------------------------------------------------------------------

/** Event emitted by a session status poller / event source */
export interface SessionStatusEvent {
  sessionId: string
  status: AgentSessionStatus
  message?: string
}

/** Event emitted for artifacts */
export interface SessionArtifactEvent {
  sessionId: string
  name: string
  content: string
  mimeType?: string
}

/** Generic session event union */
export type SessionEvent =
  | { type: 'status'; event: SessionStatusEvent }
  | { type: 'artifact'; event: SessionArtifactEvent }

/**
 * An event source that yields session events.
 * Implementations may use Redis pub/sub, polling, or in-process event bus.
 */
export interface SessionEventSource {
  /** Subscribe to events for a session, yielding them as they arrive */
  subscribe(sessionId: string): AsyncIterable<SessionEvent>
  /** Clean up subscription resources */
  unsubscribe(sessionId: string): void
}

// ---------------------------------------------------------------------------
// Polling-based event source (default for OSS)
// ---------------------------------------------------------------------------

/**
 * A simple polling-based event source that monitors session state changes.
 * Polls the session storage at regular intervals and emits status changes.
 *
 * This is the OSS default — platform deployments will use Redis pub/sub.
 */
export class PollingSessionEventSource implements SessionEventSource {
  private subscriptions = new Map<string, { active: boolean }>()
  private pollIntervalMs: number

  constructor(pollIntervalMs = 2000) {
    this.pollIntervalMs = pollIntervalMs
  }

  async *subscribe(sessionId: string): AsyncIterable<SessionEvent> {
    const sub = { active: true }
    this.subscriptions.set(sessionId, sub)

    let lastStatus: AgentSessionStatus | null = null

    try {
      while (sub.active) {
        const session = await getSessionState(sessionId)

        if (session && session.status !== lastStatus) {
          lastStatus = session.status

          yield {
            type: 'status' as const,
            event: {
              sessionId,
              status: session.status,
            },
          }

          // Stop polling on terminal states
          const a2aStatus = mapSessionStatusToA2a(session.status)
          if (isTerminalStatus(a2aStatus)) {
            break
          }
        }

        // Wait before next poll
        await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs))
      }
    } finally {
      this.subscriptions.delete(sessionId)
    }
  }

  unsubscribe(sessionId: string): void {
    const sub = this.subscriptions.get(sessionId)
    if (sub) {
      sub.active = false
      this.subscriptions.delete(sessionId)
    }
  }
}

// ---------------------------------------------------------------------------
// SSE stream handler
// ---------------------------------------------------------------------------

export interface A2aSseStreamConfig {
  /** Event source for subscribing to session events */
  eventSource: SessionEventSource

  /** Task ID ↔ Session ID resolver */
  getSessionId: (taskId: string) => string | undefined
}

/**
 * Create an SSE Response from session events for a given A2A task.
 *
 * Converts session events to A2A SSE events using `formatSseEvent()`,
 * streams them to the client, and closes the stream on terminal events.
 *
 * @param taskId - The A2A task ID to stream events for
 * @param config - Streaming configuration
 * @returns A Response with SSE content type and streaming body
 */
export function createSseStream(
  taskId: string,
  config: A2aSseStreamConfig,
): Response {
  const { eventSource, getSessionId } = config

  const sessionId = getSessionId(taskId)
  if (!sessionId) {
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32001, message: 'Task not found' },
      }),
      {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      },
    )
  }

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      log.info('SSE stream started', { taskId, sessionId })

      try {
        for await (const sessionEvent of eventSource.subscribe(sessionId)) {
          let a2aEvent: A2aTaskEvent

          switch (sessionEvent.type) {
            case 'status': {
              const message: A2aMessage | undefined = sessionEvent.event.message
                ? {
                    role: 'agent',
                    parts: [{ type: 'text', text: sessionEvent.event.message }],
                  }
                : undefined

              a2aEvent = createStatusUpdateEvent(
                taskId,
                sessionEvent.event.status,
                message,
              )
              break
            }

            case 'artifact': {
              a2aEvent = createArtifactUpdateEvent(
                taskId,
                sessionEvent.event.name,
                sessionEvent.event.content,
                sessionEvent.event.mimeType,
              )
              break
            }

            default:
              // Skip unknown event types silently
              continue
          }

          const formatted = formatSseEvent(a2aEvent)
          controller.enqueue(encoder.encode(formatted))

          // Close stream on terminal status
          if (
            a2aEvent.type === 'TaskStatusUpdate' &&
            a2aEvent.final
          ) {
            log.info('SSE stream closing (terminal status)', {
              taskId,
              status: a2aEvent.status,
            })
            break
          }
        }
      } catch (error) {
        log.error('SSE stream error', { taskId, error })

        // Send a final error event before closing
        const errorEvent = createStatusUpdateEvent(taskId, 'failed')
        const formatted = formatSseEvent(errorEvent)
        controller.enqueue(encoder.encode(formatted))
      } finally {
        eventSource.unsubscribe(sessionId)
        controller.close()
        log.info('SSE stream closed', { taskId })
      }
    },

    cancel() {
      log.info('SSE stream canceled by client', { taskId, sessionId })
      eventSource.unsubscribe(sessionId!)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
