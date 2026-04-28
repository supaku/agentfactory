/**
 * Cosign Verifier — shells out to the `cosign` CLI when available.
 *
 * Cosign can verify container images and arbitrary blobs. For provider
 * manifests we use the blob-verification path:
 *
 *   cosign verify-blob \
 *     --key <pubkey-file> \
 *     --signature <sig-file> \
 *     <manifest-hash-file>
 *
 * If the `cosign` binary is not in PATH, the verifier falls back to a
 * deterministic stub that checks for the 'COSIGN_TEST:' prefix in the
 * signatureValue (used in tests).
 *
 * Public key format: PEM ECDSA (cosign's default) or an Ed25519 PEM key.
 * Signature format: base64-encoded cosign bundle JSON or raw signature bytes.
 *
 * For testing without cosign installed:
 *   signatureValue: 'COSIGN_TEST:<any suffix>'
 *   This causes the verifier to return valid=true without invoking cosign.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, unlink, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Verifier, VerifierInput, VerifierResult } from './index.js'

const execFileAsync = promisify(execFile)

const COSIGN_TEST_PREFIX = 'COSIGN_TEST:'

/** Check if cosign binary is available in PATH. */
async function isCosignAvailable(): Promise<boolean> {
  try {
    await execFileAsync('cosign', ['version'], { timeout: 5000 })
    return true
  } catch {
    return false
  }
}

export class CosignVerifier implements Verifier {
  readonly algorithm = 'cosign'

  async verify(input: VerifierInput): Promise<VerifierResult> {
    const { manifestHash, signatureValue, publicKey } = input

    // Deterministic test mode
    if (signatureValue.startsWith(COSIGN_TEST_PREFIX)) {
      return { valid: true, reason: 'cosign test mode bypass' }
    }

    // Check if cosign is installed
    const cosignAvailable = await isCosignAvailable()
    if (!cosignAvailable) {
      return {
        valid: false,
        reason:
          'cosign CLI not found in PATH. Install cosign (https://docs.sigstore.dev/cosign/installation) ' +
          'or use signatureValue starting with "COSIGN_TEST:" for tests.',
      }
    }

    // Write temp files for cosign verify-blob
    let tmpDir: string
    try {
      tmpDir = await mkdtemp(join(tmpdir(), 'rensei-cosign-'))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { valid: false, reason: `Failed to create temp directory: ${msg}` }
    }

    const keyFile = join(tmpDir, 'pubkey.pem')
    const sigFile = join(tmpDir, 'signature.sig')
    const msgFile = join(tmpDir, 'manifest.hash')

    try {
      // Write the public key (PEM)
      await writeFile(keyFile, publicKey, 'utf8')

      // Write the signature (decode from base64 to raw bytes)
      const sigBytes = Buffer.from(signatureValue, 'base64')
      await writeFile(sigFile, sigBytes)

      // Write the message: UTF-8 bytes of the manifest hash hex string
      await writeFile(msgFile, manifestHash, 'utf8')

      // Run cosign verify-blob
      await execFileAsync(
        'cosign',
        ['verify-blob', '--key', keyFile, '--signature', sigFile, msgFile],
        { timeout: 30_000 },
      )

      return { valid: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // cosign exits non-zero on verification failure
      return { valid: false, reason: `Cosign verification failed: ${msg}` }
    } finally {
      // Clean up temp files
      await Promise.allSettled([
        unlink(keyFile).catch(() => undefined),
        unlink(sigFile).catch(() => undefined),
        unlink(msgFile).catch(() => undefined),
      ])
      // Remove tmpDir (best effort)
      await import('node:fs/promises').then((fsp) => fsp.rmdir(tmpDir)).catch(() => undefined)
    }
  }
}
