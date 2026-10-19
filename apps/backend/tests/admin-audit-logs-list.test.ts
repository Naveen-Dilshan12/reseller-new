import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { installHermeticBackend, serve, strictFake } from './helpers/hermetic-backend'

/**
 * Admin → Audit logs: GET /audit-logs and /audit-logs/facets.
 *  - only staff with `audit:read` can read; the log has no write endpoints through this router;
 *  - filters, search, date range and paging reach the query;
 *  - paging is stable: entries written in the same instant never repeat or disappear between pages, because the order is
 *    newest first with the entry id as the tie-breaker;
 *  - metadata is redacted when an entry is WRITTEN (password / secret / token / API-key style keys, at any depth), so the
 *    list never has to return them.
 *
 * Database-free (see tests/helpers/hermetic-backend.ts): the real router, auth, validation and audit service run against an
 * in-memory log. Like a database, the fake leaves the order of rows with equal sort keys unspecified: it flips it from one
 * query to the next. Nothing here reads `.env`, runs Prisma or opens a connection.
 */

type Row = Record<string, any>

const log: Row[] = []
const queries: Row[] = []
let queryNo = 0

const seed = () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 5, minute))
  const entry = (id: string, createdAt: Date, over: Row = {}): Row => ({
    id,
    actorType: 'USER',
    actorUserId: 'u-admin',
    actorEmail: 'admin@test.invalid',
    action: 'LOGIN_SUCCESS',
    entityType: 'User',
    entityId: 'u-admin',
    resellerId: null,
    ip: '10.0.0.1',
    userAgent: 'test',
    metadata: null,
    createdAt,
    ...over,
  })
  log.length = 0
  log.push(
    // six entries written in the same instant (e.g. one action that records several steps)
    ...['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((id) => entry(id, at(10), { action: 'ACTIVATION_APPROVED', entityType: 'ActivationRequest', entityId: `ar-${id}` })),
    entry('b1', at(5), { actorType: 'SYSTEM', actorEmail: null, action: 'COMMISSION_PROMOTED', entityType: 'Commission', entityId: 'CUS-000042' }),
    entry('c1', at(1), { actorType: 'SAAS', actorEmail: 'saas:SALON', action: 'SUBSCRIPTION_PAYMENT_VERIFIED', entityType: 'CustomerAccount', entityId: 'acc-9' }),
  )
}

const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true
    if (key === 'OR') return (cond as Row[]).some((c) => matches(row, c))
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('contains' in cond) return String(row[key] ?? '').toLowerCase().includes(String(cond.contains).toLowerCase())
      if ('gte' in cond || 'lte' in cond) return (cond.gte === undefined || row[key] >= cond.gte) && (cond.lte === undefined || row[key] <= cond.lte)
      throw new Error(`The fake does not understand this condition on ${key}: ${JSON.stringify(cond)}`)
    }
    return row[key] === cond
  })

/** Orders by the requested keys; rows that tie on all of them come back in an order that changes from query to query. */
const ordered = (rows: Row[], orderBy: Row | Row[]) => {
  queryNo += 1
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((o) => Object.entries(o) as [string, 'asc' | 'desc'][])
  const byId = [...rows].sort((x, y) => x.id.localeCompare(y.id))
  const shift = byId.length ? (queryNo * 3) % byId.length : 0
  return [...byId.slice(shift), ...byId.slice(0, shift)]
    .sort((x, y) => {
      for (const [key, dir] of keys) {
        const a = x[key] instanceof Date ? x[key].getTime() : x[key]
        const b = y[key] instanceof Date ? y[key].getTime() : y[key]
        if (a !== b) return (a < b ? -1 : 1) * (dir === 'desc' ? -1 : 1)
      }
      return 0
    })
}

const USERS: Record<string, Row> = {
  'u-admin': { id: 'u-admin', email: 'admin@test.invalid', role: 'ADMIN', status: 'ACTIVE', emailVerified: null, resellerId: null, reseller: null },
  'u-seller': { id: 'u-seller', email: 'seller@test.invalid', role: 'SELLER', status: 'ACTIVE', emailVerified: new Date(), resellerId: 'r1', reseller: { status: 'ACTIVE' } },
}
type Who = keyof typeof USERS

