import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { installHermeticBackend, serve, strictFake } from './helpers/hermetic-backend'

/**
 * Admin → Resellers list: `GET /admin/resellers` (default view, status filter, search, pagination,
 * computed columns, validation, authorization), through the real router, auth, validation and service.
 *
 * Database-free (see tests/helpers/hermetic-backend.ts): nothing here reads `.env`, runs Prisma or opens a
 * connection. The Prisma stand-in below interprets the query arguments the way PostgreSQL would:
 *  - `contains` is case-SENSITIVE unless `mode: 'insensitive'` is given;
 *  - DESC puts NULLs first, ASC puts them last;
 *  - rows that tie on every ORDER BY key come back in an unspecified order that may differ per query, so the
 *    stand-in reshuffles ties on every call. A list is only paginated correctly if its ordering is total.
 * It cannot prove SQL behaviour (e.g. LIKE wildcard escaping); it proves what the service asks the database for.
 */

interface Fx {
  id: string
  code: string
  businessName: string
  fullName: string
  email: string
  mobile: string
  status: 'PENDING' | 'ACTIVE' | 'REJECTED' | 'SUSPENDED' | 'TERMINATED'
  currentLevel: number | null
  activeCustomerCount: number
  approvedAt: Date | null
  submittedAt: Date
  suspendedAt: Date | null
  suspensionReason: string | null
  // relation counts
  customers: number
  users: number
  accounts: number
}
interface ActivationFx { resellerId: string; status: string }
interface CommissionFx { resellerId: string; status: string; amount: import('@prisma/client').Prisma.Decimal }

const data = {
  resellers: [] as Fx[],
  activations: [] as ActivationFx[],
  commissions: [] as CommissionFx[],
}
const calls = { findMany: 0 }
let queryCounter = 0

type Obj = Record<string, any>
function matches(row: Obj, where: Obj): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true // Prisma ignores undefined filters
    if (key === 'OR') return (cond as Obj[]).some((w) => matches(row, w))
    if (key === 'AND') return (cond as Obj[]).every((w) => matches(row, w))
    const value = row[key]
    if (cond === null || typeof cond !== 'object') return value === cond
    if (cond.contains !== undefined) {
      const hay = String(value ?? '')
      return cond.mode === 'insensitive' ? hay.toLowerCase().includes(String(cond.contains).toLowerCase()) : hay.includes(cond.contains)
    }
    if (cond.notIn) return !cond.notIn.includes(value)
    if (cond.in) return cond.in.includes(value)
    throw new Error(`Unsupported filter on ${key}: ${JSON.stringify(cond)}`)
  })
}

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function sortRows(rows: Fx[], orderBy: Array<Record<string, 'asc' | 'desc'>>) {
  const random = mulberry32(++queryCounter)
  const tieBreak = new Map(rows.map((r) => [r.id, random()]))
  const cmp = (a: unknown, b: unknown, dir: 'asc' | 'desc') => {
    if (a === b) return 0
    if (a === null) return dir === 'desc' ? -1 : 1 // PostgreSQL: NULLS FIRST for DESC, NULLS LAST for ASC
    if (b === null) return dir === 'desc' ? 1 : -1
    const x = a instanceof Date ? a.getTime() : (a as string | number)
    const y = b instanceof Date ? b.getTime() : (b as string | number)
    const c = x < y ? -1 : x > y ? 1 : 0
    return dir === 'desc' ? -c : c
  }
  return [...rows].sort((a, b) => {
    for (const entry of orderBy) {
      const [[field, dir]] = Object.entries(entry)
      const c = cmp((a as Obj)[field], (b as Obj)[field], dir)
      if (c !== 0) return c
    }
    return tieBreak.get(a.id)! - tieBreak.get(b.id)!
  })
}

const USERS: Record<string, object> = {
  'u-admin': { id: 'u-admin', email: 'admin@test.invalid', role: 'ADMIN', status: 'ACTIVE', emailVerified: null, resellerId: null, reseller: null },
  'u-seller': { id: 'u-seller', email: 'seller@test.invalid', role: 'SELLER', status: 'ACTIVE', emailVerified: new Date(), resellerId: 'r1', reseller: { status: 'ACTIVE' } },
}

