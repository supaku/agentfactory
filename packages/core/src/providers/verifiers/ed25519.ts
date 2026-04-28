/**
 * Ed25519 Verifier — uses node:crypto built-in.
 *
 * Key format: PEM (-----BEGIN PUBLIC KEY-----) or raw base64.
 * Signature format: base64-encoded 64-byte Ed25519 signature.
 *
 * The message signed is the UTF-8 encoding of the manifest hash hex string.
 */

import { createVerify, createPublicKey } from 'node:crypto'
import type { Verifier, VerifierInput, VerifierResult } from './index.js'

export class Ed25519Verifier implements Verifier {
  readonly algorithm = 'ed25519'

  async verify(input: VerifierInput): Promise<VerifierResult> {
    try {
      const { manifestHash, signatureValue, publicKey } = input

      // Decode the base64 signature
      let sigBuf: Buffer
      try {
        sigBuf = Buffer.from(signatureValue, 'base64')
      } catch {
        return { valid: false, reason: 'signatureValue is not valid base64' }
      }

      if (sigBuf.length === 0) {
        return { valid: false, reason: 'signatureValue decoded to empty buffer' }
      }

      // Parse the public key — accept PEM or raw base64
      let keyObject: ReturnType<typeof createPublicKey>
      try {
        if (publicKey.includes('-----BEGIN')) {
          keyObject = createPublicKey({ key: publicKey, format: 'pem' })
        } else {
          // Attempt raw base64 (32-byte Ed25519 public key)
          const rawKey = Buffer.from(publicKey, 'base64')
          keyObject = createPublicKey({
            key: rawKey,
            format: 'der',
            type: 'spki',
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { valid: false, reason: `Failed to parse publicKey: ${msg}` }
      }

      // Verify: message is the UTF-8 bytes of the manifest hash hex string
      const message = Buffer.from(manifestHash, 'utf8')

      const verify = createVerify('SHA512')
      // Ed25519 uses SHA-512 internally but the algorithm name passed to
      // createVerify must be 'SHA512' when using Ed25519 key objects.
      // Actually for Ed25519, we use the 'ed25519' algorithm directly.
      // node:crypto createVerify doesn't support 'ed25519' directly for
      // Ed25519 keys; we use the sign/verify API instead.
      void verify // silence unused var; we use the newer API below

      const { verify: cryptoVerify } = await import('node:crypto')
      const isValid = cryptoVerify(
        null, // Ed25519 does not use a hash algorithm parameter
        message,
        keyObject,
        sigBuf,
      )

      if (!isValid) {
        return { valid: false, reason: 'Ed25519 signature verification failed' }
      }

      return { valid: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { valid: false, reason: `Ed25519 verification error: ${msg}` }
    }
  }
}
