# Migration from `@renseiai/agentfactory-cli` Legacy Binaries

> **Status:** In progress — most high-traffic binaries are already ported. See the tables below for the current state.

OSS users upgrading from the legacy Node/TypeScript `@renseiai/agentfactory-cli` binaries to the Go `af` CLI should use this guide as their reference. The Go `af` binary ships as a single static executable with no Node.js runtime dependency.

---

## Why two binaries? `af` vs `rensei`

| Binary | Purpose | Who uses it |
|--------|---------|-------------|
| `af` | Open-source, single-user CLI. Orchestrates local agent fleets, interacts with Linear, inspects logs, manages worktrees. No platform account required — just a `LINEAR_API_KEY`. | Individual developers, self-hosters, OSS contributors |
| `rensei` | Platform-aware CLI for Rensei AI customers. Adds multi-workspace OAuth, tenant-scoped billing, RBAC, remote fleet management, and telemetry. Wraps `af` functionality and extends it. | Teams and orgs using the hosted Rensei platform |

Everything in `af` works without a `rensei` account. If you are self-hosting, `af` is all you need.

---

## Primary binary mapping

The binaries listed in `packages/cli/package.json` "bin" entries, in order of typical usage frequency:

| Legacy binary | Go equivalent | Status | Linear ref |
|---------------|--------------|--------|-----------|
| `af-orchestrator` | `af orchestrator` | Ported | REN-1361 |
| `af-linear` | `af linear` | Ported | REN-1360 |
| `af-analyze-logs` | `af logs analyze` | Ported | REN-1359 |
| `af-cleanup` | `af admin cleanup` | Ported | REN-1362 |
| `af-queue-admin` | `af admin queue` | Ported | REN-1362 |
| `af-merge-queue` | `af admin merge-queue` | Ported | REN-1362 |
| `af-code` | `af code` | Ported | REN-1363 |
| `af-arch` | `af arch` | Ported | REN-1363 |

## Auxiliary binary mapping

These binaries handle utility and migration tasks. They are less frequently used and some may remain Node-only for the near term.

| Legacy binary | Go equivalent | Status | Notes |
|---------------|--------------|--------|-------|
| `af-worker` | `af worker` | Not yet ported | Remote worker for distributed fleet; tracking issue pending |
| `af-worker-fleet` | `af worker fleet` | Not yet ported | Multi-worker process manager; tracking issue pending |
| `af-agent` | `af agent` | Not yet ported | Session management (list/stop/chat/reconnect); tracking issue pending |
| `af-governor` | `af governor` | Not yet ported | Workflow governor / top-of-funnel automation; tracking issue pending |
| `af-setup` | `af setup` | Not yet ported | Dev-tool configuration (mergiraf); tracking issue pending |
| `af-add-dep` | `af add-dep` | Not yet ported | Safe dependency install in agent worktrees; tracking issue pending |
| `af-sync-routes` | `af sync-routes` | Not yet ported | Next.js route-file generator from manifest; tracking issue pending |
| `af-migrate-worktrees` | _(migration complete — retire after run)_ | Out of scope | One-shot migration from `.worktrees/` to sibling-dir layout; no Go port planned |
| `af-migrate-config-to-kits` | _(migration complete — retire after run)_ | Out of scope | One-shot `.agentfactory/config.yaml` → `.rensei/kits/` migration (REN-1294); no Go port planned |
| `agentfactory` (root binary) | `af` | Ported | Top-level dispatcher; the `agentfactory` name is the legacy alias |

> **"Out of scope"** binaries are one-shot migration tools. Once the migration they perform has been applied to your repository, the binary itself is no longer needed. They will not be ported to Go.

---

## Side-by-side flag comparison

### Orchestrator