const fakePrisma = strictFake('prisma', {
  user: { findUnique: async ({ where }: { where: { id: string } }) => USERS[where.id] ?? null },
  commissionLevel: {
    findMany: async () => [
      { level: 1, name: 'Bronze' },
      { level: 2, name: 'Silver' },
      { level: 3, name: 'Gold' },
    ],
  },
  reseller: {
    findMany: async ({ where, select, orderBy, skip, take }: Obj) => {
      calls.findMany++
      const rows = sortRows(data.resellers.filter((r) => matches(r, where)), orderBy).slice(skip, skip + take)
      return rows.map((r) => {
        const out: Obj = Object.fromEntries(Object.keys(select).filter((k) => k !== '_count' && select[k]).map((k) => [k, (r as Obj)[k]]))
        if (select._count) out._count = Object.fromEntries(Object.keys(select._count.select).map((k) => [k, (r as Obj)[k]]))
        return out
      })
    },
    count: async ({ where }: Obj) => data.resellers.filter((r) => matches(r, where)).length,
    groupBy: async ({ by }: { by: string[] }) => {
      assert.deepEqual(by, ['status'])
      const counts = new Map<string, number>()
      for (const r of data.resellers) counts.set(r.status, (counts.get(r.status) ?? 0) + 1)
      return [...counts].map(([status, n]) => ({ status, _count: { _all: n } }))
    },
  },
  activationRequest: {
    groupBy: async ({ where }: Obj) => {
      const counts = new Map<string, number>()
      for (const a of data.activations.filter((x) => matches(x, where))) counts.set(a.resellerId, (counts.get(a.resellerId) ?? 0) + 1)
      return [...counts].map(([resellerId, n]) => ({ resellerId, _count: { _all: n } }))
    },
  },
  commission: {
    groupBy: async ({ where }: Obj) => {
      const sums = new Map<string, import('@prisma/client').Prisma.Decimal>()
      for (const c of data.commissions.filter((x) => matches(x, where))) sums.set(c.resellerId, (sums.get(c.resellerId) ?? c.amount.minus(c.amount)).plus(c.amount))
      return [...sums].map(([resellerId, amount]) => ({ resellerId, _sum: { amount } }))
    },
  },
})

// ---- fixtures -------------------------------------------------------------------------------------------

const day = (s: string) => new Date(`${s}T00:00:00Z`)
function reseller(over: Partial<Fx> & Pick<Fx, 'id' | 'code' | 'businessName'>): Fx {
  return {
    fullName: 'Some Person',
    email: `${over.id}@example.invalid`,
    mobile: '+94700000000',
    status: 'ACTIVE',
    currentLevel: null,
    activeCustomerCount: 0,
    approvedAt: day('2025-01-01'),
    submittedAt: day('2024-12-01'),
    suspendedAt: null,
    suspensionReason: null,
    customers: 0,
    users: 1,
    accounts: 0,
    ...over,
  }
}

