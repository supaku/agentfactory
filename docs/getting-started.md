# Getting Started

This guide walks through setting up AgentFactory to process Linear issues with coding agents.

## Prerequisites

- **Node.js** >= 22
- **pnpm** >= 8 (or npm/yarn)
- **Git** — agents work in git worktrees
- **Linear account** — with API key access
- A coding agent installed:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (default)
  - [OpenAI Codex](https://platform.openai.com/docs/guides/codex) (experimental)

## Quick Start (recommended)

The fastest way to get started is with the scaffolding tool:

```bash
npx @supaku/create-agentfactory-app my-agent

cd my-agent
cp .env.example .env.local    # Fill in LINEAR_ACCESS_TOKEN
pnpm install && pnpm dev      # Start webhook server
pnpm worker                   # Start local worker (in another terminal)
```

This creates a complete Next.js webhook server with all route handlers, middleware, OAuth, and CLI tools preconfigured.

## Manual Installation

If you prefer to add AgentFactory to an existing project:

```bash
# Webhook server (Next.js) — includes all route handlers
npm install @supaku/agentfactory-nextjs

# Core + Linear integration (for CLI-only usage)
npm install @supaku/agentfactory @supaku/agentfactory-linear

# Optional: CLI tools (orchestrator, worker, fleet)
npm install @supaku/agentfactory-cli

# Optional: Distributed workers (requires Redis)
npm install @supaku/agentfactory-server
```

## Configuration

### Environment Variables

Create a `.env.local` file:

```bash
# Required
LINEAR_ACCESS_TOKEN=lin_api_...

# Webhook verification
LINEAR_WEBHOOK_SECRET=your-webhook-secret

# Optional: agent provider (default: claude)
AGENT_PROVIDER=claude

# Optional: Linear team/project IDs
LINEAR_TEAM_ID=your-team-uuid

# Optional: Redis (for distributed mode)
REDIS_URL=redis://localhost:6379

# Optional: Worker configuration
WORKER_API_URL=https://your-app.vercel.app
WORKER_API_KEY=your-api-key
```

### Linear Setup

#### Step 1: Create a Linear API Key

1. Go to [Linear Settings > API](https://linear.app/settings/api)
2. Under **Personal API Keys**, click "Create key"
3. Copy the key (starts with `lin_api_`)
4. Set it as both `LINEAR_ACCESS_TOKEN` and `LINEAR_API_KEY` in your `.env.local`

> **Note:** `LINEAR_ACCESS_TOKEN` is used by the Next.js webhook server. `LINEAR_API_KEY` is used by CLI tools. They can be the same key.

#### Step 2: Configure the Webhook

1. In Linear, go to **Settings > API > Webhooks**
2. Click "New webhook" and configure:
   - **Label:** AgentFactory (or any name)
   - **URL:** `https://your-app.example.com/webhook` (your deployed app URL + `/webhook`)
   - **Events:** Enable the following:
     - `AgentSession` — created, updated, prompted (triggers agent work)
     - `Issue` — updated (triggers auto-QA and auto-acceptance on status transitions)
3. Copy the **Signing Secret** and set it as `LINEAR_WEBHOOK_SECRET`

The webhook handler verifies every request in production using HMAC-SHA256 via the `linear-signature` header. In development, verification is logged as a warning but not enforced.

#### Step 3: Verify the Webhook

After deploying, confirm the webhook is working:

```bash
# The GET endpoint returns a health check
curl https://your-app.example.com/webhook
# Should return: {"status":"ok",...}
```

Then trigger a test event in Linear (e.g., move an issue to Backlog). Check your server logs for incoming webhook events.

#### OAuth Setup (Optional — Multi-Workspace)

For teams managing multiple Linear workspaces from a single AgentFactory instance:

1. In Linear, go to **Settings > API > OAuth applications**
2. Create a new OAuth app:
   - **Redirect URI:** `https://your-app.example.com/callback`
   - **Scopes:** `read`, `write`, `issues:create`, `comments:create`
3. Set the credentials:
   ```bash
   LINEAR_CLIENT_ID=your-oauth-client-id
   LINEAR_CLIENT_SECRET=your-oauth-client-secret
   NEXT_PUBLIC_APP_URL=https://your-app.example.com
   ```
4. OAuth tokens are stored in Redis (requires `REDIS_URL`) and auto-refreshed before expiration

When an `organizationId` is present on a webhook event, AgentFactory checks Redis for a workspace-specific OAuth token before falling back to `LINEAR_ACCESS_TOKEN`.

#### Troubleshooting

| Problem | Solution |
|---------|----------|
| 503 on `/webhook` POST | `LINEAR_WEBHOOK_SECRET` not set in production — add it to your environment |
| 401 on `/webhook` POST | Webhook signing secret mismatch — copy the secret from Linear Settings > API > Webhooks |
| Webhook events not arriving | Verify the URL is publicly accessible and matches `/webhook` exactly |
| Agent not triggered on issue move | Check that `Issue` updated events are enabled on the webhook |
| OAuth callback fails | Ensure `NEXT_PUBLIC_APP_URL` matches the redirect URI in your Linear OAuth app |

## Webhook Server Setup

If you used `@supaku/create-agentfactory-app`, this is already configured. For manual setup:

### Route Configuration

Create `src/lib/config.ts`:

```typescript
import { createAllRoutes, createDefaultLinearClientResolver } from '@supaku/agentfactory-nextjs'

export const routes = createAllRoutes({
  linearClient: createDefaultLinearClientResolver(),
  // Optional: customize prompt generation
  // generatePrompt: (identifier, workType) => `Work on ${identifier}`,
})
```

### Route Re-exports

Each API route is a 2-line file that re-exports from the config:

```typescript
// src/app/webhook/route.ts
import { routes } from '@/lib/config'
export const POST = routes.webhook.POST
export const GET = routes.webhook.GET
```

```typescript
// src/app/api/sessions/route.ts
import { routes } from '@/lib/config'
export const GET = routes.sessions.list.GET
```

### Middleware

Create `src/middleware.ts`:

```typescript
import { createAgentFactoryMiddleware } from '@supaku/agentfactory-nextjs'

const { middleware } = createAgentFactoryMiddleware()

export { middleware }

export const config = {
  matcher: ['/api/:path*', '/webhook', '/dashboard', '/sessions/:path*', '/'],
}
```

The middleware handles API key authentication, rate limiting, and webhook signature verification.

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
- [Configuration](./configuration.md) — complete config reference
- [Providers](./providers.md) — configure multiple agent providers
- [Examples](../examples/) — working code samples
