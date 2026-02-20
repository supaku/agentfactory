# Architecture

AgentFactory is a multi-agent orchestrator that turns issue backlogs into shipped code. This document covers the system architecture and how the components fit together.

## System Overview

```
                    ┌───────────────────────────┐
                    │       Linear Issues        │
                    │  (Backlog / Started / ...)  │
                    └─────────────┬─────────────┘
                                  │
                    ┌─────────────▼─────────────┐
                    │       Orchestrator          │
                    │  - Issue selection          │
                    │  - Agent lifecycle          │
                    │  - Crash recovery           │
                    │  - Inactivity timeout       │
                    └──┬──────────┬──────────┬───┘
                       │          │          │
              ┌────────▼──┐ ┌────▼────┐ ┌───▼───────┐
              │  Agent 1   │ │ Agent 2  │ │  Agent 3   │
              │  Claude    │ │ Codex    │ │  Claude    │
              │  DEV #123  │ │ QA #120  │ │  DEV #125  │
              └────┬───────┘ └────┬────┘ └─────┬─────┘
                   │              │             │
              ┌────▼───────┐ ┌───▼─────┐ ┌────▼──────┐
              │  Worktree   │ │Worktree  │ │ Worktree   │
              │  #123-DEV   │ │#120-QA   │ │ #125-DEV   │
              └────────────┘ └─────────┘ └───────────┘
```

## Package Architecture

AgentFactory is split into six packages:

| Package | Responsibility |
|---------|---------------|
| `@supaku/agentfactory` | Core orchestrator, provider abstraction, crash recovery |
| `@supaku/agentfactory-linear` | Linear API integration, sessions, status transitions |
| `@supaku/agentfactory-server` | Redis work queue, session storage, distributed workers |
| `@supaku/agentfactory-cli` | CLI tools for local and remote operation |
| `@supaku/agentfactory-nextjs` | Next.js route handlers, webhook processor, OAuth, middleware |
| `@supaku/create-agentfactory-app` | Project scaffolding tool (`npx create-agentfactory-app`) |

### Dependency Graph

```
@supaku/create-agentfactory-app (scaffolding, no runtime deps)

@supaku/agentfactory-nextjs
  ├── @supaku/agentfactory (core)
  ├── @supaku/agentfactory-linear
  └── @supaku/agentfactory-server

@supaku/agentfactory-cli
  ├── @supaku/agentfactory (core)
  ├── @supaku/agentfactory-linear
  └── @supaku/agentfactory-server

@supaku/agentfactory-server
  ├── @supaku/agentfactory (core)
  └── @supaku/agentfactory-linear
```

For a full webhook-driven setup, install `@supaku/agentfactory-nextjs` (it pulls in all dependencies). For CLI-only local orchestration, install `@supaku/agentfactory` and `@supaku/agentfactory-linear`.

## Core Components

### Orchestrator

The orchestrator (`packages/core/src/orchestrator/`) manages the full lifecycle of coding agents:

1. **Issue selection** — queries Linear for backlog issues, filters by project, selects by priority
2. **Worktree creation** — creates isolated git worktrees per agent (e.g., `.worktrees/PROJ-123-DEV`)
3. **Agent spawning** — delegates to the provider abstraction to start agents
4. **Stream processing** — iterates `AgentEvent` from the provider, emitting activities to Linear
5. **Completion handling** — detects PR URLs, posts completion comments, transitions status
6. **Crash recovery** — persists state to `.agent/` directory, resumes on restart
7. **Inactivity timeout** — monitors `lastActivityAt` and stops idle agents

Key files:

- `orchestrator.ts` — main orchestration loop (~2,900 lines)
- `types.ts` — `OrchestratorConfig`, `AgentProcess`, `OrchestratorResult`
- `activity-emitter.ts` — streams agent activities to Linear issue view
- `state-recovery.ts` — reads/writes `.agent/state.json` for crash recovery
- `heartbeat-writer.ts` — periodic health signals for crash detection
- `stream-parser.ts` — extracts PR URLs, cost data, and results from agent output
- `log-analyzer.ts` — post-run analysis for creating bug reports

### Provider Abstraction

The provider system (`packages/core/src/providers/`) abstracts away differences between coding agent SDKs:

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

**AgentEvent** is a discriminated union of normalized events:

