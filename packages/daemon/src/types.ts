/**
 * Daemon types — shared shapes for the local daemon fleet implementation.
 *
 * Architecture reference:
 *   rensei-architecture/004-sandbox-capability-matrix.md §Local daemon mode
 *   rensei-architecture/011-local-daemon-fleet.md
 *
 * These types mirror the Go-land RegisterRequest / RegisterResponse from
 * agentfactory-tui/worker/types.go, plus the TypeScript extensions needed
 * for the daemon's multi-project, long-running model.
 */

// ---------------------------------------------------------------------------
// Configuration types — mirrors ~/.rensei/daemon.yaml schema
// ---------------------------------------------------------------------------

export interface DaemonCapacityConfig {
  /** Maximum concurrent sessions the daemon will run. Default: 8. */
  maxConcurrentSessions: number
  /** Maximum vCPUs allocated per session. Default: 4. */
  maxVCpuPerSession: number
  /** Maximum memory (MiB) allocated per session. Default: 8192. */
  maxMemoryMbPerSession: number
  /** Resources reserved for the host OS (never used by sessions). */
  reservedForSystem: {
    vCpu: number
    memoryMb: number
  }
}

export interface DaemonProjectGitConfig {
  /** Git credential helper (e.g. 'osxkeychain', 'manager'). */
  credentialHelper?: string
  /** Path to SSH key file for SSH-based remotes. */
  sshKey?: string
}

export type CloneStrategy = 'shallow' | 'full' | 'reference-clone'

export interface DaemonProjectConfig {
  /** Short identifier for the project (used in logs and metrics). */
  id: string
  /** Repository URL or slug, e.g. github.com/renseiai/agentfactory. */
  repository: string
  /** Clone strategy for new workarea pool members. Default: 'shallow'. */
  cloneStrategy?: CloneStrategy
  /** Git credential configuration. */
  git?: DaemonProjectGitConfig
}

export interface DaemonOrchestratorConfig {
  /**
   * Where the daemon receives work assignments.
   * https://platform.rensei.dev (SaaS), custom URL, or file:///path for local queue.
   */
  url: string
  /**
   * One-time registration token with prefix `rsp_live_…`.
   * Exchanged for a scoped JWT on first start; the JWT is cached at
   * ~/.rensei/daemon.jwt.
   * May be provided via RENSEI_DAEMON_TOKEN env var.
   */
  authToken?: string
}

export type AutoUpdateChannel = 'stable' | 'beta' | 'main'
export type AutoUpdateSchedule = 'nightly' | 'on-release' | 'manual'

export interface DaemonAutoUpdateConfig {
  /** Release channel to track. Default: 'stable'. */
  channel: AutoUpdateChannel
  /** When to check for updates. Default: 'nightly'. */
  schedule: AutoUpdateSchedule
  /**
   * Maximum seconds to wait for in-flight sessions to drain before
   * forcing an update restart. Default: 600 (10 min).
   */
  drainTimeoutSeconds: number
}

export interface DaemonObservabilityConfig {
  /** Log format: 'ndjson' (default) or 'pretty'. */
  logFormat?: 'ndjson' | 'pretty'
  /** File path for log output. Default: ~/.rensei/daemon.log. */
  logPath?: string
  /** Prometheus metrics port. 0 disables metrics. Default: 9101. */
  metricsPort?: number
}

/**
 * Full parsed configuration from ~/.rensei/daemon.yaml.
 * Matches the YAML schema documented in 004 §Configuration shape.
 */
export interface DaemonConfig {
  apiVersion: string
  kind: string
  machine: {
    id: string
    /** Region hint for the scheduler's latency routing. */
    region?: string
  }
  capacity: DaemonCapacityConfig
  projects: DaemonProjectConfig[]
  orchestrator: DaemonOrchestratorConfig
  autoUpdate: DaemonAutoUpdateConfig
  observability?: DaemonObservabilityConfig
}

