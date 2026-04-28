/**
 * Worker spawner — spawns and tracks child worker processes per session.
 *
 * Architecture reference:
 *   rensei-architecture/004-sandbox-capability-matrix.md §Local daemon mode
 *   rensei-architecture/011-local-daemon-fleet.md §Daemon lifecycle
 *
 * Each accepted session gets its own child process. The spawner:
 *   - Validates the session spec against the project allowlist.
 *   - Spawns a child process (currently a no-op worker node script; real
 *     worker launch is wired in REN-1292/launchd and the CLI entry point).
 *   - Tracks in-flight sessions and their PIDs.
 *   - Supports drain semantics: stops accepting new work and waits for
 *     all children to exit (with a configurable timeout), then SIGTERMs.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { SessionSpec, SessionHandle, SessionState, DaemonProjectConfig } from './types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpawnedSession {
  handle: SessionHandle
  process: ChildProcess
  spec: SessionSpec
}

export interface WorkerSpawnerOptions {
  /** List of allowed projects from daemon config. */
  projects: DaemonProjectConfig[]
  /** Maximum concurrent sessions. */
  maxConcurrentSessions: number
  /** Worker entry-point script path.
   * Defaults to a placeholder that logs the session env and exits 0.
   * Real workers will be wired via CLI (REN-1292).
   */
  workerScript?: string
  /** Base environment variables injected into every worker process. */
  baseEnv?: Record<string, string>
}

// ---------------------------------------------------------------------------
// WorkerSpawner
// ---------------------------------------------------------------------------

/**
 * Manages the lifecycle of worker child processes.
 * Emits 'session-started' and 'session-ended' events on the EventEmitter.
 */
export class WorkerSpawner extends EventEmitter {
  private readonly _sessions = new Map<string, SpawnedSession>()
  private readonly _opts: Required<WorkerSpawnerOptions>
  private _accepting = true

  constructor(opts: WorkerSpawnerOptions) {
    super()
    this._opts = {
      workerScript: _defaultWorkerScript(),
      baseEnv: {},
      ...opts,
    }
  }

  // ---------------------------------------------------------------------------
  // acceptWork — validate, spawn, track
  // ---------------------------------------------------------------------------

  /**
   * Accept a work spec: validate the project is allowed, check capacity,
   * spawn a child worker process, and return a SessionHandle.
   *
   * @throws {Error} If the project is not in the allowlist or capacity is full.
   */
  async acceptWork(spec: SessionSpec): Promise<SessionHandle> {
    if (!this._accepting) {
      throw new Error('[daemon] Not accepting new work (draining or stopped)')
    }

    if (this._sessions.size >= this._opts.maxConcurrentSessions) {
      throw new Error(
        `[daemon] At capacity (${this._sessions.size}/${this._opts.maxConcurrentSessions} sessions)`,
      )
    }

    const project = this._findProject(spec.repository)
    if (!project) {
      throw new Error(
        `[daemon] Repository '${spec.repository}' is not in the project allowlist`,
      )
    }

    const handle = await this._spawnWorker(spec, project)
    return handle
  }

  // ---------------------------------------------------------------------------
  // Drain semantics
  // ---------------------------------------------------------------------------

  /**
   * Stop accepting new work. Returns a promise that resolves when all
   * in-flight sessions complete, or rejects after timeoutMs.
   *
   * @param timeoutMs - Max wait time before SIGTERMing remaining children.
   *                    Default: 30 minutes (from spec — matches drainTimeoutSeconds default × 3).
   */
  async drain(timeoutMs = 30 * 60 * 1000): Promise<void> {
    this._accepting = false

    if (this._sessions.size === 0) {
      return
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Grace period expired — SIGTERM remaining children
        for (const { process: proc, handle } of this._sessions.values()) {
          console.warn(`[daemon] drain timeout — sending SIGTERM to session ${handle.sessionId} (pid ${proc.pid})`)
          proc.kill('SIGTERM')
        }
        reject(new Error(`[daemon] drain timed out after ${timeoutMs}ms with ${this._sessions.size} sessions still running`))
      }, timeoutMs)

      const checkDone = (): void => {
        if (this._sessions.size === 0) {
          clearTimeout(timer)
          resolve()
        }
      }

