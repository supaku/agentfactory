# Changelog

## v0.7.52

### Fixes

- **Set maxTurns=200 for coordination and inflight agents** — Coordinators were hitting the Claude SDK's default ~30 turn limit before finishing sub-agent polling, causing premature exit with unknown work result. Added `maxTurns` to `AgentSpawnConfig` and threaded it through to the SDK's `query()` options. Coordination, QA-coordination, acceptance-coordination, and inflight work types now get 200 turns.

### Features

- **Add `--work-type` flag to orchestrator CLI** — Allows forcing a specific work type when using `--single` mode, bypassing auto-detection from issue status. Useful for re-running coordination work that would otherwise be detected as inflight.
- **Add Spring AI agent provider** — New provider for Spring AI-based agents (SUP-1038).

## v0.7.51

### Fixes

- **Add heuristic fallback patterns for coordination work types** — `parseWorkResult` now detects pass/fail from real agent output when the structured `<!-- WORK_RESULT -->` marker is missing. Adds patterns for `coordination` ("all X/X sub-issues completed", "Must Fix Before Merge"), `qa-coordination` ("Status: N Issues Found", "N Critical Issues (Block Merge)"), and `acceptance-coordination` ("Must Fix Before Merge"). Previously, missing markers caused `unknown` results that left issues stuck in Delivered, triggering infinite acceptance retry loops.
- **Strengthen WORK_RESULT marker instruction and move to end of all templates** — The work-result-marker partial now uses a prominent visual box and explicit "VERY LAST line" instruction. Moved from mid-prompt to the final position in all 10 templates that use it, so it's the last thing agents read before generating output.
- **Add READ-ONLY/GATE constraints and status manipulation guards to QA and acceptance templates** — QA templates now explicitly forbid code changes. Acceptance templates are marked as gates that must not fix issues. All result-sensitive templates prohibit `update-issue --state` to prevent agents from bypassing the orchestrator's state machine. Acceptance tool permissions tightened from `git push *` to `git push origin --delete *`.

## v0.7.50

### Fixes

- **Pass workflow context to coordination rework prompts via webhook path** — When QA-coordination failed and the dev coordination agent was re-triggered via webhook, it received a fresh prompt instead of the rework prompt. The failure context filter excluded the `coordination` work type from Started status, and `workflowContext` was never passed as the 4th argument to `generatePrompt`. Now the webhook handler includes coordination in the filter and passes `wfContext` through, so the rework mode prompt activates correctly.

## v0.7.49

### Fixes

- **Add READ-ONLY constraint to QA and acceptance prompts** — QA and acceptance agents (including coordination variants) now receive a `READ-ONLY ROLE` constraint that explicitly forbids modifying source code, config, or migration files. Agents must only read, validate, and report — if issues are found, they emit `WORK_RESULT:failed` instead of attempting fixes. Prevents QA agents from silently patching code and masking real bugs.
- **Expand qa-coordination and acceptance-coordination prompts with structured steps** — Both prompts now include numbered validation steps, PR selection guidance, and explicit pass/fail criteria with `WORK_RESULT` marker instructions, matching the detail level of their non-coordination counterparts.
- **Prevent acceptance re-trigger loop on failure** — When an acceptance agent fails or returns unknown result, `markAcceptanceCompleted` is now called to prevent the webhook orchestrator from immediately re-dispatching another acceptance agent for the same issue.

## v0.7.48

### Fixes

- **Coordination rework mode for QA retries** — When a coordinated parent issue fails QA and is retried, the coordinator now receives a specialized "REWORK MODE" prompt instead of the fresh coordination prompt. This prevents re-spawning sub-agents for already-complete work. The rework prompt instructs the agent to read QA failure comments, apply targeted fixes directly, push to the existing PR branch, and run full validation — addressing the SUP-994 scenario where coordinators saw all sub-issues as Finished and concluded "nothing to do."

## v0.7.47

### Fixes

- **Wire WorkflowContext into governor prompt generation for retries** — When an issue failed QA and was retried, the governor dispatched agents with a vanilla prompt containing no failure context. The `WorkflowState` (cycle count, strategy, failure summary) was sitting in Redis but never passed to `generatePrompt`. Now `dispatchWork` fetches workflow state via `getWorkflowState()` and passes it as `WorkflowContext` to `generatePrompt`, so retry agents see previous QA failures, cycle count, and escalation strategy in their prompt.
- **Emit response activity to close Linear agent sessions on completion** — Agent sessions now properly close in Linear's UI when work completes.

