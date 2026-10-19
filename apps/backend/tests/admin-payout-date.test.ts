import { after, afterEach, before, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { installHermeticBackend, strictFake } from './helpers/hermetic-backend'

/**
 * Payout "paid on" date: today (business time, Asia/Colombo) or earlier, never a future day.
 * The clock is fixed in each test, so the cases that only occur at certain hours are reproduced exactly:
 * between 18:30 and 24:00 UTC the business date is already the next day, so a date typed as "today" by an admin in
 * Sri Lanka is ahead of the UTC date and must still be accepted.
 *
 * Database-free (see tests/helpers/hermetic-backend.ts): only the validation schema and the date helper run. Nothing here
 * reads `.env`, runs Prisma or opens a connection.
 */

let createPayoutSchema: typeof import('../src/modules/commissions/commission.schema')['createPayoutSchema']
let businessDateOf: typeof import('../src/utils/period')['businessDateOf']

const at = (iso: string) => mock.timers.enable({ apis: ['Date'], now: new Date(iso) })
const check = (paidAt: unknown) => createPayoutSchema.safeParse({ resellerId: 'r1', paymentReference: 'TX-1', paidAt })
const messages = (paidAt: unknown) => {
  const r = check(paidAt)
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
}
const accepted = (paidAt: unknown) => {
  const r = check(paidAt)
  assert.equal(r.success, true, `${JSON.stringify(paidAt)} should be accepted: ${r.success ? '' : JSON.stringify(r.error.issues)}`)
  return r.success ? (r.data.paidAt as Date) : undefined
}
const FUTURE = 'paidAt: Payment date cannot be in the future'

describe('business date', () => {
  before(() => {
    installHermeticBackend(strictFake('prisma', {}))
  })
  before(async () => {
    ;({ createPayoutSchema } = await import('../src/modules/commissions/commission.schema'))
    ;({ businessDateOf } = await import('../src/utils/period'))
  })
  afterEach(() => mock.timers.reset())
  after(() => mock.timers.reset())

  it('is the Asia/Colombo calendar day, which runs ahead of UTC from 18:30 to midnight', () => {
    assert.equal(businessDateOf(new Date('2026-10-14T18:29:59Z')), '2026-10-14')
    assert.equal(businessDateOf(new Date('2026-10-14T18:30:00Z')), '2026-10-15')
    assert.equal(businessDateOf(new Date('2026-10-14T23:59:59Z')), '2026-10-15')
    assert.equal(businessDateOf(new Date('2026-10-15T00:00:00Z')), '2026-10-15')
    assert.equal(businessDateOf(new Date('2026-12-31T20:00:00Z')), '2027-01-01', 'across a year end')
  })

  describe('payout paidAt', () => {
    it('accepts the business-time "today" even when the UTC date is still the day before', () => {
      at('2026-10-14T20:00:00Z') // 01:30 on 15 October in Colombo, 14 October in UTC
      assert.equal(accepted('2026-10-15')?.toISOString(), '2026-10-15T00:00:00.000Z')
      accepted('2026-10-14')
      accepted('2026-01-01')
    })

    it('refuses the day after the business-time today, with the same message in every form', () => {
      at('2026-10-14T20:00:00Z')
      for (const paidAt of ['2026-10-16', '2027-01-01', '2026-10-15T19:00:00Z', new Date('2026-10-16T01:00:00Z').getTime()]) {
        assert.deepEqual(messages(paidAt), [FUTURE], String(paidAt))
      }
    })

    it('moves to the next day exactly at midnight in Colombo', () => {
      at('2026-10-15T18:29:59Z') // 23:59:59 on 15 October in Colombo
      assert.deepEqual(messages('2026-10-16'), [FUTURE])
      accepted('2026-10-15')
      mock.timers.reset()
      at('2026-10-15T18:30:00Z') // 00:00:00 on 16 October in Colombo
      accepted('2026-10-16')
      assert.deepEqual(messages('2026-10-17'), [FUTURE])
    })

    it('judges a timestamp by its Colombo day: later today is fine, tomorrow is not', () => {
      at('2026-10-15T03:00:00Z') // 08:30 on 15 October in Colombo
      accepted('2026-10-15T09:00:00+05:30') // later the same day
      accepted('2026-10-14T19:00:00Z') // 00:30 on 15 October in Colombo
      assert.deepEqual(messages('2026-10-15T19:00:00Z'), [FUTURE]) // 00:30 on 16 October in Colombo
    })

    it('trims a typed date, and keeps its calendar day', () => {
      at('2026-10-15T03:00:00Z')
      assert.equal(accepted('  2026-10-10  ')?.toISOString(), '2026-10-10T00:00:00.000Z')
    })

    it('says what is wrong with a date that does not exist or cannot be read', () => {
      at('2026-10-15T03:00:00Z')
      const unreadable = 'paidAt: Enter a valid payment date (YYYY-MM-DD)'
      for (const paidAt of ['2026-02-31', '2026-04-31', '2026-13-01', '2026-00-01', 'yesterday', '15/10/2026', true, null, {}, []]) {
        assert.deepEqual(messages(paidAt), [unreadable], JSON.stringify(paidAt))
      }
      for (const paidAt of ['', '   ']) assert.deepEqual(messages(paidAt), ['paidAt: Enter the payment date (YYYY-MM-DD)'])
      accepted('2024-02-29') // a real leap day
      assert.deepEqual(messages('2025-02-29'), [unreadable]) // not a leap year
    })
  })
})
