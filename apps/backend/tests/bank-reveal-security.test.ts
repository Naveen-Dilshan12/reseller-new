import { after, before, beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import nodeCrypto from 'node:crypto'
import { installHermeticBackend, serve } from './helpers/hermetic-backend'
import { ACCOUNT_NUMBER, LAST4, OTHER_ACCOUNT_NUMBER, createApplicationsFake } from './helpers/applications-fake'

/**
 * Reseller bank-account reveal, through the real Express `app` (helmet, CORS, global limiter, the API-wide
 * no-store header, auth, permissions, controller, service, crypto and audit code).
 *
 * Database-free (see tests/helpers/hermetic-backend.ts): nothing here reads `.env`, runs Prisma or opens a
 * connection. The account number is encrypted and decrypted with the real AES-256-GCM code and a throwaway key.
 * The stand-in records an ordered trail of events, so "audit first, then decrypt" is observed, not assumed:
 * the audit insert reports 'audit' and a spy on `crypto.createDecipheriv` reports 'decrypt'.
 *
 * The reveal endpoint is not described in any project doc; these tests pin the behaviour of the code as it is.
 */

const fake = createApplicationsFake()
const { state } = fake

describe('Bank-account reveal', () => {
  let api: Awaited<ReturnType<typeof serve>>
  let signAccessToken: typeof import('../src/utils/jwt')['signAccessToken']
  const tokens: Record<string, string> = {}
  let encryptedRs1 = ''

  const REVEAL = (id: string, prefix = '/admin/reseller-applications') => `/api/v1${prefix}/${id}/bank-account/reveal`
  const reveal = (id: string, token?: string, prefix?: string) => api.call('POST', REVEAL(id, prefix), { token })
  const profile = (id: string, token = tokens.admin) => api.call('GET', `/api/v1/admin/reseller-applications/${id}`, { token })
  const noSecrets = (value: unknown, label: string) => {
    const text = JSON.stringify(value)
    assert.equal(text.includes(ACCOUNT_NUMBER), false, `${label}: plaintext account number leaked`)
    assert.equal(text.includes(OTHER_ACCOUNT_NUMBER), false, `${label}: another account number leaked`)
    assert.equal(text.includes(encryptedRs1), false, `${label}: encrypted account number leaked`)
    assert.equal(/accountNumberEncrypted/.test(text), false, `${label}: encrypted field leaked`)
  }
  const revealRows = () => state.audit.filter((a) => a.action === 'RESELLER_BANK_ACCOUNT_REVEALED')

  before(async () => {
    installHermeticBackend(fake.fakePrisma)
    ;({ signAccessToken } = await import('../src/utils/jwt'))
    const { encryptAccountNumber } = await import('../src/modules/resellers/bank-account.util')
    fake.seed(encryptAccountNumber)
    encryptedRs1 = state.resellers.get('rs-1')!.bankAccount.accountNumberEncrypted
    const { default: app } = await import('../src/app')

    // Record every real decryption, then run it.
    const realCreateDecipheriv = nodeCrypto.createDecipheriv
    mock.method(nodeCrypto, 'createDecipheriv', function (this: unknown, ...args: unknown[]) {
      state.events.push('decrypt')
      return (realCreateDecipheriv as (...a: unknown[]) => unknown).apply(this, args)
    })

    for (const [name, id] of [['admin', 'u-admin'], ['seller1', 'u-seller-1'], ['seller2', 'u-seller-2']] as const) {
      const u = state.users.get(id)!
      tokens[name] = signAccessToken({ userId: u.id, email: u.email, role: u.role, resellerId: u.resellerId })
    }
    api = await serve(app)
  })
  after(async () => {
    mock.restoreAll()
    await api?.close()
  })
  beforeEach(() => {
    state.audit.length = 0
    state.events.length = 0
    state.failAudit = undefined
    state.resellers.get('rs-1')!.bankAccount.accountNumberEncrypted = encryptedRs1
  })

  describe('who may reveal', () => {
    it('refuses a request with no token (401) and does nothing', async () => {
      const res = await reveal('rs-1')
      assert.equal(res.status, 401)
      assert.deepEqual(state.events, [])
      noSecrets(res.json, '401')
    })

    it('refuses a bad token (401)', async () => {
      assert.equal((await reveal('rs-1', 'not.a.jwt')).status, 401)
      assert.deepEqual(state.events, [])
    })

    it('refuses an approved reseller user (403), even for their own bank account, on both route prefixes', async () => {
      for (const [who, id] of [['seller1', 'rs-1'], ['seller2', 'rs-1'], ['seller1', 'rs-2']] as const) {
        for (const prefix of ['/admin/reseller-applications', '/reseller-applications']) {
          const res = await reveal(id, tokens[who], prefix)
          assert.equal(res.status, 403, `${who} → ${id} via ${prefix}`)
          assert.equal(res.json.message, 'Insufficient permissions')
          noSecrets(res.json, '403')
        }
      }
      assert.deepEqual(state.events, [], 'no audit entry and no decryption for refused callers')
    })

    it('does not offer the reveal over GET', async () => {
      const res = await api.call('GET', REVEAL('rs-1'), { token: tokens.admin })
      assert.equal(res.status, 404)
      assert.deepEqual(state.events, [])
      noSecrets(res.json, 'GET')
    })
  })

  describe('revealing', () => {
    it('gives an authorised admin the correct plaintext number, and only that', async () => {
      const res = await reveal('rs-1', tokens.admin)
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.equal(res.json.success, true)
      assert.deepEqual(res.json.data, { accountNumber: ACCOUNT_NUMBER })
    })

    it('returns the number of the reseller that was asked for', async () => {
      assert.equal((await reveal('rs-2', tokens.admin)).json.data.accountNumber, OTHER_ACCOUNT_NUMBER)
      assert.equal((await reveal('rs-1', tokens.admin)).json.data.accountNumber, ACCOUNT_NUMBER)
    })

    it('works on the non-/admin alias route for an admin too', async () => {
      const res = await reveal('rs-1', tokens.admin, '/reseller-applications')
      assert.equal(res.status, 200)
      assert.equal(res.json.data.accountNumber, ACCOUNT_NUMBER)
    })
  })

  describe('when there is nothing to reveal', () => {
    it('answers 404 "Bank account not found" for a reseller without a bank account, with no audit entry', async () => {
      const res = await reveal('rs-nobank', tokens.admin)
      assert.equal(res.status, 404)
      assert.equal(res.json.success, false)
      assert.equal(res.json.message, 'Bank account not found')
      assert.deepEqual(state.events, [])
    })

    it('answers 404 for an unknown reseller', async () => {
      const res = await reveal('nope', tokens.admin)
      assert.equal(res.status, 404)
      assert.equal(res.json.message, 'Partner application not found')
      assert.deepEqual(state.events, [])
    })
  })

  describe('audit trail', () => {
    it('writes the audit entry before the number is decrypted', async () => {
      await reveal('rs-1', tokens.admin)
      assert.deepEqual(state.events, ['audit', 'decrypt'])
    })

    it('records who revealed which bank account, with no metadata', async () => {
      await reveal('rs-1', tokens.admin)
      assert.equal(revealRows().length, 1)
      const [row] = revealRows()
      assert.equal(row.actorType, 'USER')
      assert.equal(row.actorUserId, 'u-admin')
      assert.equal(row.actorEmail, 'u-admin@test.invalid')
      assert.equal(row.entityType, 'ResellerBankAccount')
      assert.equal(row.entityId, 'ba-1')
      assert.equal(row.resellerId, 'rs-1')
      assert.equal(row.metadata, undefined)
    })

    it('writes one entry per reveal', async () => {
      await reveal('rs-1', tokens.admin)
      await reveal('rs-1', tokens.admin)
      assert.equal(revealRows().length, 2)
    })

    it('never puts the account number, in any form, in an audit entry', async () => {
      await profile('rs-1')
      await reveal('rs-1', tokens.admin)
      await reveal('rs-2', tokens.admin)
      assert.ok(state.audit.length >= 3)
      for (const row of state.audit) noSecrets(row, `audit ${row.action}`)
    })

    it('blocks the reveal when the audit entry cannot be written: 500, no decryption, nothing disclosed', async () => {
      state.failAudit = new Error('audit store unavailable')
      const res = await reveal('rs-1', tokens.admin)
      assert.equal(res.status, 500)
      assert.deepEqual(state.events, ['audit'], 'the attempt to audit happened and nothing was decrypted')
      assert.equal(revealRows().length, 0)
      noSecrets(res.json, 'audit failure')
    })

    it('works again once the audit store is back', async () => {
      state.failAudit = new Error('audit store unavailable')
      await reveal('rs-1', tokens.admin)
      const retry = await reveal('rs-1', tokens.admin)
      assert.equal(retry.status, 200)
      assert.equal(revealRows().length, 1)
    })

    it('if decryption itself fails the attempt stays audited, and the error discloses nothing', async () => {
      const [iv, tag] = encryptedRs1.split('.')
      state.resellers.get('rs-1')!.bankAccount.accountNumberEncrypted = [iv, tag, Buffer.from('tampered').toString('base64')].join('.')
      const res = await reveal('rs-1', tokens.admin)
      assert.equal(res.status, 500)
      assert.equal(res.json.message, 'Internal server error')
      assert.deepEqual(state.events, ['audit', 'decrypt'])
      assert.equal(revealRows().length, 1)
      noSecrets(res.json, 'decrypt failure')
      assert.equal(JSON.stringify(res.json).includes('tampered'), false)
    })
  })

  describe('application profile (GET)', () => {
    it('shows the bank details masked and never the plaintext or the encrypted value', async () => {
      const res = await profile('rs-1')
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.deepEqual(res.json.data.bank, {
        bankName: 'Test Bank',
        branch: 'Colombo',
        accountHolderName: 'Nimal Perera',
        accountNumberMasked: `•••• •••• ${LAST4}`,
        accountNumberLast4: LAST4,
      })
      noSecrets(res.json, 'profile')
    })

    it('stays masked after the number has been revealed', async () => {
      await reveal('rs-1', tokens.admin)
      noSecrets((await profile('rs-1')).json, 'profile after reveal')
    })

    it('reports no bank details as null', async () => {
      assert.equal((await profile('rs-nobank')).json.data.bank, null)
    })

    it('is not readable by a reseller user', async () => {
      const res = await profile('rs-1', tokens.seller1)
      assert.equal(res.status, 403)
      noSecrets(res.json, 'profile 403')
    })

    it('a profile view is audited without any account data', async () => {
      await profile('rs-1')
      const view = state.audit.find((a) => a.action === 'RESELLER_APPLICATION_VIEWED')
      assert.ok(view)
      noSecrets(view, 'view audit')
      assert.deepEqual(state.events, ['audit'], 'viewing never decrypts')
    })
  })

  describe('Cache-Control', () => {
    it('is no-store on the reveal response, on the profile, and on every refusal and failure', async () => {
      const cases: Array<[string, Awaited<ReturnType<typeof reveal>>]> = [
        ['200 reveal', await reveal('rs-1', tokens.admin)],
        ['200 profile', await profile('rs-1')],
        ['401', await reveal('rs-1')],
        ['403', await reveal('rs-1', tokens.seller1)],
        ['404', await reveal('rs-nobank', tokens.admin)],
      ]
      state.failAudit = new Error('audit store unavailable')
      cases.push(['500', await reveal('rs-1', tokens.admin)])
      for (const [label, res] of cases) assert.equal(res.headers.get('cache-control'), 'no-store', label)
      assert.deepEqual(cases.map(([, r]) => r.status), [200, 200, 401, 403, 404, 500])
    })
  })
})
