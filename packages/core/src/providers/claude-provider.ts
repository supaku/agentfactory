/**
 * Claude Agent Provider
 *
 * Wraps @anthropic-ai/claude-agent-sdk to implement the AgentProvider interface.
 * Translates Claude SDK's `query()` and `SDKMessage` stream into normalized AgentEvents.
 */

import { spawn } from 'child_process'
import {
  query,
  type SDKMessage,
  type SDKUserMessage,
  type Query,
  type CanUseTool,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentProvider,
  AgentSpawnConfig,
  AgentHandle,
  AgentEvent,
} from './types.js'

/**
 * Programmatic permission handler for autonomous agents.
 *
 * Filesystem-based hooks (.claude/hooks/auto-approve.js) may not load
 * correctly in git worktrees where .git is a file (not a directory),
 * because the SDK's project root resolution can fail to find .claude/.
 *
 * This callback acts as a reliable fallback — it evaluates permissions
 * in-process without filesystem dependencies.
 */
const autonomousCanUseTool: CanUseTool = async (toolName, input) => {
  // Read-only tools: always allow
  if (['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'].includes(toolName)) {
    return { behavior: 'allow' }
  }

  // File write tools: always allow (permissionMode: 'acceptEdits' should
  // handle these, but be explicit as a safety net)
  if (['Write', 'Edit', 'NotebookEdit'].includes(toolName)) {
    return { behavior: 'allow' }
  }

  // Task management and planning
  if (['Task', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList',
       'EnterPlanMode', 'ExitPlanMode', 'Skill'].includes(toolName)) {
    return { behavior: 'allow' }
  }

  // Bash: evaluate command safety
  if (toolName === 'Bash') {
    const cmd = (typeof input.command === 'string' ? input.command : '').trim()
    if (!cmd) return { behavior: 'allow' }

    // Deny destructive patterns
    if (/rm\s+(-[a-z]*f[a-z]*\s+)?\/\s*$/.test(cmd)) {
      return { behavior: 'deny', message: 'rm of filesystem root blocked' }
    }
    if (/git\s+worktree\s+(remove|prune)/.test(cmd)) {
      return { behavior: 'deny', message: 'worktree remove/prune blocked per project rules' }
    }
    if (/git\s+reset\s+--hard/.test(cmd)) {
      return { behavior: 'deny', message: 'reset --hard blocked' }
    }
    if (/git\s+push\b/.test(cmd) && /(--force\b|-f\b)/.test(cmd)) {
      return { behavior: 'deny', message: 'force push blocked' }
    }

    // Allow everything else — autonomous agents run in isolated worktrees
    // managed by the orchestrator, with guardrails at the process level.
    return { behavior: 'allow' }
  }

  // MCP tools: allow all (agents need Linear, Vercel, etc.)
  if (toolName.startsWith('mcp__')) {
    return { behavior: 'allow' }
  }

  // Default: allow — autonomous agents should not be blocked by prompts
  return { behavior: 'allow' }
}

export class ClaudeProvider implements AgentProvider {
  readonly name = 'claude' as const

  spawn(config: AgentSpawnConfig): AgentHandle {
    return this.createHandle(config)
  }

  resume(sessionId: string, config: AgentSpawnConfig): AgentHandle {
    return this.createHandle(config, sessionId)
  }

  private createHandle(config: AgentSpawnConfig, resumeSessionId?: string): AgentHandle {
    const abortController = config.abortController

    // Default allowed tools for autonomous agents — ensures bash commands
    // like `pnpm af-linear`, `git`, `gh` are auto-approved without needing
    // settings.local.json (which isn't available in worktrees).
    // Format: Bash(prefix:glob) — colon separates prefix from wildcard.
    const defaultAllowedTools = config.autonomous
      ? [
          'Bash(pnpm:*)',
          'Bash(git:*)',
          'Bash(gh:*)',
          'Bash(node:*)',
          'Bash(npx:*)',
          'Bash(npm:*)',
          'Bash(tsx:*)',
          'Bash(python3:*)',
          'Bash(python:*)',
          'Bash(curl:*)',
          'Bash(turbo:*)',
          'Bash(tsc:*)',
          'Bash(vitest:*)',
          'Bash(jest:*)',
          'Bash(claude:*)',
          // Non-Node project support: common build tools and shell scripts
          'Bash(make:*)',
          'Bash(cmake:*)',
          'Bash(bash:*)',
          'Bash(sh:*)',
          'Bash(./:*)',
        ]
      : []

    const agentQuery = query({
      prompt: config.prompt,
      options: {
        cwd: config.cwd,
        env: config.env,
        abortController,
        allowedTools: config.allowedTools ?? defaultAllowedTools,
        // Programmatic permission handler for autonomous agents.
        // Filesystem hooks may not resolve in worktrees — this callback
        // ensures headless agents are never blocked by permission prompts.
        canUseTool: config.autonomous ? autonomousCanUseTool : undefined,
        permissionMode: 'acceptEdits',
        disallowedTools: config.autonomous ? ['AskUserQuestion'] : [],
        settingSources: ['project'],
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        resume: resumeSessionId,
        sandbox: config.sandboxEnabled
          ? {
              enabled: true,
              autoAllowBashIfSandboxed: true,
              excludedCommands: ['git', 'gh', 'pnpm', 'npm', 'npx', 'node', 'vercel'],
              network: {
                allowLocalBinding: true,
                allowAllUnixSockets: true,
                allowedDomains: ['*'],
              },
            }
          : { enabled: false },
        spawnClaudeCodeProcess: (spawnOptions) => {
          const nodePath = process.execPath
          const args = spawnOptions.args || []
          const child = spawn(nodePath, args, {
            cwd: spawnOptions.cwd,
            env: spawnOptions.env,
            stdio: ['pipe', 'pipe', 'pipe'],
          })

          config.onProcessSpawned?.(child.pid)

          child.on('error', (err) => {
            console.error('[ClaudeProvider] Child process error:', err.message)
          })

          if (spawnOptions.signal) {
            const abortHandler = () => {
              child.kill('SIGTERM')
            }
            spawnOptions.signal.addEventListener('abort', abortHandler)
            child.once('exit', () => {
              spawnOptions.signal.removeEventListener('abort', abortHandler)
            })
          }

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return child as any
        },
      },
    })

    return new ClaudeAgentHandle(agentQuery, abortController)
  }
}

