import { after, before, beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { installHermeticBackend, serve, strictFake } from './helpers/hermetic-backend'

/**
 * Admin → Customers → "Record subscription event": POST /subscription-events (manual events, source ADMIN).
 *  - PAYMENT_VERIFIED needs a tenant and finished provisioning; TRIAL, PENDING and ACTIVE (renewal) accounts are supported,
 *    a CANCELLED account is not reactivated by a manual event;
 *  - CANCELLED / REFUNDED never end an unpaid trial; REFUNDED needs the PAYMENT_VERIFIED event of the same month, and only
 *    refunding the current month (with nothing paid after it) ends the subscription;
 *  - the billing month must be inside the activation window (last month … two months ahead) in business time (Asia/Colombo);
 *  - an open activation request blocks a manual event with a clear 409, while the activation flow's own call is exempt;
 *  - event history is never edited or deleted (a refunded month stays refunded).
 *
 * Database-free (see tests/helpers/hermetic-backend.ts): the real router, auth, validation, event service, commission ledger
 * and level code run against an in-memory store that enforces the (account, type, month) uniqueness with Prisma's P2002 and
 * undoes a failed transaction. Nothing here reads `.env`, runs Prisma or opens a connection.
 */

type Row = Record<string, any>

let Prisma: typeof import('@prisma/client').Prisma
let periodMonthOf: typeof import('../src/utils/period')['periodMonthOf']
let shiftPeriod: typeof import('../src/utils/period')['shiftPeriod']
let billingWindow: typeof import('../src/utils/period')['billingWindow']

const db = {
  accounts: new Map<string, Row>(),
  events: [] as Row[],
  trials: [] as Row[],
  activations: [] as Row[],
  commissions: [] as Row[],
  audit: [] as Row[],
  reseller: { id: 'r1', currentLevel: null as number | null, activeCustomerCount: 0 } as Row,
  clock: 0,
  ids: 0,
}

const seed = () => {
  db.accounts = new Map()
  db.events = []
  db.trials = []
  db.activations = []
  db.commissions = []
  db.audit = []
  db.reseller = { id: 'r1', currentLevel: null, activeCustomerCount: 0 }
  db.clock = 0
  db.ids = 0
}

/** The `where` shapes the event code uses: equality, null, and { in | not | gt | gte | lt | lte }. */
const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond) return cond.in.includes(row[key])
      if ('not' in cond) return row[key] !== cond.not
      if ('gt' in cond) return row[key] > cond.gt
      if ('gte' in cond) return row[key] >= cond.gte
      if ('lt' in cond) return row[key] < cond.lt
      if ('lte' in cond) return row[key] <= cond.lte
      throw new Error(`The fake does not understand this condition on ${key}: ${JSON.stringify(cond)}`)
    }
    return row[key] === cond
  })

const pick = (row: Row, select?: Row) =>
  select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : { ...row }

const newest = (rows: Row[], orderBy?: Row) => {
  const [key, dir] = orderBy ? Object.entries(orderBy)[0] : ['createdAt', 'desc']
  return [...rows].sort((a, b) => (dir === 'desc' ? b[key as string] - a[key as string] : a[key as string] - b[key as string]))
}

const uniqueViolation = () => new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' })

const levels = () => [{ level: 1, name: 'Starter', minActiveCustomers: 1, maxActiveCustomers: null, ratePercent: new Prisma.Decimal('10') }]
const product = () => ({ id: 'p1', monthlyPrice: new Prisma.Decimal('5500'), currency: 'LKR' })

