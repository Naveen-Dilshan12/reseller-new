import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { jsx, mountPage } from './helpers/render-page'

/**
 * Admin → Commissions (/admin/commissions): the ledger table with its filters, pager, "Approve selected" and "Reverse".
 *  - states: "Loading…" while the first answer is awaited (never "No commission entries" yet), a failed load shows its
 *    error with Retry instead of stale rows or an empty table, and filtered-empty is told apart from empty;
 *  - filters send the right request, go back to page 1, drop the selection, and a slow answer for an old filter cannot
 *    replace a newer one; a page that no longer exists (everything on it was approved) moves to the last real page;
 *  - approve: only pending rows can be ticked, one request per click, the result says how many moved and how many were
 *    skipped, and the list is reloaded; a conflict reloads it too;
 *  - reverse: the reason is checked, a failure appears inside the dialog (not behind it), Escape is ignored while saving,
 *    and the dialog starts clean each time;
 *  - the partner filter (all-resellers admin view only): the list is loaded in full, the table follows the choice from page 1,
 *    and a failed list does not hold the table up;
 *  - the page: a Commissions tab and a Payouts tab (all partners), with approve / reverse / the filter following the admin's permissions;
 *  - read-only for people without commissions:manage.
 *
 * The real, unmodified component and page run in Node through tests/helpers/render-page.ts against scripted API stubs.
 * Database-free; nothing here reads `.env`, runs Prisma or opens a connection. There is no browser, so how the page
 * looks is not checked here.
 */

const LEDGER = path.resolve(__dirname, '../../web/src/components/commissions/CommissionLedger.tsx')
const PAGE = path.resolve(__dirname, '../../web/src/app/admin/commissions/page.tsx')
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

const entry = (id: string, over: Row = {}): Row => ({
  id,
  entryType: 'EARNING',
  periodMonth: '2026-10',
  level: 2,
  baseAmount: '5000',
  rate: '10',
  amount: '500',
  currency: 'LKR',
  status: 'PENDING',
  payableAt: '2026-11-01T00:00:00.000Z',
  approvedAt: null,
  paidAt: null,
  reversedAt: null,
  reversalReason: null,
  createdAt: '2026-10-01T05:00:00.000Z',
  customerAccount: { id: `acc-${id}`, status: 'ACTIVE', customer: { id: `c-${id}`, displayName: `Customer ${id}` } },
  product: { code: 'SALON', name: 'Hexalyte Salon' },
  reseller: { id: 'r1', code: 'RS-1', businessName: 'Kandy Traders' },
  payout: null,
  ...over,
})
const list = (items: Row[], meta: Row = {}): Row => ({
  data: items,
  meta: { total: items.length, page: 1, limit: 25, totalPages: 1, netAmount: '0', ...meta },
})
const REASON = 'Customer asked for a refund'
const EMPTY_HINT = 'Commission entries will appear here once customer subscriptions are activated and verified.'

