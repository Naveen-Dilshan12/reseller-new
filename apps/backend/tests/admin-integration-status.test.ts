import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { installHermeticBackend, serve, strictFake } from './helpers/hermetic-backend'

/**
 * Admin → SaaS product → Configure integration: `PUT /admin/saas-products/:id/integration`.
 * After a save, the product's integration status must never contradict its last health check.
 *
 * Status meanings (unchanged): CONFIGURED = saved, not verified (or manual fulfilment); CONNECTED = a remote provider
 * passed its health check; ERROR = the health check failed; DISABLED = switched off by an admin; NOT_CONFIGURED =
 * credentials missing. `healthCheck` is what stores CONNECTED / ERROR together with lastCheckOk, and a save that leaves
 * the connection unchanged must leave that pair consistent (inbound partner calls are authenticated only against
 * CONNECTED products, so a silent downgrade also stops them working until the next manual test).
 *
 * Database-free (see tests/helpers/hermetic-backend.ts): real router, auth, validation, service and audit code against
 * an in-memory product + integration store. Nothing here reads `.env`, runs Prisma or opens a connection.
 */

type Row = Record<string, any>
const T0 = new Date('2025-01-01T00:00:00.000Z')
const CHECKED = new Date('2025-03-01T10:00:00.000Z')
let Decimal: typeof import('@prisma/client').Prisma.Decimal
const store = { product: undefined as Row | undefined, config: undefined as Row | null | undefined, audit: [] as Row[] }

const tx = {
  saasIntegrationConfig: {
    upsert: async ({ create, update }: { where: Row; create: Row; update: Row }) => {
      const defined = (o: Row) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
      store.config = store.config
        ? Object.assign(store.config, defined(update), { updatedAt: new Date() })
        : { id: 'cfg-1', lastCheckedAt: null, lastCheckOk: null, lastError: null, createdAt: T0, updatedAt: T0, ...defined(create) }
      return store.config
    },
  },
  saasProduct: {
    update: async ({ data }: { where: Row; data: Row }) => Object.assign(store.product!, data, { updatedAt: new Date() }),
  },
  auditLog: {
    create: async ({ data }: { data: Row }) => {
      store.audit.push({ ...data })
      return data
    },
  },
}

const USERS: Record<string, Row> = {
  'u-admin': { id: 'u-admin', email: 'admin@test.invalid', role: 'ADMIN', status: 'ACTIVE', emailVerified: null, resellerId: null, reseller: null },
  'u-seller': { id: 'u-seller', email: 'seller@test.invalid', role: 'SELLER', status: 'ACTIVE', emailVerified: new Date(), resellerId: 'r1', reseller: { status: 'ACTIVE' } },
}

const fakePrisma = strictFake('prisma', {
  user: { findUnique: async ({ where }: { where: { id: string } }) => USERS[where.id] ?? null },
  saasProduct: {
    findUnique: async ({ select }: { where: { id: string }; select: Row }) => {
      const product = store.product!
      if (Object.keys(select).length === 1 && select.integration) return { integration: store.config ?? null }
      return { ...product, integration: store.config ?? null }
    },
  },
  $transaction: async <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => {
    const snapshot = { product: { ...store.product! }, config: store.config ? { ...store.config } : store.config, audit: store.audit.length }
    try {
      return await fn(tx)
    } catch (err) {
      store.product = snapshot.product
      store.config = snapshot.config
      store.audit.length = snapshot.audit
      throw err
    }
  },
})

const REMOTE = { provider: 'MOBILE_SHOP', baseUrl: 'https://api.shop.example', apiKeyEncrypted: 'enc-key', signingSecretEncrypted: 'enc-secret' }
const MANUAL = { provider: 'MANUAL', baseUrl: null, apiKeyEncrypted: null, signingSecretEncrypted: null }
type Start = { integrationStatus: string; lastCheckedAt: Date | null; lastCheckOk: boolean | null; lastError?: string | null }
const VERIFIED: Start = { integrationStatus: 'CONNECTED', lastCheckedAt: CHECKED, lastCheckOk: true }
const FAILED: Start = { integrationStatus: 'ERROR', lastCheckedAt: CHECKED, lastCheckOk: false, lastError: 'HTTP 503' }
const UNCHECKED: Start = { integrationStatus: 'CONFIGURED', lastCheckedAt: null, lastCheckOk: null }