## v0.7.46

### Fixes

- **Fix coordination agent circular re-triggering on parent issues** — Three compounding bugs caused parent issues with sub-issues to cycle through 8+ agent sessions without progressing. (1) Coordination work type was not result-sensitive — the orchestrator auto-promoted to Finished on session completion regardless of whether sub-issues were actually done. Coordination now requires a `<!-- WORK_RESULT:passed -->` marker like QA/acceptance. (2) WORK_RESULT markers embedded in tool call inputs (e.g., `create-comment --body`) were invisible to the orchestrator's parser, causing "unknown result → no transition → re-trigger" loops. The stream loop now captures markers from tool inputs. (3) Added `{{> partials/work-result-marker}}` to the coordination template so agents are instructed to emit the marker.
- **Add circuit breaker for runaway agent sessions** — New `MAX_SESSION_ATTEMPTS` guard (default: 3) in the governor decision engine prevents issues from cycling through agents indefinitely. If an issue has had 3+ completed sessions without reaching a terminal status, the governor stops dispatching and the issue requires manual intervention.

## v0.7.45

### Features

- **`af-agent` CLI for managing running agent sessions** — New command with five subcommands: `stop` (sets session to stopped in Redis, worker aborts within ~5s), `chat` (queues a pending prompt injected into the running Claude session), `status` (shows session details), `reconnect` (creates a fresh Linear agent session and re-associates Redis state), and `list`/`ls` (shows active sessions with duration and cost, `--all` for completed/failed).

### Fixes

- **Backlog-writer creates issues in Icebox instead of Backlog** — Built-in prompts in three locations (defaults/prompts.ts, orchestrator.ts, backlog-creation.yaml) told the backlog-writer agent to create issues in Backlog status, causing the governor to immediately dispatch dev agents before human review. All prompt sources now consistently use Icebox. The agent definition in downstream repos already specified Icebox, but the agentfactory built-in prompts overrode it.

## v0.7.44

### Fixes

- **Fix ZodError in autonomous agent permission handling** — Claude Code 2.1.70 requires `updatedInput` in `PermissionResult` allow responses, but `autonomousCanUseTool` returned `{ behavior: 'allow' }` without it. Added `updatedInput: input` to all allow returns to satisfy the stricter Zod validation.

## v0.7.43

### Features

- **Register CLI commands as in-process agent tools** — New `ToolPlugin` system exposes Linear CLI commands as typed, Zod-validated tools for Claude agents. Instead of shelling out to `pnpm af-linear`, agents call `af_linear_get_issue`, `af_linear_create_comment`, etc. directly — no subprocess overhead, no arg string construction, no stdout parsing. Uses the Claude Agent SDK's `createSdkMcpServer()` for in-process MCP tool registration (the only extension mechanism for adding custom tools to Claude Code). Non-Claude providers continue using the Bash-based CLI unchanged.
- **Tool plugin architecture for future integrations** — `ToolPlugin` interface and `ToolRegistry` enable adding new tool sets (Asana, deployment, framework-specific) with minimal boilerplate. Each plugin provides a name and a `createTools()` function returning SDK tool definitions.

### Chores

- **Move `runLinear()` from CLI to core** — The canonical Linear runner now lives in `packages/core/src/tools/linear-runner.ts`. The CLI re-exports from core, ensuring both CLI and tool plugin use the same code path.
- **Document tool plugin system** — Updated `docs/providers.md`, `docs/architecture.md`, `CONTRIBUTING.md`, and `CLAUDE.md` with MCP integration rationale, plugin authoring guide, and architecture diagrams.

## v0.7.42

### Fixes

- **Fix infinite loop when qa-coordination fails on parent issues** — QA coordination failure sent parent issues to `Backlog`, which triggered development coordination. The coordinator saw all sub-issues already `Finished` and immediately promoted back to `Finished`, restarting the QA cycle indefinitely. Changed `qa-coordination` fail status to `Started` instead, which keeps the issue visible without re-triggering the coordination loop.
- **Fix `getVersion()` returning "unknown" in compiled output** — Version resolution now works correctly in bundled builds.
- **Disable filesystem hooks for autonomous SDK agents** — Prevents permission failures when agents run headless.

