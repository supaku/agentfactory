# Configuration Reference

Complete reference for all AgentFactory configuration options.

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `LINEAR_ACCESS_TOKEN` | Linear API key — used by the Next.js webhook server and `createDefaultLinearClientResolver()` |
| `LINEAR_API_KEY` | Linear API key — used by CLI tools (`af-orchestrator`, `af-worker`, etc.) |

> **Tip:** Set both to the same Linear API key value. If you only use CLI tools, `LINEAR_API_KEY` is sufficient. If you only use the Next.js server, `LINEAR_ACCESS_TOKEN` is sufficient.

### Webhook Server

| Variable | Default | Description |
|----------|---------|-------------|
| `LINEAR_WEBHOOK_SECRET` | — | Secret for verifying Linear webhook signatures |
| `LINEAR_CLIENT_ID` | — | OAuth app client ID (multi-workspace) |
| `LINEAR_CLIENT_SECRET` | — | OAuth app client secret |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` | App URL for OAuth redirects |
| `REDIS_URL` | — | Redis connection URL for distributed workers |

### Agent Provider

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_PROVIDER` | `claude` | Default provider: `claude`, `codex`, `amp` |
| `AGENT_PROVIDER_{WORKTYPE}` | — | Per-work-type override (e.g., `AGENT_PROVIDER_QA=codex`) |
| `AGENT_PROVIDER_{PROJECT}` | — | Per-project override (e.g., `AGENT_PROVIDER_SOCIAL=amp`) |

### Worker Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKER_API_URL` | — | Webhook server URL (for remote workers) |
| `WORKER_API_KEY` | — | API key for worker authentication |

### Timeouts

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_INACTIVITY_TIMEOUT_MS` | `300000` (5 min) | Stop agent after this idle period |
| `AGENT_MAX_SESSION_TIMEOUT_MS` | unlimited | Hard cap on session duration |
| `AGENT_HEARTBEAT_INTERVAL_MS` | `10000` (10 sec) | Heartbeat write interval |
| `AGENT_HEARTBEAT_TIMEOUT_MS` | `30000` (30 sec) | Heartbeat staleness threshold |
| `AGENT_MAX_RECOVERY_ATTEMPTS` | `3` | Max crash recovery attempts |

### Auto-Trigger

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_AUTO_QA` | `false` | Auto-trigger QA when issues move to Finished |
| `ENABLE_AUTO_ACCEPTANCE` | `false` | Auto-trigger acceptance when issues move to Delivered |
| `AUTO_QA_REQUIRE_AGENT_WORKED` | `true` | Only auto-QA issues previously worked by agent |
| `AUTO_ACCEPTANCE_REQUIRE_AGENT_WORKED` | `true` | Only auto-accept agent-worked issues |
| `AUTO_QA_PROJECTS` | (all) | Comma-separated project names to auto-QA |
| `AUTO_ACCEPTANCE_PROJECTS` | (all) | Comma-separated project names to auto-accept |
| `AUTO_QA_EXCLUDE_LABELS` | — | Labels that exclude from auto-QA |
| `AUTO_ACCEPTANCE_EXCLUDE_LABELS` | — | Labels that exclude from auto-acceptance |

## Route Factory Configuration

### `createAllRoutes(config)`

Central factory that creates all 21+ route handlers from a single config:

```typescript
import { createAllRoutes, createDefaultLinearClientResolver } from '@supaku/agentfactory-nextjs'

const routes = createAllRoutes({
  // Required: how to resolve a Linear API client
  linearClient: createDefaultLinearClientResolver(),

  // Optional: customize prompt generation
  generatePrompt: (identifier, workType, mentionContext) => string,

  // Optional: detect work type from a free-text prompt
  detectWorkTypeFromPrompt: (prompt, validWorkTypes) => AgentWorkType | undefined,

  // Optional: assign priority to work types
  getPriority: (workType) => number,

  // Optional: auto-trigger configuration
  autoTrigger: {
    enableAutoQA: true,
    enableAutoAcceptance: false,
    autoQARequireAgentWorked: true,
    autoAcceptanceRequireAgentWorked: true,
    autoQAProjects: [],
    autoAcceptanceProjects: [],
    autoQAExcludeLabels: [],
    autoAcceptanceExcludeLabels: [],
  },

  // Optional: build context for parent QA/acceptance coordination
  buildParentQAContext: (identifier, subIssues) => string,
  buildParentAcceptanceContext: (identifier, subIssues) => string,

  // Optional: OAuth configuration
  oauth: {
    clientId: process.env.LINEAR_CLIENT_ID,
    clientSecret: process.env.LINEAR_CLIENT_SECRET,
    appUrl: process.env.NEXT_PUBLIC_APP_URL,
    successRedirect: '/?oauth=success',
  },

  // Optional: webhook secret (defaults to LINEAR_WEBHOOK_SECRET env)
  webhookSecret: process.env.LINEAR_WEBHOOK_SECRET,
})
```