| Task | Legacy | Go `af` |
|------|--------|---------|
| Process a project backlog | `af-orchestrator --project MyProject` | `af orchestrator --project MyProject` |
| Process single issue | `af-orchestrator --single PROJ-123` | `af orchestrator --single PROJ-123` |
| Limit concurrency | `af-orchestrator --project P --max 5` | `af orchestrator --project P --max 5` |
| Dry run | `af-orchestrator --project P --dry-run` | `af orchestrator --project P --dry-run` |
| Custom templates | `af-orchestrator --templates ./tmpl` | `af orchestrator --templates ./tmpl` |
| Scope to repo | `af-orchestrator --repo github.com/org/repo` | `af orchestrator --repo github.com/org/repo` |
| Force work type | `af-orchestrator --single P-1 --work-type qa` | `af orchestrator --single P-1 --work-type qa` |

### Linear CLI

| Task | Legacy | Go `af` |
|------|--------|---------|
| Get issue | `af-linear get-issue PROJ-123` | `af linear get-issue PROJ-123` |
| Create issue | `af-linear create-issue --title "T" --team "X"` | `af linear create-issue --title "T" --team "X"` |
| Create comment | `af-linear create-comment PROJ-123 --body "msg"` | `af linear create-comment PROJ-123 --body "msg"` |
| List backlog | `af-linear list-backlog-issues --project P` | `af linear list-backlog-issues --project P` |
| Check deployment | `af-linear check-deployment 42` | `af linear check-deployment 42` |
| Create blocker | `af-linear create-blocker PROJ-1 --title "T"` | `af linear create-blocker PROJ-1 --title "T"` |

### Log analyzer

| Task | Legacy | Go `af` |
|------|--------|---------|
| Analyze a session | `af-analyze-logs --session <id>` | `af logs analyze --session <id>` |
| Watch mode | `af-analyze-logs --follow` | `af logs analyze --follow` |
| Dry run | `af-analyze-logs --dry-run` | `af logs analyze --dry-run` |
| Cleanup old logs | `af-analyze-logs --cleanup` | `af logs analyze --cleanup` |

### Admin: cleanup, queue, merge-queue

| Task | Legacy | Go `af` |
|------|--------|---------|
| Cleanup worktrees (dry) | `af-cleanup --dry-run` | `af admin cleanup --dry-run` |
| Force cleanup | `af-cleanup --force` | `af admin cleanup --force` |
| List work queue | `af-queue-admin list` | `af admin queue list` |
| Clear stale claims | `af-queue-admin clear-claims` | `af admin queue clear-claims` |
| Full state reset | `af-queue-admin reset` | `af admin queue reset` |
| Merge queue status | `af-merge-queue status` | `af admin merge-queue status` |
| Retry failed PR | `af-merge-queue retry 42` | `af admin merge-queue retry 42` |
| Pause queue | `af-merge-queue pause` | `af admin merge-queue pause` |

### Code intelligence

| Task | Legacy | Go `af` |
|------|--------|---------|
| Search symbols | `af-code search-symbols "MyFunc"` | `af code search-symbols "MyFunc"` |
| Repo map | `af-code get-repo-map` | `af code get-repo-map` |
| BM25 code search | `af-code search-code "query"` | `af code search-code "query"` |
| Duplicate check | `af-code check-duplicate --content-file /tmp/s.ts` | `af code check-duplicate --content-file /tmp/s.ts` |
| Type usages | `af-code find-type-usages "MyType"` | `af code find-type-usages "MyType"` |
| Validate cross-deps | `af-code validate-cross-deps` | `af code validate-cross-deps` |

### Architectural intelligence

| Task | Legacy | Go `af` |
|------|--------|---------|
| Assess PR drift | `af-arch assess <pr-url>` | `af arch assess <pr-url>` |
| Assess by repo+PR number | `af-arch assess --repository github.com/org/r --pr 42` | `af arch assess --repository github.com/org/r --pr 42` |

---

## Per-binary deprecation notice templates

Copy the relevant block into your `CHANGELOG.md` when retiring each binary.

### `af-orchestrator`

```markdown
### Deprecated: `af-orchestrator`

The `af-orchestrator` binary (from `@renseiai/agentfactory-cli`) is deprecated
and will be removed in a future release. Use the Go `af orchestrator` command
instead — flags are identical. Ported in REN-1361.
```

