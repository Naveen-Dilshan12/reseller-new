/**
 * End-to-end production-readiness check of the full reseller flow.
 *
 * Runs the real API against a DISPOSABLE, migrated and seeded database plus a
 * mock SaaS partner API that verifies the bearer key and HMAC signature.
 *
 *   E2E_DATABASE_URL=postgresql://... SEED_SUPER_ADMIN_EMAIL=... SEED_SUPER_ADMIN_PASSWORD=... \
 *     npx tsx scripts/e2e-flow.ts
 *
 * Never point it at a real database: it creates resellers, customers and commissions.
 */
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import type { AddressInfo } from 'node:net'

const DB = process.env.E2E_DATABASE_URL
const ADMIN_EMAIL = process.env.SEED_SUPER_ADMIN_EMAIL
const ADMIN_PASSWORD = process.env.SEED_SUPER_ADMIN_PASSWORD
if (!DB || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('E2E_DATABASE_URL, SEED_SUPER_ADMIN_EMAIL and SEED_SUPER_ADMIN_PASSWORD are required')
  process.exit(2)
}

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxr-e2e-uploads-'))
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: DB,
  JWT_ACCESS_SECRET: crypto.randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
  UPLOAD_DIR: uploadDir,
  MAX_UPLOAD_MB: '5',
  INTEGRATION_TIMEOUT_MS: '1000',
  CORS_ORIGINS: 'http://localhost:3000',
  COMPANY_BANK_DETAILS: 'Hexalyte (Pvt) Ltd | Test Bank | 000111222',
})

// ─── Mini test runner ────────────────────────────────────────────────────────

