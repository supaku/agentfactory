/**
 * Provider Base Contract — unified Provider<F> interface
 *
 * This module implements the unified base contract for all eight Rensei plugin
 * families: Sandbox, Workarea, AgentRuntime, VersionControl, IssueTracker,
 * Deployment, AgentRegistry, and Kit.
 *
 * Architecture reference: rensei-architecture/002-provider-base-contract.md
 *
 * Key design decisions:
 * - Provider<F> is generic on the family discriminator F (ProviderFamily)
 * - ProviderCapabilities<F> must be a flat object (no nested objects)
 * - Scope resolution: project > org > tenant > global, most-specific wins
 * - Same-level scope conflicts are an error (not a silent override)
 * - Manifest signing uses canonical-JSON hash; real sigstore wiring is REN-1314
 */

import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// ProviderFamily — the eight typed plugin families
// ---------------------------------------------------------------------------

/**
 * The eight Rensei plugin families. Every Provider<F> is parameterized on one
 * of these discriminants.
 */
export type ProviderFamily =
  | 'sandbox'
  | 'workarea'
  | 'agent-runtime'
  | 'vcs'
  | 'issue-tracker'
  | 'deployment'
  | 'agent-registry'
  | 'kit'

// ---------------------------------------------------------------------------
// ProviderHealth — health check result shape
// ---------------------------------------------------------------------------

export type ProviderHealth =
  | { status: 'ready' }
  | { status: 'degraded'; reason: string; recoverableAt?: Date }
  | { status: 'unhealthy'; reason: string }

// ---------------------------------------------------------------------------
// ProviderScope — four-level scope model
// ---------------------------------------------------------------------------

export interface ScopeSelector {
  /** Project IDs or names (disjunctive within this matcher) */
  project?: string | string[]
  /** Org IDs or names (disjunctive within) */
  org?: string | string[]
  /** Tenant IDs or names (disjunctive within) */
  tenant?: string | string[]

  /** Glob path patterns — provider applies when the workarea path matches */
  paths?: string[]
  excludePaths?: string[]

  /** Provider only applies when these host-side capabilities are present */
  requiresCapability?: string[]
  /** IDs of other providers that must be active */
  requiresProvider?: string[]
}

export interface ProviderScope {
  level: 'project' | 'org' | 'tenant' | 'global'
  /**
   * Selector is required for any level other than 'global'.
   * An empty selector at non-global level is invalid and will be caught by
   * validateManifest().
   */
  selector?: ScopeSelector
}

// ---------------------------------------------------------------------------
// ProviderEntry — how to load the provider implementation
// ---------------------------------------------------------------------------

export type ProviderEntry<_F> =
  | { kind: 'static'; modulePath: string }
  | { kind: 'npm'; package: string; export?: string }
  | { kind: 'binary'; command: string; args?: string[] }
  | { kind: 'remote'; url: string; protocol: 'a2a' | 'mcp' | 'http+rensei' }

// ---------------------------------------------------------------------------
// ProviderCapabilities<F> — flat capability structs per family
//
// Capabilities MUST be flat (no nested objects) so the scheduler can index
// and query them efficiently without deep traversal.
// ---------------------------------------------------------------------------

export interface SandboxProviderCapabilities {
  transportModel: 'dial-in' | 'dial-out' | 'either'
  supportsFsSnapshot: boolean
  supportsPauseResume: boolean
  idleCostModel: 'zero' | 'storage-only' | 'metered'
  billingModel: 'wall-clock' | 'active-cpu' | 'invocation' | 'fixed'
  regions: string[]
  maxConcurrent: number | null
  maxSessionDurationSeconds: number | null
}

export interface WorkareaProviderCapabilities {
  supportsSnapshot: boolean
  supportsWarmPool: boolean
  cleanStrategy: 'scoped-clean' | 'full-reset' | 'snapshot-restore'
}

export interface AgentRuntimeProviderCapabilities {
  supportsMessageInjection: boolean
  supportsSessionResume: boolean
  supportsToolPlugins: boolean
  emitsSubagentEvents: boolean
  toolPermissionFormat: 'claude' | 'codex' | 'spring-ai' | 'generic'
}

