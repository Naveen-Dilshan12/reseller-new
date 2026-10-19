import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { installHermeticBackend, serve, strictFake } from './helpers/hermetic-backend'

/**
 * Admin → Customers → "Link SaaS account": POST /customer-accounts.
 *  - a new customer is created through the shared `findOrCreateCustomer` (CUS- code, name matching, no duplicates);
 *  - the account is linked through the shared `linkTrialAccount` guards, with a clear 409 for a duplicate customer + product
 *    or an already-used tenant, and nothing left behind when a request fails;
 *  - a PENDING account with a tenant ID is refused (PENDING means "no tenant yet").
 *
 * Database-free (see tests/helpers/hermetic-backend.ts): the real router, auth, validation, linking services, product-access
 * check, audit and error handler run against an in-memory store that enforces the two unique constraints of customer_accounts
 * ((customerId, productId) and (productId, externalTenantId)) with Prisma's P2002 error, and undoes a failed transaction.
 * Nothing here reads `.env`, runs Prisma or opens a connection.
 */

type Row = Record<string, any>

const db = {
  resellers: new Map<string, Row>(),
  products: new Map<string, Row>(),
  customers: new Map<string, Row>(),
  accounts: new Map<string, Row>(),
  audit: [] as Row[],
  seq: 0,
  ids: 0,
}

const copy = (m: Map<string, Row>) => new Map([...m].map(([k, v]) => [k, { ...v }] as [string, Row]))

const seed = () => {
  db.resellers = new Map<string, Row>([
    ['r1', { id: 'r1', code: 'RS-1', businessName: 'Kandy Traders', status: 'ACTIVE' }],
    ['r2', { id: 'r2', code: 'RS-2', businessName: 'Galle Traders', status: 'ACTIVE' }],
    ['r-pending', { id: 'r-pending', code: 'RS-3', businessName: 'New Traders', status: 'PENDING' }],
  ])
  db.products = new Map<string, Row>([
    ['p1', { id: 'p1', code: 'SALON', name: 'Hexalyte Salon', status: 'ACTIVE', access: { r1: 'ACTIVE', r2: 'ACTIVE' } }],
    ['p-off', { id: 'p-off', code: 'OLD', name: 'Retired', status: 'INACTIVE', access: { r1: 'ACTIVE' } }],
    ['p-closed', { id: 'p-closed', code: 'MOB', name: 'Mobile Shop', status: 'ACTIVE', access: {} }],
  ])
  db.customers = new Map<string, Row>([
    ['c-kandy', { id: 'c-kandy', resellerId: 'r1', displayName: 'Kandy Mobiles', customerCode: 'CUS-000001' }],
    ['c-other', { id: 'c-other', resellerId: 'r2', displayName: 'Other Shop', customerCode: 'CUS-000002' }],
  ])
  db.accounts = new Map()
  db.audit = []
  db.seq = 2
  db.ids = 0
}

let Prisma: typeof import('@prisma/client').Prisma
const uniqueViolation = () => new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' })

/** customer_accounts' two unique constraints, as PostgreSQL enforces them. */
function assertUnique(candidate: Row, ignoreId?: string) {
  for (const a of db.accounts.values()) {
    if (a.id === ignoreId) continue
    if (a.customerId === candidate.customerId && a.productId === candidate.productId) throw uniqueViolation()
    if (candidate.externalTenantId && a.productId === candidate.productId && a.externalTenantId === candidate.externalTenantId) throw uniqueViolation()
  }
}

