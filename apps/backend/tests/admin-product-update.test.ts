import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { installHermeticBackend, serve, strictFake } from './helpers/hermetic-backend'

/**
 * Admin → SaaS products → edit: `PATCH /admin/saas-products/:id`.
 *  1. Trial days stay consistent with `trialAvailable` (also for partial PATCH requests).
 *  2. The update audit entry lists only fields whose stored value really changed, and a no-op leaves no entry.
 * (Status is not editable here: see admin-product-status-guard.test.ts.)
 *
 * Database-free (see tests/helpers/hermetic-backend.ts): the real router, auth, validation, service and audit code
 * run against an in-memory product store. The store applies `updateMany` with its WHERE condition (so a concurrent
 * change between the service's read and write is visible) and rolls a transaction back if its callback throws.
 * Nothing here reads `.env`, runs Prisma or opens a connection.
 */

type Row = Record<string, any>
const T0 = new Date('2025-01-01T00:00:00Z')
let Decimal: typeof import('@prisma/client').Prisma.Decimal
const rows = new Map<string, Row>()
const state = {
  audit: [] as Row[],
  /** Every product write: the WHERE condition and the data actually sent. */
  writes: [] as Array<{ where: Row; data: Row }>,
  failAudit: undefined as Error | undefined,
  reads: 0,
  /** Runs once, right after the service's first product read: lets a test play "someone else saved in between". */
  afterFirstRead: undefined as (() => void) | undefined,
}
const definedOnly = (o: object) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
const project = (row: Row | undefined, select?: Row) =>
  row ? (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : { ...row }) : null

/** One write, as PostgreSQL would run it: UPDATE … WHERE id = ? AND <other conditions>. Returns how many rows matched. */
function write(where: Row, data: Row) {
  const { id, ...conditions } = where
  const row = rows.get(id)
  if (!row || Object.entries(conditions).some(([k, v]) => v !== undefined && row[k] !== v)) return 0
  state.writes.push({ where, data })
  const stored: Row = definedOnly(data)
  if (stored.monthlyPrice !== undefined) stored.monthlyPrice = new Decimal(stored.monthlyPrice) // Prisma returns Decimals
  Object.assign(row, stored, { updatedAt: new Date(row.updatedAt.getTime() + 60_000) })
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
      if (state.failAudit) {
        const err = state.failAudit
        state.failAudit = undefined
        throw err
      }
      state.audit.push({ ...data })
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
    findUnique: async ({ where, select }: { where: { id: string }; select?: Row }) => {
      const found = project(rows.get(where.id), select)
      if (++state.reads === 1 && state.afterFirstRead) {
        const hook = state.afterFirstRead
        state.afterFirstRead = undefined
        hook()
      }
      return found
    },
  },
  $transaction: async <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => {
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
  },
})

