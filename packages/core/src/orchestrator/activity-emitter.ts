/**
 * Linear Activity Emitter
 *
 * Emits Claude stream events to Linear as agent activities.
 * Handles rate limiting by batching rapid activities and
 * truncating long outputs.
 *
 * Mapping:
 * - assistant message → response (persisted, user-directed communication)
 * - tool_use → action (ephemeral)
 * - tool_result → action (ephemeral)
 * - result → response (persisted)
 * - error → error (persisted)
 */

import type { AgentSession } from '@supaku/agentfactory-linear'
import type {
  ClaudeAssistantEvent,
  ClaudeToolUseEvent,
  ClaudeToolResultEvent,
  ClaudeResultEvent,
  ClaudeErrorEvent,
  ClaudeTodoItem,
  ClaudeStreamHandlers,
} from './stream-parser.js'
import type { AgentPlanItemState } from '@supaku/agentfactory-linear'
import { ENVIRONMENT_ISSUE_TYPES } from '@supaku/agentfactory-linear'

/** Configuration for the activity emitter */
export interface ActivityEmitterConfig {
  /** AgentSession to emit activities to */
  session: AgentSession
  /** Minimum interval between activities in ms (default: 500ms) */
  minInterval?: number
  /** Maximum length for tool outputs before truncation (default: 2000) */
  maxOutputLength?: number
  /** Whether to include timestamps in activities (default: false) */
  includeTimestamps?: boolean
  /** Optional callback when an activity is emitted */
  onActivityEmitted?: (type: string, content: string) => void
  /** Optional callback when an activity is throttled */
  onActivityThrottled?: (type: string, content: string) => void
}

interface QueuedActivity {
  type: 'thought' | 'action' | 'response' | 'error'
  content: string
  ephemeral: boolean
  toolName?: string
  toolInput?: Record<string, unknown>
  toolOutput?: string
}

const DEFAULT_MIN_INTERVAL = 500
const DEFAULT_MAX_OUTPUT_LENGTH = 2000

/**
 * Map Claude todo status to Linear plan item state
 */
function mapTodoStatusToLinearState(
  status: ClaudeTodoItem['status']
): AgentPlanItemState {
  switch (status) {
    case 'pending':
      return 'pending'
    case 'in_progress':
      return 'inProgress'
    case 'completed':
      return 'completed'
    default:
      return 'pending'
  }
}

/**
 * Activity Emitter
 *
 * Handles rate-limited emission of Claude events to Linear activities.
 */
export class ActivityEmitter {
  private readonly session: AgentSession
  private readonly minInterval: number
  private readonly maxOutputLength: number
  private readonly includeTimestamps: boolean
  private readonly onActivityEmitted?: (type: string, content: string) => void
  private readonly onActivityThrottled?: (type: string, content: string) => void

