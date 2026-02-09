# Distributed Workers

Scale your agent fleet horizontally with Redis-coordinated workers.

## Architecture

```
Webhook/API ──> Coordinator ──> Redis Queue ──> Worker Nodes
                                                  ├── Worker 1 (2 agents)
                                                  ├── Worker 2 (3 agents)
                                                  └── Worker 3 (1 agent)
```

- **Coordinator**: Receives webhooks or API calls, enqueues work into Redis
- **Workers**: Poll the queue, claim work atomically, run agents locally
- **Redis**: Priority queue + session storage + worker heartbeats

## Setup

```bash
# Start Redis
docker run -d -p 6379:6379 redis:7

# Set environment
export REDIS_URL=redis://localhost:6379
export LINEAR_API_KEY=lin_api_...
```

## Run

```bash
# Terminal 1: Enqueue work
npx tsx examples/distributed/index.ts coordinator PROJ-123

# Terminal 2: Run a worker
npx tsx examples/distributed/index.ts worker
```

## Server Package Components

| Component | Description |
|-----------|-------------|
| `createWorkQueue` | Priority queue with atomic claim/release |
| `createSessionStorage` | Session state persistence (status, cost, timestamps) |
| `createWorkerStorage` | Worker registration and heartbeat tracking |
| `createIssueLock` | Per-issue mutex to prevent duplicate work |
| `createAgentTracking` | QA attempt counts and agent-worked history |
| `createWebhookIdempotency` | Dedup webhook deliveries |

## Scaling

Each worker runs independently. Scale by adding more worker processes:

```bash
# Run 3 workers on different machines
REDIS_URL=redis://shared-redis:6379 npx tsx examples/distributed/index.ts worker
```

Workers coordinate through Redis — no direct communication between workers.
