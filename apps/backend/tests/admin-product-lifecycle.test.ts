import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { installHermeticBackend, serve, strictFake } from './helpers/hermetic-backend'

/**
 * Admin → SaaS products → lifecycle (no permanent deletion):
 *   GET  /admin/saas-products/:id/impact                    counts of what the change touches
 *   POST /admin/saas-products/:id/retire                    ACTIVE | COMING_SOON → INACTIVE, reason required
 *   POST /admin/saas-products/:id/restore                   INACTIVE → ACTIVE, note optional
 *   POST /admin/saas-products/:id/coming-soon               ACTIVE | INACTIVE → COMING_SOON, reason required
 *   POST /admin/saas-products/:id/launch                    COMING_SOON → ACTIVE, note optional
 *   GET  /admin/saas-products/:id/resellers-without-access  read-only review list (no grant)
 *
 * Database-free (see tests/helpers/hermetic-backend.ts): the real router, auth, validation, services and audit code run
 * against an in-memory store that behaves like PostgreSQL where it matters here:
 *  - `UPDATE … WHERE` takes a row lock held until the transaction ends; a second writer waits, then re-checks its WHERE;
 *  - a failed transaction undoes only its own writes; reads never wait;
 *  - customer, request, commission, access and integration records have NO write methods here, so any attempt by the
 *    lifecycle code to change them fails the test.
 * Nothing here reads `.env`, runs Prisma or opens a connection.
 */

type Row = Record<string, any>
const T0 = new Date('2025-01-01T00:00:00.000Z')
const V0 = T0.toISOString()
let Decimal: typeof import('@prisma/client').Prisma.Decimal

const db = {
  products: new Map<string, Row>(),
  integrations: new Map<string, Row>(),
  resellers: [] as Row[],
  access: [] as Row[],
  accounts: [] as Row[],
  activations: [] as Row[],
  demos: [] as Row[],
  commissions: [] as Row[],
  audit: [] as Row[],
}
const state = {
  failAudit: undefined as Error | undefined,
  productReads: 0,
  /** Runs once, right after the first product read: lets a test play "someone else saved in between". */
  afterFirstRead: undefined as (() => void) | undefined,
  /** While armed, product reads wait until `n` have happened, so concurrent requests have all read before any writes. */
  barrier: undefined as (() => Promise<void>) | undefined,
  productWrites: [] as Array<{ where: Row; data: Row }>,
}

// ---- query semantics ------------------------------------------------------------------------------------------

const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b)
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true
    if (key === 'productAccess') {
      const related = db.access.filter((a) => a.resellerId === row.id)
      if (cond.none) return !related.some((a) => matches(a, cond.none))
      throw new Error(`Unsupported relation filter: ${JSON.stringify(cond)}`)
    }
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      if (Array.isArray(cond.in)) return cond.in.some((v: unknown) => same(row[key], v))
      throw new Error(`Unsupported filter on ${key}: ${JSON.stringify(cond)}`)
    }
    return same(row[key], cond)
  })
}
const project = (row: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : { ...row })
function groupBy(rows: Row[], args: Row) {
  const [field] = args.by as string[]
  const groups = new Map<unknown, Row[]>()
  for (const row of rows.filter((r) => matches(r, args.where))) groups.set(row[field], [...(groups.get(row[field]) ?? []), row])
  return [...groups].map(([value, members]) => ({
    [field]: value,
    ...(args._count ? { _count: { _all: members.length } } : {}),
    ...(args._sum ? { _sum: { amount: members.reduce((sum, m) => sum.plus(m.amount), new Decimal(0)) } } : {}),
  }))
}
function sortBy(rows: Row[], orderBy: Array<Record<string, 'asc' | 'desc'>> = []) {
  return [...rows].sort((a, b) => {
    for (const entry of orderBy) {
      const [[field, dir]] = Object.entries(entry)
      if (a[field] === b[field]) continue
      const c = a[field] < b[field] ? -1 : 1
      return dir === 'desc' ? -c : c
    }
    return 0
  })
}
function productView(row: Row | undefined, select?: Row) {
  if (!row) return null
  const full: Row = {
    ...row,
    integration: db.integrations.get(row.id) ?? null,
    _count: {
      resellerAccess: db.access.filter((a) => a.productId === row.id && a.status === 'ACTIVE').length,
      accounts: db.accounts.filter((a) => a.productId === row.id).length,
    },
  }
  return project(full, select)
}

const productFindUnique = async ({ where, select }: { where: { id: string }; select?: Row }) => {
  const found = productView(db.products.get(where.id), select)
  if (++state.productReads === 1 && state.afterFirstRead) {
    const hook = state.afterFirstRead
    state.afterFirstRead = undefined
    hook()
  }
  if (state.barrier) await state.barrier()
  return found
}

/** Read-only models: the same for the root client and inside a transaction. */
const reads = {
  customerAccount: { groupBy: async (args: Row) => groupBy(db.accounts, args) },
  activationRequest: { count: async ({ where }: Row) => db.activations.filter((r) => matches(r, where)).length },
  demoRequest: { groupBy: async (args: Row) => groupBy(db.demos, args) },
  commission: { groupBy: async (args: Row) => groupBy(db.commissions, args) },
  resellerProductAccess: { count: async ({ where }: Row) => db.access.filter((r) => matches(r, where)).length },
  reseller: {
    count: async ({ where }: Row) => db.resellers.filter((r) => matches(r, where)).length,
    findMany: async ({ where, select, orderBy, take }: Row) =>
      sortBy(db.resellers.filter((r) => matches(r, where)), orderBy).slice(0, take).map((r) => project(r, select)),
  },
}

// ---- transactions: row locks + per-transaction undo -------------------------------------------------------------

interface TxContext { id: number; undo: Array<() => void>; release: Array<() => void> }
let txSeq = 0
const locks = new Map<string, { owner: number; released: Promise<void> }>()

async function lockRow(key: string, ctx: TxContext) {
  for (let held = locks.get(key); held && held.owner !== ctx.id; held = locks.get(key)) await held.released
  if (locks.get(key)?.owner === ctx.id) return
  let release!: () => void
  locks.set(key, { owner: ctx.id, released: new Promise<void>((resolve) => (release = resolve)) })
  ctx.release.push(() => {
    locks.delete(key)
    release()
  })
}

function txModels(ctx: TxContext) {
  return {
    ...reads,
    saasProduct: {
      findUnique: productFindUnique,
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        await lockRow(`product:${where.id}`, ctx)
        const row = db.products.get(where.id)
        if (!row || !matches(row, where)) return { count: 0 }
        ctx.undo.push(() => db.products.set(where.id, row))
        db.products.set(where.id, { ...row, ...data, updatedAt: new Date(row.updatedAt.getTime() + 60_000) })
        state.productWrites.push({ where, data })
        return { count: 1 }
      },
    },
    auditLog: {
      create: async ({ data }: { data: Row }) => {
        if (state.failAudit) {
          const err = state.failAudit
          state.failAudit = undefined
          throw err
        }
        const entry = { ...data }
        db.audit.push(entry)
        ctx.undo.push(() => db.audit.splice(db.audit.indexOf(entry), 1))
        return entry
      },
    },
  }
}

