import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { installHermeticBackend, serve, strictFake } from './helpers/hermetic-backend'

/**
 * Admin → SaaS products: a product's status changes only through Retire / Restore, never through the general edit.
 *   PATCH /admin/saas-products/:id          ordinary details; refuses a status different from the stored one (422)
 *   POST  /admin/saas-products/:id/retire   ACTIVE | COMING_SOON → INACTIVE: reason, impact snapshot, audit, version
 *   POST  /admin/saas-products/:id/restore  INACTIVE → ACTIVE: optional note, impact snapshot, audit, version
 *
 * Database-free (see tests/helpers/hermetic-backend.ts): the real router, auth, validation, services and audit code run
 * against an in-memory product store that behaves like PostgreSQL where it matters here:
 *  - `UPDATE … WHERE id = ? AND status = ? AND updatedAt = ?` is evaluated atomically against the row's current value;
 *  - every write moves `updatedAt` (as Prisma's @updatedAt does);
 *  - reads never wait, a conditional write checks and applies in one step, and a failed transaction undoes only its own writes.
 * The related tables (accounts, requests, commissions, access) are read-only counts: the lifecycle code has no way to
 * write to them here. Nothing here reads `.env`, runs Prisma or opens a connection.
 */

type Row = Record<string, any>
const T0 = new Date('2025-01-01T00:00:00.000Z')
const V0 = T0.toISOString()
let Decimal: typeof import('@prisma/client').Prisma.Decimal
const rows = new Map<string, Row>()
const state = {
  audit: [] as Row[],
  /** Every product write: the WHERE condition and the data actually sent. */
  writes: [] as Array<{ where: Row; data: Row }>,
  reads: 0,
  /** Runs once, right after the first product read: lets a test play "someone else saved in between". */
  afterFirstRead: undefined as (() => void) | undefined,
  /** While armed, every product read waits until `n` reads have happened: the requests are truly in flight together. */
  barrier: undefined as (() => Promise<void>) | undefined,
}

function armReadBarrier(n: number) {
  let arrived = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  state.barrier = async () => {
    if (++arrived >= n) release()
    // Bounded, so a request that never gets here fails the test's assertions instead of hanging the file.
    await Promise.race([gate, new Promise<void>((resolve) => setTimeout(resolve, 2_000).unref())])
  }
}

const definedOnly = (o: object) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b)
const project = (row: Row | undefined, select?: Row) =>
  row ? (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : { ...row }) : null

/** Any save of the product (this module, an integration change, a health check) moves updatedAt. */
const bump = (row: Row) => (row.updatedAt = new Date(row.updatedAt.getTime() + 60_000))

interface TxContext {
  undo: Array<() => void>
}

/** One write, as PostgreSQL would run it: UPDATE … WHERE id = ? AND <other conditions>. Returns how many rows matched. */
function write(where: Row, data: Row, ctx: TxContext) {
  const { id, ...conditions } = where
  const row = rows.get(id)
  if (!row || Object.entries(conditions).some(([k, v]) => v !== undefined && !same(row[k], v))) return 0
  const previous = { ...row }
  ctx.undo.push(() => rows.set(id, previous))
  state.writes.push({ where, data })
  const stored: Row = definedOnly(data)
  if (stored.monthlyPrice !== undefined) stored.monthlyPrice = new Decimal(stored.monthlyPrice) // Prisma returns Decimals
  Object.assign(row, stored)
  bump(row)
  return 1
}

const productFindUnique = async ({ where, select }: { where: { id?: string; code?: string }; select?: Row }) => {
  const row = where.id ? rows.get(where.id) : [...rows.values()].find((r) => r.code === where.code)
  const found = project(row, select)
  if (++state.reads === 1 && state.afterFirstRead) {
    const hook = state.afterFirstRead
    state.afterFirstRead = undefined
    hook()
  }
  if (state.barrier) await state.barrier()
  return found
}

