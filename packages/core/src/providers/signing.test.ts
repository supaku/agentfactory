/**
 * Tests for the provider signing & trust verification runtime (REN-1314).
 *
 * Coverage:
 * - Manifest hash computation (canonical JSON sha256) via base.ts helpers
 * - All four verifier paths: sigstore, cosign, minisign, ed25519
 * - All three trust modes: permissive, signed-by-allowlist, attested
 * - trustOverride audit trail
 * - Capability discrepancy detection + hook bus event
 * - Invalid signature rejection
 * - Allowlist matching
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  generateKeyPairSync,
  sign as cryptoSign,
  createPrivateKey,
  createPublicKey,
} from 'node:crypto'
import type { ProviderManifest, ProviderSignature, ProviderRef } from './base.js'
import { hashManifest } from './base.js'
import {
  verifyManifestSignature,
  detectCapabilityMismatch,
  getTrustOverrideAuditLog,
  clearTrustOverrideAuditLog,
  registerVerifier,
  getVerifier,
  type TrustMode,
  type TrustOverride,
} from './signing.js'
import { globalHookBus } from '../observability/hooks.js'
import type { ProviderHookEvent } from './base.js'
import type { SandboxProviderCapabilities } from './base.js'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const validSandboxCaps: SandboxProviderCapabilities = {
  transportModel: 'dial-in',
  supportsFsSnapshot: true,
  supportsPauseResume: false,
  idleCostModel: 'zero',
  billingModel: 'wall-clock',
  regions: ['us-east-1'],
  maxConcurrent: null,
  maxSessionDurationSeconds: 3600,
}

function makeManifest(
  id = 'test-sandbox',
  overrides?: Partial<ProviderManifest<'sandbox'>>,
): ProviderManifest<'sandbox'> {
  return {
    apiVersion: 'rensei.dev/v1',
    family: 'sandbox',
    id,
    version: '1.0.0',
    name: `Test ${id}`,
    requires: { rensei: '>=0.8' },
    entry: { kind: 'static', modulePath: `./dist/${id}.js` },
    capabilitiesDeclared: validSandboxCaps,
    ...overrides,
  }
}

const testProviderRef: ProviderRef = {
  family: 'sandbox',
  id: 'test-sandbox',
  version: '1.0.0',
}

function makeBaseSig(manifest: ProviderManifest<'sandbox'>): ProviderSignature {
  return {
    signer: 'did:web:example.com',
    publicKey: 'placeholder-key',
    algorithm: 'ed25519',
    signatureValue: 'STUB_VALID_sig',
    manifestHash: hashManifest(manifest),
    attestedAt: '2026-04-27T00:00:00.000Z',
  }
}

// ---------------------------------------------------------------------------
// Helper: generate a real Ed25519 keypair and sign
// ---------------------------------------------------------------------------

function generateEd25519Keypair() {
  return generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
}

function signWithEd25519(manifestHash: string, privateKeyPem: string): string {
  const privKey = createPrivateKey(privateKeyPem)
  const message = Buffer.from(manifestHash, 'utf8')
  const sigBuf = cryptoSign(null, message, privKey)
  return sigBuf.toString('base64')
}

// ---------------------------------------------------------------------------
// 1. Manifest hash computation
// ---------------------------------------------------------------------------

describe('manifest hash computation', () => {
  it('produces a 64-char hex sha256 digest', () => {
    const manifest = makeManifest()
    const hash = hashManifest(manifest)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('produces the same hash for identical manifests', () => {
    const m1 = makeManifest()
    const m2 = makeManifest()
    expect(hashManifest(m1)).toBe(hashManifest(m2))
  })

  it('produces different hashes for different manifests', () => {
    const m1 = makeManifest('provider-a')
    const m2 = makeManifest('provider-b')
    expect(hashManifest(m1)).not.toBe(hashManifest(m2))
  })

  it('is key-order insensitive (canonical JSON)', () => {
    const m1 = makeManifest('p', { description: 'first', author: 'alice' })
    const m2 = makeManifest('p', { author: 'alice', description: 'first' })
    expect(hashManifest(m1)).toBe(hashManifest(m2))
  })
})

// ---------------------------------------------------------------------------
// 2. Ed25519 verifier
// ---------------------------------------------------------------------------

describe('Ed25519 verifier', () => {
  it('verifies a real Ed25519 signature', async () => {
    const { publicKey, privateKey } = generateEd25519Keypair()
    const manifest = makeManifest()
    const manifestHash = hashManifest(manifest)
    const signatureValue = signWithEd25519(manifestHash, privateKey)

    const sig: ProviderSignature = {
      signer: 'did:web:test.example',
      publicKey,
      algorithm: 'ed25519',
      signatureValue,
      manifestHash,
      attestedAt: '2026-04-27T00:00:00.000Z',
    }

    const result = await verifyManifestSignature(manifest, sig)
    expect(result.valid).toBe(true)
  })

  it('rejects an invalid Ed25519 signature', async () => {
    const { publicKey, privateKey } = generateEd25519Keypair()
    const manifest = makeManifest()
    const manifestHash = hashManifest(manifest)
    // Sign a different message
    const wrongMessage = 'this-is-not-the-hash'
    const privKey = createPrivateKey(privateKey)
    const sigBuf = cryptoSign(null, Buffer.from(wrongMessage, 'utf8'), privKey)
    const signatureValue = sigBuf.toString('base64')

    const sig: ProviderSignature = {
      signer: 'did:web:test.example',
      publicKey,
      algorithm: 'ed25519',
      signatureValue,
      manifestHash,
      attestedAt: '2026-04-27T00:00:00.000Z',
    }

    const result = await verifyManifestSignature(manifest, sig)
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/Ed25519/)
  })

  it('rejects when manifest hash does not match', async () => {
    const { publicKey, privateKey } = generateEd25519Keypair()
    const manifest = makeManifest()
    const manifestHash = hashManifest(manifest)
    const signatureValue = signWithEd25519(manifestHash, privateKey)

    const sig: ProviderSignature = {
      signer: 'did:web:test.example',
      publicKey,
      algorithm: 'ed25519',
      signatureValue,
      manifestHash: 'tampered-hash',
      attestedAt: '2026-04-27T00:00:00.000Z',
    }

    const result = await verifyManifestSignature(manifest, sig)
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/manifestHash mismatch/)
  })

  it('rejects with wrong public key', async () => {
    const kp1 = generateEd25519Keypair()
    const kp2 = generateEd25519Keypair()
    const manifest = makeManifest()
    const manifestHash = hashManifest(manifest)
    const signatureValue = signWithEd25519(manifestHash, kp1.privateKey)

    const sig: ProviderSignature = {
      signer: 'did:web:test.example',
      publicKey: kp2.publicKey, // wrong key
      algorithm: 'ed25519',
      signatureValue,
      manifestHash,
      attestedAt: '2026-04-27T00:00:00.000Z',
    }

    const result = await verifyManifestSignature(manifest, sig)
    expect(result.valid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. Minisign verifier (simplified mode)
// ---------------------------------------------------------------------------

describe('Minisign verifier (simplified mode)', () => {
  it('verifies a simplified minisign signature (plain 64-byte sig + plain 32-byte key)', async () => {
    // Generate Ed25519 keypair — minisign simplified mode uses raw bytes
    const { publicKey: pubPem, privateKey: privPem } = generateEd25519Keypair()
    const manifest = makeManifest()
    const manifestHash = hashManifest(manifest)

    // Extract raw 32-byte Ed25519 public key from SPKI DER
    const pubKeyObj = createPublicKey(pubPem)
    const spkiDer = pubKeyObj.export({ type: 'spki', format: 'der' }) as Buffer
    // SPKI prefix for Ed25519 is 12 bytes: 302a300506032b6570032100
    const rawPubKey = spkiDer.subarray(12) // last 32 bytes

    // Sign with Ed25519 private key
    const privKey = createPrivateKey(privPem)
    const message = Buffer.from(manifestHash, 'utf8')
    const sigBytes = cryptoSign(null, message, privKey)

    const sig: ProviderSignature = {
      signer: 'did:web:test.example',
      publicKey: rawPubKey.toString('base64'), // 32 bytes base64
      algorithm: 'minisign',
      signatureValue: sigBytes.toString('base64'), // 64 bytes base64
      manifestHash,
      attestedAt: '2026-04-27T00:00:00.000Z',
    }

    const result = await verifyManifestSignature(manifest, sig)
    expect(result.valid).toBe(true)
  })

  it('rejects invalid minisign signature', async () => {
    const { publicKey: pubPem } = generateEd25519Keypair()
    const manifest = makeManifest()
    const manifestHash = hashManifest(manifest)

    const pubKeyObj = createPublicKey(pubPem)
    const spkiDer = pubKeyObj.export({ type: 'spki', format: 'der' }) as Buffer
    const rawPubKey = spkiDer.subarray(12)

    // Use garbage as the signature
    const garbageSig = Buffer.alloc(64, 0xff)

    const sig: ProviderSignature = {
      signer: 'did:web:test.example',
      publicKey: rawPubKey.toString('base64'),
      algorithm: 'minisign',
      signatureValue: garbageSig.toString('base64'),
      manifestHash,
      attestedAt: '2026-04-27T00:00:00.000Z',
    }

    const result = await verifyManifestSignature(manifest, sig)
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/Minisign/)
  })
})

// ---------------------------------------------------------------------------
// 4. Cosign verifier (test mode)
// ---------------------------------------------------------------------------

describe('Cosign verifier (test mode)', () => {
  it('accepts COSIGN_TEST: prefix in test mode', async () => {
    const manifest = makeManifest()
    const sig: ProviderSignature = {
      signer: 'did:web:registry.example',
      publicKey: 'placeholder-cosign-key',
      algorithm: 'cosign',
      signatureValue: 'COSIGN_TEST:valid',
      manifestHash: hashManifest(manifest),
      attestedAt: '2026-04-27T00:00:00.000Z',
    }

    const result = await verifyManifestSignature(manifest, sig)
    expect(result.valid).toBe(true)
  })

  it('rejects when cosign CLI unavailable and no test prefix', async () => {
    const manifest = makeManifest()
    const sig: ProviderSignature = {
      signer: 'did:web:registry.example',
      publicKey: 'placeholder-cosign-key',
      algorithm: 'cosign',
      signatureValue: 'real-cosign-sig-base64',
      manifestHash: hashManifest(manifest),
      attestedAt: '2026-04-27T00:00:00.000Z',
    }

    // cosign is (almost certainly) not in the test environment PATH
    const result = await verifyManifestSignature(manifest, sig)
    // Either cosign is unavailable (most likely) or it fails to verify the garbage sig
    expect(result.valid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. Sigstore verifier (test mode)
// ---------------------------------------------------------------------------

describe('Sigstore verifier (test mode)', () => {
  it('accepts SIGSTORE_TEST: prefix in test mode', async () => {
    const manifest = makeManifest()
    const sig: ProviderSignature = {
      signer: 'did:web:sigstore.dev',
      publicKey: '',
      algorithm: 'sigstore',
      signatureValue: 'SIGSTORE_TEST:bundle',
      manifestHash: hashManifest(manifest),
      attestedAt: '2026-04-27T00:00:00.000Z',
    }

    const result = await verifyManifestSignature(manifest, sig)
    expect(result.valid).toBe(true)
  })

  it('rejects without @sigstore/verify installed when not in test mode', async () => {
    const manifest = makeManifest()
    const sig: ProviderSignature = {
      signer: 'did:web:sigstore.dev',
      publicKey: '',
      algorithm: 'sigstore',
      // Base64 of some string pretending to be a bundle
      signatureValue: Buffer.from('{"not": "a real bundle"}').toString('base64'),
      manifestHash: hashManifest(manifest),
      attestedAt: '2026-04-27T00:00:00.000Z',
    }

    const result = await verifyManifestSignature(manifest, sig)
    // Either @sigstore/verify is not installed (most likely) or it fails
    expect(result.valid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 6. Trust modes
// ---------------------------------------------------------------------------

describe('trust modes', () => {
  // Helper: make a sig with STUB_VALID so crypto passes, set _testBypassVerify
  function makeTestSig(manifest: ProviderManifest<'sandbox'>, signer = 'did:web:example.com'): ProviderSignature {
    return {
      signer,
      publicKey: 'test-pubkey',
      algorithm: 'ed25519',
      signatureValue: 'STUB_VALID_for_trust_test',
      manifestHash: hashManifest(manifest),
      attestedAt: '2026-04-27T00:00:00.000Z',
    }
  }

  describe('permissive mode', () => {
    it('accepts unsigned providers with a warning', async () => {
      const manifest = makeManifest()
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const result = await verifyManifestSignature(manifest, null, {
        trustMode: 'permissive',
      })
      expect(result.valid).toBe(true)
      expect(result.reason).toMatch(/permissive/)
      warnSpy.mockRestore()
    })

    it('accepts signed providers regardless of signer', async () => {
      const manifest = makeManifest()
      const sig = makeTestSig(manifest, 'did:web:unknown-signer.example')
      const result = await verifyManifestSignature(manifest, sig, {
        trustMode: 'permissive',
        _testBypassVerify: true,
      })
      expect(result.valid).toBe(true)
    })
  })

  describe('signed-by-allowlist mode', () => {
    it('accepts providers whose signer is in the allowlist', async () => {
      const manifest = makeManifest()
      const sig = makeTestSig(manifest, 'did:web:trusted.example')
      const result = await verifyManifestSignature(manifest, sig, {
        trustMode: 'signed-by-allowlist',
        signerAllowlist: ['did:web:trusted.example', 'did:web:other.example'],
        _testBypassVerify: true,
      })
      expect(result.valid).toBe(true)
    })

    it('rejects providers whose signer is NOT in the allowlist', async () => {
      const manifest = makeManifest()
      const sig = makeTestSig(manifest, 'did:web:untrusted.example')
      const result = await verifyManifestSignature(manifest, sig, {
        trustMode: 'signed-by-allowlist',
        signerAllowlist: ['did:web:trusted.example'],
        _testBypassVerify: true,
      })
      expect(result.valid).toBe(false)
      expect(result.reason).toMatch(/not in the allowlist/)
      expect(result.reason).toMatch(/untrusted\.example/)
    })

    it('rejects unsigned providers', async () => {
      const manifest = makeManifest()
      const result = await verifyManifestSignature(manifest, null, {
        trustMode: 'signed-by-allowlist',
        signerAllowlist: ['did:web:trusted.example'],
      })
      expect(result.valid).toBe(false)
      expect(result.reason).toMatch(/requires/)
    })

    it('rejects when allowlist is empty', async () => {
      const manifest = makeManifest()
      const sig = makeTestSig(manifest, 'did:web:anyone.example')
      const result = await verifyManifestSignature(manifest, sig, {
        trustMode: 'signed-by-allowlist',
        signerAllowlist: [],
        _testBypassVerify: true,
      })
      expect(result.valid).toBe(false)
      expect(result.reason).toMatch(/non-empty signerAllowlist/)
    })
  })

  describe('attested mode', () => {
    it('accepts providers with SLSA provenance under "slsa" key', async () => {
      const manifest = makeManifest()
      const sig = makeTestSig(manifest)
      const sigWithAttestation: ProviderSignature = {
        ...sig,
        attestations: {
          slsa: { buildType: 'https://slsa.dev/provenance/v0.2', builder: { id: 'ci.example.com' } },
        },
      }
      const result = await verifyManifestSignature(manifest, sigWithAttestation, {
        trustMode: 'attested',
        _testBypassVerify: true,
      })
      expect(result.valid).toBe(true)
    })

    it('accepts providers with SLSA provenance under "slsaProvenance" key', async () => {
      const manifest = makeManifest()
      const sig: ProviderSignature = {
        ...makeTestSig(manifest),
        attestations: { slsaProvenance: { level: 2 } },
      }
      const result = await verifyManifestSignature(manifest, sig, {
        trustMode: 'attested',
        _testBypassVerify: true,
      })
      expect(result.valid).toBe(true)
    })

    it('rejects providers without SLSA provenance', async () => {
      const manifest = makeManifest()
      const sig: ProviderSignature = {
        ...makeTestSig(manifest),
        attestations: { 'code-scan': 'passed' }, // no slsa key
      }
      const result = await verifyManifestSignature(manifest, sig, {
        trustMode: 'attested',
        _testBypassVerify: true,
      })
      expect(result.valid).toBe(false)
      expect(result.reason).toMatch(/SLSA provenance/)
    })

    it('rejects providers with no attestations at all', async () => {
      const manifest = makeManifest()
      const sig = makeTestSig(manifest) // no attestations
      const result = await verifyManifestSignature(manifest, sig, {
        trustMode: 'attested',
        _testBypassVerify: true,
      })
      expect(result.valid).toBe(false)
      expect(result.reason).toMatch(/SLSA provenance/)
    })
  })
})

// ---------------------------------------------------------------------------
// 7. trustOverride audit trail
// ---------------------------------------------------------------------------

describe('trustOverride audit trail', () => {
  beforeEach(() => clearTrustOverrideAuditLog())
  afterEach(() => clearTrustOverrideAuditLog())

  const override: TrustOverride = {
    mode: 'allowed-this-once',
    actor: 'oncall-engineer@example.com',
    reason: 'Incident response — signer key being rotated',
  }

  it('applies override when trust check fails and logs an audit entry', async () => {
    const manifest = makeManifest()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const result = await verifyManifestSignature(manifest, null, {
      trustMode: 'signed-by-allowlist',
      signerAllowlist: ['did:web:trusted.example'],
      trustOverride: override,
    })
    expect(result.valid).toBe(true)
    expect(result.overrideApplied).toBe(true)
    warnSpy.mockRestore()

    const log = getTrustOverrideAuditLog()
    expect(log).toHaveLength(1)
    expect(log[0].actor).toBe(override.actor)
    expect(log[0].reason).toBe(override.reason)
    expect(log[0].signer).toBe('unsigned')
    expect(log[0].providerRef.id).toBe('test-sandbox')
    expect(log[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('includes manifestHash in the audit entry', async () => {
    const manifest = makeManifest()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await verifyManifestSignature(manifest, null, {
      trustMode: 'signed-by-allowlist',
      signerAllowlist: ['did:web:trusted.example'],
      trustOverride: override,
    })
    vi.restoreAllMocks()

    const log = getTrustOverrideAuditLog()
    expect(log[0].manifestHash).toBe(hashManifest(manifest))
  })

  it('accumulates multiple override entries', async () => {
    const m1 = makeManifest('provider-a')
    const m2 = makeManifest('provider-b')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await verifyManifestSignature(m1, null, {
      trustMode: 'signed-by-allowlist',
      signerAllowlist: [],
      trustOverride: override,
    })
    await verifyManifestSignature(m2, null, {
      trustMode: 'signed-by-allowlist',
      signerAllowlist: [],
      trustOverride: override,
    })
    vi.restoreAllMocks()

    expect(getTrustOverrideAuditLog()).toHaveLength(2)
  })

  it('does NOT apply override when trust check passes', async () => {
    const manifest = makeManifest()
    const result = await verifyManifestSignature(manifest, null, {
      trustMode: 'permissive', // passes
      trustOverride: override,
    })
    expect(result.valid).toBe(true)
    expect(result.overrideApplied).toBeUndefined()
    expect(getTrustOverrideAuditLog()).toHaveLength(0)
  })

  it('records the signer identity from the signature (not "unsigned")', async () => {
    const manifest = makeManifest()
    const { publicKey, privateKey } = generateEd25519Keypair()
    const manifestHash = hashManifest(manifest)
    const signatureValue = signWithEd25519(manifestHash, privateKey)

    const sig: ProviderSignature = {
      signer: 'did:web:known-signer.example',
      publicKey,
      algorithm: 'ed25519',
      signatureValue,
      manifestHash,
      attestedAt: '2026-04-27T00:00:00.000Z',
    }

    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await verifyManifestSignature(manifest, sig, {
      trustMode: 'signed-by-allowlist',
      signerAllowlist: ['did:web:different-signer.example'], // not matching
      trustOverride: override,
    })
    vi.restoreAllMocks()

    const log = getTrustOverrideAuditLog()
    expect(log[0].signer).toBe('did:web:known-signer.example')
  })
})

// ---------------------------------------------------------------------------
// 8. Capability discrepancy detection
// ---------------------------------------------------------------------------

describe('capability discrepancy detection', () => {
  const providerRef: ProviderRef = { family: 'sandbox', id: 'test-provider', version: '1.0.0' }
  let emittedEvents: ProviderHookEvent[] = []

  beforeEach(() => {
    emittedEvents = []
    globalHookBus.subscribe({ kinds: ['capability-mismatch'] }, (event) => {
      emittedEvents.push(event)
    })
  })

  afterEach(() => {
    globalHookBus.clear()
  })

  it('returns empty discrepancies when declared matches observed', async () => {
    const declared = { supportsPauseResume: false, billingModel: 'wall-clock', regions: ['us-east-1'] }
    const observed = { supportsPauseResume: false, billingModel: 'wall-clock', regions: ['us-east-1'] }
    const result = await detectCapabilityMismatch(providerRef, declared, observed)
    expect(result).toHaveLength(0)
    expect(emittedEvents).toHaveLength(0)
  })

  it('detects a boolean capability mismatch', async () => {
    const declared = { supportsPauseResume: true }
    const observed = { supportsPauseResume: false }
    const result = await detectCapabilityMismatch(providerRef, declared, observed)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatch(/supportsPauseResume/)
    expect(result[0]).toMatch(/mismatch/)
  })

  it('detects a missing capability in observed', async () => {
    const declared = { supportsPauseResume: true, billingModel: 'wall-clock' }
    const observed = { billingModel: 'wall-clock' } // missing supportsPauseResume
    const result = await detectCapabilityMismatch(providerRef, declared, observed)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatch(/supportsPauseResume/)
    expect(result[0]).toMatch(/not observed/)
  })

  it('detects a string capability mismatch', async () => {
    const declared = { billingModel: 'wall-clock' }
    const observed = { billingModel: 'active-cpu' }
    const result = await detectCapabilityMismatch(providerRef, declared, observed)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatch(/billingModel/)
  })

  it('detects array capability mismatch (different elements)', async () => {
    const declared = { regions: ['us-east-1', 'eu-west-1'] }
    const observed = { regions: ['us-east-1'] }
    const result = await detectCapabilityMismatch(providerRef, declared, observed)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatch(/regions/)
  })

  it('treats array capabilities as order-insensitive (set semantics)', async () => {
    const declared = { regions: ['us-east-1', 'eu-west-1'] }
    const observed = { regions: ['eu-west-1', 'us-east-1'] }
    const result = await detectCapabilityMismatch(providerRef, declared, observed)
    expect(result).toHaveLength(0)
  })

  it('detects multiple mismatches', async () => {
    const declared = { supportsPauseResume: true, billingModel: 'wall-clock' }
    const observed = { supportsPauseResume: false, billingModel: 'active-cpu' }
    const result = await detectCapabilityMismatch(providerRef, declared, observed)
    expect(result).toHaveLength(2)
  })

  it('emits capability-mismatch hook event when mismatch detected', async () => {
    const declared = { supportsPauseResume: true }
    const observed = { supportsPauseResume: false }
    await detectCapabilityMismatch(providerRef, declared, observed)
    // Give the hook bus time to dispatch
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    expect(emittedEvents).toHaveLength(1)
    expect(emittedEvents[0].kind).toBe('capability-mismatch')
    const mismatchEvent = emittedEvents[0] as Extract<ProviderHookEvent, { kind: 'capability-mismatch' }>
    expect(mismatchEvent.provider).toEqual(providerRef)
    expect(mismatchEvent.declared).toEqual(declared)
    expect(mismatchEvent.observed).toEqual(observed)
  })

  it('does NOT emit hook event when no mismatch', async () => {
    const declared = { billingModel: 'wall-clock' }
    const observed = { billingModel: 'wall-clock' }
    await detectCapabilityMismatch(providerRef, declared, observed)
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    expect(emittedEvents).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 9. Pluggable verifier interface
// ---------------------------------------------------------------------------

describe('pluggable verifier interface', () => {
  it('can register a custom verifier', () => {
    const customVerifier = {
      algorithm: 'custom-test',
      verify: async (_input: unknown) => ({ valid: true }),
    }
    registerVerifier(customVerifier as Parameters<typeof registerVerifier>[0])
    const retrieved = getVerifier('custom-test')
    expect(retrieved).toBe(customVerifier)
  })

  it('uses a registered custom verifier for manifest verification', async () => {
    let verifyCalled = false
    const customVerifier = {
      algorithm: 'custom-algo',
      verify: async () => {
        verifyCalled = true
        return { valid: true }
      },
    }
    registerVerifier(customVerifier as Parameters<typeof registerVerifier>[0])

    const manifest = makeManifest()
    const sig: ProviderSignature = {
      signer: 'did:web:test.example',
      publicKey: 'test-key',
      algorithm: 'custom-algo' as ProviderSignature['algorithm'],
      signatureValue: 'any-value',
      manifestHash: hashManifest(manifest),
      attestedAt: '2026-04-27T00:00:00.000Z',
    }

    const result = await verifyManifestSignature(manifest, sig, { trustMode: 'permissive' })
    expect(verifyCalled).toBe(true)
    expect(result.valid).toBe(true)
  })

  it('returns an error for unregistered algorithm', async () => {
    const manifest = makeManifest()
    const sig: ProviderSignature = {
      signer: 'did:web:test.example',
      publicKey: 'test-key',
      algorithm: 'unknown-algo' as ProviderSignature['algorithm'],
      signatureValue: 'any-value',
      manifestHash: hashManifest(manifest),
      attestedAt: '2026-04-27T00:00:00.000Z',
    }

    const result = await verifyManifestSignature(manifest, sig)
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/No verifier registered/)
  })
})
