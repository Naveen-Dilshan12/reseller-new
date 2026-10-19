import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeInternationalPhone } from '../src/utils/phone'
import { whatsappNumberSchema } from '../src/modules/auth/auth.schema'

describe('International phone numbers (Seller WhatsApp number)', () => {
  it('accepts numbers with a country code and normalises separators to +<digits>', () => {
    assert.equal(normalizeInternationalPhone('+94 77 123 4567'), '+94771234567')
    assert.equal(normalizeInternationalPhone('0094771234567'), '+94771234567')
    assert.equal(normalizeInternationalPhone('+94-(77)-123-4567'), '+94771234567')
    assert.equal(normalizeInternationalPhone('+44 7911 123456'), '+447911123456')
    assert.equal(normalizeInternationalPhone('+1 202 555 0143'), '+12025550143')
    assert.equal(normalizeInternationalPhone('+971 50 123 4567'), '+971501234567')
  })

  it('adds +94 when no country code is given (local format)', () => {
    assert.equal(normalizeInternationalPhone('0771234567'), '+94771234567')
    assert.equal(normalizeInternationalPhone('077 123 4567'), '+94771234567')
    assert.equal(normalizeInternationalPhone('771234567'), '+94771234567')
    assert.equal(normalizeInternationalPhone('0112345678'), null, 'landline')
  })

  it('rejects an unassigned country code, wrong lengths, letters and empty input', () => {
    assert.equal(normalizeInternationalPhone('+999 1234 5678'), null)
    assert.equal(normalizeInternationalPhone('+0 1234 5678 90'), null)
    assert.equal(normalizeInternationalPhone('+94771'), null, 'too short')
    assert.equal(normalizeInternationalPhone('+1234567890123456'), null, 'more than 15 digits')
    assert.equal(normalizeInternationalPhone('+94 77 ABC 4567'), null)
    assert.equal(normalizeInternationalPhone('   '), null)
  })

  it('requires a Sri Lankan (+94) number to be a mobile number', () => {
    assert.equal(normalizeInternationalPhone('+94112345678'), null, 'Colombo landline')
    assert.equal(normalizeInternationalPhone('+9477123456'), null, 'one digit short')
    assert.equal(normalizeInternationalPhone('+94771234567'), '+94771234567')
  })

  it('whatsappNumberSchema returns the canonical number and rejects bad input and extra fields', () => {
    const ok = whatsappNumberSchema.safeParse({ whatsappNumber: ' +94 77 123 4567 ' })
    assert.equal(ok.success, true)
    if (ok.success) assert.equal(ok.data.whatsappNumber, '+94771234567')

    assert.equal(whatsappNumberSchema.safeParse({ whatsappNumber: '0771234567' }).success, true)
    assert.equal(whatsappNumberSchema.safeParse({}).success, false)
    assert.equal(whatsappNumberSchema.safeParse({ whatsappNumber: '+94771234567', password: 'x' }).success, false, 'no credential-like fields')
  })
})
