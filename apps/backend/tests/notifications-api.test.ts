import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { installHermeticBackend, serve, strictFake } from './helpers/hermetic-backend'

/**
 * Notifications API behind the admin (and reseller) inbox: /notifications.
 *  - every route works only on the caller's own notifications: listing, unread count, read-all and read-one;
 *  - someone else's notification id looks exactly like a missing one (404);
 *  - paging and the unread filter reach the query; anonymous callers get nothing.
 *
 * Database-free (see tests/helpers/hermetic-backend.ts): the real router, auth and validation run against an in-memory
 * notification table. Nothing here reads `.env`, runs Prisma or opens a connection.
 */

type Row = Record<string, any>
const rows: Row[] = []
const seed = () => {
  const n = (id: string, userId: string, minute: number, readAt: Date | null = null): Row => ({
    id,
    userId,
    type: 'TEST',
    title: `Title ${id}`,
    body: 'body',
    link: null,
    readAt,
    createdAt: new Date(Date.UTC(2026, 9, 1, 5, minute)),
  })
  rows.length = 0
  rows.push(n('a1', 'u-admin', 1), n('a2', 'u-admin', 2, new Date('2026-10-02T00:00:00Z')), n('a3', 'u-admin', 3), n('s1', 'u-seller', 4), n('s2', 'u-seller', 5))
}
const matches = (r: Row, where: Row = {}) => Object.entries(where).every(([k, v]) => v === undefined || r[k] === v)

const USERS: Record<string, Row> = {
  'u-admin': { id: 'u-admin', email: 'admin@test.invalid', role: 'ADMIN', status: 'ACTIVE', emailVerified: null, resellerId: null, reseller: null },
  'u-seller': { id: 'u-seller', email: 'seller@test.invalid', role: 'SELLER', status: 'ACTIVE', emailVerified: new Date(), resellerId: 'r1', reseller: { status: 'ACTIVE' } },
}
type Who = keyof typeof USERS

const queries: Row[] = []
const fakePrisma = strictFake('prisma', {
  user: { findUnique: async ({ where }: { where: { id: string } }) => USERS[where.id] ?? null },
  notification: {
    findMany: async (args: Row) => {
      queries.push({ op: 'findMany', ...args })
      return rows
        .filter((r) => matches(r, args.where))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? 20))
        .map((r) => ({ ...r }))
    },
    count: async (args: Row) => rows.filter((r) => matches(r, args.where)).length,
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const hit = rows.filter((r) => matches(r, where))
      hit.forEach((r) => Object.assign(r, data))
      return { count: hit.length }
    },
  },
})

describe('Notifications API', () => {
  let api: Awaited<ReturnType<typeof serve>>
  let signAccessToken: typeof import('../src/utils/jwt')['signAccessToken']

  const token = (who: Who) => signAccessToken({ userId: who, email: USERS[who].email, role: USERS[who].role, resellerId: USERS[who].resellerId })
  const call = (method: string, path: string, who: Who = 'u-admin') => api.call(method, `/notifications${path}`, { token: token(who) })
  const ids = (res: Awaited<ReturnType<typeof call>>) => res.json.data.map((r: Row) => r.id)
  const unreadOf = (userId: string) => rows.filter((r) => r.userId === userId && !r.readAt).map((r) => r.id)

  before(async () => {
    installHermeticBackend(fakePrisma)
    ;({ signAccessToken } = await import('../src/utils/jwt'))
    const { errorHandler } = await import('../src/middleware/error.middleware')
    const router = (await import('../src/modules/notifications/notifications.routes')).default
    const app = express()
    app.use(express.json())
    app.use('/notifications', router)
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

  it('lists only the caller\'s notifications, newest first, with paging meta', async () => {
    const res = await call('GET', '')
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.deepEqual(ids(res), ['a3', 'a2', 'a1'])
    assert.equal(res.json.meta.total, 3)
    assert.deepEqual(ids(await call('GET', '', 'u-seller')), ['s2', 's1'])
  })

  it('pages the list and filters to unread', async () => {
    const page2 = await call('GET', '?limit=2&page=2')
    assert.deepEqual(ids(page2), ['a1'])
    assert.equal(page2.json.meta.totalPages, 2)
    const unread = await call('GET', '?unread=true')
    assert.deepEqual(ids(unread), ['a3', 'a1'])
    assert.equal(unread.json.meta.total, 2)
    assert.deepEqual(ids(await call('GET', '?unread=false')), ['a3', 'a2', 'a1'])
  })

  it('rejects a malformed filter or page size', async () => {
    for (const query of ['?unread=yes', '?limit=101', '?page=0']) assert.equal((await call('GET', query)).status, 422, query)
    assert.equal(queries.length, 0)
  })

  it('counts only the caller\'s unread notifications', async () => {
    assert.equal((await call('GET', '/unread-count')).json.data.count, 2)
    assert.equal((await call('GET', '/unread-count', 'u-seller')).json.data.count, 2)
  })

  it('"read all" marks only the caller\'s unread notifications', async () => {
    const res = await call('POST', '/read-all')
    assert.equal(res.status, 200)
    assert.equal(res.json.data.updated, 2)
    assert.deepEqual(unreadOf('u-admin'), [])
    assert.deepEqual(unreadOf('u-seller'), ['s1', 's2'], 'the other user\'s notifications are untouched')
  })

  it('marks one of the caller\'s notifications as read', async () => {
    const res = await call('POST', '/a1/read')
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.deepEqual(unreadOf('u-admin'), ['a3'])
  })

  it('treats another user\'s notification id exactly like a missing one, and does not touch it', async () => {
    const other = await call('POST', '/s1/read')
    const missing = await call('POST', '/does-not-exist/read')
    assert.equal(other.status, 404)
    assert.equal(missing.status, 404)
    assert.equal(other.json.message, missing.json.message)
    assert.deepEqual(unreadOf('u-seller'), ['s1', 's2'])
  })

  it('needs a signed-in user', async () => {
    for (const [method, path] of [['GET', ''], ['GET', '/unread-count'], ['POST', '/read-all'], ['POST', '/a1/read']]) {
      assert.equal((await api.call(method, `/notifications${path}`)).status, 401, `${method} ${path}`)
    }
    assert.deepEqual(unreadOf('u-admin'), ['a1', 'a3'])
  })
})
