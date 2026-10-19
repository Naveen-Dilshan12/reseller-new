import { after, before, beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import type { Request } from 'express'
import { installHermeticBackend, serve, strictFake } from './helpers/hermetic-backend'

/**
 * Admin → Resellers → Products: saving an access change without a note (which is what the UI sends when
 * the note box is blank) must keep the note already stored for that reseller/product.
 *
 * Database-free: the real service, router, auth and validation run against an in-memory stand-in for the few
 * Prisma calls they make (see tests/helpers/hermetic-backend.ts). Nothing here reads `.env` or opens a connection.
 */

type Status = 'ACTIVE' | 'SUSPENDED' | 'REVOKED'
interface AccessRow {
  id: string
  resellerId: string
  productId: string
  status: Status
  note: string | null
  grantedById: string | null
  statusChangedAt: Date
}

const RESELLER = 'rs-1'
const PRODUCT = 'prod-1'
const LONG_AGO = new Date('2024-01-01T00:00:00Z')
const store = new Map<string, AccessRow>()
const keyOf = (resellerId: string, productId: string) => `${resellerId}:${productId}`
const seed = (row: Partial<AccessRow>) =>
  store.set(keyOf(RESELLER, PRODUCT), { id: 'acc-1', resellerId: RESELLER, productId: PRODUCT, status: 'ACTIVE', note: null, grantedById: null, statusChangedAt: LONG_AGO, ...row })
const stored = () => store.get(keyOf(RESELLER, PRODUCT))

const withoutUndefined = (o: object) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

const USERS: Record<string, object> = {
  'u-admin': { id: 'u-admin', email: 'admin@test.invalid', role: 'ADMIN', status: 'ACTIVE', emailVerified: null, resellerId: null, reseller: null },
  'u-seller': { id: 'u-seller', email: 'seller@test.invalid', role: 'SELLER', status: 'ACTIVE', emailVerified: new Date(), resellerId: 'rs-own', reseller: { status: 'ACTIVE' } },
}

interface UpsertArgs {
  where: { resellerId_productId: { resellerId: string; productId: string } }
  create: Partial<AccessRow>
  update: Partial<AccessRow>
}
const tx = {
  resellerProductAccess: {
    findUnique: async ({ where }: Pick<UpsertArgs, 'where'>) => {
      const row = store.get(keyOf(where.resellerId_productId.resellerId, where.resellerId_productId.productId))
      return row ? { status: row.status } : null
    },
    // Same semantics as Prisma's upsert: `undefined` fields are left alone, `null` writes null.
    upsert: async ({ where, create, update }: UpsertArgs) => {
      const { resellerId, productId } = where.resellerId_productId
      const existing = store.get(keyOf(resellerId, productId))
      const row = existing
        ? Object.assign(existing, withoutUndefined(update))
        : ({ id: `acc-${store.size + 1}`, note: null, grantedById: null, ...withoutUndefined(create) } as AccessRow)
      store.set(keyOf(resellerId, productId), row)
      return { ...row }
    },
  },
}
const fakePrisma = strictFake('prisma', {
  user: { findUnique: async ({ where }: { where: { id: string } }) => USERS[where.id] ?? null },
  reseller: { findUnique: async ({ where }: { where: { id: string } }) => (where.id === RESELLER ? { id: RESELLER } : null) },
  saasProduct: { findUnique: async ({ where }: { where: { id: string } }) => (where.id === PRODUCT ? { name: 'Salon POS' } : null) },
  $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
})

const req = { user: { userId: 'u-admin', email: 'admin@test.invalid', role: 'ADMIN', resellerId: null } } as unknown as Request

describe('Product access: the note survives a save that does not mention it', () => {
  let service: typeof import('../src/modules/products/reseller-access.service')['resellerAccessService']
  let setAccessSchema: typeof import('../src/modules/products/product.schema')['setAccessSchema']
  let audit: ReturnType<typeof mock.method>
  let notify: ReturnType<typeof mock.method>
  let signAccessToken: typeof import('../src/utils/jwt')['signAccessToken']
  let api: Awaited<ReturnType<typeof serve>>

  before(async () => {
    installHermeticBackend(fakePrisma)
    ;({ resellerAccessService: service } = await import('../src/modules/products/reseller-access.service'))
    ;({ setAccessSchema } = await import('../src/modules/products/product.schema'))
    ;({ signAccessToken } = await import('../src/utils/jwt'))
    const { auditService } = await import('../src/modules/audit-logs/audit.service')
    const { notificationService } = await import('../src/modules/notifications/notification.service')
    const { errorHandler } = await import('../src/middleware/error.middleware')
    const { resellersAdminRouter } = await import('../src/modules/resellers/resellers.routes')
    const { resellerAccessRouter } = await import('../src/modules/products/products.routes')

    audit = mock.method(auditService, 'fromRequest', async () => undefined)
    notify = mock.method(notificationService, 'notifyReseller', async () => undefined)

    // Same mount order as src/app.ts
    const app = express()
    app.use(express.json())
    app.use('/admin/resellers', resellersAdminRouter)
    app.use('/admin/resellers/:resellerId/product-access', resellerAccessRouter)
    app.use(errorHandler)
    api = await serve(app)
  })

  after(async () => {
    mock.restoreAll()
    await api?.close()
  })

  beforeEach(() => {
    store.clear()
    audit.mock.resetCalls()
    notify.mock.resetCalls()
  })

  const tokenFor = (user: 'u-admin' | 'u-seller') => {
    const u = USERS[user] as { id: string; email: string; role: 'ADMIN' | 'SELLER'; resellerId: string | null }
    return signAccessToken({ userId: u.id, email: u.email, role: u.role, resellerId: u.resellerId })
  }

  describe('service', () => {
    it('keeps the stored note when the status changes and no note is sent', async () => {
      seed({ status: 'SUSPENDED', note: 'Overdue invoice' })
      await service.set(RESELLER, PRODUCT, { status: 'ACTIVE' }, req)
      assert.equal(stored()?.status, 'ACTIVE')
      assert.equal(stored()?.note, 'Overdue invoice')
      assert.ok(stored()!.statusChangedAt > LONG_AGO, 'the status change is still timestamped')
    })

    it('keeps the stored note when the same status is saved again, without notifying anyone', async () => {
      seed({ status: 'SUSPENDED', note: 'Overdue invoice' })
      await service.set(RESELLER, PRODUCT, { status: 'SUSPENDED' }, req)
      assert.equal(stored()?.note, 'Overdue invoice')
      assert.equal(stored()?.statusChangedAt.getTime(), LONG_AGO.getTime())
      assert.equal(notify.mock.callCount(), 0)
    })

    it('does not republish the old note to the reseller when a status change carries no new note', async () => {
      seed({ status: 'SUSPENDED', note: 'Overdue invoice' })
      await service.set(RESELLER, PRODUCT, { status: 'ACTIVE' }, req)
      assert.equal(notify.mock.callCount(), 1)
      const body = (notify.mock.calls[0].arguments[1] as { body: string }).body
      assert.equal(body, 'Your access to Salon POS was enabled.')
    })

    it('replaces the note when a new one is sent', async () => {
      seed({ status: 'ACTIVE', note: 'Old note' })
      await service.set(RESELLER, PRODUCT, { status: 'SUSPENDED', note: 'Under review' }, req)
      assert.equal(stored()?.note, 'Under review')
      assert.equal((notify.mock.calls[0].arguments[1] as { body: string }).body, 'Salon POS: Under review')
    })

    it('clears the note only when an empty string is sent explicitly', async () => {
      seed({ status: 'ACTIVE', note: 'Old note' })
      await service.set(RESELLER, PRODUCT, { status: 'ACTIVE', note: '' }, req)
      assert.equal(stored()?.note, null)
    })

    it('a first grant without a note stores no note', async () => {
      await service.set(RESELLER, PRODUCT, { status: 'ACTIVE' }, req)
      assert.equal(stored()?.note, null)
      assert.equal(stored()?.grantedById, 'u-admin')
    })

    it('still audits every change', async () => {
      seed({ status: 'SUSPENDED', note: 'Overdue invoice' })
      await service.set(RESELLER, PRODUCT, { status: 'ACTIVE' }, req)
      assert.equal(audit.mock.callCount(), 1)
      const entry = audit.mock.calls[0].arguments[1] as { action: string; metadata: { from: string; to: string } }
      assert.equal(entry.action, 'RESELLER_PRODUCT_ACCESS_CHANGED')
      assert.deepEqual([entry.metadata.from, entry.metadata.to], ['SUSPENDED', 'ACTIVE'])
    })
  })

  describe('request contract', () => {
    it('the body schema still accepts status alone and status + note, and rejects unknown fields', () => {
      assert.equal(setAccessSchema.safeParse({ status: 'ACTIVE' }).success, true)
      assert.equal(setAccessSchema.safeParse({ status: 'ACTIVE', note: 'x' }).success, true)
      assert.equal(setAccessSchema.safeParse({ status: 'ACTIVE', note: 'x'.repeat(301) }).success, false)
      assert.equal(setAccessSchema.safeParse({ status: 'ACTIVE', note: null }).success, false)
      assert.equal(setAccessSchema.safeParse({ status: 'ACTIVE', extra: 1 }).success, false)
    })

    it('PUT with the exact body the UI sends for a blank note keeps the stored note (admin)', async () => {
      seed({ status: 'SUSPENDED', note: 'Overdue invoice' })
      const res = await api.call('PUT', `/admin/resellers/${RESELLER}/product-access/${PRODUCT}`, { token: tokenFor('u-admin'), body: { status: 'ACTIVE' } })
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.equal(res.json.data.note, 'Overdue invoice')
      assert.equal(stored()?.status, 'ACTIVE')
      assert.equal(stored()?.note, 'Overdue invoice')
    })

    it('PUT with a note still replaces it', async () => {
      seed({ status: 'ACTIVE', note: 'Old note' })
      const res = await api.call('PUT', `/admin/resellers/${RESELLER}/product-access/${PRODUCT}`, { token: tokenFor('u-admin'), body: { status: 'REVOKED', note: 'Contract ended' } })
      assert.equal(res.status, 200)
      assert.equal(stored()?.note, 'Contract ended')
    })

    it('permissions are unchanged: unauthenticated 401, approved seller 403, unknown fields 422, nothing is written', async () => {
      seed({ status: 'SUSPENDED', note: 'Overdue invoice' })
      const url = `/admin/resellers/${RESELLER}/product-access/${PRODUCT}`
      assert.equal((await api.call('PUT', url, { body: { status: 'ACTIVE' } })).status, 401)
      assert.equal((await api.call('PUT', url, { token: tokenFor('u-seller'), body: { status: 'ACTIVE' } })).status, 403)
      assert.equal((await api.call('PUT', url, { token: tokenFor('u-admin'), body: { status: 'ACTIVE', extra: true } })).status, 422)
      assert.equal(stored()?.status, 'SUSPENDED')
      assert.equal(stored()?.note, 'Overdue invoice')
    })
  })
})