function seedSmall(Decimal: typeof import('@prisma/client').Prisma.Decimal) {
  data.resellers = [
    reseller({ id: 'r1', code: 'RS-0001', businessName: 'Acme Salons', fullName: 'Nimal Perera', email: 'nimal@acme.test', mobile: '+94771234567', currentLevel: 2, activeCustomerCount: 7, approvedAt: day('2025-03-01'), customers: 5, users: 2, accounts: 9 }),
    reseller({ id: 'r2', code: 'RS-0002', businessName: 'Blue Mobile Shop', fullName: 'Kamala Silva', email: 'Kamala@BlueMobile.test', mobile: '+94712345678', currentLevel: 1, activeCustomerCount: 2, approvedAt: day('2025-02-01'), customers: 3, users: 1, accounts: 3 }),
    reseller({ id: 'r3', code: 'RS-0003', businessName: 'Cinnamon Fashion', fullName: 'Ruwan Fernando', email: 'ruwan@cinnamon.test', mobile: '+94755550003', status: 'SUSPENDED', currentLevel: 9, activeCustomerCount: 1, approvedAt: day('2025-01-15'), suspendedAt: day('2025-06-01'), suspensionReason: 'Unpaid', customers: 2, users: 1, accounts: 4 }),
    reseller({ id: 'r4', code: 'RS-0004', businessName: 'Delta Traders', fullName: 'Sajith Bandara', email: 'sajith@delta.test', mobile: '+94766660004', status: 'TERMINATED', approvedAt: day('2024-12-01') }),
    reseller({ id: 'p1', code: 'RS-0005', businessName: 'Eastern Pending Co', fullName: 'Dinesh Perera', email: 'dinesh@eastern.test', mobile: '+94777770005', status: 'PENDING', approvedAt: null, submittedAt: day('2025-04-01') }),
    reseller({ id: 'x1', code: 'RS-0006', businessName: 'Foxtrot Rejected', fullName: 'Fiona Perera', email: 'fiona@foxtrot.test', mobile: '+94788880006', status: 'REJECTED', approvedAt: null, submittedAt: day('2025-04-02') }),
  ]
  data.activations = [
    ...['PENDING_REVIEW', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'ACTIVATION_COMPLETED', 'CANCELLED'].map((status) => ({ resellerId: 'r1', status })),
    { resellerId: 'r2', status: 'PENDING_REVIEW' },
    { resellerId: 'r3', status: 'CANCELLED' },
    { resellerId: 'p1', status: 'PENDING_REVIEW' },
  ]
  data.commissions = [
    { resellerId: 'r1', status: 'PENDING', amount: new Decimal('100.10') },
    { resellerId: 'r1', status: 'APPROVED', amount: new Decimal('200.20') },
    { resellerId: 'r1', status: 'PAYABLE', amount: new Decimal('300.30') },
    { resellerId: 'r1', status: 'PAYABLE', amount: new Decimal('-50.05') }, // clawback
    { resellerId: 'r1', status: 'PAID', amount: new Decimal('999') },
    { resellerId: 'r1', status: 'REVERSED', amount: new Decimal('888') },
    { resellerId: 'r2', status: 'PAID', amount: new Decimal('40') },
    { resellerId: 'r3', status: 'PAYABLE', amount: new Decimal('25') },
  ]
}

