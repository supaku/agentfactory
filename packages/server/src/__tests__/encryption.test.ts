import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { randomBytes } from 'node:crypto'

describe('privacy/encryption', () => {
  let encryptField: typeof import('../privacy/encryption.js').encryptField
  let decryptField: typeof import('../privacy/encryption.js').decryptField
  let isEncryptionConfigured: typeof import('../privacy/encryption.js').isEncryptionConfigured
  let reEncryptField: typeof import('../privacy/encryption.js').reEncryptField

  const TEST_MASTER_KEY = randomBytes(32).toString('base64')

  beforeEach(async () => {
    process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY
    // Re-import to pick up env change
    const mod = await import('../privacy/encryption.js')
    encryptField = mod.encryptField
    decryptField = mod.decryptField
    isEncryptionConfigured = mod.isEncryptionConfigured
    reEncryptField = mod.reEncryptField
  })

  afterEach(() => {
    delete process.env.ENCRYPTION_MASTER_KEY
  })

  it('reports encryption as configured when ENCRYPTION_MASTER_KEY is set', () => {
    expect(isEncryptionConfigured()).toBe(true)
  })

  it('reports encryption as not configured when ENCRYPTION_MASTER_KEY is missing', () => {
    delete process.env.ENCRYPTION_MASTER_KEY
    expect(isEncryptionConfigured()).toBe(false)
  })

  it('encrypts and decrypts a field correctly', () => {
    const plaintext = 'This is a secret journal entry.'
    const userId = 'user-123'

    const ciphertext = encryptField(plaintext, userId)
    expect(ciphertext).not.toBeNull()
    expect(ciphertext).not.toBe(plaintext)

    const decrypted = decryptField(ciphertext!, userId)
    expect(decrypted).toBe(plaintext)
  })

  it('different users get different ciphertexts for the same plaintext', () => {
    const plaintext = 'Shared secret'

    const ct1 = encryptField(plaintext, 'user-1')
    const ct2 = encryptField(plaintext, 'user-2')

    expect(ct1).not.toBe(ct2)
  })

  it('cannot decrypt with wrong user ID', () => {
    const plaintext = 'Private data'
    const ciphertext = encryptField(plaintext, 'user-1')

    const decrypted = decryptField(ciphertext!, 'user-2')
    // With AES-GCM, wrong key should fail authentication
    expect(decrypted).toBeNull()
  })

  it('handles empty string', () => {
    const plaintext = ''
    const userId = 'user-123'

    const ciphertext = encryptField(plaintext, userId)
    expect(ciphertext).not.toBeNull()

    const decrypted = decryptField(ciphertext!, userId)
    expect(decrypted).toBe('')
  })

  it('handles unicode text', () => {
    const plaintext = 'Secret notes with emoji: and Japanese: 秘密のメモ'
    const userId = 'user-123'

    const ciphertext = encryptField(plaintext, userId)
    const decrypted = decryptField(ciphertext!, userId)
    expect(decrypted).toBe(plaintext)
  })

  it('returns null when encryption is not configured', () => {
    delete process.env.ENCRYPTION_MASTER_KEY

    const result = encryptField('test', 'user-123')
    expect(result).toBeNull()
  })

  it('returns null when decryption gets invalid ciphertext', () => {
    const result = decryptField('not-valid-base64-ciphertext', 'user-123')
    expect(result).toBeNull()
  })

  it('re-encrypts with a new master key', () => {
    const plaintext = 'Data to migrate'
    const userId = 'user-123'

    const ciphertext = encryptField(plaintext, userId)
    expect(ciphertext).not.toBeNull()

    const newMasterKey = randomBytes(32).toString('base64')

    const reEncrypted = reEncryptField(ciphertext!, userId, TEST_MASTER_KEY, newMasterKey)
    expect(reEncrypted).not.toBeNull()
    expect(reEncrypted).not.toBe(ciphertext)

    // Set new key in env to decrypt
    process.env.ENCRYPTION_MASTER_KEY = newMasterKey
    const decrypted = decryptField(reEncrypted!, userId)
    expect(decrypted).toBe(plaintext)
  })
})