export interface VersionControlProviderCapabilities {
  mergeStrategy: 'three-way-text' | 'patch-theory' | 'crdt' | 'last-write-wins' | 'object-version'
  conflictGranularity: 'line' | 'token' | 'object' | 'cell' | 'none'
  hasPullRequests: boolean
  hasReviewWorkflow: boolean
  hasMergeQueue: boolean
  identityScheme: 'email' | 'ed25519' | 'oauth' | 'iam'
  provenanceNative: boolean
}

export interface IssueTrackerProviderCapabilities {
  supportsWebhooks: boolean
  supportsSubIssues: boolean
  hasWorkflowAutomation: boolean
  identityScheme: 'email' | 'oauth' | 'iam'
}

export interface DeploymentProviderCapabilities {
  supportsPreviewUrls: boolean
  supportsRollback: boolean
  supportsCdnInvalidation: boolean
  regions: string[]
}

export interface AgentRegistryProviderCapabilities {
  supportsVersionPinning: boolean
  supportsRemoteAgents: boolean
  sourceKind: 'local-yaml' | 'git-ref' | 'registry' | 'a2a'
}

export interface KitProviderCapabilities {
  supportsDetect: boolean
  supportsToolchainDemands: boolean
  supportsSkillExport: boolean
  supportedLanguages: string[]
}

/**
 * Capability type map — discriminated union resolved from the family tag.
 * Each family-specific capabilities struct must be a flat object (no nested
 * objects) so the scheduler can index capability flags directly.
 */
export type ProviderCapabilities<F extends ProviderFamily> =
  F extends 'sandbox' ? SandboxProviderCapabilities :
  F extends 'workarea' ? WorkareaProviderCapabilities :
  F extends 'agent-runtime' ? AgentRuntimeProviderCapabilities :
  F extends 'vcs' ? VersionControlProviderCapabilities :
  F extends 'issue-tracker' ? IssueTrackerProviderCapabilities :
  F extends 'deployment' ? DeploymentProviderCapabilities :
  F extends 'agent-registry' ? AgentRegistryProviderCapabilities :
  F extends 'kit' ? KitProviderCapabilities :
  never

// ---------------------------------------------------------------------------
// ProviderManifest<F> — discovery primitive
// ---------------------------------------------------------------------------

export interface ProviderManifest<F extends ProviderFamily> {
  /** Always 'rensei.dev/v1' */
  apiVersion: 'rensei.dev/v1'
  /** The family this manifest targets */
  family: F
  /** Globally unique within the family */
  id: string
  /** SemVer */
  version: string
  name: string
  description?: string

  /** Origin metadata — used for discovery and trust */
  author?: string
  /** Keypair identity for signing (URL or DID) */
  authorIdentity?: string
  homepage?: string
  /** SPDX identifier */
  license?: string
  repository?: string

  /** Compatibility — host checks these before activation */
  requires: {
    /** SemVer range of the host runtime required */
    rensei: string
    /** Host-side capabilities required (e.g. 'workarea:snapshot') */
    capabilities?: string[]
  }

  /** How to load the implementation */
  entry: ProviderEntry<F>
  /**
   * Capabilities declared up-front so the scheduler can reason about
   * candidates without loading the implementation.
   */
  capabilitiesDeclared: ProviderCapabilities<F>

  metricsPrefix?: string
  logScope?: string
}

// ---------------------------------------------------------------------------
// ProviderSignature — signing and trust
// ---------------------------------------------------------------------------