| Event | Description |
|-------|-------------|
| `init` | Agent initialized, contains session ID |
| `system` | Status changes, compaction notifications |
| `assistant_text` | Agent's text output |
| `tool_use` | Agent is invoking a tool |
| `tool_result` | Tool execution completed |
| `tool_progress` | Long-running tool progress update |
| `result` | Final result with cost data |
| `error` | Error occurred |

### Provider Resolution

Provider is selected dynamically per agent based on environment variables:

```
Priority: AGENT_PROVIDER_{WORKTYPE} > AGENT_PROVIDER_{PROJECT} > AGENT_PROVIDER > 'claude'
```

This allows configurations like "use Claude for development, Codex for QA".

### Linear Integration

The Linear package (`packages/linear/`) provides:

- **LinearAgentClient** — wraps `@linear/sdk` with retry logic and convenience methods
- **AgentSession** — lifecycle management (start, emit activities, update plan, complete)
- **Work type routing** — maps issue status to work type (Backlog -> development, Finished -> QA)
- **Status transitions** — automatic status updates as work progresses
- **Activity streaming** — thoughts, actions, and responses visible in Linear's issue view
- **Plan tracking** — nested task checklists with state (pending, inProgress, completed, canceled)

### Server Components

The server package (`packages/server/`) provides Redis-backed infrastructure:

- **WorkQueue** — sorted set-based priority queue with atomic claim/release
- **SessionStorage** — key-value session state (status, cost, timestamps)
- **WorkerStorage** — worker registration, heartbeat, and capacity tracking
- **IssueLock** — per-issue mutex with pending queue for parking incoming work
- **AgentTracking** — QA attempt counts and agent-worked history
- **WebhookIdempotency** — dedup webhook deliveries with TTL

## Work Types

Issues flow through work stations based on their Linear status:

| Status | Work Type | Agent Role |
|--------|-----------|------------|
| Backlog | `development` | Implement the feature or fix |
| Started | `inflight` | Continue in-progress work |
| Finished | `qa` | Validate the implementation |
| Delivered | `acceptance` | Final acceptance testing |
| Rejected | `refinement` | Address feedback and rework |

Additional coordination types exist for parent issues with sub-issues:

| Work Type | Description |
|-----------|-------------|
| `coordination` | Orchestrates sub-issue development in parallel |
| `qa-coordination` | Runs QA on all sub-issues, promotes parent if all pass |
| `acceptance-coordination` | Validates all sub-issues, merges PR |

## Crash Recovery

AgentFactory includes built-in crash recovery:

1. **State persistence** — each worktree contains `.agent/state.json` with session state
2. **Heartbeat monitoring** — agents write `.agent/heartbeat.json` every 10 seconds
3. **Crash detection** — stale heartbeat (>30s) indicates a crashed agent
4. **Automatic resume** — orchestrator rebuilds prompt from saved state and resumes
5. **Recovery limits** — configurable max attempts (default: 3) to prevent infinite loops

State file structure:

```
.worktrees/PROJ-123-DEV/.agent/
  ├── state.json      # Session state (issue, work type, prompt, status)
  ├── heartbeat.json  # Last heartbeat timestamp + metrics
  ├── todos.json      # Task list state (survives restarts)
  └── progress.log    # Append-only event log for debugging
```

## Inactivity Timeout

Instead of fixed session timeouts, AgentFactory uses inactivity-based monitoring:

- Each agent tracks `lastActivityAt` from provider events
- A background timer checks all agents periodically
- Agents idle longer than `inactivityTimeoutMs` are stopped
- An optional `maxSessionTimeoutMs` provides a hard cap

This allows long-running agents (large test suites, big refactors) to run as long as they're making progress.

## Workflow Governor

The Workflow Governor (`packages/core/src/governor/`) is the central lifecycle manager. It observes all issues across projects and decides what work to dispatch based on issue status, active sessions, cooldowns, and human overrides.

### Architecture

```
Platform Webhooks ──► PlatformAdapter.normalizeWebhookEvent()
                              │
                              ▼
                      GovernorEventBus (Redis Stream)
                              │
                    ┌─────────┴──────────┐
                    │                    │
             webhook events        poll-snapshot events
             (real-time)           (every 5 min safety net)
                    │                    │
                    └─────────┬──────────┘
                              │
                    EventDeduplicator
                       (skip if same issue+status within 10s)
                              │
                    Decision Engine (decideAction)
                              │
                    dispatchWork → Redis work queue → Workers
```

