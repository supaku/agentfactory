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

**Use `pnpm af-linear` for ALL Linear operations. Do NOT use Linear MCP tools.**

The Linear CLI wraps the `@supaku/agentfactory-linear` SDK and outputs JSON to stdout. All agents must use this CLI instead of MCP tools for Linear interactions.

### Commands

```bash
# Issue operations
pnpm af-linear get-issue <id>
pnpm af-linear create-issue --title "Title" --team "TeamName" [--description "..."] [--project "..."] [--labels "Label1,Label2"] [--state "Backlog"] [--parentId "..."]
pnpm af-linear update-issue <id> [--title "..."] [--description "..."] [--state "..."] [--labels "..."]

# Comments
pnpm af-linear list-comments <issue-id>
pnpm af-linear create-comment <issue-id> --body "Comment text"

# Relations
pnpm af-linear add-relation <issue-id> <related-issue-id> --type <related|blocks|duplicate>
pnpm af-linear list-relations <issue-id>
pnpm af-linear remove-relation <relation-id>

# Sub-issues (for coordination)
pnpm af-linear list-sub-issues <parent-issue-id>
pnpm af-linear list-sub-issue-statuses <parent-issue-id>
pnpm af-linear update-sub-issue <id> [--state "Finished"] [--comment "Done"]

# Blocking checks
pnpm af-linear check-blocked <issue-id>
pnpm af-linear list-backlog-issues --project "ProjectName"
pnpm af-linear list-unblocked-backlog --project "ProjectName"

# Deployment
pnpm af-linear check-deployment <pr-number> [--format json|markdown]

# Blocker creation
pnpm af-linear create-blocker <source-issue-id> --title "Title" [--description "..."] [--team "..."] [--project "..."] [--assignee "user@email.com"]
```

### Key Rules

- `--team` is **required** for `create-issue` unless `LINEAR_TEAM_NAME` env var is set (auto-set by orchestrator)
- Use `--state` not `--status` (e.g., `--state "Backlog"`)
- Use label **names** not UUIDs (e.g., `--labels "Feature"`)
- `--labels` accepts comma-separated values: `--labels "Bug,Feature"`
- All commands return JSON to stdout — capture the `id` field for subsequent operations
- Use `--parentId` when creating sub-issues to enable coordinator orchestration

## Route Sync CLI

After upgrading `@supaku` packages, new routes may be missing from `src/app/`. Use `af-sync-routes` to generate missing route files from the manifest.

```bash
# Preview what would be created
pnpm af-sync-routes --dry-run

# Create missing API route files
pnpm af-sync-routes

# Also sync dashboard page files
pnpm af-sync-routes --pages
```

- Never overwrites existing files
- Pages are opt-in via `--pages` (API routes sync by default)
- Use `--app-dir <path>` for non-standard app directory

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

# Restrict to a specific git repository
pnpm orchestrator --project ProjectName --repo github.com/supaku/agentfactory
```

## Repository-Scoped Orchestration

The orchestrator validates that agents only push to the correct repository. Configure via:

### .agentfactory/config.yaml

Checked into each repository to define allowed projects and repository identity:

```yaml
# Single-project repo
apiVersion: v1
kind: RepositoryConfig
repository: github.com/supaku/agentfactory
allowedProjects:
  - Agent

# Monorepo with path scoping
apiVersion: v1
kind: RepositoryConfig
repository: github.com/supaku/supaku
projectPaths:
  Social: apps/social
  Family: apps/family
  Extension: apps/social-capture-extension
sharedPaths:
  - packages/ui
  - packages/lexical