### Features

- **Add cost tooltip and all-time total to dashboard** — Fleet management dashboard now shows per-session cost breakdowns and cumulative totals.

## v0.7.41

### Fixes

- **Route parent issues to coordination work type** — The Governor's `dispatchWork` mapped `trigger-development` → `development` regardless of whether the issue had sub-issues, so parent issues were treated as single development tasks instead of using the coordinator. Now `dispatchWork` checks the `parentIssueIds` cache and upgrades to `coordination`/`qa-coordination`/`acceptance-coordination` for parent issues. Added the same check to `spawnAgentForIssue` and `forwardPrompt` auto-detect paths for defense in depth.
- **Fix Bash permission failures for autonomous agents** — The `allowedTools` list only included command-specific prefixes (`pnpm`, `git`, `gh`, etc.) but missed common shell commands (`cd`, `pwd`, `ls`, `cat`, `find`, `mkdir`, etc.). Headless agents can't prompt for permission, so unlisted commands silently failed. Added ~25 common shell builtins and utilities.
- **Hard-block Linear MCP tools for autonomous agents** — The `canUseTool` callback denied Linear MCP tools but agents still called them successfully, suggesting the callback raced with MCP execution. Added all Linear MCP tool names to `disallowedTools` for a hard SDK-level block that prevents the tools from being callable.

## v0.7.40

### Fixes

- **Block Linear MCP tools for autonomous agents** — Agents were discovering Linear MCP tools via `ToolSearch` and calling them instead of using `pnpm af-linear` CLI, causing permission errors and data dumps into issue comments. The `autonomousCanUseTool` handler now denies `mcp__*Linear__*` tools with a redirect message to the CLI.
- **Fix noisy/misleading agent startup logs** — Show "spawning" instead of "PID: undefined" in `onAgentStart` (PID arrives asynchronously after process spawn). Switched dotenv from `config()` to `parse()` to eliminate tip spam on stdout. Downgraded `settings.local.json` warnings to debug level (file may exist without `env` key, which is not an error).

## v0.7.39

### Fixes

- **Fix orphan cleanup deadlock with issue locks** — When a worker is disrupted (e.g., tmux kill), orphan cleanup detected the stale session but failed to re-dispatch it because the issue lock (SET NX, 2h TTL) was still held by the same session. Work got parked instead of queued, and the stale-lock cleanup skipped it because the session was reset to `pending` (not terminal). Now orphan cleanup releases the issue lock before re-dispatching, and the stale-lock cleanup also treats `pending` as a stale lock status.
- **Fix cross-project work routing after orphan recovery** — Orphan and zombie cleanup omitted `projectName` when reconstructing `QueuedWork` for re-dispatch. The poll filter treated untagged work as "any worker can take it", allowing workers from the wrong repository to claim issues from other projects. Now `projectName` is preserved from session state during re-queue.
- **Add server-side project validation at claim time** — The claim endpoint (`POST /api/sessions/{id}/claim`) now validates that the claiming worker's project list includes the work item's `projectName`. If mismatched, the claim is rejected and work is requeued. Previously the poll filter was the only routing gate with no server-side enforcement.
- **Tighten poll filter for project-scoped workers** — Project-filtered workers now only see work explicitly tagged with their projects. Previously, untagged work (`!w.projectName`) was accepted by any worker, bypassing project routing.
- **Fix triple-dispatch duplication in event-bridge mode** — Prevented duplicate agent dispatches when events arrived via both webhook and polling simultaneously.

### Features

- **Add gitleaks pre-commit hook** for local secret scanning
- **Add dotenvx pre-commit hook** to block `.env` commits

## v0.7.38

### Fixes

- **IDE-safe worktree cleanup** — Worktree removal now detects processes (VS Code, Cursor, language servers) with open file handles via `lsof`. When detected without `--force`, the worktree is skipped instead of removed, preventing IDE crashes from sudden workspace deletion. Added `skipped` counter to `CleanupResult`, inter-removal settle delay (1.5s) for IDE file watchers, and removed redundant `git worktree prune` calls.

