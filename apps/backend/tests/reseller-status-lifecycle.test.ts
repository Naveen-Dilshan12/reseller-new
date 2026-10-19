import { after, before, beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { installHermeticBackend, serve, strictFake } from './helpers/hermetic-backend'

/**
 * Admin → Resellers → Suspend / Reactivate, end to end through the real router, auth, validation, services,
 * audit and notification code, against an in-memory stand-in for the Prisma calls they make.
 *
 * Database-free (see tests/helpers/hermetic-backend.ts): nothing here reads `.env`, runs Prisma or opens a
 * connection. The stand-in models what matters for these tests:
 *  - `$transaction` runs one callback at a time and discards everything it wrote if the callback throws;
 *  - a write to reseller / refresh-token / audit rows through the ROOT client while a transaction is open
 *    throws, because on a real database that write would be outside the transaction and would not roll back;
 *  - a failure can be injected once into the audit insert, the token revocation, or the notification path.
 * It cannot prove Postgres behaviour; it proves that the code puts the right writes in one transaction and
 * handles failures of the rest.
 */

type Status = 'PENDING' | 'ACTIVE' | 'REJECTED' | 'SUSPENDED' | 'TERMINATED'
interface ResellerRow { id: string; code: string; businessName: string; status: Status; suspendedAt: Date | null; suspensionReason: string | null }
interface TokenRow { id: string; userId: string; revokedAt: Date | null }
interface UserRow { id: string; email: string; role: 'ADMIN' | 'SELLER'; status: 'ACTIVE' | 'INACTIVE'; emailVerified: Date | null; resellerId: string | null }
interface AuditRow { action: string; entityType: string; entityId: string | null; resellerId: string | null; metadata?: Record<string, unknown>; actorUserId: string | null; actorEmail: string | null; actorType: string }
interface NoticeRow { userId: string; type: string; title: string; body: string; link?: string }

const OLD = new Date('2024-01-01T00:00:00Z')
const state = {
  resellers: new Map<string, ResellerRow>(),
  tokens: [] as TokenRow[],
  users: new Map<string, UserRow>(),
  audit: [] as AuditRow[],
  notices: [] as NoticeRow[],
}
/** Which transaction (null = root client) each write went through. */
const writes: Array<{ op: string; txId: number | null }> = []
type FailPoint = 'auditCreate' | 'tokenRevoke' | 'userFindMany' | 'noticeCreate'
const failOnce: Partial<Record<FailPoint, Error>> = {}
let openTx: number | null = null
let txCounter = 0

function trip(point: FailPoint) {
  const err = failOnce[point]
  if (err) {
    delete failOnce[point]
    throw err
  }
}
const definedOnly = (o: object) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
const project = (row: object | undefined, select?: Record<string, boolean>) =>
  row ? (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, (row as Record<string, unknown>)[k]])) : { ...row }) : null

function models(txId: number | null) {
  const write = (op: string, guarded = true) => {
    if (guarded && txId === null && openTx !== null) throw new Error(`${op} used the root client while a transaction was open; it would not roll back with it`)
    writes.push({ op, txId })
  }
  return {
    reseller: {
      updateMany: async ({ where, data }: { where: { id: string; status: Status }; data: object }) => {
        write('reseller.updateMany')
        const row = state.resellers.get(where.id)
        if (!row || row.status !== where.status) return { count: 0 }
        Object.assign(row, definedOnly(data))
        return { count: 1 }
      },
      findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => project(state.resellers.get(where.id), select),
      findUniqueOrThrow: async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
        const row = project(state.resellers.get(where.id), select)
        if (!row) throw new Error('No Reseller found')
        return row
      },
    },
    refreshToken: {
      updateMany: async ({ where, data }: { where: { user: { resellerId: string }; revokedAt: null }; data: { revokedAt: Date } }) => {
        write('refreshToken.updateMany')
        trip('tokenRevoke')
        const hit = state.tokens.filter((t) => state.users.get(t.userId)?.resellerId === where.user.resellerId && t.revokedAt === null)
        hit.forEach((t) => (t.revokedAt = data.revokedAt))
        return { count: hit.length }
      },
    },
    auditLog: {
      create: async ({ data }: { data: AuditRow }) => {
        write('auditLog.create')
        trip('auditCreate')
        state.audit.push({ ...data })
        return data
      },
    },
    notification: {
      createMany: async ({ data }: { data: NoticeRow[] }) => {
        write('notification.createMany', false)
        trip('noticeCreate')
        state.notices.push(...data.map((d) => ({ ...d })))
        return { count: data.length }
      },
    },
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const user = state.users.get(where.id)
        if (!user) return null
        const reseller = user.resellerId ? state.resellers.get(user.resellerId) : undefined
        return { ...user, reseller: reseller ? { status: reseller.status } : null }
      },
      findMany: async ({ where }: { where: { resellerId: string; status: string } }) => {
        trip('userFindMany')
        return [...state.users.values()].filter((u) => u.resellerId === where.resellerId && u.status === where.status).map((u) => ({ id: u.id }))
      },
    },
  }
}