describe('Admin → Commissions ledger', () => {
  let listCalls: URLSearchParams[]
  let resellerCalls: string[]
  let resellerScript: Step[]
  let listScript: Step[]
  let actions: Array<{ path: string; method: string; body: any }>
  let actionScript: Step[]
  let changed: number
  let closeModal: (() => void) | undefined

  const open = async (props: Row = {}) => {
    const page = mountPage(
      LEDGER,
      {
        '@/lib/api': {
          ApiError,
          apiRequest: async (url: string) => {
            if (url.startsWith('/admin/resellers')) {
              resellerCalls.push(url)
              const next = resellerScript.shift()
              if (!next) throw new Error(`unexpected extra partner request: ${url}`)
              return next()
            }
            listCalls.push(new URLSearchParams(url.split('?')[1]))
            const next = listScript.shift()
            if (!next) throw new Error(`unexpected extra list request: ${url}`)
            return next()
          },
          api: async (url: string, init: { method?: string; body?: string } = {}) => {
            actions.push({ path: url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined })
            const next = actionScript.shift()
            if (!next) throw new Error(`unexpected extra action: ${url}`)
            return next()
          },
        },
        '@/lib/format': format,
        '@/components/ui/EmptyState': { EmptyState: ({ title, hint }: { title: string; hint?: string }) => jsx('div', { className: 'empty', children: [title, hint] }) },
        '@/components/ui/Modal': {
          Modal: ({ onClose, children }: { onClose: () => void; children: unknown }) => {
            closeModal = onClose
            return jsx('div', { className: 'modal', children })
          },
        },
      },
      { exportName: 'CommissionLedger', props: { manage: true, onChanged: () => void changed++, ...props } },
    )
    await page.settle()
    return page
  }
  type Page = Awaited<ReturnType<typeof open>>

  const text = (page: Page) => page.text().replace(/\s+/g, ' ')
  const alerts = (page: Page, kind = 'alert') => page.textOfClass(kind).map((t) => t.replace(/\s+/g, ' ').trim())
  const modal = (page: Page) => page.textOfClass('modal').map((t) => t.replace(/\s+/g, ' ').trim())[0]
  const last = () => listCalls[listCalls.length - 1]

  beforeEach(() => {
    listCalls = []
    resellerCalls = []
    resellerScript = []
    listScript = []
    actions = []
    actionScript = []
    changed = 0
    closeModal = undefined
  })

  describe('loading, errors and empty', () => {
    it('shows "Loading commissions…" until the first answer, never the empty table, then the rows and totals', async () => {
      const pending = deferred<unknown>()
      listScript = [() => pending.promise]
      const page = await open({ initialStatus: 'PENDING' })
      assert.ok(text(page).includes('Loading commissions…'))
      assert.ok(!text(page).includes('No commission entries'))
      assert.ok(!text(page).includes('entries · net'), 'no totals before there is an answer')

      pending.resolve(list([entry('c1'), entry('c2', { amount: '300' })], { netAmount: '800' }))
      await page.settle()
      assert.ok(!text(page).includes('Loading commissions…'))
      assert.ok(text(page).includes('Customer c1') && text(page).includes('Customer c2'))
      assert.ok(text(page).includes('2 entries · net Rs. 800.00'))
    })

    it('a failed first load shows the error with Retry, no empty table and no totals; Retry loads it', async () => {
      listScript = [fail(new ApiError('Failed to load', 500)), ok(list([entry('c1')], { netAmount: '500' }))]
      const page = await open()
      assert.deepEqual(alerts(page), ['Failed to load'])
      assert.ok(!text(page).includes('No commission entries'))
      assert.ok(!text(page).includes('Loading commissions'))
      assert.ok(!text(page).includes('entries · net'))
      assert.ok(page.hasButton('Retry'))

      await page.click('Retry')
      assert.deepEqual(alerts(page), [])
      assert.ok(text(page).includes('Customer c1') && text(page).includes('1 entries · net Rs. 500.00'))
      assert.equal(listCalls.length, 2)
    })

    it('says "Loading…" again while Retry is in flight, and shows a plain message when the failure is not from the server', async () => {
      const second = deferred<unknown>()
      listScript = [fail(new Error('network down')), () => second.promise]
      const page = await open()
      assert.deepEqual(alerts(page), ['Failed to load commissions'])
      const retry = page.click('Retry')
      await page.settle()
      assert.ok(text(page).includes('Loading commissions…'))
      assert.deepEqual(alerts(page), [])
      second.resolve(list([entry('c1')]))
      await retry
      assert.ok(text(page).includes('Customer c1'))
    })

    it('does not leave the previous filter\'s rows or totals on screen when the next load fails', async () => {
      listScript = [ok(list([entry('c1')], { netAmount: '500' })), fail(new ApiError('Failed to load', 500))]
      const page = await open({ initialStatus: 'PENDING' })
      assert.ok(text(page).includes('Customer c1'))
      await page.fill('ledger-status', 'PAID')
      assert.deepEqual(alerts(page), ['Failed to load'])
      assert.ok(!text(page).includes('Customer c1'), 'rows of the old filter are gone')
      assert.ok(!text(page).includes('entries · net'))
      assert.equal(last().get('status'), 'PAID')
    })

    it('tells "no entries yet" from "nothing matches these filters"', async () => {
      listScript = [ok(list([])), ok(list([])), ok(list([])), ok(list([]))]
      const page = await open() // no filter
      assert.deepEqual(page.textOfClass('empty').map((t) => t.replace(/\s+/g, ' ')), [`No commission entries${EMPTY_HINT}`])
      await page.fill('ledger-status', 'PAID')
      assert.deepEqual(page.textOfClass('empty').map((t) => t.replace(/\s+/g, ' ')), ['No commission entries matchTry another status or month.'])
      await page.fill('ledger-status', '')
      await page.fill('ledger-month', '2026-09')
      assert.ok(text(page).includes('No commission entries match'))
    })
  })

  describe('filters and paging', () => {
    it('asks for page 1 of 25 with the starting status, and shows the Partner column when asked', async () => {
      listScript = [ok(list([entry('c1')]))]
      const page = await open({ initialStatus: 'PENDING', showReseller: true })
      assert.deepEqual(Object.fromEntries(last()), { page: '1', limit: '25', status: 'PENDING' })
      assert.ok(text(page).includes('Kandy Traders') && text(page).includes('RS-1'))
    })

    it('sends the status, the month and the partner, and "All" removes the status', async () => {
      listScript = [ok(list([])), ok(list([])), ok(list([])), ok(list([]))]
      const page = await open({ initialStatus: 'PENDING', resellerId: 'r9' })
      assert.equal(last().get('resellerId'), 'r9')
      await page.fill('ledger-status', 'PAYABLE')
      assert.equal(last().get('status'), 'PAYABLE')
      await page.fill('ledger-month', '2026-09')
      assert.equal(last().get('periodMonth'), '2026-09')
      assert.equal(last().get('status'), 'PAYABLE')
      await page.fill('ledger-status', '')
      assert.equal(last().get('status'), null)
      assert.equal(last().get('periodMonth'), '2026-09')
      assert.equal(last().get('resellerId'), 'r9')
    })

    it('goes back to page 1 when a filter changes', async () => {
      // (The test renderer re-renders on every state change instead of batching them like React, so the status and the
      // page reset may be two requests here; either way the page-1 answer is what ends up on screen.)
      listScript = [ok(list([entry('c1')], { totalPages: 4, total: 100 })), ok(list([entry('c2')], { totalPages: 4, total: 100 })), ok(list([entry('c3')])), ok(list([entry('c3')]))]
      const page = await open()
      await page.click('Next')
      assert.equal(last().get('page'), '2')
      await page.fill('ledger-status', 'PAID')
      assert.equal(last().get('page'), '1')
      assert.equal(last().get('status'), 'PAID')
      assert.ok(text(page).includes('Customer c3') && !text(page).includes('Customer c2'))
      assert.ok(!page.hasButton('Next'), 'single page again')
    })

    it('the newest filter wins when an older request answers late', async () => {
      const slow = deferred<unknown>()
      const fast = deferred<unknown>()
      listScript = [ok(list([entry('start')])), () => slow.promise, () => fast.promise]
      const page = await open({ initialStatus: 'PENDING' })
      void page.fill('ledger-status', 'APPROVED') // slow
      await page.settle()
      void page.fill('ledger-status', 'PAID') // fast
      await page.settle()

      fast.resolve(list([entry('paid-1', { status: 'PAID' })], { netAmount: '500' }))
      await page.settle()
      assert.ok(text(page).includes('Customer paid-1'))
      slow.resolve(list([entry('approved-1', { status: 'APPROVED' })], { netAmount: '999' }))
      await page.settle()
      assert.ok(text(page).includes('Customer paid-1'), 'the late answer for APPROVED did not replace it')
      assert.ok(!text(page).includes('Customer approved-1'))
      assert.ok(text(page).includes('net Rs. 500.00'))
    })

    it('shows the pager only when there are several pages, and Previous / Next stay inside them', async () => {
      listScript = [ok(list([entry('c1')])), ok(list([entry('c1')], { totalPages: 2, total: 30 })), ok(list([entry('c2')], { totalPages: 2, total: 30 })), ok(list([entry('c1')], { totalPages: 2, total: 30 }))]
      const single = await open()
      assert.ok(!single.hasButton('Next'))

      const page = await open()
      assert.ok(text(page).includes('1 / 2'))
      assert.equal(page.isDisabled('Previous'), true)
      await page.click('Next')
      assert.equal(last().get('page'), '2')
      assert.ok(text(page).includes('2 / 2'))
      assert.equal(page.isDisabled('Next'), true)
      await page.click('Previous')
      assert.equal(last().get('page'), '1')
    })

    it('moves to the last real page when the page it was on has emptied out', async () => {
      // Page 3 of 3 held the last two pending entries; both were approved elsewhere, so only 2 pages remain.
      listScript = [
        ok(list([entry('a')], { totalPages: 3, total: 51 })),
        ok(list([entry('b')], { totalPages: 3, total: 51 })),
        ok(list([entry('c')], { totalPages: 3, total: 51 })),
        ok(list([], { totalPages: 2, total: 50 })), // page 3 is gone …
        ok(list([entry('b2')], { totalPages: 2, total: 50 })), // … so page 2 is requested
      ]
      const page = await open({ initialStatus: 'PENDING' })
      await page.click('Next')
      await page.click('Next')
      assert.equal(last().get('page'), '3')
      // The empty answer arrived as the reload of page 3 (e.g. after an action); simulate that reload.
      listScript = [ok(list([], { totalPages: 2, total: 50 })), ok(list([entry('b2')], { totalPages: 2, total: 50 }))]
      actionScript = [ok({ approved: 2, payable: 0, skipped: 0 })]
      await page.toggle('select-c', true)
      await page.click('Approve selected (1)')
      assert.deepEqual(listCalls.slice(-2).map((q) => q.get('page')), ['3', '2'])
      assert.ok(text(page).includes('Customer b2'))
      assert.ok(!text(page).includes('No commission entries'), 'the empty page 3 was never shown')
      assert.ok(text(page).includes('2 / 2'))
    })

    it('goes to page 1 when the last entry of the last page disappears and nothing is left', async () => {
      listScript = [ok(list([entry('a')], { totalPages: 2, total: 26 })), ok(list([entry('b')], { totalPages: 2, total: 26 })), ok(list([], { totalPages: 0, total: 0 })), ok(list([]))]
      const page = await open({ initialStatus: 'PENDING' })
      await page.click('Next')
      actionScript = [ok({ approved: 1, payable: 0, skipped: 0 })]
      await page.toggle('select-b', true)
      await page.click('Approve selected (1)')
      assert.deepEqual(listCalls.slice(-2).map((q) => q.get('page')), ['2', '1'])
      assert.ok(text(page).includes('No commission entries'))
    })
  })

  describe('approving', () => {
    const pendingList = () => list([entry('p1'), entry('p2'), entry('ap', { status: 'APPROVED' }), entry('pd', { status: 'PAID', payout: { id: 'po1', paymentReference: 'TX-9', paidAt: '2026-09-20T00:00:00.000Z' } })])

    it('lets only pending rows be ticked, and "select all" ticks just those', async () => {
      listScript = [ok(pendingList())]
      const page = await open()
      await page.toggle('select-p1', true)
      assert.ok(page.hasButton('Approve selected (1)'))
      await assert.rejects(page.toggle('select-ap', true), /No field with id/, 'approved rows have no tick box')
      await assert.rejects(page.toggle('select-pd', true), /No field with id/, 'nor do paid ones')
      await page.toggle('select-all-pending', true)
      assert.ok(page.hasButton('Approve selected (2)'))
      await page.toggle('select-all-pending', false)
      assert.ok(page.hasButton('Approve selected (0)'))
      assert.equal(page.isDisabled('Approve selected (0)'), true)
    })

    it('approves the ticked entries with one request, reports what moved, reloads the list and tells the parent', async () => {
      listScript = [ok(pendingList()), ok(list([entry('p2'), entry('p1', { status: 'APPROVED' })]))]
      actionScript = [ok({ approved: 1, payable: 1, skipped: 0 })]
      const page = await open()
      await page.toggle('select-p1', true)
      await page.toggle('select-p2', true)
      await page.click('Approve selected (2)')

      assert.deepEqual(actions, [{ path: '/commissions/approve', method: 'POST', body: { ids: ['p1', 'p2'] } }])
      assert.deepEqual(alerts(page, 'alert success'), ['Approved 2 commission(s): 1 payable now, 1 on refund hold.'])
      assert.equal(listCalls.length, 2, 'reloaded')
      assert.ok(page.hasButton('Approve selected (0)'), 'the ticks are cleared')
      assert.equal(changed, 1)
    })

    it('says when some of the ticked entries were no longer pending', async () => {
      listScript = [ok(pendingList()), ok(pendingList())]
      actionScript = [ok({ approved: 1, payable: 0, skipped: 1 })]
      const page = await open()
      await page.toggle('select-all-pending', true)
      await page.click('Approve selected (2)')
      assert.deepEqual(alerts(page, 'alert success'), ['Approved 1 commission(s): 0 payable now, 1 on refund hold. 1 selected entry was no longer pending and left unchanged.'])
      actionScript = [ok({ approved: 0, payable: 1, skipped: 3 })]
      listScript = [ok(pendingList())]
      await page.toggle('select-p1', true)
      await page.click('Approve selected (1)')
      assert.match(alerts(page, 'alert success')[0], /3 selected entries were no longer pending/)
    })

    it('sends one request even if the button is pressed again while it is working', async () => {
      const pending = deferred<unknown>()
      listScript = [ok(pendingList()), ok(pendingList())]
      actionScript = [() => pending.promise]
      const page = await open()
      await page.toggle('select-p1', true)
      const first = page.click('Approve selected (1)')
      await page.settle()
      assert.equal(page.isDisabled('Approve selected (1)'), true)
      await page.click('Approve selected (1)')
      pending.resolve({ approved: 1, payable: 0, skipped: 0 })
      await first
      assert.equal(actions.length, 1)
    })

    it('a conflict ("someone already approved them") shows the message and reloads the list', async () => {
      listScript = [ok(pendingList()), ok(list([entry('p1', { status: 'APPROVED' })]))]
      actionScript = [fail(new ApiError('No pending commissions found in the selection', 409))]
      const page = await open()
      await page.toggle('select-p1', true)
      await page.click('Approve selected (1)')
      assert.deepEqual(alerts(page, 'alert error'), ['No pending commissions found in the selection'])
      assert.equal(listCalls.length, 2)
      assert.equal(changed, 0)
    })

    it('another failure shows its message, keeps the ticks for a retry and does not reload', async () => {
      listScript = [ok(pendingList())]
      actionScript = [fail(new ApiError('Internal server error', 500))]
      const page = await open()
      await page.toggle('select-p1', true)
      await page.click('Approve selected (1)')
      assert.deepEqual(alerts(page, 'alert error'), ['Internal server error'])
      assert.ok(page.hasButton('Approve selected (1)'))
      assert.equal(listCalls.length, 1)
      assert.equal(changed, 0)
    })

    it('shows one result at a time: a failure replaces the earlier success message', async () => {
      listScript = [ok(pendingList()), ok(pendingList())]
      actionScript = [ok({ approved: 1, payable: 0, skipped: 0 }), fail(new ApiError('Internal server error', 500))]
      const page = await open()
      await page.toggle('select-p1', true)
      await page.click('Approve selected (1)')
      assert.equal(alerts(page, 'alert success').length, 1)
      await page.toggle('select-p2', true)
      await page.click('Approve selected (1)')
      assert.deepEqual(alerts(page, 'alert success'), [])
      assert.deepEqual(alerts(page, 'alert error'), ['Internal server error'])
    })

    it('drops the ticks the moment the filter or page changes, before the new rows arrive, so nothing out of sight can be approved', async () => {
      const slow = deferred<unknown>()
      listScript = [ok(pendingList()), () => slow.promise]
      const page = await open()
      await page.toggle('select-p1', true)
      assert.ok(page.hasButton('Approve selected (1)'))
      void page.fill('ledger-status', 'APPROVED')
      await page.settle()
      assert.ok(text(page).includes('Loading commissions…'), 'the new rows are still on their way')
      assert.ok(page.hasButton('Approve selected (0)'))
      assert.equal(page.isDisabled('Approve selected (0)'), true)
      slow.resolve(list([entry('x1')]))
      await page.settle()
      assert.equal(actions.length, 0)
    })
  })

  describe('reversing', () => {
    const rows = () =>
      list([
        entry('e1'),
        entry('e2', { status: 'PAID', paidAt: '2026-09-20T00:00:00.000Z', payout: { id: 'po1', paymentReference: 'TX-9', paidAt: '2026-09-20T00:00:00.000Z' } }),
        entry('e3', { status: 'REVERSED', reversedAt: '2026-10-02T00:00:00.000Z', reversalReason: 'Refund' }),
        entry('e4', { status: 'PAID', reversedAt: '2026-10-02T00:00:00.000Z', payout: { id: 'po1', paymentReference: 'TX-9', paidAt: '2026-09-20T00:00:00.000Z' } }),
        entry('e5', { entryType: 'CLAWBACK', status: 'PAYABLE', amount: '-500' }),
      ])

    it('offers Reverse only on earnings that are not already reversed', async () => {
      listScript = [ok(rows())]
      const page = await open()
      assert.equal(page.buttonLabels().filter((l) => l === 'Reverse').length, 2, 'e1 (pending) and e2 (paid)')
    })

    it('is read-only without commissions:manage: no ticks, no Approve, no Reverse', async () => {
      listScript = [ok(rows())]
      const page = await open({ manage: false })
      assert.deepEqual(page.buttonLabels().filter((l) => /Approve|Reverse/.test(l)), [])
      await assert.rejects(page.toggle('select-e1', true), /No field with id/)
      await assert.rejects(page.toggle('select-all-pending', true), /No field with id/)
    })

    it('needs a reason of at least 5 characters before it can be sent', async () => {
      listScript = [ok(rows())]
      const page = await open()
      await page.clickAt('Reverse', 0)
      assert.ok(modal(page).includes('Reverse commission'))
      assert.equal(page.isDisabled('Reverse commission'), true)
      await page.fill('reverse-reason', '  hi  ')
      assert.equal(page.isDisabled('Reverse commission'), true)
      await page.fill('reverse-reason', 'abcde')
      assert.equal(page.isDisabled('Reverse commission'), false)
      await page.click('Reverse commission')
      assert.equal(actions.length, 1)
    })

    it('reverses an unpaid entry: sends the trimmed reason, closes the dialog, says so, reloads and tells the parent', async () => {
      listScript = [ok(rows()), ok(list([]))]
      actionScript = [ok({ reversed: {}, clawback: null })]
      const page = await open()
      await page.clickAt('Reverse', 0)
      await page.fill('reverse-reason', `  ${REASON}  `)
      await page.click('Reverse commission')
      assert.deepEqual(actions, [{ path: '/commissions/e1/reverse', method: 'POST', body: { reason: REASON } }])
      assert.equal(modal(page), undefined, 'dialog closed')
      assert.deepEqual(alerts(page, 'alert success'), ['Commission reversed.'])
      assert.equal(listCalls.length, 2)
      assert.equal(changed, 1)
    })

    it('warns about the clawback for a paid entry, and the result mentions it', async () => {
      listScript = [ok(rows()), ok(rows())]
      actionScript = [ok({ reversed: {}, clawback: {} })]
      const page = await open()
      await page.clickAt('Reverse', 1)
      assert.match(modal(page), /already paid\. A clawback of Rs\. 500\.00 will be deducted/)
      await page.fill('reverse-reason', REASON)
      await page.click('Reverse commission')
      assert.deepEqual(alerts(page, 'alert success'), ['Paid commission reversed: a clawback was added to the next payout.'])
    })

    it('shows a failure inside the dialog, keeps it open with the typed reason, and clears the error when the reason is edited', async () => {
      listScript = [ok(rows())]
      actionScript = [fail(new ApiError('Validation error', 422, undefined, ['reason: Reason must be at most 500 characters']))]
      const page = await open()
      await page.clickAt('Reverse', 0)
      await page.fill('reverse-reason', REASON)
      await page.click('Reverse commission')
      assert.ok(modal(page).includes('Reason must be at most 500 characters'), 'the reason is in the dialog')
      assert.deepEqual(alerts(page, 'alert error'), ['Reason must be at most 500 characters'], 'and nowhere else')
      assert.equal(page.valueOf('reverse-reason'), REASON)
      assert.equal(changed, 0)
      await page.fill('reverse-reason', `${REASON}.`)
      assert.deepEqual(alerts(page, 'alert error'), [])
    })

    it('a conflict ("changed by someone else") is shown in the dialog and the list is reloaded behind it', async () => {
      listScript = [ok(rows()), ok(list([]))]
      actionScript = [fail(new ApiError('This commission was changed by someone else (already reversed or paid). Reload the list and check its status.', 409))]
      const page = await open()
      await page.clickAt('Reverse', 0)
      await page.fill('reverse-reason', REASON)
      await page.click('Reverse commission')
      assert.match(modal(page), /changed by someone else/)
      assert.equal(listCalls.length, 2)
    })

    it('ignores Escape while the request is in flight and sends only one request however often it is pressed', async () => {
      const pending = deferred<unknown>()
      listScript = [ok(rows()), ok(list([]))]
      actionScript = [() => pending.promise]
      const page = await open()
      await page.clickAt('Reverse', 0)
      await page.fill('reverse-reason', REASON)
      const first = page.click('Reverse commission')
      await page.settle()
      assert.ok(page.hasButton('Reversing…'))
      assert.equal(page.isDisabled('Reversing…'), true)
      closeModal?.() // Escape
      await page.settle()
      assert.ok(modal(page) !== undefined, 'still open while saving')
      await page.click('Reversing…')
      pending.resolve({ reversed: {}, clawback: null })
      await first
      assert.equal(actions.length, 1)
      assert.equal(modal(page), undefined)
    })

    it('closes on Escape or Cancel when idle, and starts clean for the next entry', async () => {
      listScript = [ok(rows())]
      actionScript = [fail(new ApiError('Internal server error', 500))]
      const page = await open()
      await page.clickAt('Reverse', 0)
      await page.fill('reverse-reason', REASON)
      await page.click('Reverse commission')
      assert.ok(modal(page).includes('Internal server error'))

      closeModal?.()
      await page.settle()
      assert.equal(modal(page), undefined)

      await page.clickAt('Reverse', 1)
      assert.equal(page.valueOf('reverse-reason'), '', 'the earlier reason is not carried over')
      assert.ok(!modal(page).includes('Internal server error'), 'nor the earlier error')
      await page.click('Cancel')
      assert.equal(modal(page), undefined)
    })
  })

  describe('reseller filter', () => {
    const reseller = (id: string, businessName: string, code: string, status = 'ACTIVE'): Row => ({ id, businessName, code, status, email: `${id}@test.invalid` })
    const resellerList = (items: Row[], meta: Row = {}): Row => ({ data: items, meta: { total: items.length, page: 1, limit: 100, totalPages: 1, ...meta } })
    const ALL = [reseller('r2', 'Galle Traders', 'RS-2'), reseller('r1', 'Kandy Traders', 'RS-1'), reseller('r3', 'Colombo Co', 'RS-3', 'SUSPENDED')]

    it('is not offered unless asked for, and never when the page already fixes the partner', async () => {
      listScript = [ok(list([entry('c1')])), ok(list([entry('c1')]))]
      const plain = await open({ showReseller: true })
      await assert.rejects(plain.change('ledger-reseller', { value: 'r1' }), /No field with id/)
      const fixed = await open({ resellerId: 'r1', filterByReseller: true })
      await assert.rejects(fixed.change('ledger-reseller', { value: 'r2' }), /No field with id/)
      assert.deepEqual(resellerCalls, [], 'no partner list is fetched either')
    })

    it('shows "Loading partners…" until the list arrives, then offers every partner by name and code, A to Z, marking those not active', async () => {
      const pending = deferred<unknown>()
      resellerScript = [() => pending.promise]
      listScript = [ok(list([entry('c1')]))]
      const page = await open({ showReseller: true, filterByReseller: true, initialStatus: 'PENDING' })
      assert.ok(text(page).includes('Loading partners…'))
      assert.deepEqual(resellerCalls, ['/admin/resellers?page=1&limit=100'])
      assert.equal(last().get('resellerId'), null, 'the table starts on all partners, without waiting for the list')

      pending.resolve(resellerList(ALL))
      await page.settle()
      const t = text(page)
      assert.ok(!t.includes('Loading partners…'))
      assert.ok(t.includes('All partners'))
      const order = ['Colombo Co (RS-3) · suspended', 'Galle Traders (RS-2)', 'Kandy Traders (RS-1)'].map((label) => t.indexOf(label))
      assert.ok(order.every((i) => i >= 0), t)
      assert.deepEqual([...order].sort((a, b) => a - b), order, 'sorted by name')
    })

    it('reads every page of partners', async () => {
      resellerScript = [ok(resellerList([reseller('r1', 'Kandy Traders', 'RS-1')], { totalPages: 2, total: 2 })), ok(resellerList([reseller('r2', 'Galle Traders', 'RS-2')], { page: 2, totalPages: 2, total: 2 }))]
      listScript = [ok(list([]))]
      const page = await open({ filterByReseller: true })
      assert.deepEqual(resellerCalls, ['/admin/resellers?page=1&limit=100', '/admin/resellers?page=2&limit=100'])
      assert.ok(text(page).includes('Galle Traders (RS-2)') && text(page).includes('Kandy Traders (RS-1)'))
    })

    it('choosing a partner reloads the table for that partner from page 1, keeping the status and month; "All partners" lifts it', async () => {
      resellerScript = [ok(resellerList(ALL))]
      listScript = [ok(list([entry('a')], { totalPages: 3, total: 60 })), ok(list([entry('b')], { totalPages: 3, total: 60 })), ok(list([entry('c')])), ok(list([entry('d')])), ok(list([entry('e')])), ok(list([entry('f')]))]
      const page = await open({ showReseller: true, filterByReseller: true, initialStatus: 'PAYABLE' })
      await page.fill('ledger-month', '2026-09')
      await page.click('Next')
      assert.equal(last().get('page'), '2')

      await page.fill('ledger-reseller', 'r2')
      assert.equal(last().get('resellerId'), 'r2')
      assert.equal(last().get('page'), '1', 'back to the first page')
      assert.equal(last().get('status'), 'PAYABLE')
      assert.equal(last().get('periodMonth'), '2026-09')
      assert.equal(page.valueOf('ledger-reseller'), 'r2')

      await page.fill('ledger-reseller', '')
      assert.equal(last().get('resellerId'), null)
      assert.equal(last().get('status'), 'PAYABLE')
    })

    it('drops the ticks at once when the partner changes', async () => {
      const slow = deferred<unknown>()
      resellerScript = [ok(resellerList(ALL))]
      listScript = [ok(list([entry('p1'), entry('p2')])), () => slow.promise]
      const page = await open({ filterByReseller: true, initialStatus: 'PENDING' })
      await page.toggle('select-p1', true)
      assert.ok(page.hasButton('Approve selected (1)'))
      void page.fill('ledger-reseller', 'r1')
      await page.settle()
      assert.ok(page.hasButton('Approve selected (0)'))
      slow.resolve(list([]))
      await page.settle()
    })

    it('tells "nothing matches" when a partner has no entries for the chosen status', async () => {
      resellerScript = [ok(resellerList(ALL))]
      listScript = [ok(list([entry('c1')])), ok(list([]))]
      const page = await open({ filterByReseller: true })
      await page.fill('ledger-reseller', 'r3')
      assert.deepEqual(page.textOfClass('empty').map((t) => t.replace(/\s+/g, ' ')), ['No commission entries matchTry another status, month or partner.'])
    })

    it('a failed partner list says so, offers a retry, and leaves the table working on all partners', async () => {
      resellerScript = [fail(new ApiError('Failed to load partners', 500)), ok(resellerList(ALL))]
      listScript = [ok(list([entry('c1')]))]
      const page = await open({ showReseller: true, filterByReseller: true })
      assert.ok(text(page).includes('Failed to load partners'))
      assert.ok(text(page).includes('All partners'), 'the filter can still be left on "All partners"')
      assert.ok(text(page).includes('Customer c1'), 'the table is not held up by it')

      await page.click('Retry loading partners')
      assert.ok(!text(page).includes('Failed to load partners'))
      assert.ok(text(page).includes('Kandy Traders (RS-1)'))
      assert.equal(resellerCalls.length, 2)
    })

    it('shows a plain message when the partner list fails for a reason that is not the server\'s', async () => {
      resellerScript = [fail(new Error('network down'))]
      listScript = [ok(list([]))]
      const page = await open({ filterByReseller: true })
      assert.ok(text(page).includes('Could not load the partner list'))
    })
  })

  describe('the page', () => {
    const mountAdminPage = (permissions: string[]) => {
      const ledger: Row[] = []
      const payouts: Row[] = []
      const page = mountPage(PAGE, {
        'next/link': { __esModule: true, default: ({ href, children }: { href: string; children: unknown }) => jsx('a', { href, children }) },
        '@/lib/admin-context': { useAdminUser: () => ({ permissions }) },
        '@/components/admin/AdminPageHeader': { AdminPageHeader: ({ title, actions }: { title: string; actions: unknown }) => jsx('header', { children: [jsx('h1', { children: title }), actions] }) },
        '@/components/Tabs': {
          Tabs: ({ tabs, value, onChange }: { tabs: Array<{ key: string; label: string }>; value: string; onChange: (key: string) => void }) =>
            jsx('div', { className: 'tabs', children: tabs.map((t) => jsx('button', { className: value === t.key ? 'tab active' : 'tab', onClick: () => onChange(t.key), children: t.label })) }),
        },
        '@/components/commissions/CommissionLedger': { CommissionLedger: (props: Row) => (ledger.push(props), jsx('div', { className: 'ledger', children: 'ledger' })) },
        '@/components/commissions/PayoutHistory': { PayoutHistory: (props: Row) => (payouts.push(props), jsx('div', { className: 'payouts', children: 'payouts' })) },
      })
      const showing = () => ({ ledger: page.textOfClass('ledger').length > 0, payouts: page.textOfClass('payouts').length > 0 })
      return { page, ledger, payouts, showing }
    }

    it('opens on the pending queue for all partners, with the partner filter, and links to the monthly report', () => {
      const { page, ledger, showing } = mountAdminPage(['commissions:read', 'commissions:manage', 'resellers:read'])
      assert.deepEqual(ledger[0], { manage: true, showReseller: true, filterByReseller: true, initialStatus: 'PENDING' })
      assert.deepEqual(showing(), { ledger: true, payouts: false })
      assert.deepEqual(page.links(), [{ href: '/admin/commissions/report', text: 'Monthly report' }])
      assert.ok(page.text().includes('Commissions & Payouts'))
    })

    it('has a Payouts tab that shows every reseller\'s payouts, and Commissions brings the ledger back', async () => {
      const { page, payouts, showing } = mountAdminPage(['commissions:read', 'commissions:manage', 'resellers:read'])
      assert.deepEqual(page.buttonLabels(), ['Commissions', 'Payouts'])
      await page.click('Payouts')
      assert.deepEqual(showing(), { ledger: false, payouts: true })
      assert.deepEqual(payouts.at(-1), { showReseller: true }, 'all resellers: no resellerId, with the Partner column')
      await page.click('Commissions')
      assert.deepEqual(showing(), { ledger: true, payouts: false })
    })

    it('turns approve / reverse off for an admin without commissions:manage, and the partner filter off without resellers:read', () => {
      const { ledger } = mountAdminPage(['commissions:read'])
      assert.equal(ledger[0].manage, false)
      assert.equal(ledger[0].filterByReseller, false)
    })
  })
})