## v0.7.37

### Features

- **Skip worktree creation for non-code work types** — Research and backlog-creation agents no longer create git worktrees, branches, or `.agent/` state directories. These agents run from the main repo root with `cwd` set to `process.cwd()`, eliminating startup latency, branch pollution, and `fatal: no upstream` log noise. Added `WORK_TYPES_REQUIRING_WORKTREE` constant to `@supaku/agentfactory-linear` for the 8 code-producing work types. Made `worktreeIdentifier` and `worktreePath` optional on `AgentProcess`, `SpawnAgentOptions`, and `SpawnAgentWithResumeOptions`. All state persistence, recovery checks, and worktree cleanup are automatically skipped when these fields are undefined.

## v0.7.36

### Fixes

- **Fix governor re-dispatching work for issues with active agents** — `getSessionStateByIssue()` returned the first Redis key match for an issue, regardless of session status. When multiple sessions existed (one running + several failed from prior claim attempts), a failed session could be found first, causing `hasActiveSession()` to return false. The governor then re-dispatched every scan cycle, creating duplicate queue entries that workers claimed and failed on ("Agent already running"). Now `getSessionStateByIssue()` scans all matching sessions and prefers active ones (running/claimed/pending) over inactive ones.
- **Use issue-lock dispatch in governor** — Governor's `dispatchWork()` called `queueWork()` directly, bypassing the issue-lock system. Multiple dispatches for the same issue all entered the global queue unserialized. Now uses `issueLockDispatchWork()` which acquires an atomic issue lock before queueing; if the issue is already locked, work is parked and auto-promoted when the lock is released.

## v0.7.35

### Fixes

- **Skip work for issues in terminal status (Accepted/Canceled/Duplicate)** — The governor queues work based on issue status at scan time, but by the time the worker picks up the item, the issue may have already moved to a terminal status. The orchestrator spawned agents anyway, causing issues like SUP-866 to get QA'd after already being Accepted. Added terminal status guards in `spawnAgentForIssue` (throws) and `forwardPrompt` (returns early with `reason: 'terminal_status'`).

### Features

