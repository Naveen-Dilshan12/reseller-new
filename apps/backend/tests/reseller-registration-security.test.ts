import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { disposableDatabaseUrl } from './helpers/disposable-database'
import { pinVerificationCutoff } from './helpers/verification-cutoff'

/**
 * Regression tests for C1 (public reseller-registration account takeover).
 *
 * These hit the *real* Express app and the *real* resellerRegistrationService
 * over HTTP, against a disposable, already-migrated Postgres database — the
 * same convention `scripts/e2e-flow.ts` uses. They are intentionally NOT part
 * of the default `npm test` run against an in-memory/no-DB setup: they are
 * skipped (not failed) unless `E2E_DATABASE_URL` is set.
 *
 *   E2E_DATABASE_URL=postgresql://... npx tsx --test tests/reseller-registration-security.test.ts
 *
 * Never point this at a real/shared database: it creates and deletes users
 * and resellers.
 */

const DB = disposableDatabaseUrl()

describe('Reseller registration account-takeover regression (C1)', () => {
  if (!DB) {
    it(
      'skipped: set E2E_DATABASE_URL to a disposable, already-migrated Postgres database to run this suite',
      { skip: true },
      () => {},
    )
    return
  }

  type PrismaModule = typeof import('../src/config/database')
  type PasswordModule = typeof import('../src/utils/password')

  let prisma: PrismaModule['prisma']
  let hashPassword: PasswordModule['hashPassword']
  let server: http.Server
  let baseUrl: string

  const run = crypto.randomUUID().slice(0, 8)
  const admin = { email: `sec-admin-${run}@test.hexalyte.invalid`, password: 'OriginalAdminPass1' }
  const seller = { email: `sec-seller-${run}@test.hexalyte.invalid`, password: 'OriginalSellerPass1' }
  const victim = { email: `sec-victim-${run}@test.hexalyte.invalid`, password: 'OriginalVictimPass1' }
  const crossAttacker = { email: `sec-cross-${run}@test.hexalyte.invalid`, password: 'OriginalCrossPass1' }

  const createdUserIds: string[] = []
  const createdResellerIds: string[] = []

  function uniqueNic(): string {
    // 9 digits + V, matching the (old-style) NIC pattern.
    const digits = Math.floor(900000000 + Math.random() * 99999999).toString()
    return `${digits}V`
  }

  /** A fully valid registerResellerSchema payload, overridable per scenario. */
  function applicationPayload(overrides: Record<string, unknown> = {}) {
    const suffix = crypto.randomUUID().slice(0, 8)
    return {
      personal: {
        fullName: 'Test Applicant',
        nicOrPassport: uniqueNic(),
        email: `applicant-${suffix}@test.hexalyte.invalid`,
        mobile: '0771234567',
        address: '123 Test Road, Colombo',
      },
      business: {
        businessName: `Test Business ${suffix}`,
        businessRegistrationNo: `PV ${suffix.toUpperCase()}`,
        businessAddress: '456 Business Road, Colombo',
        businessPhone: '0112345678',
        businessEmail: `business-${suffix}@test.hexalyte.invalid`,
      },
      bank: {
        bankName: 'Test Bank',
        branch: 'Colombo',
        accountHolderName: 'Test Applicant',
        accountNumber: '1234567890',
      },
      acceptTerms: true,
      ...overrides,
    }
  }

  async function post(path: string, body: unknown, accessToken?: string) {
    const res = await fetch(`${baseUrl}/api/v1${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => null)) as any
    return { status: res.status, json }
  }

  async function login(email: string, password: string) {
    const { status, json } = await post('/auth/login', { email, password })
    return { status, accessToken: json?.data?.accessToken as string | undefined, json }
  }

  before(async () => {
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxr-sec-test-uploads-'))
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: DB,
      JWT_ACCESS_SECRET: crypto.randomBytes(32).toString('hex'),
      ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
      UPLOAD_DIR: uploadDir,
      MAX_UPLOAD_MB: '5',
      INTEGRATION_TIMEOUT_MS: '1000',
      CORS_ORIGINS: 'http://localhost:3000',
      COMPANY_BANK_DETAILS: 'Test Bank | 000111222',
    })

    // "A brand-new account must verify before login" is asserted below: pin the cutoff instead of relying on the shipped launch value.
    pinVerificationCutoff()
    const { default: app } = await import('../src/app')
    ;({ prisma } = await import('../src/config/database'))
    ;({ hashPassword } = await import('../src/utils/password'))

    const [adminHash, sellerHash, victimHash, crossHash] = await Promise.all([
      hashPassword(admin.password),
      hashPassword(seller.password),
      hashPassword(victim.password),
      hashPassword(crossAttacker.password),
    ])

    const [adminUser, sellerUser, victimUser, crossUser] = await Promise.all([
      prisma.user.create({
        data: { email: admin.email, name: 'Security Test Admin', passwordHash: adminHash, role: 'ADMIN', status: 'ACTIVE' },
      }),
      prisma.user.create({
        data: {
          email: seller.email,
          name: 'Security Test Seller',
          passwordHash: sellerHash,
          role: 'SELLER',
          status: 'ACTIVE',
          emailVerified: new Date(),
        },
      }),
      prisma.user.create({
        data: {
          email: victim.email,
          name: 'Security Test Victim',
          passwordHash: victimHash,
          role: 'SELLER',
          status: 'ACTIVE',
          emailVerified: new Date(),
        },
      }),
      prisma.user.create({
        data: {
          email: crossAttacker.email,
          name: 'Security Test Cross Attacker',
          passwordHash: crossHash,
          role: 'SELLER',
          status: 'ACTIVE',
          emailVerified: new Date(),
        },
      }),
    ])
    createdUserIds.push(adminUser.id, sellerUser.id, victimUser.id, crossUser.id)

    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${port}`
  })

  after(async () => {
    server?.close()
    if (!prisma) return
    if (createdUserIds.length) {
      // Detach users from any reseller before the reseller rows are removed.
      await prisma.user.updateMany({ where: { id: { in: createdUserIds } }, data: { resellerId: null } }).catch(() => undefined)
    }
    if (createdResellerIds.length) {
      await prisma.reseller.deleteMany({ where: { id: { in: createdResellerIds } } }).catch(() => undefined)
    }
    if (createdUserIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => undefined)
    }
    await prisma.$disconnect()
  })

  it('unauthenticated: submitting an existing ADMIN email is rejected and the admin account is untouched', async () => {
    const { status, json } = await post('/reseller-registration', applicationPayload({ personal: { ...applicationPayload().personal, email: admin.email } }))
    assert.equal(status, 409)
    assert.equal(json?.success, false)

    const row = await prisma.user.findUniqueOrThrow({ where: { email: admin.email } })
    assert.equal(row.role, 'ADMIN')
    assert.equal(row.resellerId, null)

    const stillWorks = await login(admin.email, admin.password)
    assert.equal(stillWorks.status, 200, 'the admin password must still be the original one')
  })

  it('authenticated: a logged-in ADMIN cannot self-link (submitting their own email) and is not demoted to SELLER', async () => {
    const session = await login(admin.email, admin.password)
    assert.equal(session.status, 200)
    assert.ok(session.accessToken)

    const payload = applicationPayload({ personal: { ...applicationPayload().personal, email: admin.email } })
    const { status, json } = await post('/reseller-registration', payload, session.accessToken)
    assert.equal(status, 409, JSON.stringify(json))
    assert.equal(json?.success, false)

    const row = await prisma.user.findUniqueOrThrow({ where: { email: admin.email } })
    assert.equal(row.role, 'ADMIN', 'an ADMIN must never be converted to SELLER by this endpoint')
    assert.equal(row.resellerId, null, 'an ADMIN must never end up linked to a reseller application')

    const stillWorks = await login(admin.email, admin.password)
    assert.equal(stillWorks.status, 200, 'the admin password must still be the original one')
  })

  it('authenticated: a logged-in ADMIN cannot create a reseller application under a different (brand-new) email either', async () => {
    const session = await login(admin.email, admin.password)
    assert.equal(session.status, 200)
    assert.ok(session.accessToken)

    const untouchedEmail = `admin-attempt-${run}@test.hexalyte.invalid`
    const payload = applicationPayload({
      personal: { ...applicationPayload().personal, email: untouchedEmail },
      password: 'ShouldNeverBeUsedPass1',
      confirmPassword: 'ShouldNeverBeUsedPass1',
    })
    const { status, json } = await post('/reseller-registration', payload, session.accessToken)
    assert.equal(status, 409, JSON.stringify(json))
    assert.equal(json?.success, false)

    const adminRow = await prisma.user.findUniqueOrThrow({ where: { email: admin.email } })
    assert.equal(adminRow.role, 'ADMIN')
    assert.equal(adminRow.resellerId, null)

    const noUserCreated = await prisma.user.findUnique({ where: { email: untouchedEmail } })
    assert.equal(noUserCreated, null, 'no new user/reseller may be created from an authenticated platform session')
  })

  it('unauthenticated: submitting an existing (non-reseller) SELLER email is rejected and the account is untouched', async () => {
    const { status, json } = await post('/reseller-registration', applicationPayload({ personal: { ...applicationPayload().personal, email: seller.email } }))
    assert.equal(status, 409)
    assert.equal(json?.success, false)

    const row = await prisma.user.findUniqueOrThrow({ where: { email: seller.email } })
    assert.equal(row.role, 'SELLER')
    assert.equal(row.resellerId, null)

    const stillWorks = await login(seller.email, seller.password)
    assert.equal(stillWorks.status, 200, 'the seller password must still be the original one')
  })

  it('authenticated: a logged-in SELLER can link a reseller application to their own account', async () => {
    const session = await login(seller.email, seller.password)
    assert.equal(session.status, 200)
    assert.ok(session.accessToken)

    const newPassword = 'BrandNewSellerPass1'
    const payload = applicationPayload({
      personal: { ...applicationPayload().personal, email: seller.email },
      password: newPassword,
      confirmPassword: newPassword,
    })
    const { status, json } = await post('/reseller-registration', payload, session.accessToken)
    assert.equal(status, 201, JSON.stringify(json))
    createdResellerIds.push(json.data.applicationId)

    const row = await prisma.user.findUniqueOrThrow({ where: { email: seller.email } })
    assert.equal(row.resellerId, json.data.applicationId)

    const oldPasswordRejected = await login(seller.email, seller.password)
    assert.equal(oldPasswordRejected.status, 401, 'the old password must stop working once changed')
    const newPasswordWorks = await login(seller.email, newPassword)
    assert.equal(newPasswordWorks.status, 200, 'the new password set during the application must work')

    // Keep `seller` usable as "original password" in later assertions is not needed again.
  })

  it('authenticated: a logged-in user cannot use someone else\'s email to hijack that account', async () => {
    const session = await login(crossAttacker.email, crossAttacker.password)
    assert.equal(session.status, 200)
    assert.ok(session.accessToken)

    const payload = applicationPayload({ personal: { ...applicationPayload().personal, email: victim.email } })
    const { status, json } = await post('/reseller-registration', payload, session.accessToken)
    assert.equal(status, 409, JSON.stringify(json))
    assert.equal(json?.success, false)

    const victimRow = await prisma.user.findUniqueOrThrow({ where: { email: victim.email } })
    assert.equal(victimRow.resellerId, null)
    assert.equal(victimRow.role, 'SELLER')

    const victimLoginStillWorks = await login(victim.email, victim.password)
    assert.equal(victimLoginStillWorks.status, 200, "the victim's original password must still work")

    const attackerRow = await prisma.user.findUniqueOrThrow({ where: { email: crossAttacker.email } })
    assert.equal(attackerRow.resellerId, null, "the attacker's own account must not have been linked either")
  })

  it('unauthenticated: a genuinely new applicant (brand-new email) can still register', async () => {
    const newEmail = `brand-new-${run}@test.hexalyte.invalid`
    const newPassword = 'BrandNewApplicantPass1'
    const payload = applicationPayload({
      personal: { ...applicationPayload().personal, email: newEmail },
      password: newPassword,
      confirmPassword: newPassword,
    })
    const { status, json } = await post('/reseller-registration', payload)
    assert.equal(status, 201, JSON.stringify(json))
    createdResellerIds.push(json.data.applicationId)

    const row = await prisma.user.findUniqueOrThrow({ where: { email: newEmail } })
    createdUserIds.push(row.id)
    assert.equal(row.resellerId, json.data.applicationId)

    // A brand-new account is not yet email-verified (same OTP gate as /auth/register),
    // so it must be rejected at login until verification completes, not allowed through.
    const loginBeforeVerification = await login(newEmail, newPassword)
    assert.equal(loginBeforeVerification.status, 403, JSON.stringify(loginBeforeVerification.json))
    assert.equal(loginBeforeVerification.json?.code, 'EMAIL_NOT_VERIFIED')
  })

  it('duplicate NIC/business-registration-number is still rejected (unaffected by the fix)', async () => {
    const first = applicationPayload({ password: 'FirstApplicantPass1', confirmPassword: 'FirstApplicantPass1' })
    const firstRes = await post('/reseller-registration', first)
    assert.equal(firstRes.status, 201, JSON.stringify(firstRes.json))
    createdResellerIds.push(firstRes.json.data.applicationId)
    const firstUser = await prisma.user.findUniqueOrThrow({ where: { email: firstRes.json.data.email } })
    createdUserIds.push(firstUser.id)

    const dupNic = applicationPayload({
      personal: { ...applicationPayload().personal, nicOrPassport: first.personal.nicOrPassport },
      password: 'SecondApplicantPass1',
      confirmPassword: 'SecondApplicantPass1',
    })
    const dupRes = await post('/reseller-registration', dupNic)
    assert.equal(dupRes.status, 409)
  })
})
