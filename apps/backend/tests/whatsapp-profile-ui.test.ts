import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, '../../web/src/app/profile/page.tsx'), 'utf8')
const i18n = readFileSync(join(__dirname, '../../web/src/lib/i18n.tsx'), 'utf8')

describe('Profile → WhatsApp Number section', () => {
  it('says Partner account, never seller account', () => {
    assert.doesNotMatch(src, /seller account/i)
    assert.match(src, /stored on your Partner account/)
    assert.doesNotMatch(i18n, /seller account/i)
  })

  it('shows the format warning only through the field error, set only by failed validation', () => {
    assert.match(src, /error=\{fieldError \?\? undefined\}/)
    assert.match(src, /if \(!toWhatsAppNumber\(value\)\) \{\s*setFieldError\(PHONE_INVALID\)/)
    assert.doesNotMatch(src, /setError\(COUNTRY_CODE_HINT\)/, 'format hint is no longer a permanent/duplicated alert')
    assert.match(src, /if \(fieldError\) setFieldError\(null\)/, 'clears while typing')
  })

  it('has a single concise example under the input', () => {
    assert.equal(src.match(/e\.g\. 0771234567 or \+94771234567/g)!.length, 2, 'one hint + one validation message')
    assert.match(src, /hint=\{PHONE_EXAMPLE\}/)
    assert.doesNotMatch(src, /COUNTRY_CODE_HINT/)
  })

  it('uses the shared validator that accepts local numbers (+94 auto-added)', () => {
    assert.match(src, /from '@\/lib\/whatsapp'/)
    assert.doesNotMatch(src, /looksInternational/)
  })

  it('labels the save button correctly', () => {
    assert.match(src, /'Save WhatsApp Number'/)
    assert.doesNotMatch(src, /Link Number/)
  })
})
