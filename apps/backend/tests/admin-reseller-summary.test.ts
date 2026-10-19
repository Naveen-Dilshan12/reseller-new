import { after, before, beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { installHermeticBackend, serve, strictFake } from './helpers/hermetic-backend'

/**
 * `GET /admin/resellers/:id` is the safe identity lookup the Products page uses for its header, instead of the
 * full application profile (NIC, address, bank, and an audit row per view).
 *
 * Database-free: real router, auth middleware and service against an in-memory stand-in for Prisma
 * (see tests/helpers/hermetic-backend.ts). Nothing here reads `.env` or opens a connection.
 */

// Everything a reseller row holds; the endpoint must only ever surface the fields it selects.
const ROW = {
  id: 'rs-1',
  code: 'RS-0001',
  businessName: 'Acme Salons',
  status: 'ACTIVE',
  fullName: 'Nimal Perera',
  nicOrPassport: '901234567V',
  address: '12 Galle Road, Colombo',
  email: 'nimal@acme.invalid',
  mobile: '0771234567',
  suspensionReason: null,
}

const USERS: Record<string, object> = {
  'u-admin': { id: 'u-admin', email: 'admin@test.invalid', role: 'ADMIN', status: 'ACTIVE', emailVerified: null, resellerId: null, reseller: null },
  'u-seller': { id: 'u-seller', email: 'seller@test.invalid', role: 'SELLER', status: 'ACTIVE', emailVerified: new Date(), resellerId: 'rs-own', reseller: { status: 'ACTIVE' } },
}

const lookups: Array<{ where: { id: string }; select?: Record<string, boolean> }> = []
const fakePrisma = strictFake('prisma', {
  user: { findUnique: async ({ where }: { where: { id: string } }) => USERS[where.id] ?? null },
  reseller: {
    findUnique: async (args: { where: { id: string }; select?: Record<string, boolean> }) => {
      lookups.push(args)
      if (args.where.id !== ROW.id) return null
      // Honour `select` the way Prisma does, so the response proves what the query asked for.
      const row = ROW as Record<string, unknown>
      return args.select ? Object.fromEntries(Object.keys(args.select).filter((k) => args.select![k]).map((k) => [k, row[k]])) : { ...ROW }
    },
  },
})

describe('GET /admin/resellers/:id (reseller identity for page headers)', () => {
  let api: Awaited<ReturnType<typeof serve>>
  let audit: ReturnType<typeof mock.method>
  let signAccessToken: typeof import('../src/utils/jwt')['signAccessToken']

  before(async () => {
    installHermeticBackend(fakePrisma)
    ;({ signAccessToken } = await import('../src/utils/jwt'))
    const { auditService } = await import('../src/modules/audit-logs/audit.service')
    const { errorHandler } = await import('../src/middleware/error.middleware')
    const { resellersAdminRouter } = await import('../src/modules/resellers/resellers.routes')

    audit = mock.method(auditService, 'fromRequest', async () => undefined)
    const app = express()
    app.use(express.json())
    app.use('/admin/resellers', resellersAdminRouter)
    app.use(errorHandler)
    api = await serve(app)
  })

  after(async () => {
    mock.restoreAll()
    await api?.close()
  })

  beforeEach(() => {
    lookups.length = 0
    audit.mock.resetCalls()
  })

  const tokenFor = (user: 'u-admin' | 'u-seller') => {
    const u = USERS[user] as { id: string; email: string; role: 'ADMIN' | 'SELLER'; resellerId: string | null }
    return signAccessToken({ userId: u.id, email: u.email, role: u.role, resellerId: u.resellerId })
  }

  it('returns only id, code, business name and status', async () => {
    const res = await api.call('GET', '/admin/resellers/rs-1', { token: tokenFor('u-admin') })
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.deepEqual(res.json.data, { id: 'rs-1', code: 'RS-0001', businessName: 'Acme Salons', status: 'ACTIVE' })
    assert.deepEqual(Object.keys(lookups[0].select ?? {}).sort(), ['businessName', 'code', 'id', 'status'], 'the query itself must not select personal data')
    const body = JSON.stringify(res.json)
    for (const secret of [ROW.nicOrPassport, ROW.address, ROW.email, ROW.mobile, ROW.fullName]) assert.equal(body.includes(secret), false, `response must not contain ${secret}`)
  })

  it('does not write an audit entry (it is not a profile view)', async () => {
    await api.call('GET', '/admin/resellers/rs-1', { token: tokenFor('u-admin') })
    assert.equal(audit.mock.callCount(), 0)
  })

  it('404s for an unknown reseller', async () => {
    const res = await api.call('GET', '/admin/resellers/nope', { token: tokenFor('u-admin') })
    assert.equal(res.status, 404)
    assert.match(res.json.message, /not found/i)
  })

  it('needs a signed-in user with resellers:read: no token 401, approved seller 403', async () => {
    assert.equal((await api.call('GET', '/admin/resellers/rs-1')).status, 401)
    const seller = await api.call('GET', '/admin/resellers/rs-1', { token: tokenFor('u-seller') })
    assert.equal(seller.status, 403)
    assert.equal(seller.json.message, 'Insufficient permissions')
    assert.equal(lookups.length, 0, 'no reseller lookup happens for a refused caller')
  })

  it('the Products page uses it, and no longer requests the application profile', () => {
    const page = fs.readFileSync(path.resolve(__dirname, '../../web/src/app/admin/resellers/[id]/products/page.tsx'), 'utf8')
    // Paths handed to api()/apiRequest(); plain <Link href> navigation is fine and not matched.
    const requested = [...page.matchAll(/\bapi(?:Request)?\s*(?:<[^()]*?>)?\s*\(\s*`([^`]*)`/g)].map((m) => m[1])
    assert.ok(requested.includes('/admin/resellers/${id}'), `expected the header lookup, got ${JSON.stringify(requested)}`)
    assert.ok(requested.includes('/admin/resellers/${id}/product-access'))
    assert.deepEqual(requested.filter((p) => p.includes('reseller-applications')), [], 'must not fetch the application profile')
  })
})
