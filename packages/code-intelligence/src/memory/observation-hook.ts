/**
 * Observation Capture Hook
 *
 * PostToolUse-style hook that extracts structured observations from
 * agent tool calls. This is the write side of agent memory — it
 * produces observations that are stored for cross-session retrieval.
 *
 * Design principles:
 * - LLM-free extraction first (structured parsing of tool inputs/outputs)
 * - Lightweight — observation extraction is synchronous, persistence is deferred
 * - Never throws — errors in extraction are caught and logged
 * - No-op when memory is disabled
 */

import type {
  Observation,
  ObservationSink,
  FileOperationType,
} from './observations.js'

// ── Tool Event Types ─────────────────────────────────────────────────

/**
 * Normalized tool event consumed by the observation hook.
 * This is provider-agnostic — the orchestrator maps native events to this format.
 */
export interface ToolEvent {
  /** Tool name (e.g., 'Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob') */
  toolName: string
  /** Tool input parameters */
  input: Record<string, unknown>
  /** Tool output content (may be truncated for large outputs) */
  output?: string
  /** Whether the tool call resulted in an error */
  isError?: boolean
}

// ── Hook Configuration ───────────────────────────────────────────────

export interface ObservationHookConfig {
  /** Session ID for scoping observations */
  sessionId: string
  /** Project scope (e.g., repo path or project name) */
  projectScope: string
  /** Sink to emit observations to */
  sink: ObservationSink
  /** Whether memory capture is enabled (default: true) */
  enabled?: boolean
}

// ── Hook Implementation ──────────────────────────────────────────────

let idCounter = 0

function generateObservationId(sessionId: string): string {
  return `obs_${sessionId}_${Date.now()}_${++idCounter}`
}

/**
 * Create an observation capture hook for processing tool events.
 *
 * Returns a function that should be called after each tool execution.
 * The hook extracts structured observations from tool calls and emits
 * them to the configured sink.
 *
 * @example
 * ```typescript
 * const hook = createObservationHook({
 *   sessionId: 'session-123',
 *   projectScope: 'github.com/org/repo',
 *   sink: new InMemoryObservationSink(),
 * })
 *
 * // Call after each tool execution
 * await hook({ toolName: 'Read', input: { file_path: '/src/index.ts' }, output: '...' })
 * ```
 */
export function createObservationHook(
  config: ObservationHookConfig,
): (event: ToolEvent) => Promise<void> {
  const { sessionId, projectScope, sink, enabled = true } = config

  return async (event: ToolEvent): Promise<void> => {
    if (!enabled) return

    try {
      const observation = extractObservation(event, sessionId, projectScope)
      if (observation) {
        await sink.emit(observation)
      }
    } catch {
      // Never propagate errors from observation extraction
    }
  }
}

// ── Extraction Logic ─────────────────────────────────────────────────

/**
 * Extract a structured observation from a tool event.
 * Returns null if no meaningful observation can be extracted.
 */
export function extractObservation(
  event: ToolEvent,
  sessionId: string,
  projectScope: string,
): Observation | null {
  // Route to type-specific extractors
  if (event.isError) {
    return extractErrorObservation(event, sessionId, projectScope)
  }

  const fileOp = getFileOperationType(event.toolName)
  if (fileOp) {
    return extractFileObservation(event, fileOp, sessionId, projectScope)
  }

  // Bash commands may contain file operations or decisions
  if (event.toolName === 'Bash') {
    return extractBashObservation(event, sessionId, projectScope)
  }

  return null
}

// ── File Operation Extraction ────────────────────────────────────────

const TOOL_TO_FILE_OP: Record<string, FileOperationType> = {
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  Glob: 'glob',
  Grep: 'grep',
}

function getFileOperationType(toolName: string): FileOperationType | null {
  return TOOL_TO_FILE_OP[toolName] ?? null
}

