# @supaku/agentfactory-cli

CLI tools for [AgentFactory](https://github.com/supaku/agentfactory). Run a local orchestrator, remote workers, worker fleets, and queue management.

## Installation

```bash
# Global (CLI commands)
npm install -g @supaku/agentfactory-cli

# Local (programmatic runner functions)
npm install @supaku/agentfactory-cli
```

## CLI Commands

```bash
# Spawn agents on backlog issues
af-orchestrator --project MyProject --max 3

# Process a single issue
af-orchestrator --single PROJ-123

# Dry run — preview what would be processed
af-orchestrator --project MyProject --dry-run

# Start a remote worker
af-worker --api-url https://your-app.vercel.app --api-key your-key

# Start a worker fleet (auto-detects CPU cores)
af-worker-fleet --api-url https://your-app.vercel.app --api-key your-key

# Clean up orphaned git worktrees
af-cleanup

# Queue management
af-queue-admin list
af-queue-admin drain

# Analyze agent session logs
af-analyze-logs --follow
```

## Programmatic Usage

All CLI tools are available as importable functions via subpath exports:

```typescript
import { runOrchestrator } from '@supaku/agentfactory-cli/orchestrator'

await runOrchestrator({
  project: 'MyProject',
  max: 3,
  dryRun: false,
})
```

### Available Runner Functions

```typescript
import { runOrchestrator } from '@supaku/agentfactory-cli/orchestrator'
import { runWorker } from '@supaku/agentfactory-cli/worker'
import { runWorkerFleet } from '@supaku/agentfactory-cli/worker-fleet'
import { runCleanup } from '@supaku/agentfactory-cli/cleanup'
import { runQueueAdmin } from '@supaku/agentfactory-cli/queue-admin'
import { runLogAnalyzer } from '@supaku/agentfactory-cli/analyze-logs'
```

Each function accepts a config object and returns a Promise — use them to build thin wrappers with your own env loading and argument parsing.

## Environment Variables

| Variable | Used By | Description |
|----------|---------|-------------|
| `LINEAR_API_KEY` | orchestrator | Linear API key |
| `WORKER_API_URL` | worker, fleet | Webhook server URL |
| `WORKER_API_KEY` | worker, fleet | API key for authentication |
| `REDIS_URL` | queue-admin | Redis connection URL |

## Related Packages

| Package | Description |
|---------|-------------|
| [@supaku/agentfactory](https://www.npmjs.com/package/@supaku/agentfactory) | Core orchestrator |
| [@supaku/agentfactory-server](https://www.npmjs.com/package/@supaku/agentfactory-server) | Redis work queue |
| [@supaku/agentfactory-nextjs](https://www.npmjs.com/package/@supaku/agentfactory-nextjs) | Next.js webhook server |

## License

MIT
