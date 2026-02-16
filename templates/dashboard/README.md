# AgentFactory Dashboard

AI agent fleet management dashboard powered by [AgentFactory](https://github.com/supaku-org/agentfactory).

## One-Click Deploy

### Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fsupaku-org%2Fagentfactory-dashboard-template&env=LINEAR_ACCESS_TOKEN,LINEAR_WEBHOOK_SECRET,REDIS_URL,NEXT_PUBLIC_APP_URL&envDescription=Environment%20variables%20needed%20for%20AgentFactory%20Dashboard&envLink=https%3A%2F%2Fgithub.com%2Fsupaku-org%2Fagentfactory-dashboard-template%23environment-variables&project-name=agentfactory-dashboard)

> **Note:** Vercel does not include built-in Redis. Add [Vercel KV](https://vercel.com/docs/storage/vercel-kv) or [Upstash Redis](https://upstash.com/) after deployment and set the `REDIS_URL` environment variable.

### Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/agentfactory?referralCode=supaku)

> **Advantage:** Railway bundles Redis as a companion service — Redis is provisioned automatically with the template.

## Quick Start (Local)

```bash
# Clone this repository
git clone https://github.com/supaku-org/agentfactory-dashboard-template.git
cd agentfactory-dashboard-template

# Install dependencies
npm install

# Copy environment variables
cp .env.example .env.local

# Edit .env.local with your Linear API key and webhook secret

# Start development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to see the dashboard.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LINEAR_ACCESS_TOKEN` | Yes | Linear API key ([create here](https://linear.app/settings/api)) |
| `LINEAR_WEBHOOK_SECRET` | Yes | Webhook signature verification (32+ chars) |
| `REDIS_URL` | Yes | Redis connection string |
| `NEXT_PUBLIC_APP_URL` | Yes | Public URL of your deployment |
| `WORKER_API_KEY` | Production | Worker authentication bearer token |
| `CRON_SECRET` | Production | Cron endpoint auth token |
| `SESSION_HASH_SALT` | Production | Session hashing salt |

See [.env.example](.env.example) for the full list with descriptions.

## Setup Guide

### 1. Linear API Key

1. Go to [Linear Settings > API](https://linear.app/settings/api)
2. Create a Personal API Key
3. Set `LINEAR_ACCESS_TOKEN` to the generated key

### 2. Linear Webhook

1. Go to [Linear Settings > API > Webhooks](https://linear.app/settings/api)
2. Create a new webhook pointing to `https://your-app.com/webhook`
3. Select events: Issue updates, Comments
4. Copy the signing secret to `LINEAR_WEBHOOK_SECRET`

### 3. Redis

**Vercel:** Add [Vercel KV](https://vercel.com/docs/storage/vercel-kv) from the Storage tab, or create an [Upstash Redis](https://upstash.com/) database and copy the connection URL.

**Railway:** Redis is provisioned automatically. The `REDIS_URL` variable is injected via service reference.

**Local:** Run `redis-server` or use Docker: `docker run -p 6379:6379 redis`

## Architecture

This is a [Next.js](https://nextjs.org) application that provides:

- **Webhook server** — receives Linear webhook events and manages agent sessions
- **Fleet dashboard** — real-time overview of active agents, sessions, and pipeline
- **API routes** — worker registration, session management, and public stats
- **CLI tools** — local worker, orchestrator, and fleet management scripts

### Pages

| Route | Description |
|-------|-------------|
| `/` | Fleet overview with agent status |
| `/pipeline` | Kanban-style pipeline view |
| `/sessions` | Session list and detail views |
| `/settings` | Integration status and configuration |

### Key Dependencies

| Package | Purpose |
|---------|---------|
| `@supaku/agentfactory-nextjs` | Route handlers and middleware |
| `@supaku/agentfactory-dashboard` | UI components and pages |
| `@supaku/agentfactory-server` | Redis-backed session/worker persistence |
| `@supaku/agentfactory-linear` | Linear SDK client |

## Platform Comparison

| Feature | Vercel | Railway |
|---------|--------|---------|
| Redis included | No (add Vercel KV/Upstash) | Yes (companion service) |
| Auto-detect Next.js | Yes | Yes (via Railpack) |
| Custom domain | Yes | Yes |
| Health checks | Via Vercel | Configurable in railway.toml |
| Pricing | Free tier available | Free tier available |

## Staying Up to Date

This template is kept in sync with the [AgentFactory monorepo](https://github.com/supaku-org/agentfactory) via automated CI. When new versions of `@supaku/agentfactory-*` packages are released, a PR is automatically opened to update this template.

To manually update package versions:

```bash
npm install @supaku/agentfactory@latest @supaku/agentfactory-linear@latest \
  @supaku/agentfactory-nextjs@latest @supaku/agentfactory-server@latest \
  @supaku/agentfactory-dashboard@latest @supaku/agentfactory-cli@latest
```

## License

MIT