describe('Admin SaaS products: PATCH /admin/saas-products/:id', () => {
  let api: Awaited<ReturnType<typeof serve>>
  let signAccessToken: typeof import('../src/utils/jwt')['signAccessToken']
  let createProductSchema: typeof import('../src/modules/products/product.schema')['createProductSchema']
  let updateProductSchema: typeof import('../src/modules/products/product.schema')['updateProductSchema']

  const token = (id: 'u-admin' | 'u-seller') => signAccessToken({ userId: id, email: USERS[id].email, role: USERS[id].role, resellerId: USERS[id].resellerId })
  const patch = (body: unknown, who: 'u-admin' | 'u-seller' = 'u-admin') => api.call('PATCH', '/admin/saas-products/p1', { token: token(who), body })
  const product = () => rows.get('p1')!
  const changes = () => state.audit[0]?.metadata?.changes
  /** What the admin page sends when Save is pressed: every editable field, filled from the current product (status is not one). */
  const fullForm = (over: Row = {}) => {
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
  const seed = (over: Row = {}) => {
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
      ...over,
    })
  }

  before(async () => {
    installHermeticBackend(fakePrisma)
    ;({ signAccessToken } = await import('../src/utils/jwt'))
    ;({ Prisma: { Decimal } } = await import('@prisma/client'))
    ;({ createProductSchema, updateProductSchema } = await import('../src/modules/products/product.schema'))
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
    state.failAudit = undefined
    state.afterFirstRead = undefined
    state.reads = 0
  })

  describe('trial days stay consistent with trialAvailable', () => {
    it('rejects trial days on a product that has no trial, and changes nothing', async () => {
      const res = await patch({ trialDays: 30 })
      assert.equal(res.status, 422, JSON.stringify(res.json))
      assert.equal(res.json.message, 'Validation error')
      assert.deepEqual(res.json.errors, ['trialDays: Trial days can only be set when a trial is available'])
      assert.deepEqual([product().trialAvailable, product().trialDays], [false, null])
      assert.equal(state.writes.length, 0)
      assert.equal(state.audit.length, 0)
    })

    it('still rejects trial days together with trialAvailable=false in the same request (existing rule)', async () => {
      const res = await patch({ trialAvailable: false, trialDays: 30 })
      assert.equal(res.status, 422)
      assert.deepEqual(res.json.errors, ['trialDays: Trial days can only be set when a trial is available'])
      assert.equal(state.writes.length, 0)
    })

    it('disabling trials clears the stored trial days', async () => {
      seed({ trialAvailable: true, trialDays: 14 })
      const res = await patch({ trialAvailable: false })
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.deepEqual([product().trialAvailable, product().trialDays], [false, null])
      assert.deepEqual([res.json.data.trialAvailable, res.json.data.trialDays], [false, null])
      assert.deepEqual(changes(), { trialAvailable: { from: 'true', to: 'false' }, trialDays: { from: '14', to: '' } })
    })

    it('disabling trials with explicitly null days is fine', async () => {
      seed({ trialAvailable: true, trialDays: 14 })
      assert.equal((await patch({ trialAvailable: false, trialDays: null })).status, 200)
      assert.deepEqual([product().trialAvailable, product().trialDays], [false, null])
    })

    it('clearing the days of a product without a trial is accepted (it is already clear)', async () => {
      const res = await patch({ trialDays: null })
      assert.equal(res.status, 200)
      assert.deepEqual([product().trialAvailable, product().trialDays], [false, null])
    })

    it('changing only the days of a product that has a trial still works', async () => {
      seed({ trialAvailable: true, trialDays: 14 })
      const res = await patch({ trialDays: 45 })
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.deepEqual([product().trialAvailable, product().trialDays], [true, 45])
      assert.deepEqual(changes(), { trialDays: { from: '14', to: '45' } })
    })

    it('turning a trial on, with or without days, works', async () => {
      assert.equal((await patch({ trialAvailable: true, trialDays: 14 })).status, 200)
      assert.deepEqual([product().trialAvailable, product().trialDays], [true, 14])
      seed()
      assert.equal((await patch({ trialAvailable: true })).status, 200)
      assert.deepEqual([product().trialAvailable, product().trialDays], [true, null])
    })

    it('a full-form save of a product with a trial keeps it intact', async () => {
      seed({ trialAvailable: true, trialDays: 30 })
      const res = await patch(fullForm({ name: 'Renamed' }))
      assert.equal(res.status, 200)
      assert.deepEqual([product().trialAvailable, product().trialDays, product().name], [true, 30, 'Renamed'])
    })

    it('repairs a product already stored with days but no trial, whatever else is being edited', async () => {
      seed({ trialAvailable: false, trialDays: 30 }) // left over from before this rule existed
      const res = await patch({ name: 'Renamed' })
      assert.equal(res.status, 200)
      assert.deepEqual([product().trialAvailable, product().trialDays], [false, null])
      assert.deepEqual(changes(), { name: { from: 'Hexalyte Salon', to: 'Renamed' }, trialDays: { from: '30', to: '' } })
    })

    it('does not let a concurrent "disable trials" leave days behind: 409, product untouched', async () => {
      seed({ trialAvailable: true, trialDays: 14 })
      // Another admin saves "no trial" after this request has read the product but before it writes.
      state.afterFirstRead = () => Object.assign(product(), { trialAvailable: false, trialDays: null })
      const res = await patch({ trialDays: 30 })
      assert.equal(res.status, 409, JSON.stringify(res.json))
      assert.deepEqual([product().trialAvailable, product().trialDays], [false, null])
      assert.equal(state.audit.length, 0)
    })

    it('create and update schemas keep their existing contracts', () => {
      const create = (b: object) => createProductSchema.safeParse({ code: 'PHARMACY', name: 'Pharmacy', monthlyPrice: 5500, ...b })
      assert.equal(create({}).success, true)
      assert.equal(create({ trialAvailable: true }).success, true)
      assert.equal(create({ trialAvailable: true, trialDays: 30 }).success, true)
      assert.equal(create({ trialAvailable: false, trialDays: null }).success, true)
      assert.equal(create({ trialDays: 30 }).success, false, 'days without a trial (trialAvailable defaults to false)')
      assert.equal(create({ trialAvailable: false, trialDays: 30 }).success, false)
      assert.equal(create({ trialAvailable: true, trialDays: 91 }).success, false)

      assert.equal(updateProductSchema.safeParse({ trialDays: 30 }).success, true, 'depends on the stored product, so the service decides')
      assert.equal(updateProductSchema.safeParse({ trialAvailable: true, trialDays: 30 }).success, true)
      assert.equal(updateProductSchema.safeParse({ trialAvailable: false, trialDays: 30 }).success, false)
      assert.equal(updateProductSchema.safeParse({ trialAvailable: false, trialDays: null }).success, true)
      assert.equal(updateProductSchema.safeParse({}).success, false)
    })
  })

  describe('the audit entry records only what really changed', () => {
    it('changing one field of a full-form save records that field only, in the existing format', async () => {
      const res = await patch(fullForm({ name: 'Hexalyte Salon Pro' }))
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.equal(state.audit.length, 1)
      const [entry] = state.audit
      assert.equal(entry.action, 'SAAS_PRODUCT_UPDATED')
      assert.equal(entry.entityType, 'SaasProduct')
      assert.equal(entry.entityId, 'p1')
      assert.equal(entry.actorUserId, 'u-admin')
      assert.deepEqual(entry.metadata, { changes: { name: { from: 'Hexalyte Salon', to: 'Hexalyte Salon Pro' } } })
      assert.deepEqual(state.writes.map((w) => w.data), [{ name: 'Hexalyte Salon Pro' }], 'only the changed field is written')
    })

    it('a no-op save changes nothing: no audit entry, no write, same updatedAt, normal response', async () => {
      const res = await patch(fullForm())
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.equal(res.json.message, 'Product updated')
      assert.equal(res.json.data.id, 'p1')
      assert.equal(res.json.data.name, 'Hexalyte Salon')
      assert.equal(state.audit.length, 0)
      assert.equal(state.writes.length, 0)
      assert.equal(product().updatedAt, T0)
    })

    it('a price sent as a number equal to the stored decimal is not a change', async () => {
      seed({ monthlyPrice: new Decimal('5500.50') })
      assert.equal((await patch({ monthlyPrice: 5500.5 })).status, 200)
      assert.equal(state.audit.length, 0)
      assert.equal(state.writes.length, 0)
    })

    it('a changed price is recorded as the old and new amounts', async () => {
      assert.equal((await patch(fullForm({ monthlyPrice: 6000.5 }))).status, 200)
      assert.deepEqual(changes(), { monthlyPrice: { from: '5500', to: '6000.5' } })
      assert.equal(product().monthlyPrice.toString(), '6000.5')
    })

    it('several changes are all recorded, and nothing else', async () => {
      assert.equal((await patch(fullForm({ name: 'Hexalyte Salon Pro', description: 'Salon POS', monthlyPrice: 6000 }))).status, 200)
      assert.deepEqual(changes(), {
        name: { from: 'Hexalyte Salon', to: 'Hexalyte Salon Pro' },
        description: { from: '', to: 'Salon POS' },
        monthlyPrice: { from: '5500', to: '6000' },
      })
    })

    it('a second identical save is then a no-op', async () => {
      await patch(fullForm({ description: 'Salon POS' }))
      state.audit.length = 0
      state.writes.length = 0
      await patch(fullForm({ description: 'Salon POS' }))
      assert.equal(state.audit.length, 0)
      assert.equal(state.writes.length, 0)
    })

    it('the update and its audit entry still succeed or fail together', async () => {
      state.failAudit = new Error('audit store unavailable')
      const res = await patch({ name: 'Renamed' })
      assert.equal(res.status, 500)
      assert.equal(product().name, 'Hexalyte Salon', 'the rename was rolled back')
      assert.equal(state.audit.length, 0)
    })
  })

  describe('unchanged behaviour', () => {
    it('an empty body is still rejected, and unknown fields still are', async () => {
      assert.equal((await patch({})).status, 422)
      assert.equal((await patch({ code: 'OTHER' })).status, 422)
      assert.equal((await patch({ name: 'x' })).status, 422, 'name must be 2–100 characters')
      assert.equal(state.writes.length, 0)
    })

    it('an unknown product is 404', async () => {
      const res = await api.call('PATCH', '/admin/saas-products/nope', { token: token('u-admin'), body: { name: 'Renamed' } })
      assert.equal(res.status, 404)
    })

    it('still needs products:manage: no token 401, a reseller user 403, nothing written', async () => {
      assert.equal((await api.call('PATCH', '/admin/saas-products/p1', { body: { name: 'Renamed' } })).status, 401)
      assert.equal((await patch({ name: 'Renamed' }, 'u-seller')).status, 403)
      assert.equal(state.writes.length, 0)
      assert.equal(product().name, 'Hexalyte Salon')
    })
  })
})
