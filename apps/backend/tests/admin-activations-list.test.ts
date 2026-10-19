import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { installHermeticBackend, serve, strictFake } from './helpers/hermetic-backend'

/**
 * Admin → Activation requests: GET /activation-requests (the list behind the page).
 *  - `status` takes a comma-separated list of real activation statuses; anything else is a 422 validation error, not a
 *    database error;
 *  - filters, search and paging reach the query; a reseller is always limited to its own requests;
 *  - the KPI pipeline counts ignore the status filter and the search.
 *
 * Database-free (see tests/helpers/hermetic-backend.ts): the real router, auth, validation and list service run against a
 * recording fake. Nothing here reads `.env`, runs Prisma or opens a connection.
 */

type Row = Record<string, any>

const USERS: Record<string, Row> = {
  'u-admin': { id: 'u-admin', email: 'admin@test.invalid', role: 'ADMIN', status: 'ACTIVE', emailVerified: null, resellerId: null, reseller: null },
  'u-seller': { id: 'u-seller', email: 'seller@test.invalid', role: 'SELLER', status: 'ACTIVE', emailVerified: new Date(), resellerId: 'r1', reseller: { status: 'ACTIVE' } },
}
type Who = keyof typeof USERS

const queries = { find: [] as Row[], count: [] as Row[] }

const fakePrisma = strictFake('prisma', {
  user: { findUnique: async ({ where }: { where: { id: string } }) => USERS[where.id] ?? null },
  activationRequest: {
    findMany: async (args: Row) => {
      queries.find.push(args)
      return [{ id: 'ar1', reference: 'AR-AAA111', status: 'PENDING_REVIEW' }]
    },
    count: async (args: Row) => {
      queries.count.push(args)
      return 7
    },
  },
})

describe('Admin → Activation requests list API', () => {
  let api: Awaited<ReturnType<typeof serve>>
  let signAccessToken: typeof import('../src/utils/jwt')['signAccessToken']

  const token = (who: Who) => signAccessToken({ userId: who, email: USERS[who].email, role: USERS[who].role, resellerId: USERS[who].resellerId })
  const list = (query: string, who: Who = 'u-admin') => api.call('GET', `/activation-requests${query}`, { token: token(who) })

  before(async () => {
    installHermeticBackend(fakePrisma)
    ;({ signAccessToken } = await import('../src/utils/jwt'))
    const { errorHandler } = await import('../src/middleware/error.middleware')
    const router = (await import('../src/modules/activations/activations.routes')).default
    const app = express()
    app.use(express.json())
    app.use('/activation-requests', router)
    app.use(errorHandler)
    api = await serve(app)
  })
  after(async () => {
    await api?.close()
  })
  beforeEach(() => {
    queries.find = []
    queries.count = []
  })

  it('applies a list of real statuses, paging and search, and returns the pipeline counts', async () => {
    const res = await list('?status=PENDING_REVIEW,UNDER_REVIEW&page=2&limit=25&search=%20kandy%20')
    assert.equal(res.status, 200, JSON.stringify(res.json))
    const where = queries.find[0].where
    assert.deepEqual(where.status, { in: ['PENDING_REVIEW', 'UNDER_REVIEW'] })
    assert.equal(where.OR.length, 4)
    assert.equal(where.OR[0].reference.contains, 'kandy', 'the search is trimmed')
    assert.equal(queries.find[0].skip, 25)
    assert.equal(queries.find[0].take, 25)
    assert.equal(res.json.meta.total, 7)
    assert.deepEqual(Object.keys(res.json.meta.pipelineCounts), ['total', 'pendingReview', 'underReview', 'completed'])
  })

  it('accepts every real activation status, one at a time', async () => {
    for (const status of ['PENDING_REVIEW', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'ACTIVATION_COMPLETED', 'CANCELLED']) {
      const res = await list(`?status=${status}`)
      assert.equal(res.status, 200, `${status}: ${JSON.stringify(res.json)}`)
    }
  })

  it('refuses a status that is not an activation status with a 422 that names it, and never queries', async () => {
    for (const status of ['PENDING', 'FOO', 'PENDING_REVIEW,FOO', 'APPROVED,ACTIVE', 'ACTIVATION_IN_PROGRESS']) {
      queries.find = []
      const res = await list(`?status=${status}`)
      assert.equal(res.status, 422, `${status}: ${JSON.stringify(res.json)}`)
      assert.equal(res.json.message, 'Validation error')
      assert.match(res.json.errors[0], /^status: /)
      assert.equal(queries.find.length, 0, `${status}: invalid input must not reach the database`)
    }
  })

  it('still refuses malformed status lists and out-of-range paging', async () => {
    for (const query of ['?status=pending_review', '?status=PENDING_REVIEW,', '?status=,APPROVED', '?limit=101', '?page=0']) {
      const res = await list(query)
      assert.equal(res.status, 422, query)
    }
    assert.equal(queries.find.length, 0)
  })

  it('KPI counts ignore the status filter and the search', async () => {
    await list('?status=APPROVED&search=zzz')
    const countWheres = queries.count.map((c) => c.where)
    assert.equal(countWheres.length, 5)
    // list total (filtered), then the four pipeline counts
    assert.deepEqual(countWheres[0].status, { in: ['APPROVED'] })
    for (const w of countWheres.slice(1)) assert.equal(w.OR, undefined)
    assert.deepEqual(countWheres.slice(1).map((w) => w.status), [undefined, 'PENDING_REVIEW', 'UNDER_REVIEW', 'ACTIVATION_COMPLETED'])
  })

  it('an admin may filter by reseller; a reseller is always limited to its own requests', async () => {
    await list('?resellerId=r2', 'u-admin')
    assert.equal(queries.find[0].where.resellerId, 'r2')
    queries.find = []
    queries.count = []
    await list('?resellerId=r2', 'u-seller')
    assert.equal(queries.find[0].where.resellerId, 'r1')
    for (const c of queries.count) assert.equal(c.where.resellerId, 'r1')
  })

  it('needs a signed-in user with activations:read', async () => {
    const anonymous = await api.call('GET', '/activation-requests')
    assert.equal(anonymous.status, 401)
    assert.equal(queries.find.length, 0)
  })
})