/**
 * AgentHandle implementation wrapping a Claude SDK Query object.
 */
class ClaudeAgentHandle implements AgentHandle {
  sessionId: string | null = null
  private readonly agentQuery: Query
  private readonly abortController: AbortController

  constructor(agentQuery: Query, abortController: AbortController) {
    this.agentQuery = agentQuery
    this.abortController = abortController
  }

  get stream(): AsyncIterable<AgentEvent> {
    return this.createEventStream()
  }

  async injectMessage(text: string): Promise<void> {
    const sessionId = this.sessionId
    async function* userMessageGenerator(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: 'user',
        message: {
          role: 'user',
          content: text,
        },
        parent_tool_use_id: null,
        session_id: sessionId || '',
      }
    }

    await this.agentQuery.streamInput(userMessageGenerator())
  }

  async stop(): Promise<void> {
    this.abortController.abort()
  }

  /**
   * Returns the underlying Query object for direct access if needed.
   * This is an escape hatch — prefer using the AgentHandle interface.
   */
  getRawQuery(): Query {
    return this.agentQuery
  }

  private async *createEventStream(): AsyncGenerator<AgentEvent> {
    for await (const message of this.agentQuery) {
      const events = this.mapSDKMessage(message)
      for (const event of events) {
        yield event
      }
    }
  }

  /**
   * Map a single SDKMessage to one or more AgentEvents.
   * Most messages map 1:1, but assistant messages with multiple content blocks
   * may produce multiple events.
   */
  private mapSDKMessage(message: SDKMessage): AgentEvent[] {
    switch (message.type) {
      case 'system':
        return this.mapSystemMessage(message)
      case 'user':
        return this.mapUserMessage(message)
      case 'assistant':
        return this.mapAssistantMessage(message)
      case 'result':
        return this.mapResultMessage(message)
      case 'tool_progress':
        return [{
          type: 'tool_progress',
          toolName: message.tool_name,
          elapsedSeconds: message.elapsed_time_seconds,
          raw: message,
        }]
      case 'stream_event':
        // Partial streaming — skip (high frequency, low value for orchestrator)
        return []
      case 'auth_status':
        if (message.error) {
          return [{
            type: 'error',
            message: message.error,
            raw: message,
          }]
        }
        return [{
          type: 'system',
          subtype: 'auth_status',
          message: message.isAuthenticating ? 'Authenticating...' : 'Authenticated',
          raw: message,
        }]
      default:
        return [{
          type: 'system',
          subtype: 'unknown',
          message: `Unhandled message type: ${(message as { type: string }).type}`,
          raw: message,
        }]
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapSystemMessage(message: any): AgentEvent[] {
    if (message.subtype === 'init') {
      this.sessionId = message.session_id
      return [{
        type: 'init',
        sessionId: message.session_id,
        raw: message,
      }]
    }

    return [{
      type: 'system',
      subtype: message.subtype ?? 'unknown',
      message: message.status ?? message.message,
      raw: message,
    }]
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapUserMessage(message: any): AgentEvent[] {
    const events: AgentEvent[] = []

    if (message.message?.content) {
      for (const block of message.message.content) {
        if (
          typeof block === 'object' &&
          block !== null &&
          'type' in block &&
          block.type === 'tool_result' &&
          'content' in block
        ) {
          events.push({
            type: 'tool_result',
            toolUseId: 'tool_use_id' in block ? String(block.tool_use_id) : undefined,
            content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
            isError: 'is_error' in block && block.is_error === true,
            raw: message,
          })
        }
      }
    }

    // If no tool results were extracted, emit as a generic system event
    if (events.length === 0) {
      events.push({
        type: 'system',
        subtype: 'user_message',
        raw: message,
      })
    }

    return events
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapAssistantMessage(message: any): AgentEvent[] {
    const events: AgentEvent[] = []

    if (message.message?.content) {
      for (const block of message.message.content) {
        if (block.type === 'text' && block.text) {
          events.push({
            type: 'assistant_text',
            text: block.text,
            raw: message,
          })
        } else if (block.type === 'tool_use') {
          events.push({
            type: 'tool_use',
            toolName: block.name,
            toolUseId: block.id,
            input: block.input as Record<string, unknown>,
            raw: message,
          })
        }
      }
    }

    return events
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapResultMessage(message: any): AgentEvent[] {
    if (message.subtype === 'success') {
      return [{
        type: 'result',
        success: true,
        message: message.result,
        cost: {
          totalCostUsd: message.total_cost_usd,
          numTurns: message.num_turns,
        },
        raw: message,
      }]
    }

    // Error result
    return [{
      type: 'result',
      success: false,
      errors: 'errors' in message && message.errors ? message.errors : [],
      errorSubtype: message.subtype,
      raw: message,
    }]
  }
}

/**
 * Create a new Claude provider instance
 */
export function createClaudeProvider(): ClaudeProvider {
  return new ClaudeProvider()
}
