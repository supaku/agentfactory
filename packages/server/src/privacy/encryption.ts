/**
 * Application-level AES-256-GCM field encryption
 *
 * Provides encrypt/decrypt for sensitive fields (journal entries, API keys, OAuth tokens).
 * Uses per-user key derivation from a master key + user ID for tenant isolation.
 *
 * Environment: ENCRYPTION_MASTER_KEY (base64-encoded 32-byte key)
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'
import { createLogger } from '../logger.js'

const log = createLogger('privacy/encryption')

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

/**
 * Encrypted field format: base64(iv + authTag + ciphertext)
 * This is a single opaque string that can be stored in any text column.
 */
export interface EncryptedField {
  /** The encrypted value as a base64 string */
  ciphertext: string
  /** Whether the field is currently encrypted */
  encrypted: true
}

/**
 * Get the master encryption key from environment.
 * Returns null if not configured (encryption disabled).
 */
function getMasterKey(): Buffer | null {
  const keyStr = process.env.ENCRYPTION_MASTER_KEY
  if (!keyStr) {
    return null
  }
  const key = Buffer.from(keyStr, 'base64')
  if (key.length !== 32) {
    log.error('ENCRYPTION_MASTER_KEY must be 32 bytes (base64-encoded)')
    return null
  }
  return key
}

/**
 * Derive a per-user encryption key from master key + user ID.
 * Uses SHA-256(masterKey + userId) to produce a 32-byte key.
 */
export function deriveUserKey(userId: string): Buffer | null {
  const masterKey = getMasterKey()
  if (!masterKey) return null

  return createHash('sha256')
    .update(Buffer.concat([masterKey, Buffer.from(userId, 'utf-8')]))
    .digest()
}

/**
 * Check if encryption is configured
 */
export function isEncryptionConfigured(): boolean {
  return getMasterKey() !== null
}

/**
 * Encrypt a plaintext value using AES-256-GCM.
 *
 * @param plaintext - The value to encrypt
 * @param userId - User ID for key derivation
 * @returns Base64-encoded ciphertext or null if encryption is not configured
 */
export function encryptField(plaintext: string, userId: string): string | null {
  const key = deriveUserKey(userId)
  if (!key) {
    log.warn('Encryption not configured, returning plaintext')
    return null
  }

  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
  ])

  const authTag = cipher.getAuthTag()

  // Pack: iv (12) + authTag (16) + ciphertext
  const packed = Buffer.concat([iv, authTag, encrypted])
  return packed.toString('base64')
}

/**
 * Decrypt an encrypted field value.
 *
 * @param ciphertext - Base64-encoded encrypted value
 * @param userId - User ID for key derivation
 * @returns Decrypted plaintext or null if decryption fails
 */
export function decryptField(ciphertext: string, userId: string): string | null {
  const key = deriveUserKey(userId)
  if (!key) {
    log.warn('Encryption not configured, cannot decrypt')
    return null
  }

  try {
    const packed = Buffer.from(ciphertext, 'base64')

    if (packed.length < IV_LENGTH + AUTH_TAG_LENGTH) {
      log.error('Ciphertext too short')
      return null
    }

    const iv = packed.subarray(0, IV_LENGTH)
    const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
    const encrypted = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH)

    const decipher = createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(authTag)

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ])

    return decrypted.toString('utf-8')
  } catch (error) {
    log.error('Decryption failed', { error })
    return null
  }
}

/**
 * Re-encrypt a field with a new master key.
 * Used during key rotation: decrypt with old key, re-encrypt with new.
 *
 * @param ciphertext - Currently encrypted value
 * @param userId - User ID
 * @param oldMasterKey - Previous master key (base64)
 * @param newMasterKey - New master key (base64)
 */
export function reEncryptField(
  ciphertext: string,
  userId: string,
  oldMasterKey: string,
  newMasterKey: string
): string | null {
  // Temporarily derive key with old master
  const oldKey = createHash('sha256')
    .update(Buffer.concat([Buffer.from(oldMasterKey, 'base64'), Buffer.from(userId, 'utf-8')]))
    .digest()

  try {
    const packed = Buffer.from(ciphertext, 'base64')
    const iv = packed.subarray(0, IV_LENGTH)
    const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
    const encrypted = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH)

    const decipher = createDecipheriv(ALGORITHM, oldKey, iv)
    decipher.setAuthTag(authTag)

    const plaintext = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString('utf-8')

    // Re-encrypt with new key
    const newKey = createHash('sha256')
      .update(Buffer.concat([Buffer.from(newMasterKey, 'base64'), Buffer.from(userId, 'utf-8')]))
      .digest()

    const newIv = randomBytes(IV_LENGTH)
    const cipher = createCipheriv(ALGORITHM, newKey, newIv)

    const newEncrypted = Buffer.concat([
      cipher.update(plaintext, 'utf-8'),
      cipher.final(),
    ])

    const newAuthTag = cipher.getAuthTag()
    const newPacked = Buffer.concat([newIv, newAuthTag, newEncrypted])
    return newPacked.toString('base64')
  } catch (error) {
    log.error('Re-encryption failed', { error })
    return null
  }
}
