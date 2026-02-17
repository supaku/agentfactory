# AgentFactory Monorepo

Multi-agent fleet management for coding agents. This is a pnpm monorepo using Turborepo.

## Project Structure

| Package | Path | Purpose |
|---------|------|---------|
| `@supaku/agentfactory` | `packages/core` | Orchestrator, providers, crash recovery, deployment checker |
| `@supaku/agentfactory-linear` | `packages/linear` | Linear SDK client, agent sessions, webhook types |
| `@supaku/agentfactory-server` | `packages/server` | Work queue server for webhook-driven execution |
| `@supaku/agentfactory-nextjs` | `packages/nextjs` | Next.js webhook handlers and middleware |
| `@supaku/agentfactory-dashboard` | `packages/dashboard` | Fleet management dashboard UI |
| `@supaku/create-agentfactory` | `packages/create-app` | Project scaffolding CLI |
| `@supaku/agentfactory-cli` | `packages/cli` | Orchestrator, worker, Linear CLI, and admin entry points |

## Linear CLI (CRITICAL)

**Use `pnpm linear` for ALL Linear operations. Do NOT use Linear MCP tools.**

The Linear CLI wraps the `@supaku/agentfactory-linear` SDK and outputs JSON to stdout. All agents must use this CLI instead of MCP tools for Linear interactions.

### Commands

```bash
# Issue operations
pnpm linear get-issue <id>
pnpm linear create-issue --title "Title" --team "TeamName" [--description "..."] [--project "..."] [--labels "Label1,Label2"] [--state "Backlog"] [--parentId "..."]
pnpm linear update-issue <id> [--title "..."] [--description "..."] [--state "..."] [--labels "..."]

# Comments
pnpm linear list-comments <issue-id>
pnpm linear create-comment <issue-id> --body "Comment text"

# Relations
pnpm linear add-relation <issue-id> <related-issue-id> --type <related|blocks|duplicate>
pnpm linear list-relations <issue-id>
pnpm linear remove-relation <relation-id>

# Sub-issues (for coordination)
pnpm linear list-sub-issues <parent-issue-id>
pnpm linear list-sub-issue-statuses <parent-issue-id>
pnpm linear update-sub-issue <id> [--state "Finished"] [--comment "Done"]

# Blocking checks
pnpm linear check-blocked <issue-id>
pnpm linear list-backlog-issues --project "ProjectName"
pnpm linear list-unblocked-backlog --project "ProjectName"

# Deployment
pnpm linear check-deployment <pr-number> [--format json|markdown]
```

### Key Rules

- `--team` is **always required** for `create-issue`
- Use `--state` not `--status` (e.g., `--state "Backlog"`)
- Use label **names** not UUIDs (e.g., `--labels "Feature"`)
- `--labels` accepts comma-separated values: `--labels "Bug,Feature"`
- All commands return JSON to stdout — capture the `id` field for subsequent operations
- Use `--parentId` when creating sub-issues to enable coordinator orchestration

## Autonomous Operation Mode

When running as an automated agent (via webhook or orchestrator), Claude operates in headless mode.

### Detection

```typescript
const isAutonomous = !!process.env.LINEAR_SESSION_ID
```

### Autonomous Behavior Rules

**When `LINEAR_SESSION_ID` is set, you are running autonomously:**

1. **Never ask for user input** — `AskUserQuestion` is disabled. Make autonomous decisions based on issue description, existing code patterns, and best practices.
2. **Make reasonable assumptions** — choose the simplest solution, follow existing patterns, document assumptions in code comments or PR description.
3. **Complete the full workflow** — implement, test (`pnpm test`, `pnpm typecheck`), create PR, report status.
4. **Handle errors gracefully** — try alternatives; if blocked, post a Linear comment and mark as failed.
5. **Never delete your own worktree** — see Worktree Lifecycle Rules below.

## File Operations Best Practices

### Read Before Write Rule

**Always read existing files before writing to them.** Claude Code enforces this — writing to an existing file without reading it first will fail.

**Correct workflow:**
1. Use Read tool to view the current file content
2. Analyze what needs to change
3. Use Edit tool for targeted changes, or Write tool for complete rewrites

### Working with Large Files

When you encounter "exceeds maximum allowed tokens" error when reading files:
- Use Grep to search for specific code patterns instead of reading entire files
- Use Read with `offset`/`limit` parameters to paginate through large files
- Avoid reading auto-generated files (use Grep instead)

## Worktree Lifecycle Rules

### Never Delete Your Own Worktree

The orchestrator manages worktree creation and cleanup. Agents must:

1. **NEVER run**: `git worktree remove`, `git worktree prune`
2. **NEVER run**: `git checkout`, `git switch` (to a different branch)
3. **NEVER run**: `git reset --hard`, `git clean -fd`, `git restore .`
4. **NEVER delete** or modify the `.git` file in the worktree root
5. Only the orchestrator manages worktree lifecycle

### Shared Worktree Rules (Coordination)

When multiple sub-agents run concurrently in the same worktree:
- Work only on files relevant to your sub-issue
- Commit changes with descriptive messages before reporting completion
- Prefix every sub-agent prompt with: "SHARED WORKTREE — DO NOT MODIFY GIT STATE"

## Dependency Installation

Dependencies are pre-installed by the orchestrator. Do NOT run `pnpm install` unless you encounter a specific missing module error. If you must run it, run it **synchronously** (never with `run_in_background`). Never use sleep or polling loops.

## Orchestrator Usage

```bash
# Process backlog issues from a specific project
pnpm orchestrator --project ProjectName

# Process a single issue
pnpm orchestrator --single ISSUE-123

# Preview without executing
pnpm orchestrator --project ProjectName --dry-run

# Custom concurrency
pnpm orchestrator --project ProjectName --max 2
```

## Build & Test

```bash
pnpm build        # Build all packages
pnpm test         # Run all tests
pnpm typecheck    # Type-check all packages
pnpm clean        # Clean all dist directories
```
