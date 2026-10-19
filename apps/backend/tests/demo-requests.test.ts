import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { disposableDatabaseUrl } from './helpers/disposable-database'
import { buildWhatsAppLink } from '../src/modules/demos/demo.service'
import { sanitizeInputMiddleware } from '../src/middleware/sanitization.middleware'
import {
  approveDemoSchema,
  confirmDemoSchema,
  createDemoRequestSchema,
  rejectDemoSchema,
  saveWelcomeMessageSchema,
} from '../src/modules/demos/demo.schema'

// A realistic admin-prepared message: multi-line, mixed punctuation, an em dash and emoji.
const PREPARED_MESSAGE = `Welcome to Hexalyte 🎉

Hi Nimal,

Your demo shop is ready: https://kandy-mobiles.mobileshop.hexalyte.com
Login: https://mobileshop.hexalyte.com/login (use "Forgot password" on first login)

Thank you!
— Hexalyte Team`

// ─── Pure logic: WhatsApp link, Zod validation ───────────────────────────────
// These need no database and always run.

describe('Demo request — WhatsApp link (wa.me, phone normalisation, URL encoding)', () => {
  it('normalises a local 0-prefixed Sri Lankan number to the 94 country code', () => {
    const link = buildWhatsAppLink('0771234567', 'hello')
    assert.match(link, /^https:\/\/wa\.me\/94771234567\?text=/)
  })

  it('leaves an already-international number untouched', () => {
    const link = buildWhatsAppLink('+94771234567', 'hello')
    assert.match(link, /^https:\/\/wa\.me\/94771234567\?text=/)
  })

  it('percent-encodes a multi-line message with special characters losslessly', () => {
    const link = buildWhatsAppLink('0771234567', PREPARED_MESSAGE)
    const [, query] = link.split('?text=')
    assert.equal(decodeURIComponent(query), PREPARED_MESSAGE, 'decoding the URL must reproduce the exact original message, including newlines, the em dash and emoji')
  })
})

describe('Demo request — Zod validation', () => {
  it('createDemoRequestSchema rejects a missing product/contact and accepts a valid payload', () => {
    assert.equal(
      createDemoRequestSchema.safeParse({
        businessName: 'Kandy Mobiles',
        contactName: 'Nimal Perera',
        contactEmail: 'nimal@example.test',
        contactPhone: '0771234567',
      }).success,
      false,
      'missing productId must fail',
    )
    const ok = createDemoRequestSchema.safeParse({
      productId: 'prod_1',
      businessName: 'Kandy Mobiles',
      contactName: 'Nimal Perera',
      contactEmail: 'nimal@example.test',
      contactPhone: '0771234567',
    })
    assert.equal(ok.success, true)
  })

  it('saveWelcomeMessageSchema requires a non-blank welcomeMessage and keeps it exactly as pasted', () => {
    assert.equal(saveWelcomeMessageSchema.safeParse({}).success, false, 'missing message must fail')
    assert.equal(saveWelcomeMessageSchema.safeParse({ welcomeMessage: '' }).success, false)
    assert.equal(saveWelcomeMessageSchema.safeParse({ welcomeMessage: '  \n\t ' }).success, false, 'whitespace-only must fail')
    assert.equal(saveWelcomeMessageSchema.safeParse({ welcomeMessage: 'x'.repeat(4001) }).success, false, 'over the length cap must fail')

    const ok = saveWelcomeMessageSchema.safeParse({ welcomeMessage: PREPARED_MESSAGE })
    assert.equal(ok.success, true)
    if (ok.success) assert.equal(ok.data.welcomeMessage, PREPARED_MESSAGE, 'the message must not be trimmed or rewritten')
  })

  it('the global body sanitizer leaves welcomeMessage exactly as pasted but still sanitizes other fields', () => {
    // `>`/`<`, a trailing newline and a `?connection=…&phone=…` login URL are all altered by the sanitizer.
    const message = 'Open Settings > Profile, use <your shop name>.\nSign in: https://app.example.com/login?connection=demo&phone=0771234567\n'
    const req: any = { body: { welcomeMessage: message, note: '<b>hi</b>' }, query: {}, params: {}, headers: {} }
    sanitizeInputMiddleware(req, {} as any, () => {})
    assert.equal(req.body.welcomeMessage, message, 'welcome message must reach the schema untouched')
    assert.equal(req.body.note, 'bhi/b', 'other body fields are still sanitized')
  })

  it('saveWelcomeMessageSchema rejects the removed demo-shop fields (strict)', () => {
    const legacy = saveWelcomeMessageSchema.safeParse({
      welcomeMessage: PREPARED_MESSAGE,
      shopName: 'Kandy Mobiles',
      loginUrl: 'https://mobileshop.hexalyte.com/login',
    })
    assert.equal(legacy.success, false)
  })

  it('confirmDemoSchema requires the SaaS tenant ID (needed to link the trial account)', () => {
    assert.equal(confirmDemoSchema.safeParse({}).success, false)
    assert.equal(confirmDemoSchema.safeParse({ externalTenantId: '   ' }).success, false)
    const ok = confirmDemoSchema.safeParse({ externalTenantId: ' tenant-123 ', note: 'ok' })
    assert.equal(ok.success, true)
    if (ok.success) assert.equal(ok.data.externalTenantId, 'tenant-123')
    assert.equal(confirmDemoSchema.safeParse({ externalTenantId: 'tenant-123', customerId: 'x' }).success, false, 'strict')
  })

  it('rejectDemoSchema requires a reason of at least 10 characters', () => {
    assert.equal(rejectDemoSchema.safeParse({ reason: 'too short' }).success, false)
    assert.equal(rejectDemoSchema.safeParse({ reason: 'Not a good fit for this SaaS product.' }).success, true)
  })

  it('approveDemoSchema allows an optional note only', () => {
    assert.equal(approveDemoSchema.safeParse({}).success, true)
    assert.equal(approveDemoSchema.safeParse({ note: 'Looks legitimate' }).success, true)
  })
})

