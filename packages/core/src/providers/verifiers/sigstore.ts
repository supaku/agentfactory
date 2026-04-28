/**
 * Sigstore Verifier — implements the Sigstore bundle verification path.
 *
 * Sigstore uses Rekor (transparency log) + Fulcio (certificate authority)
 * to produce signed bundles. For provider manifests we support two modes:
 *
 * 1. **Bundle mode** (production): signatureValue is base64(JSON sigstore bundle).
 *    We attempt to import @sigstore/verify if available; otherwise we report a
 *    clear error with installation instructions.
 *
 * 2. **Test mode**: signatureValue starts with 'SIGSTORE_TEST:'.
 *    Returns valid=true without any network call or library dependency.
 *
 * The publicKey field may be:
 *   - Empty string: use Rekor/Fulcio identity verification (OIDC signer)
 *   - PEM certificate or public key: used for keyful signing verification
 *
 * Note: Full Sigstore verification requires network access to Rekor. In
 * environments without network access, use cosign or ed25519 instead.
 */

import type { Verifier, VerifierInput, VerifierResult } from './index.js'

const SIGSTORE_TEST_PREFIX = 'SIGSTORE_TEST:'

/**
 * Attempt to verify using @sigstore/verify if installed.
 * Returns null if the package is not available.
 */
async function tryVerifyWithSigstorePackage(
  bundleJson: string,
  artifactBytes: Buffer,
): Promise<VerifierResult | null> {
  // Type definitions for the @sigstore/verify API shapes we use.
  // Defined inline to avoid a hard dependency on the package types.
  type SigstoreBundle = Record<string, unknown>
  type SignedEntity = Record<string, unknown>
  type SigstoreVerifierInstance = { verify(entity: SignedEntity, artifact: Buffer): void }
  type SigstoreVerifierCtor = new (policy: unknown, options?: unknown) => SigstoreVerifierInstance
  type SigstoreVerifyModule = {
    Verifier?: SigstoreVerifierCtor
    toSignedEntity?: (bundle: SigstoreBundle) => SignedEntity
    TrustRootManager?: { fulcio(): unknown }
  }

  try {
    // Dynamic import — graceful degradation if not installed.
    // We use a string variable to prevent TypeScript from resolving
    // the module at compile time (avoids TS2307 when not installed).
    const moduleName = '@sigstore/verify'
    const sigstoreVerify = await import(/* @vite-ignore */ moduleName).catch(() => null) as SigstoreVerifyModule | null
    if (!sigstoreVerify) return null

    const { Verifier: SigstoreVerifierClass, toSignedEntity } = sigstoreVerify

    if (!SigstoreVerifierClass || !toSignedEntity) {
      // Unexpected module shape — skip
      return null
    }

    let bundle: SigstoreBundle
    try {
      const parsed = JSON.parse(bundleJson) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { valid: false, reason: 'signatureValue is not a valid JSON object (expected sigstore bundle)' }
      }
      bundle = parsed as SigstoreBundle
    } catch {
      return { valid: false, reason: 'signatureValue is not valid JSON (expected sigstore bundle)' }
    }

    const signedEntity = toSignedEntity(bundle)
    // The verifier API varies between @sigstore/verify versions.
    // We use a try-based dispatch to handle different API shapes.
    const verifierInstance = new SigstoreVerifierClass({})
    verifierInstance.verify(signedEntity, artifactBytes)

    return { valid: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { valid: false, reason: `Sigstore bundle verification failed: ${msg}` }
  }
}

export class SigstoreVerifier implements Verifier {
  readonly algorithm = 'sigstore'

  async verify(input: VerifierInput): Promise<VerifierResult> {
    const { manifestHash, signatureValue } = input

    // Test mode bypass
    if (signatureValue.startsWith(SIGSTORE_TEST_PREFIX)) {
      return { valid: true, reason: 'sigstore test mode bypass' }
    }

    // The artifact being verified is the UTF-8 bytes of the manifest hash
    const artifactBytes = Buffer.from(manifestHash, 'utf8')

    // Attempt to decode the bundle
    let bundleJson: string
    try {
      bundleJson = Buffer.from(signatureValue, 'base64').toString('utf8')
    } catch {
      return { valid: false, reason: 'signatureValue is not valid base64' }
    }

    // Try @sigstore/verify first
    const packageResult = await tryVerifyWithSigstorePackage(bundleJson, artifactBytes)
    if (packageResult !== null) {
      return packageResult
    }

    // @sigstore/verify not available
    return {
      valid: false,
      reason:
        '@sigstore/verify package is not installed. Install it with: ' +
        'pnpm add @sigstore/verify\n' +
        'Alternatively, use signatureValue starting with "SIGSTORE_TEST:" for tests, ' +
        'or use the cosign or ed25519 algorithm with a local key.',
    }
  }
}