describe('Admin SaaS products: integration status after a save', () => {
  let api: Awaited<ReturnType<typeof serve>>
  let signAccessToken: typeof import('../src/utils/jwt')['signAccessToken']
  let statusKeepingLastCheck: typeof import('../src/modules/integrations/integration.service')['statusKeepingLastCheck']
  let statusAfterConfigChange: typeof import('../src/modules/integrations/integration.service')['statusAfterConfigChange']

  const token = (id: 'u-admin' | 'u-seller') => signAccessToken({ userId: id, email: USERS[id].email, role: USERS[id].role, resellerId: USERS[id].resellerId })
  const put = (body: Row, who: 'u-admin' | 'u-seller' = 'u-admin') => api.call('PUT', '/admin/saas-products/p1/integration', { token: token(who), body })
  const now = () => ({
    status: store.product!.integrationStatus as string,
    checkedAt: store.config!.lastCheckedAt as Date | null,
    ok: store.config!.lastCheckOk as boolean | null,
    error: store.config!.lastError as string | null,
  })
  const seed = (config: Row, start: Start) => {
    store.product = {
      id: 'p1', code: 'SHOP', name: 'Mobile Shop', description: null, status: 'ACTIVE', monthlyPrice: new Decimal('5500'), currency: 'LKR',
      trialAvailable: false, trialDays: null, integrationStatus: start.integrationStatus, createdAt: T0, updatedAt: T0,
      _count: { resellerAccess: 1, accounts: 1 },
    }
    store.config = { id: 'cfg-1', productId: 'p1', ...config, lastCheckedAt: start.lastCheckedAt, lastCheckOk: start.lastCheckOk, lastError: start.lastError ?? null, createdAt: T0, updatedAt: T0 }
  }
  /** The promise the API makes: status and last check never contradict each other. */
  const assertConsistent = (label: string, provider: string) => {
    const s = now()
    const remote = provider !== 'MANUAL'
    if (s.status === 'CONNECTED') assert.equal(s.ok, true, `${label}: CONNECTED needs a passing last check`)
    if (s.status === 'ERROR') assert.equal(s.ok, false, `${label}: ERROR needs a failing last check`)
    if (s.ok === false) assert.ok(['ERROR', 'DISABLED'].includes(s.status), `${label}: a failed check cannot sit under ${s.status}`)
    if (s.ok === true && remote) assert.ok(['CONNECTED', 'DISABLED'].includes(s.status), `${label}: a passing check on a remote provider cannot sit under ${s.status}`)
    if (s.checkedAt === null) assert.deepEqual([s.ok, s.error], [null, null], `${label}: no check, so no result`)
  }

  before(async () => {
    installHermeticBackend(fakePrisma)
    ;({ signAccessToken } = await import('../src/utils/jwt'))
    ;({ Prisma: { Decimal } } = await import('@prisma/client'))
    ;({ statusKeepingLastCheck, statusAfterConfigChange } = await import('../src/modules/integrations/integration.service'))
    const { errorHandler } = await import('../src/middleware/error.middleware')
    const { adminProductsRouter } = await import('../src/modules/products/products.routes')
    const app = express()
    app.use(express.json())
    app.use('/admin/saas-products', adminProductsRouter)
    app.use(errorHandler)
    api = await serve(app)
  })
  after(async () => {
    await api?.close()
  })
  beforeEach(() => {
    store.audit.length = 0
  })

  describe('connection unchanged: the last check still applies', () => {
    it('saving a verified remote integration keeps it CONNECTED, with its last check', async () => {
      seed(REMOTE, VERIFIED)
      const res = await put({ provider: 'MOBILE_SHOP', enabled: true })
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.deepEqual(now(), { status: 'CONNECTED', checkedAt: CHECKED, ok: true, error: null })
      assert.equal(res.json.data.integrationStatus, 'CONNECTED')
      assert.equal(res.json.data.integration.lastCheckOk, true)
      assert.equal(store.audit[0].metadata.integrationStatus, 'CONNECTED', 'the audit entry records the status that was stored')
    })

    it('a failed last check keeps the integration in ERROR, with its message', async () => {
      seed(REMOTE, FAILED)
      assert.equal((await put({ provider: 'MOBILE_SHOP', enabled: true })).status, 200)
      assert.deepEqual(now(), { status: 'ERROR', checkedAt: CHECKED, ok: false, error: 'HTTP 503' })
    })

    it('disabling shows DISABLED and keeps the last check; re-enabling restores what that check supports', async () => {
      seed(REMOTE, VERIFIED)
      await put({ provider: 'MOBILE_SHOP', enabled: false })
      assert.deepEqual(now(), { status: 'DISABLED', checkedAt: CHECKED, ok: true, error: null })
      await put({ provider: 'MOBILE_SHOP', enabled: true })
      assert.deepEqual(now(), { status: 'CONNECTED', checkedAt: CHECKED, ok: true, error: null })
    })

    it('re-enabling an integration whose last check failed gives ERROR, not a clean-looking CONFIGURED', async () => {
      seed(REMOTE, { ...FAILED, integrationStatus: 'DISABLED' })
      await put({ provider: 'MOBILE_SHOP', enabled: true })
      assert.deepEqual(now(), { status: 'ERROR', checkedAt: CHECKED, ok: false, error: 'HTTP 503' })
    })

    it('an integration that was never checked is CONFIGURED, as before', async () => {
      seed(REMOTE, UNCHECKED)
      await put({ provider: 'MOBILE_SHOP', enabled: true })
      assert.deepEqual(now(), { status: 'CONFIGURED', checkedAt: null, ok: null, error: null })
    })

    it('a manual provider that passed its check stays CONFIGURED: only remote providers are CONNECTED', async () => {
      seed(MANUAL, { integrationStatus: 'CONFIGURED', lastCheckedAt: CHECKED, lastCheckOk: true })
      await put({ provider: 'MANUAL', enabled: true })
      assert.deepEqual(now(), { status: 'CONFIGURED', checkedAt: CHECKED, ok: true, error: null })
    })

    it('an incomplete remote configuration stays NOT_CONFIGURED', async () => {
      seed({ ...REMOTE, apiKeyEncrypted: null }, { integrationStatus: 'NOT_CONFIGURED', lastCheckedAt: null, lastCheckOk: null })
      await put({ provider: 'MOBILE_SHOP', enabled: true })
      assert.equal(now().status, 'NOT_CONFIGURED')
    })
  })

  describe('connection changed: the old check no longer applies', () => {
    it('a new base URL clears the old check and is CONFIGURED until tested again', async () => {
      seed(REMOTE, VERIFIED)
      await put({ provider: 'MOBILE_SHOP', enabled: true, baseUrl: 'https://other.shop.example' })
      assert.deepEqual(now(), { status: 'CONFIGURED', checkedAt: null, ok: null, error: null })
    })

    it('rotating the API key or the signing secret clears the old check', async () => {
      seed(REMOTE, VERIFIED)
      await put({ provider: 'MOBILE_SHOP', enabled: true, apiKey: 'k'.repeat(20) })
      assert.deepEqual(now(), { status: 'CONFIGURED', checkedAt: null, ok: null, error: null })
      seed(REMOTE, FAILED)
      await put({ provider: 'MOBILE_SHOP', enabled: true, signingSecret: 's'.repeat(40) })
      assert.deepEqual(now(), { status: 'CONFIGURED', checkedAt: null, ok: null, error: null })
    })

    it('deleting the credentials makes it NOT_CONFIGURED and clears the check', async () => {
      seed(REMOTE, VERIFIED)
      await put({ provider: 'MOBILE_SHOP', enabled: true, clearCredentials: true })
      assert.deepEqual(now(), { status: 'NOT_CONFIGURED', checkedAt: null, ok: null, error: null })
    })

    it('switching to another implementation clears the check', async () => {
      seed(REMOTE, VERIFIED)
      await put({ provider: 'MANUAL', enabled: true })
      assert.deepEqual(now(), { status: 'CONFIGURED', checkedAt: null, ok: null, error: null })
    })

    it('changing the connection while disabling gives DISABLED with the check cleared', async () => {
      seed(REMOTE, VERIFIED)
      await put({ provider: 'MOBILE_SHOP', enabled: false, baseUrl: 'https://other.shop.example' })
      assert.deepEqual(now(), { status: 'DISABLED', checkedAt: null, ok: null, error: null })
    })
  })

  describe('whatever is saved, the status agrees with the last check', () => {
    const starts: Array<[string, Start]> = [
      ['verified', VERIFIED],
      ['failed', FAILED],
      ['never checked', UNCHECKED],
      ['disabled, last check passed', { ...VERIFIED, integrationStatus: 'DISABLED' }],
      ['disabled, last check failed', { ...FAILED, integrationStatus: 'DISABLED' }],
    ]
    const saves: Array<[string, Row]> = [
      ['unchanged, enabled', { provider: 'MOBILE_SHOP', enabled: true }],
      ['unchanged, disabled', { provider: 'MOBILE_SHOP', enabled: false }],
      ['new base URL', { provider: 'MOBILE_SHOP', enabled: true, baseUrl: 'https://other.shop.example' }],
      ['new API key', { provider: 'MOBILE_SHOP', enabled: true, apiKey: 'k'.repeat(20) }],
      ['credentials deleted', { provider: 'MOBILE_SHOP', enabled: true, clearCredentials: true }],
      ['another implementation', { provider: 'SALON', enabled: true }],
      ['manual', { provider: 'MANUAL', enabled: true }],
    ]
    for (const [startName, start] of starts) {
      for (const [saveName, body] of saves) {
        it(`${startName} → ${saveName}`, async () => {
          seed(REMOTE, start)
          assert.equal((await put(body)).status, 200)
          assertConsistent(`${startName} → ${saveName}`, body.provider)
        })
      }
    }

    it('and again after a second save', async () => {
      seed(REMOTE, VERIFIED)
      for (const enabled of [false, true, true, false, true]) {
        await put({ provider: 'MOBILE_SHOP', enabled })
        assertConsistent(`enabled=${enabled}`, 'MOBILE_SHOP')
      }
      assert.equal(now().status, 'CONNECTED')
    })
  })

  describe('the rule itself', () => {
    const complete = { provider: 'MOBILE_SHOP', baseUrl: 'https://api.test', apiKeyEncrypted: 'k', signingSecretEncrypted: 's' }
    it('mirrors what a health check stores for the same result', () => {
      assert.equal(statusKeepingLastCheck(complete, { lastCheckedAt: CHECKED, lastCheckOk: true }), 'CONNECTED')
      assert.equal(statusKeepingLastCheck(complete, { lastCheckedAt: CHECKED, lastCheckOk: false }), 'ERROR')
      assert.equal(statusKeepingLastCheck(MANUAL, { lastCheckedAt: CHECKED, lastCheckOk: true }), 'CONFIGURED')
    })
    it('without a check it is exactly the old rule', () => {
      assert.equal(statusKeepingLastCheck(complete, null), statusAfterConfigChange(complete))
      assert.equal(statusKeepingLastCheck(complete, { lastCheckedAt: null, lastCheckOk: null }), 'CONFIGURED')
      assert.equal(statusKeepingLastCheck({ ...complete, apiKeyEncrypted: null }, { lastCheckedAt: CHECKED, lastCheckOk: true }), 'NOT_CONFIGURED')
    })
    it('statusAfterConfigChange itself is unchanged', () => {
      assert.equal(statusAfterConfigChange(complete), 'CONFIGURED')
      assert.equal(statusAfterConfigChange({ ...complete, signingSecretEncrypted: null }), 'NOT_CONFIGURED')
    })
  })

  describe('unchanged behaviour', () => {
    it('the audit entry keeps its shape', async () => {
      seed(REMOTE, VERIFIED)
      await put({ provider: 'MOBILE_SHOP', enabled: true })
      assert.equal(store.audit[0].action, 'INTEGRATION_CONFIG_UPDATED')
      assert.deepEqual(Object.keys(store.audit[0].metadata).sort(), ['baseUrl', 'credentialsCleared', 'credentialsUpdated', 'enabled', 'integrationStatus', 'provider'])
    })
    it('still needs integrations:manage: no token 401, a reseller user 403, nothing changed', async () => {
      seed(REMOTE, VERIFIED)
      assert.equal((await api.call('PUT', '/admin/saas-products/p1/integration', { body: { provider: 'MOBILE_SHOP', enabled: false } })).status, 401)
      assert.equal((await put({ provider: 'MOBILE_SHOP', enabled: false }, 'u-seller')).status, 403)
      assert.equal(now().status, 'CONNECTED')
      assert.equal(store.audit.length, 0)
    })
  })
})