export interface ProviderSignature {
  /** Identity (URL or DID) of the signer */
  signer: string
  /** PEM or multibase-encoded public key */
  publicKey: string
  algorithm: 'sigstore' | 'cosign' | 'minisign' | 'ed25519'
  /** Base64-encoded signature value */
  signatureValue: string
  /** canonical-JSON sha256 of the manifest */
  manifestHash: string
  /** ISO timestamp when the signature was created */
  attestedAt: string
  /** Signer-defined extensions (SLSA provenance, in-toto attestations, etc.) */
  attestations?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// ProviderHost — minimal host interface passed to activate()
// ---------------------------------------------------------------------------

/** Reference to a provider by family and id */
export interface ProviderRef {
  family: ProviderFamily
  id: string
  version: string
}

export interface ProviderHost {
  /** Emit a hook event to the Layer 6 observability surface */
  emit(event: ProviderHookEvent): void
}

// ---------------------------------------------------------------------------
// ProviderHookEvent — lifecycle hook taxonomy
// ---------------------------------------------------------------------------

export type ProviderHookEvent =
  // Activation lifecycle
  | { kind: 'pre-activate'; provider: ProviderRef }
  | { kind: 'post-activate'; provider: ProviderRef; durationMs: number }
  | { kind: 'pre-deactivate'; provider: ProviderRef; reason: string }
  | { kind: 'post-deactivate'; provider: ProviderRef }

  // Family-specific verb invocation
  | { kind: 'pre-verb'; provider: ProviderRef; verb: string; args: unknown }
  | { kind: 'post-verb'; provider: ProviderRef; verb: string; result: unknown; durationMs: number }
  | { kind: 'verb-error'; provider: ProviderRef; verb: string; error: Error }

  // Capability discrepancy
  | { kind: 'capability-mismatch'; provider: ProviderRef; declared: unknown; observed: unknown }

  // Scope events
  | { kind: 'scope-resolved'; chosen: ProviderRef[]; rejected: { provider: ProviderRef; reason: string }[] }

// ---------------------------------------------------------------------------
// Provider<F> — the unified base interface
// ---------------------------------------------------------------------------

/**
 * The unified base contract every plugin family in Rensei extends.
 *
 * Family-specific verbs (provision, acquire, clone, record, detect, etc.)
 * live on the family-typed sub-interfaces declared in their own reference
 * docs (003–008). This base is what every Provider must do to be
 * administrable: declare itself, advertise capabilities, prove its identity,
 * attach to lifecycle hooks.
 */
export interface Provider<F extends ProviderFamily = ProviderFamily> {
  readonly manifest: ProviderManifest<F>
  readonly capabilities: ProviderCapabilities<F>
  readonly scope: ProviderScope
  readonly signature: ProviderSignature | null

  /**
   * Called by the host once at activation. Idempotent.
   * Throwing here aborts activation.
   */
  activate(host: ProviderHost): Promise<void>

  /**
   * Called by the host at deactivation. Idempotent.
   * Must not throw on second call.
   */
  deactivate(): Promise<void>

