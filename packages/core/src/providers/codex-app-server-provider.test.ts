import { describe, it, expect } from 'vitest'
import {
  mapAppServerNotification,
  mapAppServerItemEvent,
  normalizeMcpToolName,
  resolveSandboxPolicy,
  resolveCodexModel,
  calculateCostUsd,
  CODEX_MODEL_MAP,
  CODEX_DEFAULT_MODEL,
  CODEX_PRICING,
  CODEX_DEFAULT_PRICING,
  type AppServerEventMapperState,
  type JsonRpcNotification,
} from './codex-app-server-provider.js'
import type { AgentSpawnConfig } from './types.js'

function freshState(): AppServerEventMapperState {
  return {
    sessionId: null,
    model: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCachedInputTokens: 0,
    turnCount: 0,
  }
}

// ---------------------------------------------------------------------------
// mapAppServerNotification
// ---------------------------------------------------------------------------

describe('mapAppServerNotification', () => {
  // --- Thread lifecycle ---

  it('maps thread/started to init', () => {
    const state = freshState()
    const notification: JsonRpcNotification = {
      method: 'thread/started',
      params: { thread: { id: 'thr_abc' } },
    }
    const result = mapAppServerNotification(notification, state)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: 'init',
      sessionId: 'thr_abc',
    })
    expect(state.sessionId).toBe('thr_abc')
  })

  it('maps thread/started without thread to empty array', () => {
    const state = freshState()
    const notification: JsonRpcNotification = {
      method: 'thread/started',
      params: {},
    }
    const result = mapAppServerNotification(notification, state)
    expect(result).toHaveLength(0)
  })

  it('maps thread/closed to system event', () => {
    const state = freshState()
    const notification: JsonRpcNotification = {
      method: 'thread/closed',
      params: { threadId: 'thr_abc' },
    }
    const result = mapAppServerNotification(notification, state)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'thread_closed',
    })
  })

  it('maps thread/status/changed to system event', () => {
    const state = freshState()
    const notification: JsonRpcNotification = {
      method: 'thread/status/changed',
      params: { threadId: 'thr_abc', status: 'idle' },
    }
    const result = mapAppServerNotification(notification, state)

    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'thread_status_changed',
    })
  })

  // --- Turn lifecycle ---

  it('maps turn/started with incrementing turn count', () => {
    const state = freshState()
    const notification: JsonRpcNotification = {
      method: 'turn/started',
      params: { turn: { id: 'turn_1' } },
    }

    const r1 = mapAppServerNotification(notification, state)
    expect(r1[0]).toMatchObject({
      type: 'system',
      subtype: 'turn_started',
      message: 'Turn 1 started (turn_1)',
    })
    expect(state.turnCount).toBe(1)

    const r2 = mapAppServerNotification(notification, state)
    expect(r2[0]).toMatchObject({
      message: 'Turn 2 started (turn_1)',
    })
    expect(state.turnCount).toBe(2)
  })

  it('maps turn/started without turn id', () => {
    const state = freshState()
    const notification: JsonRpcNotification = {
      method: 'turn/started',
      params: {},
    }
    const result = mapAppServerNotification(notification, state)
    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'turn_started',
      message: 'Turn 1 started',
    })
  })

  it('maps turn/completed (success) with usage', () => {
    const state = freshState()
    state.turnCount = 1
    state.model = 'gpt-5-codex'

    const notification: JsonRpcNotification = {
      method: 'turn/completed',
      params: {
        turn: {
          id: 'turn_1',
          status: 'completed',
          usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 20 },
        },
      },
    }
    const result = mapAppServerNotification(notification, state)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: 'result',
      success: true,
      cost: {
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 20,
        numTurns: 1,
      },
    })
    expect((result[0] as any).cost.totalCostUsd).toBeGreaterThan(0)
    expect(state.totalInputTokens).toBe(100)
    expect(state.totalOutputTokens).toBe(50)
    expect(state.totalCachedInputTokens).toBe(20)
  })

  it('accumulates usage across multiple turns', () => {
    const state = freshState()
    state.turnCount = 2
    state.model = 'gpt-5-codex'

    mapAppServerNotification({
      method: 'turn/completed',
      params: { turn: { id: 't1', status: 'completed', usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 10 } } },
    }, state)

    const result = mapAppServerNotification({
      method: 'turn/completed',
      params: { turn: { id: 't2', status: 'completed', usage: { input_tokens: 200, output_tokens: 80, cached_input_tokens: 30 } } },
    }, state)

    expect(result[0]).toMatchObject({
      type: 'result',
      success: true,
      cost: { inputTokens: 300, outputTokens: 130, cachedInputTokens: 40 },
    })
    expect((result[0] as any).cost.totalCostUsd).toBeGreaterThan(0)
    expect(state.totalCachedInputTokens).toBe(40)
  })

  it('maps turn/completed (failed) with error', () => {
    const state = freshState()
    const notification: JsonRpcNotification = {
      method: 'turn/completed',
      params: {
        turn: {
          id: 'turn_1',
          status: 'failed',
          error: { message: 'Context window exceeded', codexErrorInfo: 'ContextWindowExceeded' },
        },
      },
    }
    const result = mapAppServerNotification(notification, state)

    expect(result[0]).toMatchObject({
      type: 'result',
      success: false,
      errors: ['Context window exceeded'],
      errorSubtype: 'ContextWindowExceeded',
    })
  })

  it('maps turn/completed (failed) without error message', () => {
    const state = freshState()
    const result = mapAppServerNotification({
      method: 'turn/completed',
      params: { turn: { id: 'turn_1', status: 'failed' } },
    }, state)

    expect(result[0]).toMatchObject({
      type: 'result',
      success: false,
      errors: ['Turn failed'],
    })
  })

  it('maps turn/completed (interrupted)', () => {
    const state = freshState()
    const result = mapAppServerNotification({
      method: 'turn/completed',
      params: { turn: { id: 'turn_1', status: 'interrupted' } },
    }, state)

    expect(result[0]).toMatchObject({
      type: 'result',
      success: false,
      errors: ['Turn was interrupted'],
      errorSubtype: 'interrupted',
    })
  })

  it('maps turn/completed without turn object (defaults to completed)', () => {
    const state = freshState()
    const result = mapAppServerNotification({
      method: 'turn/completed',
      params: {},
    }, state)

    expect(result[0]).toMatchObject({
      type: 'result',
      success: true,
    })
  })

  // --- Item deltas (streaming) ---

  it('maps item/agentMessage/delta to assistant_text', () => {
    const state = freshState()
    const result = mapAppServerNotification({
      method: 'item/agentMessage/delta',
      params: { text: 'Hello world' },
    }, state)

    expect(result[0]).toMatchObject({
      type: 'assistant_text',
      text: 'Hello world',
    })
  })

  it('maps item/agentMessage/delta with empty text to empty array', () => {
    const state = freshState()
    const result = mapAppServerNotification({
      method: 'item/agentMessage/delta',
      params: {},
    }, state)
    expect(result).toHaveLength(0)
  })

  it('maps item/reasoning/summaryTextDelta to reasoning', () => {
    const state = freshState()
    const result = mapAppServerNotification({
      method: 'item/reasoning/summaryTextDelta',
      params: { text: 'Thinking about the problem...' },
    }, state)

    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'reasoning',
      message: 'Thinking about the problem...',
    })
  })

  it('maps item/commandExecution/outputDelta to command_progress', () => {
    const state = freshState()
    const result = mapAppServerNotification({
      method: 'item/commandExecution/outputDelta',
      params: { delta: 'Installing packages...' },
    }, state)

    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'command_progress',
      message: 'Installing packages...',
    })
  })

  // --- Turn diff/plan ---

  it('maps turn/diff/updated to system event', () => {
    const state = freshState()
    const result = mapAppServerNotification({
      method: 'turn/diff/updated',
      params: { diff: '--- a/file.ts\n+++ b/file.ts' },
    }, state)

    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'diff_updated',
      message: '--- a/file.ts\n+++ b/file.ts',
    })
  })

  it('maps turn/plan/updated to system event', () => {
    const state = freshState()
    const result = mapAppServerNotification({
      method: 'turn/plan/updated',
      params: { plan: { steps: ['step1'] } },
    }, state)

    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'plan_updated',
    })
  })

  // --- Unknown notifications ---

  it('handles unknown notification method', () => {
    const state = freshState()
    const result = mapAppServerNotification({
      method: 'some/unknown/method',
      params: {},
    }, state)

    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'unknown',
      message: 'Unhandled App Server notification: some/unknown/method',
    })
  })

  // --- Item lifecycle (delegates) ---

  it('delegates item/started to mapAppServerItemEvent', () => {
    const state = freshState()
    const result = mapAppServerNotification({
      method: 'item/started',
      params: {
        item: { id: 'cmd-1', type: 'commandExecution', command: 'ls -la' },
      },
    }, state)

    expect(result[0]).toMatchObject({
      type: 'tool_use',
      toolName: 'shell',
      toolUseId: 'cmd-1',
      input: { command: 'ls -la' },
    })
  })

  it('delegates item/completed to mapAppServerItemEvent', () => {
    const state = freshState()
    const result = mapAppServerNotification({
      method: 'item/completed',
      params: {
        item: { id: 'msg-1', type: 'agentMessage', text: 'Done!' },
      },
    }, state)

    expect(result[0]).toMatchObject({
      type: 'assistant_text',
      text: 'Done!',
    })
  })
})

