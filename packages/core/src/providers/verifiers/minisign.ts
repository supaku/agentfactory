/**
 * Minisign Verifier — pure JS implementation of the minisign format.
 *
 * Minisign uses Ed25519 with a specific wire format:
 *
 *   Public key file:
 *     Line 1: comment (ignored)
 *     Line 2: base64(algorithm_id[2] || key_id[8] || public_key[32])
 *
 *   Signature file:
 *     Line 1: "untrusted comment: ..."
 *     Line 2: base64(algorithm[2] || key_id[8] || signature[64])
 *     Line 3: "trusted comment: ..."
 *     Line 4: base64(global_signature[64])
 *
 * For our use case we pack the public key and signature into base64 fields
 * of ProviderSignature so they can be embedded in the manifest JSON.
 *
 * Encoding conventions for this verifier:
 *   publicKey:      base64(algorithm_id[2] + key_id[8] + public_key_bytes[32])
 *                   OR plain base64(public_key_bytes[32]) for simplified mode
 *   signatureValue: base64(algorithm_id[2] + key_id[8] + signature_bytes[64])
 *                   OR plain base64(signature_bytes[64]) for simplified mode
 *
 * "Simplified mode" is detected when the decoded buffer is exactly 32 bytes
 * (public key) or 64 bytes (signature), skipping the minisign framing.
 */

import { verify as cryptoVerify } from 'node:crypto'
import { createPublicKey } from 'node:crypto'
import type { Verifier, VerifierInput, VerifierResult } from './index.js'

const MINISIGN_ALGORITHM_ED = 0x4544 // 'ED' in big-endian
const MINISIGN_ALG_BYTES = 2
const MINISIGN_KEY_ID_BYTES = 8
const MINISIGN_PUBKEY_BYTES = 32
const MINISIGN_SIG_BYTES = 64
const MINISIGN_FRAMED_PUBKEY_LEN = MINISIGN_ALG_BYTES + MINISIGN_KEY_ID_BYTES + MINISIGN_PUBKEY_BYTES // 42
const MINISIGN_FRAMED_SIG_LEN = MINISIGN_ALG_BYTES + MINISIGN_KEY_ID_BYTES + MINISIGN_SIG_BYTES // 74

function parsePublicKey(publicKey: string): { keyId: Buffer; keyBytes: Buffer } | { error: string } {
  let raw: Buffer
  try {
    raw = Buffer.from(publicKey, 'base64')
  } catch {
    return { error: 'publicKey is not valid base64' }
  }

  if (raw.length === MINISIGN_PUBKEY_BYTES) {
    // Simplified mode — no framing
    return { keyId: Buffer.alloc(MINISIGN_KEY_ID_BYTES), keyBytes: raw }
  }

  if (raw.length === MINISIGN_FRAMED_PUBKEY_LEN) {
    // Framed mode: algId[2] + keyId[8] + key[32]
    const algId = raw.readUInt16BE(0)
    if (algId !== MINISIGN_ALGORITHM_ED) {
      return { error: `Unknown minisign algorithm id: 0x${algId.toString(16)}` }
    }
    const keyId = raw.subarray(MINISIGN_ALG_BYTES, MINISIGN_ALG_BYTES + MINISIGN_KEY_ID_BYTES)
    const keyBytes = raw.subarray(MINISIGN_ALG_BYTES + MINISIGN_KEY_ID_BYTES)
    return { keyId: Buffer.from(keyId), keyBytes: Buffer.from(keyBytes) }
  }

  return {
    error: `Unexpected publicKey length ${raw.length}: expected ${MINISIGN_PUBKEY_BYTES} (plain) or ${MINISIGN_FRAMED_PUBKEY_LEN} (framed)`,
  }
}

function parseSignature(signatureValue: string): { keyId: Buffer; sigBytes: Buffer } | { error: string } {
  let raw: Buffer
  try {
    raw = Buffer.from(signatureValue, 'base64')
  } catch {
    return { error: 'signatureValue is not valid base64' }
  }

  if (raw.length === MINISIGN_SIG_BYTES) {
    // Simplified mode — no framing
    return { keyId: Buffer.alloc(MINISIGN_KEY_ID_BYTES), sigBytes: raw }
  }

  if (raw.length === MINISIGN_FRAMED_SIG_LEN) {
    // Framed mode: algId[2] + keyId[8] + sig[64]
    const algId = raw.readUInt16BE(0)
    if (algId !== MINISIGN_ALGORITHM_ED) {
      return { error: `Unknown minisign algorithm id: 0x${algId.toString(16)}` }
    }
    const keyId = raw.subarray(MINISIGN_ALG_BYTES, MINISIGN_ALG_BYTES + MINISIGN_KEY_ID_BYTES)
    const sigBytes = raw.subarray(MINISIGN_ALG_BYTES + MINISIGN_KEY_ID_BYTES)
    return { keyId: Buffer.from(keyId), sigBytes: Buffer.from(sigBytes) }
  }

  return {
    error: `Unexpected signatureValue length ${raw.length}: expected ${MINISIGN_SIG_BYTES} (plain) or ${MINISIGN_FRAMED_SIG_LEN} (framed)`,
  }
}

export class MinisignVerifier implements Verifier {
  readonly algorithm = 'minisign'

  async verify(input: VerifierInput): Promise<VerifierResult> {
    try {
      const pkResult = parsePublicKey(input.publicKey)
      if ('error' in pkResult) {
        return { valid: false, reason: pkResult.error }
      }

      const sigResult = parseSignature(input.signatureValue)
      if ('error' in sigResult) {
        return { valid: false, reason: sigResult.error }
      }

      // Key ID consistency check (only when both have non-zero key IDs)
      const pkKeyIdIsZero = pkResult.keyId.every((b) => b === 0)
      const sigKeyIdIsZero = sigResult.keyId.every((b) => b === 0)
      if (!pkKeyIdIsZero && !sigKeyIdIsZero) {
        if (!pkResult.keyId.equals(sigResult.keyId)) {
          return {
            valid: false,
            reason: `Key ID mismatch: public key id ${pkResult.keyId.toString('hex')} != signature key id ${sigResult.keyId.toString('hex')}`,
          }
        }
      }

      // Build a SPKI-wrapped Ed25519 public key for node:crypto
      let keyObject: ReturnType<typeof createPublicKey>
      try {
        // Raw Ed25519 public key bytes wrapped as SPKI DER
        // SPKI prefix for Ed25519: 302a300506032b6570032100
        const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex')
        const spkiDer = Buffer.concat([spkiPrefix, pkResult.keyBytes])
        keyObject = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { valid: false, reason: `Failed to parse Ed25519 public key: ${msg}` }
      }

      // Message: UTF-8 bytes of the manifest hash hex string
      const message = Buffer.from(input.manifestHash, 'utf8')

      const isValid = cryptoVerify(null, message, keyObject, sigResult.sigBytes)

      if (!isValid) {
        return { valid: false, reason: 'Minisign (Ed25519) signature verification failed' }
      }

      return { valid: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { valid: false, reason: `Minisign verification error: ${msg}` }
    }
  }
}
