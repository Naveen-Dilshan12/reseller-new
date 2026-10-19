import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { installHermeticBackend, serve, strictFake } from './helpers/hermetic-backend'

/**
 * Admin → SaaS products: an edit based on an older copy of the product must not overwrite a newer save.
 * The version is the product's `updatedAt` as the client last saw it, sent as `expectedUpdatedAt` on
 * `PATCH /admin/saas-products/:id` and compared inside the UPDATE itself.
 *
 * Database-free (see tests/helpers/hermetic-backend.ts): the real router, auth, validation and service run against an
 * in-memory product store that behaves like PostgreSQL where it matters here:
 *  - `UPDATE … WHERE id = ? AND updatedAt = ?` is evaluated atomically against the row's current value;
 *  - every write moves `updatedAt` (as Prisma's @updatedAt does), and the column keeps millisecond precision;
 *  - transactions run one at a time, like row locks, and a failed one is rolled back.
 * It cannot prove Postgres itself; it proves the code asks the database the right question. Nothing here reads
 * `.env`, runs Prisma or opens a connection.
 */

type Row = Record<string, any>
const T0 = new Date('2025-01-01T00:00:00.000Z')
let Decimal: typeof import('@prisma/client').Prisma.Decimal
const rows = new Map<string, Row>()
const state = {
  audit: [] as Row[],
  writes: [] as Array<{ where: Row; data: Row }>,
  reads: 0,
  /** Runs once, right after the service's first product read: lets a test play "someone saved in between". */
  afterFirstRead: undefined as (() => void) | undefined,
  /** While armed, every product read waits until `n` reads have happened: the requests are truly in flight together. */
  barrier: undefined as (() => Promise<void>) | undefined,
}

/** Makes `n` concurrent requests all read the product before any of them can write (so none sees another's save). */
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

function write(where: Row, data: Row) {
  const { id, ...conditions } = where
  const row = rows.get(id)
  if (!row || Object.entries(conditions).some(([k, v]) => v !== undefined && !same(row[k], v))) return 0
  state.writes.push({ where, data })
  const stored: Row = definedOnly(data)
  if (stored.monthlyPrice !== undefined) stored.monthlyPrice = new Decimal(stored.monthlyPrice)
  Object.assign(row, stored)
  bump(row)
  return 1
}

const tx = {
  saasProduct: {
    updateMany: async ({ where, data }: { where: Row; data: Row }) => ({ count: write(where, data) }),
    update: async ({ where, data }: { where: Row; data: Row }) => {
      if (write(where, data) === 0) throw new Error('Record to update not found')
      return rows.get(where.id)
    },
  },
  auditLog: {
    create: async ({ data }: { data: Row }) => {
      state.audit.push({ ...data })
      return data
    },
  },
}

const USERS: Record<string, Row> = {
  'u-admin': { id: 'u-admin', email: 'admin@test.invalid', role: 'ADMIN', status: 'ACTIVE', emailVerified: null, resellerId: null, reseller: null },
  'u-seller': { id: 'u-seller', email: 'seller@test.invalid', role: 'SELLER', status: 'ACTIVE', emailVerified: new Date(), resellerId: 'r1', reseller: { status: 'ACTIVE' } },
}

let queue: Promise<unknown> = Promise.resolve()
const fakePrisma = strictFake('prisma', {
  user: { findUnique: async ({ where }: { where: { id: string } }) => USERS[where.id] ?? null },
  saasProduct: {
    findUnique: async ({ where, select }: { where: { id: string }; select?: Row }) => {
      const found = project(rows.get(where.id), select)
      if (++state.reads === 1 && state.afterFirstRead) {
        const hook = state.afterFirstRead
        state.afterFirstRead = undefined
        hook()
      }
      if (state.barrier) await state.barrier()
      return found
    },
  },
  $transaction: <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => {
    const run = async () => {
      const snapshot = new Map([...rows].map(([k, v]) => [k, { ...v }] as const))
      const auditLength = state.audit.length
      try {
        return await fn(tx)
      } catch (err) {
        rows.clear()
        snapshot.forEach((v, k) => rows.set(k, v))
        state.audit.length = auditLength
        throw err
      }
    }
    const result = queue.then(run, run) // one transaction at a time, like row locks on the same product
    queue = result.catch(() => undefined)
    return result
  },
})