### `af-linear`

```markdown
### Deprecated: `af-linear`

The `af-linear` binary (from `@renseiai/agentfactory-cli`) is deprecated and
will be removed in a future release. Use `af linear` instead — all subcommands
and flags are preserved. Ported in REN-1360.
```

### `af-analyze-logs`

```markdown
### Deprecated: `af-analyze-logs`

The `af-analyze-logs` binary (from `@renseiai/agentfactory-cli`) is deprecated.
Use `af logs analyze` instead. Note the subcommand path change: the top-level
`logs` group now houses all log-related commands. Ported in REN-1359.
```

### `af-cleanup`

```markdown
### Deprecated: `af-cleanup`

The `af-cleanup` binary (from `@renseiai/agentfactory-cli`) is deprecated. Use
`af admin cleanup` instead — flags (`--dry-run`, `--force`, `--path`, etc.) are
preserved. Ported in REN-1362.
```

### `af-queue-admin`

```markdown
### Deprecated: `af-queue-admin`

The `af-queue-admin` binary (from `@renseiai/agentfactory-cli`) is deprecated.
Use `af admin queue` instead — all subcommands (`list`, `sessions`, `workers`,
`clear-claims`, `clear-queue`, `reset`, `remove`) are preserved. Ported in
REN-1362.
```

### `af-merge-queue`

```markdown
### Deprecated: `af-merge-queue`

The `af-merge-queue` binary (from `@renseiai/agentfactory-cli`) is deprecated.
Use `af admin merge-queue` instead — subcommands (`status`, `list`, `retry`,
`skip`, `pause`, `resume`, `priority`) and flags are preserved. Ported in
REN-1362.
```

### `af-code`

```markdown
### Deprecated: `af-code`

The `af-code` binary (from `@renseiai/agentfactory-cli`) is deprecated. Use
`af code` instead — all subcommands and flags are preserved. Ported in REN-1363.
```

### `af-arch`

```markdown
### Deprecated: `af-arch`

The `af-arch` binary (from `@renseiai/agentfactory-cli`) is deprecated. Use
`af arch` instead — the `assess` subcommand and all flags are preserved. Ported
in REN-1363.
```

---

## Installation

### Legacy (Node.js)

```bash
npm install -g @renseiai/agentfactory-cli
# Provides: af-orchestrator, af-linear, af-analyze-logs, af-cleanup, ...
# Requires: Node.js >= 22
```

### Go `af` (recommended)

```bash
# macOS (Homebrew — when available)
brew install renseiai/tap/af

# Direct download (all platforms)
curl -sSfL https://github.com/RenseiAI/af/releases/latest/download/install.sh | sh

# After install
af --version
```

The Go binary is statically compiled — no Node.js, no `node_modules`, no pnpm.

---

## Environment variable compatibility

All environment variables used by the legacy CLI are honoured by `af`:

| Variable | Used by |
|----------|---------|
| `LINEAR_API_KEY` | `af orchestrator`, `af linear`, `af logs analyze`, `af governor` |
| `REDIS_URL` | `af admin queue`, `af admin merge-queue`, `af agent` |
| `WORKER_API_URL` | `af worker` |
| `WORKER_API_KEY` | `af worker` |
| `WORKER_PROJECTS` | `af worker`, `af worker fleet` |
| `ANTHROPIC_API_KEY` | `af arch` |
| `RENSEI_DRIFT_GATE` | `af arch` |
| `VOYAGE_AI_API_KEY` | `af code` (optional — enables vector embeddings) |
| `COHERE_API_KEY` | `af code` (optional — enables cross-encoder reranking) |
| `GOVERNOR_PROJECTS` | `af governor` |

---

## Related documentation

- [Getting Started](./getting-started.md)
- [Configuration reference](./configuration.md)
- [Providers](./providers.md)
- [Code Intelligence](./code-intelligence.md)
