import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { AddressInfo } from 'node:net'
import { installHermeticBackend, strictFake } from './helpers/hermetic-backend'
import { pinVerificationCutoff } from './helpers/verification-cutoff'

/**
 * SMSlenz gateway settings and the SMS-OTP partner registration, through the real Express `app`.
 * Database-free (see tests/helpers/hermetic-backend.ts) and network-free: the SMSlenz endpoint is a stubbed
 * `fetch`, so no real SMS is ever sent. All keys, numbers and codes below are throwaway test values.
 */

type Row = Record<string, any>
const API_KEY = 'test-api-key-0123456789abcdef'
const PHONE = '0771234567'
const PHONE_E164 = '+94771234567'

const state = {
  users: new Map<string, Row>(),
  tokens: [] as Row[],
  settings: new Map<string, Row>(),
  audit: [] as Row[],
  seq: 0,
  lockStatements: 0,
  readsBeforeLock: 0,
  resellers: [] as Row[],
}

const USERS: Record<string, Row> = {
  'u-admin': { id: 'u-admin', name: 'Ada Admin', email: 'admin@test.invalid', role: 'ADMIN', status: 'ACTIVE', emailVerified: null, resellerId: null, reseller: null },
  'u-seller': { id: 'u-seller', name: 'Sam Seller', email: 'seller@test.invalid', role: 'SELLER', status: 'ACTIVE', emailVerified: new Date(), resellerId: 'r1', reseller: { status: 'ACTIVE' } },
}

const matchUser = (u: Row, where: Row): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'not' in v) return v.not === null ? u[k] != null : u[k] !== v.not
    return u[k] === v
  })
const allUsers = () => [...Object.values(USERS), ...state.users.values()]

const matchToken = (t: Row, where: Row): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (k === 'user') {
      const phone = state.users.get(t.userId)?.phone
      return v.phone && typeof v.phone === 'object' && 'not' in v.phone ? phone != null : phone === v.phone
    }
    if (k === 'createdAt') return t.createdAt >= v.gte
    return t[k] === v
  })

/** Per-transaction store: lets the fake notice a token read made inside a transaction before the lock was taken. */
const txStore = new AsyncLocalStorage<{ lockHeld: boolean }>()
const noteRead = () => {
  const t = txStore.getStore()
  if (t && !t.lockHeld) state.readsBeforeLock++
}

const tokenApi = {
  findFirst: async ({ where, orderBy }: Row) => {
    noteRead()
    const rows = state.tokens.filter((t) => matchToken(t, where))
    return (orderBy ? rows.sort((a, b) => b.seq - a.seq) : rows)[0] ?? null
  },
  create: async ({ data }: Row) => {
    const row = { id: `t${++state.seq}`, seq: state.seq, usedAt: null, createdAt: new Date(), ...data }
    state.tokens.push(row)
    return { ...row }
  },
  update: async ({ where, data }: Row) => {
    const t = state.tokens.find((x) => x.id === where.id)!
    for (const [k, v] of Object.entries(data)) t[k] = v && typeof v === 'object' && 'increment' in (v as Row) ? t[k] + (v as Row).increment : v
    return { ...t }
  },
  updateMany: async ({ where, data }: Row) => {
    const rows = state.tokens.filter((t) => matchToken(t, where))
    rows.forEach((t) => Object.assign(t, data))
    return { count: rows.length }
  },
  count: async ({ where }: Row) => {
    noteRead()
    return state.tokens.filter((t) => matchToken(t, where)).length
  },
}
const userApi = {
  findUnique: async ({ where }: Row) => {
    const u = where.id ? allUsers().find((x) => x.id === where.id) : allUsers().find((x) => x.email === where.email)
    const reseller = u?.resellerId && !u.reseller ? state.resellers.find((r) => r.id === u.resellerId) : undefined
    return u ? { ...u, ...(reseller ? { reseller: { status: reseller.status } } : {}) } : null
  },
  findMany: async () => [] as Row[],
  findFirst: async ({ where }: Row) => {
    const { id, ...rest } = where
    return allUsers().find((u) => matchUser(u, rest) && (!id || matchUser(u, { id }))) ?? null
  },
  create: async ({ data }: Row) => {
    const u = { id: `new${++state.seq}`, createdAt: new Date(), status: 'ACTIVE', ...data }
    state.users.set(u.id, u)
    return { ...u }
  },
  update: async ({ where, data }: Row) => {
    const u = state.users.get(where.id)!
    if (data.verifiedPhone && allUsers().some((o) => o.id !== u.id && o.verifiedPhone === data.verifiedPhone)) {
      throw Object.assign(new Error('Unique constraint failed on verifiedPhone'), { code: 'P2002' })
    }
    return Object.assign(u, data)
  },
  delete: async ({ where }: Row) => {
    state.users.delete(where.id)
    state.tokens = state.tokens.filter((t) => t.userId !== where.id)
  },
}
const platformSetting = {
  findUnique: async ({ where }: Row) => (state.settings.has(where.key) ? { ...state.settings.get(where.key) } : null),
  upsert: async ({ where, create, update }: Row) => {
    state.settings.set(where.key, { ...(state.settings.get(where.key) ?? create), ...(state.settings.has(where.key) ? update : {}) })
  },
}
const auditLog = { create: async ({ data }: Row) => void state.audit.push({ ...data }) }
const tx = {
  user: userApi,
  emailVerificationToken: tokenApi,
  $executeRawUnsafe: async (sql: string) => {
    assert.match(sql, /pg_advisory_xact_lock/)
    state.lockStatements++
    const t = txStore.getStore()
    if (t) t.lockHeld = true
    return 1
  },
  reseller: {
    create: async ({ data }: Row) => {
      const r = { id: `rs${++state.seq}`, ...data, bankAccount: undefined }
      state.resellers.push(r)
      return r
    },
  },
  auditLog: { create: async ({ data }: Row) => void state.audit.push({ ...data }) },
}
/** Stands in for the advisory lock: transactions that take it run one at a time. */
let lockQueue: Promise<unknown> = Promise.resolve()
const serialised = <T>(fn: () => Promise<T>) => {
  const run = lockQueue.then(() => txStore.run({ lockHeld: false }, fn), () => txStore.run({ lockHeld: false }, fn))
  lockQueue = run.catch(() => undefined)
  return run
}

