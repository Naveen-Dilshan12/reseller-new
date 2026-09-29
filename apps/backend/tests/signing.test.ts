import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { signRequest, verifyWebhookSignature } from '../src/modules/integrations/signing'

describe('SaaS Integration Signing & Webhook Verification', () => {
  const secret = 'super-secret-key-32-chars-long-12345'

  it('should sign outbound partner API requests correctly', () => {
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const signature = signRequest(secret, 'POST', '/partner/v1/tenants', '{"name":"Test"}', timestamp)

    assert.ok(signature.startsWith('sha256='))
    assert.equal(signature.length, 7 + 64)
  })

  it('should verify valid webhook signature within tolerance window', () => {
    const now = Math.floor(Date.now() / 1000)
    const timestamp = now.toString()
    const rawBody = JSON.stringify({ event: 'SUBSCRIPTION_PAID', tenantId: 't-123' })
    const { hmacSha256 } = require('../src/utils/crypto')
    const validSignature = `sha256=${hmacSha256(secret, `${timestamp}.${rawBody}`)}`

    const isValid = verifyWebhookSignature(secret, rawBody, timestamp, validSignature)
    assert.equal(isValid, true)
  })

  it('should reject webhook with incorrect signature', () => {
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const rawBody = JSON.stringify({ event: 'SUBSCRIPTION_PAID' })

    const isValid = verifyWebhookSignature(secret, rawBody, timestamp, 'sha256=invalid-signature-12345')
    assert.equal(isValid, false)
  })

  it('should reject webhook with timestamp outside tolerance window', () => {
    // 10 minutes in the past (tolerance is 300s = 5m)
    const oldTimestamp = (Math.floor(Date.now() / 1000) - 600).toString()
    const rawBody = JSON.stringify({ event: 'TEST' })
    const { hmacSha256 } = require('../src/utils/crypto')
    const signature = `sha256=${hmacSha256(secret, `${oldTimestamp}.${rawBody}`)}`

    const isValid = verifyWebhookSignature(secret, rawBody, oldTimestamp, signature)
    assert.equal(isValid, false)
  })

  it('should reject webhook when timestamp or signature is missing', () => {
    assert.equal(verifyWebhookSignature(secret, '{}', undefined, 'sig'), false)
    assert.equal(verifyWebhookSignature(secret, '{}', '12345', undefined), false)
  })
})
