import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  encryptSecret,
  decryptSecret,
  encryptBuffer,
  decryptBuffer,
  sha256,
  randomToken,
  hmacSha256,
  safeEqual,
} from '../src/utils/crypto'

describe('Crypto Utilities', () => {
  it('should encrypt and decrypt a string secret correctly', () => {
    const secret = 'my-super-secret-api-key-12345!@#'
    const encrypted = encryptSecret(secret)

    assert.notEqual(encrypted, secret)
    assert.match(encrypted, /^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/)

    const decrypted = decryptSecret(encrypted)
    assert.equal(decrypted, secret)
  })

  it('should encrypt and decrypt binary buffers correctly', () => {
    const buffer = Buffer.from('PDF or Image file content dummy bytes 0123456789')
    const encrypted = encryptBuffer(buffer)

    assert.notEqual(encrypted.length, buffer.length)
    // 12 bytes IV + 16 bytes tag + ciphertext
    assert.equal(encrypted.length, 12 + 16 + buffer.length)

    const decrypted = decryptBuffer(encrypted)
    assert.deepEqual(decrypted, buffer)
  })

  it('should compute consistent SHA-256 hashes', () => {
    const hash1 = sha256('hello-world')
    const hash2 = sha256('hello-world')
    const hash3 = sha256('different')

    assert.equal(hash1, hash2)
    assert.notEqual(hash1, hash3)
    assert.equal(hash1.length, 64)
  })

  it('should generate URL-safe random tokens', () => {
    const token1 = randomToken(32)
    const token2 = randomToken(32)

    assert.notEqual(token1, token2)
    assert.match(token1, /^[A-Za-z0-9_-]+$/)
  })

  it('should compute HMAC-SHA256 signatures correctly', () => {
    const key = 'secret-key-123'
    const msg = 'GET./partner/v1/health.'
    const sig1 = hmacSha256(key, msg)
    const sig2 = hmacSha256(key, msg)
    const sigDifferent = hmacSha256('other-key', msg)

    assert.equal(sig1, sig2)
    assert.notEqual(sig1, sigDifferent)
  })

  it('should safely compare strings in constant time', () => {
    assert.equal(safeEqual('abc', 'abc'), true)
    assert.equal(safeEqual('abc', 'abd'), false)
    assert.equal(safeEqual('abc', 'abcd'), false)
  })
})
