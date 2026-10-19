import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { installHermeticBackend, serve, strictFake } from './helpers/hermetic-backend'

/**
 * Admin → Commissions: the ledger list (`GET /commissions`) and the actions behind the page
 * (`POST /commissions/approve`, `POST /commissions/:id/reverse`, `POST /commissions/payouts`).
 *  - who may read and who may act; a reseller only ever sees its own entries;
 *  - list filters, the net total, and a page order that cannot repeat or skip rows;
 *  - approve: PENDING → APPROVED (inside the refund hold) or PAYABLE, only PENDING rows move, a repeat does nothing,
 *    and the audit entry is written in the same transaction as the change;
 *  - reverse: unpaid → REVERSED, paid → stays PAID plus a negative clawback, never twice, and never over a row that was
 *    paid or reversed after it was read;
 *  - payout: settles exactly the PAYABLE rows (net of clawbacks) once.
 *
 * Database-free (see tests/helpers/hermetic-backend.ts): the real router, auth, validation, controller, services and audit
 * code run against an in-memory commission ledger that evaluates the WHERE conditions the services send (so a row that
 * changed between a read and a write is seen), returns tied rows in an unspecified order, and rolls a transaction back
 * if its callback throws. It cannot prove PostgreSQL itself. Nothing here reads `.env`, runs Prisma or opens a connection.
 */

type Row = Record<string, any>
let Decimal: typeof import('@prisma/client').Prisma.Decimal
let PrismaNs: typeof import('@prisma/client').Prisma
let businessDateOf: typeof import('../src/utils/period')['businessDateOf']

const NOW = Date.now()
const DAY = 24 * 60 * 60 * 1000
const PAST = new Date(NOW - 2 * DAY) // refund hold already over
const FUTURE = new Date(NOW + 5 * DAY) // still on hold

const ledger = new Map<string, Row>()
const payouts = new Map<string, Row>()
const state = {
  audit: [] as Row[],
  notifications: [] as Row[],
  failAudit: undefined as Error | undefined,
  seq: 0,
  calls: 0,
  /** Runs once, right after the service's first commission read: lets a test play "someone else acted in between". */
  afterFirstRead: undefined as (() => void) | undefined,
}

const USERS: Record<string, Row> = {
  'u-admin': { id: 'u-admin', email: 'admin@test.invalid', role: 'ADMIN', status: 'ACTIVE', emailVerified: null, resellerId: null, reseller: null },
  'u-r1': { id: 'u-r1', email: 'r1@test.invalid', role: 'SELLER', status: 'ACTIVE', emailVerified: new Date(), resellerId: 'r1', reseller: { status: 'ACTIVE' } },
  'u-r2': { id: 'u-r2', email: 'r2@test.invalid', role: 'SELLER', status: 'ACTIVE', emailVerified: new Date(), resellerId: 'r2', reseller: { status: 'ACTIVE' } },
  'u-pending': { id: 'u-pending', email: 'p@test.invalid', role: 'SELLER', status: 'ACTIVE', emailVerified: new Date(), resellerId: 'r3', reseller: { status: 'PENDING' } },
}
const RESELLERS = new Set(['r1', 'r2', 'r3'])

const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b)

/** A WHERE clause as PostgreSQL would evaluate it against the row as it is right now. */
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      return Object.entries(cond).every(([op, v]) => {
        switch (op) {
          case 'in': return (v as unknown[]).includes(row[key])
          case 'notIn': return !(v as unknown[]).includes(row[key])
          case 'not': return !same(row[key], v)
          case 'lte': return row[key] <= (v as any)
          case 'gt': return row[key] > (v as any)
          default: throw new Error(`The fake does not understand ${op} on ${key}`)
        }
      })
    }
    return same(row[key], cond)
  })
}

const definedOnly = (o: object) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
const project = (row: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : { ...row })

/** Rows written through a transaction are recorded, so a rollback undoes exactly those and not other connections' writes. */
const commissionFor = (wrote?: Set<string>) => ({
  ...commissionReads,
  updateMany: async ({ where, data }: { where: Row; data: Row }) => {
    const hit = [...ledger.values()].filter((r) => matches(r, where))
    for (const r of hit) {
      wrote?.add(r.id)
      Object.assign(r, definedOnly(data))
    }
    return { count: hit.length }
  },
  /** `update` with extra conditions in `where` is one UPDATE … WHERE; no matching row is Prisma's P2025. */
  update: async ({ where, data }: { where: Row; data: Row }) => {
    const row = [...ledger.values()].find((r) => matches(r, where))
    if (!row) throw new PrismaNs.PrismaClientKnownRequestError('Record to update not found.', { code: 'P2025', clientVersion: 'test' })
    wrote?.add(row.id)
    Object.assign(row, definedOnly(data))
    return { ...row }
  },
  create: async ({ data }: { data: Row }) => {
    if (data.reversalOfId && [...ledger.values()].some((r) => r.reversalOfId === data.reversalOfId)) throw new Error('Unique constraint failed on reversalOfId')
    const row = { id: `cm-new-${++state.seq}`, seq: 1000 + state.seq, createdAt: new Date(), reversedAt: null, payoutId: null, paidAt: null, ...definedOnly(data) }
    wrote?.add(row.id)
    ledger.set(row.id, row)
    return { ...row }
  },
})

/** ORDER BY as the database applies it; rows that tie on every column come back in no promised order (it differs per query). */
function orderRows(rows: Row[], keys: Row[] = [], call: number): Row[] {
  return [...rows].sort((a, b) => {
    for (const spec of keys) {
      const [field, dir] = Object.entries(spec)[0] as [string, 'asc' | 'desc']
      const x = a[field] instanceof Date ? a[field].getTime() : a[field]
      const y = b[field] instanceof Date ? b[field].getTime() : b[field]
      if (x !== y) return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1)
    }
    return (a.seq - b.seq) * (call % 2 === 0 ? -1 : 1)
  })
}

