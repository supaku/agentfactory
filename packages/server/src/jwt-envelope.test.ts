import { describe, it, expect } from 'vitest'
import crypto from 'crypto'

import {
  verifyTenantEnvelope,
  _mintHS256,
  type TenantEnvelope,
  type TenantJwtClaims,
} from './jwt-envelope.js'

const HMAC_KEY = 'test-shared-secret-do-not-use-in-prod'
const ISSUER = 'https://issuer.rensei.ai/test'

function makeEnvelope(
  payload: Partial<TenantJwtClaims> = {},
  outerOrg = 'org-A',
): TenantEnvelope {
  const claims: TenantJwtClaims = {
    org: 'org-A',
    proj: 'projX',
    sub: 'user@rensei.ai',
    iss: ISSUER,
    iat: Math.floor(Date.now() / 1000),
    ...payload,
  }
  return {
    jwt: _mintHS256(claims, HMAC_KEY),
    org: outerOrg,
    ...(claims.proj && { proj: claims.proj }),
    ...(claims.sub && { sub: claims.sub }),
  }
}

describe('verifyTenantEnvelope', () => {
  it('accepts a valid HS256 envelope when worker org matches', () => {
    const env = makeEnvelope()
    const result = verifyTenantEnvelope(env, {
      trustedIssuers: [ISSUER],
      workerOrg: 'org-A',
      hmacKey: HMAC_KEY,
    })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.claims.org).toBe('org-A')
      expect(result.claims.iss).toBe(ISSUER)
    }
  })

  it('rejects a tampered token (signature does not verify)', () => {
    const env = makeEnvelope()
    // Flip a byte in the payload portion
    const parts = env.jwt.split('.')
    parts[1] = parts[1].slice(0, -1) + (parts[1].slice(-1) === 'A' ? 'B' : 'A')
    const tampered: TenantEnvelope = { ...env, jwt: parts.join('.') }

    const result = verifyTenantEnvelope(tampered, {
      trustedIssuers: [ISSUER],
      workerOrg: 'org-A',
      hmacKey: HMAC_KEY,
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      // Tampering may surface as malformed (base64 decode breaks JSON) or
      // as a signature mismatch — either is correct rejection behaviour.
      expect(['jwt-signature-invalid', 'jwt-malformed']).toContain(result.reason)
    }
  })

  it('rejects when worker org does not match the JWT org claim', () => {
    const env = makeEnvelope()
    const result = verifyTenantEnvelope(env, {
      trustedIssuers: [ISSUER],
      workerOrg: 'org-B',
      hmacKey: HMAC_KEY,
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.reason).toBe('worker-org-mismatch')
    }
  })

  it('rejects when issuer is not in the trust anchor allowlist', () => {
    const env = makeEnvelope({ iss: 'https://attacker.example/issuer' })
    const result = verifyTenantEnvelope(env, {
      trustedIssuers: [ISSUER],
      workerOrg: 'org-A',
      hmacKey: HMAC_KEY,
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.reason).toBe('jwt-issuer-untrusted')
    }
  })

  it('rejects an envelope where outer org disagrees with the JWT org claim', () => {
    const env = makeEnvelope({ org: 'org-A' }, 'org-B')
    const result = verifyTenantEnvelope(env, {
      trustedIssuers: [ISSUER],
      workerOrg: 'org-A',
      hmacKey: HMAC_KEY,
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.reason).toBe('envelope-org-mismatch')
    }
  })

  it('rejects an expired token (with default 60s clock skew)', () => {
    const past = Math.floor(Date.now() / 1000) - 3_600
    const env = makeEnvelope({ exp: past })
    const result = verifyTenantEnvelope(env, {
      trustedIssuers: [ISSUER],
      workerOrg: 'org-A',
      hmacKey: HMAC_KEY,
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.reason).toBe('jwt-expired')
    }
  })

  it('rejects when the JWT has no org claim', () => {
    const claims: TenantJwtClaims = {
      org: '',
      iss: ISSUER,
      iat: Math.floor(Date.now() / 1000),
    }
    const jwt = _mintHS256(claims, HMAC_KEY)
    const env: TenantEnvelope = { jwt, org: '' }
    const result = verifyTenantEnvelope(env, {
      trustedIssuers: [ISSUER],
      workerOrg: 'org-A',
      hmacKey: HMAC_KEY,
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.reason).toBe('jwt-org-claim-missing')
    }
  })

  it('rejects an unsupported alg', () => {
    // Mint a real HS256 token, then swap the header to advertise an
    // unsupported alg.  The signature won't verify, but alg-check fires
    // first and is the surface we want to assert on.
    const realToken = _mintHS256(
      { org: 'org-A', iss: ISSUER, iat: Math.floor(Date.now() / 1000) },
      HMAC_KEY,
    )
    const [, payloadB64, sigB64] = realToken.split('.')
    const headerBad = { alg: 'PS512', typ: 'JWT' }
    const headerB64 = Buffer.from(JSON.stringify(headerBad), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '')
    const jwt = `${headerB64}.${payloadB64}.${sigB64}`
    const env: TenantEnvelope = { jwt, org: 'org-A' }
    const result = verifyTenantEnvelope(env, {
      trustedIssuers: [ISSUER],
      workerOrg: 'org-A',
      hmacKey: HMAC_KEY,
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.reason).toBe('jwt-unsupported-alg')
    }
  })

  it('rejects malformed input', () => {
    const env: TenantEnvelope = { jwt: 'not-a-jwt', org: 'org-A' }
    const result = verifyTenantEnvelope(env, {
      trustedIssuers: [ISSUER],
      workerOrg: 'org-A',
      hmacKey: HMAC_KEY,
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.reason).toBe('jwt-malformed')
    }
  })

  it('honours the clock skew option for near-expiry tokens', () => {
    const expSlightlyPast = Math.floor(Date.now() / 1000) - 30
    const env = makeEnvelope({ exp: expSlightlyPast })
    const result = verifyTenantEnvelope(env, {
      trustedIssuers: [ISSUER],
      workerOrg: 'org-A',
      hmacKey: HMAC_KEY,
      clockSkewSeconds: 60,
    })
    // 30s ago + 60s skew → still valid
    expect(result.valid).toBe(true)
  })

  it('verifies an RS256 token using a PEM public key from the trust anchor', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
    })
    const pemPub = publicKey.export({ type: 'spki', format: 'pem' }).toString()

    const header = { alg: 'RS256', typ: 'JWT' }
    const payload: TenantJwtClaims = {
      org: 'org-A',
      iss: ISSUER,
      iat: Math.floor(Date.now() / 1000),
    }
    const headerB64 = Buffer.from(JSON.stringify(header), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '')
    const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '')
    const signingInput = `${headerB64}.${payloadB64}`
    const signer = crypto.createSign('RSA-SHA256')
    signer.update(signingInput)
    signer.end()
    const sig = signer
      .sign(privateKey)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '')

    const env: TenantEnvelope = {
      jwt: `${signingInput}.${sig}`,
      org: 'org-A',
    }

    const result = verifyTenantEnvelope(env, {
      trustedIssuers: [ISSUER],
      workerOrg: 'org-A',
      issuerPublicKeys: { [ISSUER]: pemPub },
    })
    expect(result.valid).toBe(true)
  })

  it('rejects RS256 when no PEM is registered for the issuer', () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    const header = { alg: 'RS256', typ: 'JWT' }
    const payload: TenantJwtClaims = {
      org: 'org-A',
      iss: ISSUER,
      iat: Math.floor(Date.now() / 1000),
    }
    const headerB64 = Buffer.from(JSON.stringify(header), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '')
    const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '')
    const signingInput = `${headerB64}.${payloadB64}`
    const signer = crypto.createSign('RSA-SHA256')
    signer.update(signingInput)
    signer.end()
    const sig = signer
      .sign(privateKey)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '')

    const env: TenantEnvelope = {
      jwt: `${signingInput}.${sig}`,
      org: 'org-A',
    }

    const result = verifyTenantEnvelope(env, {
      trustedIssuers: [ISSUER],
      workerOrg: 'org-A',
      // intentionally no issuerPublicKeys
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.reason).toBe('jwt-signature-invalid')
    }
  })
})