const USERS: Record<string, Row> = {
  'u-admin': { id: 'u-admin', email: 'admin@test.invalid', role: 'ADMIN', status: 'ACTIVE', emailVerified: null, resellerId: null, reseller: null },
  'u-seller': { id: 'u-seller', email: 'seller@test.invalid', role: 'SELLER', status: 'ACTIVE', emailVerified: new Date(), resellerId: 'r1', reseller: { status: 'ACTIVE' } },
  'u-pending': { id: 'u-pending', email: 'pending@test.invalid', role: 'SELLER', status: 'ACTIVE', emailVerified: new Date(), resellerId: 'r8', reseller: { status: 'PENDING' } },
  'u-disabled': { id: 'u-disabled', email: 'old-admin@test.invalid', role: 'ADMIN', status: 'SUSPENDED', emailVerified: null, resellerId: null, reseller: null },
}
type Who = 'u-admin' | 'u-seller' | 'u-pending' | 'u-disabled'

const fakePrisma = strictFake('prisma', {
  ...reads,
  user: { findUnique: async ({ where }: { where: { id: string } }) => USERS[where.id] ?? null },
  saasProduct: { findUnique: productFindUnique },
  $transaction: async <T>(fn: (tx: object) => Promise<T>): Promise<T> => {
    const ctx: TxContext = { id: ++txSeq, undo: [], release: [] }
    try {
      return await fn(strictFake('tx', txModels(ctx)))
    } catch (err) {
      for (const undo of ctx.undo.reverse()) undo()
      throw err
    } finally {
      for (const release of ctx.release) release()
    }
  },
})

function armReadBarrier(n: number) {
  let arrived = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  state.barrier = async () => {
    if (++arrived >= n) release()
    await Promise.race([gate, new Promise<void>((resolve) => setTimeout(resolve, 2_000).unref())])
  }
}

// ---- fixtures --------------------------------------------------------------------------------------------------

function seed() {
  db.products.clear()
  db.integrations.clear()
  const product = (id: string, status: string, over: Row = {}) => {
    db.products.set(id, {
      id, code: id.toUpperCase(), name: `Product ${id}`, description: null, status, monthlyPrice: new Decimal('5500'), currency: 'LKR',
      trialAvailable: true, trialDays: 14, integrationStatus: 'CONFIGURED', createdAt: T0, updatedAt: T0, ...over,
    })
    db.integrations.set(id, {
      id: `cfg-${id}`, productId: id, provider: 'MANUAL', baseUrl: null, apiKeyEncrypted: null, signingSecretEncrypted: null,
      lastCheckedAt: null, lastCheckOk: null, lastError: null, updatedById: null, createdAt: T0, updatedAt: T0,
    })
  }
  product('p1', 'ACTIVE', { name: 'Hexalyte Salon' })
  product('p2', 'ACTIVE')
  product('p3', 'COMING_SOON')
  product('p4', 'INACTIVE')

  const reseller = (id: string, status: string, businessName: string) => ({
    id, code: `RS-${id}`, businessName, status, approvedAt: status === 'PENDING' ? null : new Date('2025-02-01T00:00:00.000Z'),
    email: `${id}@reseller.invalid`, nicOrPassport: `90000000${id.slice(1)}V`,
  })
  db.resellers = [
    reseller('r1', 'ACTIVE', 'Beta Beauty'),
    reseller('r2', 'ACTIVE', 'Gamma Hair'),
    reseller('r3', 'ACTIVE', 'Delta Spa'),
    reseller('r4', 'ACTIVE', 'Epsilon Nails'),
    reseller('r5', 'ACTIVE', 'Zeta Mobiles'),
    reseller('r6', 'ACTIVE', 'Alpha Traders'),
    reseller('r7', 'SUSPENDED', 'Eta Stores'),
    reseller('r8', 'PENDING', 'Theta Shops'),
    reseller('r9', 'REJECTED', 'Iota Retail'),
  ]
  db.access = [
    { id: 'acc1', resellerId: 'r1', productId: 'p1', status: 'ACTIVE', note: null },
    { id: 'acc2', resellerId: 'r2', productId: 'p1', status: 'ACTIVE', note: 'Launch partner' },
    { id: 'acc3', resellerId: 'r3', productId: 'p1', status: 'SUSPENDED', note: 'Overdue' },
    { id: 'acc4', resellerId: 'r4', productId: 'p1', status: 'REVOKED', note: null },
    { id: 'acc5', resellerId: 'r5', productId: 'p2', status: 'ACTIVE', note: null },
  ]
  let n = 0
  const rows = (productId: string, statuses: string[], extra: (s: string) => Row = () => ({})) =>
    statuses.map((status) => ({ id: `x${++n}`, productId, status, ...extra(status) }))
  db.accounts = [
    ...rows('p1', ['ACTIVE', 'ACTIVE', 'ACTIVE', 'TRIAL', 'TRIAL', 'PENDING', 'CANCELLED', 'SUSPENDED']),
    ...rows('p2', ['ACTIVE', 'ACTIVE', 'ACTIVE', 'ACTIVE', 'TRIAL']),
  ]
  db.activations = [
    ...rows('p1', ['PENDING_REVIEW', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'ACTIVATION_COMPLETED', 'CANCELLED']),
    ...rows('p2', ['PENDING_REVIEW', 'PENDING_REVIEW']),
  ]
  db.demos = [...rows('p1', ['PENDING', 'APPROVED', 'DEMO_CREATED', 'DEMO_CREATED', 'CONFIRMED', 'REJECTED']), ...rows('p2', ['DEMO_CREATED'])]
  const commission = (productId: string, status: string, amount: string, currency = 'LKR') => ({ id: `c${++n}`, productId, status, amount: new Decimal(amount), currency })
  db.commissions = [
    commission('p1', 'PENDING', '100.10'),
    commission('p1', 'APPROVED', '200.20'),
    commission('p1', 'PAYABLE', '300.30'),
    commission('p1', 'PAYABLE', '-50.05'), // clawback
    commission('p1', 'PAID', '999'),
    commission('p1', 'REVERSED', '888'),
    commission('p1', 'APPROVED', '10', 'USD'),
    commission('p2', 'PENDING', '77'),
  ]
  db.audit = []
}

