import { describe, it, expect } from 'vitest'
import crypto from 'crypto'
import { verifyWebhookSignature } from '../webhook/signature.js'

function computeSignature(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex')
}

describe('verifyWebhookSignature', () => {
  const secret = 'test-webhook-secret'
  const body = '{"action":"create","type":"Issue"}'

  it('returns true for a valid HMAC-SHA256 signature', () => {
    const signature = computeSignature(body, secret)
    expect(verifyWebhookSignature(body, signature, secret)).toBe(true)
  })

  it('returns false for an invalid signature', () => {
    expect(verifyWebhookSignature(body, 'invalid-signature-value', secret)).toBe(false)
  })

  it('returns false for null signature', () => {
    expect(verifyWebhookSignature(body, null, secret)).toBe(false)
  })

  it('returns false for undefined signature', () => {
    expect(
      verifyWebhookSignature(body, undefined as unknown as null, secret)
    ).toBe(false)
  })

  it('returns false for empty body with wrong signature', () => {
    expect(verifyWebhookSignature('', 'wrong', secret)).toBe(false)
  })

  it('returns false (not throws) for different-length signature', () => {
    // timingSafeEqual throws when buffers differ in length;
    // verifyWebhookSignature should catch or avoid this and return false.
    const shortSig = 'ab'
    expect(() => verifyWebhookSignature(body, shortSig, secret)).not.toThrow()
    expect(verifyWebhookSignature(body, shortSig, secret)).toBe(false)
  })

  it('works with empty body and valid signature', () => {
    const emptyBodySig = computeSignature('', secret)
    expect(verifyWebhookSignature('', emptyBodySig, secret)).toBe(true)
  })

  it('works with Unicode body content', () => {
    const unicodeBody = '{"title":"Fix bug \u2014 handle \u00e9m\u00f6ji \ud83d\ude80"}'
    const signature = computeSignature(unicodeBody, secret)
    expect(verifyWebhookSignature(unicodeBody, signature, secret)).toBe(true)
  })
})
