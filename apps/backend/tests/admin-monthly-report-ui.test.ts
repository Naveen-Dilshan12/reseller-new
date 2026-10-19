import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { jsx, mountPage } from './helpers/render-page'

/**
 * The monthly commission report component (Admin → Commissions → Monthly report, also the "Monthly report" tab of a reseller's
 * own commissions and of an admin's per-reseller view).
 *  - "Loading…" while a month loads; a failed load shows the error with Retry instead of "Loading…" forever;
 *  - figures are never shown under a month they do not belong to: switching month clears the old report, and an answer for a
 *    month the admin has already moved away from is ignored;
 *  - the per-reseller table shows an Approved column so its columns add up to the Net;
 *  - rows link to the reseller's commissions only on the admin report.
 *
 * The real, unmodified component runs in Node through tests/helpers/render-page.ts against scripted API stubs.
 * Database-free; nothing here reads `.env`, runs Prisma or opens a connection.
 */

const COMPONENT = path.resolve(__dirname, '../../web/src/components/commissions/MonthlyReport.tsx')
const format = require('../../web/src/lib/format')

class ApiError extends Error {
  constructor(message: string, public status = 0, public code?: string, public errors: string[] = []) {
    super(message)
  }
}
const deferred = <T>() => {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

type Row = Record<string, any>
type Step = () => Promise<unknown>
const ok = (value: unknown): Step => async () => structuredClone(value)
const fail = (error: unknown): Step => async () => {
  throw error
}

const totals = (over: Row = {}) => ({ net: '0', pending: '0', approved: '0', payable: '0', paid: '0', reversed: '0', ...over })
const resellerRow = (code: string, over: Row = {}): Row => ({
  reseller: { id: `id-${code}`, code, businessName: `Trader ${code}`, currentLevel: 2, activeCustomerCount: 5 },
  paidCustomers: 2,
  totals: totals({ pending: '100', approved: '250', payable: '300', paid: '400', reversed: '50', net: '1050' }),
  ...over,
})
const allResellers = (month: string, codes: string[]) => ({ month, rows: codes.map((c) => resellerRow(c)), totals: totals({ net: '1050' }) })
const entry = (id: string, customer: string, amount: string, over: Row = {}): Row => ({
  id,
  entryType: 'EARNING',
  level: 2,
  rate: '10',
  amount,
  currency: 'LKR',
  status: 'PENDING',
  customerAccount: { customer: { displayName: customer } },
  product: { name: 'Hexalyte Salon' },
  ...over,
})

describe('Monthly commission report component', () => {
  let calls: URLSearchParams[]
  let script: Step[]
  const DEFAULT = format.businessPeriod()

  const open = async (props: Row = { adminLinks: true }) => {
    const page = mountPage(
      COMPONENT,
      {
        'next/link': { __esModule: true, default: ({ href, children }: { href: string; children: unknown }) => jsx('a', { href, children }) },
        '@/lib/format': format,
        '@/lib/api': {
          ApiError,
          api: async (url: string) => {
            calls.push(new URLSearchParams(url.split('?')[1]))
            const next = script.shift()
            if (!next) throw new Error(`unexpected extra request: ${url}`)
            return next()
          },
        },
      },
      { exportName: 'MonthlyReport', props },
    )
    await page.settle()
    return page
  }
  const alerts = (page: Awaited<ReturnType<typeof open>>) => page.textOfClass('alert').map((t) => t.replace(/\s+/g, ' ').trim())
  const months = () => calls.map((q) => q.get('month'))

  beforeEach(() => {
    calls = []
    script = []
  })

  describe('baseline', () => {
    it('shows one row per reseller with its figures, linking to the reseller\'s commissions on the admin report', async () => {
      script = [ok(allResellers(DEFAULT, ['RS-1', 'RS-2']))]
      const page = await open()
      assert.deepEqual(months(), [DEFAULT])
      assert.equal(calls[0].get('resellerId'), null)
      const text = page.text()
      assert.ok(text.includes('Trader RS-1') && text.includes('Trader RS-2'))
      assert.ok(text.includes('L2'))
      assert.deepEqual(page.links().map((l) => l.href), ['/admin/resellers/id-RS-1/commissions', '/admin/resellers/id-RS-2/commissions'])
    })

    it('has an Approved column next to the totals card, so Pending + Approved + Payable + Paid adds up to the Net', async () => {
      script = [ok(allResellers(DEFAULT, ['RS-1']))]
      const page = await open()
      const text = page.text()
      assert.equal((text.match(/Approved/g) ?? []).length, 2, 'once in the totals cards and once as a table column')
      assert.ok(text.includes('Rs. 250.00'), 'the row shows its approved amount')
    })

    it('does not link resellers to the admin pages when it is not the admin report', async () => {
      script = [ok(allResellers(DEFAULT, ['RS-1']))]
      const page = await open({})
      assert.deepEqual(page.links(), [])
      assert.ok(page.text().includes('Trader RS-1'))
    })

    it('shows one reseller\'s entries, with a clawback as a negative amount, when given a resellerId', async () => {
      script = [
        ok({
          month: DEFAULT,
          resellerId: 'r1',
          entries: [entry('e1', 'Nimal Stores', '550'), entry('e2', 'Kamal Mobile', '-550', { entryType: 'CLAWBACK', status: 'PAYABLE' })],
          totals: totals({ net: '0' }),
        }),
      ]
      const page = await open({ resellerId: 'r1' })
      assert.equal(calls[0].get('resellerId'), 'r1')
      const text = page.text()
      assert.ok(text.includes('Nimal Stores') && text.includes('Kamal Mobile'))
      assert.ok(text.includes('Clawback') && text.includes('Monthly commission'))
    })

    it('says so when a month has no commissions', async () => {
      script = [ok({ month: DEFAULT, rows: [], totals: totals() })]
      const page = await open()
      assert.ok(page.text().includes('No commissions for this month.'))
    })
  })

  describe('loading and failing', () => {
    it('shows "Loading…" while the first request is in flight', async () => {
      const pending = deferred<unknown>()
      script = [() => pending.promise]
      const page = await open()
      assert.ok(page.text().includes('Loading…'))
      assert.ok(!page.text().includes('No commissions'))
      pending.resolve(allResellers(DEFAULT, ['RS-1']))
      await page.settle()
      assert.ok(page.text().includes('Trader RS-1'))
      assert.ok(!page.text().includes('Loading…'))
    })

    it('a failed load shows the error with Retry, not "Loading…" forever, and Retry recovers', async () => {
      script = [fail(new ApiError('Service unavailable', 503)), ok(allResellers(DEFAULT, ['RS-1']))]
      const page = await open()
      assert.deepEqual(alerts(page), ['Service unavailable Retry'])
      assert.ok(!page.text().includes('Loading…'))
      assert.ok(!page.text().includes('No commissions'))

      await page.click('Retry')
      assert.deepEqual(months(), [DEFAULT, DEFAULT])
      assert.deepEqual(alerts(page), [])
      assert.ok(page.text().includes('Trader RS-1'))
    })

    it('a non-ApiError failure still gets a readable message', async () => {
      script = [fail(new TypeError('Failed to fetch'))]
      const page = await open()
      assert.deepEqual(alerts(page), ['Failed to load report Retry'])
    })
  })

  describe('month selection', () => {
    it('never shows one month\'s figures under another month: switching clears the report while the new one loads', async () => {
      const next = deferred<unknown>()
      script = [ok(allResellers(DEFAULT, ['RS-OLD'])), () => next.promise]
      const page = await open()
      assert.ok(page.text().includes('Trader RS-OLD'))

      await page.fill('report-month', '2026-07')
      assert.equal(page.valueOf('report-month'), '2026-07')
      assert.ok(page.text().includes('Loading…'))
      assert.ok(!page.text().includes('Trader RS-OLD'), 'the previous month\'s figures are gone')

      next.resolve(allResellers('2026-07', ['RS-NEW']))
      await page.settle()
      assert.ok(page.text().includes('Trader RS-NEW'))
      assert.deepEqual(months(), [DEFAULT, '2026-07'])
    })

    it('a failed switch shows the error and Retry for the new month, not the old month\'s figures', async () => {
      script = [ok(allResellers(DEFAULT, ['RS-OLD'])), fail(new ApiError('Gateway timeout', 504)), ok(allResellers('2026-07', ['RS-NEW']))]
      const page = await open()
      await page.fill('report-month', '2026-07')
      assert.deepEqual(alerts(page), ['Gateway timeout Retry'])
      assert.ok(!page.text().includes('Trader RS-OLD'))

      await page.click('Retry')
      assert.equal(calls[2].get('month'), '2026-07', 'Retry repeats the month on screen')
      assert.ok(page.text().includes('Trader RS-NEW'))
    })

    it('ignores a late answer for a month the admin has already moved away from', async () => {
      const slow = deferred<unknown>()
      const fast = deferred<unknown>()
      script = [ok(allResellers(DEFAULT, ['RS-OLD'])), () => slow.promise, () => fast.promise]
      const page = await open()
      await page.fill('report-month', '2026-06')
      await page.fill('report-month', '2026-05')

      fast.resolve(allResellers('2026-05', ['RS-MAY']))
      await page.settle()
      slow.resolve(allResellers('2026-06', ['RS-JUNE']))
      await page.settle()
      assert.ok(page.text().includes('Trader RS-MAY'))
      assert.ok(!page.text().includes('Trader RS-JUNE'), 'the June answer arrived after May was chosen')
      assert.equal(page.valueOf('report-month'), '2026-05')
    })

    it('a late failure for an earlier month does not replace the report on screen', async () => {
      const slow = deferred<unknown>()
      script = [ok(allResellers(DEFAULT, ['RS-OLD'])), () => slow.promise, ok(allResellers('2026-05', ['RS-MAY']))]
      const page = await open()
      await page.fill('report-month', '2026-06')
      await page.fill('report-month', '2026-05')
      slow.reject(new ApiError('late failure', 500))
      await page.settle()
      assert.deepEqual(alerts(page), [])
      assert.ok(page.text().includes('Trader RS-MAY'))
    })

    it('ignores an emptied month field', async () => {
      script = [ok(allResellers(DEFAULT, ['RS-1']))]
      const page = await open()
      await page.fill('report-month', '')
      assert.equal(calls.length, 1)
      assert.equal(page.valueOf('report-month'), DEFAULT)
      assert.ok(page.text().includes('Trader RS-1'))
    })
  })
})