describe('Admin SaaS products: stale edits (optimistic concurrency)', () => {
  let api: Awaited<ReturnType<typeof serve>>
  let signAccessToken: typeof import('../src/utils/jwt')['signAccessToken']

  const token = (id: 'u-admin' | 'u-seller') => signAccessToken({ userId: id, email: USERS[id].email, role: USERS[id].role, resellerId: USERS[id].resellerId })
  const patch = (body: unknown, who: 'u-admin' | 'u-seller' = 'u-admin', id = 'p1') =>
    api.call('PATCH', `/admin/saas-products/${id}`, { token: token(who), body })
  const get = () => api.call('GET', '/admin/saas-products/p1', { token: token('u-admin') })
  const product = () => rows.get('p1')!
  const version = () => product().updatedAt.toISOString() as string
  /** What the admin page sends: every editable field of the copy it was opened on (status is changed by Retire / Restore). */
  const formFrom = (copy: Row, over: Row = {}) => ({
    name: copy.name,
    description: copy.description,
    monthlyPrice: Number(copy.monthlyPrice),
    trialAvailable: copy.trialAvailable,
    trialDays: copy.trialAvailable ? copy.trialDays : null,
    ...over,
  })

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
    rows.clear()
    rows.set('p1', {
      id: 'p1',
      code: 'SALON',
      name: 'Hexalyte Salon',
      description: null,
      status: 'ACTIVE',
      monthlyPrice: new Decimal('5500'),
      currency: 'LKR',
      trialAvailable: false,
      trialDays: null,
      integrationStatus: 'CONFIGURED',
      createdAt: T0,
      updatedAt: T0,
      integration: null,
      _count: { resellerAccess: 2, accounts: 3 },
    })
    state.audit.length = 0
    state.writes.length = 0
    state.reads = 0
    state.afterFirstRead = undefined
    state.barrier = undefined
  })

  describe('normal updates', () => {
    it('an edit that carries the current version is saved, and the response carries the next version', async () => {
      const opened = (await get()).json.data
      assert.equal(opened.updatedAt, T0.toISOString())
      const res = await patch({ name: 'Renamed', expectedUpdatedAt: opened.updatedAt })
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.equal(product().name, 'Renamed')
      assert.notEqual(res.json.data.updatedAt, opened.updatedAt, 'the version moved')
      assert.equal(res.json.data.updatedAt, version())
    })

    it('the version returned by a save is the one the next edit needs, and the old one is then stale', async () => {
      const first = await patch({ name: 'One', expectedUpdatedAt: T0.toISOString() })
      const second = await patch({ name: 'Two', expectedUpdatedAt: first.json.data.updatedAt })
      assert.equal(second.status, 200, JSON.stringify(second.json))
      assert.equal(product().name, 'Two')
      const reuse = await patch({ name: 'Three', expectedUpdatedAt: first.json.data.updatedAt })
      assert.equal(reuse.status, 409)
      assert.equal(product().name, 'Two')
    })

    it('a request without a version still works exactly as before (unprotected)', async () => {
      const res = await patch({ name: 'Renamed' })
      assert.equal(res.status, 200)
      assert.equal(product().name, 'Renamed')
    })

    it('the version is compared inside the update, and is never written or audited as a product field', async () => {
      await patch({ name: 'Renamed', expectedUpdatedAt: T0.toISOString() })
      assert.equal(state.writes.length, 1)
      assert.equal(state.writes[0].where.updatedAt.getTime(), T0.getTime(), 'the UPDATE is conditional on the version')
      assert.deepEqual(Object.keys(state.writes[0].data), ['name'], 'only product fields are written')
      assert.deepEqual(Object.keys(state.audit[0].metadata.changes), ['name'])
    })

    it('accepts the same instant written with an offset', async () => {
      const res = await patch({ name: 'Renamed', expectedUpdatedAt: '2025-01-01T05:30:00.000+05:30' })
      assert.equal(res.status, 200, JSON.stringify(res.json))
    })
  })

  describe('stale updates', () => {
    it("an older form cannot overwrite another admin's price change: 409, nothing saved", async () => {
      const copyOfB = (await get()).json.data // admin B opens the product
      await patch({ monthlyPrice: 6000, expectedUpdatedAt: copyOfB.updatedAt }) // admin A raises the price
      const auditAfterA = state.audit.length
      const writesAfterA = state.writes.length

      // B changes only the name, but the page sends the whole (older) form, including the old price.
      const res = await patch(formFrom(copyOfB, { name: 'B renamed it', expectedUpdatedAt: copyOfB.updatedAt }))
      assert.equal(res.status, 409, JSON.stringify(res.json))
      assert.match(res.json.message, /changed/i)
      assert.equal(Number(product().monthlyPrice), 6000, "A's price is still there")
      assert.equal(product().name, 'Hexalyte Salon', "B's change was not applied either")
      assert.equal(state.audit.length, auditAfterA)
      assert.equal(state.writes.length, writesAfterA)
    })

    it("an older form cannot undo another admin's retirement, even one that still repeats the old status", async () => {
      const copyOfB = (await get()).json.data
      // Admin A retires the product (through POST /retire, covered in admin-product-status-guard.test.ts): status and version move.
      Object.assign(product(), { status: 'INACTIVE' })
      bump(product())
      for (const form of [formFrom(copyOfB), { ...formFrom(copyOfB), status: copyOfB.status }]) {
        const res = await patch({ ...form, description: 'Updated text', expectedUpdatedAt: copyOfB.updatedAt })
        assert.equal(res.status, 409, JSON.stringify(res.json))
        assert.equal(product().status, 'INACTIVE')
        assert.equal(product().description, null)
      }
      assert.equal(state.writes.length, 0)
    })

    it('is stale even when the two admins changed different fields', async () => {
      const copyOfB = (await get()).json.data
      await patch({ description: 'Added by A', expectedUpdatedAt: copyOfB.updatedAt })
      assert.equal((await patch({ name: 'By B', expectedUpdatedAt: copyOfB.updatedAt })).status, 409)
      assert.equal(product().name, 'Hexalyte Salon')
    })

    it('is stale even when the old form would change nothing', async () => {
      const copyOfB = (await get()).json.data
      await patch({ name: 'By A', expectedUpdatedAt: copyOfB.updatedAt })
      assert.equal((await patch({ ...formFrom(copyOfB), expectedUpdatedAt: copyOfB.updatedAt })).status, 409)
    })

    it('any other save of the product also makes older forms stale (the version covers the whole row)', async () => {
      const opened = (await get()).json.data
      bump(product()) // e.g. an integration setting saved or a health check run
      assert.equal((await patch({ name: 'Renamed', expectedUpdatedAt: opened.updatedAt })).status, 409)
    })

    it('a stale request is checked before its trial-days rule, and after the product is known to exist', async () => {
      const opened = (await get()).json.data
      bump(product())
      assert.equal((await patch({ trialDays: 30, expectedUpdatedAt: opened.updatedAt })).status, 409)
      assert.equal((await patch({ name: 'x1', expectedUpdatedAt: opened.updatedAt }, 'u-admin', 'nope')).status, 404)
    })

    it('rejects a malformed version as a validation error, and a version alone is not an update', async () => {
      for (const bad of ['yesterday', '2025-01-01', 1735689600000, '', null]) {
        const res = await patch({ name: 'Renamed', expectedUpdatedAt: bad })
        assert.equal(res.status, 422, `expectedUpdatedAt=${JSON.stringify(bad)}`)
      }
      const alone = await patch({ expectedUpdatedAt: T0.toISOString() })
      assert.equal(alone.status, 422)
      assert.match(JSON.stringify(alone.json.errors), /Nothing to update/)
      assert.equal(state.writes.length, 0)
    })
  })

  describe('simultaneous updates', () => {
    it('two requests on the same version: exactly one is saved', async () => {
      armReadBarrier(2) // both have read version T0 before either one writes
      const results = await Promise.all([
        patch({ name: 'From A', expectedUpdatedAt: T0.toISOString() }),
        patch({ description: 'From B', expectedUpdatedAt: T0.toISOString() }),
      ])
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
      assert.equal(state.audit.length, 1)
      const savedName = product().name === 'From A'
      const savedDescription = product().description === 'From B'
      assert.equal(savedName !== savedDescription, true, 'exactly one of the two changes is stored')
    })

    it('five simultaneous requests on the same version: one wins, four conflict', async () => {
      armReadBarrier(5)
      const results = await Promise.all([1, 2, 3, 4, 5].map((n) => patch({ name: `Writer ${n}`, expectedUpdatedAt: T0.toISOString() })))
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409, 409, 409])
      assert.equal(state.audit.length, 1)
      assert.equal(state.writes.length, 1)
    })

    it("a save that lands between this request's read and its write is caught by the write itself", async () => {
      const opened = (await get()).json.data
      state.reads = 0
      // Another admin saves a new price after our request has read the product but before it writes.
      state.afterFirstRead = () => Object.assign(product(), { monthlyPrice: new Decimal('7000') }) && bump(product())
      const res = await patch({ name: 'Renamed', expectedUpdatedAt: opened.updatedAt })
      assert.equal(res.status, 409, JSON.stringify(res.json))
      assert.equal(Number(product().monthlyPrice), 7000, "the other admin's price is intact")
      assert.equal(product().name, 'Hexalyte Salon')
      assert.equal(state.audit.length, 0, 'the rolled-back request left no audit entry')
    })
  })

  describe('unchanged behaviour', () => {
    it('still needs products:manage: no token 401, a reseller user 403, nothing saved', async () => {
      assert.equal((await api.call('PATCH', '/admin/saas-products/p1', { body: { name: 'x1', expectedUpdatedAt: T0.toISOString() } })).status, 401)
      assert.equal((await patch({ name: 'Renamed', expectedUpdatedAt: T0.toISOString() }, 'u-seller')).status, 403)
      assert.equal(state.writes.length, 0)
    })
  })
})