const P1_IMPACT = {
  customerAccounts: { active: 3, trial: 2, pending: 1 },
  openActivationRequests: 3,
  openDemoRequests: { total: 4, awaitingConfirmation: 2 },
  unpaidCommissions: { count: 5, totals: [{ currency: 'LKR', amount: '550.55' }, { currency: 'USD', amount: '10.00' }] },
  resellers: { withAccess: 2, approvedWithoutAccess: 2 },
}
const EMPTY_IMPACT_WITH_SIX_MISSING = {
  customerAccounts: { active: 0, trial: 0, pending: 0 },
  openActivationRequests: 0,
  openDemoRequests: { total: 0, awaitingConfirmation: 0 },
  unpaidCommissions: { count: 0, totals: [] },
  resellers: { withAccess: 0, approvedWithoutAccess: 6 },
}

/** Everything other than the products and the audit log: none of it may change. */
const related = () =>
  JSON.stringify({ integrations: [...db.integrations], resellers: db.resellers, access: db.access, accounts: db.accounts, activations: db.activations, demos: db.demos, commissions: db.commissions })

describe('Admin SaaS products: retire / restore lifecycle', () => {
  let api: Awaited<ReturnType<typeof serve>>
  let signAccessToken: typeof import('../src/utils/jwt')['signAccessToken']

  const token = (who: Who) => signAccessToken({ userId: who, email: USERS[who].email, role: USERS[who].role, resellerId: USERS[who].resellerId })
  const call = (method: string, path: string, body?: unknown, who: Who | null = 'u-admin') =>
    api.call(method, `/admin/saas-products${path}`, { token: who ? token(who) : undefined, body })
  const retire = (id: string, body: unknown, who: Who | null = 'u-admin') => call('POST', `/${id}/retire`, body, who)
  const restore = (id: string, body: unknown, who: Who | null = 'u-admin') => call('POST', `/${id}/restore`, body, who)
  const comingSoon = (id: string, body: unknown, who: Who | null = 'u-admin') => call('POST', `/${id}/coming-soon`, body, who)
  const launch = (id: string, body: unknown, who: Who | null = 'u-admin') => call('POST', `/${id}/launch`, body, who)
  const product = (id: string) => db.products.get(id)!
  const REASON = 'Replaced by the new Salon Pro product'
  const NOT_YET = 'Waiting for the partner API to go live'

  before(async () => {
    installHermeticBackend(fakePrisma)
    ;({ signAccessToken } = await import('../src/utils/jwt'))
    ;({ Prisma: { Decimal } } = await import('@prisma/client'))
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
    seed()
    state.failAudit = undefined
    state.productReads = 0
    state.afterFirstRead = undefined
    state.barrier = undefined
    state.productWrites = []
  })

  describe('authorization', () => {
    it('every lifecycle endpoint needs a signed-in admin: no token 401, a reseller user 403, and nothing changes', async () => {
      const before = related()
      const endpoints: Array<[string, string, unknown]> = [
        ['GET', '/p1/impact', undefined],
        ['POST', '/p1/retire', { reason: REASON, expectedUpdatedAt: V0 }],
        ['POST', '/p4/restore', { expectedUpdatedAt: V0 }],
        ['POST', '/p1/coming-soon', { reason: NOT_YET, expectedUpdatedAt: V0 }],
        ['POST', '/p3/launch', { expectedUpdatedAt: V0 }],
        ['GET', '/p1/resellers-without-access', undefined],
      ]
      for (const [method, path, body] of endpoints) {
        assert.equal((await call(method, path, body, null)).status, 401, `${method} ${path} without a token`)
        const seller = await call(method, path, body, 'u-seller')
        assert.equal(seller.status, 403, `${method} ${path} as a reseller user`)
        assert.equal(seller.json.message, 'Insufficient permissions')
      }
      assert.deepEqual([product('p1').status, product('p3').status, product('p4').status], ['ACTIVE', 'COMING_SOON', 'INACTIVE'])
      assert.equal(db.audit.length, 0)
      assert.equal(state.productWrites.length, 0)
      assert.equal(related(), before)
    })

    it('set coming soon and launch refuse every identity but an active admin, and check permission before the body', async () => {
      const before = related()
      const attempts: Array<[string, string, object, (who: Who | null) => Promise<{ status: number }>]> = [
        ['coming-soon', 'p1', { reason: NOT_YET, expectedUpdatedAt: V0 }, (who) => comingSoon('p1', { reason: NOT_YET, expectedUpdatedAt: V0 }, who)],
        ['launch', 'p3', { expectedUpdatedAt: V0 }, (who) => launch('p3', { expectedUpdatedAt: V0 }, who)],
      ]
      for (const [action, id, body, send] of attempts) {
        const malformed = await api.call('POST', `/admin/saas-products/${id}/${action}`, { token: 'not.a.token', body })
        assert.equal(malformed.status, 401, `${action}: malformed token`)
        assert.equal((await send('u-disabled')).status, 401, `${action}: disabled admin`)
        assert.equal((await send('u-pending')).status, 403, `${action}: reseller user whose application is pending`)
        assert.equal((await send('u-seller')).status, 403, `${action}: approved reseller user`)
      }
      // An invalid body from someone who may not act is still 403, not a validation error that reveals the rules.
      assert.equal((await comingSoon('p1', {}, 'u-seller')).status, 403)
      assert.equal((await launch('p3', { status: 'ACTIVE' }, 'u-seller')).status, 403)
      assert.deepEqual([product('p1').status, product('p3').status], ['ACTIVE', 'COMING_SOON'])
      assert.equal(db.audit.length, 0)
      assert.equal(state.productWrites.length, 0)
      assert.equal(related(), before)
    })
  })

  describe('impact', () => {
    it('counts what retiring would touch, for this product only', async () => {
      const res = await call('GET', '/p1/impact')
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.deepEqual(res.json.data, { productId: 'p1', status: 'ACTIVE', ...P1_IMPACT })
    })

    it('reports counts only, never reseller or customer details', async () => {
      const text = JSON.stringify((await call('GET', '/p1/impact')).json)
      for (const secret of ['Alpha Traders', 'Zeta Mobiles', 'reseller.invalid', 'RS-r6', '900000006V']) assert.equal(text.includes(secret), false, secret)
    })

    it('is read-only, and an unknown product is 404', async () => {
      const before = related()
      await call('GET', '/p1/impact')
      assert.equal((await call('GET', '/nope/impact')).status, 404)
      assert.equal(state.productWrites.length, 0)
      assert.equal(db.audit.length, 0)
      assert.equal(related(), before)
    })
  })

  describe('retire', () => {
    it('takes an active product off sale and records the reason with an impact snapshot', async () => {
      const res = await retire('p1', { reason: `  ${REASON}  `, expectedUpdatedAt: V0 })
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.equal(res.json.message, 'Product retired')
      assert.equal(res.json.data.status, 'INACTIVE')
      assert.notEqual(res.json.data.updatedAt, V0, 'the version moved, so open edit forms become stale')
      assert.equal(product('p1').status, 'INACTIVE')

      assert.equal(db.audit.length, 1)
      const [entry] = db.audit
      assert.equal(entry.action, 'SAAS_PRODUCT_RETIRED')
      assert.equal(entry.entityType, 'SaasProduct')
      assert.equal(entry.entityId, 'p1')
      assert.equal(entry.actorUserId, 'u-admin')
      assert.deepEqual(entry.metadata, { reason: REASON, from: 'ACTIVE', to: 'INACTIVE', impact: P1_IMPACT })
    })

    it('a coming-soon product can be retired too', async () => {
      const res = await retire('p3', { reason: REASON, expectedUpdatedAt: V0 })
      assert.equal(res.status, 200)
      assert.equal(product('p3').status, 'INACTIVE')
      assert.equal(db.audit[0].metadata.from, 'COMING_SOON')
    })

    it('changes only the status: every related record and the rest of the product stay exactly as they were', async () => {
      const before = related()
      const { status: _s, updatedAt: _u, ...restBefore } = product('p1')
      await retire('p1', { reason: REASON, expectedUpdatedAt: V0 })
      const { status: _s2, updatedAt: _u2, ...restAfter } = product('p1')
      assert.equal(related(), before, 'customer accounts, requests, commissions, reseller access and the integration are untouched')
      assert.deepEqual(restAfter, restBefore, 'price, trial settings, integration status… unchanged')
      assert.deepEqual(state.productWrites.map((w) => w.data), [{ status: 'INACTIVE' }])
    })

    it('an inactive product cannot be retired again: 409, nothing written', async () => {
      const res = await retire('p4', { reason: REASON, expectedUpdatedAt: V0 })
      assert.equal(res.status, 409)
      assert.equal(res.json.code, 'PRODUCT_LIFECYCLE_CONFLICT')
      assert.match(res.json.message, /inactive.*only active or coming-soon products can be retired/)
      assert.equal(state.productWrites.length, 0)
      assert.equal(db.audit.length, 0)
    })

    it('an unknown product is 404', async () => {
      assert.equal((await retire('nope', { reason: REASON, expectedUpdatedAt: V0 })).status, 404)
    })

    it('rejects invalid input with 422 and changes nothing', async () => {
      const bad: Array<[string, unknown]> = [
        ['no reason', { expectedUpdatedAt: V0 }],
        ['a reason that is short once trimmed', { reason: '   too short   ', expectedUpdatedAt: V0 }],
        ['a reason over 500 characters', { reason: 'x'.repeat(501), expectedUpdatedAt: V0 }],
        ['no version', { reason: REASON }],
        ['a malformed version', { reason: REASON, expectedUpdatedAt: 'yesterday' }],
        ['an unknown field', { reason: REASON, expectedUpdatedAt: V0, deleteEverything: true }],
      ]
      for (const [label, body] of bad) assert.equal((await retire('p1', body)).status, 422, label)
      assert.equal(product('p1').status, 'ACTIVE')
      assert.equal(state.productWrites.length, 0)
      assert.equal(db.audit.length, 0)
    })

    it('a stale version is refused with 409 and nothing changes', async () => {
      db.products.set('p1', { ...product('p1'), monthlyPrice: new Decimal('6000'), updatedAt: new Date(T0.getTime() + 60_000) }) // someone edited the price
      const res = await retire('p1', { reason: REASON, expectedUpdatedAt: V0 })
      assert.equal(res.status, 409)
      assert.equal(res.json.code, 'PRODUCT_CHANGED')
      assert.match(res.json.message, /since you opened it/)
      assert.equal(product('p1').status, 'ACTIVE')
      assert.equal(db.audit.length, 0)
    })

    it('two admins retiring at the same moment: exactly one succeeds, and one audit entry is written', async () => {
      armReadBarrier(2) // both requests have read the product (version V0) before either writes
      const results = await Promise.all([
        retire('p1', { reason: `${REASON} (admin A)`, expectedUpdatedAt: V0 }),
        retire('p1', { reason: `${REASON} (admin B)`, expectedUpdatedAt: V0 }),
      ])
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
      const loser = results.find((r) => r.status === 409)!
      assert.match(loser.json.message, /at the same time/)
      assert.equal(db.audit.length, 1)
      assert.equal(state.productWrites.length, 1)
      assert.equal(product('p1').status, 'INACTIVE')
    })

    it('a save that lands between the read and the write is caught by the write itself', async () => {
      state.afterFirstRead = () =>
        db.products.set('p1', { ...product('p1'), monthlyPrice: new Decimal('6000'), updatedAt: new Date(T0.getTime() + 60_000) })
      const res = await retire('p1', { reason: REASON, expectedUpdatedAt: V0 })
      assert.equal(res.status, 409, JSON.stringify(res.json))
      assert.match(res.json.message, /at the same time/)
      assert.equal(product('p1').status, 'ACTIVE')
      assert.equal(product('p1').monthlyPrice.toString(), '6000', "the other admin's change is kept")
      assert.equal(db.audit.length, 0)
    })

    it('if the audit entry cannot be written the product is not retired, and a retry works', async () => {
      state.failAudit = new Error('audit store unavailable')
      const failed = await retire('p1', { reason: REASON, expectedUpdatedAt: V0 })
      assert.equal(failed.status, 500)
      assert.equal(product('p1').status, 'ACTIVE')
      assert.equal(product('p1').updatedAt.getTime(), T0.getTime(), 'rolled back, so the version the page holds is still current')
      assert.equal(db.audit.length, 0)

      assert.equal((await retire('p1', { reason: REASON, expectedUpdatedAt: V0 })).status, 200)
      assert.equal(db.audit.length, 1)
    })
  })

  describe('restore', () => {
    it('puts an inactive product back on sale and records it, including who still has no access', async () => {
      const res = await restore('p4', { expectedUpdatedAt: V0 })
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.equal(res.json.message, 'Product restored')
      assert.equal(res.json.data.status, 'ACTIVE')
      assert.equal(db.audit.length, 1)
      assert.equal(db.audit[0].action, 'SAAS_PRODUCT_RESTORED')
      assert.deepEqual(db.audit[0].metadata, { note: null, from: 'INACTIVE', to: 'ACTIVE', impact: EMPTY_IMPACT_WITH_SIX_MISSING })
    })

    it('a note is optional, trimmed and recorded', async () => {
      await restore('p4', { note: '  Back in the catalogue  ', expectedUpdatedAt: V0 })
      assert.equal(db.audit[0].metadata.note, 'Back in the catalogue')
    })

    it('never grants access: approved resellers without access still have none afterwards', async () => {
      const before = related()
      await restore('p4', { expectedUpdatedAt: V0 })
      assert.equal(related(), before, 'no access record was created, and nothing else changed')
      const list = await call('GET', '/p4/resellers-without-access')
      assert.equal(list.json.data.total, 6)
    })

    it('an active or coming-soon product cannot be restored: 409, nothing written', async () => {
      for (const id of ['p1', 'p3']) {
        const res = await restore(id, { expectedUpdatedAt: V0 })
        assert.equal(res.status, 409, id)
        assert.equal(res.json.code, 'PRODUCT_LIFECYCLE_CONFLICT')
        assert.match(res.json.message, /only inactive products can be restored/)
      }
      assert.equal(state.productWrites.length, 0)
      assert.equal(db.audit.length, 0)
    })

    it('a stale version is 409, an unknown product 404, invalid input 422', async () => {
      db.products.set('p4', { ...product('p4'), updatedAt: new Date(T0.getTime() + 60_000) })
      assert.equal((await restore('p4', { expectedUpdatedAt: V0 })).status, 409)
      assert.equal((await restore('nope', { expectedUpdatedAt: V0 })).status, 404)
      for (const body of [{}, { note: 'x'.repeat(501), expectedUpdatedAt: V0 }, { expectedUpdatedAt: V0, status: 'ACTIVE' }]) {
        assert.equal((await restore('p4', body)).status, 422, JSON.stringify(body).slice(0, 60))
      }
      assert.equal(product('p4').status, 'INACTIVE')
      assert.equal(db.audit.length, 0)
    })

    it('if the audit entry cannot be written the product stays inactive', async () => {
      state.failAudit = new Error('audit store unavailable')
      assert.equal((await restore('p4', { expectedUpdatedAt: V0 })).status, 500)
      assert.equal(product('p4').status, 'INACTIVE')
      assert.equal(db.audit.length, 0)
    })

    it('retire then restore: two audit entries, the version moves each time, and nothing else changes', async () => {
      const before = related()
      const retired = await retire('p1', { reason: REASON, expectedUpdatedAt: V0 })
      const restored = await restore('p1', { expectedUpdatedAt: retired.json.data.updatedAt })
      assert.equal(restored.status, 200, JSON.stringify(restored.json))
      assert.equal(product('p1').status, 'ACTIVE')
      assert.deepEqual(db.audit.map((a) => a.action), ['SAAS_PRODUCT_RETIRED', 'SAAS_PRODUCT_RESTORED'])
      assert.equal(related(), before)
      assert.equal((await restore('p1', { expectedUpdatedAt: retired.json.data.updatedAt })).status, 409, 'restoring twice is refused')
    })
  })

  /** Any other save of the product (a price edit, an integration change) moves its version. */
  const bumpVersion = (id: string, over: Row = {}) => db.products.set(id, { ...product(id), ...over, updatedAt: new Date(product(id).updatedAt.getTime() + 60_000) })

  describe('set coming soon', () => {
    it('takes an active product off sale and records the reason with an impact snapshot', async () => {
      const res = await comingSoon('p1', { reason: `  ${NOT_YET}  `, expectedUpdatedAt: V0 })
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.equal(res.json.message, 'Product set to coming soon')
      assert.equal(res.json.data.status, 'COMING_SOON')
      assert.notEqual(res.json.data.updatedAt, V0, 'the version moved, so open edit forms become stale')
      assert.equal(product('p1').status, 'COMING_SOON')

      assert.equal(db.audit.length, 1)
      const [entry] = db.audit
      assert.equal(entry.action, 'SAAS_PRODUCT_SET_COMING_SOON')
      assert.equal(entry.entityType, 'SaasProduct')
      assert.equal(entry.entityId, 'p1')
      assert.equal(entry.actorUserId, 'u-admin')
      assert.deepEqual(entry.metadata, { reason: NOT_YET, from: 'ACTIVE', to: 'COMING_SOON', impact: P1_IMPACT })
    })

    it('an inactive product can be set to coming soon too, and the audit entry says where it came from', async () => {
      const res = await comingSoon('p4', { reason: NOT_YET, expectedUpdatedAt: V0 })
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.equal(product('p4').status, 'COMING_SOON')
      assert.deepEqual(db.audit[0].metadata, { reason: NOT_YET, from: 'INACTIVE', to: 'COMING_SOON', impact: EMPTY_IMPACT_WITH_SIX_MISSING })
    })

    it('changes only the status: every related record, the integration and the rest of the product stay as they were', async () => {
      for (const id of ['p1', 'p4']) {
        const before = related()
        const { status: _s, updatedAt: _u, ...restBefore } = product(id)
        state.productWrites = []
        await comingSoon(id, { reason: NOT_YET, expectedUpdatedAt: V0 })
        const { status: _s2, updatedAt: _u2, ...restAfter } = product(id)
        assert.equal(related(), before, `${id}: customer accounts, requests, commissions, reseller access and the integration are untouched`)
        assert.deepEqual(restAfter, restBefore, `${id}: price, trial settings, integration status… unchanged`)
        assert.deepEqual(state.productWrites.map((w) => w.data), [{ status: 'COMING_SOON' }], id)
      }
    })

    it('a product that is already coming soon cannot be set again: 409, nothing written', async () => {
      const res = await comingSoon('p3', { reason: NOT_YET, expectedUpdatedAt: V0 })
      assert.equal(res.status, 409)
      assert.equal(res.json.code, 'PRODUCT_LIFECYCLE_CONFLICT')
      assert.match(res.json.message, /coming soon.*only active or inactive products can be set to coming soon/)
      assert.equal(state.productWrites.length, 0)
      assert.equal(db.audit.length, 0)
    })

    it('an unknown product is 404', async () => {
      assert.equal((await comingSoon('nope', { reason: NOT_YET, expectedUpdatedAt: V0 })).status, 404)
    })

    it('rejects invalid input with 422 and changes nothing: a reason is required, as for retire', async () => {
      const bad: Array<[string, unknown]> = [
        ['no reason', { expectedUpdatedAt: V0 }],
        ['a note instead of a reason', { note: NOT_YET, expectedUpdatedAt: V0 }],
        ['a reason that is short once trimmed', { reason: '   too short   ', expectedUpdatedAt: V0 }],
        ['a reason over 500 characters', { reason: 'x'.repeat(501), expectedUpdatedAt: V0 }],
        ['no version', { reason: NOT_YET }],
        ['a malformed version', { reason: NOT_YET, expectedUpdatedAt: 'yesterday' }],
        ['a status in the body', { reason: NOT_YET, expectedUpdatedAt: V0, status: 'COMING_SOON' }],
        ['an unknown field', { reason: NOT_YET, expectedUpdatedAt: V0, deleteEverything: true }],
      ]
      for (const id of ['p1', 'p4']) {
        for (const [label, body] of bad) assert.equal((await comingSoon(id, body)).status, 422, `${id}: ${label}`)
      }
      assert.deepEqual([product('p1').status, product('p4').status], ['ACTIVE', 'INACTIVE'])
      assert.equal(state.productWrites.length, 0)
      assert.equal(db.audit.length, 0)
      assert.match((await comingSoon('p1', { expectedUpdatedAt: V0 })).json.errors.join(' '), /Give a reason for setting this product to coming soon/)
    })

    describe('stale and simultaneous requests', () => {
      it('a stale version is refused with 409 for a valid transition, and nothing changes', async () => {
        for (const id of ['p1', 'p4']) {
          bumpVersion(id) // someone edited the product after this page loaded it
          const res = await comingSoon(id, { reason: NOT_YET, expectedUpdatedAt: V0 })
          assert.equal(res.status, 409, id)
          assert.equal(res.json.code, 'PRODUCT_CHANGED')
          assert.match(res.json.message, /since you opened it/)
        }
        assert.deepEqual([product('p1').status, product('p4').status], ['ACTIVE', 'INACTIVE'])
        assert.equal(state.productWrites.length, 0)
        assert.equal(db.audit.length, 0)
      })

      it('a page that loaded the product before another lifecycle change is stale for this one', async () => {
        const retired = await retire('p1', { reason: REASON, expectedUpdatedAt: V0 })
        assert.equal(retired.status, 200)
        const stale = await comingSoon('p1', { reason: NOT_YET, expectedUpdatedAt: V0 }) // INACTIVE is a valid source, but V0 is old
        assert.equal(stale.status, 409)
        assert.equal(stale.json.code, 'PRODUCT_CHANGED')
        assert.equal(product('p1').status, 'INACTIVE')
        assert.equal((await comingSoon('p1', { reason: NOT_YET, expectedUpdatedAt: retired.json.data.updatedAt })).status, 200, 'the current version works')
      })

      it('two admins at the same moment: exactly one succeeds, and one audit entry is written', async () => {
        armReadBarrier(2) // both requests have read the product (version V0) before either writes
        const results = await Promise.all([
          comingSoon('p1', { reason: `${NOT_YET} (admin A)`, expectedUpdatedAt: V0 }),
          comingSoon('p1', { reason: `${NOT_YET} (admin B)`, expectedUpdatedAt: V0 }),
        ])
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
        assert.match(results.find((r) => r.status === 409)!.json.message, /at the same time/)
        assert.equal(db.audit.length, 1)
        assert.equal(state.productWrites.length, 1)
        assert.equal(product('p1').status, 'COMING_SOON')
      })

      it('five simultaneous requests: one wins, four are refused, one audit entry', async () => {
        armReadBarrier(5)
        const results = await Promise.all([1, 2, 3, 4, 5].map((n) => comingSoon('p4', { reason: `${NOT_YET} (${n})`, expectedUpdatedAt: V0 })))
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409, 409, 409])
        assert.equal(db.audit.length, 1)
        assert.equal(state.productWrites.length, 1)
      })

      it('against a retire on the same version: exactly one is saved, and the audit entry matches the final status', async () => {
        armReadBarrier(2)
        const results = await Promise.all([
          comingSoon('p1', { reason: NOT_YET, expectedUpdatedAt: V0 }),
          retire('p1', { reason: REASON, expectedUpdatedAt: V0 }),
        ])
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
        assert.equal(db.audit.length, 1)
        assert.equal(state.productWrites.length, 1)
        const pairs: Record<string, string> = { COMING_SOON: 'SAAS_PRODUCT_SET_COMING_SOON', INACTIVE: 'SAAS_PRODUCT_RETIRED' }
        assert.equal(db.audit[0].action, pairs[product('p1').status], 'whichever won, its audit entry is the one stored')
      })

      it('against a generic edit on the same version: exactly one is saved', async () => {
        armReadBarrier(2)
        const results = await Promise.all([
          comingSoon('p1', { reason: NOT_YET, expectedUpdatedAt: V0 }),
          call('PATCH', '/p1', { name: 'Edited name', expectedUpdatedAt: V0 }),
        ])
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
        assert.equal(db.audit.length, 1)
        const statusMoved = product('p1').status === 'COMING_SOON'
        assert.equal(product('p1').name === 'Edited name', !statusMoved, 'exactly one of the two changes is stored')
      })

      it('a save that lands between the read and the write is caught by the write itself', async () => {
        state.afterFirstRead = () => bumpVersion('p1', { monthlyPrice: new Decimal('6000') })
        const res = await comingSoon('p1', { reason: NOT_YET, expectedUpdatedAt: V0 })
        assert.equal(res.status, 409, JSON.stringify(res.json))
        assert.match(res.json.message, /at the same time/)
        assert.equal(product('p1').status, 'ACTIVE')
        assert.equal(product('p1').monthlyPrice.toString(), '6000', "the other admin's change is kept")
        assert.equal(db.audit.length, 0)
      })

      it('a retire that lands between the read and the write is caught by the status condition of the write', async () => {
        state.afterFirstRead = () => bumpVersion('p1', { status: 'INACTIVE' }) // read as ACTIVE, written against INACTIVE
        const res = await comingSoon('p1', { reason: NOT_YET, expectedUpdatedAt: V0 })
        assert.equal(res.status, 409, JSON.stringify(res.json))
        assert.equal(product('p1').status, 'INACTIVE')
        assert.equal(db.audit.length, 0)
      })
    })

    describe('audit atomicity', () => {
      it('if the audit entry cannot be written the product keeps its status and version, and a retry works', async () => {
        for (const id of ['p1', 'p4']) {
          const status = product(id).status
          const auditBefore = db.audit.length
          state.failAudit = new Error('audit store unavailable')
          const failed = await comingSoon(id, { reason: NOT_YET, expectedUpdatedAt: V0 })
          assert.equal(failed.status, 500, id)
          assert.equal(product(id).status, status, id)
          assert.equal(product(id).updatedAt.getTime(), T0.getTime(), `${id}: rolled back, so the version the page holds is still current`)
          assert.equal(db.audit.length, auditBefore, `${id}: the failed request left no audit entry`)

          assert.equal((await comingSoon(id, { reason: NOT_YET, expectedUpdatedAt: V0 })).status, 200, `${id}: retry`)
          assert.equal(product(id).status, 'COMING_SOON')
        }
        assert.equal(db.audit.length, 2)
      })

      it('a refused request never leaves an audit entry behind (invalid, stale, wrong state)', async () => {
        await comingSoon('p1', { expectedUpdatedAt: V0 })
        bumpVersion('p4')
        await comingSoon('p4', { reason: NOT_YET, expectedUpdatedAt: V0 })
        await comingSoon('p3', { reason: NOT_YET, expectedUpdatedAt: V0 })
        assert.equal(db.audit.length, 0)
        assert.equal(state.productWrites.length, 0)
      })
    })
  })

  describe('launch', () => {
    it('puts a coming-soon product on sale and records it, including who still has no access', async () => {
      const res = await launch('p3', { expectedUpdatedAt: V0 })
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.equal(res.json.message, 'Product launched')
      assert.equal(res.json.data.status, 'ACTIVE')
      assert.notEqual(res.json.data.updatedAt, V0)
      assert.equal(db.audit.length, 1)
      const [entry] = db.audit
      assert.equal(entry.action, 'SAAS_PRODUCT_LAUNCHED')
      assert.equal(entry.entityId, 'p3')
      assert.equal(entry.actorUserId, 'u-admin')
      assert.deepEqual(entry.metadata, { note: null, from: 'COMING_SOON', to: 'ACTIVE', impact: EMPTY_IMPACT_WITH_SIX_MISSING })
    })

    it('a note is optional, trimmed and recorded', async () => {
      await launch('p3', { note: '  Partner API is live  ', expectedUpdatedAt: V0 })
      assert.equal(db.audit[0].metadata.note, 'Partner API is live')
    })

    it('changes only the status and never grants access: approved resellers without access still have none', async () => {
      const before = related()
      const { status: _s, updatedAt: _u, ...restBefore } = product('p3')
      await launch('p3', { expectedUpdatedAt: V0 })
      const { status: _s2, updatedAt: _u2, ...restAfter } = product('p3')
      assert.equal(related(), before, 'no access record was created, and nothing else changed')
      assert.deepEqual(restAfter, restBefore)
      assert.deepEqual(state.productWrites.map((w) => w.data), [{ status: 'ACTIVE' }])
      assert.equal((await call('GET', '/p3/resellers-without-access')).json.data.total, 6)
    })

    it('an active or inactive product cannot be launched: 409, nothing written', async () => {
      for (const id of ['p1', 'p4']) {
        const res = await launch(id, { expectedUpdatedAt: V0 })
        assert.equal(res.status, 409, id)
        assert.equal(res.json.code, 'PRODUCT_LIFECYCLE_CONFLICT')
        assert.match(res.json.message, /only coming-soon products can be launched/)
      }
      assert.equal(state.productWrites.length, 0)
      assert.equal(db.audit.length, 0)
    })

    it('a stale version is 409, an unknown product 404, invalid input 422', async () => {
      bumpVersion('p3')
      const stale = await launch('p3', { expectedUpdatedAt: V0 })
      assert.equal(stale.status, 409)
      assert.equal(stale.json.code, 'PRODUCT_CHANGED')
      assert.equal((await launch('nope', { expectedUpdatedAt: V0 })).status, 404)
      const bad: unknown[] = [{}, { note: 'x'.repeat(501), expectedUpdatedAt: V0 }, { expectedUpdatedAt: V0, status: 'ACTIVE' }, { reason: NOT_YET, expectedUpdatedAt: V0 }, { expectedUpdatedAt: 'yesterday' }]
      for (const body of bad) assert.equal((await launch('p3', body)).status, 422, JSON.stringify(body).slice(0, 60))
      assert.equal(product('p3').status, 'COMING_SOON')
      assert.equal(db.audit.length, 0)
    })

    it('two admins at the same moment: exactly one succeeds, and one audit entry is written', async () => {
      armReadBarrier(2)
      const results = await Promise.all([launch('p3', { note: 'admin A', expectedUpdatedAt: V0 }), launch('p3', { note: 'admin B', expectedUpdatedAt: V0 })])
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
      assert.match(results.find((r) => r.status === 409)!.json.message, /at the same time/)
      assert.equal(db.audit.length, 1)
      assert.equal(state.productWrites.length, 1)
      assert.equal(product('p3').status, 'ACTIVE')
    })

    it('against a retire on the same version: exactly one is saved, and the audit entry matches the final status', async () => {
      armReadBarrier(2)
      const results = await Promise.all([launch('p3', { expectedUpdatedAt: V0 }), retire('p3', { reason: REASON, expectedUpdatedAt: V0 })])
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
      assert.equal(db.audit.length, 1)
      const pairs: Record<string, string> = { ACTIVE: 'SAAS_PRODUCT_LAUNCHED', INACTIVE: 'SAAS_PRODUCT_RETIRED' }
      assert.equal(db.audit[0].action, pairs[product('p3').status])
    })

    it('a save that lands between the read and the write is caught by the write itself', async () => {
      state.afterFirstRead = () => bumpVersion('p3', { trialDays: 30 })
      const res = await launch('p3', { expectedUpdatedAt: V0 })
      assert.equal(res.status, 409, JSON.stringify(res.json))
      assert.equal(product('p3').status, 'COMING_SOON')
      assert.equal(product('p3').trialDays, 30, "the other admin's change is kept")
      assert.equal(db.audit.length, 0)
    })

    it('if the audit entry cannot be written the product stays coming soon, at the same version, and a retry works', async () => {
      state.failAudit = new Error('audit store unavailable')
      assert.equal((await launch('p3', { expectedUpdatedAt: V0 })).status, 500)
      assert.equal(product('p3').status, 'COMING_SOON')
      assert.equal(product('p3').updatedAt.getTime(), T0.getTime())
      assert.equal(db.audit.length, 0)
      assert.equal((await launch('p3', { expectedUpdatedAt: V0 })).status, 200)
      assert.equal(db.audit.length, 1)
    })
  })

  describe('which actions each status accepts', () => {
    type Send = (id: string) => Promise<{ status: number; json: any }>
    const ACTIONS: Record<string, { send: Send; allowed: Record<string, string>; audit: string }> = {
      retire: { send: (id) => retire(id, { reason: REASON, expectedUpdatedAt: V0 }), allowed: { ACTIVE: 'INACTIVE', COMING_SOON: 'INACTIVE' }, audit: 'SAAS_PRODUCT_RETIRED' },
      restore: { send: (id) => restore(id, { expectedUpdatedAt: V0 }), allowed: { INACTIVE: 'ACTIVE' }, audit: 'SAAS_PRODUCT_RESTORED' },
      'coming-soon': { send: (id) => comingSoon(id, { reason: NOT_YET, expectedUpdatedAt: V0 }), allowed: { ACTIVE: 'COMING_SOON', INACTIVE: 'COMING_SOON' }, audit: 'SAAS_PRODUCT_SET_COMING_SOON' },
      launch: { send: (id) => launch(id, { expectedUpdatedAt: V0 }), allowed: { COMING_SOON: 'ACTIVE' }, audit: 'SAAS_PRODUCT_LAUNCHED' },
    }
    const PRODUCT_WITH: Record<string, string> = { ACTIVE: 'p1', COMING_SOON: 'p3', INACTIVE: 'p4' }

    for (const [action, def] of Object.entries(ACTIONS)) {
      for (const [from, id] of Object.entries(PRODUCT_WITH)) {
        const to = def.allowed[from]
        it(`${action} on a ${from} product: ${to ? `${from} → ${to}, audited` : '409, nothing written'}`, async () => {
          const before = related()
          const res = await def.send(id)
          if (to) {
            assert.equal(res.status, 200, JSON.stringify(res.json))
            assert.equal(product(id).status, to)
            assert.deepEqual(db.audit.map((a) => a.action), [def.audit])
            assert.deepEqual([db.audit[0].metadata.from, db.audit[0].metadata.to], [from, to])
          } else {
            assert.equal(res.status, 409, JSON.stringify(res.json))
            assert.equal(res.json.code, 'PRODUCT_LIFECYCLE_CONFLICT')
            assert.equal(product(id).status, from)
            assert.equal(state.productWrites.length, 0)
            assert.equal(db.audit.length, 0)
          }
          assert.equal(related(), before)
        })
      }
    }

    it('a pre-launch product can go through every state, each step needing the version the previous one returned', async () => {
      const before = related()
      let version = V0
      const step = async (send: (v: string) => Promise<{ status: number; json: any }>, expected: string) => {
        const res = await send(version)
        assert.equal(res.status, 200, JSON.stringify(res.json))
        assert.equal(res.json.data.status, expected)
        assert.notEqual(res.json.data.updatedAt, version)
        version = res.json.data.updatedAt
      }
      await step((v) => launch('p3', { expectedUpdatedAt: v }), 'ACTIVE')
      await step((v) => comingSoon('p3', { reason: NOT_YET, expectedUpdatedAt: v }), 'COMING_SOON')
      await step((v) => retire('p3', { reason: REASON, expectedUpdatedAt: v }), 'INACTIVE')
      await step((v) => comingSoon('p3', { reason: NOT_YET, expectedUpdatedAt: v }), 'COMING_SOON')
      await step((v) => launch('p3', { note: 'Finally live', expectedUpdatedAt: v }), 'ACTIVE')
      await step((v) => retire('p3', { reason: REASON, expectedUpdatedAt: v }), 'INACTIVE')
      await step((v) => restore('p3', { expectedUpdatedAt: v }), 'ACTIVE')

      assert.deepEqual(db.audit.map((a) => a.action), [
        'SAAS_PRODUCT_LAUNCHED',
        'SAAS_PRODUCT_SET_COMING_SOON',
        'SAAS_PRODUCT_RETIRED',
        'SAAS_PRODUCT_SET_COMING_SOON',
        'SAAS_PRODUCT_LAUNCHED',
        'SAAS_PRODUCT_RETIRED',
        'SAAS_PRODUCT_RESTORED',
      ])
      assert.deepEqual(db.audit.map((a) => `${a.metadata.from}>${a.metadata.to}`), [
        'COMING_SOON>ACTIVE',
        'ACTIVE>COMING_SOON',
        'COMING_SOON>INACTIVE',
        'INACTIVE>COMING_SOON',
        'COMING_SOON>ACTIVE',
        'ACTIVE>INACTIVE',
        'INACTIVE>ACTIVE',
      ])
      assert.deepEqual(state.productWrites.map((w) => Object.keys(w.data)), Array(7).fill(['status']), 'only the status was ever written')
      assert.equal(related(), before)
      const stale = await retire('p3', { reason: REASON, expectedUpdatedAt: V0 }) // a valid move from ACTIVE, but on a version from the start
      assert.equal(stale.status, 409)
      assert.equal(stale.json.code, 'PRODUCT_CHANGED')
      assert.equal(product('p3').status, 'ACTIVE')
    })
  })

  describe('reviewing resellers without access', () => {
    it('lists approved resellers that have no access record for this product, alphabetically', async () => {
      const res = await call('GET', '/p1/resellers-without-access')
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.equal(res.json.data.total, 2)
      assert.equal(res.json.data.limit, 200)
      assert.deepEqual(res.json.data.items.map((r: Row) => r.id), ['r6', 'r5'], 'Alpha Traders, Zeta Mobiles')
    })

    it('leaves out suspended or revoked access (deliberate decisions) and resellers that are not approved', async () => {
      const ids = (await call('GET', '/p1/resellers-without-access')).json.data.items.map((r: Row) => r.id)
      for (const id of ['r1', 'r2', 'r3', 'r4', 'r7', 'r8', 'r9']) assert.equal(ids.includes(id), false, id)
    })

    it('returns only what the review needs: no contact or identity data', async () => {
      const [first] = (await call('GET', '/p1/resellers-without-access')).json.data.items
      assert.deepEqual(Object.keys(first).sort(), ['approvedAt', 'businessName', 'code', 'id'])
    })

    it('is read-only, and an unknown product is 404', async () => {
      const before = related()
      await call('GET', '/p1/resellers-without-access')
      assert.equal((await call('GET', '/nope/resellers-without-access')).status, 404)
      assert.equal(related(), before)
      assert.equal(state.productWrites.length, 0)
      assert.equal(db.audit.length, 0)
    })
  })

  describe('unchanged behaviour', () => {
    it('the generic edit still cannot change status, to or from coming soon, and names the lifecycle actions instead', async () => {
      const attempts: Array<[string, string]> = [['p1', 'COMING_SOON'], ['p4', 'COMING_SOON'], ['p3', 'ACTIVE'], ['p3', 'INACTIVE'], ['p1', 'INACTIVE'], ['p4', 'ACTIVE']]
      for (const [id, status] of attempts) {
        const res = await call('PATCH', `/${id}`, { status, expectedUpdatedAt: V0 })
        assert.equal(res.status, 422, `${id} → ${status}: ${JSON.stringify(res.json)}`)
        assert.match(res.json.errors[0], /^status: Status cannot be changed/)
        assert.match(res.json.errors[0], /Set coming soon/)
        assert.match(res.json.errors[0], /Launch/)
      }
      assert.deepEqual([product('p1').status, product('p3').status, product('p4').status], ['ACTIVE', 'COMING_SOON', 'INACTIVE'])
      assert.equal(state.productWrites.length, 0)
      assert.equal(db.audit.length, 0)
    })

    it('the generic edit still works on its own and keeps its own audit format', async () => {
      const res = await call('PATCH', '/p1', { name: 'Hexalyte Salon Pro', expectedUpdatedAt: V0 })
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.equal(db.audit[0].action, 'SAAS_PRODUCT_UPDATED')
      assert.deepEqual(db.audit[0].metadata, { changes: { name: { from: 'Hexalyte Salon', to: 'Hexalyte Salon Pro' } } })
    })
  })
})
