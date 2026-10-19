import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { installHermeticBackend, serve, strictFake } from './helpers/hermetic-backend'

/**
 * Admin → Bank slips register: GET /bank-slips (metadata only; opening a file goes through the audited activation endpoint).
 *  - `status` takes a comma-separated list of real activation statuses; anything else is a 422, not a database error;
 *  - staff see duplicates across every reseller; a reseller (who also holds bankslips:read) only ever sees its own slips and
 *    gets no duplicate information at all (no "used N×" count, no duplicates filter), like its own request screens;
 *  - no file hash or storage detail is returned.
 *
 * Database-free (see tests/helpers/hermetic-backend.ts): the real router, auth and validation run against an in-memory slip
 * store that groups and filters like the queries the route sends. Nothing here reads `.env`, runs Prisma or opens a connection.
 */

type Row = Record<string, any>

const H1 = 'hash-shared-by-two-resellers'
const H2 = 'hash-unique'
const H3 = 'hash-reused-by-r1'

const slips: Row[] = []
const seed = () => {
  const base = (id: string, resellerId: string, sha256: string, minute: number, status = 'UNDER_REVIEW'): Row => ({
    id,
    resellerId,
    sha256,
    originalName: `${id}.pdf`,
    mimeType: 'application/pdf',
    sizeBytes: 1000,
    createdAt: new Date(Date.UTC(2026, 9, 1, 5, minute)),
    activationRequest: { id: `ar-${id}`, reference: `AR-${id}`, status },
  })
  slips.length = 0
  slips.push(
    base('s1', 'r1', H1, 1),
    base('s2', 'r2', H1, 2), // the same file, uploaded by another reseller
    base('s3', 'r1', H2, 3, 'APPROVED'),
    base('s4', 'r1', H3, 4),
    base('s5', 'r1', H3, 5), // r1 re-used its own file
  )
}

const queries = { find: [] as Row[], count: [] as Row[], group: [] as Row[] }

const inScope = (s: Row, where: Row = {}) =>
  (where.resellerId === undefined || s.resellerId === where.resellerId) &&
  (!where.sha256 || where.sha256.in.includes(s.sha256)) &&
  (!where.activationRequest?.status || where.activationRequest.status.in.includes(s.activationRequest.status))

const fakePrisma = strictFake('prisma', {
  user: { findUnique: async ({ where }: { where: { id: string } }) => USERS[where.id] ?? null },
  bankSlip: {
    groupBy: async (args: Row) => {
      queries.group.push(args)
      const groups = new Map<string, number>()
      for (const s of slips.filter((x) => inScope(x, args.where))) groups.set(s.sha256, (groups.get(s.sha256) ?? 0) + 1)
      const min = args.having?.sha256?._count?.gt ?? 0
      return [...groups].filter(([, n]) => n > min).map(([sha256, n]) => ({ sha256, _count: { _all: n } }))
    },
    findMany: async (args: Row) => {
      queries.find.push(args)
      const rows = slips
        .filter((s) => inScope(s, args.where))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? 20))
      return rows.map((s) => ({
        id: s.id,
        originalName: s.originalName,
        mimeType: s.mimeType,
        sizeBytes: s.sizeBytes,
        sha256: s.sha256,
        createdAt: s.createdAt,
        reseller: { id: s.resellerId, code: s.resellerId.toUpperCase(), businessName: `Reseller ${s.resellerId}` },
        activationRequest: { ...s.activationRequest, amount: '5500', currency: 'LKR', transactionRef: 'TX', periodMonth: '2026-10', paymentVerifiedAt: null },
      }))
    },
    count: async (args: Row) => {
      queries.count.push(args)
      return slips.filter((s) => inScope(s, args.where)).length
    },
  },
})

const USERS: Record<string, Row> = {
  'u-admin': { id: 'u-admin', email: 'admin@test.invalid', role: 'ADMIN', status: 'ACTIVE', emailVerified: null, resellerId: null, reseller: null },
  'u-seller': { id: 'u-seller', email: 'seller@test.invalid', role: 'SELLER', status: 'ACTIVE', emailVerified: new Date(), resellerId: 'r1', reseller: { status: 'ACTIVE' } },
  'u-pending': { id: 'u-pending', email: 'pending@test.invalid', role: 'SELLER', status: 'ACTIVE', emailVerified: new Date(), resellerId: 'r3', reseller: { status: 'PENDING' } },
}
type Who = keyof typeof USERS