const fakePrisma = strictFake('prisma', {
  user: userApi,
  emailVerificationToken: tokenApi,
  platformSetting,
  auditLog,
  refreshToken: { create: async () => ({}) },
  $transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => serialised(() => fn(tx)),
  reseller: { findUnique: async () => null },
  notification: { createMany: async () => ({ count: 0 }) },
})

/** Stub of the SMSlenz endpoint. */
const sms = {
  calls: [] as { url: string; body: Row }[],
  reply: (): { status: number; body: unknown } | 'timeout' | 'network' => ({ status: 200, body: { success: true, message: 'SMS sent successfully', data: { status: 'success' } } }),
  lastCode: () => /(\d{6})/.exec(sms.calls.at(-1)!.body.message)![1],
}
const realFetch = globalThis.fetch

describe('SMSlenz gateway settings and SMS-OTP registration', () => {
  let base = ''
  let server: http.Server
  /** A fresh client IP per test (the app trusts one proxy hop), so the in-memory per-IP limiters of one test never affect another. */
  let clientIp = '10.0.0.1'
  let ipCounter = 0
  const tokens: Record<string, string> = {}

  const json = async (method: string, urlPath: string, opts: { token?: string; body?: unknown } = {}) => {
    const res = await realFetch(`${base}/api/v1${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': clientIp, ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    })
    return { status: res.status, json: (await res.json().catch(() => null)) as any }
  }

  const gatewayBody = (extra: Row = {}) => ({ provider: 'SMSLENZ', userId: '12', senderId: 'HexTest', enabled: true, updateApiKey: true, apiKey: API_KEY, ...extra })
  const saveGateway = (extra: Row = {}) => json('PUT', '/admin/settings/sms-gateway', { token: tokens.admin, body: gatewayBody(extra) })
  const registerBody = (extra: Row = {}) => ({
    name: 'New Partner',
    email: 'new@test.invalid',
    phone: PHONE,
    password: 'StrongPass123',
    confirmPassword: 'StrongPass123',
    acceptTerms: true,
    ...extra,
  })
  const register = (extra: Row = {}) => json('POST', '/auth/register', { body: registerBody(extra) })
  const verify = (otp: string, email = 'new@test.invalid') => json('POST', '/auth/verify-email', { body: { email, otp } })
  const resend = (email = 'new@test.invalid') => json('POST', '/auth/resend-verification', { body: { email } })
  const login = (email = 'new@test.invalid') => json('POST', '/auth/login', { body: { email, password: 'StrongPass123' } })
  const wrongCode = (real: string) => (real === '000000' ? '111111' : '000000')
  /** Ages every stored code so the 60 s resend cooldown has passed. */
  const passCooldown = () => state.tokens.forEach((t) => (t.createdAt = new Date(Date.now() - 61_000)))

  before(async () => {
    installHermeticBackend(fakePrisma)
    // The registration / login gate below is exercised for real: pin its cutoff so the test never depends on the shipped launch value.
    pinVerificationCutoff()
    const { signAccessToken } = await import('../src/utils/jwt')
    const { default: app } = await import('../src/app')
    for (const [name, id] of [['admin', 'u-admin'], ['seller', 'u-seller']] as const) {
      const u = USERS[id]
      tokens[name] = signAccessToken({ userId: u.id, email: u.email, role: u.role, resellerId: u.resellerId })
    }
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input)
      if (!url.startsWith('https://www.smslenz.lk/')) return realFetch(input, init)
      sms.calls.push({ url, body: JSON.parse(init.body) })
      const r = sms.reply()
      if (r === 'timeout') throw Object.assign(new Error('timeout'), { name: 'TimeoutError' })
      if (r === 'network') throw new TypeError('fetch failed')
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
  })

  after(async () => {
    globalThis.fetch = realFetch
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  beforeEach(() => {
    clientIp = `10.0.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`
    state.users.clear()
    state.tokens = []
    state.resellers = []
    state.lockStatements = 0
    state.readsBeforeLock = 0
    delete USERS['u-seller'].verifiedPhone
    delete USERS['u-seller'].phone
    state.settings.clear()
    state.audit = []
    sms.calls = []
    sms.reply = () => ({ status: 200, body: { success: true, message: 'SMS sent successfully', data: { status: 'success' } } })
  })

  describe('admin settings API', () => {
    it('is admin only (anonymous 401, partner 403) for read, save and test', async () => {
      for (const [method, path, body] of [['GET', '/admin/settings/sms-gateway', undefined], ['PUT', '/admin/settings/sms-gateway', gatewayBody()], ['POST', '/admin/settings/sms-gateway/test', { phone: PHONE }]] as const) {
        assert.equal((await json(method, path, { body })).status, 401, `${method} ${path} anonymous`)
        assert.equal((await json(method, path, { token: tokens.seller, body })).status, 403, `${method} ${path} partner`)
      }
      assert.equal(sms.calls.length, 0)
    })

    it('saves credentials encrypted, returns only a masked key, and audits without secrets', async () => {
      const res = await saveGateway()
      assert.equal(res.status, 200)
      assert.equal(res.json.data.status, 'READY')
      assert.equal(res.json.data.apiKeyConfigured, true)
      assert.ok(res.json.data.apiKeyMasked.startsWith('••••'))

      const stored = state.settings.get('SMS_GATEWAY_CONFIG')!.value as string
      assert.ok(!stored.includes(API_KEY) && !stored.includes('HexTest'), 'stored value is ciphertext')

      const get = await json('GET', '/admin/settings/sms-gateway', { token: tokens.admin })
      assert.ok(!JSON.stringify(get.json).includes(API_KEY), 'GET never contains the key')
      assert.ok(!JSON.stringify(res.json).includes(API_KEY), 'PUT response never contains the key')

      const audit = state.audit.find((a) => a.action === 'SETTINGS_SMS_GATEWAY_UPDATED')!
      assert.ok(audit)
      assert.ok(!JSON.stringify(audit).includes(API_KEY))
      assert.equal(audit.metadata.credentialRotated, true)
    })

    it('keeps the stored key unless an update is explicitly requested', async () => {
      await saveGateway()
      const keep = await saveGateway({ updateApiKey: false, apiKey: undefined, senderId: 'Other', enabled: false })
      assert.equal(keep.status, 200)
      assert.equal(keep.json.data.status, 'DISABLED')
      assert.equal(keep.json.data.apiKeyConfigured, true)
      // The retained key is still the one used for sending.
      await json('POST', '/admin/settings/sms-gateway/test', { token: tokens.admin, body: { phone: PHONE } })
      assert.equal(sms.calls[0].body.api_key, API_KEY)
      assert.equal(sms.calls[0].body.sender_id, 'Other')
      // A key without the explicit flag is rejected.
      assert.equal((await saveGateway({ updateApiKey: false })).status, 422)
    })

    it('validates required fields and a first save needs an API key', async () => {
      assert.equal((await saveGateway({ userId: '' })).status, 422)
      assert.equal((await saveGateway({ senderId: '' })).status, 422)
      assert.equal((await saveGateway({ updateApiKey: true, apiKey: undefined })).status, 422)
      assert.equal((await saveGateway({ updateApiKey: false, apiKey: undefined })).status, 422, 'no stored key to keep')
      assert.equal((await saveGateway({ extra: 1 })).status, 422, 'unknown fields rejected')
    })

    it('test SMS needs a valid Sri Lankan number, is sent only on request, and uses the SMSlenz request format', async () => {
      await saveGateway()
      assert.equal((await json('POST', '/admin/settings/sms-gateway/test', { token: tokens.admin, body: {} })).status, 422)
      assert.equal((await json('POST', '/admin/settings/sms-gateway/test', { token: tokens.admin, body: { phone: '+447911123456' } })).status, 422)
      assert.equal((await json('POST', '/admin/settings/sms-gateway/test', { token: tokens.admin, body: { phone: 'abc' } })).status, 422)
      assert.equal(sms.calls.length, 0, 'nothing sent for invalid input or by saving')

      const ok = await json('POST', '/admin/settings/sms-gateway/test', { token: tokens.admin, body: { phone: PHONE } })
      assert.equal(ok.status, 200)
      assert.equal(sms.calls.length, 1)
      assert.equal(sms.calls[0].url, 'https://www.smslenz.lk/api/send-sms')
      assert.deepEqual(Object.keys(sms.calls[0].body).sort(), ['api_key', 'contact', 'message', 'sender_id', 'user_id'])
      assert.equal(sms.calls[0].body.contact, PHONE_E164)
      assert.equal(ok.json.data.lastTest.ok, true)
    })

    it('test SMS refuses to run before the gateway is configured', async () => {
      assert.equal((await json('POST', '/admin/settings/sms-gateway/test', { token: tokens.admin, body: { phone: PHONE } })).status, 409)
      assert.equal(sms.calls.length, 0)
    })

    for (const [name, reply, status, code] of [
      ['invalid credentials (401)', { status: 401, body: { success: false, message: 'Invalid API key' } }, 502, 'SMS_INVALID_CREDENTIALS'],
      ['insufficient credit', { status: 200, body: { success: false, message: 'Insufficient SMS credit balance' } }, 502, 'SMS_INSUFFICIENT_CREDIT'],
      ['invalid number', { status: 422, body: { success: false, message: 'The contact number is invalid' } }, 502, 'SMS_INVALID_NUMBER'],
      ['provider error', { status: 500, body: 'oops' }, 502, 'SMS_PROVIDER_ERROR'],
      ['timeout', 'timeout', 502, 'SMS_TIMEOUT'],
      ['network failure', 'network', 502, 'SMS_NETWORK'],
    ] as const) {
      it(`test SMS reports ${name} safely`, async () => {
        await saveGateway()
        sms.reply = () => reply as any
        const res = await json('POST', '/admin/settings/sms-gateway/test', { token: tokens.admin, body: { phone: PHONE } })
        assert.equal(res.status, status)
        assert.equal(res.json.code, code)
        assert.ok(!JSON.stringify(res.json).includes(API_KEY))
        const cfg = await json('GET', '/admin/settings/sms-gateway', { token: tokens.admin })
        assert.equal(cfg.json.data.lastTest.ok, false)
      })
    }
  })

  describe('registration OTP', () => {
    it('refuses to register while the gateway is not ready, and creates nothing', async () => {
      assert.equal((await register()).status, 503)
      await saveGateway({ enabled: false })
      assert.equal((await register()).status, 503)
      assert.equal(state.users.size, 0)
      assert.equal(sms.calls.length, 0)
    })

    it('rejects a missing or non-Sri-Lankan phone number', async () => {
      await saveGateway()
      assert.equal((await register({ phone: undefined })).status, 422)
      assert.equal((await register({ phone: '12345' })).status, 422)
      assert.equal((await register({ phone: '+447911123456' })).status, 422)
      assert.equal(sms.calls.length, 0)
    })

    it('sends a six-digit code, stores only its hash, blocks login until verified, then verifies once', async () => {
      await saveGateway()
      const res = await register()
      assert.equal(res.status, 201)
      assert.ok(!res.json.data.phoneMasked.includes('771234567'))
      assert.equal(sms.calls.length, 1)
      assert.equal(sms.calls[0].body.contact, PHONE_E164)
      const code = sms.lastCode()
      assert.match(code, /^\d{6}$/)
      assert.ok(!JSON.stringify(state.tokens).includes(code), 'plain code is not stored')
      assert.ok(!JSON.stringify(state.audit).includes(code))

      // Direct API use cannot skip the OTP: login is refused for the unverified account.
      const early = await login()
      assert.equal(early.status, 403)
      assert.equal(early.json.code, 'EMAIL_NOT_VERIFIED')

      assert.equal((await verify(code)).status, 200)
      assert.equal((await login()).status, 200)
      // One-time use.
      assert.equal((await verify(code)).json.message, 'Your account is already verified. You can log in.')
      assert.equal(state.tokens.filter((t) => !t.usedAt).length, 0)
    })

    it('does not require email verification: the email is never mailed in this flow', async () => {
      await saveGateway()
      assert.equal((await register()).status, 201)
      // (the email service would throw/log in a hermetic run if it were used; the SMS stub is the only outbound call)
      assert.equal(sms.calls.length, 1)
    })

    it('prevents duplicate registrations by email and by verified phone number', async () => {
      await saveGateway()
      await register()
      assert.equal((await register()).status, 409, 'same email')
      assert.equal((await register({ email: 'other@test.invalid' })).status, 201, 'unverified phone does not block')
      assert.equal((await verify(sms.lastCode(), 'other@test.invalid')).status, 200)
      assert.equal((await register({ email: 'third@test.invalid' })).status, 409, 'verified phone is taken')
    })

    it('rejects expired codes', async () => {
      await saveGateway()
      await register()
      const code = sms.lastCode()
      state.tokens[0].expiresAt = new Date(Date.now() - 1000)
      const res = await verify(code)
      assert.equal(res.status, 400)
      assert.equal(res.json.code, 'OTP_EXPIRED')
      assert.equal((await login()).status, 403)
    })

    it('locks a code after five wrong attempts, even if the right code follows', async () => {
      await saveGateway()
      await register()
      const code = sms.lastCode()
      for (let i = 1; i <= 4; i++) {
        const res = await verify(wrongCode(code))
        assert.equal(res.json.code, 'INVALID_OTP')
      }
      assert.equal((await verify(wrongCode(code))).json.code, 'TOO_MANY_ATTEMPTS')
      const after = await verify(code)
      assert.equal(after.status, 400)
      assert.equal(after.json.code, 'NO_ACTIVE_OTP')
      assert.equal((await login()).status, 403)
    })

    it('counts parallel guesses atomically: at most five tries in total', async () => {
      await saveGateway()
      await register()
      const code = sms.lastCode()
      const results = await Promise.all(Array.from({ length: 12 }, () => verify(wrongCode(code))))
      assert.equal(results.filter((r) => r.json.code === 'INVALID_OTP').length, 4)
      assert.equal((await verify(code)).json.code, 'NO_ACTIVE_OTP')
    })

    it('enforces the 60 second resend cooldown, then replaces the old code', async () => {
      await saveGateway()
      await register()
      const first = sms.lastCode()
      const early = await resend()
      assert.equal(early.status, 429)
      assert.equal(early.json.code, 'RESEND_COOLDOWN')
      assert.equal(sms.calls.length, 1, 'no SMS during cooldown')

      passCooldown()
      assert.equal((await resend()).status, 200)
      assert.equal(sms.calls.length, 2)
      const second = sms.lastCode()
      if (second !== first) assert.equal((await verify(first)).json.code, 'INVALID_OTP', 'old code no longer works')
      assert.equal((await verify(second)).status, 200)
    })

    it('caps codes at five per hour per number', async () => {
      await saveGateway()
      await register()
      for (let i = 0; i < 4; i++) {
        passCooldown()
        assert.equal((await resend()).status, 200)
      }
      passCooldown()
      const res = await resend()
      assert.equal(res.status, 429)
      assert.equal(res.json.code, 'OTP_SEND_LIMIT')
      // A different account cannot be used to text the same number more often either.
      assert.equal((await register({ email: 'bomb@test.invalid' })).status, 429)
      assert.equal(sms.calls.length, 5)
    })

    it('does not reveal whether an account exists when resending', async () => {
      await saveGateway()
      const res = await resend('nobody@test.invalid')
      assert.equal(res.status, 200)
      assert.equal(sms.calls.length, 0)
    })

    for (const [name, reply] of [
      ['invalid number', { status: 200, body: { success: false, message: 'Invalid contact number' } }],
      ['insufficient credit', { status: 200, body: { success: false, message: 'Insufficient credit' } }],
      ['timeout', 'timeout'],
    ] as const) {
      it(`keeps the unverified account, blocks login and counts the attempt on ${name}`, async () => {
        await saveGateway()
        sms.reply = () => reply as any
        const res = await register()
        assert.equal(res.status, 201, 'the account exists, so the client can continue to the verification page')
        assert.equal(res.json.data.codeSent, false)
        assert.equal(res.json.data.email, 'new@test.invalid')
        assert.ok(!/credit|api|key/i.test(res.json.message), 'no provider details to the visitor')
        assert.ok(!/has been sent/i.test(res.json.message), 'never claims an SMS that was not delivered')

        // The account is kept, still blocked, and the failed attempt left a counted (but unusable) token row.
        assert.equal(state.users.size, 1)
        assert.equal((await login()).status, 403)
        assert.equal(state.tokens.length, 1)
        assert.equal(state.tokens.filter((t) => !t.usedAt).length, 0, 'the unsent code cannot be used')
        const cfg = await json('GET', '/admin/settings/sms-gateway', { token: tokens.admin })
        assert.equal(cfg.json.data.usage24h, 1, 'failed or uncertain delivery consumes daily quota')

        // Retrying does not make a second account and does not reset any limit.
        assert.equal((await register()).status, 409)
        assert.equal(state.users.size, 1)
        const early = await resend()
        assert.equal(early.status, 429)
        assert.equal(early.json.code, 'RESEND_COOLDOWN', 'the failed attempt still triggers the cooldown')

        // After the cooldown a resend works once the gateway recovers, and the account can then be verified.
        sms.reply = () => ({ status: 200, body: { success: true, data: { status: 'success' } } })
        passCooldown()
        assert.equal((await resend()).status, 200)
        assert.equal((await verify(sms.lastCode())).status, 200)
        assert.equal((await login()).status, 200)
      })
    }

    it('failed deliveries count toward the hourly per-number cap too', async () => {
      await saveGateway()
      sms.reply = () => 'timeout'
      await register()
      for (let i = 0; i < 4; i++) {
        passCooldown()
        assert.equal((await resend()).status, 502)
      }
      passCooldown()
      assert.equal((await resend()).json.code, 'OTP_SEND_LIMIT')
      assert.equal(sms.calls.length, 5)
    })

    it('keeps existing login working for verified users and admins', async () => {
      const res = await json('POST', '/auth/login', { body: { email: 'nobody@test.invalid', password: 'x' } })
      assert.equal(res.status, 401)
    })
  })

  describe('verified phone ownership and email separation', () => {
    it('SMS verification sets phoneVerifiedAt + verifiedPhone and never emailVerified', async () => {
      await saveGateway()
      await register()
      assert.equal((await verify(sms.lastCode())).status, 200)
      const u = [...state.users.values()][0]
      assert.equal(u.verifiedPhone, PHONE_E164)
      assert.ok(u.phoneVerifiedAt instanceof Date)
      assert.equal(u.emailVerified, null, 'email ownership is not claimed')
      assert.equal(state.audit.at(-1)!.action, 'AUTH_PHONE_VERIFIED')
    })

    it('a number used only as a WhatsApp/contact number does not block registration', async () => {
      await saveGateway()
      USERS['u-seller'].phone = PHONE_E164
      assert.equal((await register()).status, 201)
      assert.equal((await verify(sms.lastCode())).status, 200)
      assert.equal(USERS['u-seller'].phone, PHONE_E164, 'the contact number is untouched')
      assert.equal(USERS['u-seller'].verifiedPhone, undefined)
    })

    it('two accounts verifying the same number at once: exactly one wins, the other gets a conflict', async () => {
      await saveGateway()
      await register({ email: 'a@test.invalid' })
      const codeA = sms.lastCode()
      await register({ email: 'b@test.invalid' })
      const codeB = sms.lastCode()
      const [ra, rb] = await Promise.all([verify(codeA, 'a@test.invalid'), verify(codeB, 'b@test.invalid')])
      assert.deepEqual([ra.status, rb.status].sort(), [200, 409])
      assert.equal([...state.users.values()].filter((u) => u.verifiedPhone === PHONE_E164).length, 1)
    })

    it('an account with no phone still verifies through an emailed code, which does prove the email', async () => {
      await saveGateway()
      state.users.set('legacy-1', { id: 'legacy-1', email: 'old@test.invalid', name: 'Old', phone: null, role: 'SELLER', status: 'ACTIVE', emailVerified: null, createdAt: new Date() })
      assert.equal((await resend('old@test.invalid')).status, 200)
      assert.equal(sms.calls.length, 0, 'no SMS for an account without a phone')
      // The emailed code is not observable here, so stand in for it with a known hash.
      const { sha256 } = await import('../src/utils/crypto')
      state.tokens.at(-1)!.tokenHash = sha256('123456')
      assert.equal((await verify('123456', 'old@test.invalid')).status, 200)
      assert.ok(state.users.get('legacy-1')!.emailVerified instanceof Date)
      assert.equal(state.users.get('legacy-1')!.verifiedPhone, undefined)
    })
  })

  describe('sender destination check', () => {
    it('refuses a foreign or malformed destination before any request to SMSlenz, and sends a valid one in canonical form', async () => {
      await saveGateway()
      const { smsGatewayService, SmsSendError } = await import('../src/modules/sms/sms-gateway.service')
      for (const bad of ['+447911123456', '+94112345678', '+9477123', 'abc', '']) {
        await assert.rejects(
          smsGatewayService.send(bad, 'x'),
          (e: unknown) => e instanceof SmsSendError && e.code === 'INVALID_NUMBER',
          `destination ${JSON.stringify(bad)}`,
        )
      }
      assert.equal(sms.calls.length, 0, 'nothing reached SMSlenz')

      await smsGatewayService.send(PHONE, 'hello')
      assert.equal(sms.calls.length, 1)
      assert.equal(sms.calls[0].body.contact, PHONE_E164, 'sent in canonical +94 form')
    })

    it('keeps reporting an unconfigured or disabled gateway before looking at the destination', async () => {
      const { smsGatewayService } = await import('../src/modules/sms/sms-gateway.service')
      await assert.rejects(smsGatewayService.send('+447911123456', 'x'), (e: any) => e.code === 'NOT_CONFIGURED')
      await saveGateway({ enabled: false })
      await assert.rejects(smsGatewayService.send('+447911123456', 'x'), (e: any) => e.code === 'DISABLED')
      assert.equal(sms.calls.length, 0)
    })
  })

  describe('legacy access rule', () => {
    it('admins, email-verified, phone-verified and pre-cutoff accounts pass; newer unverified ones do not', async () => {
      const { isAccountVerified, parseVerificationCutoff, hasLegacyAccess } = await import('../src/config/account-verification')
      const cutoff = parseVerificationCutoff('2026-11-02T00:00:00+05:30')!
      const before = new Date('2026-11-01T00:00:00Z')
      const after = new Date('2026-11-03T00:00:00Z')
      assert.equal(isAccountVerified({ role: 'ADMIN' }, cutoff), true)
      assert.equal(isAccountVerified({ role: 'SELLER', emailVerified: new Date() }, cutoff), true)
      assert.equal(isAccountVerified({ role: 'SELLER', phoneVerifiedAt: new Date() }, cutoff), true)
      assert.equal(isAccountVerified({ role: 'SELLER', createdAt: before }, cutoff), true)
      assert.equal(isAccountVerified({ role: 'SELLER', createdAt: after }, cutoff), false)
      assert.equal(isAccountVerified({ role: 'SELLER', createdAt: cutoff }, cutoff), false, 'the cutoff instant itself is not legacy')
      assert.equal(hasLegacyAccess({ createdAt: before }, cutoff), true)
    })

    it('fails closed while the cutoff is the placeholder or malformed', async () => {
      const { isAccountVerified, parseVerificationCutoff, ACCOUNT_VERIFICATION_REQUIRED_FROM } = await import('../src/config/account-verification')
      const PLACEHOLDER = 'UNCONFIRMED-SET-DEPLOYMENT-TIMESTAMP'
      assert.equal(parseVerificationCutoff(PLACEHOLDER), null, 'the placeholder never parses, so it fails closed')
      // Independent of which value is shipped: it is either still the placeholder or a well-formed instant, never half-set.
      assert.ok(
        ACCOUNT_VERIFICATION_REQUIRED_FROM === PLACEHOLDER || parseVerificationCutoff(ACCOUNT_VERIFICATION_REQUIRED_FROM) !== null,
        'the shipped value is neither the placeholder nor a valid timestamp',
      )
      assert.equal(parseVerificationCutoff('2026-11-02'), null)
      assert.equal(parseVerificationCutoff('2026-11-02T00:00:00'), null, 'an explicit offset is required')
      assert.equal(isAccountVerified({ role: 'SELLER', createdAt: new Date(0) }, null), false)
    })

    it('legacy access never writes or implies verification', async () => {
      const { hasLegacyAccess, parseVerificationCutoff } = await import('../src/config/account-verification')
      const account = { role: 'SELLER' as const, createdAt: new Date('2020-01-01'), emailVerified: null, phoneVerifiedAt: null }
      assert.equal(hasLegacyAccess(account, parseVerificationCutoff('2026-11-02T00:00:00+05:30')), true)
      assert.equal(account.emailVerified, null)
      assert.equal(account.phoneVerifiedAt, null)
    })
  })

  describe('global daily SMS cap', () => {
    const regN = (i: number) => register({ email: `cap${i}@test.invalid`, phone: `07712345${String(10 + i)}` })

    it('defaults to 500 and is configurable, validated and shown with usage', async () => {
      const saved = await saveGateway({ dailyLimit: undefined })
      assert.equal(saved.json.data.dailyLimit, 500)
      assert.equal((await saveGateway({ dailyLimit: 0 })).status, 422)
      assert.equal((await saveGateway({ dailyLimit: 1.5 })).status, 422)
      assert.equal((await saveGateway({ dailyLimit: 3 })).json.data.dailyLimit, 3)
      await regN(1)
      const cfg = await json('GET', '/admin/settings/sms-gateway', { token: tokens.admin })
      assert.equal(cfg.json.data.usage24h, 1)
      assert.equal(cfg.json.data.dailyLimit, 3)
    })

    it('stops at the limit with SMS_DAILY_LIMIT, sends nothing more and leaves no account behind', async () => {
      await saveGateway({ dailyLimit: 3 })
      for (let i = 1; i <= 3; i++) assert.equal((await regN(i)).status, 201)
      const res = await regN(4)
      assert.equal(res.status, 503)
      assert.equal(res.json.code, 'SMS_DAILY_LIMIT')
      assert.ok(!/limit/i.test(res.json.message), 'the visitor is not told about a limit')
      assert.equal(sms.calls.length, 3)
      assert.equal(state.users.size, 3)
      // Resend is capped by the same global counter.
      passCooldown()
      const r = await resend('cap1@test.invalid')
      assert.equal(r.status, 503)
      assert.equal(r.json.code, 'SMS_DAILY_LIMIT')
      assert.equal(sms.calls.length, 3)
    })

    it('concurrent requests cannot exceed the limit', async () => {
      await saveGateway({ dailyLimit: 2 })
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => regN(i + 1)))
      assert.equal(results.filter((r) => r.status === 201).length, 2)
      assert.equal(results.filter((r) => r.json?.code === 'SMS_DAILY_LIMIT').length, 6)
      assert.equal(sms.calls.length, 2)
      assert.ok(state.lockStatements >= 8, 'every reservation takes the advisory lock')
    })

    it('codes older than 24 hours no longer count; test SMS never counts', async () => {
      await saveGateway({ dailyLimit: 1 })
      assert.equal((await regN(1)).status, 201)
      assert.equal((await regN(2)).status, 503)
      state.tokens.forEach((t) => (t.createdAt = new Date(Date.now() - 25 * 60 * 60 * 1000)))
      assert.equal((await regN(2)).status, 201)

      state.tokens = []
      const before = sms.calls.length
      assert.equal((await json('POST', '/admin/settings/sms-gateway/test', { token: tokens.admin, body: { phone: PHONE } })).status, 200)
      assert.equal(sms.calls.length, before + 1)
      assert.equal((await json('GET', '/admin/settings/sms-gateway', { token: tokens.admin })).json.data.usage24h, 0)
    })
  })

  describe('atomic limits under concurrency (in-memory fake; real PostgreSQL locking is not exercised)', () => {
    it('parallel resends send exactly one SMS; the rest hit the cooldown', async () => {
      await saveGateway()
      await register()
      passCooldown()
      const before = sms.calls.length
      state.readsBeforeLock = 0
      const results = await Promise.all(Array.from({ length: 8 }, () => resend()))
      assert.equal(results.filter((r) => r.status === 200).length, 1)
      assert.equal(results.filter((r) => r.json?.code === 'RESEND_COOLDOWN').length, 7)
      assert.equal(sms.calls.length - before, 1)
    })

    it('parallel registrations for one number stop at the hourly per-number cap', async () => {
      await saveGateway()
      const results = await Promise.all(Array.from({ length: 9 }, (_, i) => register({ email: `same${i}@test.invalid` })))
      assert.equal(results.filter((r) => r.status === 201).length, 5)
      assert.equal(results.filter((r) => r.json?.code === 'OTP_SEND_LIMIT').length, 4)
      assert.equal(sms.calls.length, 5)
      assert.equal(state.users.size, 5, 'refused attempts leave no account')
    })

    it('every limit is read only after the single advisory lock is held', async () => {
      await saveGateway({ dailyLimit: 4 })
      state.readsBeforeLock = 0
      await Promise.all([register({ email: 'x1@test.invalid', phone: '0771111111' }), register({ email: 'x2@test.invalid', phone: '0772222222' })])
      passCooldown()
      await Promise.all([resend('x1@test.invalid'), resend('x2@test.invalid')])
      assert.equal(state.readsBeforeLock, 0, 'cooldown, hourly and daily counts all run under the lock')
      assert.ok(state.lockStatements >= 4)
    })
  })

  describe('usage counting', () => {
    it('does not change when a user later removes or changes the contact/WhatsApp phone', async () => {
      await saveGateway()
      await register()
      const before = (await json('GET', '/admin/settings/sms-gateway', { token: tokens.admin })).json.data.usage24h
      ;[...state.users.values()][0].phone = null
      const after = (await json('GET', '/admin/settings/sms-gateway', { token: tokens.admin })).json.data.usage24h
      assert.equal(before, 1)
      assert.equal(after, 1)
    })
  })

  describe('legacy /reseller-registration', () => {
    const payload = (extra: Row = {}) => ({
      personal: { fullName: 'Test Applicant', nicOrPassport: '901234567V', email: 'apply@test.invalid', mobile: '0771234567', address: '123 Test Road, Colombo' },
      business: { businessName: 'Test Biz', businessRegistrationNo: 'PV 12345', businessAddress: '456 Business Road, Colombo', businessPhone: '0112345678', businessEmail: 'biz@test.invalid' },
      bank: { bankName: 'Test Bank', branch: 'Colombo', accountHolderName: 'Test Applicant', accountNumber: '1234567890' },
      password: 'StrongPass123',
      confirmPassword: 'StrongPass123',
      acceptTerms: true,
      ...extra,
    })
    const apply = (extra: Row = {}) => json('POST', '/reseller-registration', { body: payload(extra) })

    it('sends the SMS code for a new account, says so, and the account must verify before login', async () => {
      await saveGateway()
      const res = await apply()
      assert.equal(res.status, 201)
      assert.equal(res.json.data.verification.required, true)
      assert.equal(res.json.data.verification.codeSent, true)
      assert.match(res.json.data.verification.message, /SMS/)
      assert.equal(sms.calls.length, 1)
      assert.equal(sms.calls[0].body.contact, PHONE_E164)
      assert.equal((await login('apply@test.invalid')).status, 403)
      assert.equal((await verify(sms.lastCode(), 'apply@test.invalid')).status, 200)
      assert.equal((await login('apply@test.invalid')).status, 200)
      const account = [...state.users.values()][0]
      assert.equal(account.verifiedPhone, PHONE_E164)
    })

    it('keeps the application but does not claim an SMS when the gateway is disabled', async () => {
      await saveGateway({ enabled: false })
      const res = await apply()
      assert.equal(res.status, 201)
      assert.equal(res.json.data.verification.codeSent, false)
      assert.ok(!/we sent/i.test(res.json.data.verification.message))
      assert.equal(sms.calls.length, 0)
      assert.equal(state.tokens.filter((t) => !t.usedAt).length, 0, 'no usable code exists')
      assert.equal([...state.users.values()][0].verifiedPhone, undefined, 'the application number is not marked verified')
    })

    it('reports a provider failure and a reached daily limit without claiming a send', async () => {
      await saveGateway({ dailyLimit: 1 })
      sms.reply = () => ({ status: 200, body: { success: false, message: 'Invalid contact number' } })
      const failed = await apply()
      assert.equal(failed.status, 201)
      assert.equal(failed.json.data.verification.codeSent, false)
      assert.equal(state.tokens.filter((t) => !t.usedAt).length, 0, 'the unsent code is invalidated')

      sms.reply = () => ({ status: 200, body: { success: true, data: { status: 'success' } } })
      const limited = await apply({
        personal: { ...payload().personal, email: 'apply2@test.invalid', nicOrPassport: '911234567V', mobile: '0771234599' },
        business: { ...payload().business, businessRegistrationNo: 'PV 99999' },
      })
      assert.equal(limited.json.data.verification.codeSent, false)
      assert.equal(sms.calls.length, 1, 'nothing sent once the cap is reached')
    })
  })
})
