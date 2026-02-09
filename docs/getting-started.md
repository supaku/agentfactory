# Getting Started

This guide walks through setting up AgentFactory to process Linear issues with coding agents.

## Prerequisites

- **Node.js** >= 18
- **pnpm** >= 8 (or npm/yarn)
- **Git** — agents work in git worktrees
- **Linear account** — with API key access
- A coding agent installed:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (default)
  - [OpenAI Codex](https://platform.openai.com/docs/guides/codex) (experimental)

## Installation

```bash
# Core + Linear integration (minimum required)
npm install @supaku/agentfactory @supaku/agentfactory-linear

# Optional: CLI tools
npm install -g @supaku/agentfactory-cli

# Optional: Distributed workers (requires Redis)
npm install @supaku/agentfactory-server
```

## Configuration

### Environment Variables

Create a `.env` file:

```bash
# Required
LINEAR_API_KEY=lin_api_...

# Optional: agent provider (default: claude)
AGENT_PROVIDER=claude

# Optional: Linear team/project IDs
LINEAR_TEAM_ID=your-team-uuid

# Optional: Redis (for distributed mode)
REDIS_URL=redis://localhost:6379
```

### Linear Setup

1. Go to **Settings > API** in Linear
2. Create a Personal API Key
3. Set it as `LINEAR_API_KEY`

For webhook-based triggers (production), you'll also need:
- A Linear OAuth application
- Webhook endpoint configured to receive events

## Basic Usage

### Process a Single Issue

```typescript
import { createOrchestrator } from '@supaku/agentfactory'

const orchestrator = createOrchestrator({
  maxConcurrent: 1,
  worktreePath: '.worktrees',
})

// Spawn agent for a specific issue
await orchestrator.spawnAgentForIssue('PROJ-123')
await orchestrator.waitForAll()
```

### Process Project Backlog

```typescript
const orchestrator = createOrchestrator({
  project: 'MyProject',
  maxConcurrent: 3,
})

// Picks up highest-priority Backlog issues
const result = await orchestrator.run()
console.log(`Spawned ${result.agents.length} agents`)

await orchestrator.waitForAll()
```

### Use the CLI

```bash
# Process backlog issues
npx af-orchestrator --project MyProject --max 3

# Process a single issue
npx af-orchestrator --single PROJ-123

# Dry run (preview what would be processed)
npx af-orchestrator --project MyProject --dry-run
```

## What Happens When an Agent Runs

1. **Worktree creation** — a git worktree is created at `.worktrees/PROJ-123-DEV`
2. **Branch setup** — a feature branch `PROJ-123` is created from `main`
3. **Issue fetch** — requirements are fetched from the Linear issue description
4. **Agent execution** — the coding agent reads the codebase, implements the change
5. **PR creation** — the agent commits changes and creates a pull request
6. **Status update** — Linear issue status transitions to "Finished"
7. **Cost tracking** — token usage and cost are recorded on the agent process

## Event Callbacks

Monitor agent lifecycle:

```typescript
const orchestrator = createOrchestrator({
  events: {
    onAgentStart: (agent) => {
      console.log(`Started: ${agent.identifier} [${agent.workType}]`)
    },
    onAgentComplete: (agent) => {
      console.log(`Done: ${agent.identifier} — ${agent.status}`)
      if (agent.pullRequestUrl) {
        console.log(`  PR: ${agent.pullRequestUrl}`)
      }
      if (agent.totalCostUsd) {
        console.log(`  Cost: $${agent.totalCostUsd.toFixed(4)}`)
      }
    },
    onAgentError: (agent, error) => {
      console.error(`Error on ${agent.identifier}:`, error.message)
    },
  },
})
```

## Timeouts

Configure inactivity-based timeouts:

```typescript
const orchestrator = createOrchestrator({
  // Stop agents idle for 5 minutes
  inactivityTimeoutMs: 300_000,

  // Hard cap at 2 hours regardless of activity
  maxSessionTimeoutMs: 7_200_000,

  // Different thresholds per work type
  workTypeTimeouts: {
    qa: { inactivityTimeoutMs: 600_000 },         // QA gets 10 min
    development: { inactivityTimeoutMs: 300_000 }, // Dev gets 5 min
  },
})
```

## Work Type Flow

Issues progress through work types based on their Linear status:

```
Backlog ──> development ──> Finished
                              │
                              ▼
                            qa ──> Delivered
                              │       │
                              ▼       ▼
                          (fail)   acceptance ──> Accepted
                              │
                              ▼
                          Finished (retry)
```

Each transition is automatic when `autoTransition: true` (default).

## Next Steps

- [Architecture](./architecture.md) — understand the system design
- [Providers](./providers.md) — configure multiple agent providers
- [Examples](../examples/) — working code samples
