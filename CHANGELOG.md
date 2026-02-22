# Changelog

## v0.7.21

### Fixes

- **Add WORK_RESULT marker instructions to coordination prompts** — The `qa-coordination` and `acceptance-coordination` work types were treated as result-sensitive by the orchestrator (requiring `<!-- WORK_RESULT:passed/failed -->` in the agent's final output), but neither prompt template included the structured result marker instructions. This caused the orchestrator to post a false "no structured result marker detected" warning even when the QA coordinator successfully moved the issue to Delivered. Fixed in both the hardcoded prompts (`orchestrator.ts`) and the YAML templates (`qa-coordination.yaml`, `acceptance-coordination.yaml`).

## v0.7.20

### Fixes

- **Strip Anthropic API keys from agent environments** — App `.env.local` files (e.g. `apps/social/.env.local`) may contain `ANTHROPIC_API_KEY` for runtime use. The orchestrator was loading these and passing them into Claude Code agent processes, causing Claude Code to switch from Max subscription billing to API-key billing. Added `AGENT_ENV_BLOCKLIST` that strips `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, and `OPENCLAW_GATEWAY_TOKEN` from all three env sources (`process.env`, app env files, and `settings.local.json`) before spawning agents. Applied to both `spawnAgent()` and `forwardPrompt()` code paths.
- **Governor skips sub-issues in all statuses** — Previously only skipped sub-issues in Backlog; now skips in all statuses to prevent double-dispatch.
- **Optimize N+1 GraphQL queries** — Reduced Linear API calls for sub-issue graph, relations, and status fetching from O(N) to O(1) using raw GraphQL queries with nested fields.
- **Skip Linear forwarding for governor-generated fake session IDs** — Prevents 404 errors when the governor creates synthetic sessions for internal use.
- **Record all auth failures in circuit breaker** — Circuit breaker now records auth failures regardless of HTTP status code, improving detection of degraded Linear API states.

### Chores

- Aligned all package versions to 0.7.20 across the monorepo.

## v0.7.19

### Features

- **Circuit breaker for Linear API** — New `CircuitBreaker` class in `@supaku/agentfactory-linear` with closed→open→half-open state machine and exponential backoff. Detects auth errors (400/401/403), GraphQL `RATELIMITED` responses, and error message patterns. Integrated into `LinearAgentClient.withRetry()` — checks circuit before acquiring a rate limit token, so no quota is consumed when the circuit is open.
- **Pluggable rate limiter & circuit breaker strategies** — New `RateLimiterStrategy` and `CircuitBreakerStrategy` interfaces allow swapping in-memory defaults for Redis-backed implementations. `LinearAgentClient` accepts optional strategy overrides via config.
- **Redis-backed shared rate limiter** — New `RedisTokenBucket` in `@supaku/agentfactory-server` uses atomic Lua scripts to share a single token bucket across all processes (dashboard, governor, agents). Key: `linear:rate-limit:{workspaceId}`.
- **Redis-backed shared circuit breaker** — New `RedisCircuitBreaker` in `@supaku/agentfactory-server` shares circuit state across processes via Redis. Supports exponential backoff on reset timeout.
- **Linear quota tracker** — New `QuotaTracker` in `@supaku/agentfactory-server` reads and stores Linear's `X-RateLimit-Requests-Remaining` and `X-RateLimit-Complexity-Remaining` headers in Redis for proactive throttling. Warns when quota drops below threshold.
- **Centralized issue tracker proxy** — New `POST /api/issue-tracker-proxy` endpoint in `@supaku/agentfactory-nextjs` acts as a single gateway for all Linear API calls. Agents, governors, and CLI tools call this endpoint instead of Linear directly, centralizing rate limiting, circuit breaking, and OAuth token management. Includes a health endpoint at `GET /api/issue-tracker-proxy`.
- **Platform-agnostic proxy types** — New `IssueTrackerMethod`, `SerializedIssue`, `SerializedComment`, `ProxyRequest`, and `ProxyResponse` types in `@supaku/agentfactory-linear` are Linear-agnostic, enabling future issue tracker backends without changing consumer code.
- **Proxy client** — New `ProxyIssueTrackerClient` in `@supaku/agentfactory-linear` is a drop-in replacement that routes all calls through the dashboard proxy. Activated when `AGENTFACTORY_API_URL` env var is set.

### Fixes

- **Removed harmful OAuth fallback** — The Linear client resolver no longer falls back to a personal API key when OAuth token lookup fails. Personal API keys cannot call Agent API endpoints (`createAgentActivity`, etc.), so the fallback guaranteed 400 errors that wasted rate limit quota.
- **Workspace client caching** — The Linear client resolver now caches workspace clients with a 5-minute TTL, so all requests within the dashboard process share one client (and one token bucket + circuit breaker) per workspace.
- **Governor uses Redis strategies** — When `REDIS_URL` is available, the governor injects `RedisTokenBucket` and `RedisCircuitBreaker` into its Linear clients for coordinated rate limiting across processes.

### Tests

- Circuit breaker unit tests (23 tests) — state transitions, auth error detection, GraphQL RATELIMITED detection, exponential backoff, half-open probe, reset, diagnostics.
- Updated manifest route count (24→25) and create-app template parity for the new proxy route.

### Chores

- Aligned all package versions to 0.7.19 across the monorepo.

## v0.7.18

### Fixes

- **Governor uses OAuth tokens from Redis for Linear Agent API** — The governor now resolves OAuth access tokens from Redis at startup and uses them for `createAgentSessionOnIssue`, fixing "Failed to post to Linear" errors caused by using a personal API key for the Agent API. Falls back to personal API key when no OAuth token is available.
- **Governor stores `organizationId` on session state** — Workers can now resolve the correct OAuth token for progress/activity posting since the workspace ID is persisted alongside the session.
- **Governor includes `prompt` in queued work items** — Agents receive work-type-specific prompts instead of generic fallbacks, improving agent behavior on pickup.

### Chores

- Aligned all package versions to 0.7.18 across the monorepo.

## v0.7.17

### Fixes

- **Governor skips sub-issues in Backlog** — The decision engine now checks `parentId` and skips sub-issues, dispatching only top-level and parent issues. This prevents invisible backlog sprawl when sub-issues are in Backlog but their parent is still in Icebox.
- **Backlog-writer creates sub-issues in Icebox** — Sub-issues are now created with `--state "Icebox"` to match their parent. The user promotes the parent to Backlog when ready and sub-issues follow via Linear's built-in behavior. Independent issues still default to Backlog.

### Tests

- Added decision engine tests for sub-issue skip behavior and precedence over `enableAutoDevelopment`.

### Chores

- Aligned all package versions to 0.7.17 across the monorepo.

## v0.7.16

### Fixes

- **Governor `GOVERNOR_PROJECTS` env var** — The governor CLI now reads `GOVERNOR_PROJECTS` (comma-separated) as a fallback when no `--project` flags are provided. Aligns with `worker` and `worker-fleet` CLIs which already support env var defaults via `WORKER_PROJECTS`.

### Chores

- Aligned all package versions to 0.7.16 across the monorepo.

## v0.7.15

### Features

- **`af-sync-routes` CLI command** — New command that auto-generates missing `route.ts` and `page.tsx` files in consumer projects after upgrading `@supaku` packages. Reads from a central route manifest in `@supaku/agentfactory` and creates only missing files (never overwrites). Use `--pages` to also sync dashboard pages, `--dry-run` to preview. Available as `af-sync-routes` binary and `@supaku/agentfactory-cli/sync-routes` subpath export.
- **Route manifest** — New `ROUTE_MANIFEST` in `@supaku/agentfactory` defines all 24 API routes and 5 dashboard pages as structured data. Includes `generateRouteContent()` and `generatePageContent()` generators that produce output identical to the `create-app` templates.

### Tests

- Manifest unit tests (14 tests) — validates entry counts, path patterns, method accessors, and content generation.
- Manifest / create-app parity tests (6 tests) — ensures the manifest stays in sync with `create-app` templates.
- Sync routes runner tests (8 tests) — file creation, no-overwrite safety, dry-run, error handling, and page sync.

### Chores

- Excluded `__tests__` directories from tsc build in core and cli packages.
- Aligned all package versions to 0.7.15 across the monorepo.

## v0.7.14

### Features

- **Linear API rate limiter** — New `TokenBucket` rate limiter in `@supaku/agentfactory-linear` proactively throttles requests below Linear's ~100 req/min limit. Uses a token bucket algorithm (80 burst capacity, 1.5 tokens/sec refill). All `LinearAgentClient` API calls now pass through the rate limiter with automatic backpressure. Includes `Retry-After` header parsing for 429 responses.
- **Auto-detect app URL on Vercel** — `getAppUrl()` and OAuth callback in `@supaku/agentfactory-nextjs` now fall back to `VERCEL_PROJECT_PRODUCTION_URL` / `VERCEL_URL` when `NEXT_PUBLIC_APP_URL` is not set. Removes the need to manually configure app URL on Vercel deployments.
- **One-click deploy buttons** — Vercel and Railway deploy buttons are now fully functional across all READMEs. Vercel deploys from the monorepo subdirectory (`agentfactory/tree/main/templates/dashboard`), eliminating the need for a separate template repository. Railway deploy uses a published template with bundled Redis.

### Fixes

- **Dashboard template Tailwind v4 build** — The dashboard template imported the `@supaku/agentfactory-dashboard` v3 stylesheet which used `@apply border-border`, failing under Tailwind v4. Converted all dashboard styles to v4-native `@theme` declarations and removed the v3 import.
- **`vercel.json` schema validation** — Removed invalid `env` block that used object format (`{description, required}`) instead of Vercel's expected string values. Env vars are prompted via the deploy button URL parameter instead.
- **Retry improvements** — Retry logic now handles `429 Too Many Requests` with `Retry-After` header parsing, and distinguishes retryable status codes (429, 500, 502, 503, 504) from non-retryable ones.
- **Governor dependencies cleanup** — Simplified `governor-dependencies.ts` in the CLI package, removing redundant wiring.

### Docs

- **Workflow Governor documentation** — Added comprehensive Governor docs across all packages.

### Chores

- Updated dashboard template dependency versions to 0.7.14.
- Added `next-env.d.ts` to template `.gitignore`.
- Aligned all package versions to 0.7.14 across the monorepo.

## v0.7.13

### Fixes

- **Terminal state guard on AgentSession** — `AgentSession.start()` and `AgentSession.complete()` now check the issue's current status before auto-transitioning. If the issue is in a terminal state (Accepted, Canceled, Duplicate), the transition is refused with a warning. This prevents stale or rogue sessions from pulling completed issues back into active workflow states.

## v0.7.12

### Fixes

- **Governor dispatch loop** — `dispatchWork()` now calls `storeSessionState()` before `queueWork()`, so `hasActiveSession()` correctly returns true on subsequent poll sweeps. Previously, the governor would re-dispatch the same issue every poll cycle because no session was registered in Redis.
- **Worker claim failures** — Workers could never claim governor-dispatched work because `claimSession()` requires a pending session in Redis. The session is now registered before the queue entry, eliminating the race window.
- **Phase completion signal** — When research or backlog-creation sessions complete, `markPhaseCompleted()` is now called in the session status handler. This prevents the governor from re-dispatching top-of-funnel work for the same issue after each poll sweep.
- **Project name on dispatched work** — Governor-dispatched queue items now include `projectName`, enabling correct worker routing across multi-project deployments.

### Changes

- **Icebox auto-triggers default to off** — `enableAutoResearch` and `enableAutoBacklogCreation` now default to `false`. The Icebox is a space for ideation and iterative refinement via @ mentions; automated research/backlog-creation is opt-in via `--auto-research` / `--auto-backlog-creation` CLI flags. The governor's default scope is Backlog → development, Finished → QA, Delivered → acceptance.

## v0.7.11

### Features

- **Hybrid Event+Poll Governor** — `EventDrivenGovernor` wraps the existing decision engine with a real-time event loop (via `GovernorEventBus`) plus a periodic poll safety net (default 5 min), both feeding through `EventDeduplicator` to avoid duplicate processing
- **PlatformAdapter pattern** — New `PlatformAdapter` interface in core with `LinearPlatformAdapter` implementation that normalizes Linear webhooks into `GovernorEvent`s and scans projects for non-terminal issues
- **Webhook-to-Governor bridge** — `governorMode` config (`direct` | `event-bridge` | `governor-only`) lets deployments opt in incrementally; webhooks publish status-change events to the bus alongside or instead of direct dispatch
- **Real GovernorDependencies** — CLI governor now wires all 10 dependency callbacks to Linear SDK + Redis (sessions, cooldowns, overrides, workflow state, phase tracking, work dispatch) with stub fallback when env vars aren't set
- **Redis Streams event bus** — `RedisEventBus` with consumer groups, MAXLEN trimming, and pending message re-delivery; `RedisEventDeduplicator` using SETNX with TTL
- **`--mode event-driven|poll-only` CLI flag** — `af-governor` now supports event-driven mode with `InMemoryEventBus` for single-process usage

### Chores

- Aligned all package versions to 0.7.11 across the monorepo.

## v0.7.10

### Features

- **Workflow Governor** — Autonomous lifecycle management with human-in-the-loop. Replaces manual @mention-driven triggers with a deterministic state machine that surfaces high-value decision points for human input. Includes:
  - **WorkSchedulingFrontend interface** with AbstractStatus (8 statuses, 16 methods) for frontend-agnostic work scheduling
  - **LinearFrontendAdapter** wrapping LinearAgentClient through the abstract interface
  - **Governor scan loop** — Polling-based scheduler with configurable intervals, decision engine, and priority-aware dispatch
  - **Human touchpoint system** — Structured override directives (HOLD, RESUME, SKIP QA, DECOMPOSE, REASSIGN, PRIORITY) with configurable timeouts
  - **Auto top-of-funnel** — Automatic research and backlog-creation for Icebox issues based on description quality heuristics
  - **Strategy-aware template selection** — Escalation-driven template resolution (normal → context-enriched → decompose → escalate-human)
  - **`af-governor` CLI** — New binary entry point for running the Governor scan loop
  - **PM curation workflow documentation** — Docs for PM interaction with the top-of-funnel pipeline

### Improvements

- **Workflow state machine and QA loop circuit breaker** — Added `WorkflowState` tracking and escalation ladder for QA cycles
- **YAML-based workflow template system** — Agent prompts driven by YAML templates with Handlebars interpolation, overridable per project

### Chores

- Aligned all package versions to 0.7.10 across the monorepo.

## v0.7.9

### Features

- **`LINEAR_TEAM_NAME` env var for CLI** — `pnpm af-linear create-issue` now falls back to the `LINEAR_TEAM_NAME` environment variable when `--team` is omitted. The orchestrator auto-sets this from the issue's team context, so agents no longer waste turns discovering the team name. Explicit `--team` always wins. Added `getDefaultTeamName()` to `@supaku/agentfactory-linear` constants.
- **Server-level project filtering** — `@supaku/agentfactory-server` supports project filtering at the server level for multi-project deployments.
- **Improved WORK_RESULT marker handling** — QA and acceptance agent prompts now have better `<!-- WORK_RESULT:passed/failed -->` marker instructions and handling.

### Fixes

- **`qa-coordination` and `acceptance-coordination` priority order** — Fixed work type priority ordering to include `qa-coordination` and `acceptance-coordination` in the correct position.

### Chores

- Aligned all package versions to 0.7.9 across the monorepo.

## v0.7.8

### Chores

- **Standardize Linear CLI command references** — Replaced all `pnpm linear` references with `pnpm af-linear` across documentation, agent definitions, orchestrator prompts, and templates. The `af-linear` binary name is the canonical invocation since v0.7.6; the old `pnpm linear` script alias was an internal-only convenience that didn't work in consumer projects or worktrees.
- Renamed root `package.json` script from `linear` to `af-linear` for consistency.
- Aligned all package versions to 0.7.8 across the monorepo.

## v0.7.7

### Fixes

- **Fix autonomous agent permissions in worktrees** — Agents spawned by the orchestrator in git worktrees were unable to run `pnpm af-linear` and other Bash commands because they received unanswerable permission prompts in headless mode. Two compounding issues:
  1. **Wrong `allowedTools` pattern format** — `Bash(pnpm *)` (space) doesn't match; Claude Code uses `Bash(prefix:glob)` syntax with a colon separator. Fixed to `Bash(pnpm:*)`.
  2. **Filesystem hooks unreliable in worktrees** — The auto-approve hook (`.claude/hooks/auto-approve.js`) loaded via `settingSources: ['project']` may not resolve correctly when `.git` is a file (worktree) instead of a directory. Added a programmatic `canUseTool` callback as a reliable in-process fallback that doesn't depend on filesystem hook resolution.

### Features

- **`create-blocker` command** — New `af-linear create-blocker` / `pnpm af-linear create-blocker` command for creating human-needed blocker issues that block the source issue.

### Improvements

- **Expanded `allowedTools` coverage** — Autonomous agents now pre-approve `npm`, `tsx`, `python3`, `python`, `curl`, `turbo`, `tsc`, `vitest`, `jest`, and `claude` in addition to the existing `pnpm`, `git`, `gh`, `node`, `npx`.
- **WORK_RESULT marker instruction** — QA and acceptance agent prompts now include explicit instructions for the `<!-- WORK_RESULT:passed/failed -->` marker.

### Chores

- Aligned all package versions to 0.7.7 across the monorepo.

## v0.7.6

### Features

- **`af-linear` CLI** — Promoted the Linear CLI to a published binary in `@supaku/agentfactory-cli`. All 15 commands (`get-issue`, `create-issue`, `update-issue`, `list-comments`, `create-comment`, `list-backlog-issues`, `list-unblocked-backlog`, `check-blocked`, `add-relation`, `list-relations`, `remove-relation`, `list-sub-issues`, `list-sub-issue-statuses`, `update-sub-issue`, `check-deployment`) are now available via `npx af-linear` or `pnpm af-linear` after installing `@supaku/agentfactory-cli`. Previously, the Linear CLI only existed as an internal script in `packages/core/` and consumers had to bundle their own copy.
- **`@supaku/agentfactory-cli/linear` subpath export** — `runLinear()` and `parseLinearArgs()` are available as a programmatic API for building custom CLI wrappers.
- **`create-agentfactory-app` improvements** — Scaffolded projects now include `pnpm af-linear` out of the box (via `af-linear`), a `.claude/CLAUDE.md` with Linear CLI reference, and an enhanced developer agent definition with Linear status update workflows.

### Chores

- `@supaku/agentfactory-cli` is now a required dependency for all scaffolded projects (not just when `includeCli` is selected).
- Deprecated `packages/core/src/linear-cli.ts` in favor of the CLI package.
- Aligned all package versions to 0.7.6 across the monorepo.

## v0.7.5

### Fixes

- **Fix Redis WRONGTYPE error in expired lock cleanup** — `cleanupExpiredLocksWithPendingWork()` scanned `issue:pending:*` which matched both sorted sets (`issue:pending:{id}`) and hashes (`issue:pending:items:{id}`). Running `ZCARD` on a hash key caused a recurring `WRONGTYPE` error in production. Added the same colon-guard already present in `cleanupStaleLocksWithIdleWorkers`.

### Chores

- Aligned all package versions to 0.7.5 across the monorepo.

## v0.7.4

### Fixes

- **Auto-allow bash commands for autonomous agents in worktrees** — Agents spawned in git worktrees couldn't run `pnpm af-linear` or other bash commands because `settings.local.json` and the auto-approve hook weren't accessible from the worktree CWD. The Claude provider now passes `allowedTools` to the SDK so `pnpm`, `git`, `gh`, `node`, and `npx` commands are auto-approved for autonomous agents without relying on filesystem settings. Added optional `allowedTools` field to `AgentSpawnConfig` for custom overrides.
- **Linear CLI loads `.env.local` credentials automatically** — `pnpm af-linear` commands no longer require `LINEAR_API_KEY` to be exported in the shell. The CLI now loads `.env` and `.env.local` via dotenv at startup.

### Chores

- Aligned all package versions to 0.7.4 across the monorepo.

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

- **Linear CLI restored** — Ported the full Linear CLI entry point (`pnpm af-linear`) from the supaku repo. Provides 16 subcommands (`get-issue`, `create-issue`, `update-issue`, `create-comment`, `list-comments`, `add-relation`, `list-relations`, `remove-relation`, `list-sub-issues`, `list-sub-issue-statuses`, `update-sub-issue`, `check-blocked`, `list-backlog-issues`, `list-unblocked-backlog`, `check-deployment`) wrapping `@supaku/agentfactory-linear`. Runs via `node --import tsx` so it works in worktrees without a build step.
- **CLAUDE.md project instructions** — Added root-level `CLAUDE.md` with Linear CLI reference, autonomous mode detection, project structure, worktree lifecycle rules, and explicit prohibition of Linear MCP tools.
- **Agent definitions** — Added full agent definitions to `examples/agent-definitions/` for backlog-writer, developer, qa-reviewer, coordinator, and acceptance-handler. Each includes Linear CLI instructions and MCP prohibition.
- **Orchestrator CLI guidance** — All 10 work types in `generatePromptForWorkType()` now include explicit instructions to use `pnpm af-linear` instead of MCP tools.

### Fixes

- **Linear DEFAULT_TEAM_ID** — Resolved empty `DEFAULT_TEAM_ID` caused by ESM import hoisting.
- **Dashboard clickable links** — Styled issue identifiers as clickable links on fleet and pipeline pages.

### Chores

- Added `worker-fleet` and `analyze-logs` root scripts.
- Added "Built with AgentFactory" badge system and README badge.
- Resized badges to 20px to match shields.io standard.
- Fleet-runner changes.
- Consolidated backlog-writer to `examples/`, gitignored `.claude/`.
