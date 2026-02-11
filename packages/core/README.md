# @supaku/agentfactory

Core orchestrator for multi-agent fleet management. Turns your issue backlog into shipped code by coordinating coding agents (Claude, Codex, Amp) through an automated pipeline.

Part of the [AgentFactory](https://github.com/supaku/agentfactory) monorepo.

## Installation

```bash
npm install @supaku/agentfactory @supaku/agentfactory-linear
```

## Quick Start

```typescript
import { createOrchestrator } from '@supaku/agentfactory'

const orchestrator = createOrchestrator({
  maxConcurrent: 3,
  worktreePath: '.worktrees',
})

// Process a single issue
await orchestrator.spawnAgentForIssue('PROJ-123')
await orchestrator.waitForAll()

// Check results
for (const agent of orchestrator.getAgents()) {
  console.log(`${agent.identifier}: ${agent.status}`)
  if (agent.pullRequestUrl) console.log(`  PR: ${agent.pullRequestUrl}`)
  if (agent.totalCostUsd) console.log(`  Cost: $${agent.totalCostUsd.toFixed(4)}`)
}
```

## What It Does

1. **Issue selection** — queries Linear for backlog issues, filters by project, selects by priority
2. **Worktree creation** — creates isolated git worktrees per agent
3. **Agent spawning** — delegates to providers (Claude, Codex, Amp)
4. **Stream processing** — iterates `AgentEvent` from providers, emits activities to Linear
5. **Crash recovery** — persists state to `.agent/` directory, resumes on restart
6. **Inactivity timeout** — monitors idle agents and stops them

## Provider Abstraction

```typescript
interface AgentProvider {
  readonly name: 'claude' | 'codex' | 'amp'
  spawn(config: AgentSpawnConfig): AgentHandle
  resume(sessionId: string, config: AgentSpawnConfig): AgentHandle
}

interface AgentHandle {
  sessionId: string | null
  stream: AsyncIterable<AgentEvent>
  injectMessage(text: string): Promise<void>
  stop(): Promise<void>
}
```

Provider resolution: `AGENT_PROVIDER_{WORKTYPE}` > `AGENT_PROVIDER_{PROJECT}` > `AGENT_PROVIDER` > `'claude'`

## Configuration

```typescript
const orchestrator = createOrchestrator({
  provider: myProvider,            // Agent provider instance
  maxConcurrent: 3,                // Max concurrent agents
  project: 'MyProject',           // Filter by project
  worktreePath: '.worktrees',     // Git worktree base path
  inactivityTimeoutMs: 300_000,   // 5 min idle timeout
  maxSessionTimeoutMs: 7_200_000, // 2 hour hard cap
  workTypeTimeouts: {
    qa: { inactivityTimeoutMs: 600_000 },
  },
})
```

## Related Packages

| Package | Description |
|---------|-------------|
| [@supaku/agentfactory-linear](https://www.npmjs.com/package/@supaku/agentfactory-linear) | Linear issue tracker integration |
| [@supaku/agentfactory-server](https://www.npmjs.com/package/@supaku/agentfactory-server) | Redis work queue, distributed workers |
| [@supaku/agentfactory-cli](https://www.npmjs.com/package/@supaku/agentfactory-cli) | CLI tools |
| [@supaku/agentfactory-nextjs](https://www.npmjs.com/package/@supaku/agentfactory-nextjs) | Next.js webhook server |

## License

MIT