// ---------------------------------------------------------------------------
// Registration types — dial-out worker model per 004 §Worker registration model
// ---------------------------------------------------------------------------

/**
 * One-time registration token issued by the platform.
 * Prefix `rsp_live_` identifies long-lived registration tokens.
 * The daemon exchanges this for a scoped JWT on first start.
 */
export type RegistrationToken = `rsp_live_${string}` | string

/**
 * Request body sent to the orchestrator's worker-registration endpoint.
 * Mirrors RegisterRequest from agentfactory-tui/worker/types.go.
 */
export interface RegisterRequest {
  /** Stable machine identifier from daemon.yaml machine.id. */
  hostname: string
  /** Daemon package version (semver). */
  version: string
  /** Maximum concurrent sessions from config. */
  maxAgents: number
  /** Capability tags. Typed SandboxProviderCapabilities is preferred when present. */
  capabilities: string[]
  /** Sessions currently running. */
  activeAgentCount: number
  /** 'idle' | 'busy' | 'draining' */
  status: DaemonRegistrationStatus
  /** ISO 8601 region hint. */
  region?: string
  /** One-time registration token (only on first registration). */
  registrationToken?: RegistrationToken
}

/**
 * Response from the orchestrator's worker-registration endpoint.
 * Mirrors RegisterResponse from agentfactory-tui/worker/types.go.
 */
export interface RegisterResponse {
  /** Stable worker pool ID assigned by the orchestrator. */
  workerId: string
  /** Scoped JWT for subsequent calls (heartbeats, work acceptance). */
  runtimeJwt: string
  /** How often the daemon should send heartbeats (seconds). */
  heartbeatIntervalSeconds: number
  /** How often the daemon should poll for new work (seconds). */
  pollIntervalSeconds: number
}

export type DaemonRegistrationStatus = 'idle' | 'busy' | 'draining'

// ---------------------------------------------------------------------------
// Session / work-acceptance types
// ---------------------------------------------------------------------------

/**
 * Inbound work specification dispatched by the orchestrator.
 * Subset of SandboxSpec from 004 that is relevant to the daemon's
 * session-dispatch path.
 */
export interface SessionSpec {
  /** Orchestrator-assigned session identifier. */
  sessionId: string
  /** Repository to work on (must be in the project allowlist). */
  repository: string
  /** Git ref (branch/tag/SHA) to check out. */
  ref: string
  /** Optional resource request (defaults to per-session maxes from config). */
  resources?: {
    vCpu?: number
    memoryMb?: number
  }
  /** Environment variables to inject into the worker process. */
  env?: Record<string, string>
  /** Maximum session wall-clock time in seconds. Default: unlimited. */
  maxDurationSeconds?: number
}

/**
 * Handle returned to the orchestrator after a session is accepted.
 * Represents a spawned child worker process.
 */
export interface SessionHandle {
  sessionId: string
  /** OS process ID of the worker child process. */
  pid: number
  /** ISO 8601 timestamp when the session was accepted. */
  acceptedAt: string
  /** Current session state. */
  state: SessionState
}

export type SessionState = 'starting' | 'running' | 'completed' | 'failed' | 'terminated'

// ---------------------------------------------------------------------------
// Daemon lifecycle state
// ---------------------------------------------------------------------------

export type DaemonState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'draining'
  | 'updating'

export interface DaemonStatus {
  state: DaemonState
  /** Orchestrator-assigned worker pool ID (available after registration). */
  workerId?: string
  /** Sessions currently in-flight. */
  activeSessions: number
  /** Maximum sessions from config. */
  maxSessions: number
  /** Daemon version. */
  version: string
  /** ISO 8601 start time. */
  startedAt?: string
}

// ---------------------------------------------------------------------------
// Heartbeat event shape (emitted to globalHookBus as 'post-verb')
// ---------------------------------------------------------------------------

export interface DaemonHeartbeatPayload {
  workerId: string
  hostname: string
  status: DaemonRegistrationStatus
  activeSessions: number
  maxSessions: number
  region?: string
  sentAt: string
}