  /**
   * Optional health check. Hosts may poll periodically to drop unhealthy
   * providers from rotation without restarting them.
   */
  health?(): Promise<ProviderHealth>
}

// ---------------------------------------------------------------------------
// Canonical-JSON hashing
// ---------------------------------------------------------------------------

/**
 * Produce a canonical-JSON string from a manifest.
 *
 * Canonical JSON: keys sorted recursively, no extra whitespace.
 * This is the string that gets hashed for signing / verification.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']'
  }
  const sorted = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => JSON.stringify(k) + ':' + canonicalJson((value as Record<string, unknown>)[k]))
    .join(',')
  return '{' + sorted + '}'
}

/**
 * Compute the SHA-256 hash of the canonical-JSON encoding of a manifest.
 * Returns a lowercase hex string.
 */
export function hashManifest<F extends ProviderFamily>(manifest: ProviderManifest<F>): string {
  const canonical = canonicalJson(manifest)
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// Signature verification stub
// ---------------------------------------------------------------------------

/**
 * Verify a provider signature against a manifest.
 *
 * Real sigstore/cosign/minisign wiring is deferred to REN-1314.
 * This stub implements the structural contract so consumers can program
 * against it today:
 *
 * - The manifestHash in the signature must match the canonical-JSON sha256 of
 *   the manifest.
 * - The signatureValue must be present and non-empty.
 * - The publicKey must be present and non-empty.
 *
 * For tests that need a "valid" signature, provide a signatureValue whose
 * first 7 bytes encode 'VALID' (base64url) or use the `_testBypassVerify`
 * option.
 */
export interface VerifySignatureOptions {
  /**
   * When true, skip the cryptographic verification step entirely.
   * For use in tests that only need to verify the hash check.
   * Never set this to true in production code.
   */
  _testBypassVerify?: boolean
}

export interface SignatureVerificationResult {
  valid: boolean
  reason?: string
}

export function verifySignature<F extends ProviderFamily>(
  sig: ProviderSignature,
  manifest: ProviderManifest<F>,
  _pubkey: string,
  options?: VerifySignatureOptions,
): SignatureVerificationResult {
  // 1. Verify the manifest hash
  const expectedHash = hashManifest(manifest)
  if (sig.manifestHash !== expectedHash) {
    return {
      valid: false,
      reason: `manifestHash mismatch: got ${sig.manifestHash}, expected ${expectedHash}`,
    }
  }

  // 2. Structural checks
  if (!sig.signatureValue || sig.signatureValue.trim().length === 0) {
    return { valid: false, reason: 'signatureValue is empty' }
  }
  if (!sig.publicKey || sig.publicKey.trim().length === 0) {
    return { valid: false, reason: 'publicKey is empty' }
  }

  // 3. Cryptographic verification (stubbed — REN-1314 wires real sigstore)
  if (options?._testBypassVerify) {
    return { valid: true }
  }

  // Deterministic stub: sig.signatureValue must start with 'STUB_VALID'
  // (base64-encoded). Real implementations replace this block with the
  // algorithm-specific verification call.
  if (!sig.signatureValue.startsWith('STUB_VALID')) {
    return {
      valid: false,
      reason:
        'Cryptographic verification not yet implemented (REN-1314). ' +
        'Use signatureValue starting with "STUB_VALID" in tests, or pass _testBypassVerify: true.',
    }
  }

  return { valid: true }
}

// ---------------------------------------------------------------------------
// Flat-capability validator
// ---------------------------------------------------------------------------

/**
 * Returns true if the given value is a "flat" object — i.e., has no property
 * whose value is a plain object (nested structs are forbidden per spec).
 *
 * Arrays and primitives are allowed as property values. Only `typeof x === 'object'
 * && !Array.isArray(x) && x !== null` at any property value triggers a violation.
 */
export function isFlatCapabilities(caps: Record<string, unknown>): boolean {
  for (const value of Object.values(caps)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return false
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

export interface ManifestValidationResult {
  valid: boolean
  errors: string[]
}

/**
 * Validate a ProviderManifest<F> against the base-contract schema.
 *
 * Checks:
 * 1. Required fields are present and well-formed.
 * 2. Capabilities are flat (no nested objects).
 * 3. Non-global scopes must have a selector.
 * 4. apiVersion is exactly 'rensei.dev/v1'.
 *
 * Returns { valid, errors } rather than throwing so callers can inspect all
 * violations at once.
 */
export function validateManifest<F extends ProviderFamily>(
  manifest: ProviderManifest<F>,
): ManifestValidationResult {
  const errors: string[] = []

  // apiVersion
  if (manifest.apiVersion !== 'rensei.dev/v1') {
    errors.push(`apiVersion must be 'rensei.dev/v1', got '${manifest.apiVersion}'`)
  }

  // family
  const validFamilies: ProviderFamily[] = [
    'sandbox',
    'workarea',
    'agent-runtime',
    'vcs',
    'issue-tracker',
    'deployment',
    'agent-registry',
    'kit',
  ]
  if (!validFamilies.includes(manifest.family)) {
    errors.push(`family '${manifest.family}' is not a valid ProviderFamily`)
  }

  // id
  if (!manifest.id || manifest.id.trim().length === 0) {
    errors.push('id must be a non-empty string')
  }

  // version
  if (!manifest.version || !/^\d+\.\d+\.\d+/.test(manifest.version)) {
    errors.push(`version '${manifest.version}' is not a valid semver string`)
  }

  // name
  if (!manifest.name || manifest.name.trim().length === 0) {
    errors.push('name must be a non-empty string')
  }

  // requires
  if (!manifest.requires || !manifest.requires.rensei) {
    errors.push('requires.rensei must be a non-empty semver range string')
  }

  // entry
  if (!manifest.entry || !manifest.entry.kind) {
    errors.push('entry.kind must be one of: static, npm, binary, remote')
  } else {
    const validEntryKinds = ['static', 'npm', 'binary', 'remote']
    if (!validEntryKinds.includes(manifest.entry.kind)) {
      errors.push(`entry.kind '${manifest.entry.kind}' is not valid; must be one of: ${validEntryKinds.join(', ')}`)
    }
  }

  // capabilities must be flat (no nested objects)
  if (manifest.capabilitiesDeclared && typeof manifest.capabilitiesDeclared === 'object') {
    if (!isFlatCapabilities(manifest.capabilitiesDeclared as unknown as Record<string, unknown>)) {
      errors.push(
        'capabilitiesDeclared must be a flat object (no nested plain objects). ' +
        'Arrays and primitives are allowed as values.',
      )
    }
  } else {
    errors.push('capabilitiesDeclared must be an object')
  }

  return { valid: errors.length === 0, errors }
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

/** Priority map for scope levels (higher = more specific) */
const SCOPE_LEVEL_PRIORITY: Record<ProviderScope['level'], number> = {
  project: 4,
  org: 3,
  tenant: 2,
  global: 1,
}

export interface ScopeResolutionResult<F extends ProviderFamily> {
  chosen: Provider<F> | null
  rejected: { provider: Provider<F>; reason: string }[]
}

/**
 * Resolve which provider to activate from a set of candidates.
 *
 * Resolution rules (from 002-provider-base-contract.md §Scope resolution):
 * 1. Most-specific scope wins. project > org > tenant > global.
 * 2. Same-level conflicts are an error — throws rather than silently picking one.
 * 3. Non-global scope without a selector is invalid (rejected).
 *
 * Selector matching is not implemented here (that requires a request context
 * object). This function resolves purely on scope level, which is sufficient
 * for the static activation use case. Path matching and conditional matchers
 * are added in the WorkareaProvider / Kit activation paths.
 *
 * @throws {Error} When two providers share the same highest scope level (conflict).
 */
export function resolveScope<F extends ProviderFamily>(
  candidates: Provider<F>[],
): ScopeResolutionResult<F> {
  if (candidates.length === 0) {
    return { chosen: null, rejected: [] }
  }

  const rejected: { provider: Provider<F>; reason: string }[] = []

  // Filter out providers with invalid non-global scopes (no selector)
  const valid: Provider<F>[] = []
  for (const p of candidates) {
    const { level, selector } = p.scope
    if (level !== 'global' && (!selector || Object.keys(selector).length === 0)) {
      rejected.push({
        provider: p,
        reason: `scope.level '${level}' requires a non-empty scope.selector`,
      })
    } else {
      valid.push(p)
    }
  }

  if (valid.length === 0) {
    return { chosen: null, rejected }
  }

  // Find the highest priority level
  const maxPriority = Math.max(...valid.map((p) => SCOPE_LEVEL_PRIORITY[p.scope.level]))

  // All providers at the highest priority level
  const topCandidates = valid.filter((p) => SCOPE_LEVEL_PRIORITY[p.scope.level] === maxPriority)

  if (topCandidates.length > 1) {
    // Same-level conflict — this is an error per spec
    const ids = topCandidates.map((p) => `${p.manifest.family}/${p.manifest.id}`).join(', ')
    throw new Error(
      `Provider scope conflict: ${topCandidates.length} providers share scope level '${topCandidates[0].scope.level}' ` +
      `for family '${topCandidates[0].manifest.family}'. ` +
      `Conflicting providers: ${ids}. ` +
      `Resolve by version-pinning one provider or adjusting scope selectors.`,
    )
  }

  const chosen = topCandidates[0]
  // The rest of valid (lower-priority) are "rejected" (shadowed)
  const shadowed = valid.filter((p) => p !== chosen).map((p) => ({
    provider: p,
    reason: `shadowed by higher-scope provider '${chosen.manifest.id}' (${chosen.scope.level} > ${p.scope.level})`,
  }))

  return {
    chosen,
    rejected: [...rejected, ...shadowed],
  }
}
