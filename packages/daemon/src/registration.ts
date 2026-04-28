/**
 * Daemon registration — exchanges a one-time rsp_live_* token for a scoped JWT.
 *
 * Architecture reference:
 *   rensei-architecture/004-sandbox-capability-matrix.md §Worker registration model
 *   rensei-architecture/011-local-daemon-fleet.md
 *
 * The dial-out flow:
 *   1. Daemon boots with a one-time `rsp_live_…` registration token from config.
 *   2. Calls POST /v1/daemon/register with RegisterRequest.
 *   3. Receives RegisterResponse including a scoped JWT (runtimeJwt).
 *   4. Caches the JWT at ~/.rensei/daemon.jwt for subsequent runs.
 *   5. On subsequent starts, uses the cached JWT directly and skips token exchange.
 *
 * NOTE: The orchestrator API endpoint POST /v1/daemon/register does not yet exist
 * in the platform. This module ships a stub implementation that returns a valid
 * synthetic JWT for development/testing. The real endpoint will be wired in a
 * follow-up issue (REN-1292 or orchestrator-side work).
 *
 * To activate the real HTTP exchange, set RENSEI_DAEMON_REAL_REGISTRATION=1.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve as resolvePath, dirname } from 'node:path'
import type { RegisterRequest, RegisterResponse, RegistrationToken } from './types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default path where the exchanged JWT is cached between restarts. */
export const DEFAULT_JWT_PATH = resolvePath(homedir(), '.rensei', 'daemon.jwt')

/**
 * Registration endpoint on the orchestrator.
 * TODO: implement on the orchestrator side — this endpoint is stubbed below.
 */
export const REGISTER_ENDPOINT = '/v1/daemon/register'

// ---------------------------------------------------------------------------
// Stub JWT (development / CI / pre-orchestrator-endpoint)
// ---------------------------------------------------------------------------

/**
 * Generate a synthetic JWT-shaped string for testing and pre-production use.
 * The stub is always valid (no expiry enforced) and encodes the workerId.
 *
 * Format: `stub.<base64-header>.<base64-payload>.<stub-sig>`
 * The `stub.` prefix is intentionally invalid as a real JWT so real code
 * will reject it if accidentally used against a live service.
 */
function makeStubJwt(workerId: string, hostname: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'stub', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      sub: workerId,
      iss: 'rensei-daemon-stub',
      iat: Math.floor(Date.now() / 1000),
      hostname,
      stub: true,
    }),
  ).toString('base64url')
  return `stub.${header}.${payload}.stub-signature`
}

/**
 * Build a synthetic RegisterResponse for the stub path.
 * Mirrors the shape expected from the real orchestrator endpoint.
 */
function buildStubResponse(req: RegisterRequest): RegisterResponse {
  const workerId = `worker-${req.hostname}-stub`
  return {
    workerId,
    runtimeJwt: makeStubJwt(workerId, req.hostname),
    heartbeatIntervalSeconds: 30,
    pollIntervalSeconds: 10,
  }
}

// ---------------------------------------------------------------------------
// JWT cache helpers
// ---------------------------------------------------------------------------

interface CachedJwt {
  workerId: string
  runtimeJwt: string
  heartbeatIntervalSeconds: number
  pollIntervalSeconds: number
  /** ISO 8601 — when this cache entry was written */
  cachedAt: string
}

/**
 * Load a cached JWT from disk. Returns undefined if the file does not exist
 * or is not parseable.
 */