const fakePrisma = strictFake('prisma', {
  user: { findUnique: async ({ where }: { where: { id: string } }) => USERS[where.id] ?? null },
  auditLog: {
    findMany: async (args: Row) => {
      queries.push({ op: 'findMany', ...args })
      const rows = ordered(log.filter((r) => matches(r, args.where)), args.orderBy)
      return rows.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? 20)).map((r) => ({ ...r }))
    },
    count: async (args: Row) => {
      queries.push({ op: 'count', ...args })
      return log.filter((r) => matches(r, args.where)).length
    },
    groupBy: async (args: Row) => {
      queries.push({ op: 'groupBy', ...args })
      const key = args.by[0] as string
      const counts = new Map<string, number>()
      for (const r of log) counts.set(r[key], (counts.get(r[key]) ?? 0) + 1)
      return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([value, n]) => ({ [key]: value, _count: { _all: n } }))
    },
  },
})

describe('Admin → Audit logs API', () => {
  let api: Awaited<ReturnType<typeof serve>>
  let signAccessToken: typeof import('../src/utils/jwt')['signAccessToken']

  const token = (who: Who) => signAccessToken({ userId: who, email: USERS[who].email, role: USERS[who].role, resellerId: USERS[who].resellerId })
  const list = (query = '', who: Who = 'u-admin') => api.call('GET', `/audit-logs${query}`, { token: token(who) })
  const ids = (res: Awaited<ReturnType<typeof list>>) => res.json.data.map((r: Row) => r.id)

  before(async () => {
    installHermeticBackend(fakePrisma)
    ;({ signAccessToken } = await import('../src/utils/jwt'))
    const { errorHandler } = await import('../src/middleware/error.middleware')
    const router = (await import('../src/modules/audit-logs/audit-logs.routes')).default
    const app = express()
    app.use(express.json())
    app.use('/audit-logs', router)
    app.use(errorHandler)
    api = await serve(app)
  })
  after(async () => {
    await api?.close()
  })
  beforeEach(() => {
    seed()
    queries.length = 0
    queryNo = 0
  })

  describe('access', () => {
    it('needs a signed-in user with audit:read: resellers and anonymous callers get nothing', async () => {
      assert.equal((await api.call('GET', '/audit-logs')).status, 401)
      assert.equal((await api.call('GET', '/audit-logs/facets')).status, 401)
      for (const path of ['', '/facets']) {
        const res = await api.call('GET', `/audit-logs${path}`, { token: token('u-seller') })
        assert.equal(res.status, 403, path)
        assert.equal(res.json.message, 'Insufficient permissions')
      }
      assert.equal(queries.length, 0)
    })

    it('offers no way to change the log through this router', async () => {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        for (const path of ['/audit-logs', '/audit-logs/a1']) {
          const res = await api.call(method, path, { token: token('u-admin'), body: {} })
          assert.equal(res.status, 404, `${method} ${path}`)
        }
      }
      assert.equal(log.length, 8)
    })
  })

  describe('listing', () => {
    it('returns the newest entries first with the paging meta', async () => {
      const res = await list('?limit=3')
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.equal(res.json.data.length, 3)
      assert.equal(res.json.meta.total, 8)
      assert.equal(res.json.meta.totalPages, 3)
    })

    it('pages through entries written in the same instant without repeating or losing any', async () => {
      const seen: string[] = []
      for (let page = 1; page <= 4; page++) seen.push(...ids(await list(`?limit=2&page=${page}`)))
      assert.equal(new Set(seen).size, 8, `every entry exactly once, got ${JSON.stringify(seen)}`)
      assert.deepEqual([...seen].sort(), ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'b1', 'c1'])
    })

    it('gives the same order every time the same page is asked for', async () => {
      const first = ids(await list('?limit=4'))
      const second = ids(await list('?limit=4'))
      const third = ids(await list('?limit=4'))
      assert.deepEqual(second, first)
      assert.deepEqual(third, first)
      assert.deepEqual(first.slice(0, 2).every((id: string) => id.startsWith('a')), true)
    })

    it('filters by action, record type, actor type, reseller and actor', async () => {
      assert.deepEqual(ids(await list('?action=COMMISSION_PROMOTED')), ['b1'])
      assert.deepEqual(ids(await list('?entityType=CustomerAccount')), ['c1'])
      assert.deepEqual(ids(await list('?actorType=SYSTEM')), ['b1'])
      assert.deepEqual(ids(await list('?actorType=SAAS')), ['c1'])
      assert.deepEqual(ids(await list('?entityType=ActivationRequest&entityId=ar-a3')), ['a3'])
      assert.deepEqual(ids(await list('?actorUserId=nobody')), [])
    })

    it('searches action, actor e-mail and record id, ignoring case and surrounding spaces', async () => {
      assert.deepEqual(ids(await list('?search=%20payment_verified%20')), ['c1'])
      assert.deepEqual(ids(await list('?search=SAAS:salon')), ['c1'])
      assert.deepEqual(ids(await list('?search=CUS-000042')), ['b1'])
    })

    it('limits to a date range, including both ends', async () => {
      const from = encodeURIComponent('2026-10-01T05:05:00.000Z')
      const to = encodeURIComponent('2026-10-01T05:10:00.000Z')
      assert.deepEqual(ids(await list(`?from=${from}&to=${to}`)).sort(), ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'b1'])
      assert.deepEqual(ids(await list(`?from=${encodeURIComponent('2026-10-01T05:06:00.000Z')}`)).sort(), ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'])
    })

    it('rejects malformed filters and page sizes before querying', async () => {
      for (const query of ['?actorType=ADMIN', '?limit=101', '?page=0', '?from=not-a-date', '?search=' + 'x'.repeat(101)]) {
        assert.equal((await list(query)).status, 422, query)
      }
      assert.equal(queries.length, 0)
    })
  })

  describe('facets', () => {
    it('lists the distinct actions and record types with their counts', async () => {
      const res = await api.call('GET', '/audit-logs/facets', { token: token('u-admin') })
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.deepEqual(res.json.data.actions, [
        { value: 'ACTIVATION_APPROVED', count: 6 },
        { value: 'COMMISSION_PROMOTED', count: 1 },
        { value: 'SUBSCRIPTION_PAYMENT_VERIFIED', count: 1 },
      ])
      assert.deepEqual(res.json.data.entityTypes.map((e: Row) => e.value), ['ActivationRequest', 'Commission', 'CustomerAccount'])
    })
  })

  describe('sensitive data is redacted when an entry is written', () => {
    it('removes password, secret, token and API-key values at any depth, and keeps everything else', async () => {
      const { auditService } = await import('../src/modules/audit-logs/audit.service')
      const written: Row[] = []
      const db = { auditLog: { create: async ({ data }: { data: Row }) => written.push(data) } }
      await auditService.system(
        {
          action: 'TEST_EVENT',
          entityType: 'Test',
          metadata: {
            note: 'kept',
            password: 'p4ss',
            newPassword: 'p4ss2',
            nested: { apiKey: 'k1', api_key: 'k2', webhookSecret: 's1', clientSecret: 's2', accessToken: 't1', authorization: 'Bearer x', amount: '550' },
            list: [{ token: 't2', ok: true }, 'plain'],
          },
        },
        db as never,
      )
      assert.deepEqual(written[0].metadata, {
        note: 'kept',
        password: '[REDACTED]',
        newPassword: '[REDACTED]',
        nested: {
          apiKey: '[REDACTED]',
          api_key: '[REDACTED]',
          webhookSecret: '[REDACTED]',
          clientSecret: '[REDACTED]',
          accessToken: '[REDACTED]',
          authorization: '[REDACTED]',
          amount: '550',
        },
        list: [{ token: '[REDACTED]', ok: true }, 'plain'],
      })
    })
  })
})
