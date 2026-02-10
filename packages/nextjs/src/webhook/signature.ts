/**
 * Webhook Signature Verification
 *
 * HMAC-SHA256 verification for Linear webhook signatures.
 * @see https://developers.linear.app/docs/webhooks#validating-webhooks
 */

import crypto from 'crypto'

/**
 * Verify a Linear webhook signature using HMAC-SHA256.
 *
 * @param body - Raw request body string
 * @param signature - Value of the `linear-signature` header
 * @param secret - The webhook signing secret
 * @returns true if the signature is valid
 */
export function verifyWebhookSignature(
  body: string,
  signature: string | null,
  secret: string
): boolean {
  if (!signature) return false

  const hmac = crypto.createHmac('sha256', secret)
  hmac.update(body)
  const digest = hmac.digest('hex')

  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature))
}
