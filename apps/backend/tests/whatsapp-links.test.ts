import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildWhatsAppUrl, customerGreeting, toWhatsAppNumber } from '../../web/src/lib/whatsapp'

const web = (p: string) => readFileSync(join(__dirname, '../../web/src', p), 'utf8')

describe('WhatsApp number normalisation', () => {
  it('converts local Sri Lankan and international formats to digits with country code', () => {
    assert.equal(toWhatsAppNumber('0771234567'), '94771234567')
    assert.equal(toWhatsAppNumber('077 123 4567'), '94771234567')
    assert.equal(toWhatsAppNumber('771234567'), '94771234567')
    assert.equal(toWhatsAppNumber('+94 77-123-4567'), '94771234567')
    assert.equal(toWhatsAppNumber('0094771234567'), '94771234567')
    assert.equal(toWhatsAppNumber('+44 7911 123456'), '447911123456')
  })

  it('rejects missing, malformed and non-mobile numbers', () => {
    for (const bad of [null, undefined, '', '   ', 'abc', '77 ABC 4567', '+0771234567', '+9477', '+1234567890123456', '0112345678']) {
      assert.equal(toWhatsAppNumber(bad), null, String(bad))
    }
  })
})

describe('WhatsApp URL', () => {
  it('builds a wa.me link without a message', () => {
    assert.equal(buildWhatsAppUrl('0771234567'), 'https://wa.me/94771234567')
    assert.equal(buildWhatsAppUrl('0771234567', '   '), 'https://wa.me/94771234567')
  })

  it('URL-encodes the prefilled message', () => {
    const url = buildWhatsAppUrl('+94771234567', 'Hi & welcome!\nA+B 100%')
    assert.equal(url, 'https://wa.me/94771234567?text=Hi%20%26%20welcome!%0AA%2BB%20100%25')
    assert.equal(new URL(url!).searchParams.get('text'), 'Hi & welcome!\nA+B 100%')
  })

  it('returns null (no broken link) for invalid numbers', () => {
    assert.equal(buildWhatsAppUrl('12345', 'hello'), null)
    assert.equal(buildWhatsAppUrl(null, 'hello'), null)
  })

  it('greeting names the customer and optionally the partner', () => {
    assert.match(customerGreeting('Nimal'), /^Hello Nimal,/)
    assert.match(customerGreeting('Nimal', 'Kasun'), /This is Kasun from Hexalyte/)
  })
})

describe('WhatsApp UI wiring', () => {
  it('demo request detail only renders the action for a valid number, opening safely', () => {
    const src = web('app/demo-requests/[id]/page.tsx')
    assert.match(src, /buildWhatsAppUrl\(item\.contactPhone, customerGreeting\(item\.contactName\)\)/)
    assert.match(src, /url \? \(/)
    assert.match(src, /rel="noopener noreferrer"/)
    assert.match(src, /No valid WhatsApp number on file/)
  })

  it('trial hand-off uses the shared helper and hides the button when invalid', () => {
    const src = web('app/trials/new/page.tsx')
    assert.match(src, /buildWhatsAppUrl\(shop\.phone, welcomeMessage\)/)
    assert.match(src, /whatsappLink \? \(/)
    assert.doesNotMatch(src, /wa\.me/)
  })
})

describe('Partner terminology (user-facing only)', () => {
  it('uses Partner in labels and translations', () => {
    const i18n = web('lib/i18n.tsx')
    assert.match(i18n, /'brand\.subtitle': 'Partner Console'/)
    assert.match(i18n, /'dash\.becomeReseller': 'Become a Partner'/)
    assert.doesNotMatch(i18n, /ප්‍රතිවිකුණුම්/)
    assert.match(web('app/admin/layout.tsx'), /label: 'Partners', permission: 'resellers:read'/)
  })

  it('keeps technical identifiers and routes unchanged', () => {
    assert.match(web('app/admin/layout.tsx'), /href: '\/admin\/resellers'/)
    assert.match(web('app/dashboard/become-reseller/page.tsx'), /'\/reseller-registration'/)
    assert.match(web('lib/i18n.tsx'), /'dash\.becomeReseller'/)
  })
})