```

- `repository`: Git remote URL pattern validated at startup against `git remote get-url origin`
- `allowedProjects`: Only issues from these Linear projects are processed
- `projectPaths`: Maps project names to their root directory (mutually exclusive with `allowedProjects`). When set, allowed projects are auto-derived from keys. Agents receive directory scoping instructions in their prompts.
- `sharedPaths`: Directories any project's agent may modify (only used with `projectPaths`)

### Validation layers

1. **OrchestratorConfig.repository** — validates git remote at constructor time and before spawning agents
2. **CLI `--repo` flag** — passes repository to OrchestratorConfig from the command line
3. **.agentfactory/config.yaml** — auto-loaded at startup, filters issues by `allowedProjects` or `projectPaths` keys
4. **Template partial `{{> partials/repo-validation}}`** — agents verify git remote before any push
5. **Template partial `{{> partials/path-scoping}}`** — agents verify file changes are within project scope
6. **Linear project metadata** — cross-references project repo link with config

## Workflow Template System

Agent prompts are driven by YAML templates with Handlebars interpolation. Templates live in `packages/core/src/templates/defaults/` and can be overridden per project.

### Template Structure

```yaml
apiVersion: v1
kind: WorkflowTemplate
metadata:
  name: development
  description: Standard development workflow
  workType: development
tools:
  allow:
    - shell: "pnpm *"
    - shell: "git commit *"
  disallow:
    - user-input
prompt: |
  Start work on {{identifier}}.
  {{> partials/dependency-instructions}}
  {{> partials/cli-instructions}}
  {{#if mentionContext}}
  Additional context: {{mentionContext}}
  {{/if}}
```

### Customizing Templates

Override built-in templates by creating `.agentfactory/templates/` in your project root:

```
.agentfactory/
  templates/
    development.yaml      # Override development workflow
    qa.yaml               # Override QA workflow
    partials/
      custom-partial.yaml # Custom partial for {{> partials/custom-partial}}
```

Templates are resolved in layers (later overrides earlier):
1. Built-in defaults (`packages/core/src/templates/defaults/`)
2. Project-level overrides (`.agentfactory/templates/`)
3. Programmatic overrides (`WebhookConfig.generatePrompt` still works)

### CLI Flag

```bash
pnpm orchestrator --project MyProject --templates /path/to/templates
```

### Template Variables

| Variable | Description |
|----------|-------------|
| `{{identifier}}` | Issue ID (e.g., "SUP-123") |
| `{{mentionContext}}` | Optional user mention text |
| `{{startStatus}}` | Frontend-resolved start status |
| `{{completeStatus}}` | Frontend-resolved complete status |
| `{{parentContext}}` | Parent issue context for coordination |
| `{{subIssueList}}` | Formatted sub-issue list |
| `{{repository}}` | Git repository URL pattern for pre-push validation |
| `{{projectPath}}` | Root directory for this project in a monorepo (e.g., `apps/family`) |
| `{{sharedPaths}}` | Shared directories any project may modify (array) |
| `{{buildCommand}}` | Build command override for native projects (e.g., `cargo build`) |
| `{{testCommand}}` | Test command override for native projects (e.g., `cargo test`) |
| `{{validateCommand}}` | Validation command override — replaces typecheck (e.g., `cargo clippy`) |

### Available Partials

| Partial | Description |
|---------|-------------|
| `{{> partials/cli-instructions}}` | Linear CLI + human blocker instructions |
| `{{> partials/dependency-instructions}}` | Dependency installation rules |
| `{{> partials/large-file-instructions}}` | Token limit handling |
| `{{> partials/work-result-marker}}` | QA/acceptance WORK_RESULT marker |
| `{{> partials/shared-worktree-safety}}` | Shared worktree safety rules |
| `{{> partials/pr-selection}}` | PR selection guidance |
| `{{> partials/repo-validation}}` | Pre-push git remote URL validation |
| `{{> partials/path-scoping}}` | Monorepo directory scoping instructions |
| `{{> partials/native-build-validation}}` | Build system detection and safety checks for native projects |

### Tool Permissions

Templates express tool permissions in a provider-agnostic format:

```yaml
tools:
  allow:
    - shell: "pnpm *"      # → Claude: Bash(pnpm:*)
    - shell: "git commit *" # → Claude: Bash(git commit:*)
  disallow:
    - user-input            # → Claude: AskUserQuestion
```

Provider adapters translate these to native format at runtime.

## Build & Test

```bash
pnpm build        # Build all packages
pnpm test         # Run all tests
pnpm typecheck    # Type-check all packages
pnpm clean        # Clean all dist directories
```