const txModels = () => ({
  $queryRaw: async () => [],
  customerAccount: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const a = db.accounts.get(where.id)
      return a ? { ...a, product: product(), customer: { displayName: 'Nimal Stores' } } : null
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => Object.assign(db.accounts.get(where.id)!, data),
    count: async ({ where }: { where: Row }) => [...db.accounts.values()].filter((a) => matches(a, where)).length,
  },
  subscriptionEvent: {
    create: async ({ data }: { data: Row }) => {
      if (db.events.some((e) => e.customerAccountId === data.customerAccountId && e.type === data.type && e.periodMonth === data.periodMonth)) throw uniqueViolation()
      const row = { id: `e${++db.ids}`, createdAt: ++db.clock, externalRef: null, note: null, ...data }
      db.events.push(row)
      return { ...row }
    },
    findMany: async ({ where, select, orderBy }: { where?: Row; select?: Row; orderBy?: Row }) =>
      newest(db.events.filter((e) => matches(e, where)), orderBy).map((e) => pick(e, select)),
    findFirst: async ({ where, select, orderBy }: { where?: Row; select?: Row; orderBy?: Row }) => {
      const found = newest(db.events.filter((e) => matches(e, where)), orderBy)[0]
      return found ? pick(found, select) : null
    },
    findUnique: async ({ where, select }: { where: { customerAccountId_type_periodMonth: Row }; select?: Row }) => {
      const k = where.customerAccountId_type_periodMonth
      const found = db.events.find((e) => e.customerAccountId === k.customerAccountId && e.type === k.type && e.periodMonth === k.periodMonth)
      return found ? pick(found, select) : null
    },
  },
  trialRequest: {
    findFirst: async ({ where, select, orderBy }: { where?: Row; select?: Row; orderBy?: Row }) => {
      const found = newest(db.trials.filter((t) => matches(t, where)), orderBy)[0]
      return found ? pick(found, select) : null
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const hit = db.trials.filter((t) => matches(t, where))
      hit.forEach((t) => Object.assign(t, data))
      return { count: hit.length }
    },
  },
  activationRequest: {
    findFirst: async ({ where, select, orderBy }: { where?: Row; select?: Row; orderBy?: Row }) => {
      const found = newest(db.activations.filter((a) => matches(a, where)), orderBy)[0]
      return found ? pick(found, select) : null
    },
  },
  commissionLevel: { findMany: async () => levels() },
  reseller: {
    findUniqueOrThrow: async () => ({ currentLevel: db.reseller.currentLevel }),
    update: async ({ data }: { data: Row }) => Object.assign(db.reseller, data),
  },
  resellerLevelChange: { create: async ({ data }: { data: Row }) => data },
  commission: {
    findFirst: async ({ where }: { where?: Row }) => db.commissions.find((c) => matches(c, where)) ?? null,
    findMany: async ({ where }: { where?: Row }) => db.commissions.filter((c) => matches(c, where)),
    create: async ({ data }: { data: Row }) => {
      const row = { id: `m${++db.ids}`, reversedAt: null, reversedById: null, createdAt: ++db.clock, ...data }
      db.commissions.push(row)
      return row
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => Object.assign(db.commissions.find((c) => c.id === where.id)!, data),
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

const snapshotOf = () => ({
  accounts: new Map([...db.accounts].map(([k, v]) => [k, { ...v }] as [string, Row])),
  events: db.events.map((e) => ({ ...e })),
  trials: db.trials.map((t) => ({ ...t })),
  commissions: db.commissions.map((c) => ({ ...c })),
  audit: [...db.audit],
  reseller: { ...db.reseller },
})

const fakePrisma = strictFake('prisma', {
  user: {
    findUnique: async ({ where }: { where: { id: string } }) => USERS[where.id] ?? null,
    findMany: async () => [],
  },
  notification: { createMany: async () => ({ count: 0 }) },
  $transaction: async <T>(fn: (t: object) => Promise<T>): Promise<T> => {
    const saved = snapshotOf()
    try {
      return await fn(strictFake('tx', txModels()))
    } catch (err) {
      Object.assign(db, saved)
      throw err
    }
  },
})

describe('Admin → manual subscription events (POST /subscription-events)', () => {
  let api: Awaited<ReturnType<typeof serve>>
  let signAccessToken: typeof import('../src/utils/jwt')['signAccessToken']
  let applySubscriptionEvent: typeof import('../src/modules/commissions/subscription-events.service')['applySubscriptionEvent']

  const token = (who: Who) => signAccessToken({ userId: who, email: USERS[who].email, role: USERS[who].role, resellerId: USERS[who].resellerId })
  const record = (body: Row, who: Who = 'u-admin') => api.call('POST', '/subscription-events', { token: token(who), body: { customerAccountId: 'a1', ...body } })
  const account = () => db.accounts.get('a1')!
  const seedAccount = (over: Row = {}) => {
    const a = { id: 'a1', resellerId: 'r1', productId: 'p1', customerId: 'c1', status: 'TRIAL', externalTenantId: 'tenant-1', activatedAt: null, deactivatedAt: null, ...over }
    db.accounts.set(a.id, a)
    return a
  }
  const seedTrial = (status: string) => db.trials.push({ id: `t${++db.ids}`, customerAccountId: 'a1', status, createdAt: ++db.clock })
  const seedActivation = (status: string, reference = 'AR-ABC123') => db.activations.push({ id: `ar${++db.ids}`, customerAccountId: 'a1', status, reference, createdAt: ++db.clock })
  /** Everything an event could change, so "nothing happened" is one comparison. */
  const state = () => JSON.stringify({ accounts: [...db.accounts], events: db.events, trials: db.trials, commissions: db.commissions, audit: db.audit, reseller: db.reseller })
  const earning = (month: string) => db.commissions.find((c) => c.periodMonth === month && c.entryType === 'EARNING')!
  const types = () => db.events.map((e) => `${e.type}:${e.periodMonth}`)

  // business-time months relative to today
  let cur: string
  let prev: string
  let next: string
  const refresh = () => {
    cur = periodMonthOf()
    prev = shiftPeriod(cur, -1)
    next = shiftPeriod(cur, 1)
  }

  before(async () => {
    installHermeticBackend(fakePrisma)
    ;({ signAccessToken } = await import('../src/utils/jwt'))
    ;({ Prisma } = await import('@prisma/client'))
    ;({ periodMonthOf, shiftPeriod, billingWindow } = await import('../src/utils/period'))
    ;({ applySubscriptionEvent } = await import('../src/modules/commissions/subscription-events.service'))
    const { errorHandler } = await import('../src/middleware/error.middleware')
    const { subscriptionEventsRouter } = await import('../src/modules/commissions/commissions.routes')
    const app = express()
    app.use(express.json())
    app.use('/subscription-events', subscriptionEventsRouter)
    app.use(errorHandler)
    api = await serve(app)
  })
  after(async () => {
    await api?.close()
  })
  beforeEach(() => {
    seed()
    refresh()
  })

  describe('billing month window', () => {
    it('is last month through two months ahead, across a year boundary too (shared with activation requests)', () => {
      assert.deepEqual(billingWindow('2026-10'), { from: '2026-09', to: '2026-12' })
      assert.deepEqual(billingWindow('2026-01'), { from: '2025-12', to: '2026-03' })
      assert.deepEqual(billingWindow('2026-12'), { from: '2026-11', to: '2027-02' })
      assert.deepEqual(billingWindow(), billingWindow(periodMonthOf()))
    })

    it('accepts last month, this month and up to two months ahead', async () => {
      for (const month of [prev, cur, next, shiftPeriod(cur, 2)]) {
        seed()
        seedAccount()
        const res = await record({ type: 'PAYMENT_VERIFIED', periodMonth: month })
        assert.equal(res.status, 201, `${month}: ${JSON.stringify(res.json)}`)
      }
    })

    it('refuses months outside the window with a clear 400 that names the allowed range, and writes nothing', async () => {
      seedAccount()
      const before = state()
      const from = prev
      const to = shiftPeriod(cur, 2)
      for (const month of [shiftPeriod(cur, -2), shiftPeriod(cur, 3), '2001-01', '2099-12']) {
        const res = await record({ type: 'PAYMENT_VERIFIED', periodMonth: month })
        assert.equal(res.status, 400, `${month}: ${JSON.stringify(res.json)}`)
        assert.match(res.json.message, /Billing month must be between/)
        assert.ok(res.json.message.includes(from) && res.json.message.includes(to), res.json.message)
      }
      assert.equal(state(), before)
    })

    it('applies to CANCELLED and REFUNDED events too', async () => {
      seedAccount({ status: 'ACTIVE' })
      for (const type of ['CANCELLED', 'REFUNDED']) {
        const res = await record({ type, periodMonth: shiftPeriod(cur, -3) })
        assert.equal(res.status, 400, type)
      }
    })

    it('uses business time (Asia/Colombo), not the server\'s or browser\'s clock, to decide the current month', async () => {
      // 19:00 UTC on 30 September is already 00:30 on 1 October in Colombo.
      mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-30T19:00:00Z') })
      try {
        seedAccount()
        const adminToken = token('u-admin')
        const call = (periodMonth: string) => api.call('POST', '/subscription-events', { token: adminToken, body: { customerAccountId: 'a1', type: 'PAYMENT_VERIFIED', periodMonth } })
        // Colombo month = 2026-10  →  window 2026-09 … 2026-12
        assert.equal((await call('2026-08')).status, 400, 'August is outside the Colombo window (it would be inside a UTC window)')
        assert.equal((await call('2026-12')).status, 201, 'December is inside the Colombo window (it would be outside a UTC window)')
      } finally {
        mock.timers.reset()
      }
    })
  })

  describe('PAYMENT_VERIFIED', () => {
    it('activates a TRIAL account with a tenant and creates the month\'s commission', async () => {
      seedAccount({ status: 'TRIAL' })
      seedTrial('PROVISIONED')
      const res = await record({ type: 'PAYMENT_VERIFIED', periodMonth: cur, externalRef: 'INV-1' })
      assert.equal(res.status, 201, JSON.stringify(res.json))
      assert.equal(account().status, 'ACTIVE')
      assert.ok(account().activatedAt)
      assert.equal(res.json.data.accountStatus, 'ACTIVE')
      assert.equal(res.json.data.commission.periodMonth, cur)
      assert.equal(String(earning(cur).amount), '550')
      assert.deepEqual(types(), [`PAYMENT_VERIFIED:${cur}`])
    })

    it('activates a PENDING account that has a tenant and no unfinished trial request', async () => {
      for (const latest of [null, 'PROVISIONED', 'CANCELLED']) {
        seed()
        seedAccount({ status: 'PENDING' })
        if (latest) seedTrial(latest)
        const res = await record({ type: 'PAYMENT_VERIFIED', periodMonth: cur })
        assert.equal(res.status, 201, `latest trial ${latest}: ${JSON.stringify(res.json)}`)
        assert.equal(account().status, 'ACTIVE')
      }
    })

    it('records an ACTIVE renewal for another month, with its own commission', async () => {
      seedAccount({ status: 'TRIAL' })
      assert.equal((await record({ type: 'PAYMENT_VERIFIED', periodMonth: cur })).status, 201)
      const renewal = await record({ type: 'PAYMENT_VERIFIED', periodMonth: next })
      assert.equal(renewal.status, 201, JSON.stringify(renewal.json))
      assert.equal(account().status, 'ACTIVE')
      assert.equal(db.commissions.filter((c) => c.entryType === 'EARNING').length, 2)
    })

    it('an ACTIVE renewal is not held up by an old failed trial request', async () => {
      seedAccount({ status: 'ACTIVE', activatedAt: new Date() })
      seedTrial('FAILED')
      assert.equal((await record({ type: 'PAYMENT_VERIFIED', periodMonth: cur })).status, 201)
    })

    it('refuses an account without a (valid) tenant with a clear 409, and changes nothing', async () => {
      for (const [status, externalTenantId] of [['TRIAL', null], ['PENDING', null], ['PENDING', ''], ['TRIAL', '   '], ['ACTIVE', null]] as const) {
        seed()
        seedAccount({ status, externalTenantId })
        const before = state()
        const res = await record({ type: 'PAYMENT_VERIFIED', periodMonth: cur })
        assert.equal(res.status, 409, `${status}/${JSON.stringify(externalTenantId)}: ${JSON.stringify(res.json)}`)
        assert.match(res.json.message, /no SaaS tenant/i)
        assert.equal(state(), before)
      }
    })

    it('does not reactivate a CANCELLED account, even one with a tenant', async () => {
      seedAccount({ status: 'CANCELLED', deactivatedAt: new Date() })
      const before = state()
      const res = await record({ type: 'PAYMENT_VERIFIED', periodMonth: cur })
      assert.equal(res.status, 409, JSON.stringify(res.json))
      assert.match(res.json.message, /cancelled/i)
      assert.match(res.json.message, /activation request/i, 'points to the supported reactivation flow')
      assert.equal(state(), before)
    })

    it('refuses while trial provisioning is unfinished or failed, naming the trial status', async () => {
      for (const latest of ['PENDING', 'SUBMITTED', 'FAILED']) {
        seed()
        seedAccount({ status: 'PENDING' })
        seedTrial(latest)
        const before = state()
        const res = await record({ type: 'PAYMENT_VERIFIED', periodMonth: cur })
        assert.equal(res.status, 409, `${latest}: ${JSON.stringify(res.json)}`)
        assert.match(res.json.message, /provisioning/i)
        assert.ok(res.json.message.includes(latest), res.json.message)
        assert.equal(state(), before)
      }
    })

    it('only the latest trial request counts: an older failure followed by a provisioned trial is fine', async () => {
      seedAccount({ status: 'TRIAL' })
      seedTrial('FAILED')
      seedTrial('PROVISIONED')
      assert.equal((await record({ type: 'PAYMENT_VERIFIED', periodMonth: cur })).status, 201)
    })

    it('SUSPENDED is left as it was: still activated by a verified payment (no rule has been decided for it)', async () => {
      seedAccount({ status: 'SUSPENDED' })
      const res = await record({ type: 'PAYMENT_VERIFIED', periodMonth: cur })
      assert.equal(res.status, 201, JSON.stringify(res.json))
      assert.equal(account().status, 'ACTIVE')
    })

    it('a month recorded twice is a 409 and the first event is untouched', async () => {
      seedAccount()
      assert.equal((await record({ type: 'PAYMENT_VERIFIED', periodMonth: cur, externalRef: 'INV-1' })).status, 201)
      const eventBefore = JSON.stringify(db.events[0])
      const again = await record({ type: 'PAYMENT_VERIFIED', periodMonth: cur, externalRef: 'INV-2' })
      assert.equal(again.status, 409)
      assert.match(again.json.message, /PAYMENT_VERIFIED event for .* is already recorded/)
      assert.equal(db.events.length, 1)
      assert.equal(JSON.stringify(db.events[0]), eventBefore)
    })

    it('a refunded month stays refunded: it cannot be recorded as paid again, and its history is kept', async () => {
      seedAccount()
      assert.equal((await record({ type: 'PAYMENT_VERIFIED', periodMonth: cur })).status, 201)
      assert.equal((await record({ type: 'REFUNDED', periodMonth: cur })).status, 201)
      const history = JSON.stringify(db.events)
      const again = await record({ type: 'PAYMENT_VERIFIED', periodMonth: cur })
      assert.equal(again.status, 409, JSON.stringify(again.json))
      assert.match(again.json.message, /refunded/i)
      assert.equal(JSON.stringify(db.events), history, 'event records are neither edited nor deleted')
      assert.deepEqual(types(), [`PAYMENT_VERIFIED:${cur}`, `REFUNDED:${cur}`])
    })
  })

  describe('open activation requests', () => {
    it('refuse PAYMENT_VERIFIED with a clear 409 that names the request, and change nothing', async () => {
      for (const status of ['PENDING_REVIEW', 'UNDER_REVIEW', 'APPROVED']) {
        seed()
        seedAccount({ status: 'TRIAL' })
        seedActivation(status, 'AR-K7M2PQ')
        const before = state()
        const res = await record({ type: 'PAYMENT_VERIFIED', periodMonth: cur })
        assert.equal(res.status, 409, `${status}: ${JSON.stringify(res.json)}`)
        assert.match(res.json.message, /AR-K7M2PQ/)
        assert.match(res.json.message, /activation request/i)
        assert.equal(state(), before)
      }
    })

    it('do not block when every request is finished', async () => {
      for (const status of ['ACTIVATION_COMPLETED', 'REJECTED', 'CANCELLED']) {
        seed()
        seedAccount({ status: 'TRIAL' })
        seedActivation(status)
        assert.equal((await record({ type: 'PAYMENT_VERIFIED', periodMonth: cur })).status, 201, status)
      }
    })

    it('also block a CANCELLED event and a refund that would end the subscription', async () => {
      seedAccount({ status: 'ACTIVE', activatedAt: new Date() })
      db.events.push({ id: 'e0', customerAccountId: 'a1', type: 'PAYMENT_VERIFIED', periodMonth: cur, createdAt: 0 })
      seedActivation('UNDER_REVIEW', 'AR-OPEN01')
      const before = state()
      for (const body of [{ type: 'CANCELLED', periodMonth: cur }, { type: 'REFUNDED', periodMonth: cur }]) {
        const res = await record(body)
        assert.equal(res.status, 409, JSON.stringify(body))
        assert.match(res.json.message, /AR-OPEN01/)
      }
      assert.equal(state(), before)
    })

    it('the activation flow\'s own call is exempt: window, open request and CANCELLED status do not stop it', async () => {
      const farBack = shiftPeriod(cur, -3)
      seedAccount({ status: 'CANCELLED', deactivatedAt: new Date() })
      seedActivation('APPROVED', 'AR-OWN001')
      const result = await applySubscriptionEvent(
        txModels() as never,
        { customerAccountId: 'a1', type: 'PAYMENT_VERIFIED', periodMonth: farBack },
        { source: 'ACTIVATION_REQUEST' },
      )
      assert.equal(account().status, 'ACTIVE')
      assert.equal(result.event.periodMonth, farBack)
      assert.equal(String(earning(farBack).amount), '550')
    })
  })

  describe('CANCELLED', () => {
    it('ends a paid (ACTIVE) subscription and keeps the commission already earned', async () => {
      seedAccount({ status: 'TRIAL' })
      assert.equal((await record({ type: 'PAYMENT_VERIFIED', periodMonth: cur })).status, 201)
      const res = await record({ type: 'CANCELLED', periodMonth: cur })
      assert.equal(res.status, 201, JSON.stringify(res.json))
      assert.equal(account().status, 'CANCELLED')
      assert.ok(account().deactivatedAt)
      assert.equal(res.json.data.accountStatus, 'CANCELLED')
      assert.equal(res.json.data.subscriptionEnded, true)
      assert.equal(earning(cur).status, 'PENDING', 'earned commission is kept')
    })

    it('never terminates an unpaid trial (TRIAL or PENDING), and says why', async () => {
      for (const status of ['TRIAL', 'PENDING']) {
        seed()
        seedAccount({ status })
        seedTrial('PROVISIONED')
        const before = state()
        const res = await record({ type: 'CANCELLED', periodMonth: cur })
        assert.equal(res.status, 409, `${status}: ${JSON.stringify(res.json)}`)
        assert.match(res.json.message, /unpaid/i)
        assert.match(res.json.message, /trial/i)
        assert.equal(state(), before)
      }
    })

    it('refuses an account that is already cancelled', async () => {
      seedAccount({ status: 'CANCELLED', deactivatedAt: new Date() })
      const before = state()
      const res = await record({ type: 'CANCELLED', periodMonth: cur })
      assert.equal(res.status, 409)
      assert.match(res.json.message, /already cancelled/i)
      assert.equal(state(), before)
    })

    it('SUSPENDED is left as it was: still cancelled by a CANCELLED event', async () => {
      seedAccount({ status: 'SUSPENDED' })
      const res = await record({ type: 'CANCELLED', periodMonth: cur })
      assert.equal(res.status, 201, JSON.stringify(res.json))
      assert.equal(account().status, 'CANCELLED')
    })
  })

  describe('REFUNDED', () => {
    const pay = async (...months: string[]) => {
      seedAccount({ status: 'TRIAL' })
      for (const month of months) assert.equal((await record({ type: 'PAYMENT_VERIFIED', periodMonth: month })).status, 201, month)
    }

    it('needs the PAYMENT_VERIFIED event of the same account and month', async () => {
      await pay(cur)
      const before = state()
      for (const month of [prev, next]) {
        const res = await record({ type: 'REFUNDED', periodMonth: month })
        assert.equal(res.status, 409, `${month}: ${JSON.stringify(res.json)}`)
        assert.match(res.json.message, /no payment to refund/i)
        assert.ok(res.json.message.includes(month))
      }
      assert.equal(state(), before)
    })

    it('does not accept another account\'s payment as the match', async () => {
      seedAccount({ status: 'TRIAL' })
      db.events.push({ id: 'other', customerAccountId: 'a-other', type: 'PAYMENT_VERIFIED', periodMonth: cur, createdAt: 0 })
      const res = await record({ type: 'REFUNDED', periodMonth: cur })
      assert.equal(res.status, 409)
      assert.match(res.json.message, /no payment to refund/i)
    })

    it('refunding the current month reverses its commission and ends the subscription', async () => {
      await pay(cur)
      const res = await record({ type: 'REFUNDED', periodMonth: cur, externalRef: 'RF-1' })
      assert.equal(res.status, 201, JSON.stringify(res.json))
      assert.equal(earning(cur).status, 'REVERSED')
      assert.equal(account().status, 'CANCELLED')
      assert.equal(res.json.data.subscriptionEnded, true)
      assert.equal(res.json.data.reversed.length, 1)
    })

    it('refunding a historical month reverses that month only: the current subscription stays ACTIVE', async () => {
      await pay(prev, cur)
      const res = await record({ type: 'REFUNDED', periodMonth: prev })
      assert.equal(res.status, 201, JSON.stringify(res.json))
      assert.equal(earning(prev).status, 'REVERSED')
      assert.equal(earning(cur).status, 'PENDING', 'this month\'s commission is untouched')
      assert.equal(account().status, 'ACTIVE')
      assert.equal(res.json.data.accountStatus, 'ACTIVE')
      assert.equal(res.json.data.subscriptionEnded, false)
      assert.equal(db.reseller.activeCustomerCount, 1, 'the customer still counts as active')
    })

    it('a historical refund does not end the subscription even when nothing was paid after it', async () => {
      await pay(prev)
      const res = await record({ type: 'REFUNDED', periodMonth: prev })
      assert.equal(res.status, 201, JSON.stringify(res.json))
      assert.equal(earning(prev).status, 'REVERSED')
      assert.equal(account().status, 'ACTIVE', 'ending it is an explicit Cancelled event, not a side effect of a historical refund')
      assert.equal(res.json.data.subscriptionEnded, false)
    })

    it('refunding a prepaid future month keeps the current month\'s subscription', async () => {
      await pay(cur, next)
      const res = await record({ type: 'REFUNDED', periodMonth: next })
      assert.equal(res.status, 201, JSON.stringify(res.json))
      assert.equal(earning(next).status, 'REVERSED')
      assert.equal(account().status, 'ACTIVE')
    })

    it('refunding the current month does not end a subscription that is paid for a later month', async () => {
      await pay(cur, next)
      const res = await record({ type: 'REFUNDED', periodMonth: cur })
      assert.equal(res.status, 201, JSON.stringify(res.json))
      assert.equal(earning(cur).status, 'REVERSED')
      assert.equal(account().status, 'ACTIVE')
      assert.equal(res.json.data.subscriptionEnded, false)
    })

    it('a later month that was itself refunded no longer counts as paid', async () => {
      await pay(cur, next)
      assert.equal((await record({ type: 'REFUNDED', periodMonth: next })).status, 201)
      const res = await record({ type: 'REFUNDED', periodMonth: cur })
      assert.equal(res.status, 201, JSON.stringify(res.json))
      assert.equal(account().status, 'CANCELLED')
    })

    it('endSubscription: false keeps the subscription on a current-month refund', async () => {
      await pay(cur)
      const res = await record({ type: 'REFUNDED', periodMonth: cur, endSubscription: false })
      assert.equal(res.status, 201, JSON.stringify(res.json))
      assert.equal(earning(cur).status, 'REVERSED')
      assert.equal(account().status, 'ACTIVE')
      assert.equal(res.json.data.subscriptionEnded, false)
    })

    it('never terminates an unpaid trial, even if a payment event exists for the month', async () => {
      for (const status of ['TRIAL', 'PENDING']) {
        seed()
        seedAccount({ status })
        db.events.push({ id: 'e0', customerAccountId: 'a1', type: 'PAYMENT_VERIFIED', periodMonth: cur, createdAt: 0 })
        const res = await record({ type: 'REFUNDED', periodMonth: cur })
        assert.equal(res.status, 201, `${status}: ${JSON.stringify(res.json)}`)
        assert.equal(account().status, status, 'an unpaid trial is not ended by a refund')
        assert.equal(res.json.data.subscriptionEnded, false)
      }
    })

    it('can still refund a paid month of an already cancelled account (commission only)', async () => {
      await pay(cur)
      assert.equal((await record({ type: 'CANCELLED', periodMonth: cur })).status, 201)
      const res = await record({ type: 'REFUNDED', periodMonth: cur })
      assert.equal(res.status, 201, JSON.stringify(res.json))
      assert.equal(earning(cur).status, 'REVERSED')
      assert.equal(account().status, 'CANCELLED')
    })

    it('a month refunded twice is a 409 and the first refund event is untouched', async () => {
      await pay(prev, cur)
      assert.equal((await record({ type: 'REFUNDED', periodMonth: prev })).status, 201)
      const refundEvent = JSON.stringify(db.events.find((e) => e.type === 'REFUNDED'))
      const again = await record({ type: 'REFUNDED', periodMonth: prev })
      assert.equal(again.status, 409)
      assert.match(again.json.message, /REFUNDED event for .* is already recorded/)
      assert.equal(JSON.stringify(db.events.find((e) => e.type === 'REFUNDED')), refundEvent)
    })

    it('keeps the clawback rule for a commission that was already paid out', async () => {
      await pay(cur)
      earning(cur).status = 'PAID'
      const res = await record({ type: 'REFUNDED', periodMonth: cur })
      assert.equal(res.status, 201, JSON.stringify(res.json))
      assert.equal(earning(cur).status, 'PAID')
      assert.ok(earning(cur).reversedAt)
      const clawback = db.commissions.find((c) => c.entryType === 'CLAWBACK')!
      assert.equal(String(clawback.amount), '-550')
    })

    it('a refund that only reverses a historical month is allowed while a request is open', async () => {
      await pay(prev, cur)
      seedActivation('PENDING_REVIEW', 'AR-OPEN02')
      const res = await record({ type: 'REFUNDED', periodMonth: prev })
      assert.equal(res.status, 201, JSON.stringify(res.json))
    })
  })

  describe('access and input checks stay as they were', () => {
    it('needs an admin with subscriptions:record', async () => {
      seedAccount()
      const seller = await record({ type: 'PAYMENT_VERIFIED', periodMonth: cur }, 'u-seller')
      assert.equal(seller.status, 403)
      const anonymous = await api.call('POST', '/subscription-events', { body: { customerAccountId: 'a1', type: 'PAYMENT_VERIFIED', periodMonth: cur } })
      assert.equal(anonymous.status, 401)
      assert.equal(db.events.length, 0)
    })

    it('rejects a malformed month, an unknown type and an unknown account', async () => {
      seedAccount()
      assert.equal((await record({ type: 'PAYMENT_VERIFIED', periodMonth: '2026-13' })).status, 422)
      assert.equal((await record({ type: 'PAYMENT_VERIFIED', periodMonth: 'October' })).status, 422)
      assert.equal((await record({ type: 'SUSPENDED', periodMonth: cur })).status, 422)
      const missing = await api.call('POST', '/subscription-events', { token: token('u-admin'), body: { customerAccountId: 'a-missing', type: 'PAYMENT_VERIFIED', periodMonth: cur } })
      assert.equal(missing.status, 404)
      assert.equal(db.events.length, 0)
    })
  })
})