### Two Governor Classes

| Class | Mode | Use Case |
|-------|------|----------|
| `WorkflowGovernor` | Poll-only | Simple periodic scan loop, CLI `--once` mode |
| `EventDrivenGovernor` | Hybrid event + poll | Production: real-time webhook events with periodic safety net |

Both share the same `decideAction()` pure function and dependency injection interface.

### Decision Engine

For each issue, the governor evaluates:

1. **Status** — maps to a potential action (e.g., Backlog → `trigger-development`)
2. **Active session** — skip if an agent is already running
3. **Cooldown** — skip if QA just failed (prevents retry loops)
4. **Parent issue** — routes to coordination work types
5. **Hold override** — skip if a human commented `HOLD`
6. **Priority override** — reorder if `PRIORITY HIGH` / `PRIORITY URGENT`
7. **Workflow strategy** — considers top-of-funnel phases (research, backlog-creation)

### GovernorDependencies

All external state is injected through the `GovernorDependencies` interface:

```typescript
interface GovernorDependencies {
  listIssues(project: string): Promise<GovernorIssue[]>
  hasActiveSession(issueId: string): Promise<boolean>
  isWithinCooldown(issueId: string): Promise<boolean>
  isParentIssue(issueId: string): Promise<boolean>
  isHeld(issueId: string): Promise<boolean>
  getOverridePriority(issueId: string): Promise<OverridePriority | null>
  getWorkflowStrategy(issueId: string): Promise<string | undefined>
  isResearchCompleted(issueId: string): Promise<boolean>
  isBacklogCreationCompleted(issueId: string): Promise<boolean>
  dispatchWork(issueId: string, action: GovernorAction): Promise<void>
}
```

### PlatformAdapter

The `PlatformAdapter` interface abstracts platform-specific operations for multi-platform support:

```typescript
interface PlatformAdapter {
  readonly name: string
  normalizeWebhookEvent(payload: unknown): GovernorEvent[] | null
  scanProjectIssues(project: string): Promise<GovernorIssue[]>
  toGovernorIssue(native: unknown): Promise<GovernorIssue>
  isParentIssue(issueId: string): Promise<boolean>
}
```

`LinearPlatformAdapter` (in `packages/linear`) implements this for Linear. Additional adapters (Asana, Jira, etc.) would follow the same pattern.

### GovernorEventBus

Events flow through the `GovernorEventBus` interface:

```typescript
interface GovernorEventBus {
  publish(event: GovernorEvent): Promise<string>
  subscribe(): AsyncIterable<{ id: string; event: GovernorEvent }>
  ack(eventId: string): Promise<void>
  close(): Promise<void>
}
```

Two implementations:
- `InMemoryEventBus` — for testing and single-process CLI
- `RedisEventBus` — production, uses Redis Streams with consumer groups

### Governor Mode

The webhook server supports three modes via `governorMode` in `WebhookConfig`:

| Mode | Webhooks | Governor Events | Use Case |
|------|----------|----------------|----------|
| `direct` | Dispatch directly | Not published | Default, no governor needed |
| `event-bridge` | Dispatch AND publish events | Published to Redis Stream | Dual-write for safe rollout |
| `governor-only` | Only publish events | Published to Redis Stream | Governor handles all lifecycle |

### Human Override Commands

Users can override the governor by adding Linear comments:

- `HOLD` — Pause all automated processing
- `RESUME` — Resume automated processing
- `PRIORITY HIGH` / `PRIORITY URGENT` — Override priority for next dispatch

## Distributed Architecture

For horizontal scaling, AgentFactory supports a coordinator + worker topology:

```
┌─────────────────┐     ┌──────────┐     ┌──────────────────┐
│  Webhook Server  │────>│  Redis   │<────│  Worker Node 1    │
│  (enqueues work) │     │  Queue   │     │  (claims + runs)  │
└─────────────────┘     │          │     └──────────────────┘
                        │          │     ┌──────────────────┐
                        │          │<────│  Worker Node 2    │
                        └──────────┘     └──────────────────┘
```

Workers are stateless — all coordination happens through Redis. Scale by adding more worker processes.