// ---------------------------------------------------------------------------
// mapAppServerItemEvent
// ---------------------------------------------------------------------------

describe('mapAppServerItemEvent', () => {
  it('maps agentMessage item.completed to assistant_text', () => {
    const result = mapAppServerItemEvent('item/completed', {
      item: { id: 'msg-1', type: 'agentMessage', text: 'Analysis complete' },
    })

    expect(result).toEqual([{
      type: 'assistant_text',
      text: 'Analysis complete',
      raw: { method: 'item/completed', params: { item: { id: 'msg-1', type: 'agentMessage', text: 'Analysis complete' } } },
    }])
  })

  it('returns empty for agentMessage item.started', () => {
    const result = mapAppServerItemEvent('item/started', {
      item: { id: 'msg-1', type: 'agentMessage', text: '' },
    })
    expect(result).toHaveLength(0)
  })

  it('maps reasoning item to system event', () => {
    const result = mapAppServerItemEvent('item/completed', {
      item: { id: 'r-1', type: 'reasoning', summary: 'Thinking about it...' },
    })

    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'reasoning',
      message: 'Thinking about it...',
    })
  })

  it('maps commandExecution item.started to tool_use', () => {
    const result = mapAppServerItemEvent('item/started', {
      item: { id: 'cmd-1', type: 'commandExecution', command: 'npm test' },
    })

    expect(result[0]).toMatchObject({
      type: 'tool_use',
      toolName: 'shell',
      toolUseId: 'cmd-1',
      input: { command: 'npm test' },
    })
  })

  it('maps commandExecution item.completed to tool_result (success)', () => {
    const result = mapAppServerItemEvent('item/completed', {
      item: {
        id: 'cmd-1',
        type: 'commandExecution',
        command: 'echo hello',
        text: 'hello',
        exitCode: 0,
        status: 'completed',
      },
    })

    expect(result[0]).toMatchObject({
      type: 'tool_result',
      toolName: 'shell',
      toolUseId: 'cmd-1',
      content: 'hello',
      isError: false,
    })
  })

  it('maps commandExecution item.completed to tool_result (failure)', () => {
    const result = mapAppServerItemEvent('item/completed', {
      item: {
        id: 'cmd-1',
        type: 'commandExecution',
        command: 'false',
        text: '',
        exitCode: 1,
        status: 'failed',
      },
    })

    expect(result[0]).toMatchObject({
      type: 'tool_result',
      isError: true,
    })
  })

  it('maps fileChange item.completed to tool_result', () => {
    const result = mapAppServerItemEvent('item/completed', {
      item: {
        id: 'fc-1',
        type: 'fileChange',
        changes: [
          { path: 'src/index.ts', kind: 'update' },
          { path: 'src/new.ts', kind: 'add' },
        ],
        status: 'completed',
      },
    })

    expect(result[0]).toMatchObject({
      type: 'tool_result',
      toolName: 'file_change',
      content: 'update: src/index.ts\nadd: src/new.ts',
      isError: false,
    })
  })

  // --- MCP tool call mapping (SUP-1745) ---

  it('maps mcpToolCall item.started to tool_use with normalized name', () => {
    const result = mapAppServerItemEvent('item/started', {
      item: {
        id: 'mcp-1',
        type: 'mcpToolCall',
        server: 'af-linear',
        tool: 'af_linear_create_issue',
        arguments: { title: 'Test' },
        status: 'in_progress',
      },
    })

    expect(result[0]).toMatchObject({
      type: 'tool_use',
      toolName: 'mcp__af-linear__af_linear_create_issue',
      toolUseId: 'mcp-1',
      input: { title: 'Test' },
      toolCategory: 'general',
    })
  })

  it('maps mcpToolCall item.completed to tool_result with normalized name (success)', () => {
    const result = mapAppServerItemEvent('item/completed', {
      item: {
        id: 'mcp-1',
        type: 'mcpToolCall',
        server: 'af-linear',
        tool: 'af_linear_create_issue',
        arguments: {},
        result: { content: [{ text: 'Created' }] },
        status: 'completed',
      },
    })

    expect(result[0]).toMatchObject({
      type: 'tool_result',
      toolName: 'mcp__af-linear__af_linear_create_issue',
      content: '[{"text":"Created"}]',
      isError: false,
    })
  })

  it('maps mcpToolCall item.completed to tool_result (error)', () => {
    const result = mapAppServerItemEvent('item/completed', {
      item: {
        id: 'mcp-1',
        type: 'mcpToolCall',
        server: 'af-linear',
        tool: 'af_linear_create_issue',
        arguments: {},
        error: { message: 'Auth failed' },
        status: 'failed',
      },
    })

    expect(result[0]).toMatchObject({
      type: 'tool_result',
      toolName: 'mcp__af-linear__af_linear_create_issue',
      isError: true,
      content: 'Auth failed',
    })
  })

  it('maps mcpToolCall with code-intelligence server to searchable category', () => {
    const result = mapAppServerItemEvent('item/started', {
      item: {
        id: 'mcp-2',
        type: 'mcpToolCall',
        server: 'af-code-intelligence',
        tool: 'af_code_search_symbols',
        arguments: { query: 'ToolRegistry' },
        status: 'in_progress',
      },
    })

    expect(result[0]).toMatchObject({
      type: 'tool_use',
      toolName: 'mcp__af-code-intelligence__af_code_search_symbols',
      toolCategory: 'research', // search matches research category
    })
  })

  it('maps plan item to system event', () => {
    const result = mapAppServerItemEvent('item/completed', {
      item: { id: 'p-1', type: 'plan', text: 'Step 1: Read code' },
    })

    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'plan',
      message: 'Step 1: Read code',
    })
  })

  it('maps webSearch item to system event', () => {
    const result = mapAppServerItemEvent('item/started', {
      item: { id: 'ws-1', type: 'webSearch', text: 'codex app server docs' },
    })

    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'web_search',
      message: 'Web search: codex app server docs',
    })
  })

  it('maps contextCompaction item to system event', () => {
    const result = mapAppServerItemEvent('item/completed', {
      item: { id: 'cc-1', type: 'contextCompaction' },
    })

    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'context_compaction',
      message: 'Context history compacted',
    })
  })

  it('returns empty when no item in params', () => {
    const result = mapAppServerItemEvent('item/completed', {})
    expect(result).toHaveLength(0)
  })

  it('handles unknown item type', () => {
    const result = mapAppServerItemEvent('item/completed', {
      item: { id: 'x', type: 'novelItemType' },
    })

    expect(result[0]).toMatchObject({
      type: 'system',
      subtype: 'unknown_item',
    })
  })
})