let passed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL  ${name}${detail === undefined ? '' : `  -> ${JSON.stringify(detail).slice(0, 400)}`}`)
  }
}
const section = (title: string) => console.log(`\n== ${title}`)

// ─── Mock SaaS partner API ───────────────────────────────────────────────────

const SAAS_API_KEY = `mk_${crypto.randomBytes(16).toString('hex')}`
const SAAS_SIGNING_SECRET = crypto.randomBytes(32).toString('hex')
const saas = {
  mode: 'ok' as 'ok' | 'slow' | 'error',
  badSignatures: 0,
  calls: [] as { method: string; path: string; idempotencyKey?: string; body: unknown }[],
  activations: new Map<string, string>(),
}

function startMockSaas(): Promise<string> {
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: status < 400, data, message: status < 400 ? 'ok' : String((data as { m?: string })?.m ?? 'error') }))
      }
      const ts = String(req.headers['x-hexalyte-timestamp'] ?? '')
      const expected = `sha256=${crypto.createHmac('sha256', SAAS_SIGNING_SECRET).update(`${ts}.${req.method}.${req.url}.${raw}`).digest('hex')}`
      if (req.headers.authorization !== `Bearer ${SAAS_API_KEY}` || req.headers['x-hexalyte-signature'] !== expected) {
        saas.badSignatures++
        return send(401, { m: 'bad signature' })
      }
      const idem = req.headers['idempotency-key'] as string | undefined
      saas.calls.push({ method: req.method!, path: req.url!, idempotencyKey: idem, body: raw ? JSON.parse(raw) : null })

      if (saas.mode === 'slow') return void setTimeout(() => send(200, { ok: true }), 2500)
      if (saas.mode === 'error') return send(500, { m: 'internal failure at db.host=10.0.0.5' })

      const url = req.url!
      if (url === '/partner/v1/health') return send(200, { ok: true })
      if (req.method === 'POST' && url === '/partner/v1/tenants') {
        return send(201, { tenantId: `ms-tenant-${crypto.randomUUID().slice(0, 8)}`, ownerUserId: 'u-1', status: 'TRIAL', trialEndsAt: '2026-10-13' })
      }
      const act = url.match(/^\/partner\/v1\/tenants\/([^/]+)\/subscription-activations$/)
      if (req.method === 'POST' && act) {
        const requestId = saas.activations.get(idem!) ?? `act-${crypto.randomUUID().slice(0, 8)}`
        saas.activations.set(idem!, requestId)
        return send(201, { requestId, status: 'ACTIVATED', subscriptionReference: `INV-${requestId}` })
      }
      const st = url.match(/^\/partner\/v1\/tenants\/([^/]+)\/status$/)
      if (st) return send(200, { tenantId: decodeURIComponent(st[1]), status: 'ACTIVE', plan: 'STANDARD' })
      send(404, { m: 'not found' })
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)))
}

// ─── HTTP client ─────────────────────────────────────────────────────────────

let API = ''
const responseLog: string[] = []
interface Res<T = any> {
  status: number
  body: { success: boolean; data: T; message?: string; code?: string; meta?: { total: number } }
  text: string
}

async function call<T = any>(method: string, p: string, opts: { token?: string; json?: unknown; form?: FormData; headers?: Record<string, string> } = {}): Promise<Res<T>> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  let body: BodyInit | undefined
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.json)
  } else if (opts.form) body = opts.form
  const res = await fetch(`${API}${p}`, { method, headers, body })
  const text = await res.text()
  let parsed: any = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = { success: false, data: null }
  }
  return { status: res.status, body: parsed, text }
}

/** Calls made as a reseller; their raw responses are later scanned for leaked secrets. */
async function asReseller<T = any>(token: string, method: string, p: string, opts: Parameters<typeof call>[2] = {}) {
  const r = await call<T>(method, p, { ...opts, token })
  responseLog.push(r.text)
  return r
}

async function login(email: string, password: string) {
  return call<{ accessToken: string; refreshToken: string; user: { id: string; resellerId: string | null } }>('POST', '/auth/login', {
    json: { email, password },
  })
}

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  crypto.randomBytes(2048),
])

function slipForm(fields: Record<string, string>, file: Buffer, name: string, type: string) {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  form.append('slip', new Blob([file], { type }), name)
  return form
}

function registration(label: string) {
  const tag = label.toLowerCase()
  const n = crypto.randomInt(10_000_000, 99_999_999)
  return {
    personal: { fullName: `Reseller ${tag}`, nicOrPassport: `${crypto.randomInt(100_000_000, 999_999_999)}V`, email: `reseller-${tag}-${n}@e2e.test`, mobile: `077${n.toString().slice(0, 7)}`, address: '12 Galle Road, Colombo 03' },
    business: { businessName: `${tag} Traders ${n}`, businessRegistrationNo: `PV${n}`, businessAddress: '12 Galle Road, Colombo 03', businessPhone: '0112345678', businessEmail: `biz-${tag}-${n}@e2e.test` },
    bank: { bankName: 'Commercial Bank', branch: 'Kollupitiya', accountHolderName: `Reseller ${tag}`, accountNumber: `80012${n}` },
    password: 'Reseller123X',
    confirmPassword: 'Reseller123X',
    acceptTerms: true,
  }
}

const month = (offset = 0) => {
  const d = new Date()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + offset)
  return d.toISOString().slice(0, 7)
}

// ─── Flow ────────────────────────────────────────────────────────────────────

async function main() {
  const saasUrl = await startMockSaas()
  const { default: app } = await import('../src/app')
  const { prisma } = await import('../src/config/database')
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  API = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`

  try {
    section('Setup: admin login + Mobile Shop partner integration')
    const adminLogin = await login(ADMIN_EMAIL!, ADMIN_PASSWORD!)
    check('super admin can log in', adminLogin.status === 200, adminLogin.body)
    const admin = adminLogin.body.data.accessToken

    const products = await call<any[]>('GET', '/admin/saas-products?limit=50', { token: admin })
    const mobileShop = products.body.data.find((p: any) => p.code === 'MOBILE_SHOP')
    const integ = await call('PUT', `/admin/saas-products/${mobileShop.id}/integration`, {
      token: admin,
      json: { provider: 'MOBILE_SHOP', baseUrl: saasUrl, apiKey: SAAS_API_KEY, signingSecret: SAAS_SIGNING_SECRET },
    })
    check('integration configured (server-side only)', integ.status === 200, integ.body)
    check('admin integration view hides secret values', !integ.text.includes(SAAS_API_KEY) && !integ.text.includes(SAAS_SIGNING_SECRET))
    const health = await call('POST', `/admin/saas-products/${mobileShop.id}/integration/test`, { token: admin })
    check('health check reaches SaaS with valid HMAC', health.status === 200 && health.body.data.ok === true, health.body)

    section('1. Reseller registration')
    const regA = registration('A')
    const regB = registration('B')
    const rA = await call('POST', '/reseller-registration', { json: regA })
    const rB = await call('POST', '/reseller-registration', { json: regB })
    check('reseller A registers', rA.status === 201 || rA.status === 200, rA.body)
    check('reseller B registers', rB.status === 201 || rB.status === 200, rB.body)
    const dup = await call('POST', '/reseller-registration', { json: regA })
    check('duplicate registration rejected', dup.status === 409, dup.status)
    const weak = await call('POST', '/reseller-registration', { json: { ...registration('W'), password: 'a'.repeat(73) + 'A1', confirmPassword: 'a'.repeat(73) + 'A1' } })
    check('password over bcrypt 72-byte limit rejected', weak.status === 422, weak.status)

    const early = await login(regA.personal.email, regA.password)
    check('unapproved reseller cannot log in', early.status === 403, { status: early.status, code: early.body.code })

    section('2. Admin approval')
    const apps = await call<any[]>('GET', '/admin/reseller-applications?status=PENDING&limit=100', { token: admin })
    const appA = apps.body.data.find((a: any) => a.user?.email === regA.personal.email || a.email === regA.personal.email || a.businessEmail === regA.business.businessEmail)
    const appB = apps.body.data.find((a: any) => a.user?.email === regB.personal.email || a.email === regB.personal.email || a.businessEmail === regB.business.businessEmail)
    check('applications listed for review', Boolean(appA && appB), apps.body.data?.[0])
    check('application list masks bank account number', !apps.text.includes(regA.bank.accountNumber))
    for (const a of [appA, appB]) {
      const ok = await call('POST', `/admin/reseller-applications/${a.id}/approve`, { token: admin, json: { note: 'KYC verified' } })
      check(`approve ${a.businessName ?? a.id}`, ok.status === 200, ok.body)
    }

    section('3. Reseller login')
    const lA = await login(regA.personal.email, regA.password)
    const lB = await login(regB.personal.email, regB.password)
    check('approved reseller A logs in', lA.status === 200, lA.body)
    check('approved reseller B logs in', lB.status === 200, lB.body)
    const tokA = lA.body.data.accessToken
    const tokB = lB.body.data.accessToken
    const wrong = await login(regA.personal.email, 'Wrong123456X')
    check('wrong password gives generic 401', wrong.status === 401 && wrong.body.message === 'Invalid email or password', wrong.body)

    section('4-5. Create trial -> existing SaaS creates the account')
    const catalogue = await asReseller<any[]>(tokA, 'GET', '/products')
    check('reseller catalogue has no integration config', !/baseUrl|apiKey|signingSecret|Encrypted/i.test(catalogue.text), catalogue.text.slice(0, 200))
    const runId = crypto.randomInt(1e6, 9e6)
    const owner = { businessName: `Kandy Mobile Hub ${runId}`, contactName: 'Nimal Perera', contactEmail: `owner-${runId}@kandymobile.test`, contactPhone: '0771234567' }
    const trial = await asReseller(tokA, 'POST', '/trials', { json: { productId: mobileShop.id, owner } })
    check('trial provisioned by SaaS partner API', trial.status === 200 || trial.status === 201, trial.body)
    const trialData = trial.body.data
    check('trial outcome PROVISIONED', trialData?.outcome === 'PROVISIONED', trialData?.outcome)
    const account = trialData.trial.customerAccount
    const customerId = account.customer.id
    check('platform stores only the SaaS tenant reference', typeof account.externalTenantId === 'string' && account.status === 'TRIAL', account)
    const createCall = saas.calls.find((c) => c.method === 'POST' && c.path === '/partner/v1/tenants')
    check('SaaS received trial with idempotency key', Boolean(createCall?.idempotencyKey), createCall)
    const stored = JSON.stringify([await prisma.trialRequest.findMany(), await prisma.customer.findMany(), await prisma.auditLog.findMany(), await prisma.notification.findMany()])
    check('owner contact details are forwarded to the SaaS, not persisted centrally', !stored.includes(owner.contactEmail) && !stored.includes(owner.contactName) && JSON.stringify(createCall?.body).includes(owner.contactEmail))

    const bTrialOnA = await asReseller(tokB, 'POST', '/trials', { json: { productId: mobileShop.id, customerId, owner } })
    check("reseller B cannot create a trial on A's customer", bTrialOnA.status === 400 || bTrialOnA.status === 404, bTrialOnA.status)

    section('6-8. Customer pays -> reseller uploads bank slip -> activation request')
    const payInfo = await asReseller(tokA, 'GET', '/activation-requests/payment-info')
    check('reseller sees company bank details for payment', payInfo.status === 200 && JSON.stringify(payInfo.body.data).includes('000111222'), payInfo.body)
    const fields = {
      customerId,
      productId: mobileShop.id,
      periodMonth: month(),
      amount: '5500.00',
      payerName: 'Nimal Perera',
      payerBank: 'BOC',
      transactionRef: `TRX${crypto.randomInt(1e6, 9e6)}`,
      transferDate: new Date().toISOString().slice(0, 10),
    }
    const fake = await asReseller(tokA, 'POST', '/activation-requests', { form: slipForm(fields, Buffer.from('<script>alert(1)</script>'), 'slip.png', 'image/png') })
    check('non-image disguised as PNG rejected (magic bytes)', fake.status >= 400 && fake.status < 500, { status: fake.status, msg: fake.body.message })
    const exe = await asReseller(tokA, 'POST', '/activation-requests', { form: slipForm(fields, Buffer.from('MZ\x90\x00'), 'slip.exe', 'application/octet-stream') })
    check('executable upload rejected', exe.status >= 400 && exe.status < 500, exe.status)
    const big = await asReseller(tokA, 'POST', '/activation-requests', { form: slipForm(fields, Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]), 'slip.png', 'image/png') })
    check('oversize slip (>5 MB) rejected', big.status === 400 || big.status === 413, big.status)
    const bSubmit = await asReseller(tokB, 'POST', '/activation-requests', { form: slipForm(fields, PNG, 'slip.png', 'image/png') })
    check("reseller B cannot submit activation for A's customer", bSubmit.status >= 400 && bSubmit.status < 500, bSubmit.status)

    const created = await asReseller(tokA, 'POST', '/activation-requests', { form: slipForm(fields, PNG, 'bank slip.png', 'image/png') })
    check('activation request submitted with slip', created.status === 201 || created.status === 200, created.body)
    const act = (await asReseller(tokA, 'GET', `/activation-requests/${created.body.data.id}`)).body.data
    const slipId = act.bankSlips[0].id
    check('status PENDING_REVIEW', act.status === 'PENDING_REVIEW', act.status)
    const onDisk = fs.readdirSync(uploadDir, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(uploadDir, f)).isFile())
    check('slip stored in private storage outside web root', onDisk.length === 1, onDisk)
    check('stored slip is not the plaintext image', !fs.readFileSync(path.join(uploadDir, onDisk[0])).subarray(0, 8).equals(PNG.subarray(0, 8)))

    section('Reseller isolation and privilege checks')
    const bView = await asReseller(tokB, 'GET', `/activation-requests/${act.id}`)
    check("B cannot view A's activation", bView.status === 403 || bView.status === 404, bView.status)
    const bSlip = await asReseller(tokB, 'GET', `/activation-requests/${act.id}/bank-slips/${slipId}`)
    check("B cannot download A's bank slip", bSlip.status === 403 || bSlip.status === 404, bSlip.status)
    const bAcc = await asReseller(tokB, 'GET', `/customer-accounts/${account.id}`)
    check("B cannot view A's customer account", bAcc.status === 403 || bAcc.status === 404, bAcc.status)
    const bList = await asReseller<any[]>(tokB, 'GET', `/customer-accounts?resellerId=${appA.id}`)
    check("B's resellerId filter cannot widen scope", bList.status === 200 && bList.body.data.length === 0, bList.body.meta)
    const bActs = await asReseller<any[]>(tokB, 'GET', `/activation-requests?resellerId=${appA.id}`)
    check("B's activation list excludes A's requests", bActs.body.data.length === 0, bActs.body.meta)
    const bSlips = await asReseller<any[]>(tokB, 'GET', `/bank-slips?resellerId=${appA.id}`)
    check("B's bank-slip list excludes A's slips", bSlips.status === 200 && bSlips.body.data.length === 0, bSlips.status)
    const bTrials = await asReseller<any[]>(tokB, 'GET', `/trials?resellerId=${appA.id}`)
    check("B's trial list excludes A's trials", bTrials.body.data.length === 0, bTrials.body.meta)

    for (const [label, method, p, json] of [
      ['start review', 'POST', `/activation-requests/${act.id}/start-review`, {}],
      ['verify payment', 'POST', `/activation-requests/${act.id}/verify-payment`, { confirmed: true, note: 'self approve attempt' }],
      ['approve activation', 'POST', `/activation-requests/${act.id}/approve`, {}],
      ['trigger SaaS activation', 'POST', `/activation-requests/${act.id}/activate`, {}],
      ['complete activation', 'POST', `/activation-requests/${act.id}/complete`, { activationReference: 'FAKE-1' }],
      ['record subscription event', 'POST', '/subscription-events', { customerAccountId: account.id, type: 'PAYMENT_VERIFIED', periodMonth: month() }],
      ['approve commissions', 'POST', '/commissions/approve', { ids: ['x'] }],
      ['change commission levels', 'PUT', '/admin/settings/commission-levels', { levels: [], reason: 'give myself more' }],
      ['read SaaS integration config', 'GET', `/admin/saas-products/${mobileShop.id}`, undefined],
      ['read audit logs', 'GET', '/audit-logs', undefined],
      ['list all resellers', 'GET', '/admin/resellers', undefined],
      ['reveal bank account', 'POST', `/admin/reseller-applications/${appB.id}/bank-account/reveal`, {}],
    ] as const) {
      const r = await asReseller(tokA, method, p, json === undefined ? {} : { json })
      check(`reseller cannot ${label}`, r.status === 403, r.status)
    }

    section('9. Admin verification')
    const slipView = await call('GET', `/activation-requests/${act.id}/bank-slips/${slipId}`, { token: admin })
    check('admin views slip (decrypted, served as private)', slipView.status === 200 && slipView.text.length > 0)
    const slipRes = await fetch(`${API}/activation-requests/${act.id}/bank-slips/${slipId}`, { headers: { Authorization: `Bearer ${admin}` } })
    check('slip response is no-store + nosniff + sandbox CSP', /no-store/.test(slipRes.headers.get('cache-control') ?? '') && slipRes.headers.get('x-content-type-options') === 'nosniff' && /sandbox/.test(slipRes.headers.get('content-security-policy') ?? ''))
    check('slip bytes round-trip intact', Buffer.from(await slipRes.arrayBuffer()).equals(PNG))
    const slipNoAuth = await call('GET', `/activation-requests/${act.id}/bank-slips/${slipId}`)
    check('slip requires authentication', slipNoAuth.status === 401, slipNoAuth.status)

    for (const [step, p, json] of [
      ['start review', 'start-review', {}],
      ['verify payment', 'verify-payment', { confirmed: true, note: 'Matched on bank statement line 42' }],
      ['approve', 'approve', { note: 'OK' }],
    ] as const) {
      const r = await call('POST', `/activation-requests/${act.id}/${p}`, { token: admin, json })
      check(`admin ${step}`, r.status === 200, r.body)
    }

    section('10-11. Existing SaaS subscription activation -> active customer')
    const activated = await call('POST', `/activation-requests/${act.id}/activate`, { token: admin, json: {} })
    check('SaaS activation triggered', activated.status === 200, activated.body)
    const detail = await call('GET', `/activation-requests/${act.id}`, { token: admin })
    check('request ACTIVATION_COMPLETED', detail.body.data.status === 'ACTIVATION_COMPLETED', detail.body.data?.status)
    const actCall = saas.calls.find((c) => c.path.endsWith('/subscription-activations'))
    check('SaaS received activation with idempotency key + reference', Boolean(actCall?.idempotencyKey) && (actCall?.body as any)?.externalRef === act.reference, actCall)
    const again = await call('POST', `/activation-requests/${act.id}/activate`, { token: admin, json: {} })
    check('re-activating a completed request is refused', again.status === 409, again.status)
    const accNow = await asReseller(tokA, 'GET', `/customer-accounts/${account.id}`)
    check('customer account ACTIVE', accNow.body.data.status === 'ACTIVE', accNow.body.data?.status)
    const resellerAct = await asReseller(tokA, 'GET', `/activation-requests/${act.id}`)
    check('reseller view hides internal notes and reviewer identity', !/Matched on bank statement|people|paymentVerifiedById/.test(resellerAct.text))

    section('12-13. Commission generated and level recalculated')
    const comms = await asReseller<any[]>(tokA, 'GET', '/commissions')
    const earning = comms.body.data.filter((c: any) => c.entryType === 'EARNING')
    check('exactly one EARNING commission', earning.length === 1, comms.body.data)
    check('amount = 10% of 5,500 = 550.00 at Level 1', earning[0] && Number(earning[0].amount) === 550 && earning[0].level === 1 && Number(earning[0].rate) === 10, earning[0])
    check('commission starts PENDING', earning[0]?.status === 'PENDING', earning[0]?.status)
    const dash = await asReseller(tokA, 'GET', '/dashboard/reseller')
    const k = dash.body.data?.kpis ?? {}
    check('dashboard: level 1, 1 active customer', JSON.stringify(k).includes('"activeCustomers":1') || k.activeCustomers === 1, k)
    const resellerRow = await prisma.reseller.findUnique({ where: { id: appA.id } })
    check('reseller level recalculated to 1 (active count 1)', resellerRow?.currentLevel === 1 && resellerRow.activeCustomerCount === 1, resellerRow)
    const bComms = await asReseller<any[]>(tokB, 'GET', `/commissions?resellerId=${appA.id}`)
    check("B cannot see A's commissions", bComms.status === 200 && bComms.body.data.length === 0, bComms.body.meta)

    section('Commission integrity')
    const dupEvent = await call('POST', '/subscription-events', { token: admin, json: { customerAccountId: account.id, type: 'PAYMENT_VERIFIED', periodMonth: month() } })
    check('duplicate PAYMENT_VERIFIED for same month refused', dupEvent.status === 409, dupEvent.status)
    const concurrent = await Promise.all(
      [1, 2, 3].map(() => call('POST', '/subscription-events', { token: admin, json: { customerAccountId: account.id, type: 'PAYMENT_VERIFIED', periodMonth: month(1) } })),
    )
    check('concurrent renewals for next month: exactly one wins', concurrent.filter((r) => r.status === 200 || r.status === 201).length === 1, concurrent.map((r) => r.status))
    const earnings = await prisma.commission.findMany({ where: { customerAccountId: account.id, entryType: 'EARNING' } })
    check('two earnings total (this + next month), no duplicates', earnings.length === 2, earnings.length)
    const lvl = await prisma.reseller.findUnique({ where: { id: appA.id } })
    check('renewal does not inflate active customer count', lvl?.activeCustomerCount === 1, lvl?.activeCustomerCount)

    const toApprove = earnings.find((e) => e.periodMonth === month())!
    const appr = await call('POST', '/commissions/approve', { token: admin, json: { ids: [toApprove.id] } })
    check('admin approves commission', appr.status === 200, appr.body)
    const refund = await call('POST', '/subscription-events', {
      token: admin,
      json: { customerAccountId: account.id, type: 'REFUNDED', periodMonth: month(1), externalRef: 'RF-1', endSubscription: false },
    })
    check('refund reverses that month only', refund.status === 200 || refund.status === 201, refund.body)
    const nextMonth = await prisma.commission.findFirst({ where: { customerAccountId: account.id, periodMonth: month(1), entryType: 'EARNING' } })
    check('refunded month commission REVERSED', nextMonth?.status === 'REVERSED', nextMonth?.status)
    const cancel = await call('POST', '/subscription-events', { token: admin, json: { customerAccountId: account.id, type: 'CANCELLED', periodMonth: month(1) } })
    check('cancellation recorded', cancel.status === 200 || cancel.status === 201, cancel.body)
    const afterCancel = await prisma.reseller.findUnique({ where: { id: appA.id } })
    check('cancellation drops active count to 0 and level to none', afterCancel?.activeCustomerCount === 0 && afterCancel.currentLevel === null, afterCancel)
    const kept = await prisma.commission.findUnique({ where: { id: toApprove.id } })
    check('earned (approved) commission is kept after cancellation', kept?.status === 'APPROVED' || kept?.status === 'PAYABLE', kept?.status)

    section('Agent role and SaaS credentials')
    const agentEmail = `agent-${crypto.randomInt(1e6, 9e6)}@e2e.test`
    const { hashPassword } = await import('../src/utils/password')
    await prisma.user.create({ data: { email: agentEmail, name: 'Agent', passwordHash: await hashPassword('Agent12345X'), role: 'RESELLER_AGENT', resellerId: appA.id } })
    const agent = (await login(agentEmail, 'Agent12345X')).body.data.accessToken
    const agentAcc = await asReseller(agent, 'GET', `/customer-accounts/${account.id}`)
    check('agent sees own-reseller account without commission data', agentAcc.status === 200 && !('commissions' in agentAcc.body.data), Object.keys(agentAcc.body.data ?? {}))
    const agentComms = await asReseller(agent, 'GET', '/commissions')
    check('agent cannot read commissions', agentComms.status === 403, agentComms.status)
    const leaked = responseLog.some((t) => t.includes(SAAS_API_KEY) || t.includes(SAAS_SIGNING_SECRET) || t.includes(DB!) || t.includes(saasUrl))
    check('no reseller response contained SaaS key, secret, URL or DB URL', !leaked)
    check('every SaaS call carried a valid signature', saas.badSignatures === 0, saas.badSignatures)

    section('Integration failure handling')
    const logs = await prisma.integrationLog.findMany()
    check('integration calls logged (no payload column)', logs.length >= 3 && logs.every((l) => !('payload' in l)), logs.length)
    saas.mode = 'error'
    const failTrial = await asReseller(tokA, 'POST', '/trials', { json: { productId: mobileShop.id, owner: { ...owner, businessName: 'Galle Phones' } } })
    check('SaaS 500 -> trial FAILED and retryable', failTrial.body.data?.outcome === 'FAILED' && failTrial.body.data?.trial?.errorRetryable === true, failTrial.body)
    check('SaaS internal error text not shown to reseller', !failTrial.text.includes('10.0.0.5'))
    saas.mode = 'slow'
    const started = Date.now()
    const slow = await call('POST', `/admin/saas-products/${mobileShop.id}/integration/test`, { token: admin })
    check('SaaS timeout enforced (~1s) and reported', slow.body.data?.ok === false && /timed out/.test(slow.body.data?.message ?? '') && Date.now() - started < 2400, { ms: Date.now() - started, body: slow.body })
    saas.mode = 'ok'
    const errLog = await prisma.integrationLog.findFirst({ where: { success: false }, orderBy: { createdAt: 'desc' } })
    check('failed calls logged with error message', Boolean(errLog?.errorMessage), errLog)

    section('Auth and HTTP hardening')
    const lr = await login(regB.personal.email, regB.password)
    const rt = lr.body.data.refreshToken
    const races = await Promise.all([1, 2].map(() => call('POST', '/auth/refresh', { json: { refreshToken: rt } })))
    check('concurrent refresh with same token: only one succeeds', races.filter((r) => r.status === 200).length === 1, races.map((r) => r.status))
    const replay = await call('POST', '/auth/refresh', { json: { refreshToken: rt } })
    check('refresh token replay rejected', replay.status === 401, replay.status)
    const tampered = await call('GET', '/auth/me', { token: `${tokA.slice(0, -4)}AAAA` })
    check('tampered JWT rejected', tampered.status === 401, tampered.status)
    const huge = await call('POST', '/auth/login', { json: { email: 'x@y.z', password: 'p'.repeat(2 * 1024 * 1024) } })
    check('oversize JSON body -> 413', huge.status === 413, huge.status)
    const evil = await call('GET', '/products', { token: tokA, headers: { Origin: 'https://evil.example' } })
    check('disallowed CORS origin -> 403', evil.status === 403, evil.status)

    await call('POST', `/admin/resellers/${appB.id}/suspend`, { token: admin, json: { reason: 'E2E suspension check' } })
    const suspended = await call('GET', '/auth/me', { token: tokB })
    check('suspended reseller token stops working immediately', suspended.status === 401 || suspended.status === 403, suspended.status)

    section('Audit trail')
    const actions = new Set((await prisma.auditLog.findMany({ select: { action: true } })).map((a) => a.action))
    for (const a of [
      'RESELLER_APPLICATION_SUBMITTED', 'RESELLER_APPLICATION_APPROVED', 'AUTH_LOGIN', 'AUTH_LOGIN_FAILED', 'TRIAL_REQUESTED', 'TRIAL_PROVISIONED',
      'BANK_SLIP_VIEWED', 'SUBSCRIPTION_PAYMENT_VERIFIED', 'COMMISSION_APPROVED', 'SUBSCRIPTION_REFUNDED', 'RESELLER_SUSPENDED',
      'AUTH_REFRESH_TOKEN_REUSED', 'INTEGRATION_HEALTH_CHECKED',
    ]) {
      check(`audited: ${a}`, actions.has(a), [...actions].filter((x) => x.startsWith(a.split('_')[0])))
    }
    const activationAudits = [...actions].filter((a) => a.startsWith('ACTIVATION_'))
    check('activation status changes audited', activationAudits.length >= 4, activationAudits)
    let blocked = false
    try {
      await prisma.$executeRaw`UPDATE audit_logs SET action = 'TAMPERED'`
    } catch {
      blocked = true
    }
    check('audit log is append-only (UPDATE blocked by trigger)', blocked)
  } finally {
    server.close()
    await prisma.$disconnect()
    fs.rmSync(uploadDir, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  fs.rmSync(uploadDir, { recursive: true, force: true })
  process.exit(1)
})
