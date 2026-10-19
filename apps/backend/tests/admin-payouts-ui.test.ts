import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { jsx, mountPage } from './helpers/render-page'

/**
 * Admin → Commissions → Payouts, and the "Record commission payout" dialog.
 *  - the payouts list (all partners, or one): "Loading…" first, the Partner column only when asked, a failed load shows its
 *    error with Retry (never "No payouts yet"), more than one page can be paged through, and a page that no longer exists
 *    moves to the last real page;
 *  - the dialog: the date starts on today (business time), the picker stops there, a future or empty date is refused before
 *    anything is sent, and the server's own message is shown instead of "Validation error".
 *
 * The real, unmodified component and page run in Node through tests/helpers/render-page.ts against scripted API stubs.
 * Database-free; nothing here reads `.env`, runs Prisma or opens a connection. There is no browser, so how the page looks
 * is not checked here.
 */

const WEB = path.resolve(__dirname, '../../web/src')
const HISTORY = path.join(WEB, 'components/commissions/PayoutHistory.tsx')
const PAYER = path.join(WEB, 'app/admin/resellers/[id]/commissions/page.tsx')
const format = require('../../web/src/lib/format')
const pagedList = require('../../web/src/lib/paged-list')

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
const squash = (s: string) => s.replace(/\s+/g, ' ')

describe('Payouts list', () => {
  let calls: URLSearchParams[]
  let script: Step[]

  const payout = (id: string, over: Row = {}): Row => ({
    id,
    totalAmount: '1250',
    currency: 'LKR',
    paymentReference: `TX-${id}`,
    paidAt: '2026-09-20T00:00:00.000Z',
    note: null,
    reseller: { code: 'RS-1', businessName: 'Kandy Traders' },
    _count: { commissions: 3 },
    ...over,
  })
  const list = (items: Row[], meta: Row = {}): Row => ({ data: items, meta: { total: items.length, page: 1, limit: 50, totalPages: 1, ...meta } })

  const open = async (props: Row = {}) => {
    const page = mountPage(
      HISTORY,
      {
        '@/lib/api': {
          ApiError,
          apiRequest: async (url: string) => {
            calls.push(new URLSearchParams(url.split('?')[1]))
            const next = script.shift()
            if (!next) throw new Error(`unexpected extra request: ${url}`)
            return next()
          },
        },
        '@/lib/format': format,
        '@/lib/paged-list': pagedList,
      },
      { exportName: 'PayoutHistory', props },
    )
    await page.settle()
    return page
  }
  const text = (page: Awaited<ReturnType<typeof open>>) => squash(page.text())
  const last = () => calls[calls.length - 1]

  beforeEach(() => {
    calls = []
    script = []
  })

  it('shows "Loading…" until the answer, then the payouts, with the Partner column only when asked for', async () => {
    const pending = deferred<unknown>()
    script = [() => pending.promise, ok(list([payout('p1', { note: 'September' })]))]
    const all = mountPage(HISTORY, { '@/lib/api': { ApiError, apiRequest: async (url: string) => (calls.push(new URLSearchParams(url.split('?')[1])), script.shift()!()) }, '@/lib/format': format, '@/lib/paged-list': pagedList }, { exportName: 'PayoutHistory', props: { showReseller: true } })
    assert.ok(squash(all.text()).includes('Loading…'))
    assert.ok(!squash(all.text()).includes('No payouts yet'))
    pending.resolve(list([payout('p1', { note: 'September' })]))
    await all.settle()
    const t = squash(all.text())
    assert.ok(t.includes('Kandy Traders') && t.includes('RS-1') && t.includes('TX-p1') && t.includes('Rs. 1,250.00') && t.includes('September'))
    assert.ok(t.includes('Partner'))

    const one = await open()
    assert.ok(!text(one).includes('Kandy Traders'), 'no Partner column on a single reseller\'s own list')
    assert.ok(text(one).includes('TX-p1'))
  })

  it('asks for page 1 of 50, for all partners unless one is given', async () => {
    script = [ok(list([])), ok(list([]))]
    await open({ showReseller: true })
    assert.deepEqual(Object.fromEntries(last()), { page: '1', limit: '50' })
    await open({ resellerId: 'r9' })
    assert.deepEqual(Object.fromEntries(last()), { page: '1', limit: '50', resellerId: 'r9' })
  })

  it('says "No payouts yet." only when there really are none', async () => {
    script = [ok(list([]))]
    const page = await open({ showReseller: true })
    assert.ok(text(page).includes('No payouts yet.'))
    assert.ok(!text(page).includes('Loading…'))
  })

  it('a failed load shows the error with Retry, not "No payouts yet" or "Loading…"; Retry loads it', async () => {
    const second = deferred<unknown>()
    script = [fail(new ApiError('Failed to load payouts', 500)), () => second.promise]
    const page = await open({ showReseller: true })
    assert.deepEqual(page.textOfClass('alert').map(squash), ['Failed to load payouts'])
    assert.ok(!text(page).includes('No payouts yet') && !text(page).includes('Loading…'))
    const retry = page.click('Retry')
    await page.settle()
    assert.ok(text(page).includes('Loading…'), 'while it retries')
    assert.deepEqual(page.textOfClass('alert'), [])
    second.resolve(list([payout('p1')]))
    await retry
    assert.ok(text(page).includes('TX-p1'))
    assert.equal(calls.length, 2)
  })

  it('shows a plain message when the failure did not come from the server', async () => {
    script = [fail(new Error('network down'))]
    const page = await open()
    assert.deepEqual(page.textOfClass('alert').map(squash), ['Failed to load payouts'])
  })

  it('pages through more than one page, and the pager is hidden when there is only one', async () => {
    script = [ok(list([payout('p1')])), ok(list([payout('p1')], { total: 70, totalPages: 2 })), ok(list([payout('p2')], { total: 70, page: 2, totalPages: 2 })), ok(list([payout('p1')], { total: 70, totalPages: 2 }))]
    const single = await open()
    assert.ok(!single.hasButton('Next'))

    const page = await open()
    assert.ok(text(page).includes('1 / 2'))
    assert.equal(page.isDisabled('Previous'), true)
    await page.click('Next')
    assert.equal(last().get('page'), '2')
    assert.ok(text(page).includes('TX-p2') && text(page).includes('2 / 2'))
    assert.equal(page.isDisabled('Next'), true)
    await page.click('Previous')
    assert.equal(last().get('page'), '1')
    assert.ok(text(page).includes('TX-p1'))
  })

  it('does not keep showing the previous page when the next one fails', async () => {
    script = [ok(list([payout('p1')], { total: 70, totalPages: 2 })), fail(new ApiError('Failed to load payouts', 500))]
    const page = await open()
    await page.click('Next')
    assert.deepEqual(page.textOfClass('alert').map(squash), ['Failed to load payouts'])
    assert.ok(!text(page).includes('TX-p1'))
  })

  it('moves to the last real page when the page it asked for no longer exists', async () => {
    // Page 1 said there were 2 pages; by the time Next is pressed the list has shrunk to 1.
    script = [
      ok(list([payout('p1')], { total: 60, totalPages: 2 })),
      ok(list([], { total: 50, page: 2, totalPages: 1 })),
      ok(list([payout('p1')], { total: 50, totalPages: 1 })),
    ]
    const page = await open()
    await page.click('Next')
    assert.deepEqual(calls.map((q) => q.get('page')), ['1', '2', '1'], 'the empty page 2 was replaced by a request for page 1')
    assert.ok(text(page).includes('TX-p1'))
    assert.ok(!text(page).includes('No payouts yet') && !text(page).includes('Loading…'))
    assert.ok(!page.hasButton('Next'), 'one page left')
  })
})