const snapshot = () => ({
  resellers: new Map([...state.resellers].map(([k, v]) => [k, { ...v }] as const)),
  tokens: state.tokens.map((t) => ({ ...t })),
  audit: [...state.audit],
  notices: [...state.notices],
})
let queue: Promise<unknown> = Promise.resolve()
const $transaction = <T>(fn: (tx: object) => Promise<T>): Promise<T> => {
  const run = async () => {
    const before = snapshot()
    const id = ++txCounter
    openTx = id
    try {
      return await fn(strictFake('tx', models(id)))
    } catch (err) {
      Object.assign(state, before) // rollback
      throw err
    } finally {
      openTx = null
    }
  }
  const result = queue.then(run, run) // one transaction at a time, like row locks on the same reseller
  queue = result.catch(() => undefined)
  return result
}
const fakePrisma = strictFake('prisma', { ...models(null), $transaction })

// ---- fixtures -------------------------------------------------------------------------------------------

const addReseller = (id: string, status: Status, extra: Partial<ResellerRow> = {}) =>
  state.resellers.set(id, { id, code: `CODE-${id}`, businessName: `Business ${id}`, status, suspendedAt: null, suspensionReason: null, ...extra })
const addUser = (u: Partial<UserRow> & { id: string }) =>
  state.users.set(u.id, { email: `${u.id}@test.invalid`, role: 'SELLER', status: 'ACTIVE', emailVerified: new Date(), resellerId: null, ...u })

function reset() {
  state.resellers = new Map()
  state.users = new Map()
  state.tokens = []
  state.audit = []
  state.notices = []
  writes.length = 0
  for (const k of Object.keys(failOnce)) delete failOnce[k as FailPoint]
  addReseller('rs-1', 'ACTIVE')
  addReseller('rs-2', 'ACTIVE')
  addUser({ id: 'u-admin', role: 'ADMIN', emailVerified: null })
  addUser({ id: 'u-seller-1', resellerId: 'rs-1' })
  addUser({ id: 'u-seller-1b', resellerId: 'rs-1' })
  addUser({ id: 'u-seller-1c', resellerId: 'rs-1', status: 'INACTIVE' })
  addUser({ id: 'u-seller-2', resellerId: 'rs-2' })
  state.tokens = [
    { id: 't1', userId: 'u-seller-1', revokedAt: null },
    { id: 't2', userId: 'u-seller-1b', revokedAt: null },
    { id: 't3', userId: 'u-seller-1', revokedAt: OLD }, // already revoked: its timestamp must not move
    { id: 't4', userId: 'u-seller-2', revokedAt: null }, // another reseller
    { id: 't5', userId: 'u-admin', revokedAt: null }, // staff
  ]
}
/** rs-1 as it looks after a successful suspension. */
function makeSuspended() {
  Object.assign(state.resellers.get('rs-1')!, { status: 'SUSPENDED', suspendedAt: new Date('2025-05-01T00:00:00Z'), suspensionReason: 'Unpaid invoices' })
  state.tokens.filter((t) => ['u-seller-1', 'u-seller-1b'].includes(t.userId)).forEach((t) => (t.revokedAt ??= new Date('2025-05-01T00:00:00Z')))
}
const fingerprint = () =>
  JSON.stringify({ resellers: [...state.resellers], tokens: state.tokens, audit: state.audit, notices: state.notices })
