import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { disposableDatabaseUrl } from './helpers/disposable-database'

/**
 * Reseller onboarding lifecycle against the real Express app and a disposable, already-migrated
 * Postgres database: first login (welcome marker) → application submitted (PENDING) → Admin
 * approves / rejects → what a seller may call at each stage. Skipped unless E2E_DATABASE_URL is set.
 *
 *   E2E_DATABASE_URL=postgresql://... npx tsx --test tests/reseller-approval-flow.test.ts
 *
 * Never point this at a real/shared database: it creates and deletes users and resellers.
 */

const DB = disposableDatabaseUrl()

describe('Reseller onboarding lifecycle: welcome marker, pending, approval gate', () => {
  if (!DB) {
    it('skipped: set E2E_DATABASE_URL to a disposable, already-migrated Postgres database to run this suite', { skip: true }, () => {})
    return
  }

  type PrismaModule = typeof import('../src/config/database')
  let prisma: PrismaModule['prisma']
  let signAccessToken: typeof import('../src/utils/jwt')['signAccessToken']
  let server: http.Server
  let baseUrl: string

  const run = crypto.randomUUID().slice(0, 8)
  const admin = { email: `flow-admin-${run}@test.hexalyte.invalid`, password: 'FlowAdminPass1' }
  const approvedSeller = { email: `flow-ok-${run}@test.hexalyte.invalid`, password: 'FlowSellerPass1' }
  const rejectedSeller = { email: `flow-no-${run}@test.hexalyte.invalid`, password: 'FlowSellerPass2' }
  const createdUserIds: string[] = []
  const createdResellerIds: string[] = []
  let approvedId = ''
  let rejectedId = ''

  function payload(email: string) {
    const suffix = crypto.randomUUID().slice(0, 8)
    return {
      personal: { fullName: 'Flow Applicant', nicOrPassport: `${Math.floor(900000000 + Math.random() * 99999999)}V`, email, mobile: '0771234567', address: '123 Test Road, Colombo' },
      business: { businessName: `Flow Business ${suffix}`, businessRegistrationNo: `PV ${suffix.toUpperCase()}`, businessAddress: '456 Business Road, Colombo', businessPhone: '0112345678', businessEmail: `biz-${suffix}@test.hexalyte.invalid` },
      bank: { bankName: 'Test Bank', branch: 'Colombo', accountHolderName: 'Flow Applicant', accountNumber: '1234567890' },
      acceptTerms: true,
    }
  }

  async function call(method: string, path: string, body?: unknown, accessToken?: string) {
    const res = await fetch(`${baseUrl}/api/v1${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: res.status, json: (await res.json().catch(() => null)) as any }
  }
  const get = (p: string, t?: string) => call('GET', p, undefined, t)
  const post = (p: string, b: unknown, t?: string) => call('POST', p, b, t)
  async function login(email: string, password: string) {
    const r = await post('/auth/login', { email, password })
    return r.json?.data?.accessToken as string
  }

  /** Every permissioned seller API a not-yet-approved seller must be refused on. */
  const PROTECTED_READS = ['/products', '/customers', '/dashboard/reseller', '/commissions/summary', '/activation-requests', '/demo-requests', '/trials']
  async function assertRefused(token: string, label: string) {
    for (const p of PROTECTED_READS) {
      const r = await get(p, token)
      assert.equal(r.status, 403, `${label}: GET ${p} must be refused (got ${r.status})`)
      assert.match(r.json?.message ?? '', /must be approved/i, `${label}: GET ${p}`)
    }
    const create = await post('/demo-requests', { productId: 'x', businessName: 'x', contactName: 'x', contactEmail: 'x@x.test', contactPhone: '0771234567' }, token)
    assert.equal(create.status, 403, `${label}: POST /demo-requests must be refused`)
    // These only need a signed-in user and stay reachable
    assert.equal((await get('/auth/me', token)).status, 200, `${label}: /auth/me`)
    assert.equal((await get('/commissions/levels', token)).status, 200, `${label}: /commissions/levels`)
    assert.equal((await get('/notifications/unread-count', token)).status, 200, `${label}: notifications`)
  }

  before(async () => {
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxr-flow-test-uploads-'))
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
    const { default: app } = await import('../src/app')
    ;({ prisma } = await import('../src/config/database'))
    ;({ signAccessToken } = await import('../src/utils/jwt'))
    const { hashPassword } = await import('../src/utils/password')

    const mk = async (u: { email: string; password: string }, name: string, role: 'ADMIN' | 'SELLER') =>
      prisma.user.create({
        data: { email: u.email, name, passwordHash: await hashPassword(u.password), role, status: 'ACTIVE', ...(role === 'SELLER' ? { emailVerified: new Date() } : {}) },
      })
    const [a, s1, s2] = await Promise.all([mk(admin, 'Flow Admin', 'ADMIN'), mk(approvedSeller, 'Flow Seller One', 'SELLER'), mk(rejectedSeller, 'Flow Seller Two', 'SELLER')])
    createdUserIds.push(a.id, s1.id, s2.id)

    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  after(async () => {
    server?.close()
    if (!prisma) return
    await prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => undefined)
    await prisma.user.updateMany({ where: { id: { in: createdUserIds } }, data: { resellerId: null } }).catch(() => undefined)
    if (createdResellerIds.length) await prisma.reseller.deleteMany({ where: { id: { in: createdResellerIds } } }).catch(() => undefined)
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => undefined)
    await prisma.$disconnect()
  })

  it('first login: no application → no permissions, protected seller APIs refused, welcome marker stored once and remembered', async () => {
    const token = await login(approvedSeller.email, approvedSeller.password)
    const me = (await get('/auth/me', token)).json.data
    assert.equal(me.reseller, null)
    assert.deepEqual(me.permissions, [])
    assert.equal(me.welcomeSeen, false)
    await assertRefused(token, 'no application')

    // Reported twice (e.g. two tabs): still one record. A fresh login sees it.
    assert.equal((await post('/auth/me/welcome-shown', {}, token)).status, 200)
    assert.equal((await post('/auth/me/welcome-shown', {}, token)).status, 200)
    const records = await prisma.auditLog.count({ where: { action: 'RESELLER_WELCOME_SHOWN', entityType: 'User', actorEmail: approvedSeller.email } })
    assert.equal(records, 1)
    const secondLogin = await login(approvedSeller.email, approvedSeller.password)
    assert.equal((await get('/auth/me', secondLogin)).json.data.welcomeSeen, true, 'repeat login, even much later, must not show the welcome again')
  })

  it('application submitted: status is PENDING, access is still refused, and the seller cannot approve themselves', async () => {
    const token = await login(approvedSeller.email, approvedSeller.password)
    const submitted = await post('/reseller-registration', payload(approvedSeller.email), token)
    assert.equal(submitted.status, 201, JSON.stringify(submitted.json))
    approvedId = submitted.json.data.applicationId
    createdResellerIds.push(approvedId)

    const me = (await get('/auth/me', token)).json.data
    assert.equal(me.reseller.status, 'PENDING')
    assert.deepEqual(me.permissions, [])
    assert.equal(me.welcomeSeen, true, 'submitting does not bring the welcome back')
    await assertRefused(token, 'pending')

    const selfApprove = await post(`/reseller-applications/${approvedId}/approve`, {}, token)
    assert.equal(selfApprove.status, 403)
    assert.equal((await prisma.reseller.findUniqueOrThrow({ where: { id: approvedId } })).status, 'PENDING')
  })

  it('Admin approves: the same session reflects ACTIVE and gets normal access', async () => {
    const adminToken = await login(admin.email, admin.password)
    const sellerToken = await login(approvedSeller.email, approvedSeller.password)

    const list = await get('/admin/reseller-applications', adminToken)
    assert.equal(list.status, 200)
    const approved = await post(`/reseller-applications/${approvedId}/approve`, {}, adminToken)
    assert.equal(approved.status, 200, JSON.stringify(approved.json))

    const me = (await get('/auth/me', sellerToken)).json.data
    assert.equal(me.reseller.status, 'ACTIVE')
    assert.equal(me.permissions.includes('products:read'), true)
    assert.equal(me.welcomeSeen, true)
    for (const p of ['/products', '/customers', '/dashboard/reseller', '/commissions/summary', '/activation-requests', '/demo-requests']) {
      const r = await get(p, sellerToken)
      assert.equal(r.status, 200, `approved: GET ${p} must work (got ${r.status} ${r.json?.message ?? ''})`)
    }
    // Approval does not widen the role: still no admin permissions
    assert.equal((await get('/admin/settings', sellerToken)).status, 403)
    assert.equal((await post(`/reseller-applications/${approvedId}/reject`, { reason: 'Trying to reject myself' }, sellerToken)).status, 403)
  })

  it('Admin rejects a second application: that seller stays refused', async () => {
    const adminToken = await login(admin.email, admin.password)
    const token = await login(rejectedSeller.email, rejectedSeller.password)
    const submitted = await post('/reseller-registration', payload(rejectedSeller.email), token)
    assert.equal(submitted.status, 201, JSON.stringify(submitted.json))
    rejectedId = submitted.json.data.applicationId
    createdResellerIds.push(rejectedId)

    const rejected = await post(`/reseller-applications/${rejectedId}/reject`, { reason: 'Business registration could not be verified.' }, adminToken)
    assert.equal(rejected.status, 200, JSON.stringify(rejected.json))

    const me = (await get('/auth/me', token)).json.data
    assert.equal(me.reseller.status, 'REJECTED')
    assert.deepEqual(me.permissions, [])
    await assertRefused(token, 'rejected')
  })

  it('Admin functionality is unaffected', async () => {
    const adminToken = await login(admin.email, admin.password)
    const me = (await get('/auth/me', adminToken)).json.data
    assert.equal(me.permissions.includes('settings:manage'), true)
    for (const p of ['/admin/settings', '/admin/reseller-applications', '/admin/resellers', '/products', '/commissions/levels']) {
      const r = await get(p, adminToken)
      assert.equal(r.status, 200, `admin: GET ${p} (got ${r.status} ${r.json?.message ?? ''})`)
    }
  })

  it('existing approved accounts in this database keep working (read-only check)', async () => {
    const seller = await prisma.user.findFirst({
      where: { role: 'SELLER', status: 'ACTIVE', emailVerified: { not: null }, reseller: { status: 'ACTIVE' }, email: { not: { endsWith: '@test.hexalyte.invalid' } } },
      select: { id: true, email: true, role: true, resellerId: true },
    })
    const staff = await prisma.user.findFirst({
      where: { role: 'ADMIN', status: 'ACTIVE', email: { not: { endsWith: '@test.hexalyte.invalid' } } },
      select: { id: true, email: true, role: true, resellerId: true },
    })
    // Tokens are signed directly, so no login (and no write) happens on these real accounts.
    if (seller) {
      const token = signAccessToken({ userId: seller.id, email: seller.email, role: seller.role, resellerId: seller.resellerId })
      const me = (await get('/auth/me', token)).json.data
      assert.equal(me.reseller.status, 'ACTIVE')
      assert.equal(me.permissions.includes('products:read'), true, 'an already approved seller keeps its permissions')
      for (const p of ['/products', '/customers', '/dashboard/reseller', '/commissions/summary']) assert.equal((await get(p, token)).status, 200, `existing seller: GET ${p}`)
    }
    if (staff) {
      const token = signAccessToken({ userId: staff.id, email: staff.email, role: staff.role, resellerId: staff.resellerId })
      for (const p of ['/admin/settings', '/admin/reseller-applications', '/admin/resellers']) assert.equal((await get(p, token)).status, 200, `existing admin: GET ${p}`)
    }
  })
})