### AllRoutes Structure

The returned `routes` object maps directly to Next.js App Router:

```
routes.webhook.POST          → /webhook (POST)
routes.webhook.GET           → /webhook (GET — health check)
routes.oauth.callback.GET    → /callback (GET)

routes.workers.register.POST → /api/workers/register
routes.workers.list.GET      → /api/workers
routes.workers.detail.GET    → /api/workers/[id]
routes.workers.detail.DELETE → /api/workers/[id]
routes.workers.heartbeat.POST → /api/workers/[id]/heartbeat
routes.workers.poll.GET      → /api/workers/[id]/poll

routes.sessions.list.GET     → /api/sessions
routes.sessions.detail.GET   → /api/sessions/[id]
routes.sessions.claim.POST   → /api/sessions/[id]/claim
routes.sessions.status.*     → /api/sessions/[id]/status
routes.sessions.lockRefresh.POST    → /api/sessions/[id]/lock-refresh
routes.sessions.prompts.*    → /api/sessions/[id]/prompts
routes.sessions.transferOwnership.POST → /api/sessions/[id]/transfer-ownership
routes.sessions.activity.POST → /api/sessions/[id]/activity
routes.sessions.completion.POST → /api/sessions/[id]/completion
routes.sessions.externalUrls.POST → /api/sessions/[id]/external-urls
routes.sessions.progress.POST → /api/sessions/[id]/progress
routes.sessions.toolError.POST → /api/sessions/[id]/tool-error

routes.public.stats.GET      → /api/public/stats
routes.public.sessions.GET   → /api/public/sessions
routes.public.sessionDetail.GET → /api/public/sessions/[id]

routes.cleanup.POST          → /api/cleanup
routes.cleanup.GET           → /api/cleanup
```

## Middleware Configuration

### `createAgentFactoryMiddleware(config?)`

```typescript
import { createAgentFactoryMiddleware } from '@supaku/agentfactory-nextjs'

const { middleware } = createAgentFactoryMiddleware({
  // Optional: customize route classification
  routes: {
    public: ['/api/public/', '/dashboard', '/'],
    protected: ['/api/sessions', '/api/workers'],
    webhook: '/webhook',
  },
  // Optional: customize rate limits
  rateLimits: {
    public: { max: 60, windowMs: 60_000 },
    webhook: { max: 10, windowMs: 1_000 },
  },
})
```

## Linear Client Resolver

### `createDefaultLinearClientResolver(config?)`

Resolves a Linear API client from environment variables, with workspace OAuth token fallback:

```typescript
import { createDefaultLinearClientResolver } from '@supaku/agentfactory-nextjs'

// Uses LINEAR_ACCESS_TOKEN env by default
const resolver = createDefaultLinearClientResolver()

// Custom env var name
const resolver = createDefaultLinearClientResolver({
  apiKeyEnvVar: 'MY_LINEAR_API_KEY',
})
```

The resolver implements the `LinearClientResolver` interface:

```typescript
interface LinearClientResolver {
  getClient(organizationId?: string): Promise<LinearAgentClient> | LinearAgentClient
}
```

When an `organizationId` is provided, it checks Redis for a stored OAuth token (from the OAuth callback flow). Otherwise falls back to the API key from the environment variable.

## Orchestrator Configuration

### `createOrchestrator(config)`

```typescript
import { createOrchestrator } from '@supaku/agentfactory'

const orchestrator = createOrchestrator({
  provider: myProvider,              // Agent provider instance
  maxConcurrent: 3,                  // Max concurrent agents
  project: 'MyProject',             // Project name filter
  worktreePath: '.worktrees',       // Git worktree base path
  linearApiKey: 'lin_api_...',      // Linear API key
  autoTransition: true,             // Auto-update issue status
  sandboxEnabled: false,            // Enable agent sandboxing
  inactivityTimeoutMs: 300_000,     // 5 minutes
  maxSessionTimeoutMs: 7_200_000,   // 2 hour hard cap
  workTypeTimeouts: {
    qa: { inactivityTimeoutMs: 600_000 },
    development: { inactivityTimeoutMs: 300_000 },
  },
})
```

## CLI Runner Functions

All CLI tools are available as programmatic functions via subpath exports:

```typescript
import { runOrchestrator } from '@supaku/agentfactory-cli/orchestrator'
import { runWorker } from '@supaku/agentfactory-cli/worker'
import { runWorkerFleet } from '@supaku/agentfactory-cli/worker-fleet'
import { runCleanup } from '@supaku/agentfactory-cli/cleanup'
import { runQueueAdmin } from '@supaku/agentfactory-cli/queue-admin'
import { runLogAnalyzer } from '@supaku/agentfactory-cli/analyze-logs'
```

These functions accept config objects and return Promises — use them to build thin CLI wrappers with your own env loading strategy.