function extractFileObservation(
  event: ToolEvent,
  opType: FileOperationType,
  sessionId: string,
  projectScope: string,
): Observation | null {
  const filePath = extractFilePath(event)
  if (!filePath) return null

  const summary = buildFileSummary(event, opType)

  return {
    id: generateObservationId(sessionId),
    type: 'file_operation',
    content: `${opType} ${filePath}: ${summary}`,
    sessionId,
    projectScope,
    timestamp: Date.now(),
    source: 'auto_capture',
    weight: 1.0,
    detail: {
      filePath,
      operationType: opType,
      summary,
    },
  }
}

function extractFilePath(event: ToolEvent): string | null {
  const input = event.input
  // Common input field names for file paths
  if (typeof input.file_path === 'string') return input.file_path
  if (typeof input.filePath === 'string') return input.filePath
  if (typeof input.path === 'string') return input.path
  if (typeof input.pattern === 'string') return input.pattern
  return null
}

function buildFileSummary(event: ToolEvent, opType: FileOperationType): string {
  const input = event.input

  switch (opType) {
    case 'read':
      return `Read file${input.offset ? ` from line ${input.offset}` : ''}`
    case 'write':
      return 'Wrote file content'
    case 'edit': {
      const oldStr = typeof input.old_string === 'string' ? input.old_string : ''
      const maxLen = 80
      const preview = oldStr.length > maxLen ? oldStr.slice(0, maxLen) + '...' : oldStr
      return `Edited: replaced "${preview}"`
    }
    case 'glob':
      return `Searched for pattern: ${input.pattern ?? 'unknown'}`
    case 'grep': {
      const pattern = typeof input.pattern === 'string' ? input.pattern : 'unknown'
      return `Searched for: ${pattern}`
    }
    default:
      return `${opType} operation`
  }
}

// ── Bash Observation Extraction ──────────────────────────────────────

function extractBashObservation(
  event: ToolEvent,
  sessionId: string,
  projectScope: string,
): Observation | null {
  const command = typeof event.input.command === 'string' ? event.input.command : ''
  if (!command) return null

  // Detect git operations
  if (command.startsWith('git ') || command.includes(' git ')) {
    return {
      id: generateObservationId(sessionId),
      type: 'file_operation',
      content: `bash: ${truncate(command, 200)}`,
      sessionId,
      projectScope,
      timestamp: Date.now(),
      source: 'auto_capture',
      weight: 0.5,
      detail: {
        filePath: '.',
        operationType: 'write',
        summary: `Git command: ${truncate(command, 120)}`,
      },
    }
  }

  // Detect test/build commands
  if (command.includes('pnpm test') || command.includes('pnpm build') ||
      command.includes('pnpm typecheck') || command.includes('npm test') ||
      command.includes('npm build')) {
    return {
      id: generateObservationId(sessionId),
      type: 'file_operation',
      content: `bash: ${truncate(command, 200)}`,
      sessionId,
      projectScope,
      timestamp: Date.now(),
      source: 'auto_capture',
      weight: 0.5,
      detail: {
        filePath: '.',
        operationType: 'read',
        summary: `Build/test: ${truncate(command, 120)}`,
      },
    }
  }

  return null
}

// ── Error Observation Extraction ─────────────────────────────────────

function extractErrorObservation(
  event: ToolEvent,
  sessionId: string,
  projectScope: string,
): Observation | null {
  const output = event.output ?? 'Unknown error'
  const errorSummary = truncate(output, 500)

  return {
    id: generateObservationId(sessionId),
    type: 'error_encountered',
    content: `Error in ${event.toolName}: ${errorSummary}`,
    sessionId,
    projectScope,
    timestamp: Date.now(),
    source: 'auto_capture',
    weight: 1.5, // Errors are more valuable for future sessions
    detail: {
      error: errorSummary,
      fix: undefined,
    },
  }
}

// ── Utilities ────────────────────────────────────────────────────────

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen) + '...'
}

/**
 * Reset the internal ID counter (for testing only).
 */
export function resetIdCounter(): void {
  idCounter = 0
}
