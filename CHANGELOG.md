# Changelog

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