const rs1 = () => state.resellers.get('rs-1')!
const revokedIds = () => state.tokens.filter((t) => t.revokedAt !== null).map((t) => t.id).sort()
const REASON = 'Unpaid invoices for March'

describe('Reseller suspend / reactivate lifecycle', () => {
  let api: Awaited<ReturnType<typeof serve>>
  let signAccessToken: typeof import('../src/utils/jwt')['signAccessToken']
  let logger: typeof import('../src/utils/logger')['logger']

  const tokenFor = (userId: string) => {
    const u = state.users.get(userId)!
    return signAccessToken({ userId: u.id, email: u.email, role: u.role, resellerId: u.resellerId })
  }
  const suspend = (id: string, body: unknown = { reason: REASON }, token = tokenFor('u-admin')) =>
    api.call('POST', `/admin/resellers/${id}/suspend`, { token, body })
  const reactivate = (id: string, body?: unknown, token = tokenFor('u-admin')) =>
    api.call('POST', `/admin/resellers/${id}/reactivate`, { token, body })
  /** What `authenticate` says to a reseller's own user on an admin-only route. */
  const sellerProbe = async () => (await api.call('GET', '/admin/resellers/rs-1', { token: tokenFor('u-seller-1') })).json.message

  before(async () => {
    installHermeticBackend(fakePrisma)
    ;({ signAccessToken } = await import('../src/utils/jwt'))
    ;({ logger } = await import('../src/utils/logger'))
    const { errorHandler } = await import('../src/middleware/error.middleware')
    const { resellersAdminRouter } = await import('../src/modules/resellers/resellers.routes')
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
  beforeEach(reset)

  describe('suspend: ACTIVE → SUSPENDED', () => {
    it('suspends, revokes only that reseller’s live sessions, and writes one audit entry', async () => {
      const res = await suspend('rs-1', { reason: `  ${REASON}  ` })
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.equal(res.json.message, 'Partner suspended')
      assert.deepEqual(res.json.data, { id: 'rs-1', code: 'CODE-rs-1', businessName: 'Business rs-1', status: 'SUSPENDED' })

      assert.equal(rs1().status, 'SUSPENDED')
      assert.ok(rs1().suspendedAt instanceof Date)
      assert.equal(rs1().suspensionReason, REASON, 'reason is trimmed')

      assert.deepEqual(revokedIds(), ['t1', 't2', 't3'], 'rs-1 users revoked; rs-2 user and staff untouched')
      assert.equal(state.tokens.find((t) => t.id === 't3')!.revokedAt, OLD, 'an already-revoked session keeps its timestamp')

      assert.equal(state.audit.length, 1)
      const [entry] = state.audit
      assert.equal(entry.action, 'RESELLER_SUSPENDED')
      assert.equal(entry.entityType, 'Reseller')
      assert.equal(entry.entityId, 'rs-1')
      assert.equal(entry.resellerId, 'rs-1')
      assert.equal(entry.actorType, 'USER')
      assert.equal(entry.actorUserId, 'u-admin')
      assert.deepEqual(entry.metadata, { reason: REASON, sessionsRevoked: 2 })
      assert.equal(state.notices.length, 0, 'suspension sends no notification (unchanged behaviour)')
    })

    it('cuts the reseller’s existing access tokens off immediately', async () => {
      assert.equal(await sellerProbe(), 'Insufficient permissions', 'before: a normal admin-route refusal')
      await suspend('rs-1')
      assert.equal(await sellerProbe(), 'Partner account is suspended')
    })

    it('puts the status change, the session revocation and the audit entry in one transaction', async () => {
      await suspend('rs-1')
      assert.deepEqual(writes.map((w) => w.op), ['reseller.updateMany', 'refreshToken.updateMany', 'auditLog.create'])
      assert.equal(new Set(writes.map((w) => w.txId)).size, 1)
      assert.notEqual(writes[0].txId, null, 'not on the root client')
    })

    it('a failing audit write rolls everything back: still ACTIVE, sessions alive, and a retry works', async () => {
      failOnce.auditCreate = new Error('audit store unavailable')
      const before = fingerprint()
      const res = await suspend('rs-1')
      assert.equal(res.status, 500)
      assert.equal(fingerprint(), before, 'no half-applied suspension')
      assert.equal(rs1().status, 'ACTIVE')

      const retry = await suspend('rs-1')
      assert.equal(retry.status, 200, 'the same request can be retried, not stuck behind a 409')
      assert.equal(rs1().status, 'SUSPENDED')
      assert.deepEqual(revokedIds(), ['t1', 't2', 't3'])
      assert.equal(state.audit.length, 1)
    })

    it('a failing session revocation rolls the status change back too, and a retry works', async () => {
      failOnce.tokenRevoke = new Error('token store unavailable')
      const before = fingerprint()
      const res = await suspend('rs-1')
      assert.equal(res.status, 500)
      assert.equal(fingerprint(), before)
      assert.equal(rs1().suspendedAt, null)
      assert.equal(rs1().suspensionReason, null)

      assert.equal((await suspend('rs-1')).status, 200)
      assert.deepEqual(revokedIds(), ['t1', 't2', 't3'])
    })

    it('rejects every non-ACTIVE status with 409 and changes nothing', async () => {
      for (const status of ['SUSPENDED', 'PENDING', 'REJECTED', 'TERMINATED'] as const) {
        addReseller(`rs-${status}`, status)
        const before = fingerprint()
        const res = await suspend(`rs-${status}`)
        assert.equal(res.status, 409, status)
        assert.equal(res.json.message, `This action is not allowed while the partner is ${status}`)
        assert.equal(fingerprint(), before, `${status}: nothing written`)
      }
    })

    it('404s for an unknown reseller and writes nothing', async () => {
      const before = fingerprint()
      const res = await suspend('does-not-exist')
      assert.equal(res.status, 404)
      assert.equal(res.json.message, 'Partner not found')
      assert.equal(fingerprint(), before)
    })

    it('rejects invalid input with 422 (this API’s validation status) and changes nothing', async () => {
      const bad: Array<[string, unknown]> = [
        ['missing reason', {}],
        ['reason shorter than 10 characters', { reason: 'too short' }],
        ['reason that is short once trimmed', { reason: '      short   ' }],
        ['reason over 500 characters', { reason: 'x'.repeat(501) }],
        ['non-string reason', { reason: 12345678901 }],
        ['unknown field', { reason: REASON, extra: true }],
      ]
      for (const [label, body] of bad) {
        const before = fingerprint()
        const res = await suspend('rs-1', body)
        assert.equal(res.status, 422, label)
        assert.equal(fingerprint(), before, label)
      }
      assert.equal(rs1().status, 'ACTIVE')
    })

    it('rejects a malformed JSON body with 400 and changes nothing', async () => {
      const before = fingerprint()
      const res = await api.call('POST', '/admin/resellers/rs-1/suspend', { token: tokenFor('u-admin'), rawBody: '{"reason": ' })
      assert.equal(res.status, 400)
      assert.equal(fingerprint(), before)
    })

    it('needs resellers:manage: no token 401, a reseller user 403, and nothing changes', async () => {
      const before = fingerprint()
      assert.equal((await api.call('POST', '/admin/resellers/rs-1/suspend', { body: { reason: REASON } })).status, 401)
      const own = await suspend('rs-1', { reason: REASON }, tokenFor('u-seller-1'))
      assert.equal(own.status, 403)
      assert.equal(own.json.message, 'Insufficient permissions')
      assert.equal((await suspend('rs-1', { reason: REASON }, tokenFor('u-seller-2'))).status, 403)
      assert.equal(fingerprint(), before)
    })

    it('two simultaneous suspensions: exactly one wins and is audited once', async () => {
      const results = await Promise.all([suspend('rs-1'), suspend('rs-1')])
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
      assert.equal(state.audit.length, 1)
      assert.equal(state.audit[0].metadata?.sessionsRevoked, 2)
    })
  })

  describe('reactivate: SUSPENDED → ACTIVE', () => {
    beforeEach(makeSuspended)

    it('reactivates, clears the suspension, audits with the previous reason, and notifies active users once', async () => {
      const res = await reactivate('rs-1', { note: '  Paid in full  ' })
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.equal(res.json.message, 'Partner reactivated')
      assert.deepEqual(res.json.data, { id: 'rs-1', code: 'CODE-rs-1', businessName: 'Business rs-1', status: 'ACTIVE' })
      assert.equal(rs1().status, 'ACTIVE')
      assert.equal(rs1().suspendedAt, null)
      assert.equal(rs1().suspensionReason, null)

      assert.equal(state.audit.length, 1)
      const [entry] = state.audit
      assert.equal(entry.action, 'RESELLER_REACTIVATED')
      assert.equal(entry.entityType, 'Reseller')
      assert.equal(entry.entityId, 'rs-1')
      assert.equal(entry.resellerId, 'rs-1')
      assert.equal(entry.actorUserId, 'u-admin')
      assert.deepEqual(entry.metadata, { note: 'Paid in full', previousSuspensionReason: 'Unpaid invoices' })

      assert.deepEqual(state.notices.map((n) => n.userId).sort(), ['u-seller-1', 'u-seller-1b'], 'active users of this reseller only')
      for (const n of state.notices) {
        assert.deepEqual({ type: n.type, title: n.title, body: n.body, link: n.link }, {
          type: 'RESELLER_REACTIVATED',
          title: 'Account reactivated',
          body: 'Your partner account is active again.',
          link: '/dashboard',
        })
      }
    })

    it('works with no body and records a null note', async () => {
      const res = await reactivate('rs-1')
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.equal(state.audit[0].metadata?.note, null)
    })

    it('restores the reseller’s access to the API but does not resurrect revoked sessions', async () => {
      assert.equal(await sellerProbe(), 'Partner account is suspended')
      await reactivate('rs-1')
      assert.equal(await sellerProbe(), 'Insufficient permissions', 'no longer blocked as suspended')
      assert.deepEqual(revokedIds(), ['t1', 't2', 't3'], 'they must sign in again')
    })

    it('puts the status change and the audit entry in one transaction, and notifies only after it commits', async () => {
      await reactivate('rs-1')
      assert.deepEqual(writes.map((w) => w.op), ['reseller.updateMany', 'auditLog.create', 'notification.createMany'])
      assert.equal(writes[0].txId, writes[1].txId)
      assert.notEqual(writes[0].txId, null)
      assert.equal(writes[2].txId, null, 'the notification is outside the transaction')
    })

    it('a failing audit write rolls the reactivation back: still SUSPENDED, no notification, and a retry works', async () => {
      failOnce.auditCreate = new Error('audit store unavailable')
      const before = fingerprint()
      const res = await reactivate('rs-1')
      assert.equal(res.status, 500)
      assert.equal(fingerprint(), before, 'suspension fields intact, nothing audited or notified')
      assert.equal(rs1().status, 'SUSPENDED')
      assert.equal(rs1().suspensionReason, 'Unpaid invoices')

      assert.equal((await reactivate('rs-1')).status, 200, 'retry is not stuck behind a 409')
      assert.equal(rs1().status, 'ACTIVE')
      assert.equal(state.audit.length, 1)
      assert.equal(state.audit[0].metadata?.previousSuspensionReason, 'Unpaid invoices')
      assert.equal(state.notices.length, 2)
    })

    it('a notification failure after the commit does not fail the request or undo the reactivation', async () => {
      const logged = mock.method(logger, 'error', () => undefined)
      failOnce.userFindMany = new Error('user lookup unavailable')
      const res = await reactivate('rs-1')
      logged.mock.restore()

      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.equal(rs1().status, 'ACTIVE')
      assert.equal(state.audit.length, 1, 'the audit entry is committed with the status change')
      assert.equal(state.notices.length, 0)
      assert.equal(logged.mock.callCount(), 1, 'the failure is logged, not silent')
      assert.match(String(logged.mock.calls[0].arguments[0]), /notification/i)
      assert.equal((logged.mock.calls[0].arguments[1] as Error).message, 'user lookup unavailable')
    })

    it('a failure while inserting the notification also leaves the reactivation intact', async () => {
      const noisy = mock.method(console, 'error', () => undefined) // notifyUsers logs this one itself
      failOnce.noticeCreate = new Error('notification insert failed')
      const res = await reactivate('rs-1')
      noisy.mock.restore()
      assert.equal(res.status, 200)
      assert.equal(rs1().status, 'ACTIVE')
      assert.equal(state.audit.length, 1)
    })

    it('rejects every non-SUSPENDED status with 409 and changes nothing', async () => {
      for (const status of ['ACTIVE', 'PENDING', 'REJECTED', 'TERMINATED'] as const) {
        addReseller(`rs-${status}`, status)
        const before = fingerprint()
        const res = await reactivate(`rs-${status}`)
        assert.equal(res.status, 409, status)
        assert.equal(res.json.message, `This action is not allowed while the partner is ${status}`)
        assert.equal(fingerprint(), before, `${status}: nothing written, nobody notified`)
      }
    })

    it('404s for an unknown reseller and writes nothing', async () => {
      const before = fingerprint()
      const res = await reactivate('does-not-exist')
      assert.equal(res.status, 404)
      assert.equal(fingerprint(), before)
    })

    it('rejects invalid input with 422 and malformed JSON with 400, changing nothing', async () => {
      const before = fingerprint()
      for (const [label, body] of [
        ['note over 500 characters', { note: 'x'.repeat(501) }],
        ['non-string note', { note: 5 }],
        ['unknown field', { note: 'ok', extra: true }],
      ] as Array<[string, unknown]>) {
        assert.equal((await reactivate('rs-1', body)).status, 422, label)
      }
      const malformed = await api.call('POST', '/admin/resellers/rs-1/reactivate', { token: tokenFor('u-admin'), rawBody: '{"note": ' })
      assert.equal(malformed.status, 400)
      assert.equal(fingerprint(), before)
    })

    it('needs resellers:manage: no token 401, a reseller user 403, and nothing changes', async () => {
      const before = fingerprint()
      assert.equal((await api.call('POST', '/admin/resellers/rs-1/reactivate', { body: {} })).status, 401)
      // a suspended reseller’s own user is stopped by authenticate itself
      const suspendedUser = await reactivate('rs-1', {}, tokenFor('u-seller-1'))
      assert.equal(suspendedUser.status, 403)
      assert.equal(suspendedUser.json.message, 'Partner account is suspended')
      assert.equal((await reactivate('rs-1', {}, tokenFor('u-seller-2'))).json.message, 'Insufficient permissions')
      assert.equal(fingerprint(), before)
    })

    it('two simultaneous reactivations: exactly one wins, is audited once and notifies once', async () => {
      const results = await Promise.all([reactivate('rs-1'), reactivate('rs-1')])
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
      assert.equal(state.audit.length, 1)
      assert.equal(state.notices.length, 2, 'one notification per active user, from the winning request only')
    })
  })

  it('a full cycle keeps the audit trail in order and the previous reason accurate', async () => {
    assert.equal((await suspend('rs-1', { reason: 'First suspension reason' })).status, 200)
    assert.equal((await reactivate('rs-1', { note: 'Cleared' })).status, 200)
    assert.equal((await suspend('rs-1', { reason: 'Second suspension reason' })).status, 200)
    assert.equal((await reactivate('rs-1')).status, 200)
    assert.deepEqual(state.audit.map((a) => a.action), ['RESELLER_SUSPENDED', 'RESELLER_REACTIVATED', 'RESELLER_SUSPENDED', 'RESELLER_REACTIVATED'])
    assert.equal(state.audit[1].metadata?.previousSuspensionReason, 'First suspension reason')
    assert.equal(state.audit[3].metadata?.previousSuspensionReason, 'Second suspension reason')
    assert.equal(rs1().status, 'ACTIVE')
  })
})