  private lastEmitTime = 0
  private queue: QueuedActivity[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private isProcessing = false
  // Track reported tool error signatures for deduplication
  private readonly reportedToolErrors: Set<string> = new Set()

  constructor(config: ActivityEmitterConfig) {
    this.session = config.session
    this.minInterval = config.minInterval ?? DEFAULT_MIN_INTERVAL
    this.maxOutputLength = config.maxOutputLength ?? DEFAULT_MAX_OUTPUT_LENGTH
    this.includeTimestamps = config.includeTimestamps ?? false
    this.onActivityEmitted = config.onActivityEmitted
    this.onActivityThrottled = config.onActivityThrottled
  }

  /**
   * Emit a thought activity (persistent by default for visibility in Linear)
   */
  async emitThought(content: string, ephemeral = false): Promise<void> {
    await this.queueActivity({
      type: 'thought',
      content,
      ephemeral,
    })
  }

  /**
   * Emit a tool use activity (ephemeral by default)
   */
  async emitToolUse(
    tool: string,
    input: Record<string, unknown>,
    ephemeral = true
  ): Promise<void> {
    const inputSummary = this.summarizeToolInput(tool, input)
    await this.queueActivity({
      type: 'action',
      content: `${tool}: ${inputSummary}`,
      ephemeral,
      toolName: tool,
      toolInput: input,
    })
  }

  /**
   * Emit a response activity (persisted)
   */
  async emitResponse(content: string): Promise<void> {
    await this.queueActivity({
      type: 'response',
      content,
      ephemeral: false,
    })
  }

  /**
   * Emit an error activity (persisted)
   */
  async emitError(error: Error | string): Promise<void> {
    const message = error instanceof Error ? error.message : error
    await this.queueActivity({
      type: 'error',
      content: message,
      ephemeral: false,
    })
  }

  /**
   * Report a tool error as a Linear issue for tracking and improvement.
   * Creates a bug in the Agent project backlog.
   *
   * @param toolName - Name of the tool that errored
   * @param errorMessage - The error message
   * @param context - Additional context about the error
   * @returns The created issue, or null if creation failed or was deduplicated
   */
  async reportToolError(
    toolName: string,
    errorMessage: string,
    context?: {
      issueIdentifier?: string
      additionalContext?: Record<string, unknown>
    }
  ): Promise<{ id: string; identifier: string; url: string } | null> {
    // Deduplicate using tool name + first 100 chars of error
    const signature = `${toolName}:${errorMessage.substring(0, 100)}`
    if (this.reportedToolErrors.has(signature)) {
      return null
    }
    this.reportedToolErrors.add(signature)

    try {
      return await this.session.reportEnvironmentIssue(
        `Tool error: ${toolName}`,
        `The agent encountered an error while using the **${toolName}** tool.\n\n**Error:**\n\`\`\`\n${errorMessage}\n\`\`\``,
        {
          issueType: ENVIRONMENT_ISSUE_TYPES.TOOL,
          sourceIssueId: context?.issueIdentifier,
          additionalContext: {
            toolName,
            ...context?.additionalContext,
          },
        }
      )
    } catch (error) {
      console.error('[ActivityEmitter] Failed to report tool error:', error)
      return null
    }
  }

  /**
   * Get Claude stream handlers that emit to Linear
   */
  getStreamHandlers(): ClaudeStreamHandlers {
    return {
      onAssistant: async (event: ClaudeAssistantEvent) => {
        // Skip partial messages (streaming updates)
        if (event.partial) return

        // Assistant messages are user-directed communication, emit as response (persisted)
        await this.queueActivity({
          type: 'response',
          content: event.message,
          ephemeral: false,
        })
      },

      onToolUse: async (event: ClaudeToolUseEvent) => {
        const inputSummary = this.summarizeToolInput(event.tool, event.input)
        await this.queueActivity({
          type: 'action',
          content: `${event.tool}: ${inputSummary}`,
          ephemeral: true,
          toolName: event.tool,
          toolInput: event.input,
        })
      },

      onToolResult: async (event: ClaudeToolResultEvent) => {
        const output = this.truncateOutput(event.output)
        const prefix = event.is_error ? 'Error' : 'Result'
        await this.queueActivity({
          type: 'action',
          content: `${event.tool} ${prefix}: ${output}`,
          ephemeral: true,
          toolName: event.tool,
          toolOutput: output,
        })
      },

      onResult: async (event: ClaudeResultEvent) => {
        // Final result - persisted as response
        const content = this.formatResultContent(event)
        await this.queueActivity({
          type: 'response',
          content,
          ephemeral: false,
        })
      },

      onError: async (event: ClaudeErrorEvent) => {
        // Errors are persisted
        await this.queueActivity({
          type: 'error',
          content: event.error.message,
          ephemeral: false,
        })
      },

      onTodo: async (newTodos: ClaudeTodoItem[]) => {
        // Map Claude todos to Linear plan items
        const planItems = newTodos.map((todo) => ({
          title: todo.content,
          state: mapTodoStatusToLinearState(todo.status),
          details: todo.activeForm,
        }))

        // Update the plan via session
        try {
          await this.session.updatePlan(planItems)
        } catch (error) {
          console.error('Failed to update plan:', error)
        }
      },
    }
  }

  /**
   * Queue an activity for emission with rate limiting
   */
  private async queueActivity(activity: QueuedActivity): Promise<void> {
    this.queue.push(activity)

    // Schedule flush if not already scheduled
    if (!this.flushTimer && !this.isProcessing) {
      const timeSinceLastEmit = Date.now() - this.lastEmitTime
      const delay = Math.max(0, this.minInterval - timeSinceLastEmit)

      this.flushTimer = setTimeout(() => {
        this.flushTimer = null
        this.processQueue()
      }, delay)
    }
  }

  /**
   * Process queued activities
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) return

    this.isProcessing = true

    try {
      // Merge similar consecutive activities to reduce API calls
      const merged = this.mergeQueuedActivities()

      for (const activity of merged) {
        await this.emitActivity(activity)
        this.lastEmitTime = Date.now()

        // Small delay between emissions to avoid rate limits
        if (merged.length > 1) {
          await this.delay(100)
        }
      }
    } finally {
      this.isProcessing = false

      // If more activities were queued during processing, schedule another flush
      if (this.queue.length > 0 && !this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null
          this.processQueue()
        }, this.minInterval)
      }
    }
  }

  /**
   * Merge consecutive similar activities in the queue
   */
  private mergeQueuedActivities(): QueuedActivity[] {
    const activities = [...this.queue]
    this.queue = []

    if (activities.length <= 1) return activities

    const merged: QueuedActivity[] = []
    let current = activities[0]

    for (let i = 1; i < activities.length; i++) {
      const next = activities[i]

      // Merge consecutive thoughts
      if (
        current.type === 'thought' &&
        next.type === 'thought' &&
        current.ephemeral === next.ephemeral
      ) {
        current = {
          ...current,
          content: `${current.content}\n\n${next.content}`,
        }
        this.onActivityThrottled?.('thought', next.content)
        continue
      }

      // Merge consecutive tool results for same tool
      if (
        current.type === 'action' &&
        next.type === 'action' &&
        current.toolName === next.toolName &&
        current.ephemeral === next.ephemeral
      ) {
        current = {
          ...current,
          content: `${current.content}\n${next.content}`,
        }
        this.onActivityThrottled?.('action', next.content)
        continue
      }

      merged.push(current)
      current = next
    }

    merged.push(current)
    return merged
  }

  /**
   * Emit a single activity to Linear
   */
  private async emitActivity(activity: QueuedActivity): Promise<void> {
    try {
      const content = this.includeTimestamps
        ? `[${new Date().toISOString()}] ${activity.content}`
        : activity.content

      switch (activity.type) {
        case 'thought':
          await this.session.emitThought(content, activity.ephemeral)
          break

        case 'action':
          if (activity.toolName && activity.toolInput) {
            await this.session.emitAction(
              activity.toolName,
              activity.toolInput,
              activity.ephemeral
            )
          } else if (activity.toolName && activity.toolOutput) {
            await this.session.emitToolResult(
              activity.toolName,
              activity.toolOutput,
              activity.ephemeral
            )
          } else {
            // Generic action - emit as thought
            await this.session.emitThought(content, activity.ephemeral)
          }
          break

        case 'response':
          await this.session.emitResponse(content)
          break

        case 'error':
          await this.session.emitError(new Error(content))
          break
      }

      this.onActivityEmitted?.(activity.type, content)
    } catch (error) {
      console.error(`Failed to emit ${activity.type} activity:`, error)
    }
  }

  /**
   * Summarize tool input for display
   */
  private summarizeToolInput(
    tool: string,
    input: Record<string, unknown>
  ): string {
    // Tool-specific summaries
    switch (tool) {
      case 'Read':
        return String(input.file_path || input.path || 'file')
      case 'Write':
        return String(input.file_path || input.path || 'file')
      case 'Edit':
        return String(input.file_path || input.path || 'file')
      case 'Grep':
        return `"${input.pattern}" in ${input.path || '.'}`
      case 'Glob':
        return String(input.pattern || '*')
      case 'Bash':
        const cmd = String(input.command || '')
        return cmd.length > 50 ? cmd.substring(0, 47) + '...' : cmd
      case 'Task':
        return String(input.description || input.prompt || 'task')
      default:
        // Generic: show first string value or truncated JSON
        const firstStringValue = Object.values(input).find(
          (v) => typeof v === 'string'
        ) as string | undefined
        if (firstStringValue) {
          return firstStringValue.length > 50
            ? firstStringValue.substring(0, 47) + '...'
            : firstStringValue
        }
        const json = JSON.stringify(input)
        return json.length > 50 ? json.substring(0, 47) + '...' : json
    }
  }

  /**
   * Truncate long output strings
   */
  private truncateOutput(output: string): string {
    if (output.length <= this.maxOutputLength) return output
    return (
      output.substring(0, this.maxOutputLength) +
      `\n\n... (truncated ${output.length - this.maxOutputLength} chars)`
    )
  }

  /**
   * Format the final result content
   */
  private formatResultContent(event: ClaudeResultEvent): string {
    let content = event.result

    if (event.cost) {
      content += `\n\n---\n*Tokens: ${event.cost.input_tokens} in / ${event.cost.output_tokens} out*`
    }

    if (event.duration_ms) {
      const seconds = (event.duration_ms / 1000).toFixed(1)
      content += event.cost ? ` | *Duration: ${seconds}s*` : `\n\n---\n*Duration: ${seconds}s*`
    }

    return content
  }

  /**
   * Flush all pending activities immediately
   */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    await this.processQueue()
  }

  /**
   * Helper delay function
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

/**
 * Create an activity emitter instance
 */
export function createActivityEmitter(
  config: ActivityEmitterConfig
): ActivityEmitter {
  return new ActivityEmitter(config)
}
