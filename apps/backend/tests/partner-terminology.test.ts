import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { humanizeAction, partnerWording } from '../../web/src/lib/admin-types'

const be = (p: string) => readFileSync(join(__dirname, '..', 'src', p), 'utf8')
const web = (p: string) => readFileSync(join(__dirname, '../../web/src', p), 'utf8')

describe('Partner terminology in backend messages', () => {
  const messages: [string, string[]][] = [
    ['middleware/auth.middleware.ts', ['Your partner application must be approved', 'Partner account is suspended', 'Partner account is not active', 'approved partner account']],
    ['modules/auth/auth.service.ts', ['Your partner account is suspended']],
    ['modules/auth/verification.service.ts', ['Hexalyte Central Partner Platform']],
    ['modules/resellers/reseller-registration.service.ts', ['New partner application', 'apply to become a partner', 'Central Partner Platform']],
    ['modules/resellers/reseller-applications.service.ts', ['Your partner account ${reseller.code} is now active']],
    ['modules/resellers/admin-resellers.service.ts', ['Your partner account is active again', 'while the partner is']],
    ['modules/resellers/resellers.routes.ts', ["'Partner suspended'", "'Partner reactivated'"]],
    ['modules/settings/settings.service.ts', ['Your partner level changed', 'shown to partners']],
    ['modules/email/email.service.ts', ['Central Partner Platform', 'authorized partner']],
    ['modules/trials/trial.service.ts', ['Partner trial account limit reached']],
    ['modules/auth/auth.schema.ts', ['You must accept the partner terms']],
    ['modules/resellers/reseller.schema.ts', ['You must accept the partner terms']],
  ]
  for (const [file, needles] of messages) {
    it(`${file} says Partner to users`, () => {
      const src = be(file)
      for (const n of needles) assert.ok(src.includes(n), `${file} should contain "${n}"`)
    })
  }

  it('user-facing strings no longer say "reseller" in the changed files', () => {
    for (const [file] of messages) {
      const bad = be(file).replace(/\$\{[^}]*\}/g, '').split('\n').filter((l) => /(?:message|subject|title|body|forbidden|badRequest|conflict|sendSuccess)\b.*['"`][^'"`]*\b[Rr]esellers?\b[^'"`]*['"`]/.test(l) && !/entityType|logger/.test(l))
      assert.deepEqual(bad, [], file)
    }
  })

  it('keeps API/technical identifiers unchanged', () => {
    assert.ok(be('app.ts').includes("api.use('/admin/resellers', resellersAdminRouter)"))
    assert.ok(be('modules/auth/auth.service.ts').includes("'RESELLER_SUSPENDED'"))
    assert.ok(be('middleware/auth.middleware.ts').includes('RESELLER_APPROVAL_REQUIRED'))
    assert.ok(be('modules/resellers/reseller-applications.service.ts').includes("entityType: 'Reseller'"))
  })
})

describe('Partner wording for stored audit identifiers (web)', () => {
  it('humanises actions and entity types with Partner', () => {
    assert.equal(humanizeAction('RESELLER_APPLICATION_APPROVED'), 'Partner application approved')
    assert.equal(humanizeAction('RESELLER_LEVEL_CHANGED'), 'Partner level changed')
    assert.equal(humanizeAction('PAYMENT_VERIFIED'), 'Payment verified')
    assert.equal(partnerWording('Reseller'), 'Partner')
    assert.equal(partnerWording('Resellers'), 'Partners')
    assert.equal(partnerWording('ResellerProductAccess'), 'ResellerProductAccess', 'only whole words')
  })

  it('audit log page shows entity types through the helper', () => {
    const src = web('app/admin/audit-logs/page.tsx')
    assert.ok(src.includes('partnerWording(a.entityType)'))
    assert.ok(src.includes('partnerWording(t.value)'))
  })
})