- **Configurable build/test commands in agent frontmatter and repository config** (#15)

## v0.7.34

### Fixes

- **Fix QA infinite loop caused by rigid work result heuristics** — QA agents output verdicts like `**PASS**`, `Verdict: PASS`, `Status: **PASS**` but all heuristic patterns required a `QA` prefix (e.g., `QA Result: Pass`). Every QA run returned `unknown`, the orchestrator never transitioned the issue, and the work queue re-dispatched it endlessly. Made `QA` prefix optional, added bold markdown support (`**PASS**`/`**FAIL**`), and added standalone bold verdict patterns. Added 11 regression tests from real SUP-867 agent output.

## v0.7.33

### Fixes

- **Fix preserved worktrees blocking branch reuse** — When a worktree was preserved due to incomplete work, its heartbeat file remained on disk, causing the conflict handler to falsely detect a live agent for 30 seconds. This blocked subsequent agents from creating worktrees on the same branch, exhausting all 3 retries. Now the heartbeat file is deleted when a worktree is preserved (both completed and failed paths). Additionally, the conflict handler now saves a `.patch` file to `.worktrees/.patches/` before force-removing stale worktrees with incomplete work, preventing data loss.

## v0.7.32

### Fixes

- **Fix worktree cleanup deleting unpushed work for QA/acceptance agents** — The `checkForIncompleteWork()` safety check was gated behind `isDevelopmentWork`, so QA and acceptance agents' worktrees were cleaned up without verifying commits were pushed. This caused completed work to vanish when the worktree was removed with `--force`. Removed the work-type gate so the safety check applies to all completed agents, matching the already-correct failed-agent cleanup path.

## v0.7.31

### Fixes

- **Fix governor creating dead Linear sessions on every dispatch** — The governor resolved the OAuth token once at startup and held a static `LinearAgentClient` for the entire process lifetime. When the token expired or was missing, every `createAgentSessionOnIssue()` call failed and all sessions received a `governor-` prefixed fallback ID, causing all worker activity/progress forwarding to Linear to silently fail. Changed to a lazy resolver that re-reads the token from Redis on each dispatch, auto-refreshes when needed, and only creates a new client when the token actually changes.

## v0.7.30

### Features

- **Enable agents to add new dependencies in worktrees** — Agents can now install packages they need (e.g., `stripe`) instead of getting stuck in a loop. The orchestrator writes `.agent/add-dep.sh` into each worktree during setup, which safely removes symlinked `node_modules` and runs `pnpm add` with the `ORCHESTRATOR_INSTALL=1` guard bypass. Updated dependency-instructions partial, supaku CLAUDE.md, and the preinstall guard error message to direct agents to the helper script.

## v0.7.29

### Fixes

- **Prevent worktree node_modules from corrupting main repo** — Replaced directory-level symlinks with real directories containing per-entry symlinks. Previously, if an agent ran `pnpm install` in a worktree, pnpm would follow the top-level symlink and write into the main repo's `node_modules`. Now each entry is individually symlinked, so a rogue install only destroys the worktree's links. Also sets `ORCHESTRATOR_INSTALL=1` env var to bypass the preinstall guard when the orchestrator intentionally runs pnpm install as a fallback.

## v0.7.28

### Fixes

- **Prevent runaway agent loops (SUP-855 post-mortem)** — Six fixes to stop multi-session spirals:
  - Count `unknown` work results as failures so the 4-cycle escalation ladder fires correctly
  - Increase cooldown TTLs from 10 seconds to 5 minutes to prevent immediate re-triggering
  - Add per-issue hard cap of 8 total sessions with automatic escalation comment
  - Harden QA templates to hard-fail on build/typecheck errors instead of rationalizing them
  - Skip acceptance-coordination when sub-issues were never actually worked
  - Add 30-minute post-acceptance lock to prevent re-triggering after merge

## v0.7.27

### Fixes

- **Prevent QA state loop caused by agents manually changing issue status** — QA coordination agents were bypassing the orchestrator by calling `pnpm af-linear update-issue --state` directly, creating a Finished→Backlog→Started→Finished loop. Added explicit "never manually change status" instruction to the `work-result-marker` partial (included in all QA/acceptance templates) and reinforced in coordination templates.
- **Route QA failures to Backlog instead of Rejected** — Changed `WORK_TYPE_FAIL_STATUS` for `qa` and `qa-coordination` from `Rejected` to `Backlog`, so failed QA issues go directly back to the developer/coordinator with failure context instead of requiring a refinement intermediary. Updated the webhook handler to accept `Finished→Backlog` as a valid retry path with circuit breaker checks.
- **Detect coordination-style QA output in work result parser** — Added heuristic patterns for `Overall Result: FAIL`, `Roll-Up Verdict: FAIL`, and `Parent QA verdict: FAIL` (and PASS counterparts) so the orchestrator correctly detects pass/fail from QA coordination agents even without the structured marker.

## v0.7.26

### Fixes

- **Fix Linear CLI team resolution (name vs key)** — The orchestrator passed the team display name (e.g., "Supaku") as `LINEAR_TEAM_NAME`, but the Linear SDK's `team()` method only accepts team keys ("SUP") or UUIDs. Agents wasted many turns reverse-engineering the correct key. Now passes `team?.key` instead of `team?.name` in all three orchestrator locations and the `createBlocker` CLI fallback.
- **Make `getTeam()` resilient to display names** — `AgentClient.getTeam()` now falls back to a name search when key/ID lookup fails, so agents manually passing `--team "Supaku"` also work.

## v0.7.25

### Fixes

- **Fix governor version display showing "vunknown"** — `getVersion()` resolved `package.json` one directory level too shallow from the compiled `dist/src/` output, landing in `dist/` instead of the package root. Fixed path to go up two levels.
- **Eliminate per-issue isParentIssue API calls burning Linear quota** — The `parentIssueIds` cache only tracked parent issues, so every non-parent issue (the majority) fell through to an individual API call. With 128 issues in a single project scanned every 60s, this easily exceeded the 5,000 req/hr limit. Added a `scannedIssueIds` set so issues already seen in the batch query return immediately without an API fallback.
- **Wire onScanComplete callback in continuous governor mode** — `WorkflowGovernor.start()` discarded `scanOnce()` results in fire-and-forget mode, so `printScanSummary` with its colorized output and quota progress bars never rendered. Added `WorkflowGovernorCallbacks` to the governor constructor so the CLI receives scan results on every cycle.

## v0.7.24

### Fixes

- **Fix worktree symlink crash for missing apps** — `linkDependencies` now checks if the destination parent directory exists before creating per-workspace `node_modules` symlinks. When a branch doesn't contain all apps from `main` (e.g., `family-mobile` missing on a feature branch), the entry is skipped instead of throwing ENOENT and falling back to a full `pnpm install`.
- **Prevent `pnpm install` fallback from corrupting main repo** — `installDependencies` now removes any partial `node_modules` symlinks (root + per-workspace) before running `pnpm install`. Previously, the root `node_modules` symlink created by `linkDependencies` before the error would cause `pnpm install` to write through it into the main repo's `node_modules`, requiring the user to re-run `pnpm install` after agent work.
- **Release claim key on partial failure to prevent work queue deadlock** — When `claimWork()` succeeded at SETNX but a subsequent Redis operation threw, the claim key was left stuck for its full 1-hour TTL while the work item remained in the queue. All workers would then fail SETNX, causing infinite claim failures. Similarly, if the claim handler threw after removing the item from the queue, neither the claim key nor the work item was cleaned up.

## v0.7.23

### Features

- **Governor production logging** — New colorized, structured output for the governor CLI replacing plain `console.log`. Startup banner with version/config/integration status, per-scan summary with dispatched/skipped counts, and Linear API quota progress bars (request + complexity) with green/yellow/red thresholds.
- **API call counting for leak diagnosis** — `LinearAgentClient` now tracks per-scan API call counts (`apiCallCount`/`resetApiCallCount()`) and extracts quota headers via `onApiResponse` callback. Displayed alongside quota bars to help diagnose rate limit consumption.

### Fixes

- **Eliminate 2 redundant API calls per dispatch** — `dispatchWork` now receives the full `GovernorIssue` (already resolved during scan) instead of an `issueId` string. Removes the `getIssue()` + lazy project resolution calls that were re-fetching data already available from the scan query.
- **Consolidated rawRequest type** — Replaced 4 inline `this.client as unknown as { client: { rawRequest... } }` casts with a shared `RawGraphQLClient` type alias in `agent-client.ts`.

## v0.7.22

### Features

- **Monorepo path scoping for orchestrator** — New `projectPaths` and `sharedPaths` fields in `.agentfactory/config.yaml` allow mapping Linear projects to specific directories in a monorepo. Agents receive directory scoping instructions via `{{projectPath}}` and `{{sharedPaths}}` template variables, and a new `{{> partials/path-scoping}}` partial validates file changes at push time.

### Fixes

- **403 circuit breaker for ApiActivityEmitter** — When a session's ownership is transferred to another worker, the old worker's emitter now detects the 403 "owned by another worker" response, trips an `ownershipRevoked` circuit breaker, and stops all further activity/progress emission. Previously it would spam 403 errors for the entire agent lifetime. New `onOwnershipRevoked` callback allows the worker to request agent shutdown.
- **Reduce retry waste in agent spawn loop** — Reduced `MAX_SPAWN_RETRIES` from 6 to 3 (45s total instead of 90s). For "agent already running" errors, the retry loop now checks session ownership on the server before retrying — if another worker owns the session, it bails immediately instead of wasting API calls and dependency linking on each attempt.
- **Orphan cleanup grace period** — `findOrphanedSessions()` now skips sessions updated within the last 2 minutes (`ORPHAN_THRESHOLD_MS`), preventing the race condition where a worker re-registers with a new ID but hasn't transferred session ownership yet.
- **Increase worker TTL and heartbeat timeout** — `WORKER_TTL` increased from 120s to 300s, `HEARTBEAT_TIMEOUT` from 90s to 180s. The previous values were too tight — busy workers processing long agents could miss heartbeats, causing Redis key expiry, 404 errors, and re-registration cascades.
- **Use Node.js rmSync for worktree cleanup** — Replaced `execSync('rm -rf ...')` with `rmSync()` with `maxRetries: 3` and `retryDelay: 1000` for more resilient cleanup on mounted volumes and cross-platform compatibility.

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