/** The counts the impact review reads. Read-only: there is no write method for any of these models. */
const reads = {
  customerAccount: { groupBy: async () => [{ status: 'ACTIVE', _count: { _all: 3 } }, { status: 'TRIAL', _count: { _all: 2 } }] },
  activationRequest: { count: async () => 1 },
  demoRequest: { groupBy: async () => [] },
  commission: { groupBy: async () => [] },
  resellerProductAccess: { count: async () => 2 },
  reseller: { count: async () => 4 },
}
const IMPACT = {
  customerAccounts: { active: 3, trial: 2, pending: 0 },
  openActivationRequests: 1,
  openDemoRequests: { total: 0, awaitingConfirmation: 0 },
  unpaidCommissions: { count: 0, totals: [] },
  resellers: { withAccess: 2, approvedWithoutAccess: 4 },
}

const txModels = (ctx: TxContext) => ({
  ...reads,
  saasProduct: {
    findUnique: productFindUnique,
    updateMany: async ({ where, data }: { where: Row; data: Row }) => ({ count: write(where, data, ctx) }),
    create: async ({ data }: { data: Row }) => {
      const { integration: _integration, ...fields } = data
      const row: Row = {
        id: 'p-new', description: null, trialDays: null, createdAt: T0, updatedAt: T0, integration: null, _count: { resellerAccess: 0, accounts: 0 },
        ...fields, monthlyPrice: new Decimal(fields.monthlyPrice),
      }
      rows.set(row.id, row)
      ctx.undo.push(() => rows.delete(row.id))
      return { id: row.id, code: row.code }
    },
  },
  auditLog: {
    create: async ({ data }: { data: Row }) => {
      const entry = { ...data }
      state.audit.push(entry)
      ctx.undo.push(() => state.audit.splice(state.audit.indexOf(entry), 1))
      return data
    },
  },
})

const USERS: Record<string, Row> = {
  'u-admin': { id: 'u-admin', email: 'admin@test.invalid', role: 'ADMIN', status: 'ACTIVE', emailVerified: null, resellerId: null, reseller: null },
  'u-disabled-admin': { id: 'u-disabled-admin', email: 'old-admin@test.invalid', role: 'ADMIN', status: 'SUSPENDED', emailVerified: null, resellerId: null, reseller: null },
  'u-seller': { id: 'u-seller', email: 'seller@test.invalid', role: 'SELLER', status: 'ACTIVE', emailVerified: new Date(), resellerId: 'r1', reseller: { status: 'ACTIVE' } },
  'u-pending': { id: 'u-pending', email: 'pending@test.invalid', role: 'SELLER', status: 'ACTIVE', emailVerified: new Date(), resellerId: 'r2', reseller: { status: 'PENDING' } },
  'u-suspended': { id: 'u-suspended', email: 'suspended@test.invalid', role: 'SELLER', status: 'ACTIVE', emailVerified: new Date(), resellerId: 'r3', reseller: { status: 'SUSPENDED' } },
}
type Who = keyof typeof USERS

const fakePrisma = strictFake('prisma', {
  user: { findUnique: async ({ where }: { where: { id: string } }) => USERS[where.id] ?? null },
  saasProduct: { findUnique: productFindUnique },
  $transaction: async <T>(fn: (t: object) => Promise<T>): Promise<T> => {
    const ctx: TxContext = { undo: [] }
    try {
      return await fn(strictFake('tx', txModels(ctx)))
    } catch (err) {
      for (const undo of ctx.undo.reverse()) undo()
      throw err
    }
  },
})

const STATUSES = ['ACTIVE', 'INACTIVE', 'COMING_SOON'] as const
const REASON = 'Replaced by the new Salon Pro product'
const NOT_YET = 'Waiting for the partner API to go live'