describe('Record commission payout dialog', () => {
  let actions: Array<{ path: string; method: string; body: any }>
  let actionScript: Step[]
  let summaryScript: Step[]

  const summary = (payable = '900'): Row => ({
    reseller: { id: 'r1', code: 'RS-1', businessName: 'Kandy Traders', status: 'ACTIVE', currentLevel: 1 },
    totals: { pending: '0', approved: '0', payable, paid: '0', reversed: '0' },
  })
  const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

  const open = async (permissions = ['commissions:read', 'commissions:manage']) => {
    const page = mountPage(PAYER, {
      'next/link': { __esModule: true, default: ({ href, children }: { href: string; children: unknown }) => jsx('a', { href, children }) },
      'next/navigation': { useParams: () => ({ id: 'r1' }) },
      '@/lib/api': {
        ApiError,
        api: async (url: string, init: { method?: string; body?: string } = {}) => {
          if (url.startsWith('/commissions/summary')) return (summaryScript.shift() ?? ok(summary()))()
          actions.push({ path: url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined })
          const next = actionScript.shift()
          if (!next) throw new Error(`unexpected extra action: ${url}`)
          return next()
        },
      },
      '@/lib/admin-context': { useAdminUser: () => ({ permissions }) },
      '@/lib/format': format,
      '@/components/Tabs': { Tabs: () => null },
      '@/components/commissions/LevelSummary': { LevelSummary: () => null },
      '@/components/commissions/CommissionLedger': { CommissionLedger: () => null },
      '@/components/commissions/CustomerCommissions': { CustomerCommissions: () => null },
      '@/components/commissions/MonthlyReport': { MonthlyReport: () => null },
      '@/components/commissions/PayoutHistory': { PayoutHistory: () => null },
      '@/components/ui/Modal': { Modal: ({ children }: { children: unknown }) => jsx('div', { className: 'modal', children }) },
    })
    await page.settle()
    return page
  }
  type Page = Awaited<ReturnType<typeof open>>
  const modal = (page: Page) => page.textOfClass('modal').map(squash)[0]
  const fillForm = async (page: Page, paidAt: string, reference = 'TX-2026-10') => {
    await page.fill('pay-ref', reference)
    await page.fill('pay-date', paidAt)
  }

  beforeEach(() => {
    actions = []
    actionScript = []
    summaryScript = []
  })

  it('starts on today in business time, not the UTC date', async () => {
    const page = await open()
    await page.click('Pay Rs. 900.00')
    assert.equal(page.valueOf('pay-date'), format.businessDate())
    assert.match(page.valueOf('pay-date'), /^\d{4}-\d{2}-\d{2}$/)
  })

  it('records the payout with the chosen past date, says so, closes the dialog and starts the next one on today', async () => {
    const yesterday = addDays(format.businessDate(), -1)
    actionScript = [ok({ totalAmount: '900', entries: 3 })]
    const page = await open()
    await page.click('Pay Rs. 900.00')
    await fillForm(page, yesterday, '  TX-2026-10  ')
    await page.fill('pay-note', 'October')
    await page.click('Mark as paid')
    assert.deepEqual(actions, [{ path: '/commissions/payouts', method: 'POST', body: { resellerId: 'r1', paymentReference: 'TX-2026-10', paidAt: yesterday, note: 'October' } }])
    assert.equal(modal(page), undefined)
    assert.deepEqual(page.textOfClass('alert success').map(squash), ['Payout of Rs. 900.00 recorded for 3 commission entries.'])
    await page.click('Pay Rs. 900.00')
    assert.equal(page.valueOf('pay-date'), format.businessDate(), 'back to today')
    assert.equal(page.valueOf('pay-ref'), '')
  })

  it('accepts today itself', async () => {
    actionScript = [ok({ totalAmount: '900', entries: 3 })]
    const page = await open()
    await page.click('Pay Rs. 900.00')
    await fillForm(page, format.businessDate())
    await page.click('Mark as paid')
    assert.equal(actions.length, 1)
    assert.equal(actions[0].body.paidAt, format.businessDate())
  })

  it('refuses a future date in the dialog, saying so, and sends nothing', async () => {
    const page = await open()
    await page.click('Pay Rs. 900.00')
    await fillForm(page, addDays(format.businessDate(), 1))
    await page.click('Mark as paid')
    assert.ok(modal(page).includes('Payment date cannot be in the future.'))
    assert.deepEqual(actions, [])
    await fillForm(page, addDays(format.businessDate(), 365))
    await page.click('Mark as paid')
    assert.ok(modal(page).includes('Payment date cannot be in the future.'))
    assert.deepEqual(actions, [])
  })

  it('refuses a cleared date and a missing reference before sending anything', async () => {
    const page = await open()
    await page.click('Pay Rs. 900.00')
    await fillForm(page, '')
    await page.click('Mark as paid')
    assert.ok(modal(page).includes('Enter the date the payment was made.'))
    await fillForm(page, format.businessDate(), 'ab')
    await page.click('Mark as paid')
    assert.ok(modal(page).includes('Enter the bank transfer / payment reference.'))
    assert.deepEqual(actions, [])
  })

  it('shows the server\'s own message for a date it refuses, not "Validation error"', async () => {
    actionScript = [fail(new ApiError('Validation error', 422, undefined, ['paidAt: Payment date cannot be in the future']))]
    const page = await open()
    await page.click('Pay Rs. 900.00')
    await fillForm(page, format.businessDate())
    await page.click('Mark as paid')
    assert.ok(modal(page).includes('Payment date cannot be in the future'))
    assert.ok(!modal(page).includes('Validation error'))
    assert.ok(!modal(page).includes('paidAt:'), 'without the field prefix')
    assert.equal(page.valueOf('pay-ref'), 'TX-2026-10', 'what was typed is kept')
  })

  it('shows other failures as the server worded them, and keeps the dialog open', async () => {
    actionScript = [fail(new ApiError('There are no payable commissions for this partner', 400))]
    const page = await open()
    await page.click('Pay Rs. 900.00')
    await fillForm(page, format.businessDate())
    await page.click('Mark as paid')
    assert.ok(modal(page).includes('There are no payable commissions for this partner'))
    assert.deepEqual(page.textOfClass('alert success'), [])
  })

  it('offers the payout only to admins who may manage commissions, and only when something is payable', async () => {
    const readOnly = await open(['commissions:read'])
    assert.ok(!readOnly.buttonLabels().some((l) => l.startsWith('Pay ')))
    summaryScript = [ok(summary('0'))]
    const nothing = await open()
    assert.equal(nothing.isDisabled('Pay Rs. 0.00'), true)
  })
})