describe('Admin → Bank slips list API', () => {
  let api: Awaited<ReturnType<typeof serve>>
  let signAccessToken: typeof import('../src/utils/jwt')['signAccessToken']

  const token = (who: Who) => signAccessToken({ userId: who, email: USERS[who].email, role: USERS[who].role, resellerId: USERS[who].resellerId })
  const list = (query = '', who: Who = 'u-admin') => api.call('GET', `/bank-slips${query}`, { token: token(who) })
  const ids = (res: Awaited<ReturnType<typeof list>>) => res.json.data.map((r: Row) => r.id)
  const times = (res: Awaited<ReturnType<typeof list>>) => Object.fromEntries(res.json.data.map((r: Row) => [r.id, r.uploadedTimes]))

  before(async () => {
    installHermeticBackend(fakePrisma)
    ;({ signAccessToken } = await import('../src/utils/jwt'))
    const { errorHandler } = await import('../src/middleware/error.middleware')
    const router = (await import('../src/modules/activations/bank-slips.routes')).default
    const app = express()
    app.use(express.json())
    app.use('/bank-slips', router)
    app.use(errorHandler)
    api = await serve(app)
  })
  after(async () => {
    await api?.close()
  })
  beforeEach(() => {
    seed()
    queries.find = []
    queries.count = []
    queries.group = []
  })

  describe('staff', () => {
    it('see every reseller\'s slips, newest first, with duplicate counts across all resellers', async () => {
      const res = await list()
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.deepEqual(ids(res), ['s5', 's4', 's3', 's2', 's1'])
      assert.deepEqual(times(res), { s1: 2, s2: 2, s3: 1, s4: 2, s5: 2 })
      assert.equal(res.json.meta.total, 5)
    })

    it('"duplicates only" finds a file shared by two resellers as well as one a reseller re-used', async () => {
      const res = await list('?duplicatesOnly=true')
      assert.deepEqual(ids(res).sort(), ['s1', 's2', 's4', 's5'])
      assert.equal(res.json.meta.total, 4)
    })

    it('can narrow to one reseller and still see how many times the file was used anywhere', async () => {
      const res = await list('?resellerId=r1')
      assert.deepEqual(ids(res), ['s5', 's4', 's3', 's1'])
      assert.equal(times(res).s1, 2, 'the other reseller\'s copy still counts for staff')
    })
  })

  describe('a reseller (holds bankslips:read)', () => {
    it('sees only its own slips', async () => {
      const res = await list('', 'u-seller')
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.deepEqual(ids(res), ['s5', 's4', 's3', 's1'])
      const other = await list('?resellerId=r2', 'u-seller')
      assert.deepEqual(ids(other), ['s5', 's4', 's3', 's1'], 'asking for another reseller changes nothing')
    })

    it('gets no duplicate information at all: no "used N×" count, not even for its own re-used file', async () => {
      const res = await list('', 'u-seller')
      assert.equal(res.status, 200, JSON.stringify(res.json))
      for (const row of res.json.data) {
        assert.equal('uploadedTimes' in row, false, `${row.id} must not carry a duplicate count`)
        assert.deepEqual(Object.keys(row).sort(), ['activationRequest', 'createdAt', 'id', 'mimeType', 'originalName', 'reseller', 'sizeBytes'])
      }
      assert.equal(queries.group.length, 0, 'no duplicate analysis is even run for a reseller')
    })

    it('cannot use the duplicates filter (staff only), and is told so', async () => {
      const res = await list('?duplicatesOnly=true', 'u-seller')
      assert.equal(res.status, 403, JSON.stringify(res.json))
      assert.match(res.json.message, /staff/i)
      assert.equal(queries.find.length, 0)
      assert.equal(queries.group.length, 0)
    })

    it('may still send duplicatesOnly=false', async () => {
      assert.equal((await list('?duplicatesOnly=false', 'u-seller')).status, 200)
    })

    it('needs an approved reseller', async () => {
      const res = await list('', 'u-pending')
      assert.equal(res.status, 403)
      assert.equal(queries.find.length, 0)
    })
  })

  describe('input and output', () => {
    it('applies a list of real statuses', async () => {
      const res = await list('?status=APPROVED,REJECTED')
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.deepEqual(queries.find[0].where.activationRequest.status, { in: ['APPROVED', 'REJECTED'] })
      assert.deepEqual(ids(res), ['s3'])
    })

    it('accepts every real activation status', async () => {
      for (const status of ['PENDING_REVIEW', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'ACTIVATION_COMPLETED', 'CANCELLED']) {
        assert.equal((await list(`?status=${status}`)).status, 200, status)
      }
    })

    it('refuses a status that is not an activation status with a 422 and never queries', async () => {
      for (const status of ['PENDING', 'FOO', 'APPROVED,ACTIVE', 'pending_review']) {
        queries.find = []
        const res = await list(`?status=${status}`)
        assert.equal(res.status, 422, `${status}: ${JSON.stringify(res.json)}`)
        assert.equal(res.json.message, 'Validation error')
        assert.match(res.json.errors[0], /^status: /)
        assert.equal(queries.find.length, 0, status)
      }
    })

    it('searches request reference, bank reference and customer name, and pages the results', async () => {
      const res = await list('?search=%20kandy%20&page=2&limit=2')
      assert.equal(res.status, 200, JSON.stringify(res.json))
      const or = queries.find[0].where.activationRequest.OR
      assert.equal(or.length, 3)
      assert.equal(or[0].reference.contains, 'kandy')
      assert.equal(queries.find[0].skip, 2)
      assert.equal(queries.find[0].take, 2)
      assert.deepEqual({ page: res.json.meta.page, limit: res.json.meta.limit }, { page: 2, limit: 2 })
    })

    it('rejects a malformed switch, date or page size', async () => {
      for (const query of ['?duplicatesOnly=yes', '?from=not-a-date', '?limit=101', '?page=0']) {
        assert.equal((await list(query)).status, 422, query)
      }
      assert.equal(queries.find.length, 0)
    })

    it('never returns the file hash or any storage detail', async () => {
      const res = await list()
      for (const row of res.json.data) {
        assert.equal('sha256' in row, false)
        assert.equal('storageKey' in row, false)
        assert.deepEqual(Object.keys(row).sort(), ['activationRequest', 'createdAt', 'id', 'mimeType', 'originalName', 'reseller', 'sizeBytes', 'uploadedTimes'])
      }
    })

    it('needs a signed-in user', async () => {
      const res = await api.call('GET', '/bank-slips')
      assert.equal(res.status, 401)
      assert.equal(queries.find.length, 0)
    })
  })
})