      // Check on every session-ended event
      this.on('session-ended', () => { checkDone() })
      checkDone() // in case all sessions ended before we got here
    })
  }

  /** Resume accepting new work after a drain (e.g., for a pause/resume cycle). */
  resume(): void {
    this._accepting = true
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  /** Current number of in-flight sessions. */
  get activeCount(): number {
    return this._sessions.size
  }

  /** Whether the spawner is currently accepting new work. */
  get isAccepting(): boolean {
    return this._accepting
  }

  /** Returns all currently active session handles. */
  getActiveSessions(): SessionHandle[] {
    return [...this._sessions.values()].map((s) => s.handle)
  }

  // ---------------------------------------------------------------------------
  // Internal: spawn worker
  // ---------------------------------------------------------------------------

  private async _spawnWorker(
    spec: SessionSpec,
    project: DaemonProjectConfig,
  ): Promise<SessionHandle> {
    const sessionEnv: Record<string, string> = {
      ...this._opts.baseEnv,
      ...(spec.env ?? {}),
      RENSEI_SESSION_ID: spec.sessionId,
      RENSEI_REPOSITORY: spec.repository,
      RENSEI_REF: spec.ref,
      RENSEI_PROJECT_ID: project.id,
    }

    // When workerScript is the stub sentinel, use an inline node -e script
    // that logs the session ID and exits 0 immediately.
    const isStub = this._opts.workerScript === STUB_WORKER_SCRIPT_SENTINEL
    const spawnArgs: string[] = isStub
      ? ['-e', `process.stdout.write('session-started:' + process.env.RENSEI_SESSION_ID + '\\n'); process.exit(0);`]
      : [this._opts.workerScript, spec.sessionId]

    const child = spawn(process.execPath, spawnArgs, {
      env: { ...process.env, ...sessionEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    })

    // Log worker stdout/stderr for observability
    child.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(`[worker:${spec.sessionId.slice(0, 8)}] ${chunk.toString()}`)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[worker:${spec.sessionId.slice(0, 8)}] ${chunk.toString()}`)
    })

    const handle: SessionHandle = {
      sessionId: spec.sessionId,
      pid: child.pid ?? 0,
      acceptedAt: new Date().toISOString(),
      state: 'starting',
    }

    const session: SpawnedSession = { handle, process: child, spec }
    this._sessions.set(spec.sessionId, session)

    // Update state when the process signals readiness (for now, transition immediately)
    handle.state = 'running'
    this.emit('session-started', handle)

    child.once('exit', (code: number | null, signal: string | null) => {
      const finalState: SessionState = code === 0 ? 'completed' : signal ? 'terminated' : 'failed'
      handle.state = finalState
      this._sessions.delete(spec.sessionId)
      this.emit('session-ended', handle, { code, signal })
    })

    child.once('error', (err: Error) => {
      handle.state = 'failed'
      this._sessions.delete(spec.sessionId)
      this.emit('session-error', handle, err)
      this.emit('session-ended', handle, { code: null, signal: null })
    })

    return handle
  }

  // ---------------------------------------------------------------------------
  // Internal: project lookup
  // ---------------------------------------------------------------------------

  private _findProject(repository: string): DaemonProjectConfig | undefined {
    return this._opts.projects.find((p) => {
      // Match by exact repository string or by the trailing slug
      return (
        p.repository === repository ||
        repository.endsWith(`/${p.repository}`) ||
        p.repository.endsWith(`/${repository}`)
      )
    })
  }
}

// ---------------------------------------------------------------------------
// Default worker script helper
// ---------------------------------------------------------------------------

/**
 * Returns the path to an inline stub worker script.
 * The stub prints the session ID and exits 0, simulating a successful session.
 *
 * Real worker scripts will be wired via the CLI entry point in REN-1292.
 * This ensures tests can exercise the spawn path without actual agent work.
 */
function _defaultWorkerScript(): string {
  // We write a tiny inline Node script using node -e
  // The caller uses process.execPath + ['-e', script] — but since we're passing
  // workerScript as a file path to node, we use a temp file approach.
  // For the stub, we rely on the caller passing a real script path when needed.
  // When not overridden, we return a known no-op path.
  return _STUB_WORKER_SCRIPT_PATH
}

/**
 * Sentinel value that WorkerSpawner checks to use the inline stub.
 * When workerScript === STUB_SENTINEL, spawn uses node -e <inline-script>.
 */
export const STUB_WORKER_SCRIPT_SENTINEL = '__STUB_WORKER__'

// Re-export as default for tests
const _STUB_WORKER_SCRIPT_PATH = STUB_WORKER_SCRIPT_SENTINEL

/**
 * Create a WorkerSpawner that uses an inline stub worker (for testing).
 * The stub immediately exits 0 without doing any real work.
 */
export function createStubSpawner(opts: Omit<WorkerSpawnerOptions, 'workerScript'>): WorkerSpawner {
  return new WorkerSpawner({
    ...opts,
    workerScript: STUB_WORKER_SCRIPT_SENTINEL,
  })
}