const commissionReads = {
  findUnique: async ({ where }: { where: { id: string } }) => {
    const row = ledger.get(where.id)
    const out = row ? { ...row } : null
    if (state.afterFirstRead) {
      const hook = state.afterFirstRead
      state.afterFirstRead = undefined
      hook() // another transaction committing: a rollback of this one only undoes this one's own writes
    }
    return out
  },
  findMany: async (args: { where?: Row; select?: Row; include?: Row; orderBy?: Row[]; skip?: number; take?: number }) => {
    const call = ++state.calls
    let rows = [...ledger.values()].filter((r) => matches(r, args.where))
    rows = orderRows(rows, args.orderBy, call)
    rows = rows.slice(args.skip ?? 0, args.take === undefined ? undefined : (args.skip ?? 0) + args.take)
    return rows.map((r) =>
      args.include
        ? {
            ...r,
            customerAccount: { id: r.customerAccountId, status: 'ACTIVE', customer: { id: 'c', displayName: `Customer ${r.customerAccountId}` } },
            product: { code: 'SALON', name: 'Hexalyte Salon' },
            reseller: { id: r.resellerId, code: r.resellerId.toUpperCase(), businessName: `Reseller ${r.resellerId}` },
            payout: r.payoutId ? { id: r.payoutId, paymentReference: payouts.get(r.payoutId)?.paymentReference, paidAt: payouts.get(r.payoutId)?.paidAt } : null,
          }
        : project(r, args.select),
    )
  },
  count: async ({ where }: { where: Row }) => [...ledger.values()].filter((r) => matches(r, where)).length,
  aggregate: async ({ where }: { where: Row }) => {
    const rows = [...ledger.values()].filter((r) => matches(r, where))
    return { _sum: { amount: rows.length ? rows.reduce((s, r) => s.add(r.amount), new Decimal(0)) : null } }
  },
}
const commission = commissionFor()

const commissionPayout = {
  findMany: async (args: { where?: Row; include?: Row; orderBy?: Row[]; skip?: number; take?: number }) => {
    const call = ++state.calls
    const ordered = orderRows([...payouts.values()].filter((r) => matches(r, args.where)), args.orderBy, call)
    const rows = ordered.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? 1000))
    return rows.map((r) => ({
      ...r,
      reseller: { code: r.resellerId.toUpperCase(), businessName: `Reseller ${r.resellerId}` },
      _count: { commissions: [...ledger.values()].filter((c) => c.payoutId === r.id).length },
    }))
  },
  count: async ({ where }: { where?: Row }) => [...payouts.values()].filter((r) => matches(r, where)).length,
  create: async ({ data }: { data: Row }) => {
    const row = { id: `po-${++state.seq}`, seq: ++state.seq, createdAt: new Date(), note: null, ...definedOnly(data) }
    payouts.set(row.id, row)
    return { ...row }
  },
}

const auditLog = {
  create: async ({ data }: { data: Row }) => {
    if (state.failAudit) {
      const err = state.failAudit
      state.failAudit = undefined
      throw err
    }
    state.audit.push({ ...data })
  },
}

const txFor = (wrote: Set<string>) => ({
  commission: commissionFor(wrote),
  commissionPayout,
  auditLog,
  reseller: { findUnique: async ({ where }: { where: { id: string } }) => (RESELLERS.has(where.id) ? { id: where.id } : null) },
})

const fakePrisma = strictFake('prisma', {
  user: {
    findUnique: async ({ where }: { where: { id: string } }) => USERS[where.id] ?? null,
    findMany: async ({ where }: { where: Row }) => Object.values(USERS).filter((u) => u.resellerId === where.resellerId && u.status === 'ACTIVE').map((u) => ({ id: u.id })),
  },
  notification: { createMany: async ({ data }: { data: Row[] }) => void state.notifications.push(...data) },
  commission,
  commissionPayout,
  $transaction: async <T>(arg: ((t: ReturnType<typeof txFor>) => Promise<T>) | Promise<unknown>[]): Promise<T> => {
    if (Array.isArray(arg)) return Promise.all(arg) as Promise<T>
    const snapshot = new Map([...ledger].map(([k, v]) => [k, { ...v }] as const))
    const wrote = new Set<string>()
    const payoutSnapshot = new Map([...payouts].map(([k, v]) => [k, { ...v }] as const))
    const auditLength = state.audit.length
    try {
      return await arg(txFor(wrote))
    } catch (err) {
      for (const id of wrote) {
        const before = snapshot.get(id)
        if (before) ledger.set(id, before)
        else ledger.delete(id)
      }
      payouts.clear()
      payoutSnapshot.forEach((v, k) => payouts.set(k, v))
      state.audit.length = auditLength
      throw err
    }
  },
})

const entry = (id: string, resellerId: string, status: string, amount: string, over: Row = {}): Row => ({
  id,
  seq: ++state.seq,
  resellerId,
  productId: 'p1',
  customerAccountId: `acc-${id}`,
  subscriptionEventId: null,
  entryType: 'EARNING',
  periodMonth: '2026-10',
  level: 1,
  baseAmount: new Decimal('5000'),
  rate: new Decimal('10'),
  amount: new Decimal(amount),
  currency: 'LKR',
  status,
  payableAt: status === 'PENDING' || status === 'APPROVED' ? FUTURE : PAST,
  approvedAt: null,
  approvedById: null,
  payoutId: null,
  paidAt: null,
  reversedAt: null,
  reversedById: null,
  reversalReason: null,
  reversalOfId: null,
  createdAt: new Date('2026-10-01T05:00:00Z'),
  ...over,
})
const put = (...rows: Row[]) => rows.forEach((r) => ledger.set(r.id, r))
const row = (id: string) => ledger.get(id)!
const REASON = 'Customer asked for a refund'

