# Changelog

## v0.7.3

### Fixes

- **`create-agentfactory-app` scaffold overhaul** — Fixed multiple issues that caused scaffolded projects to fail at build time or crash on deployment:
  - **Edge Runtime middleware crash** — Changed middleware import from `@supaku/agentfactory-nextjs` (main barrel, pulls in Node.js-only deps like ioredis) to `@supaku/agentfactory-nextjs/middleware` (Edge-compatible subpath). Without this fix, every Vercel deployment crashes with `MIDDLEWARE_INVOCATION_FAILED` / `charCodeAt` errors.
  - **Tailwind v3 → v4** — Replaced deprecated Tailwind v3 setup (`tailwind.config.ts` + `postcss.config.js` + autoprefixer) with Tailwind v4 CSS-based config (`postcss.config.mjs` + `@tailwindcss/postcss`). Updated `globals.css` from `@tailwind` directives to `@import "tailwindcss"` + `@source`.
  - **CLI orchestrator missing `linearApiKey`** — `runOrchestrator()` requires `linearApiKey` but the scaffold omitted it, causing a TypeScript error.
  - **CLI cleanup called `.catch()` on sync return** — `runCleanup()` returns `CleanupResult` synchronously, not a Promise. The scaffold treated it as async.
  - **CLI worker/worker-fleet missing signal handling** — Added `AbortController` for graceful SIGINT/SIGTERM shutdown, environment variable fallbacks for `WORKER_CAPACITY`/`WORKER_PROJECTS`/`WORKER_FLEET_SIZE`, and full argument parsing.
  - **Stale dependency versions** — Bumped all `@supaku/agentfactory-*` deps from `^0.4.0` to `^0.7.2`, Next.js from `^15.3.0` to `^16.1.0`.
  - **Removed `/dashboard` from middleware matcher** — The dashboard lives at `/`, not `/dashboard`.

### Chores

- Aligned all package versions to 0.7.3 across the monorepo.

## v0.7.2

### Critical Fix

- **Prevent catastrophic main worktree destruction** — Fixed a critical bug where the stale worktree cleanup logic could `rm -rf` the main repository when a branch was checked out in the main working tree (e.g., via IDE). When the orchestrator encountered a branch conflict with the main tree, it incorrectly identified it as a "stale worktree" and attempted destructive cleanup, destroying all source files, `.git`, `.env.local`, and other untracked files.

  Three layered safety guards added to `tryCleanupConflictingWorktree()`:
  1. **`isMainWorktree()` check** — Detects the main working tree by verifying `.git` is a directory (not a worktree file), cross-checked with `git worktree list --porcelain`. Errs on the side of caution if undetermined.
  2. **`isInsideWorktreesDir()` check** — Ensures the conflict path is inside `.worktrees/` before any cleanup is attempted. Paths outside the worktrees directory are never touched.
  3. **`"is a main working tree"` error guard** — If `git worktree remove --force` itself reports the path is the main tree, the `rm -rf` fallback is now blocked instead of being used as escalation.

  Additionally, `removeWorktree()` in the CLI cleanup-runner now validates the target is not the main working tree before proceeding.

## v0.7.1

### Features

- **Worktree dependency symlinks** — Replaced `preInstallDependencies()` with `linkDependencies()` in the orchestrator. Symlinks `node_modules` from the main repo into worktrees instead of running `pnpm install`, making worktree setup near-instant vs 10+ minutes on cross-volume setups. Falls back to `pnpm install` if symlinking fails.

## v0.7.0

### Features

- **Linear CLI restored** — Ported the full Linear CLI entry point (`pnpm linear`) from the supaku repo. Provides 16 subcommands (`get-issue`, `create-issue`, `update-issue`, `create-comment`, `list-comments`, `add-relation`, `list-relations`, `remove-relation`, `list-sub-issues`, `list-sub-issue-statuses`, `update-sub-issue`, `check-blocked`, `list-backlog-issues`, `list-unblocked-backlog`, `check-deployment`) wrapping `@supaku/agentfactory-linear`. Runs via `node --import tsx` so it works in worktrees without a build step.
- **CLAUDE.md project instructions** — Added root-level `CLAUDE.md` with Linear CLI reference, autonomous mode detection, project structure, worktree lifecycle rules, and explicit prohibition of Linear MCP tools.
- **Agent definitions** — Added full agent definitions to `examples/agent-definitions/` for backlog-writer, developer, qa-reviewer, coordinator, and acceptance-handler. Each includes Linear CLI instructions and MCP prohibition.
- **Orchestrator CLI guidance** — All 10 work types in `generatePromptForWorkType()` now include explicit instructions to use `pnpm linear` instead of MCP tools.

### Fixes

- **Linear DEFAULT_TEAM_ID** — Resolved empty `DEFAULT_TEAM_ID` caused by ESM import hoisting.
- **Dashboard clickable links** — Styled issue identifiers as clickable links on fleet and pipeline pages.

### Chores

- Added `worker-fleet` and `analyze-logs` root scripts.
- Added "Built with AgentFactory" badge system and README badge.
- Resized badges to 20px to match shields.io standard.
- Fleet-runner changes.
- Consolidated backlog-writer to `examples/`, gitignored `.claude/`.