// ─── Real route/service integration (needs a disposable, migrated database) ─
//
// Same convention as tests/reseller-registration-security.test.ts: skipped
// (not failed) unless E2E_DATABASE_URL points to a disposable Postgres
// database already migrated to this schema.
//
//   E2E_DATABASE_URL=postgresql://... npx tsx --test tests/demo-requests.test.ts

// This also refuses a DATABASE_URL (e.g. from .env) that differs: the imports above can already have built a client from it.
const DB = disposableDatabaseUrl()

describe('Demo request workflow — route/service integration (requires a disposable database)', () => {
  if (!DB) {
    it('skipped: set E2E_DATABASE_URL to a disposable, already-migrated Postgres database to run this suite', { skip: true }, () => {})
    return
  }

  type PrismaModule = typeof import('../src/config/database')
  type PasswordModule = typeof import('../src/utils/password')

  let prisma: PrismaModule['prisma']
  let server: http.Server
  let baseUrl: string

  const run = crypto.randomUUID().slice(0, 8)
  const admin = { email: `demo-admin-${run}@test.hexalyte.invalid`, password: 'OriginalAdminPass1' }
  const sellerA = { email: `demo-seller-a-${run}@test.hexalyte.invalid`, password: 'OriginalSellerAPass1' }
  const sellerB = { email: `demo-seller-b-${run}@test.hexalyte.invalid`, password: 'OriginalSellerBPass1' }
  const sellerPending = { email: `demo-seller-pending-${run}@test.hexalyte.invalid`, password: 'OriginalSellerPendingPass1' }
  let resellerAId = ''
  let resellerBId = ''
  let productId = ''

  const createdUserIds: string[] = []
  const createdResellerIds: string[] = []
  const createdProductIds: string[] = []
  const createdDemoIds: string[] = []

  async function post(path: string, body: unknown, accessToken?: string) {
    const res = await fetch(`${baseUrl}/api/v1${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => null)) as any
    return { status: res.status, json }
  }
  async function get(path: string, accessToken?: string) {
    const res = await fetch(`${baseUrl}/api/v1${path}`, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    })
    const json = (await res.json().catch(() => null)) as any
    return { status: res.status, json }
  }
  async function login(email: string, password: string) {
    const { status, json } = await post('/auth/login', { email, password })
    return { status, accessToken: json?.data?.accessToken as string | undefined, json }
  }

  before(async () => {
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxr-demo-test-uploads-'))
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
    const { hashPassword }: PasswordModule = await import('../src/utils/password')

    const [adminHash, sellerAHash, sellerBHash, sellerPendingHash] = await Promise.all([
      hashPassword(admin.password),
      hashPassword(sellerA.password),
      hashPassword(sellerB.password),
      hashPassword(sellerPending.password),
    ])

    const adminUser = await prisma.user.create({
      data: { email: admin.email, name: 'Demo Test Admin', passwordHash: adminHash, role: 'ADMIN', status: 'ACTIVE' },
    })
    const product = await prisma.saasProduct.create({
      data: { code: `DEMO_TEST_${run}`, name: 'Demo Test Product', status: 'ACTIVE' },
    })
    productId = product.id
    createdProductIds.push(product.id)

    const resellerA = await prisma.reseller.create({
      data: {
        code: `RS-DEMOA-${run}`,
        fullName: 'Reseller A',
        nicOrPassport: `NIC-A-${run}`,
        email: sellerA.email,
        mobile: '+94770000001',
        address: 'Colombo',
        businessName: `Reseller A Biz ${run}`,
        businessRegistrationNo: `BRN-A-${run}`,
        businessAddress: 'Colombo',
        businessPhone: '+94110000001',
        businessEmail: sellerA.email,
        status: 'ACTIVE',
      },
    })
    const resellerB = await prisma.reseller.create({
      data: {
        code: `RS-DEMOB-${run}`,
        fullName: 'Reseller B',
        nicOrPassport: `NIC-B-${run}`,
        email: sellerB.email,
        mobile: '+94770000002',
        address: 'Colombo',
        businessName: `Reseller B Biz ${run}`,
        businessRegistrationNo: `BRN-B-${run}`,
        businessAddress: 'Colombo',
        businessPhone: '+94110000002',
        businessEmail: sellerB.email,
        status: 'ACTIVE',
      },
    })
    const resellerPending = await prisma.reseller.create({
      data: {
        code: `RS-DEMOP-${run}`,
        fullName: 'Reseller Pending',
        nicOrPassport: `NIC-P-${run}`,
        email: sellerPending.email,
        mobile: '+94770000003',
        address: 'Colombo',
        businessName: `Reseller Pending Biz ${run}`,
        businessRegistrationNo: `BRN-P-${run}`,
        businessAddress: 'Colombo',
        businessPhone: '+94110000003',
        businessEmail: sellerPending.email,
        status: 'PENDING', // not yet approved — must not be able to create demo requests
      },
    })
    resellerAId = resellerA.id
    resellerBId = resellerB.id
    createdResellerIds.push(resellerA.id, resellerB.id, resellerPending.id)

    const sellerAUser = await prisma.user.create({
      data: {
        email: sellerA.email,
        name: 'Seller A',
        passwordHash: sellerAHash,
        role: 'SELLER',
        status: 'ACTIVE',
        emailVerified: new Date(),
        resellerId: resellerA.id,
      },
    })
    const sellerBUser = await prisma.user.create({
      data: {
        email: sellerB.email,
        name: 'Seller B',
        passwordHash: sellerBHash,
        role: 'SELLER',
        status: 'ACTIVE',
        emailVerified: new Date(),
        resellerId: resellerB.id,
      },
    })
    const sellerPendingUser = await prisma.user.create({
      data: {
        email: sellerPending.email,
        name: 'Seller Pending',
        passwordHash: sellerPendingHash,
        role: 'SELLER',
        status: 'ACTIVE',
        emailVerified: new Date(),
        resellerId: resellerPending.id,
      },
    })
    await prisma.resellerProductAccess.createMany({
      data: [
        { resellerId: resellerA.id, productId: product.id, status: 'ACTIVE' },
        { resellerId: resellerB.id, productId: product.id, status: 'ACTIVE' },
      ],
    })
    createdUserIds.push(adminUser.id, sellerAUser.id, sellerBUser.id, sellerPendingUser.id)

    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${port}`
  })

  after(async () => {
    server?.close()
    if (!prisma) return
    if (createdDemoIds.length) await prisma.demoRequest.deleteMany({ where: { id: { in: createdDemoIds } } }).catch(() => undefined)
    // Confirming a demo links a Customer + CustomerAccount to the reseller; remove them before the reseller/product.
    if (createdResellerIds.length) {
      await prisma.customerAccount.deleteMany({ where: { resellerId: { in: createdResellerIds } } }).catch(() => undefined)
      await prisma.customer.deleteMany({ where: { resellerId: { in: createdResellerIds } } }).catch(() => undefined)
    }
    if (createdUserIds.length) await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => undefined)
    if (createdResellerIds.length) await prisma.reseller.deleteMany({ where: { id: { in: createdResellerIds } } }).catch(() => undefined)
    if (createdProductIds.length) await prisma.saasProduct.deleteMany({ where: { id: { in: createdProductIds } } }).catch(() => undefined)
    await prisma.$disconnect()
  })

  function payload(overrides: Record<string, unknown> = {}) {
    return {
      productId,
      businessName: 'Kandy Mobiles',
      contactName: 'Nimal Perera',
      contactEmail: `prospect-${crypto.randomUUID().slice(0, 8)}@test.hexalyte.invalid`,
      contactPhone: '0771234567',
      ...overrides,
    }
  }

  it('reseller can create a demo request; it is persisted as PENDING and owned by that reseller', async () => {
    const session = await login(sellerA.email, sellerA.password)
    assert.equal(session.status, 200)
    const { status, json } = await post('/demo-requests', payload(), session.accessToken)
    assert.equal(status, 201, JSON.stringify(json))
    assert.equal(json.data.status, 'PENDING')
    createdDemoIds.push(json.data.id)

    const row = await prisma.demoRequest.findUniqueOrThrow({ where: { id: json.data.id } })
    assert.equal(row.resellerId, resellerAId)
    assert.equal(row.status, 'PENDING')
  })

  it('an ACTIVE reseller is eligible to submit demo requests', async () => {
    const reseller = await prisma.reseller.findUniqueOrThrow({ where: { id: resellerAId }, select: { status: true } })
    assert.equal(reseller.status, 'ACTIVE')
    const session = await login(sellerA.email, sellerA.password)
    const { status, json } = await post('/demo-requests', payload(), session.accessToken)
    assert.equal(status, 201, JSON.stringify(json))
    createdDemoIds.push(json.data.id)
  })

  it('a PENDING (not yet approved) reseller cannot submit demo requests', async () => {
    const session = await login(sellerPending.email, sellerPending.password)
    assert.equal(session.status, 200)
    const body = payload()
    const { status, json } = await post('/demo-requests', body, session.accessToken)
    assert.equal(status, 403, JSON.stringify(json))
    assert.match(json.message, /must be approved/i)

    const leaked = await prisma.demoRequest.findFirst({ where: { contactEmail: body.contactEmail } })
    assert.equal(leaked, null, 'no row must be created when the reseller is not active')

    // The same gate applies to every permissioned seller API, and /auth/me reports no permissions yet.
    assert.equal((await get('/products', session.accessToken)).status, 403)
    assert.equal((await get('/customers', session.accessToken)).status, 403)
    const me = await get('/auth/me', session.accessToken)
    assert.equal(me.status, 200)
    assert.deepEqual(me.json.data.permissions, [])
    assert.equal(me.json.data.reseller.status, 'PENDING')

    // The welcome-popup marker is stored once on the server and survives a new login.
    assert.equal(me.json.data.welcomeSeen, false)
    assert.equal((await post('/auth/me/welcome-shown', {}, session.accessToken)).status, 200)
    assert.equal((await post('/auth/me/welcome-shown', {}, session.accessToken)).status, 200)
    const again = await login(sellerPending.email, sellerPending.password)
    assert.equal((await get('/auth/me', again.accessToken)).json.data.welcomeSeen, true)
    const markers = await prisma.auditLog.count({ where: { action: 'RESELLER_WELCOME_SHOWN', entityType: 'User', actorEmail: sellerPending.email } })
    assert.equal(markers, 1, 'recorded once, however many times it is reported')
  })

  it('an approved (ACTIVE) reseller gets its permissions from /auth/me', async () => {
    const session = await login(sellerA.email, sellerA.password)
    const me = await get('/auth/me', session.accessToken)
    assert.equal(me.json.data.permissions.includes('products:read'), true)
    assert.equal((await get('/products', session.accessToken)).status, 200)
  })

  it('create rejects invalid input (e.g. missing productId)', async () => {
    const session = await login(sellerA.email, sellerA.password)
    const bad = { ...payload() } as any
    delete bad.productId
    const { status } = await post('/demo-requests', bad, session.accessToken)
    assert.equal(status, 422)
  })

  it('duplicate open request for the same reseller/contact/product is rejected', async () => {
    const session = await login(sellerA.email, sellerA.password)
    const body = payload()
    const first = await post('/demo-requests', body, session.accessToken)
    assert.equal(first.status, 201)
    createdDemoIds.push(first.json.data.id)
    const second = await post('/demo-requests', body, session.accessToken)
    assert.equal(second.status, 409)
  })

  it('a REJECTED request does not block a new request for the same reseller/contact/product', async () => {
    const sessionAdmin = await login(admin.email, admin.password)
    const session = await login(sellerA.email, sellerA.password)
    const body = payload()

    const first = await post('/demo-requests', body, session.accessToken)
    assert.equal(first.status, 201)
    createdDemoIds.push(first.json.data.id)
    const rejected = await post(`/demo-requests/${first.json.data.id}/reject`, { reason: 'Not eligible for a demo at this time.' }, sessionAdmin.accessToken)
    assert.equal(rejected.status, 200)

    const second = await post('/demo-requests', body, session.accessToken)
    assert.equal(second.status, 201, JSON.stringify(second.json))
    createdDemoIds.push(second.json.data.id)
  })

  it('true concurrent submission for the same reseller/contact/product: exactly one succeeds, backed by the database constraint', async () => {
    const session = await login(sellerA.email, sellerA.password)
    const body = payload()

    const [r1, r2] = await Promise.all([
      post('/demo-requests', body, session.accessToken),
      post('/demo-requests', body, session.accessToken),
    ])
    for (const r of [r1, r2]) if (r.status === 201) createdDemoIds.push(r.json.data.id)
    const statuses = [r1.status, r2.status].sort()
    assert.deepEqual(statuses, [201, 409], 'exactly one of two truly concurrent submissions must succeed')

    const rows = await prisma.demoRequest.count({
      where: { resellerId: resellerAId, productId, contactEmail: body.contactEmail, status: { not: 'REJECTED' } },
    })
    assert.equal(rows, 1, 'the database must contain exactly one open row, never two')
  })

  it('a reseller cannot approve or reject their own request (403), and cannot see another reseller\'s request (403/404)', async () => {
    const sessionA = await login(sellerA.email, sellerA.password)
    const created = await post('/demo-requests', payload(), sessionA.accessToken)
    assert.equal(created.status, 201)
    createdDemoIds.push(created.json.data.id)

    const selfApprove = await post(`/demo-requests/${created.json.data.id}/approve`, {}, sessionA.accessToken)
    assert.equal(selfApprove.status, 403)

    const sessionB = await login(sellerB.email, sellerB.password)
    const crossRead = await get(`/demo-requests/${created.json.data.id}`, sessionB.accessToken)
    assert.equal(crossRead.status, 403, 'reseller B must not be able to read reseller A\'s demo request')
  })

  it('invalid status transitions are rejected: cannot confirm before DEMO_CREATED, cannot approve twice', async () => {
    const sessionA = await login(sellerA.email, sellerA.password)
    const sessionAdmin = await login(admin.email, admin.password)
    const created = await post('/demo-requests', payload(), sessionA.accessToken)
    createdDemoIds.push(created.json.data.id)
    const id = created.json.data.id

    const confirmTooEarly = await post(`/demo-requests/${id}/confirm`, { externalTenantId: `tenant-early-${run}` }, sessionAdmin.accessToken)
    assert.equal(confirmTooEarly.status, 409)

    const approve1 = await post(`/demo-requests/${id}/approve`, {}, sessionAdmin.accessToken)
    assert.equal(approve1.status, 200)
    const approve2 = await post(`/demo-requests/${id}/approve`, {}, sessionAdmin.accessToken)
    assert.equal(approve2.status, 409, 'an already-approved request cannot be approved again')
  })

  it('concurrent approve attempts on the same PENDING request: exactly one succeeds', async () => {
    const sessionA = await login(sellerA.email, sellerA.password)
    const sessionAdmin = await login(admin.email, admin.password)
    const created = await post('/demo-requests', payload(), sessionA.accessToken)
    createdDemoIds.push(created.json.data.id)
    const id = created.json.data.id

    const [r1, r2] = await Promise.all([
      post(`/demo-requests/${id}/approve`, {}, sessionAdmin.accessToken),
      post(`/demo-requests/${id}/approve`, {}, sessionAdmin.accessToken),
    ])
    const statuses = [r1.status, r2.status].sort()
    assert.deepEqual(statuses, [200, 409], 'exactly one concurrent approve call must win')
  })

  it('full happy path: approve → save welcome message → confirm, with history and the exact message/WhatsApp link visible to the reseller', async () => {
    const sessionA = await login(sellerA.email, sellerA.password)
    const sessionAdmin = await login(admin.email, admin.password)
    const created = await post('/demo-requests', payload({ businessName: `Happy Path Shop ${run}` }), sessionA.accessToken)
    createdDemoIds.push(created.json.data.id)
    const id = created.json.data.id

    assert.equal((await post(`/demo-requests/${id}/approve`, { note: 'Looks legit' }, sessionAdmin.accessToken)).status, 200)

    // Not visible to the reseller before it is saved.
    const before = await get(`/demo-requests/${id}`, sessionA.accessToken)
    assert.equal(before.json.data.welcomeMessage, null)
    assert.equal(before.json.data.whatsappLink, null)

    // The reseller cannot save it, a blank message is refused, and the removed fields are refused.
    assert.equal((await post(`/demo-requests/${id}/welcome-message`, { welcomeMessage: PREPARED_MESSAGE }, sessionA.accessToken)).status, 403)
    assert.equal((await post(`/demo-requests/${id}/welcome-message`, { welcomeMessage: '   ' }, sessionAdmin.accessToken)).status, 422)
    assert.equal((await post(`/demo-requests/${id}/welcome-message`, { welcomeMessage: PREPARED_MESSAGE, shopName: 'x' }, sessionAdmin.accessToken)).status, 422)

    const saved = await post(`/demo-requests/${id}/welcome-message`, { welcomeMessage: PREPARED_MESSAGE }, sessionAdmin.accessToken)
    assert.equal(saved.status, 200, JSON.stringify(saved.json))
    assert.equal(saved.json.data.status, 'DEMO_CREATED')
    assert.equal(saved.json.data.welcomeMessage, PREPARED_MESSAGE)

    // Reseller sees the exact message and a WhatsApp link carrying it, but never edits anything.
    const resellerSees = await get(`/demo-requests/${id}`, sessionA.accessToken)
    assert.equal(resellerSees.status, 200)
    assert.equal(resellerSees.json.data.welcomeMessage, PREPARED_MESSAGE)
    assert.match(resellerSees.json.data.whatsappLink, /^https:\/\/wa\.me\/94771234567\?text=/)
    assert.equal(decodeURIComponent(resellerSees.json.data.whatsappLink.split('?text=')[1]), PREPARED_MESSAGE)
    assert.equal('shopName' in resellerSees.json.data, false, 'removed demo-shop fields are no longer exposed')

    // Saving is only allowed once: a second save on a DEMO_CREATED request is a status conflict.
    assert.equal((await post(`/demo-requests/${id}/welcome-message`, { welcomeMessage: 'different' }, sessionAdmin.accessToken)).status, 409)

    const confirmed = await post(`/demo-requests/${id}/confirm`, { externalTenantId: `tenant-happy-${run}` }, sessionAdmin.accessToken)
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json))
    assert.equal(confirmed.json.data.status, 'CONFIRMED')

    const historyActions = confirmed.json.data.history.map((h: { action: string }) => h.action)
    assert.deepEqual(historyActions, ['SUBMITTED', 'APPROVED', 'DEMO_CREATED', 'CONFIRMED'])

    const auditCount = await prisma.auditLog.count({ where: { entityType: 'DemoRequest', entityId: id } })
    assert.ok(auditCount >= 4, 'every transition must be audited')
  })

  it('admin list + detail (what the Admin Demo Requests page calls): filters, counts, people/history, and a special-character welcome message round-trips exactly', async () => {
    const sellerSession = await login(sellerA.email, sellerA.password)
    const adminSession = await login(admin.email, admin.password)
    const name = `Admin View Shop ${run}`
    const q = encodeURIComponent(name)
    const created = await post('/demo-requests', payload({ businessName: name }), sellerSession.accessToken)
    assert.equal(created.status, 201, JSON.stringify(created.json))
    const id = created.json.data.id as string
    createdDemoIds.push(id)

    // List as admin: status filter + search, with product/reseller info and the counts behind the KPI cards.
    const pending = await get(`/demo-requests?limit=25&page=1&status=PENDING&search=${q}`, adminSession.accessToken)
    assert.equal(pending.status, 200, JSON.stringify(pending.json))
    assert.equal(pending.json.meta.total, 1)
    const row = pending.json.data[0]
    assert.equal(row.id, id)
    assert.equal(row.status, 'PENDING')
    assert.equal(row.product.id, productId)
    assert.equal(row.reseller.id, resellerAId)
    for (const k of ['total', 'pending', 'approved', 'demoCreated', 'confirmed']) {
      assert.equal(typeof pending.json.meta.pipelineCounts[k], 'number', `pipelineCounts.${k}`)
    }
    assert.ok(pending.json.meta.pipelineCounts.pending >= 1)
    assert.equal((await get(`/demo-requests?status=APPROVED&search=${q}`, adminSession.accessToken)).json.meta.total, 0)

    // Approve moves it between the filtered lists.
    assert.equal((await post(`/demo-requests/${id}/approve`, { note: 'ok' }, adminSession.accessToken)).status, 200)
    assert.equal((await get(`/demo-requests?status=APPROVED&search=${q}`, adminSession.accessToken)).json.meta.total, 1)
    assert.equal((await get(`/demo-requests?status=PENDING&search=${q}`, adminSession.accessToken)).json.meta.total, 0)

    // `>`/`<`, a `?connection=…&phone=…` URL and a trailing newline must survive the HTTP → sanitizer → DB round trip.
    const special = 'Open Settings > Profile, use <your shop name>.\nSign in: https://app.example.com/login?connection=demo&phone=0771234567\n'
    const saved = await post(`/demo-requests/${id}/welcome-message`, { welcomeMessage: special }, adminSession.accessToken)
    assert.equal(saved.status, 200, JSON.stringify(saved.json))
    assert.equal(saved.json.data.welcomeMessage, special)

    const detail = await get(`/demo-requests/${id}`, adminSession.accessToken)
    assert.equal(detail.status, 200)
    assert.equal(detail.json.data.status, 'DEMO_CREATED')
    assert.equal(detail.json.data.welcomeMessage, special)
    assert.equal(detail.json.data.people.requestedBy.email, sellerA.email)
    assert.equal(detail.json.data.people.reviewedBy.email, admin.email)
    assert.deepEqual(detail.json.data.history.map((h: { action: string }) => h.action), ['SUBMITTED', 'APPROVED', 'DEMO_CREATED'])
    assert.equal(detail.json.data.history[1].actor.email, admin.email)

    const resellerSees = await get(`/demo-requests/${id}`, sellerSession.accessToken)
    assert.equal(decodeURIComponent(resellerSees.json.data.whatsappLink.split('?text=')[1]), special)
  })

  async function readyToConfirm(businessName: string) {
    const sellerSession = await login(sellerA.email, sellerA.password)
    const adminSession = await login(admin.email, admin.password)
    const created = await post('/demo-requests', payload({ businessName }), sellerSession.accessToken)
    assert.equal(created.status, 201, JSON.stringify(created.json))
    const id = created.json.data.id as string
    createdDemoIds.push(id)
    assert.equal((await post(`/demo-requests/${id}/approve`, {}, adminSession.accessToken)).status, 200)
    assert.equal((await post(`/demo-requests/${id}/welcome-message`, { welcomeMessage: PREPARED_MESSAGE }, adminSession.accessToken)).status, 200)
    return { id, sellerToken: sellerSession.accessToken!, adminToken: adminSession.accessToken! }
  }

  it('confirm creates the Customer + TRIAL account once, shows it in My Customers, and never duplicates or half-applies', async () => {
    const name = `Kandy Mobiles ${run}`
    const tenant = `tenant-link-${run}`
    const first = await readyToConfirm(name)

    // Submitting, approving and saving the message never create a customer.
    assert.equal(await prisma.customer.count({ where: { resellerId: resellerAId, displayName: name } }), 0)

    // Only an admin can confirm, and the tenant ID is required.
    assert.equal((await post(`/demo-requests/${first.id}/confirm`, { externalTenantId: tenant }, first.sellerToken)).status, 403)
    assert.equal((await post(`/demo-requests/${first.id}/confirm`, {}, first.adminToken)).status, 422)

    const confirmed = await post(`/demo-requests/${first.id}/confirm`, { externalTenantId: tenant }, first.adminToken)
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json))
    assert.equal(confirmed.json.data.linkedAccount.accountCreated, true)
    assert.match(confirmed.json.data.linkedAccount.customerCode, /^CUS-/)

    const customers = await prisma.customer.findMany({ where: { resellerId: resellerAId, displayName: name }, include: { accounts: true } })
    assert.equal(customers.length, 1)
    assert.equal(customers[0].accounts.length, 1)
    assert.equal(customers[0].accounts[0].productId, productId)
    assert.equal(customers[0].accounts[0].status, 'TRIAL')
    assert.equal(customers[0].accounts[0].externalTenantId, tenant)

    // The seller sees it in My Customers as a trial account that Paid Activation can use.
    const mine = await get(`/customers?search=${encodeURIComponent(name)}`, first.sellerToken)
    assert.equal(mine.status, 200)
    assert.equal(mine.json.data.length, 1)
    assert.equal(mine.json.data[0].accounts[0].status, 'TRIAL')
    assert.equal(mine.json.data[0].accounts[0].externalTenantId, tenant)

    // A second confirmed demo for the same business + tenant links the same account: no duplicates.
    const second = await readyToConfirm(`  ${name.toUpperCase()} `)
    const linked = await post(`/demo-requests/${second.id}/confirm`, { externalTenantId: tenant }, second.adminToken)
    assert.equal(linked.status, 200, JSON.stringify(linked.json))
    assert.equal(linked.json.data.linkedAccount.accountCreated, false)
    assert.equal(linked.json.data.linkedAccount.customerId, customers[0].id)
    assert.equal(await prisma.customer.count({ where: { resellerId: resellerAId, displayName: { contains: 'Kandy Mobiles', mode: 'insensitive' }, accounts: { some: { externalTenantId: tenant } } } }), 1)
    assert.equal(await prisma.customerAccount.count({ where: { resellerId: resellerAId, productId, customerId: customers[0].id } }), 1)

    // A different tenant for an account that already has one is refused, and the whole confirmation rolls back.
    const third = await readyToConfirm(name)
    const clash = await post(`/demo-requests/${third.id}/confirm`, { externalTenantId: `${tenant}-other` }, third.adminToken)
    assert.equal(clash.status, 409, JSON.stringify(clash.json))
    assert.equal((await prisma.demoRequest.findUniqueOrThrow({ where: { id: third.id } })).status, 'DEMO_CREATED')

    // A tenant already used by another customer is refused, and no customer is left behind.
    const other = await readyToConfirm(`Other Shop ${run}`)
    const reused = await post(`/demo-requests/${other.id}/confirm`, { externalTenantId: tenant }, other.adminToken)
    assert.equal(reused.status, 409, JSON.stringify(reused.json))
    assert.equal(await prisma.customer.count({ where: { resellerId: resellerAId, displayName: `Other Shop ${run}` } }), 0)
    assert.equal((await prisma.demoRequest.findUniqueOrThrow({ where: { id: other.id } })).status, 'DEMO_CREATED')
  })

  it('Seller WhatsApp number: link, edit and remove with country-code validation', async () => {
    const session = await login(sellerB.email, sellerB.password)
    const token = session.accessToken
    const send = async (method: 'PUT' | 'DELETE', body?: unknown, accessToken?: string) => {
      const res = await fetch(`${baseUrl}/api/v1/auth/me/whatsapp`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      return { status: res.status, json: (await res.json().catch(() => null)) as any }
    }

    assert.equal((await send('PUT', { whatsappNumber: '+94771234567' })).status, 401, 'must be signed in')
    assert.equal((await send('PUT', { whatsappNumber: '0112345678' }, token)).status, 422, 'a Sri Lankan landline is refused')
    assert.equal((await send('PUT', { whatsappNumber: '+999 1234 5678' }, token)).status, 422, 'an unassigned country code is refused')

    const saved = await send('PUT', { whatsappNumber: '+94 77 123 4567' }, token)
    assert.equal(saved.status, 200, JSON.stringify(saved.json))
    assert.equal(saved.json.data.whatsappNumber, '+94771234567')
    assert.equal((await get('/auth/me', token)).json.data.whatsappNumber, '+94771234567')

    const edited = await send('PUT', { whatsappNumber: '+447911123456' }, token)
    assert.equal(edited.json.data.whatsappNumber, '+447911123456')

    const removed = await send('DELETE', undefined, token)
    assert.equal(removed.status, 200)
    assert.equal(removed.json.data.whatsappNumber, null)
    assert.equal((await get('/auth/me', token)).json.data.whatsappNumber, null)
  })

  it('rejection records the reason and notifies the reseller; a rejected request cannot be approved afterwards', async () => {
    const sessionA = await login(sellerA.email, sellerA.password)
    const sessionAdmin = await login(admin.email, admin.password)
    const created = await post('/demo-requests', payload(), sessionA.accessToken)
    createdDemoIds.push(created.json.data.id)
    const id = created.json.data.id

    const rejected = await post(`/demo-requests/${id}/reject`, { reason: 'Reseller not yet approved for this product line.' }, sessionAdmin.accessToken)
    assert.equal(rejected.status, 200)
    assert.equal(rejected.json.data.status, 'REJECTED')

    const lateApprove = await post(`/demo-requests/${id}/approve`, {}, sessionAdmin.accessToken)
    assert.equal(lateApprove.status, 409)
  })
})