const txModels = () => ({
  $executeRaw: async () => 1,
  // customer_code_seq
  $queryRaw: async () => [{ code: `CUS-${String(++db.seq).padStart(6, '0')}` }],
  customer: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const c = db.customers.get(where.id)
      return c ? { resellerId: c.resellerId } : null
    },
    findMany: async ({ where }: { where: Row }) => {
      let rows = [...db.customers.values()].filter((c) => c.resellerId === where.resellerId)
      const equals = where.OR?.[0]?.displayName?.equals
      if (equals !== undefined) rows = rows.filter((c) => c.displayName.toLowerCase() === String(equals).toLowerCase())
      return rows.map((c) => ({ id: c.id, displayName: c.displayName }))
    },
    create: async ({ data }: { data: Row }) => {
      const row = { id: `c-new-${++db.ids}`, customerCode: null, ...data }
      db.customers.set(row.id, row)
      return { ...row }
    },
  },
  customerAccount: {
    findUnique: async ({ where }: { where: { customerId_productId: { customerId: string; productId: string } } }) => {
      const { customerId, productId } = where.customerId_productId
      const a = [...db.accounts.values()].find((x) => x.customerId === customerId && x.productId === productId)
      return a ? { id: a.id, status: a.status, externalTenantId: a.externalTenantId } : null
    },
    create: async ({ data }: { data: Row }) => {
      const row = { id: `a-new-${++db.ids}`, externalAccountId: null, activatedAt: null, deactivatedAt: null, ...data }
      assertUnique(row)
      db.accounts.set(row.id, row)
      return { id: row.id }
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = db.accounts.get(where.id)!
      assertUnique({ ...row, ...data }, row.id)
      Object.assign(row, data)
      return { ...row }
    },
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
      const a = db.accounts.get(where.id)!
      const c = db.customers.get(a.customerId)!
      const p = db.products.get(a.productId)!
      const r = db.resellers.get(a.resellerId)!
      return {
        ...a,
        customer: { id: c.id, displayName: c.displayName },
        product: { id: p.id, code: p.code, name: p.name },
        reseller: { id: r.id, code: r.code, businessName: r.businessName },
      }
    },
  },
  auditLog: {
    create: async ({ data }: { data: Row }) => {
      db.audit.push({ ...data })
      return data
    },
  },
})

const USERS: Record<string, Row> = {
  'u-admin': { id: 'u-admin', email: 'admin@test.invalid', role: 'ADMIN', status: 'ACTIVE', emailVerified: null, resellerId: null, reseller: null },
  'u-seller': { id: 'u-seller', email: 'seller@test.invalid', role: 'SELLER', status: 'ACTIVE', emailVerified: new Date(), resellerId: 'r1', reseller: { status: 'ACTIVE' } },
}
type Who = keyof typeof USERS

const fakePrisma = strictFake('prisma', {
  user: { findUnique: async ({ where }: { where: { id: string } }) => USERS[where.id] ?? null },
  reseller: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const r = db.resellers.get(where.id)
      return r ? { status: r.status } : null
    },
  },
  saasProduct: {
    findUnique: async ({ where, select }: { where: { id: string }; select: Row }) => {
      const p = db.products.get(where.id)
      if (!p) return null
      const resellerId = select.resellerAccess.where.resellerId as string
      return { name: p.name, status: p.status, resellerAccess: p.access[resellerId] ? [{ status: p.access[resellerId] }] : [] }
    },
  },
  $transaction: async <T>(fn: (t: object) => Promise<T>): Promise<T> => {
    const saved = { customers: copy(db.customers), accounts: copy(db.accounts), audit: [...db.audit] }
    try {
      return await fn(strictFake('tx', txModels()))
    } catch (err) {
      Object.assign(db, saved)
      throw err
    }
  },
})

