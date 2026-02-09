# Multi-Provider

Run different coding agents for different work types or projects.

## How Provider Resolution Works

AgentFactory checks environment variables in priority order:

```
1. AGENT_PROVIDER_{WORKTYPE}   (highest priority)
2. AGENT_PROVIDER_{PROJECT}
3. AGENT_PROVIDER              (global default)
4. 'claude'                    (fallback)
```

## Example Setup

```bash
# Use Claude for development, Codex for QA
export AGENT_PROVIDER=claude
export AGENT_PROVIDER_QA=codex

# Override for a specific project
export AGENT_PROVIDER_SOCIAL=amp
```

With this configuration:

| Context | Provider |
|---------|----------|
| Development on Social | amp (project override) |
| QA on Social | codex (work type beats project) |
| Development on Backend | claude (global default) |
| QA on Backend | codex (work type override) |

## Run

```bash
npx tsx examples/multi-provider/index.ts MyProject
```

## Per-Work-Type Timeouts

Different work types can have different timeout thresholds:

```typescript
const orchestrator = createOrchestrator({
  workTypeTimeouts: {
    development: { inactivityTimeoutMs: 300_000 },    // 5 min
    qa: { inactivityTimeoutMs: 600_000 },              // 10 min (test suites pause)
    acceptance: { inactivityTimeoutMs: 120_000 },      // 2 min (quick checks)
  },
})
```