describe('Admin → Commissions: list and actions', () => {
  let api: Awaited<ReturnType<typeof serve>>
  let signAccessToken: typeof import('../src/utils/jwt')['signAccessToken']

  const tokens: Record<string, string> = {}
  const get = (path: string, who = 'u-admin') => api.call('GET', `/api/v1/commissions${path}`, { token: tokens[who] })
  const approve = (ids: unknown, who = 'u-admin') => api.call('POST', '/api/v1/commissions/approve', { token: tokens[who], body: { ids } })
  const reverse = (id: string, reason: unknown = REASON, who = 'u-admin') => api.call('POST', `/api/v1/commissions/${id}/reverse`, { token: tokens[who], body: { reason } })
  const pay = (body: unknown, who = 'u-admin') => api.call('POST', '/api/v1/commissions/payouts', { token: tokens[who], body })
  const actions = () => state.audit.map((a) => a.action)
  const untouched = (...ids: string[]) => ids.forEach((id) => assert.equal(row(id).status, snapshotStatus[id], `${id} changed`))
  let snapshotStatus: Record<string, string>
  const remember = () => (snapshotStatus = Object.fromEntries([...ledger].map(([k, v]) => [k, v.status])))

  before(async () => {
    installHermeticBackend(fakePrisma)
    PrismaNs = (await import('@prisma/client')).Prisma
    ;({ Decimal } = PrismaNs)
    ;({ signAccessToken } = await import('../src/utils/jwt'))
    ;({ businessDateOf } = await import('../src/utils/period'))
    const { default: app } = await import('../src/app')
    for (const [id, u] of Object.entries(USERS)) tokens[id] = signAccessToken({ userId: id, email: u.email, role: u.role, resellerId: u.resellerId })
    api = await serve(app as unknown as express.Express)
  })
  after(async () => api?.close())
  beforeEach(() => {
    ledger.clear()
    payouts.clear()
    state.audit.length = 0
    state.notifications.length = 0
    state.failAudit = undefined
    state.afterFirstRead = undefined
    state.seq = 0
    state.calls = 0
  })

  describe('who may read and who may act', () => {
    it('refuses every endpoint without a token (401)', async () => {
      put(entry('c1', 'r1', 'PENDING', '500'))
      assert.equal((await api.call('GET', '/api/v1/commissions')).status, 401)
      assert.equal((await api.call('POST', '/api/v1/commissions/approve', { body: { ids: ['c1'] } })).status, 401)
      assert.equal((await api.call('POST', '/api/v1/commissions/c1/reverse', { body: { reason: REASON } })).status, 401)
      assert.equal((await api.call('POST', '/api/v1/commissions/payouts', { body: { resellerId: 'r1', paymentReference: 'TX-1' } })).status, 401)
      assert.equal(row('c1').status, 'PENDING')
    })

    it('lets a reseller read the ledger but never approve, reverse or pay (403), changing nothing', async () => {
      put(entry('c1', 'r1', 'PENDING', '500'), entry('c2', 'r1', 'PAYABLE', '500'), entry('c3', 'r1', 'PAID', '500', { payoutId: 'po-x' }))
      remember()
      assert.equal((await get('', 'u-r1')).status, 200)
      assert.equal((await approve(['c1'], 'u-r1')).status, 403)
      assert.equal((await reverse('c1', REASON, 'u-r1')).status, 403)
      assert.equal((await reverse('c3', REASON, 'u-r1')).status, 403)
      assert.equal((await pay({ resellerId: 'r1', paymentReference: 'TX-1' }, 'u-r1')).status, 403)
      untouched('c1', 'c2', 'c3')
      assert.equal(ledger.size, 3, 'no clawback was created')
      assert.deepEqual(state.audit, [])
      assert.deepEqual(state.notifications, [])
    })

    it('refuses a reseller whose application is still pending, even to read (403)', async () => {
      assert.equal((await get('', 'u-pending')).status, 403)
    })

    it('shows a reseller only its own entries, whatever resellerId it asks for', async () => {
      put(entry('a1', 'r1', 'PAYABLE', '500'), entry('b1', 'r2', 'PAYABLE', '700'))
      const own = await get('', 'u-r1')
      assert.deepEqual(own.json.data.map((r: Row) => r.id), ['a1'])
      const spoof = await get('?resellerId=r2', 'u-r1')
      assert.deepEqual(spoof.json.data.map((r: Row) => r.id), ['a1'], 'asking for another reseller changes nothing')
      assert.equal(spoof.json.meta.total, 1)
      assert.equal(spoof.json.meta.netAmount, '500')
    })

    it('lets an admin see every reseller and narrow to one', async () => {
      put(entry('a1', 'r1', 'PAYABLE', '500'), entry('b1', 'r2', 'PAYABLE', '700'))
      assert.equal((await get('')).json.meta.total, 2)
      assert.deepEqual((await get('?resellerId=r2')).json.data.map((r: Row) => r.id), ['b1'])
    })
  })

  describe('list filters, totals and paging', () => {
    beforeEach(() => {
      put(
        entry('p1', 'r1', 'PENDING', '500'),
        entry('p2', 'r1', 'PENDING', '300', { periodMonth: '2026-09' }),
        entry('ap', 'r1', 'APPROVED', '400'),
        entry('pb', 'r1', 'PAYABLE', '600'),
        entry('pd', 'r1', 'PAID', '550', { reversedAt: new Date(), payoutId: 'po-1' }), // paid, then refunded …
        entry('cb', 'r1', 'PAYABLE', '-550', { entryType: 'CLAWBACK', reversalOfId: 'pd' }), // … so recovered by a clawback
        entry('rv', 'r1', 'REVERSED', '900', { reversedAt: new Date() }),
      )
      payouts.set('po-1', { id: 'po-1', paymentReference: 'TX-OLD', paidAt: new Date('2026-09-20') })
    })

    it('filters by status and by billing month, and the total counts only what matches', async () => {
      const pending = await get('?status=PENDING')
      assert.deepEqual(pending.json.data.map((r: Row) => r.id).sort(), ['p1', 'p2'])
      assert.equal(pending.json.meta.total, 2)
      assert.equal(pending.json.meta.netAmount, '800')

      const october = await get('?periodMonth=2026-10&status=PENDING')
      assert.deepEqual(october.json.data.map((r: Row) => r.id), ['p1'])
      assert.equal(october.json.meta.netAmount, '500')

      const none = await get('?status=PAID&periodMonth=2026-09')
      assert.deepEqual(none.json.data, [])
      assert.equal(none.json.meta.total, 0)
      assert.equal(none.json.meta.netAmount, '0')
    })

    it('"net" leaves out reversed entries unless that status is asked for, and a clawback offsets the paid entry it recovers', async () => {
      const all = await get('')
      assert.equal(all.json.meta.total, 7, 'the reversed row is listed …')
      assert.equal(Number(all.json.meta.netAmount), 500 + 300 + 400 + 600 + 550 - 550, '… but not counted in the net')
      assert.equal(Number((await get('?status=REVERSED')).json.meta.netAmount), 900)
      assert.equal(Number((await get('?status=PAYABLE')).json.meta.netAmount), 600 - 550)
    })

    it('shows the payout a paid entry belongs to', async () => {
      const paid = (await get('?status=PAID')).json.data[0]
      assert.deepEqual(paid.payout, { id: 'po-1', paymentReference: 'TX-OLD', paidAt: new Date('2026-09-20').toISOString() })
    })

    it('rejects filters the page cannot send with 422', async () => {
      for (const q of ['?status=DONE', '?periodMonth=2026-13', '?periodMonth=October', '?page=0', '?limit=0', '?limit=101', '?entryType=OTHER']) {
        assert.equal((await get(q)).status, 422, q)
      }
    })

    it('pages through entries created at the same instant without repeating or skipping any', async () => {
      ledger.clear()
      const ids = Array.from({ length: 7 }, (_, i) => `t${i + 1}`)
      put(...ids.map((id) => entry(id, 'r1', 'PENDING', '100'))) // all share one createdAt
      const seen: string[] = []
      for (let page = 1; page <= 4; page++) {
        const res = await get(`?limit=2&page=${page}`)
        assert.equal(res.json.meta.totalPages, 4)
        seen.push(...res.json.data.map((r: Row) => r.id))
      }
      assert.equal(new Set(seen).size, 7, `repeated or missing rows: ${seen}`)
      assert.deepEqual([...seen].sort(), [...ids].sort())
    })

    it('moves APPROVED entries whose hold has ended to PAYABLE before listing them', async () => {
      put(entry('late', 'r1', 'APPROVED', '250', { payableAt: PAST }))
      const res = await get('?status=PAYABLE')
      assert.ok(res.json.data.some((r: Row) => r.id === 'late'))
      assert.equal(row('late').status, 'PAYABLE')
    })
  })

  describe('approve', () => {
    it('sends PENDING entries to APPROVED inside the hold period and to PAYABLE once it is over, recording who and when', async () => {
      put(entry('hold', 'r1', 'PENDING', '500'), entry('over', 'r1', 'PENDING', '500', { payableAt: PAST }))
      const res = await approve(['hold', 'over'])
      assert.equal(res.status, 200)
      assert.deepEqual(res.json.data, { approved: 1, payable: 1, skipped: 0 })
      assert.equal(row('hold').status, 'APPROVED')
      assert.equal(row('over').status, 'PAYABLE')
      for (const id of ['hold', 'over']) {
        assert.equal(row(id).approvedById, 'u-admin')
        assert.ok(row(id).approvedAt instanceof Date)
      }
      assert.deepEqual(actions(), ['COMMISSION_APPROVED'])
      assert.deepEqual(state.audit[0].metadata, { ids: ['hold', 'over'], approved: 1, payable: 1, skipped: 0 })
      assert.equal(state.audit[0].actorEmail, 'admin@test.invalid')
    })

    it('moves only PENDING entries: anything else in the selection (or unknown) is skipped and left exactly as it was', async () => {
      put(
        entry('pend', 'r1', 'PENDING', '500'),
        entry('appr', 'r1', 'APPROVED', '500'),
        entry('pbl', 'r1', 'PAYABLE', '500'),
        entry('paid', 'r1', 'PAID', '500', { payoutId: 'po-1' }),
        entry('rev', 'r1', 'REVERSED', '500', { reversedAt: new Date() }),
      )
      remember()
      const res = await approve(['pend', 'appr', 'pbl', 'paid', 'rev', 'ghost'])
      assert.deepEqual(res.json.data, { approved: 1, payable: 0, skipped: 5 })
      untouched('appr', 'pbl', 'paid', 'rev')
      assert.equal(row('pend').status, 'APPROVED')
      assert.equal(state.audit[0].metadata.skipped, 5)
    })

    it('counts an id sent twice once', async () => {
      put(entry('c1', 'r1', 'PENDING', '500'))
      const res = await approve(['c1', 'c1', 'c1'])
      assert.deepEqual(res.json.data, { approved: 1, payable: 0, skipped: 0 })
      assert.deepEqual(state.audit[0].metadata.ids, ['c1'])
    })

    it('does nothing the second time: 409, no change and no second audit entry', async () => {
      put(entry('c1', 'r1', 'PENDING', '500'))
      assert.equal((await approve(['c1'])).status, 200)
      const again = await approve(['c1'])
      assert.equal(again.status, 409)
      assert.equal(again.json.message, 'No pending commissions found in the selection')
      assert.equal(row('c1').status, 'APPROVED')
      assert.deepEqual(actions(), ['COMMISSION_APPROVED'])
    })

    it('answers 409 when nothing in the selection is pending, with no audit entry', async () => {
      put(entry('c1', 'r1', 'PAYABLE', '500'))
      assert.equal((await approve(['c1', 'nope'])).status, 409)
      assert.deepEqual(state.audit, [])
    })

    it('does not approve anything when its audit entry cannot be written', async () => {
      put(entry('c1', 'r1', 'PENDING', '500'), entry('c2', 'r1', 'PENDING', '500', { payableAt: PAST }))
      state.failAudit = new Error('audit table unavailable')
      const res = await approve(['c1', 'c2'])
      assert.equal(res.status, 500)
      assert.equal(row('c1').status, 'PENDING')
      assert.equal(row('c2').status, 'PENDING')
      assert.equal(row('c1').approvedById, null)
      assert.deepEqual(state.audit, [])
      assert.equal((await approve(['c1', 'c2'])).status, 200, 'and it can simply be tried again')
    })

    it('rejects an empty or oversized selection with 422', async () => {
      assert.equal((await approve([])).status, 422)
      assert.equal((await approve(Array.from({ length: 501 }, (_, i) => `id${i}`))).status, 422)
      assert.equal((await approve('c1')).status, 422)
      assert.equal((await api.call('POST', '/api/v1/commissions/approve', { token: tokens['u-admin'], body: {} })).status, 422)
    })
  })

  describe('reverse', () => {
    it('reverses an unpaid entry whatever its stage, keeps the reason, and tells the reseller', async () => {
      put(entry('pend', 'r1', 'PENDING', '500'), entry('appr', 'r1', 'APPROVED', '500'), entry('pbl', 'r1', 'PAYABLE', '500'))
      for (const id of ['pend', 'appr', 'pbl']) {
        const res = await reverse(id)
        assert.equal(res.status, 200, id)
        assert.equal(res.json.data.clawback, null)
        assert.equal(row(id).status, 'REVERSED')
        assert.equal(row(id).reversalReason, REASON)
        assert.equal(row(id).reversedById, 'u-admin')
        assert.ok(row(id).reversedAt instanceof Date)
      }
      assert.equal(ledger.size, 3, 'no clawback for unpaid entries')
      assert.deepEqual(actions(), ['COMMISSION_REVERSED', 'COMMISSION_REVERSED', 'COMMISSION_REVERSED'])
      assert.equal(state.audit[0].resellerId, 'r1')
      assert.equal(state.audit[0].metadata.reason, REASON)
      assert.equal(state.notifications.length, 3)
      assert.equal(state.notifications[0].type, 'COMMISSION_REVERSED')
      assert.equal(state.notifications[0].userId, 'u-r1')
    })

    it('keeps a paid entry PAID and adds a negative clawback that the next payout recovers', async () => {
      put(entry('paid', 'r1', 'PAID', '550', { payoutId: 'po-1', paidAt: PAST }), entry('next', 'r1', 'PAYABLE', '900'))
      const res = await reverse('paid')
      assert.equal(res.status, 200)
      assert.equal(row('paid').status, 'PAID')
      assert.ok(row('paid').reversedAt instanceof Date)
      assert.equal(row('paid').reversalReason, REASON)

      const clawback = [...ledger.values()].find((r) => r.entryType === 'CLAWBACK')!
      assert.equal(clawback.id, res.json.data.clawback.id)
      assert.equal(clawback.amount.toString(), '-550')
      assert.equal(clawback.status, 'PAYABLE')
      assert.equal(clawback.reversalOfId, 'paid')
      assert.equal(clawback.resellerId, 'r1')
      assert.deepEqual(actions(), ['COMMISSION_CLAWBACK_CREATED'])
      assert.equal(state.audit[0].metadata.clawbackId, clawback.id)

      const payout = await pay({ resellerId: 'r1', paymentReference: 'TX-NET' })
      assert.equal(payout.status, 201)
      assert.equal(payout.json.data.totalAmount, '350', '900 earned − 550 clawed back')
      assert.equal(row(clawback.id).status, 'PAID')
    })

    it('refuses a second reversal of the same entry (409): no second clawback, audit entry or message', async () => {
      put(entry('paid', 'r1', 'PAID', '550', { payoutId: 'po-1' }), entry('unpaid', 'r1', 'PENDING', '500'))
      assert.equal((await reverse('paid')).status, 200)
      assert.equal((await reverse('unpaid')).status, 200)
      state.audit.length = 0
      state.notifications.length = 0
      const before = ledger.size

      for (const id of ['paid', 'unpaid']) {
        const again = await reverse(id, 'Second attempt by someone else')
        assert.equal(again.status, 409, id)
        assert.equal(row(id).reversalReason, REASON, 'the first reason is kept')
      }
      assert.equal(ledger.size, before, 'still one clawback')
      assert.deepEqual(state.audit, [])
      assert.deepEqual(state.notifications, [])
    })

    it('refuses to reverse a clawback entry', async () => {
      put(entry('cb', 'r1', 'PAYABLE', '-550', { entryType: 'CLAWBACK', reversalOfId: 'paid' }))
      const res = await reverse('cb')
      assert.equal(res.status, 409)
      assert.equal(row('cb').status, 'PAYABLE')
    })

    it('does not overwrite a reversal that another admin saved after this request read the entry', async () => {
      put(entry('c1', 'r1', 'PENDING', '500'))
      // Admin B finishes reversing c1 between admin A's read and A's write.
      state.afterFirstRead = () => Object.assign(row('c1'), { status: 'REVERSED', reversedAt: new Date(), reversedById: 'u-other', reversalReason: 'Reversed by B' })
      const res = await reverse('c1', 'Reversed by A')
      assert.equal(res.status, 409)
      assert.match(res.json.message, /changed by someone else/)
      assert.equal(row('c1').reversalReason, 'Reversed by B', 'B\'s reason and time are not replaced')
      assert.equal(row('c1').reversedById, 'u-other')
      assert.deepEqual(state.audit, [], 'A leaves no audit entry for a reversal it did not make')
      assert.deepEqual(state.notifications, [])
    })

    it('does not turn an entry that was paid after this request read it into REVERSED', async () => {
      put(entry('c1', 'r1', 'PAYABLE', '500'))
      // A payout commits between the read and the write.
      state.afterFirstRead = () => Object.assign(row('c1'), { status: 'PAID', payoutId: 'po-9', paidAt: new Date() })
      const res = await reverse('c1')
      assert.equal(res.status, 409)
      assert.equal(row('c1').status, 'PAID', 'it stays paid; reverse it again to get a clawback')
      assert.equal(row('c1').reversedAt, null)
      assert.equal(ledger.size, 1)
      assert.deepEqual(state.audit, [])
    })

    it('does not create a second clawback when the paid entry was reversed after this request read it', async () => {
      put(entry('paid', 'r1', 'PAID', '550', { payoutId: 'po-1' }))
      state.afterFirstRead = () => {
        Object.assign(row('paid'), { reversedAt: new Date(), reversalReason: 'Reversed by B' })
        ledger.set('cb-b', entry('cb-b', 'r1', 'PAYABLE', '-550', { entryType: 'CLAWBACK', reversalOfId: 'paid' }))
      }
      const res = await reverse('paid', 'Reversed by A')
      assert.equal(res.status, 409)
      assert.equal([...ledger.values()].filter((r) => r.entryType === 'CLAWBACK').length, 1)
      assert.equal(row('paid').reversalReason, 'Reversed by B')
    })

    it('reverses nothing when the audit entry cannot be written', async () => {
      put(entry('paid', 'r1', 'PAID', '550', { payoutId: 'po-1' }), entry('c1', 'r1', 'PENDING', '500'))
      state.failAudit = new Error('audit table unavailable')
      assert.equal((await reverse('c1')).status, 500)
      assert.equal(row('c1').status, 'PENDING')
      assert.equal(row('c1').reversalReason, null)
      state.failAudit = new Error('audit table unavailable')
      assert.equal((await reverse('paid')).status, 500)
      assert.equal(row('paid').reversedAt, null)
      assert.equal(ledger.size, 2, 'the clawback was rolled back with it')
      assert.deepEqual(state.notifications, [])
    })

    it('needs a reason of 5 to 500 characters, and an entry that exists', async () => {
      put(entry('c1', 'r1', 'PENDING', '500'))
      for (const reason of [null, '', 'no', '    ', 'x'.repeat(501), 42]) assert.equal((await reverse('c1', reason)).status, 422, String(reason))
      assert.equal((await api.call('POST', '/api/v1/commissions/c1/reverse', { token: tokens['u-admin'], body: {} })).status, 422, 'no reason at all')
      assert.equal((await reverse('c1', 'x'.repeat(500))).status, 200)
      assert.equal((await reverse('ghost')).status, 404)
    })
  })

  describe('payout', () => {
    it('settles every PAYABLE entry of that reseller (net of clawbacks) and nothing else', async () => {
      put(
        entry('pb1', 'r1', 'PAYABLE', '600'),
        entry('pb2', 'r1', 'PAYABLE', '400'),
        entry('cb', 'r1', 'PAYABLE', '-100', { entryType: 'CLAWBACK', reversalOfId: 'x' }),
        entry('pend', 'r1', 'PENDING', '999'),
        entry('hold', 'r1', 'APPROVED', '999'),
        entry('rev', 'r1', 'REVERSED', '999', { reversedAt: new Date() }),
        entry('old', 'r1', 'PAID', '999', { payoutId: 'po-old' }),
        entry('other', 'r2', 'PAYABLE', '999'),
      )
      remember()
      const paidAt = '2026-10-14'
      const res = await pay({ resellerId: 'r1', paymentReference: ' TX-2026-10 ', paidAt, note: 'October' })
      assert.equal(res.status, 201)
      assert.equal(res.json.data.totalAmount, '900')
      assert.equal(res.json.data.entries, 3)
      assert.equal(res.json.data.paymentReference, 'TX-2026-10', 'trimmed')

      const payout = [...payouts.values()][0]
      assert.equal(payout.paidById, 'u-admin')
      assert.equal(payout.paidAt.toISOString(), '2026-10-14T00:00:00.000Z')
      for (const id of ['pb1', 'pb2', 'cb']) {
        assert.equal(row(id).status, 'PAID', id)
        assert.equal(row(id).payoutId, payout.id)
        assert.equal(row(id).paidAt.toISOString(), '2026-10-14T00:00:00.000Z')
      }
      untouched('pend', 'hold', 'rev', 'old', 'other')
      assert.equal(row('old').payoutId, 'po-old')
      assert.deepEqual(actions(), ['COMMISSION_PAYOUT_CREATED'])
      assert.deepEqual(state.audit[0].metadata, { total: '900', entries: 3, paymentReference: 'TX-2026-10' })
      assert.equal(state.audit[0].resellerId, 'r1')
      assert.equal(state.notifications.length, 1)
      assert.equal(state.notifications[0].type, 'COMMISSION_PAID')
      assert.equal(state.notifications[0].userId, 'u-r1')
    })

    it('first moves APPROVED entries whose hold has ended to PAYABLE, but never ones still on hold', async () => {
      put(entry('late', 'r1', 'APPROVED', '300', { payableAt: PAST }), entry('hold', 'r1', 'APPROVED', '300'))
      remember()
      const res = await pay({ resellerId: 'r1', paymentReference: 'TX-1' })
      assert.equal(res.json.data.totalAmount, '300')
      assert.equal(row('late').status, 'PAID')
      untouched('hold')
    })

    it('pays the same entries only once: sending it again is refused (400) and records nothing', async () => {
      put(entry('pb1', 'r1', 'PAYABLE', '600'))
      assert.equal((await pay({ resellerId: 'r1', paymentReference: 'TX-1' })).status, 201)
      const again = await pay({ resellerId: 'r1', paymentReference: 'TX-1' })
      assert.equal(again.status, 400)
      assert.equal(again.json.message, 'There are no payable commissions for this partner')
      assert.equal(payouts.size, 1)
      assert.deepEqual(actions(), ['COMMISSION_PAYOUT_CREATED'])
    })

    it('can settle chosen entries only, and refuses the whole payout if any chosen one is not payable (409)', async () => {
      put(entry('a', 'r1', 'PAYABLE', '100'), entry('b', 'r1', 'PAYABLE', '200'), entry('p', 'r1', 'PENDING', '400'), entry('x', 'r2', 'PAYABLE', '800'))
      remember()
      const refused = await pay({ resellerId: 'r1', commissionIds: ['a', 'p'], paymentReference: 'TX-1' })
      assert.equal(refused.status, 409)
      const foreign = await pay({ resellerId: 'r1', commissionIds: ['a', 'x'], paymentReference: 'TX-1' })
      assert.equal(foreign.status, 409, 'another reseller\'s entry cannot be slipped in')
      untouched('a', 'b', 'p', 'x')
      assert.equal(payouts.size, 0)

      const ok = await pay({ resellerId: 'r1', commissionIds: ['a'], paymentReference: 'TX-2' })
      assert.equal(ok.json.data.totalAmount, '100')
      assert.equal(row('a').status, 'PAID')
      assert.equal(row('b').status, 'PAYABLE')
    })

    it('refuses a payout whose total would not be positive (clawbacks exceed earnings), changing nothing', async () => {
      put(entry('a', 'r1', 'PAYABLE', '100'), entry('cb', 'r1', 'PAYABLE', '-250', { entryType: 'CLAWBACK', reversalOfId: 'x' }))
      remember()
      const res = await pay({ resellerId: 'r1', paymentReference: 'TX-1' })
      assert.equal(res.status, 400)
      assert.match(res.json.message, /greater than zero/)
      untouched('a', 'cb')
      assert.equal(payouts.size, 0)
    })

    it('refuses an unknown reseller (404), a reseller with nothing payable (400) and an incomplete form (422)', async () => {
      assert.equal((await pay({ resellerId: 'ghost', paymentReference: 'TX-1' })).status, 404)
      assert.equal((await pay({ resellerId: 'r2', paymentReference: 'TX-1' })).status, 400)
      for (const body of [{}, { resellerId: 'r1' }, { resellerId: 'r1', paymentReference: 'ab' }, { resellerId: 'r1', paymentReference: '  ' }, { resellerId: 'r1', paymentReference: 'TX-1', paidAt: 'yesterday' }, { resellerId: 'r1', paymentReference: 'TX-1', commissionIds: [] }]) {
        assert.equal((await pay(body)).status, 422, JSON.stringify(body))
      }
      assert.equal(payouts.size, 0)
    })

    it('records no payout and keeps every entry PAYABLE when the audit entry cannot be written', async () => {
      put(entry('a', 'r1', 'PAYABLE', '100'), entry('b', 'r1', 'PAYABLE', '200'))
      state.failAudit = new Error('audit table unavailable')
      assert.equal((await pay({ resellerId: 'r1', paymentReference: 'TX-1' })).status, 500)
      assert.equal(payouts.size, 0)
      assert.equal(row('a').status, 'PAYABLE')
      assert.equal(row('a').payoutId, null)
      assert.deepEqual(state.notifications, [])
      assert.equal((await pay({ resellerId: 'r1', paymentReference: 'TX-1' })).status, 201, 'and it can be recorded afterwards')
    })
  })

  describe('payout date', () => {
    const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
    const body = (paidAt: unknown) => ({ resellerId: 'r1', paymentReference: 'TX-1', paidAt })
    const payableA = () => put(entry('a', 'r1', 'PAYABLE', '100'), entry('b', 'r1', 'PAYABLE', '200'))
    const nothingRecorded = () => {
      assert.equal(payouts.size, 0)
      assert.equal(row('a').status, 'PAYABLE')
      assert.deepEqual(state.audit, [])
      assert.deepEqual(state.notifications, [])
    }

    it('rejects a payment date in the future with a clear message, recording nothing', async () => {
      payableA()
      const today = businessDateOf()
      const inThreeDays = Date.now() + 3 * 86_400_000
      for (const paidAt of [addDays(today, 1), addDays(today, 400), '2099-01-01', new Date(inThreeDays).toISOString(), inThreeDays]) {
        const res = await pay(body(paidAt))
        assert.equal(res.status, 422, String(paidAt))
        assert.deepEqual(res.json.errors, ['paidAt: Payment date cannot be in the future'], String(paidAt))
      }
      nothingRecorded()
    })

    it('accepts today (business time) and earlier days, as a date, a padded date, a timestamp or epoch milliseconds', async () => {
      const today = businessDateOf()
      for (const [paidAt, expectedDay] of [
        [today, today],
        [` ${addDays(today, -1)} `, addDays(today, -1)],
        [`${addDays(today, -30)}T09:30:00+05:30`, addDays(today, -30)],
        [Date.now() - 2 * 86_400_000, undefined],
      ] as const) {
        put(entry(`x-${String(paidAt)}`, 'r1', 'PAYABLE', '100'))
        const res = await pay(body(paidAt))
        assert.equal(res.status, 201, String(paidAt))
        const stored = [...payouts.values()].at(-1)!.paidAt as Date
        assert.ok(stored instanceof Date)
        if (expectedDay) assert.equal(stored.toISOString().slice(0, 10), expectedDay)
      }
    })

    it('still defaults to now when no date is sent', async () => {
      payableA()
      const before = Date.now()
      assert.equal((await pay({ resellerId: 'r1', paymentReference: 'TX-1' })).status, 201)
      const stored = [...payouts.values()][0].paidAt as Date
      assert.ok(stored.getTime() >= before && stored.getTime() <= Date.now())
    })

    it('rejects dates that do not exist or cannot be read, saying what is wrong', async () => {
      payableA()
      const unreadable = 'Enter a valid payment date (YYYY-MM-DD)'
      const missing = 'Enter the payment date (YYYY-MM-DD)'
      const expected: Array<[unknown, string]> = [
        ['2026-02-31', unreadable],
        ['2026-13-01', unreadable],
        ['2026-00-10', unreadable],
        ['yesterday', unreadable],
        ['15/10/2026', unreadable],
        ['', missing],
        ['   ', missing],
        [true, unreadable],
        [null, unreadable],
        [{}, unreadable],
      ]
      for (const [paidAt, message] of expected) {
        const res = await pay(body(paidAt))
        assert.equal(res.status, 422, JSON.stringify(paidAt))
        assert.deepEqual(res.json.errors, [`paidAt: ${message}`], JSON.stringify(paidAt))
      }
      nothingRecorded()
    })

    it('leaves every other payout rule as it was: amounts, statuses and audit', async () => {
      put(entry('a', 'r1', 'PAYABLE', '600'), entry('cb', 'r1', 'PAYABLE', '-100', { entryType: 'CLAWBACK', reversalOfId: 'x' }), entry('p', 'r1', 'PENDING', '999'))
      const res = await pay({ resellerId: 'r1', paymentReference: 'TX-7', paidAt: addDays(businessDateOf(), -1), note: 'Weekly' })
      assert.equal(res.status, 201)
      assert.equal(res.json.data.totalAmount, '500')
      assert.equal(row('a').status, 'PAID')
      assert.equal(row('cb').status, 'PAID')
      assert.equal(row('p').status, 'PENDING')
      assert.deepEqual(actions(), ['COMMISSION_PAYOUT_CREATED'])
    })
  })

  describe('payout list (the Payouts tab)', () => {
    const payout = (id: string, resellerId: string, paidAt: string, over: Row = {}): Row => ({
      id,
      seq: ++state.seq,
      resellerId,
      totalAmount: new Decimal('1000'),
      currency: 'LKR',
      paymentReference: `TX-${id}`,
      paidAt: new Date(`${paidAt}T00:00:00Z`),
      createdAt: new Date(`${paidAt}T08:00:00Z`),
      note: null,
      ...over,
    })
    const list = (query = '', who = 'u-admin') => api.call('GET', `/api/v1/commissions/payouts${query}`, { token: tokens[who] })

    it('shows an admin the payouts of every reseller, newest first, with reseller and entry counts', async () => {
      payouts.set('p1', payout('p1', 'r1', '2026-09-01'))
      payouts.set('p2', payout('p2', 'r2', '2026-09-20'))
      payouts.set('p3', payout('p3', 'r1', '2026-09-10'))
      put(entry('e1', 'r1', 'PAID', '500', { payoutId: 'p1' }), entry('e2', 'r1', 'PAID', '500', { payoutId: 'p1' }), entry('e3', 'r2', 'PAID', '700', { payoutId: 'p2' }))
      const res = await list()
      assert.equal(res.status, 200)
      assert.deepEqual(res.json.data.map((p: Row) => p.id), ['p2', 'p3', 'p1'])
      assert.deepEqual(res.json.meta, { total: 3, page: 1, limit: 20, totalPages: 1 })
      const first = res.json.data[0]
      assert.deepEqual(first.reseller, { code: 'R2', businessName: 'Reseller r2' })
      assert.equal(first._count.commissions, 1)
      assert.equal(res.json.data[2]._count.commissions, 2)
      assert.equal(first.totalAmount, '1000')
    })

    it('narrows to one reseller on request, and a reseller only ever gets its own payouts', async () => {
      payouts.set('p1', payout('p1', 'r1', '2026-09-01'))
      payouts.set('p2', payout('p2', 'r2', '2026-09-20'))
      assert.deepEqual((await list('?resellerId=r2')).json.data.map((p: Row) => p.id), ['p2'])
      assert.deepEqual((await list('', 'u-r1')).json.data.map((p: Row) => p.id), ['p1'])
      assert.deepEqual((await list('?resellerId=r2', 'u-r1')).json.data.map((p: Row) => p.id), ['p1'], 'asking for another reseller changes nothing')
    })

    it('refuses without a token (401) and for a reseller whose application is pending (403)', async () => {
      assert.equal((await api.call('GET', '/api/v1/commissions/payouts')).status, 401)
      assert.equal((await list('', 'u-pending')).status, 403)
    })

    it('pages through payouts that share a payment day without repeating or skipping any', async () => {
      const ids = Array.from({ length: 7 }, (_, i) => `q${i + 1}`)
      for (const id of ids) payouts.set(id, payout(id, 'r1', '2026-09-15')) // same day, same instant
      const seen: string[] = []
      for (let page = 1; page <= 4; page++) {
        const res = await list(`?limit=2&page=${page}`)
        assert.equal(res.json.meta.totalPages, 4)
        seen.push(...res.json.data.map((p: Row) => p.id))
      }
      assert.equal(new Set(seen).size, 7, `repeated or missing payouts: ${seen}`)
      assert.deepEqual([...seen].sort(), [...ids].sort())
    })

    it('rejects paging values it cannot serve with 422', async () => {
      for (const q of ['?page=0', '?limit=0', '?limit=101']) assert.equal((await list(q)).status, 422, q)
    })
  })
})