describe('Admin → Link SaaS account (POST /customer-accounts)', () => {
  let api: Awaited<ReturnType<typeof serve>>
  let signAccessToken: typeof import('../src/utils/jwt')['signAccessToken']
  let linkTrialAccount: typeof import('../src/modules/customer-accounts/customer-linking')['linkTrialAccount']

  const token = (who: Who) => signAccessToken({ userId: who, email: USERS[who].email, role: USERS[who].role, resellerId: USERS[who].resellerId })
  const link = (body: unknown, who: Who | null = 'u-admin') =>
    api.call('POST', '/customer-accounts', { token: who ? token(who) : undefined, body })
  const base = { resellerId: 'r1', productId: 'p1', customerName: 'Nimal Stores', externalTenantId: 'tenant-100' }
  const accountOf = (customerId: string) => [...db.accounts.values()].filter((a) => a.customerId === customerId)
  const snapshot = () => JSON.stringify({ customers: [...db.customers], accounts: [...db.accounts], audit: db.audit })
  const seedAccount = (over: Row) => {
    const row = { id: 'a-seed', resellerId: 'r1', customerId: 'c-kandy', productId: 'p1', externalTenantId: 'tenant-old', externalAccountId: null, status: 'TRIAL', activatedAt: null, deactivatedAt: null, ...over }
    db.accounts.set(row.id, row)
    return row
  }

  before(async () => {
    installHermeticBackend(fakePrisma)
    ;({ signAccessToken } = await import('../src/utils/jwt'))
    ;({ Prisma } = await import('@prisma/client'))
    ;({ linkTrialAccount } = await import('../src/modules/customer-accounts/customer-linking'))
    const { errorHandler } = await import('../src/middleware/error.middleware')
    const { customerAccountsRouter } = await import('../src/modules/customer-accounts/customer-accounts.routes')
    const app = express()
    app.use(express.json())
    app.use('/customer-accounts', customerAccountsRouter)
    app.use(errorHandler)
    api = await serve(app)
  })
  after(async () => {
    await api?.close()
  })
  beforeEach(seed)

  describe('new customers (D4)', () => {
    it('creates the customer with a CUS- code, links it as a TRIAL account and writes one audit entry', async () => {
      const res = await link({ ...base, customerName: '  Nimal Stores  ', externalAccountId: 'owner-7' })
      assert.equal(res.status, 201, JSON.stringify(res.json))
      assert.equal(res.json.message, 'Customer account linked')
      const { data } = res.json
      assert.equal(data.status, 'TRIAL')
      assert.equal(data.externalTenantId, 'tenant-100')
      assert.equal(data.externalAccountId, 'owner-7')
      assert.deepEqual(data.customer, { id: data.customerId, displayName: 'Nimal Stores' })
      assert.equal(data.product.name, 'Hexalyte Salon')
      assert.equal(data.reseller.businessName, 'Kandy Traders')

      const customer = db.customers.get(data.customerId)!
      assert.equal(customer.resellerId, 'r1')
      assert.match(customer.customerCode, /^CUS-\d{6}$/, 'a customer created from the admin page must get a customer code like every other customer')
      assert.equal(customer.customerCode, 'CUS-000003')

      assert.equal(db.audit.length, 1)
      assert.equal(db.audit[0].action, 'CUSTOMER_ACCOUNT_LINKED')
      assert.equal(db.audit[0].entityId, data.id)
      assert.equal(db.audit[0].actorUserId, 'u-admin')
      assert.deepEqual(db.audit[0].metadata, {
        customerId: data.customerId,
        productId: 'p1',
        externalTenantId: 'tenant-100',
        externalAccountId: 'owner-7',
        outcome: 'CREATED',
      })
    })

    it('reuses the reseller\'s existing customer when the name matches ignoring case and punctuation', async () => {
      for (const name of ['Kandy Mobiles', 'kandy mobiles', 'kandy-mobiles']) {
        seed()
        const res = await link({ ...base, customerName: name })
        assert.equal(res.status, 201, `${name}: ${JSON.stringify(res.json)}`)
        assert.equal(res.json.data.customerId, 'c-kandy', name)
        assert.equal(db.customers.size, 2, `${name}: no duplicate customer may be created`)
        assert.equal(db.customers.get('c-kandy')!.customerCode, 'CUS-000001')
      }
    })

    it('does not match another reseller\'s customer of the same name', async () => {
      const res = await link({ ...base, customerName: 'Other Shop' })
      assert.equal(res.status, 201)
      assert.notEqual(res.json.data.customerId, 'c-other')
      assert.equal(db.customers.get(res.json.data.customerId)!.resellerId, 'r1')
    })

    it('links an existing customer of the reseller by id, and refuses another reseller\'s or an unknown customer', async () => {
      const ok = await link({ resellerId: 'r1', productId: 'p1', customerId: 'c-kandy', externalTenantId: 'tenant-100' })
      assert.equal(ok.status, 201, JSON.stringify(ok.json))
      assert.equal(ok.json.data.customerId, 'c-kandy')
      assert.equal(db.customers.size, 2)

      seed()
      for (const customerId of ['c-other', 'c-missing']) {
        const res = await link({ resellerId: 'r1', productId: 'p1', customerId, externalTenantId: 'tenant-100' })
        assert.equal(res.status, 400, customerId)
        assert.equal(res.json.message, 'Customer does not belong to this partner')
      }
      assert.equal(db.accounts.size, 0)
    })

    it('needs exactly one of customerId / customerName', async () => {
      for (const body of [{ ...base, customerName: undefined }, { ...base, customerId: 'c-kandy' }]) {
        const res = await link(body)
        assert.equal(res.status, 422, JSON.stringify(res.json))
        assert.match(res.json.errors[0], /^customerName: Choose an existing customer or enter a new customer name/)
      }
      assert.equal(db.accounts.size, 0)
    })
  })

  describe('PENDING with a tenant ID is refused (D5)', () => {
    it('answers 422 with a clear message and writes nothing', async () => {
      const before = snapshot()
      const res = await link({ ...base, status: 'PENDING' })
      assert.equal(res.status, 422, JSON.stringify(res.json))
      assert.equal(res.json.message, 'Validation error')
      assert.deepEqual(res.json.errors, ['status: A PENDING account cannot have a tenant ID. Link an existing tenant as TRIAL.'])
      assert.equal(snapshot(), before)
    })

    it('links as TRIAL by default and with an explicit TRIAL; ACTIVE (and anything else) is refused', async () => {
      const implicit = await link(base)
      assert.equal(implicit.status, 201)
      assert.equal(implicit.json.data.status, 'TRIAL')

      seed()
      const explicit = await link({ ...base, status: 'TRIAL' })
      assert.equal(explicit.status, 201)
      assert.equal(explicit.json.data.status, 'TRIAL')

      for (const status of ['ACTIVE', 'CANCELLED', 'trial']) {
        seed()
        const res = await link({ ...base, status })
        assert.equal(res.status, 422, status)
        assert.equal(db.accounts.size, 0, status)
      }
    })

    it('still rejects unknown fields and a missing tenant ID', async () => {
      assert.equal((await link({ ...base, role: 'ADMIN' })).status, 422)
      assert.equal((await link({ ...base, externalTenantId: '   ' })).status, 422)
      assert.equal(db.accounts.size, 0)
    })
  })

  describe('duplicate customer / product and tenant links (D6)', () => {
    it('refuses a customer that already has a paid (ACTIVE) account for the product, with a clear 409', async () => {
      seedAccount({ status: 'ACTIVE', activatedAt: new Date() })
      const before = snapshot()
      const res = await link({ resellerId: 'r1', productId: 'p1', customerId: 'c-kandy', externalTenantId: 'tenant-new' })
      assert.equal(res.status, 409, JSON.stringify(res.json))
      assert.equal(res.json.message, 'This customer already has an active paid subscription for Hexalyte Salon')
      assert.equal(snapshot(), before)
    })

    it('refuses a different tenant on a customer that already has one for the product, with a clear 409', async () => {
      seedAccount({ status: 'TRIAL', externalTenantId: 'tenant-old' })
      const before = snapshot()
      const res = await link({ resellerId: 'r1', productId: 'p1', customerId: 'c-kandy', externalTenantId: 'tenant-new' })
      assert.equal(res.status, 409, JSON.stringify(res.json))
      assert.equal(res.json.message, 'This customer already has a different SaaS tenant linked for Hexalyte Salon')
      assert.equal(snapshot(), before)
    })

    it('refuses a tenant that is already linked to another customer, with a clear 409, and leaves no new customer behind', async () => {
      seedAccount({ customerId: 'c-kandy', externalTenantId: 'tenant-100' })
      const before = snapshot()
      const res = await link({ ...base, customerName: 'Nimal Stores', externalTenantId: 'tenant-100' })
      assert.equal(res.status, 409, JSON.stringify(res.json))
      assert.equal(res.json.message, 'This SaaS tenant is already linked to another customer account')
      assert.notEqual(res.json.message, 'Record already exists', 'the generic database message must not reach the admin')
      assert.equal(db.customers.size, 2, 'the customer created for the failed request is rolled back')
      assert.equal(snapshot(), before)
    })

    it('attaches the tenant to an existing tenant-less account (e.g. after a failed trial) and makes it TRIAL', async () => {
      seedAccount({ status: 'PENDING', externalTenantId: null })
      const res = await link({ resellerId: 'r1', productId: 'p1', customerId: 'c-kandy', externalTenantId: 'tenant-100', externalAccountId: 'owner-1' })
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.equal(res.json.message, 'SaaS tenant linked to the existing customer account')
      assert.equal(res.json.data.id, 'a-seed')
      assert.equal(res.json.data.status, 'TRIAL')
      assert.equal(res.json.data.externalTenantId, 'tenant-100')
      assert.equal(res.json.data.externalAccountId, 'owner-1')
      assert.equal(db.accounts.size, 1, 'no second account for the same customer + product')
      assert.equal(db.audit[0].metadata.outcome, 'ATTACHED')
    })

    it('treats linking the same tenant again as a no-op: same account, no second audit entry', async () => {
      const first = await link(base)
      assert.equal(first.status, 201)
      const again = await link({ ...base, customerName: undefined, customerId: first.json.data.customerId })
      assert.equal(again.status, 200, JSON.stringify(again.json))
      assert.equal(again.json.message, 'Customer account was already linked')
      assert.equal(again.json.data.id, first.json.data.id)
      assert.equal(db.accounts.size, 1)
      assert.equal(db.audit.length, 1)
    })

    it('linkTrialAccount keeps its contract for the demo flow: `created` is true only for a new account', async () => {
      const input = { resellerId: 'r1', customerId: 'c-kandy', productId: 'p1', productName: 'Hexalyte Salon', externalTenantId: 'tenant-100' }
      const first = await linkTrialAccount(txModels() as never, input)
      assert.equal(first.created, true)
      assert.equal(first.outcome, 'CREATED')
      const again = await linkTrialAccount(txModels() as never, input)
      assert.deepEqual({ created: again.created, outcome: again.outcome, same: again.accountId === first.accountId }, { created: false, outcome: 'UNCHANGED', same: true })
    })
  })

  describe('access rules stay as they were', () => {
    it('needs a signed-in admin', async () => {
      assert.equal((await link(base, null)).status, 401)
      const seller = await link(base, 'u-seller')
      assert.equal(seller.status, 403)
      assert.equal(seller.json.message, 'Insufficient permissions')
      assert.equal(db.accounts.size, 0)
    })

    it('refuses an unknown or inactive reseller, and a product the reseller cannot sell', async () => {
      const cases: Array<[Row, number, RegExp]> = [
        [{ resellerId: 'r-missing' }, 404, /Partner not found/],
        [{ resellerId: 'r-pending' }, 400, /Partner is not active/],
        [{ productId: 'p-missing' }, 404, /SaaS product not found/],
        [{ productId: 'p-off' }, 400, /This product is not available/],
        [{ productId: 'p-closed' }, 400, /does not have active access to this product/],
      ]
      for (const [over, status, message] of cases) {
        const res = await link({ ...base, ...over })
        assert.equal(res.status, status, JSON.stringify(over))
        assert.match(res.json.message, message, JSON.stringify(over))
      }
      assert.equal(db.accounts.size, 0)
      assert.equal(db.customers.size, 2)
    })
  })
})