export function loadCachedJwt(jwtPath: string = DEFAULT_JWT_PATH): CachedJwt | undefined {
  if (!existsSync(jwtPath)) return undefined
  try {
    const raw = readFileSync(jwtPath, 'utf-8')
    const parsed = JSON.parse(raw) as CachedJwt
    // Basic shape check
    if (typeof parsed.runtimeJwt === 'string' && typeof parsed.workerId === 'string') {
      return parsed
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Persist a RegisterResponse as the cached JWT entry.
 */
export function saveCachedJwt(
  response: RegisterResponse,
  jwtPath: string = DEFAULT_JWT_PATH,
): void {
  const dir = dirname(jwtPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const entry: CachedJwt = {
    workerId: response.workerId,
    runtimeJwt: response.runtimeJwt,
    heartbeatIntervalSeconds: response.heartbeatIntervalSeconds,
    pollIntervalSeconds: response.pollIntervalSeconds,
    cachedAt: new Date().toISOString(),
  }
  writeFileSync(jwtPath, JSON.stringify(entry, null, 2), { encoding: 'utf-8', mode: 0o600 })
}

// ---------------------------------------------------------------------------
// Real HTTP registration (future; guarded by env flag)
// ---------------------------------------------------------------------------

/**
 * Call the real orchestrator registration endpoint.
 * Throws if the request fails or returns a non-2xx status.
 *
 * NOTE: This path is not yet reachable in production (the orchestrator endpoint
 * is not yet implemented). It is included so the real wiring is ready to activate
 * when the endpoint ships.
 */
async function callRegisterEndpoint(
  orchestratorUrl: string,
  req: RegisterRequest,
  jwtPath: string,
): Promise<RegisterResponse> {
  const url = `${orchestratorUrl.replace(/\/$/, '')}${REGISTER_ENDPOINT}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'rensei-daemon/0.1.0',
    },
    body: JSON.stringify(req),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '(no body)')
    throw new Error(`Registration failed (HTTP ${res.status}): ${body}`)
  }

  const data = (await res.json()) as RegisterResponse
  saveCachedJwt(data, jwtPath)
  return data
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RegistrationOptions {
  /** Orchestrator base URL from daemon config. */
  orchestratorUrl: string
  /** One-time registration token (rsp_live_* prefix). */
  registrationToken: RegistrationToken
  /** Machine hostname / identifier from daemon config. */
  hostname: string
  /** Daemon version string (semver). */
  version: string
  /** Maximum concurrent sessions from capacity config. */
  maxAgents: number
  /** Capability tags for the dial-out registration. */
  capabilities?: string[]
  /** Region hint for scheduler latency routing. */
  region?: string
  /** Path to the JWT cache file. Defaults to ~/.rensei/daemon.jwt. */
  jwtPath?: string
  /** Force re-registration even if a cached JWT exists. */
  forceReregister?: boolean
}

/**
 * Register the daemon with the orchestrator.
 *
 * - If a cached JWT exists (and forceReregister is false), returns it directly.
 * - Otherwise, calls the registration endpoint (real or stub) and caches the result.
 *
 * The stub is used when:
 *   - RENSEI_DAEMON_REAL_REGISTRATION is not set, OR
 *   - The orchestrator URL starts with 'file://' (local queue mode), OR
 *   - The registration token does not have an rsp_live_ prefix (test tokens).
 */
export async function register(opts: RegistrationOptions): Promise<RegisterResponse> {
  const jwtPath = opts.jwtPath ?? DEFAULT_JWT_PATH
  const useStub =
    !process.env['RENSEI_DAEMON_REAL_REGISTRATION'] ||
    opts.orchestratorUrl.startsWith('file://') ||
    !opts.registrationToken.startsWith('rsp_live_')

  // Return cached JWT if available and not forcing re-registration
  if (!opts.forceReregister) {
    const cached = loadCachedJwt(jwtPath)
    if (cached) {
      return {
        workerId: cached.workerId,
        runtimeJwt: cached.runtimeJwt,
        heartbeatIntervalSeconds: cached.heartbeatIntervalSeconds,
        pollIntervalSeconds: cached.pollIntervalSeconds,
      }
    }
  }

  const req: RegisterRequest = {
    hostname: opts.hostname,
    version: opts.version,
    maxAgents: opts.maxAgents,
    capabilities: opts.capabilities ?? ['local', 'sandbox', 'workarea'],
    activeAgentCount: 0,
    status: 'idle',
    region: opts.region,
    registrationToken: opts.registrationToken,
  }

  if (useStub) {
    const response = buildStubResponse(req)
    saveCachedJwt(response, jwtPath)
    return response
  }

  return callRegisterEndpoint(opts.orchestratorUrl, req, jwtPath)
}