describe('Admin Resellers list: GET /admin/resellers', () => {
  let api: Awaited<ReturnType<typeof serve>>
  let signAccessToken: typeof import('../src/utils/jwt')['signAccessToken']
  let Decimal: typeof import('@prisma/client').Prisma.Decimal
  let listResellersSchema: typeof import('../src/modules/resellers/admin-resellers.service')['listResellersSchema']

  const adminToken = () => signAccessToken({ userId: 'u-admin', email: 'admin@test.invalid', role: 'ADMIN', resellerId: null })
  const list = (qs = '', token: string = adminToken()) => api.call('GET', `/admin/resellers${qs ? `?${qs}` : ''}`, { token })
  const ids = (res: { json: { data: Array<{ id: string }> } }) => res.json.data.map((r) => r.id)

  before(async () => {
    installHermeticBackend(fakePrisma)
    ;({ signAccessToken } = await import('../src/utils/jwt'))
    ;({ Prisma: { Decimal } } = await import('@prisma/client'))
    ;({ listResellersSchema } = await import('../src/modules/resellers/admin-resellers.service'))
    const { errorHandler } = await import('../src/middleware/error.middleware')
    const { resellersAdminRouter } = await import('../src/modules/resellers/resellers.routes')
    const app = express()
    app.use(express.json())
    app.use('/admin/resellers', resellersAdminRouter)
    app.use(errorHandler)
    api = await serve(app)
  })
  after(async () => {
    await api?.close()
  })
  beforeEach(() => {
    calls.findMany = 0
    seedSmall(Decimal)
  })

  describe('default view and status filters', () => {
    it('by default lists approved resellers (active, suspended, terminated) and hides pending and rejected ones', async () => {
      const res = await list()
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.deepEqual(ids(res), ['r1', 'r2', 'r3', 'r4'], 'newest approval first')
      assert.equal(res.json.meta.total, 4)
    })

    it('Active and Suspended return only their own records', async () => {
      assert.deepEqual(ids(await list('status=ACTIVE')), ['r1', 'r2'])
      assert.deepEqual(ids(await list('status=SUSPENDED')), ['r3'])
      assert.equal((await list('status=ACTIVE')).json.meta.total, 2)
    })

    it('an explicit status can still reach the hidden ones (used by the Applications link)', async () => {
      assert.deepEqual(ids(await list('status=PENDING')), ['p1'])
      assert.deepEqual(ids(await list('status=REJECTED')), ['x1'])
      assert.deepEqual(ids(await list('status=TERMINATED')), ['r4'])
    })

    it('statusCounts count every reseller by status regardless of the current filter or search', async () => {
      const expected = { ACTIVE: 2, SUSPENDED: 1, TERMINATED: 1, PENDING: 1, REJECTED: 1 }
      assert.deepEqual((await list()).json.meta.statusCounts, expected)
      assert.deepEqual((await list('status=SUSPENDED&search=cinnamon')).json.meta.statusCounts, expected)
    })
  })

  describe('search', () => {
    const cases: Array<[string, string, string[]]> = [
      ['code', 'rs-0002', ['r2']],
      ['code (upper case)', 'RS-0001', ['r1']],
      ['business name', 'CINNAMON fashion', ['r3']],
      ['full name', 'ruwan', ['r3']],
      ['full name (mixed case)', 'nImAl PERERA', ['r1']],
      ['email', 'KAMALA@bluemobile.TEST', ['r2']],
      ['email stored in mixed case', 'kamala@bluemobile.test', ['r2']],
      ['mobile (stored form)', '+94712345678', ['r2']],
      ['partial match', 'mobile', ['r2']],
    ]
    for (const [label, term, expected] of cases) {
      it(`finds a reseller by ${label}, ignoring case`, async () => {
        assert.deepEqual(ids(await list(`search=${encodeURIComponent(term)}`)), expected)
      })
    }

    it('trims the term, and a blank search means no search', async () => {
      assert.deepEqual(ids(await list('search=%20%20acme%20%20')), ['r1'])
      assert.equal((await list('search=%20%20')).json.meta.total, 4)
    })

    it('returns an empty page, with zero totals, when nothing matches', async () => {
      const res = await list('search=zzz-no-such-reseller')
      assert.deepEqual(res.json.data, [])
      assert.equal(res.json.meta.total, 0)
      assert.equal(res.json.meta.totalPages, 0)
    })

    it('combines with the status filter and never widens the default view to pending/rejected', async () => {
      assert.deepEqual(ids(await list('search=perera')), ['r1'], 'Dinesh and Fiona Perera are pending/rejected')
      assert.deepEqual(ids(await list('search=perera&status=PENDING')), ['p1'])
      assert.deepEqual(ids(await list('search=rs-000&status=ACTIVE')), ['r1', 'r2'])
      assert.deepEqual(ids(await list('search=cinnamon&status=ACTIVE')), [])
    })

    it('finds a mobile number however it is typed (stored as +947XXXXXXXX)', async () => {
      for (const typed of ['0771234567', '077 123 4567', '077-123-4567', '+94 77 123 4567', '94771234567', '771234567', '0771234']) {
        assert.deepEqual(ids(await list(`search=${encodeURIComponent(typed)}`)), ['r1'], `typed as "${typed}"`)
      }
      assert.deepEqual(ids(await list('search=0712345678')), ['r2'])
      assert.deepEqual(ids(await list('search=0700000099')), [], 'a different number matches nothing')
    })

    it('a lone "0" is not turned into an empty term that matches everyone', async () => {
      // No field of this reseller contains a "0", so searching "0" must find nothing (an empty term would match all).
      data.resellers = [reseller({ id: 'z1', code: 'AB-1', businessName: 'Zed', fullName: 'Zed One', email: 'zed@example.invalid', mobile: '+94771234567' })]
      const res = await list('search=0')
      assert.equal(res.json.meta.total, 0)
    })
  })

  describe('pagination', () => {
    function bulk(n: number, over: Partial<Fx> = {}) {
      data.resellers = Array.from({ length: n }, (_, i) =>
        reseller({ id: `b-${String(i + 1).padStart(3, '0')}`, code: `BULK-${i + 1}`, businessName: `Bulk ${i + 1}`, ...over }),
      )
    }

    it('splits 60 resellers into pages of 25 with correct totals and meta', async () => {
      bulk(60)
      for (let i = 0; i < 60; i++) data.resellers[i].approvedAt = new Date(Date.UTC(2025, 0, 1) + i * 86_400_000)
      const pages = [await list('page=1&limit=25'), await list('page=2&limit=25'), await list('page=3&limit=25')]
      assert.deepEqual(pages.map((p) => p.json.data.length), [25, 25, 10])
      for (const [i, p] of pages.entries()) assert.deepEqual({ total: p.json.meta.total, page: p.json.meta.page, limit: p.json.meta.limit, totalPages: p.json.meta.totalPages }, { total: 60, page: i + 1, limit: 25, totalPages: 3 })
      const all = pages.flatMap((p) => ids(p))
      assert.equal(new Set(all).size, 60, 'no row repeated or skipped across pages')
      assert.equal(all[0], 'b-060', 'newest approval first')
    })

    it('defaults to 20 per page', async () => {
      bulk(45)
      const res = await list()
      assert.equal(res.json.data.length, 20)
      assert.equal(res.json.meta.limit, 20)
      assert.equal(res.json.meta.totalPages, 3)
    })

    it('every row appears exactly once across pages even when all rows tie on the sort keys', async () => {
      bulk(60) // identical approvedAt and submittedAt on every row, as after a bulk import
      const seen: string[] = []
      for (const page of [1, 2, 3]) seen.push(...ids(await list(`page=${page}&limit=25`)))
      assert.equal(seen.length, 60)
      assert.equal(new Set(seen).size, 60, 'duplicates mean other rows were skipped')
    })

    it('a page past the end is empty but still reports the real totals', async () => {
      bulk(60)
      const res = await list('page=9&limit=25')
      assert.deepEqual(res.json.data, [])
      assert.deepEqual({ total: res.json.meta.total, totalPages: res.json.meta.totalPages, page: res.json.meta.page }, { total: 60, totalPages: 3, page: 9 })
    })

    it('totals follow the filter and the search, and page 1 of a narrower result starts from its first row', async () => {
      bulk(60)
      data.resellers.slice(0, 30).forEach((r) => (r.status = 'SUSPENDED'))
      const suspended = await list('status=SUSPENDED&limit=25')
      assert.deepEqual({ total: suspended.json.meta.total, totalPages: suspended.json.meta.totalPages, n: suspended.json.data.length }, { total: 30, totalPages: 2, n: 25 })
      const searched = await list('search=bulk%2012&limit=25') // Bulk 12, Bulk 120... → 12 only (60 rows)
      assert.deepEqual({ total: searched.json.meta.total, n: searched.json.data.length }, { total: 1, n: 1 })
    })
  })

  describe('computed columns', () => {
    const byId = async () => Object.fromEntries((await list()).json.data.map((r: { id: string }) => [r.id, r]))

    it('level name comes from the levels table, falls back to "Level N", and is null without a level', async () => {
      const rows = await byId()
      assert.equal(rows.r1.levelName, 'Silver')
      assert.equal(rows.r2.levelName, 'Bronze')
      assert.equal(rows.r3.levelName, 'Level 9')
      assert.equal(rows.r4.levelName, null)
    })

    it('counts customers, users and open activation requests per reseller', async () => {
      const rows = await byId()
      assert.deepEqual([rows.r1.customers, rows.r1.users, rows.r1.activeCustomerCount], [5, 2, 7])
      assert.equal(rows.r1.openActivationRequests, 3, 'PENDING_REVIEW + UNDER_REVIEW + APPROVED only')
      assert.equal(rows.r2.openActivationRequests, 1)
      assert.equal(rows.r3.openActivationRequests, 0, 'a cancelled request is not open')
      assert.equal(rows.r4.openActivationRequests, 0)
    })

    it('unpaid commission is pending + approved + payable, net of clawbacks, as a decimal string', async () => {
      const rows = await byId()
      assert.equal(rows.r1.unpaidCommission, '550.55', '100.10 + 200.20 + 300.30 - 50.05; paid and reversed excluded')
      assert.equal(rows.r2.unpaidCommission, '0', 'only a paid commission')
      assert.equal(rows.r3.unpaidCommission, '25')
      assert.equal(rows.r4.unpaidCommission, '0')
    })

    it('shows suspension details only for the suspended reseller', async () => {
      const rows = await byId()
      assert.equal(rows.r3.suspensionReason, 'Unpaid')
      assert.ok(rows.r3.suspendedAt)
      assert.equal(rows.r1.suspendedAt, null)
    })

    it('active and total customers are counted in the same unit, so active never exceeds total', async () => {
      // r1: 5 customer records but 9 customer accounts (one per customer × product), 7 of them active.
      const rows = await byId()
      assert.equal(rows.r1.customers, 5, 'existing field keeps its meaning')
      assert.equal(rows.r1.customerAccounts, 9)
      for (const r of Object.values(rows) as Array<{ id: string; activeCustomerCount: number; customerAccounts: number }>) {
        assert.ok(r.activeCustomerCount <= r.customerAccounts, `${r.id}: ${r.activeCustomerCount} active of ${r.customerAccounts} accounts`)
      }
    })

    it('does not expose identity or bank data', async () => {
      const row = (await list()).json.data[0]
      for (const key of ['nicOrPassport', 'address', 'bankAccount', 'passwordHash']) assert.equal(key in row, false, key)
    })
  })

  describe('validation (422 with the standard validation body) and authorization', () => {
    const invalid = [
      ['an unknown status', 'status=ACTIVEE', /^status:/],
      ['a lower-case status', 'status=active', /^status:/],
      ['a limit above 100', 'limit=101', /^limit: .*100/],
      ['a limit of 0', 'limit=0', /^limit:/],
      ['a negative limit', 'limit=-5', /^limit:/],
      ['a non-numeric limit', 'limit=abc', /^limit:/],
      ['page 0', 'page=0', /^page:/],
      ['a negative page', 'page=-1', /^page:/],
      ['a fractional page', 'page=1.5', /^page:/],
      ['a non-numeric page', 'page=abc', /^page:/],
      ['a search term over 100 characters', `search=${'x'.repeat(101)}`, /^search:/],
    ] as const
    for (const [label, qs, pattern] of invalid) {
      it(`rejects ${label}`, async () => {
        const res = await list(qs)
        assert.equal(res.status, 422)
        assert.equal(res.json.success, false)
        assert.equal(res.json.message, 'Validation error')
        assert.ok(Array.isArray(res.json.errors) && res.json.errors.length > 0)
        assert.match(res.json.errors[0], pattern)
        assert.equal(calls.findMany, 0, 'rejected before any query runs')
      })
    }

    it('accepts the boundaries: limit 1 and limit 100', async () => {
      assert.equal((await list('limit=1')).json.data.length, 1)
      const res = await list('limit=100')
      assert.equal(res.status, 200)
      assert.equal(res.json.meta.limit, 100)
    })

    it('needs a signed-in user with resellers:read: no token 401, a reseller user 403', async () => {
      assert.equal((await api.call('GET', '/admin/resellers')).status, 401)
      const seller = signAccessToken({ userId: 'u-seller', email: 'seller@test.invalid', role: 'SELLER', resellerId: 'r1' })
      const res = await list('', seller)
      assert.equal(res.status, 403)
      assert.equal(calls.findMany, 0)
    })

    it('the query string the Resellers page builds passes this validation', async () => {
      const { listQuery, withSearch, withStatus, INITIAL_LIST_VIEW } = await import('../../web/src/lib/paged-list')
      const views = [INITIAL_LIST_VIEW, withStatus(INITIAL_LIST_VIEW, 'SUSPENDED'), withSearch(withStatus(INITIAL_LIST_VIEW, 'ACTIVE'), '  acme ')]
      for (const view of views) {
        const params = Object.fromEntries(listQuery(view, 25))
        assert.equal(listResellersSchema.safeParse(params).success, true, JSON.stringify(params))
        assert.equal((await list(new URLSearchParams(params).toString())).status, 200)
      }
    })
  })
})
