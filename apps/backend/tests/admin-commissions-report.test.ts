import { after, before, beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { installHermeticBackend, serve, strictFake } from './helpers/hermetic-backend'

/**
 * Admin → Monthly commission report: GET /commissions/monthly-report.
 *  - staff without `resellerId` get one row per reseller with status totals and a net that adds up (including a clawback for
 *    a commission that was already paid and then refunded); with `resellerId` they get that reseller's entries;
 *  - "Customers earned" counts customers who still have a live earning that month: not reversed, and not refunded after payout;
 *  - a reseller always gets only its own report, whatever `resellerId` it asks for;
 *  - the default month is the Asia/Colombo month.
 *
 * Database-free (see tests/helpers/hermetic-backend.ts): the real router, auth, validation, controller and ledger service run
 * against an in-memory commission ledger that groups and sums like the queries the service sends. Nothing here reads `.env`,
 * runs Prisma or opens a connection.
 */

type Row = Record<string, any>
let Decimal: typeof import('@prisma/client').Prisma.Decimal
let periodMonthOf: typeof import('../src/utils/period')['periodMonthOf']

const M = '2026-10'
const ledger: Row[] = []
const resellers: Row[] = [
  { id: 'r1', code: 'RS-1', businessName: 'Kandy Traders', currentLevel: 2, activeCustomerCount: 5 },
  { id: 'r2', code: 'RS-2', businessName: 'Galle Traders', currentLevel: 1, activeCustomerCount: 3 },
]

const seed = () => {
  const entry = (id: string, resellerId: string, customer: string, amount: string, status: string, over: Row = {}): Row => ({
    id,
    resellerId,
    customerAccountId: `acc-${customer}`,
    periodMonth: M,
    entryType: 'EARNING',
    status,
    level: 2,
    rate: new Decimal('10'),
    amount: new Decimal(amount),
    currency: 'LKR',
    reversedAt: null,
    createdAt: new Date(),
    ...over,
  })
  ledger.length = 0
  ledger.push(
    entry('e1', 'r1', 'a', '550', 'PENDING'),
    entry('e2', 'r1', 'b', '550', 'APPROVED'),
    entry('e3', 'r1', 'c', '550', 'PAID', { reversedAt: new Date() }), // paid out, then refunded …
    entry('e3c', 'r1', 'c', '-550', 'PAYABLE', { entryType: 'CLAWBACK' }), // … so recovered through a clawback
    entry('e4', 'r1', 'd', '550', 'REVERSED', { reversedAt: new Date() }),
    entry('e5', 'r2', 'e', '1650', 'PAYABLE'),
    entry('e6', 'r1', 'a', '550', 'PENDING', { periodMonth: '2026-09' }), // another month
  )
}

const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true
    if (cond !== null && typeof cond === 'object') {
      if ('not' in cond) return row[key] !== cond.not
      if ('in' in cond) return cond.in.includes(row[key])
      throw new Error(`The fake does not understand this condition on ${key}: ${JSON.stringify(cond)}`)
    }
    return row[key] === cond
  })

const queries: Row[] = []

const fakePrisma = strictFake('prisma', {
  user: { findUnique: async ({ where }: { where: { id: string } }) => USERS[where.id] ?? null },
  reseller: {
    findMany: async ({ where }: { where: { id: { in: string[] } } }) => resellers.filter((r) => where.id.in.includes(r.id)),
  },
  commission: {
    updateMany: async () => ({ count: 0 }), // promotePayable
    findMany: async (args: Row) => {
      queries.push({ op: 'findMany', ...args })
      return ledger
        .filter((c) => matches(c, args.where))
        .map((c) => ({
          ...c,
          customerAccount: { id: c.customerAccountId, status: 'ACTIVE', customer: { id: `cust-${c.customerAccountId}`, displayName: `Customer ${c.customerAccountId}` } },
          product: { code: 'SALON', name: 'Hexalyte Salon' },
          reseller: { id: c.resellerId, code: 'RS', businessName: 'x' },
          payout: null,
        }))
    },
    groupBy: async (args: Row) => {
      queries.push({ op: 'groupBy', ...args })
      const groups = new Map<string, Row>()
      for (const c of ledger.filter((x) => matches(x, args.where))) {
        const key = (args.by as string[]).map((k) => c[k]).join('|')
        const g = groups.get(key) ?? { ...Object.fromEntries((args.by as string[]).map((k) => [k, c[k]])), _n: 0, _sum: new Decimal(0) }
        g._n += 1
        g._sum = g._sum.add(c.amount)
        groups.set(key, g)
      }
      return [...groups.values()].map(({ _n, _sum, ...keys }) => ({
        ...keys,
        ...(args._sum ? { _sum: { amount: _sum } } : {}),
        ...(args._count ? { _count: Object.fromEntries(Object.keys(args._count).map((k) => [k, _n])) } : {}),
      }))
    },
  },
})

const USERS: Record<string, Row> = {
  'u-admin': { id: 'u-admin', email: 'admin@test.invalid', role: 'ADMIN', status: 'ACTIVE', emailVerified: null, resellerId: null, reseller: null },
  'u-seller': { id: 'u-seller', email: 'seller@test.invalid', role: 'SELLER', status: 'ACTIVE', emailVerified: new Date(), resellerId: 'r2', reseller: { status: 'ACTIVE' } },
}
type Who = keyof typeof USERS

