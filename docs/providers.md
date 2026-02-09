# Providers

AgentFactory abstracts coding agents behind a unified `AgentProvider` interface. This allows you to use different agents for different tasks and swap providers without changing orchestration logic.

## Supported Providers

| Provider | Status | Agent |
|----------|--------|-------|
| `claude` | Production | [Claude Code](https://docs.anthropic.com/en/docs/claude-code) via `@anthropic-ai/claude-agent-sdk` |
| `codex` | Experimental | [OpenAI Codex](https://platform.openai.com/) |
| `amp` | Experimental | [Amp](https://amp.dev/) |

## Provider Interface

Every provider implements:

```typescript
interface AgentProvider {
  readonly name: 'claude' | 'codex' | 'amp'

  /** Spawn a new agent session */
  spawn(config: AgentSpawnConfig): AgentHandle

  /** Resume a previously interrupted session */
  resume(sessionId: string, config: AgentSpawnConfig): AgentHandle
}
```

And returns an `AgentHandle`:

```typescript
interface AgentHandle {
  /** Session ID for crash recovery / resume */
  sessionId: string | null

  /** Async stream of normalized events */
  stream: AsyncIterable<AgentEvent>

  /** Inject a follow-up message into the running session */
  injectMessage(text: string): Promise<void>

  /** Stop the agent */
  stop(): Promise<void>
}
```

## Configuration

### Global Default

```bash
export AGENT_PROVIDER=claude
```

### Per-Work-Type Override

Use different providers for different work phases:

```bash
export AGENT_PROVIDER=claude          # Default for development
export AGENT_PROVIDER_QA=codex        # Use Codex for QA
export AGENT_PROVIDER_ACCEPTANCE=amp  # Use Amp for acceptance
```

### Per-Project Override

Use different providers for different projects:

```bash
export AGENT_PROVIDER_FRONTEND=claude
export AGENT_PROVIDER_BACKEND=codex
```

### Resolution Order

Provider is resolved per agent with this priority:

```
1. AGENT_PROVIDER_{WORKTYPE}   (e.g., AGENT_PROVIDER_QA)
2. AGENT_PROVIDER_{PROJECT}    (e.g., AGENT_PROVIDER_SOCIAL)
3. AGENT_PROVIDER              (global default)
4. 'claude'                    (fallback)
```

Work type beats project, both beat the global default.

### Programmatic Selection

```typescript
import { createProvider, resolveProviderName } from '@supaku/agentfactory'

// Create a specific provider
const claude = createProvider('claude')

// Resolve based on context
const name = resolveProviderName({
  project: 'Social',
  workType: 'qa',
})
const provider = createProvider(name)

// Pass to orchestrator
const orchestrator = createOrchestrator({
  provider: claude,
})
```

## Event Normalization

All providers emit the same `AgentEvent` types regardless of the underlying SDK:

| Event Type | Description | Key Fields |
|------------|-------------|------------|
| `init` | Session started | `sessionId` |
| `system` | Status change, compaction | `subtype`, `message` |
| `assistant_text` | Agent text output | `text` |
| `tool_use` | Tool invocation started | `toolName`, `input` |
| `tool_result` | Tool execution completed | `content`, `isError` |
| `tool_progress` | Long tool in progress | `toolName`, `elapsedSeconds` |
| `result` | Agent finished | `success`, `cost`, `message` |
| `error` | Error occurred | `message`, `code` |

Every event also carries a `raw` field with the provider's original event data.

## Cost Tracking

The `result` event includes cost data when available:

```typescript
interface AgentCostData {
  inputTokens?: number
  outputTokens?: number
  totalCostUsd?: number
  numTurns?: number
}
```

Cost is accumulated on the `AgentProcess` object and can be used for budgeting:

```typescript
orchestrator.events.onAgentComplete = (agent) => {
  console.log(`${agent.identifier}: $${agent.totalCostUsd?.toFixed(4)}`)
  console.log(`  Input:  ${agent.inputTokens} tokens`)
  console.log(`  Output: ${agent.outputTokens} tokens`)
}
```

## Writing a Custom Provider

To add support for a new coding agent:

1. Create a class implementing `AgentProvider`
2. Map native events to `AgentEvent` types in the `spawn()` method
3. Return an `AgentHandle` with the async iterable stream

```typescript
import type { AgentProvider, AgentSpawnConfig, AgentHandle, AgentEvent } from '@supaku/agentfactory'

class MyProvider implements AgentProvider {
  readonly name = 'my-agent' as any // Extend AgentProviderName first

  spawn(config: AgentSpawnConfig): AgentHandle {
    // 1. Start your agent process
    // 2. Create an async generator that yields AgentEvents
    // 3. Return an AgentHandle

    return {
      sessionId: null,
      stream: this.createStream(config),
      injectMessage: async (text) => { /* send follow-up */ },
      stop: async () => { /* kill the process */ },
    }
  }

  resume(sessionId: string, config: AgentSpawnConfig): AgentHandle {
    // Resume from previous session
    return this.spawn({ ...config, /* add resume context */ })
  }

  private async *createStream(config: AgentSpawnConfig): AsyncIterable<AgentEvent> {
    // Yield normalized events
    yield { type: 'init', sessionId: 'my-session-id', raw: {} }

    // ... process your agent's output ...

    yield {
      type: 'result',
      success: true,
      message: 'Done',
      cost: { inputTokens: 1000, outputTokens: 500, totalCostUsd: 0.01 },
      raw: {},
    }
  }
}
```

Then register it:

```typescript
const orchestrator = createOrchestrator({
  provider: new MyProvider(),
})
```