// ---------------------------------------------------------------------------
// CodexAppServerProvider class
// ---------------------------------------------------------------------------

describe('CodexAppServerProvider', () => {
  it('exports CodexAppServerProvider class', async () => {
    const { CodexAppServerProvider } = await import('./codex-app-server-provider.js')
    const provider = new CodexAppServerProvider()
    expect(provider.name).toBe('codex')
  })

  it('exports createCodexAppServerProvider factory', async () => {
    const { createCodexAppServerProvider } = await import('./codex-app-server-provider.js')
    const provider = createCodexAppServerProvider()
    expect(provider.name).toBe('codex')
    expect(provider.capabilities.supportsMessageInjection).toBe(true)
    expect(provider.capabilities.supportsSessionResume).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AppServerProcessManager
// ---------------------------------------------------------------------------

describe('AppServerProcessManager', () => {
  it('exports AppServerProcessManager class', async () => {
    const { AppServerProcessManager } = await import('./codex-app-server-provider.js')
    const manager = new AppServerProcessManager({ cwd: '/tmp' })
    expect(manager.isHealthy()).toBe(false)
    expect(manager.pid).toBeUndefined()
  })

  it('configureMcpServers is a no-op when not initialized', async () => {
    const { AppServerProcessManager } = await import('./codex-app-server-provider.js')
    const manager = new AppServerProcessManager({ cwd: '/tmp' })

    // Should not throw when not initialized
    await manager.configureMcpServers([
      { name: 'af-linear', command: 'node', args: ['server.js'] },
    ])
    // No error means it silently skipped (not initialized)
  })

  it('getMcpServerStatus returns empty when not initialized', async () => {
    const { AppServerProcessManager } = await import('./codex-app-server-provider.js')
    const manager = new AppServerProcessManager({ cwd: '/tmp' })

    const result = await manager.getMcpServerStatus()
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// normalizeMcpToolName (SUP-1745)
// ---------------------------------------------------------------------------

describe('normalizeMcpToolName', () => {
  it('normalizes server and tool to mcp__ format', () => {
    expect(normalizeMcpToolName('af-linear', 'af_linear_get_issue'))
      .toBe('mcp__af-linear__af_linear_get_issue')
  })

  it('normalizes code-intelligence tools', () => {
    expect(normalizeMcpToolName('af-code-intelligence', 'af_code_search_symbols'))
      .toBe('mcp__af-code-intelligence__af_code_search_symbols')
  })

  it('falls back to mcp:server/tool format for missing server', () => {
    expect(normalizeMcpToolName(undefined, 'some_tool'))
      .toBe('mcp:unknown/some_tool')
  })

  it('falls back to mcp:server/tool format for missing tool', () => {
    expect(normalizeMcpToolName('server', undefined))
      .toBe('mcp:server/unknown')
  })

  it('handles both missing server and tool', () => {
    expect(normalizeMcpToolName(undefined, undefined))
      .toBe('mcp:unknown/unknown')
  })
})

// ---------------------------------------------------------------------------
// resolveSandboxPolicy
// ---------------------------------------------------------------------------

describe('resolveSandboxPolicy', () => {
  it('returns readOnly policy for read-only level', () => {
    const config = { sandboxLevel: 'read-only', sandboxEnabled: false, cwd: '/work' } as unknown as AgentSpawnConfig
    expect(resolveSandboxPolicy(config)).toEqual({ type: 'readOnly' })
  })

  it('returns workspaceWrite policy with writableRoots for workspace-write level', () => {
    const config = { sandboxLevel: 'workspace-write', sandboxEnabled: false, cwd: '/work' } as unknown as AgentSpawnConfig
    expect(resolveSandboxPolicy(config)).toEqual({ type: 'workspaceWrite', writableRoots: ['/work'] })
  })

  it('returns dangerFullAccess policy for full-access level', () => {
    const config = { sandboxLevel: 'full-access', sandboxEnabled: false, cwd: '/work' } as unknown as AgentSpawnConfig
    expect(resolveSandboxPolicy(config)).toEqual({ type: 'dangerFullAccess' })
  })

  it('falls back to sandboxEnabled boolean when no level set', () => {
    const config = { sandboxEnabled: true, cwd: '/work' } as unknown as AgentSpawnConfig
    expect(resolveSandboxPolicy(config)).toEqual({ type: 'workspaceWrite', writableRoots: ['/work'] })
  })

  it('returns undefined when sandbox disabled and no level set', () => {
    const config = { sandboxEnabled: false, cwd: '/work' } as unknown as AgentSpawnConfig
    expect(resolveSandboxPolicy(config)).toBeUndefined()
  })

  it('sandboxLevel takes precedence over sandboxEnabled boolean', () => {
    const config = { sandboxLevel: 'read-only', sandboxEnabled: true, cwd: '/work' } as unknown as AgentSpawnConfig
    expect(resolveSandboxPolicy(config)).toEqual({ type: 'readOnly' })
  })
})

// ---------------------------------------------------------------------------
// resolveCodexModel (SUP-1749)
// ---------------------------------------------------------------------------

describe('resolveCodexModel', () => {
  it('returns explicit model when set', () => {
    const config = { model: 'custom-model', env: {} } as unknown as AgentSpawnConfig
    expect(resolveCodexModel(config)).toBe('custom-model')
  })

  it('maps opus tier to gpt-5-codex', () => {
    const config = { env: { CODEX_MODEL_TIER: 'opus' } } as unknown as AgentSpawnConfig
    expect(resolveCodexModel(config)).toBe('gpt-5-codex')
  })

  it('maps sonnet tier to gpt-5.2-codex', () => {
    const config = { env: { CODEX_MODEL_TIER: 'sonnet' } } as unknown as AgentSpawnConfig
    expect(resolveCodexModel(config)).toBe('gpt-5.2-codex')
  })

  it('maps haiku tier to gpt-5.3-codex', () => {
    const config = { env: { CODEX_MODEL_TIER: 'haiku' } } as unknown as AgentSpawnConfig
    expect(resolveCodexModel(config)).toBe('gpt-5.3-codex')
  })

  it('uses CODEX_MODEL env var as fallback', () => {
    const config = { env: { CODEX_MODEL: 'gpt-5.5-codex' } } as unknown as AgentSpawnConfig
    expect(resolveCodexModel(config)).toBe('gpt-5.5-codex')
  })

  it('returns default model when nothing configured', () => {
    const config = { env: {} } as unknown as AgentSpawnConfig
    expect(resolveCodexModel(config)).toBe('gpt-5-codex')
  })

  it('explicit model takes precedence over tier', () => {
    const config = { model: 'my-model', env: { CODEX_MODEL_TIER: 'opus' } } as unknown as AgentSpawnConfig
    expect(resolveCodexModel(config)).toBe('my-model')
  })

  it('tier takes precedence over CODEX_MODEL env', () => {
    const config = { env: { CODEX_MODEL_TIER: 'haiku', CODEX_MODEL: 'custom' } } as unknown as AgentSpawnConfig
    expect(resolveCodexModel(config)).toBe('gpt-5.3-codex')
  })
})

// ---------------------------------------------------------------------------
// calculateCostUsd (SUP-1750)
// ---------------------------------------------------------------------------

describe('calculateCostUsd', () => {
  it('calculates cost with default pricing (gpt-5-codex)', () => {
    // 1000 input (800 fresh + 200 cached), 500 output
    const cost = calculateCostUsd(1000, 200, 500)
    // fresh: 800/1M * 2.00 = 0.0016
    // cached: 200/1M * 0.50 = 0.0001
    // output: 500/1M * 8.00 = 0.004
    expect(cost).toBeCloseTo(0.0057, 6)
  })

  it('calculates cost with specific model pricing', () => {
    const cost = calculateCostUsd(1000, 200, 500, 'gpt-5.2-codex')
    // fresh: 800/1M * 1.00 = 0.0008
    // cached: 200/1M * 0.25 = 0.00005
    // output: 500/1M * 4.00 = 0.002
    expect(cost).toBeCloseTo(0.00285, 6)
  })

  it('calculates cost with haiku model pricing', () => {
    const cost = calculateCostUsd(1000, 200, 500, 'gpt-5.3-codex')
    // fresh: 800/1M * 0.50 = 0.0004
    // cached: 200/1M * 0.125 = 0.000025
    // output: 500/1M * 2.00 = 0.001
    expect(cost).toBeCloseTo(0.001425, 6)
  })

  it('uses default pricing for unknown models', () => {
    const cost = calculateCostUsd(1000, 0, 500, 'unknown-model')
    // fresh: 1000/1M * 2.00 = 0.002
    // output: 500/1M * 8.00 = 0.004
    expect(cost).toBeCloseTo(0.006, 6)
  })

  it('handles zero tokens', () => {
    expect(calculateCostUsd(0, 0, 0)).toBe(0)
  })

  it('handles all cached tokens (fresh = 0)', () => {
    const cost = calculateCostUsd(1000, 1000, 0)
    // fresh: 0
    // cached: 1000/1M * 0.50 = 0.0005
    expect(cost).toBeCloseTo(0.0005, 6)
  })

  it('clamps fresh tokens to zero when cached exceeds input', () => {
    const cost = calculateCostUsd(100, 200, 0)
    // fresh: max(0, 100 - 200) = 0
    // cached: 200/1M * 0.50 = 0.0001
    expect(cost).toBeCloseTo(0.0001, 6)
  })
})

// ---------------------------------------------------------------------------
// CODEX_MODEL_MAP and CODEX_DEFAULT_MODEL (SUP-1749)
// ---------------------------------------------------------------------------

describe('CODEX_MODEL_MAP', () => {
  it('maps all three tiers', () => {
    expect(CODEX_MODEL_MAP).toEqual({
      opus: 'gpt-5-codex',
      sonnet: 'gpt-5.2-codex',
      haiku: 'gpt-5.3-codex',
    })
  })
})

describe('CODEX_DEFAULT_MODEL', () => {
  it('is gpt-5-codex', () => {
    expect(CODEX_DEFAULT_MODEL).toBe('gpt-5-codex')
  })
})