describe('Admin → Monthly commission report API', () => {
  let api: Awaited<ReturnType<typeof serve>>
  let signAccessToken: typeof import('../src/utils/jwt')['signAccessToken']

  const token = (who: Who) => signAccessToken({ userId: who, email: USERS[who].email, role: USERS[who].role, resellerId: USERS[who].resellerId })
  const report = (query = '', who: Who = 'u-admin') => api.call('GET', `/commissions/monthly-report${query}`, { token: token(who) })
  const num = (v: unknown) => Number(v)
  const totalsOf = (t: Row) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, num(v)]))

  before(async () => {
    installHermeticBackend(fakePrisma)
    ;({ signAccessToken } = await import('../src/utils/jwt'))
    ;({ Prisma: { Decimal } } = await import('@prisma/client'))
    ;({ periodMonthOf } = await import('../src/utils/period'))
    const { errorHandler } = await import('../src/middleware/error.middleware')
    const { commissionsRouter } = await import('../src/modules/commissions/commissions.routes')
    const app = express()
    app.use(express.json())
    app.use('/commissions', commissionsRouter)
    app.use(errorHandler)
    api = await serve(app)
  })
  after(async () => {
    await api?.close()
  })
  beforeEach(() => {
    seed()
    queries.length = 0
  })

  describe('all resellers (staff)', () => {
    it('gives one row per reseller with status totals that add up to its net, best first', async () => {
      const res = await report(`?month=${M}`)
      assert.equal(res.status, 200, JSON.stringify(res.json))
      const { data } = res.json
      assert.equal(data.month, M)
      assert.deepEqual(data.rows.map((r: Row) => r.reseller.code), ['RS-2', 'RS-1'], 'sorted by net, highest first')

      const [r2, r1] = data.rows
      assert.deepEqual(totalsOf(r2.totals), { pending: 0, approved: 0, payable: 1650, paid: 0, reversed: 0, net: 1650 })
      // r1: pending 550 + approved 550 + paid 550 + clawback (−550, payable) = net 1100; reversed = unpaid reversal 550 + clawback 550
      assert.deepEqual(totalsOf(r1.totals), { pending: 550, approved: 550, payable: -550, paid: 550, reversed: 1100, net: 1100 })
      const sum = (t: Row) => num(t.pending) + num(t.approved) + num(t.payable) + num(t.paid)
      for (const r of data.rows) assert.equal(sum(r.totals), num(r.totals.net), `${r.reseller.code}: the columns add up to the net`)
    })

    it('overall totals are the sum of the rows', async () => {
      const { data } = (await report(`?month=${M}`)).json
      assert.deepEqual(totalsOf(data.totals), { pending: 550, approved: 550, payable: 1100, paid: 550, reversed: 1100, net: 2750 })
      assert.equal(data.rows.reduce((s: number, r: Row) => s + num(r.totals.net), 0), num(data.totals.net))
    })

    it('counts "customers earned" only for live earnings: not reversed, and not refunded after being paid out', async () => {
      const { data } = (await report(`?month=${M}`)).json
      const byCode = Object.fromEntries(data.rows.map((r: Row) => [r.reseller.code, r.paidCustomers]))
      // r1: customers a and b are live; c was paid and then refunded (clawback), d was reversed
      assert.deepEqual(byCode, { 'RS-1': 2, 'RS-2': 1 })
    })

    it('only includes the requested month, and shows the reseller\'s current level and active customers', async () => {
      const { data } = (await report('?month=2026-09')).json
      assert.deepEqual(data.rows.map((r: Row) => r.reseller.code), ['RS-1'])
      assert.equal(num(data.totals.pending), 550)
      assert.equal(data.rows[0].reseller.activeCustomerCount, 5)
      assert.equal(data.rows[0].reseller.currentLevel, 2)
    })

    it('answers a month with no commissions with an empty, zeroed report', async () => {
      const { data } = (await report('?month=2026-01')).json
      assert.deepEqual(data.rows, [])
      assert.deepEqual(totalsOf(data.totals), { pending: 0, approved: 0, payable: 0, paid: 0, reversed: 0, net: 0 })
    })
  })

  describe('one reseller', () => {
    it('staff get that reseller\'s entries (including the clawback) and totals', async () => {
      const { data } = (await report(`?month=${M}&resellerId=r1`)).json
      assert.equal(data.resellerId, 'r1')
      assert.deepEqual(data.entries.map((e: Row) => e.id).sort(), ['e1', 'e2', 'e3', 'e3c', 'e4'])
      assert.deepEqual(totalsOf(data.totals), { pending: 550, approved: 550, payable: -550, paid: 550, reversed: 1100, net: 1100 })
    })

    it('a reseller gets only its own report, whatever resellerId it asks for', async () => {
      for (const query of [`?month=${M}`, `?month=${M}&resellerId=r1`]) {
        const { data } = (await report(query, 'u-seller')).json
        assert.equal(data.resellerId, 'r2', query)
        assert.deepEqual(data.entries.map((e: Row) => e.id), ['e5'], query)
        assert.equal('rows' in data, false, 'never the all-resellers report')
      }
    })
  })

  describe('month and access', () => {
    it('defaults to the Asia/Colombo month, even while UTC / the Americas are still in the old one', async () => {
      mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-30T19:00:00Z') })
      try {
        const adminToken = token('u-admin')
        const res = await api.call('GET', '/commissions/monthly-report', { token: adminToken })
        assert.equal(res.status, 200, JSON.stringify(res.json))
        assert.equal(res.json.data.month, '2026-10')
        assert.equal(periodMonthOf(), '2026-10')
      } finally {
        mock.timers.reset()
      }
    })

    it('rejects a malformed month', async () => {
      for (const query of ['?month=2026-13', '?month=October', '?month=2026-1']) {
        assert.equal((await report(query)).status, 422, query)
      }
      assert.equal(queries.length, 0)
    })

    it('needs a signed-in user', async () => {
      const res = await api.call('GET', '/commissions/monthly-report')
      assert.equal(res.status, 401)
      assert.equal(queries.length, 0)
    })
  })
})
