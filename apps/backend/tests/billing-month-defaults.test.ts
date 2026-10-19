import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { jsx, mountPage } from './helpers/render-page'

/**
 * Billing-month defaults in the web app follow business time (Asia/Colombo), like the server, not the browser's clock.
 *  - `currentPeriod()` (used by the Commissions page, the Monthly report and the new activation form) equals `businessPeriod()`;
 *  - the Monthly report opens on, and requests, the Colombo month.
 * Each case runs with the clock mocked AND the process time zone set to a browser zone that disagrees with Colombo about the
 * month, so the test cannot pass just because the machine running it happens to be on Colombo time.
 * The new activation form cannot be mounted by the page harness (its form is a child component that uses hooks); its default
 * month and month list both come from `currentPeriod()`, which the helper test covers.
 *
 * Database-free: the real web helper and the real, unmodified MonthlyReport component run in Node against a stubbed API.
 * Nothing here reads `.env`, runs Prisma or opens a connection.
 */

const format = require('../../web/src/lib/format')
const MONTHLY_REPORT = path.resolve(__dirname, '../../web/src/components/commissions/MonthlyReport.tsx')

// Colombo is UTC+5:30 all year (no daylight saving).
/** 00:30 on 1 Oct in Colombo. A browser in New York (UTC-4) is still on 30 Sep, 15:00. */
const COLOMBO_NEW_MONTH = new Date('2026-09-30T19:00:00Z')
/** 22:30 on 30 Sep in Colombo. A browser in Auckland (UTC+13 in NZDT) is already on 1 Oct, 06:00. */
const COLOMBO_STILL_OLD_MONTH = new Date('2026-09-30T17:00:00Z')

const BEHIND = 'America/New_York'
const AHEAD = 'Pacific/Auckland'

/** Runs `run` with the clock fixed at `now` and the browser (process) time zone set to `timeZone`, then restores both. */
async function atBrowserTime<T>(now: Date, timeZone: string, localMonth: number, run: () => T | Promise<T>): Promise<T> {
  const previous = process.env.TZ
  process.env.TZ = timeZone
  mock.timers.enable({ apis: ['Date'], now })
  try {
    // If the zone could not be switched, the cases below would prove nothing: fail loudly instead.
    assert.equal(new Date().getMonth() + 1, localMonth, `the browser month in ${timeZone} should be ${localMonth} at ${now.toISOString()}`)
    return await run()
  } finally {
    mock.timers.reset()
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
}

describe('currentPeriod()', () => {
  it('is the Colombo month from 00:00 on the 1st, while a browser behind Colombo is still in the old month', async () => {
    await atBrowserTime(COLOMBO_NEW_MONTH, BEHIND, 9, () => {
      assert.equal(format.currentPeriod(), '2026-10')
      assert.equal(format.currentPeriod(), format.businessPeriod())
    })
  })

  it('is still the old month until the Colombo month ends, while a browser ahead of Colombo is already in the new one', async () => {
    await atBrowserTime(COLOMBO_STILL_OLD_MONTH, AHEAD, 10, () => {
      assert.equal(format.currentPeriod(), '2026-09')
      assert.equal(format.currentPeriod(), format.businessPeriod())
    })
  })
})

describe('Monthly report: default month', () => {
  class ApiError extends Error {}

  const open = async (props: object = {}) => {
    const requests: string[] = []
    const page = mountPage(
      MONTHLY_REPORT,
      {
        'next/link': { __esModule: true, default: ({ href, children }: { href: string; children: unknown }) => jsx('a', { href, children }) },
        '@/lib/format': format,
        '@/lib/api': {
          ApiError,
          api: async (url: string) => {
            requests.push(url)
            const month = new URLSearchParams(url.split('?')[1]).get('month')
            const zero = { net: '0', pending: '0', approved: '0', payable: '0', paid: '0', reversed: '0' }
            return { month, rows: [], totals: zero }
          },
        },
      },
      { exportName: 'MonthlyReport', props },
    )
    await page.settle()
    return { page, requests }
  }
  const queryOf = (url: string) => new URLSearchParams(url.split('?')[1])

  it('asks for, and shows, the Colombo month when the browser is still in the old one', async () => {
    await atBrowserTime(COLOMBO_NEW_MONTH, BEHIND, 9, async () => {
      const { page, requests } = await open()
      assert.equal(requests.length, 1)
      assert.equal(queryOf(requests[0]).get('month'), '2026-10')
      assert.equal(page.valueOf('report-month'), '2026-10')
      assert.ok(page.text().includes('Oct 2026'))
    })
  })

  it('keeps the old month until Colombo rolls over, even when the browser is already in the new one, and still scopes a reseller\'s report', async () => {
    await atBrowserTime(COLOMBO_STILL_OLD_MONTH, AHEAD, 10, async () => {
      const { page, requests } = await open({ resellerId: 'r1' })
      const query = queryOf(requests[0])
      assert.equal(query.get('month'), '2026-09')
      assert.equal(query.get('resellerId'), 'r1')
      assert.equal(page.valueOf('report-month'), '2026-09')
    })
  })

  it('lets the admin pick another month, which is then requested instead of the default', async () => {
    await atBrowserTime(COLOMBO_NEW_MONTH, BEHIND, 9, async () => {
      const { page, requests } = await open()
      await page.fill('report-month', '2026-07')
      assert.equal(requests.length, 2)
      assert.equal(queryOf(requests[1]).get('month'), '2026-07')
      assert.equal(page.valueOf('report-month'), '2026-07')
    })
  })
})