describe('Admin SaaS products: status changes only through Retire / Restore', () => {
  let api: Awaited<ReturnType<typeof serve>>
  let signAccessToken: typeof import('../src/utils/jwt')['signAccessToken']
  let createProductSchema: typeof import('../src/modules/products/product.schema')['createProductSchema']

  const token = (who: Who) => signAccessToken({ userId: who, email: USERS[who].email, role: USERS[who].role, resellerId: USERS[who].resellerId })
  const patch = (body: unknown, who: Who = 'u-admin', id = 'p1') => api.call('PATCH', `/admin/saas-products/${id}`, { token: token(who), body })
  const retire = (body: unknown, who: Who = 'u-admin') => api.call('POST', '/admin/saas-products/p1/retire', { token: token(who), body })
  const restore = (body: unknown, who: Who = 'u-admin') => api.call('POST', '/admin/saas-products/p1/restore', { token: token(who), body })
  const lifecycle = (id: string, action: 'retire' | 'restore' | 'coming-soon' | 'launch', body: unknown, who: Who = 'u-admin') =>
    api.call('POST', `/admin/saas-products/${id}/${action}`, { token: token(who), body })
  const product = () => rows.get('p1')!
  const version = () => product().updatedAt.toISOString() as string
  /** Everything about the stored product, so "nothing changed" is one comparison. */
  const snapshot = () => JSON.stringify(product())
  const actions = () => state.audit.map((a) => a.action)
  /** What the admin page sends on Save: every editable field of the product it was opened on (no status). */
  const pageForm = (over: Row = {}) => {
    const p = product()
    return {
      name: p.name,
      description: p.description,
      monthlyPrice: Number(p.monthlyPrice),
      trialAvailable: p.trialAvailable,
      trialDays: p.trialAvailable ? p.trialDays : null,
      ...over,
    }
  }
  const seed = (status: string = 'ACTIVE', over: Row = {}) => {
    rows.clear()
    rows.set('p1', {
      id: 'p1',
      code: 'SALON',
      name: 'Hexalyte Salon',
      description: null,
      status,
      monthlyPrice: new Decimal('5500'),
      currency: 'LKR',
      trialAvailable: false,
      trialDays: null,
      integrationStatus: 'CONFIGURED',
      createdAt: T0,
      updatedAt: T0,
      integration: null,
      _count: { resellerAccess: 2, accounts: 3 },
      ...over,
    })
  }
  const assertStatusRefused = (res: Awaited<ReturnType<typeof patch>>) => {
    assert.equal(res.status, 422, JSON.stringify(res.json))
    assert.equal(res.json.message, 'Validation error')
    assert.equal(res.json.errors.length, 1)
    assert.match(res.json.errors[0], /^status: Status cannot be changed/)
    for (const action of ['Retire', 'Restore', 'Set coming soon', 'Launch']) assert.match(res.json.errors[0], new RegExp(action))
  }

  before(async () => {
    installHermeticBackend(fakePrisma)
    ;({ signAccessToken } = await import('../src/utils/jwt'))
    ;({ Prisma: { Decimal } } = await import('@prisma/client'))
    ;({ createProductSchema } = await import('../src/modules/products/product.schema'))
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
    state.audit.length = 0
    state.writes.length = 0
    state.reads = 0
    state.afterFirstRead = undefined
    state.barrier = undefined
  })

  describe('a direct status change through PATCH is refused', () => {
    for (const from of STATUSES) {
      for (const to of STATUSES.filter((s) => s !== from)) {
        it(`${from} → ${to}: 422, and nothing is written, audited or retired`, async () => {
          seed(from)
          const before = snapshot()
          assertStatusRefused(await patch({ status: to }))
          assert.equal(snapshot(), before)
          assert.equal(state.writes.length, 0)
          assert.deepEqual(actions(), [])
        })
      }
    }

    it('refuses the whole request: the other fields in it are not saved either', async () => {
      const before = snapshot()
      assertStatusRefused(await patch(pageForm({ name: 'Renamed', monthlyPrice: 9000, status: 'INACTIVE' })))
      assert.equal(snapshot(), before)
      assert.equal(state.writes.length, 0)
      assert.deepEqual(actions(), [])
    })

    it('is not turned into a retire: a reason beside the status is an unknown field, and nothing is retired', async () => {
      const before = snapshot()
      const res = await patch({ status: 'INACTIVE', reason: REASON })
      assert.equal(res.status, 422, JSON.stringify(res.json))
      assert.match(JSON.stringify(res.json.errors), /reason/i)
      assert.equal(product().status, 'ACTIVE')
      assert.equal(snapshot(), before)
      assert.deepEqual(actions(), [], 'no SAAS_PRODUCT_RETIRED (or any other) entry')
    })

    it('is not turned into a restore either', async () => {
      seed('INACTIVE')
      assertStatusRefused(await patch({ status: 'ACTIVE' }))
      const withNote = await patch({ status: 'ACTIVE', note: 'back on sale' })
      assert.equal(withNote.status, 422, JSON.stringify(withNote.json))
      assert.match(JSON.stringify(withNote.json.errors), /note/i, 'a note is an unknown field of a general edit')
      assert.equal(product().status, 'INACTIVE')
      assert.equal(state.writes.length, 0)
      assert.deepEqual(actions(), [])
    })

    it('a version does not make it allowed, and the refused request does not use the version up', async () => {
      assertStatusRefused(await patch({ status: 'INACTIVE', expectedUpdatedAt: V0 }))
      assert.equal(version(), V0, 'nothing was saved, so the version is unchanged')
      assert.equal((await patch({ name: 'Renamed', expectedUpdatedAt: V0 })).status, 200, 'the same version still works for a real edit')
    })

    it('an unknown, empty or wrongly written status is a validation error, not a status change', async () => {
      for (const bad of [null, '', 'RETIRED', 'inactive', 'Active', 1, true, ['INACTIVE']]) {
        const res = await patch({ status: bad })
        assert.equal(res.status, 422, `status=${JSON.stringify(bad)}`)
      }
      assert.equal(product().status, 'ACTIVE')
      assert.equal(state.writes.length, 0)
    })
  })

  describe('ordinary product-detail edits keep working', () => {
    it('the admin page payload (no status) saves, records only what changed, and leaves the status alone', async () => {
      const res = await patch(pageForm({ name: 'Hexalyte Salon Pro', description: 'Salon POS', monthlyPrice: 6000, trialAvailable: true, trialDays: 14, expectedUpdatedAt: V0 }))
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.equal(res.json.message, 'Product updated')
      assert.equal(product().status, 'ACTIVE')
      assert.deepEqual(actions(), ['SAAS_PRODUCT_UPDATED'])
      assert.deepEqual(state.audit[0].metadata.changes, {
        name: { from: 'Hexalyte Salon', to: 'Hexalyte Salon Pro' },
        description: { from: '', to: 'Salon POS' },
        monthlyPrice: { from: '5500', to: '6000' },
        trialAvailable: { from: 'false', to: 'true' },
        trialDays: { from: '', to: '14' },
      })
      assert.deepEqual(Object.keys(state.writes[0].data).sort(), ['description', 'monthlyPrice', 'name', 'trialAvailable', 'trialDays'])
    })

    for (const status of STATUSES) {
      it(`a ${status} product can be edited, also by a form that repeats its status; the status is never written`, async () => {
        seed(status)
        const res = await patch(pageForm({ name: 'Renamed', monthlyPrice: 6000, status }))
        assert.equal(res.status, 200, JSON.stringify(res.json))
        assert.equal(product().status, status)
        assert.equal(product().name, 'Renamed')
        assert.deepEqual(Object.keys(state.writes[0].data).sort(), ['monthlyPrice', 'name'])
        assert.deepEqual(Object.keys(state.audit[0].metadata.changes).sort(), ['monthlyPrice', 'name'])
        assert.equal(res.json.data.status, status)
      })
    }

    it('a request that only repeats the current status is a no-op: no write, no audit entry, same version', async () => {
      const res = await patch({ status: 'ACTIVE' })
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.equal(state.writes.length, 0)
      assert.deepEqual(actions(), [])
      assert.equal(version(), V0)
    })

    it('a retired product can still be edited and stays retired', async () => {
      assert.equal((await retire({ reason: REASON, expectedUpdatedAt: V0 })).status, 200)
      const res = await patch({ description: 'Retired; kept for history', expectedUpdatedAt: version() })
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.equal(product().status, 'INACTIVE')
      assert.deepEqual(actions(), ['SAAS_PRODUCT_RETIRED', 'SAAS_PRODUCT_UPDATED'])
    })

    it('the existing edit rules are unchanged: empty body, unknown fields, immutable code, trial days', async () => {
      assert.equal((await patch({})).status, 422)
      assert.equal((await patch({ code: 'OTHER' })).status, 422)
      assert.equal((await patch({ name: 'x' })).status, 422)
      assert.equal((await patch({ trialDays: 30 })).status, 422, 'days on a product without a trial')
      assert.equal(state.writes.length, 0)
    })
  })

  describe('Retire and Restore remain the way to change status', () => {
    it('retire (reason, impact review, audit) then restore, with nothing else in the audit trail', async () => {
      assertStatusRefused(await patch({ status: 'INACTIVE' }))
      assert.equal(product().status, 'ACTIVE')

      const retired = await retire({ reason: REASON, expectedUpdatedAt: V0 })
      assert.equal(retired.status, 200, JSON.stringify(retired.json))
      assert.equal(retired.json.message, 'Product retired')
      assert.equal(product().status, 'INACTIVE')
      assert.equal(retired.json.data.status, 'INACTIVE')
      assert.equal(state.audit[0].action, 'SAAS_PRODUCT_RETIRED')
      assert.equal(state.audit[0].entityId, 'p1')
      assert.equal(state.audit[0].actorUserId, 'u-admin')
      assert.deepEqual(state.audit[0].metadata, { reason: REASON, from: 'ACTIVE', to: 'INACTIVE', impact: IMPACT })

      assertStatusRefused(await patch({ status: 'ACTIVE' })) // direct restore is refused too
      assert.equal(product().status, 'INACTIVE')

      const restored = await restore({ note: 'Back on sale', expectedUpdatedAt: version() })
      assert.equal(restored.status, 200, JSON.stringify(restored.json))
      assert.equal(restored.json.message, 'Product restored')
      assert.equal(product().status, 'ACTIVE')
      assert.equal(state.audit[1].action, 'SAAS_PRODUCT_RESTORED')
      assert.deepEqual(state.audit[1].metadata, { note: 'Back on sale', from: 'INACTIVE', to: 'ACTIVE', impact: IMPACT })

      assert.deepEqual(actions(), ['SAAS_PRODUCT_RETIRED', 'SAAS_PRODUCT_RESTORED'])
      assert.deepEqual(state.writes.map((w) => w.data), [{ status: 'INACTIVE' }, { status: 'ACTIVE' }], 'only the status was written, by the lifecycle')
    })

    it('set coming soon and launch are the way to and from coming soon; the same moves through PATCH stay refused', async () => {
      assertStatusRefused(await patch({ status: 'COMING_SOON' }))
      const soon = await lifecycle('p1', 'coming-soon', { reason: NOT_YET, expectedUpdatedAt: V0 })
      assert.equal(soon.status, 200, JSON.stringify(soon.json))
      assert.equal(product().status, 'COMING_SOON')
      assert.deepEqual(state.audit[0].metadata, { reason: NOT_YET, from: 'ACTIVE', to: 'COMING_SOON', impact: IMPACT })

      assertStatusRefused(await patch({ status: 'ACTIVE' })) // a direct launch is refused too
      assert.equal(product().status, 'COMING_SOON')

      const launched = await lifecycle('p1', 'launch', { note: 'Live', expectedUpdatedAt: version() })
      assert.equal(launched.status, 200, JSON.stringify(launched.json))
      assert.equal(product().status, 'ACTIVE')
      assert.deepEqual(state.audit[1].metadata, { note: 'Live', from: 'COMING_SOON', to: 'ACTIVE', impact: IMPACT })
      assert.deepEqual(actions(), ['SAAS_PRODUCT_SET_COMING_SOON', 'SAAS_PRODUCT_LAUNCHED'])
      assert.deepEqual(state.writes.map((w) => w.data), [{ status: 'COMING_SOON' }, { status: 'ACTIVE' }])
    })

    it('their safeguards are unchanged: a reason and the current version are required; a wrong state is refused', async () => {
      const before = snapshot()
      assert.equal((await retire({ expectedUpdatedAt: V0 })).status, 422, 'no reason')
      assert.equal((await retire({ reason: 'too short', expectedUpdatedAt: V0 })).status, 422)
      assert.equal((await retire({ reason: REASON })).status, 422, 'no version')
      assert.equal((await retire({ reason: REASON, expectedUpdatedAt: V0, status: 'ACTIVE' })).status, 422, 'unknown field')
      const wrongState = await restore({ expectedUpdatedAt: V0 }) // an ACTIVE product cannot be restored
      assert.equal(wrongState.status, 409)
      assert.equal(wrongState.json.code, 'PRODUCT_LIFECYCLE_CONFLICT')
      assert.equal(snapshot(), before)
      assert.deepEqual(actions(), [])
    })

    it('the version a retire returns is the one the next edit needs; the one from before it is stale', async () => {
      const retired = await retire({ reason: REASON, expectedUpdatedAt: V0 })
      assert.notEqual(retired.json.data.updatedAt, V0)
      assert.equal((await patch({ name: 'After retire', expectedUpdatedAt: V0 })).status, 409)
      assert.equal((await patch({ name: 'After retire', expectedUpdatedAt: retired.json.data.updatedAt })).status, 200)
      assert.equal(product().name, 'After retire')
      assert.equal(product().status, 'INACTIVE')
    })
  })

  describe('stale and simultaneous requests', () => {
    it('an older form that still repeats the old status cannot reactivate a retired product: 409, nothing saved', async () => {
      const opened = { ...pageForm(), status: 'ACTIVE', expectedUpdatedAt: V0 } // opened before the retire, by an older page build
      assert.equal((await retire({ reason: REASON, expectedUpdatedAt: V0 })).status, 200)
      const writes = state.writes.length
      const audit = state.audit.length

      const res = await patch({ ...opened, name: 'Stale rename' })
      assert.equal(res.status, 409, JSON.stringify(res.json))
      assert.match(res.json.message, /changed/i)
      assert.equal(product().status, 'INACTIVE')
      assert.equal(product().name, 'Hexalyte Salon')
      assert.equal(state.writes.length, writes)
      assert.equal(state.audit.length, audit)
    })

    it('an older form cannot undo a coming-soon change or a launch either: 409 with its version, 422 without', async () => {
      const opened = { ...pageForm(), status: 'ACTIVE', expectedUpdatedAt: V0 }
      assert.equal((await lifecycle('p1', 'coming-soon', { reason: NOT_YET, expectedUpdatedAt: V0 })).status, 200)
      const stale = await patch({ ...opened, name: 'Stale rename' })
      assert.equal(stale.status, 409, JSON.stringify(stale.json))
      const { expectedUpdatedAt: _v, ...noVersion } = opened
      assertStatusRefused(await patch({ ...noVersion, name: 'Stale rename' })) // its ACTIVE no longer matches COMING_SOON
      assert.equal(product().status, 'COMING_SOON')
      assert.equal(product().name, 'Hexalyte Salon')

      assert.equal((await lifecycle('p1', 'launch', { expectedUpdatedAt: version() })).status, 200)
      assert.equal((await patch({ ...opened, name: 'Stale rename' })).status, 409, 'the form from before both changes is long stale')
      assert.equal(product().status, 'ACTIVE')
      assert.equal(product().name, 'Hexalyte Salon')
    })

    it('the same form without a version is still refused, because its status no longer matches (422), not applied', async () => {
      assert.equal((await retire({ reason: REASON, expectedUpdatedAt: V0 })).status, 200)
      const before = snapshot()
      assertStatusRefused(await patch({ ...pageForm({ name: 'Stale rename' }), status: 'ACTIVE' }))
      assert.equal(snapshot(), before)
      assert.equal(product().status, 'INACTIVE')
    })

    it('a stale request that also names a different status is reported as stale (409) so the page reloads first', async () => {
      assert.equal((await patch({ name: 'By A', expectedUpdatedAt: V0 })).status, 200)
      const before = snapshot()
      assert.equal((await patch({ status: 'INACTIVE', expectedUpdatedAt: V0 })).status, 409)
      assert.equal(snapshot(), before)
    })

    it("a retire that lands between this edit's read and its write fails the edit (409), even without a version", async () => {
      state.afterFirstRead = () => {
        Object.assign(product(), { status: 'INACTIVE' })
        bump(product())
      }
      const res = await patch({ name: 'Renamed', status: 'ACTIVE' }) // read as ACTIVE, written against INACTIVE
      assert.equal(res.status, 409, JSON.stringify(res.json))
      assert.equal(product().status, 'INACTIVE', 'still retired')
      assert.equal(product().name, 'Hexalyte Salon')
      assert.equal(state.writes.length, 0)
      assert.deepEqual(actions(), [], 'the rolled-back request left no audit entry')
    })

    it('an edit and a retire on the same version: exactly one is saved, the other is told to reload', async () => {
      armReadBarrier(2) // both have read version V0 before either writes
      const results = await Promise.all([patch({ name: 'Edited', expectedUpdatedAt: V0 }), retire({ reason: REASON, expectedUpdatedAt: V0 })])
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
      assert.equal(state.audit.length, 1)
      const retireWon = product().status === 'INACTIVE'
      assert.equal(retireWon, state.audit[0].action === 'SAAS_PRODUCT_RETIRED')
      assert.equal(product().name === 'Edited', !retireWon, 'exactly one of the two changes is stored')
    })

    it('five simultaneous retires on one version: one wins, four are told the product changed', async () => {
      armReadBarrier(5)
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => retire({ reason: REASON, expectedUpdatedAt: V0 })))
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409, 409, 409])
      assert.deepEqual(actions(), ['SAAS_PRODUCT_RETIRED'])
    })
  })

  describe('authorization', () => {
    const attempts: Array<[string, object]> = [
      ['a status change', { status: 'INACTIVE' }],
      ['a status change with a version', { status: 'INACTIVE', expectedUpdatedAt: V0 }],
      ['an ordinary edit', { name: 'Renamed' }],
      ['an ordinary edit with a version', { name: 'Renamed', expectedUpdatedAt: V0 }],
    ]

    for (const [label, body] of attempts) {
      it(`${label}: no token 401, a malformed token 401, a disabled admin 401`, async () => {
        const before = snapshot()
        assert.equal((await api.call('PATCH', '/admin/saas-products/p1', { body })).status, 401)
        assert.equal((await api.call('PATCH', '/admin/saas-products/p1', { token: 'not.a.token', body })).status, 401)
        assert.equal((await patch(body, 'u-disabled-admin')).status, 401)
        assert.equal(snapshot(), before)
        assert.equal(state.writes.length, 0)
      })

      it(`${label}: an approved reseller user, a pending one and a suspended one are all 403`, async () => {
        const before = snapshot()
        for (const who of ['u-seller', 'u-pending', 'u-suspended'] as const) {
          const res = await patch(body, who)
          assert.equal(res.status, 403, `${who}: ${JSON.stringify(res.json)}`)
          assert.doesNotMatch(JSON.stringify(res.json), /Retire|Restore/, 'permission is checked before the body, so the status rule is not revealed')
        }
        assert.equal(snapshot(), before)
        assert.equal(state.writes.length, 0)
        assert.deepEqual(actions(), [])
      })
    }

    it('a reseller user cannot retire or restore either (unchanged)', async () => {
      const before = snapshot()
      assert.equal((await retire({ reason: REASON, expectedUpdatedAt: V0 }, 'u-seller')).status, 403)
      assert.equal((await restore({ expectedUpdatedAt: V0 }, 'u-seller')).status, 403)
      assert.equal(snapshot(), before)
      assert.deepEqual(actions(), [])
    })

    it('an unknown product is 404 before the status rule applies, and a reseller user does not learn that it exists', async () => {
      assert.equal((await patch({ status: 'INACTIVE' }, 'u-admin', 'nope')).status, 404)
      assert.equal((await patch({ status: 'INACTIVE' }, 'u-seller', 'nope')).status, 403)
    })
  })

  describe('create keeps its defaults', () => {
    const create = (body: object, who: Who = 'u-admin') => api.call('POST', '/admin/saas-products', { token: token(who), body })

    it('a new product is INACTIVE unless a status is given, with LKR and no trial', () => {
      const parsed = createProductSchema.parse({ code: 'pharmacy', name: 'Pharmacy', monthlyPrice: 5500 })
      assert.deepEqual(
        [parsed.code, parsed.status, parsed.currency, parsed.trialAvailable],
        ['PHARMACY', 'INACTIVE', 'LKR', false],
      )
      for (const status of STATUSES) {
        assert.equal(createProductSchema.parse({ code: 'PHARMACY', name: 'Pharmacy', monthlyPrice: 5500, status }).status, status)
      }
    })

    it('POST creates it as INACTIVE by default (201) and honours an explicit status; the audit entry says so', async () => {
      const made = await create({ code: 'PHARMACY', name: 'Pharmacy', monthlyPrice: 5500 })
      assert.equal(made.status, 201, JSON.stringify(made.json))
      assert.equal(made.json.data.status, 'INACTIVE')
      assert.equal(rows.get('p-new')!.status, 'INACTIVE')
      assert.equal(state.audit[0].action, 'SAAS_PRODUCT_CREATED')
      assert.equal(state.audit[0].metadata.status, 'INACTIVE')

      rows.delete('p-new')
      const soon = await create({ code: 'GROCERY', name: 'Grocery', monthlyPrice: 5500, status: 'COMING_SOON' })
      assert.equal(soon.status, 201, JSON.stringify(soon.json))
      assert.equal(soon.json.data.status, 'COMING_SOON')
    })

    it('a product created as COMING_SOON is launched with Launch; one created with the default is set to coming soon first', async () => {
      const soon = await create({ code: 'GROCERY', name: 'Grocery', monthlyPrice: 5500, status: 'COMING_SOON' })
      assert.equal(soon.status, 201, JSON.stringify(soon.json))
      const launched = await lifecycle('p-new', 'launch', { expectedUpdatedAt: soon.json.data.updatedAt })
      assert.equal(launched.status, 200, JSON.stringify(launched.json))
      assert.equal(rows.get('p-new')!.status, 'ACTIVE')
      assert.deepEqual(actions(), ['SAAS_PRODUCT_CREATED', 'SAAS_PRODUCT_LAUNCHED'])

      rows.delete('p-new')
      state.audit.length = 0
      const made = await create({ code: 'PHARMACY', name: 'Pharmacy', monthlyPrice: 5500 })
      assert.equal(made.json.data.status, 'INACTIVE')
      assert.equal((await lifecycle('p-new', 'launch', { expectedUpdatedAt: made.json.data.updatedAt })).status, 409, 'an inactive product is not launched')
      const set = await lifecycle('p-new', 'coming-soon', { reason: NOT_YET, expectedUpdatedAt: made.json.data.updatedAt })
      assert.equal(set.status, 200, JSON.stringify(set.json))
      assert.equal((await lifecycle('p-new', 'launch', { expectedUpdatedAt: set.json.data.updatedAt })).status, 200)
      assert.equal(rows.get('p-new')!.status, 'ACTIVE')
      assert.deepEqual(actions(), ['SAAS_PRODUCT_CREATED', 'SAAS_PRODUCT_SET_COMING_SOON', 'SAAS_PRODUCT_LAUNCHED'])
    })

    it('creating is still admin-only', async () => {
      assert.equal((await create({ code: 'PHARMACY', name: 'Pharmacy', monthlyPrice: 5500 }, 'u-seller')).status, 403)
      assert.equal(rows.has('p-new'), false)
    })
  })
})
