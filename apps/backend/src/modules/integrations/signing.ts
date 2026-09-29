import { env } from '../../config/env'
import { hmacSha256, safeEqual } from '../../utils/crypto'

export const TIMESTAMP_HEADER = 'x-hexalyte-timestamp'
export const SIGNATURE_HEADER = 'x-hexalyte-signature'

/** Signature for outbound requests: HMAC-SHA256 over `timestamp.METHOD.path.body`. */
export function signRequest(secret: string, method: string, path: string, body: string, timestamp: string): string {
  return `sha256=${hmacSha256(secret, `${timestamp}.${method.toUpperCase()}.${path}.${body}`)}`
}

/** Verifies an inbound webhook signed as HMAC-SHA256 over `timestamp.rawBody`. */
export function verifyWebhookSignature(secret: string, rawBody: string, timestamp: string | undefined, signature: string | undefined): boolean {
  if (!timestamp || !signature) return false
  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return false
  if (Math.abs(Date.now() / 1000 - ts) > env.WEBHOOK_TOLERANCE_SECONDS) return false
  return safeEqual(`sha256=${hmacSha256(secret, `${timestamp}.${rawBody}`)}`, signature)
}
