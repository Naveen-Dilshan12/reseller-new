import { beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { jsx, mountPage } from './helpers/render-page'

/**
 * Admin → Customers (customer accounts): how the page behaves while loading, when requests fail, when the current page
 * disappears, and in the "Link SaaS account" dialog.
 *  - the list shows "Loading…" (not "No customer accounts found") while it loads, and a real error with Retry when it fails;
 *  - a page that no longer exists is corrected to the last real page; an empty page keeps its Prev / Next controls;
 *  - the dialog shows failures to load partners / products / customers instead of silently staying empty, and never
 *    offers a PENDING status (an existing tenant is always linked as a trial);
 *  - the "Record subscription event" dialog defaults to the current month in Asia/Colombo time, shows the allowed
 *    months, offers only the events that fit the account (no Cancelled / Refunded for an unpaid trial, no manual payment
 *    for a cancelled account) and reports clearly what the server did or refused.
 *
 * The real, unmodified page runs in Node through tests/helpers/render-page.ts (a minimal hook runtime, no DOM) against
 * scripted API stubs. Database-free; nothing here reads `.env`, runs Prisma or opens a connection.
 */

const PAGE = path.resolve(__dirname, '../../web/src/app/admin/customer-accounts/page.tsx')
/** The real formatting helpers (month labels, business-month default), not a stub. */
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

const EMPTY = 'No customer accounts found'
const meta = (page: number, totalPages: number, total = totalPages * 25) => ({ total, page, limit: 25, totalPages })
const account = (name: string, over: Row = {}): Row => ({
  id: `a-${name}`,
  externalTenantId: `tenant-${name}`,
  externalAccountId: null,
  status: 'TRIAL',
  activatedAt: null,
  customer: { id: `c-${name}`, displayName: name },
  product: { id: 'p1', code: 'SALON', name: 'Hexalyte Salon' },
  reseller: { id: 'r1', code: 'RS-1', businessName: 'Kandy Traders' },
  resellerId: 'r1',
  ...over,
})
const listOf = (names: string[], m = meta(1, 1, names.length)) => ({ data: names.map((n) => account(n)), meta: m })

describe('Admin customer accounts page', () => {
  /** Every GET /customer-accounts, in order, as its query string. */
  let listCalls: URLSearchParams[]
  /** Every other request: path and (parsed) body. */
  let otherCalls: Array<{ path: string; method: string; body: Row | null }>
  let listScript: Step[]
  let otherScript: Record<string, Step[]>

  const open = async () => {
    const page = mountPage(PAGE, {
      'next/link': { __esModule: true, default: ({ href, children }: { href: string; children: unknown }) => jsx('a', { href, children }) },
      '@/lib/admin-context': { useAdminUser: () => ({ permissions: ['accounts:read', 'accounts:manage', 'subscriptions:record'] }) },
      '@/lib/format': format,
      '@/components/admin/AdminPageHeader': { AdminPageHeader: ({ title, actions }: { title: string; actions: unknown }) => jsx('div', { children: [jsx('h1', { children: title }), actions] }) },
      '@/components/ui/Modal': { Modal: ({ children }: { children: unknown }) => jsx('div', { className: 'modal', children }) },
      '@/components/ui/EmptyState': { EmptyState: ({ title, hint }: { title: string; hint: string }) => jsx('div', { className: 'empty', children: [jsx('strong', { children: title }), hint] }) },
      // Same contract as the real <Pagination>: nothing for a single page, otherwise Prev / Next driven by `meta`.
      '@/components/ui/Pagination': {
        Pagination: ({ meta: m, onPage, busy }: { meta: { page: number; totalPages: number } | null; onPage: (p: number) => void; busy?: boolean }) =>
          !m || m.totalPages <= 1
            ? null
            : jsx('nav', {
                className: 'pagination',
                children: [
                  jsx('button', { disabled: Boolean(busy) || m.page <= 1, onClick: () => onPage(m.page - 1), children: '← Prev' }),
                  jsx('button', { disabled: Boolean(busy) || m.page >= m.totalPages, onClick: () => onPage(m.page + 1), children: 'Next →' }),
                ],
              }),
      },
      '@/lib/api': {
        ApiError,
        apiRequest: async (url: string) => {
          listCalls.push(new URLSearchParams(url.split('?')[1]))
          const next = listScript.shift()
          if (!next) throw new Error(`unexpected extra list request: ${url}`)
          return next()
        },
        api: async (url: string, init?: RequestInit) => {
          const key = url.split('?')[0]
          otherCalls.push({ path: url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null })
          const next = otherScript[key]?.shift()
          if (!next) throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`)
          return next()
        },
      },
    })
    await page.settle()
    return page
  }

  const pages = () => listCalls.map((q) => Number(q.get('page')))
  const alerts = (page: Awaited<ReturnType<typeof open>>) => page.textOfClass('alert').map((t) => t.replace(/\s+/g, ' ').trim())
  /** The partner and product lists the dialog loads when it opens (a script entry is consumed once, so build them per test). */
  const optionScripts = (): Record<string, Step[]> => ({
    '/admin/reseller-applications': [ok([{ id: 'r1', businessName: 'Kandy Traders', code: 'RS-1' }])],
    '/products': [
      ok([
        { id: 'p1', name: 'Hexalyte Salon', status: 'ACTIVE' },
        { id: 'p9', name: 'Retired Product', status: 'INACTIVE' },
      ]),
    ],
  })

  beforeEach(() => {
    listCalls = []
    otherCalls = []
    listScript = []
    otherScript = {}
  })

  describe('loading and failing (D1)', () => {
    it('shows "Loading…" while the first request is in flight, never the empty state', async () => {
      const pending = deferred<unknown>()
      listScript = [() => pending.promise]
      const page = await open()
      assert.ok(page.text().includes('Loading…'))
      assert.ok(!page.text().includes(EMPTY))
      assert.deepEqual(alerts(page), [])

      pending.resolve(listOf(['Nimal Stores']))
      await page.settle()
      assert.ok(page.text().includes('Nimal Stores'))
      assert.ok(!page.text().includes('Loading…'))
      assert.ok(!page.text().includes(EMPTY))
    })

    it('shows the empty state only once an empty result has arrived', async () => {
      listScript = [ok(listOf([], meta(1, 0, 0)))]
      const page = await open()
      assert.ok(page.text().includes(EMPTY))
      assert.ok(!page.text().includes('Loading…'))
      assert.equal(page.hasButton('Next →'), false)
    })

    it('a failed first load shows the error with Retry (no empty state), and Retry recovers', async () => {
      listScript = [fail(new ApiError('Service unavailable', 503)), ok(listOf(['Nimal Stores']))]
      const page = await open()
      assert.deepEqual(alerts(page), ['Service unavailable Retry'])
      assert.ok(!page.text().includes(EMPTY), 'a failed load is not "no accounts"')
      assert.ok(!page.text().includes('Loading…'))
      assert.ok(page.hasButton('Retry'))

      await page.click('Retry')
      assert.equal(listCalls.length, 2)
      assert.deepEqual(alerts(page), [])
      assert.ok(page.text().includes('Nimal Stores'))
    })

    it('a failure that is not an ApiError still gets a readable message', async () => {
      listScript = [fail(new TypeError('Failed to fetch'))]
      const page = await open()
      assert.deepEqual(alerts(page), ['Failed to load customers Retry'])
    })

    it('a failed reload drops the stale rows instead of showing them under the error, and Retry reloads the same filter', async () => {
      listScript = [ok(listOf(['Nimal Stores'])), fail(new ApiError('Gateway timeout', 504)), ok(listOf(['Kamal Mobile']))]
      const page = await open()
      assert.ok(page.text().includes('Nimal Stores'))

      await page.fill('acc-status', 'ACTIVE')
      assert.deepEqual(alerts(page), ['Gateway timeout Retry'])
      assert.ok(!page.text().includes('Nimal Stores'))
      assert.ok(!page.text().includes(EMPTY))

      await page.click('Retry')
      assert.equal(listCalls[2].get('status'), 'ACTIVE')
      assert.deepEqual(alerts(page), [])
      assert.ok(page.text().includes('Kamal Mobile'))
    })

    it('disables Prev / Next while a page is loading', async () => {
      const second = deferred<unknown>()
      listScript = [ok(listOf(['Nimal Stores'], meta(1, 2))), () => second.promise]
      const page = await open()
      await page.click('Next →')
      assert.equal(page.isDisabled('Next →'), true)
      assert.equal(page.isDisabled('← Prev'), true)
      second.resolve(listOf(['Kamal Mobile'], meta(2, 2)))
      await page.settle()
      assert.equal(page.isDisabled('← Prev'), false)
    })
  })

  describe('pagination when the current page is empty (D2)', () => {
    it('a page past the end is corrected to the last real page, without ever showing "no accounts"', async () => {
      const corrected = deferred<unknown>()
      listScript = [
        ok(listOf(['Nimal Stores'], meta(1, 2, 30))),
        // page 2 was emptied in the meantime: 25 accounts left in total, so the last real page is 1
        ok({ data: [], meta: meta(2, 1, 25) }),
        () => corrected.promise,
      ]
      const page = await open()
      await page.click('Next →')
      assert.deepEqual(pages(), [1, 2, 1], 'asks again for the last real page, once')
      assert.ok(!page.text().includes(EMPTY), 'no flash of the empty state while correcting')

      corrected.resolve(listOf(['Kamal Mobile'], meta(1, 1, 25)))
      await page.settle()
      assert.ok(page.text().includes('Kamal Mobile'))
      assert.ok(!page.text().includes(EMPTY))
      assert.deepEqual(alerts(page), [])
      assert.deepEqual(pages(), [1, 2, 1])
    })

    it('keeps the status filter while correcting the page', async () => {
      listScript = [ok(listOf(['Nimal Stores']))]
      const page = await open()
      listScript = [ok(listOf(['Nimal Stores'], meta(1, 2, 30)))]
      await page.fill('acc-status', 'TRIAL')
      listScript = [ok({ data: [], meta: meta(2, 1, 25) }), ok(listOf(['Kamal Mobile']))]
      await page.click('Next →')
      assert.deepEqual(pages(), [1, 1, 2, 1])
      assert.deepEqual(listCalls.slice(1).map((q) => q.get('status')), ['TRIAL', 'TRIAL', 'TRIAL'])
      assert.ok(page.text().includes('Kamal Mobile'))
    })

    it('an empty page that is still within the page count keeps Prev / Next so the admin is never stuck', async () => {
      listScript = [
        ok(listOf(['Nimal Stores'], meta(1, 3, 60))),
        ok(listOf(['Kamal Mobile'], meta(2, 3, 60))),
        ok({ data: [], meta: meta(3, 3, 60) }),
        ok(listOf(['Kamal Mobile'], meta(2, 3, 60))),
      ]
      const page = await open()
      await page.click('Next →')
      await page.click('Next →')
      assert.ok(page.text().includes(EMPTY))
      assert.ok(page.hasButton('← Prev'), 'pagination stays available on an empty page')

      await page.click('← Prev')
      assert.deepEqual(pages(), [1, 2, 3, 2])
      assert.ok(page.text().includes('Kamal Mobile'))
    })

    it('a genuinely empty list is requested once: no correction loop, no pagination', async () => {
      listScript = [ok(listOf([], meta(1, 0, 0)))]
      const page = await open()
      assert.deepEqual(pages(), [1])
      assert.ok(page.text().includes(EMPTY))
      assert.equal(page.hasButton('Next →'), false)
    })

    it('a filter that matches nothing shows the empty state once', async () => {
      listScript = [ok(listOf(['Nimal Stores'])), ok(listOf([], meta(1, 0, 0)))]
      const page = await open()
      await page.fill('acc-status', 'SUSPENDED')
      assert.deepEqual(pages(), [1, 1])
      assert.equal(listCalls[1].get('status'), 'SUSPENDED')
      assert.ok(page.text().includes(EMPTY))
      assert.equal(page.hasButton('Next →'), false)
    })
  })

  describe('Link SaaS account dialog: failed fetches are visible (D3)', () => {
    it('shows why partners / products could not be loaded, with Retry; the page does not crash', async () => {
      listScript = [ok(listOf(['Nimal Stores']))]
      const options = optionScripts()
      otherScript = {
        '/admin/reseller-applications': [fail(new ApiError('Partner list unavailable', 503)), ...options['/admin/reseller-applications']],
        '/products': [ok([]), ...options['/products']],
      }
      const page = await open()
      await page.click('Link SaaS account')
      assert.deepEqual(alerts(page), ['Partner list unavailable Retry'])
      assert.ok(!page.text().includes('Loading partners and products…'))

      await page.click('Retry')
      assert.deepEqual(alerts(page), [])
      assert.ok(page.text().includes('Kandy Traders (RS-1)'))
      assert.ok(page.text().includes('Hexalyte Salon'))
      assert.ok(!page.text().includes('Retired Product'), 'only ACTIVE products can be linked')
    })

    it('a non-ApiError failure gets a readable message, and closing + reopening the dialog tries again', async () => {
      listScript = [ok(listOf(['Nimal Stores']))]
      const options = optionScripts()
      otherScript = {
        '/admin/reseller-applications': [fail(new TypeError('Failed to fetch')), ...options['/admin/reseller-applications']],
        '/products': [ok([]), ...options['/products']],
      }
      const page = await open()
      await page.click('Link SaaS account')
      assert.deepEqual(alerts(page), ['Failed to load partners and products Retry'])
      await page.click('Cancel')
      await page.click('Link SaaS account')
      assert.deepEqual(alerts(page), [])
      assert.ok(page.text().includes('Kandy Traders (RS-1)'))
    })

    it('says so when a reseller\'s customers cannot be loaded, and still lets the admin enter a new customer name', async () => {
      listScript = [ok(listOf(['Nimal Stores']))]
      otherScript = { ...optionScripts(), '/customers': [fail(new ApiError('Customers down', 500))] }
      const page = await open()
      await page.click('Link SaaS account')
      await page.fill('link-reseller', 'r1')
      assert.ok(page.text().includes('Could not load this partner\'s customers (Customers down). You can still enter a new customer name.'))
      assert.equal(page.valueOf('link-customerName'), '', 'the new customer name field is still there')

      // choosing another reseller clears the message
      otherScript['/customers'] = [ok([{ id: 'c1', displayName: 'Kandy Mobiles' }])]
      await page.fill('link-reseller', 'r2')
      assert.ok(!page.text().includes('Could not load this partner'))
      assert.ok(page.text().includes('Kandy Mobiles'))
    })

    it('ignores a slow answer for a partner that is no longer selected', async () => {
      listScript = [ok(listOf(['Nimal Stores']))]
      const slow = deferred<unknown>()
      otherScript = { ...optionScripts(), '/customers': [() => slow.promise, ok([{ id: 'c2', displayName: 'Galle Customer' }])] }
      const page = await open()
      await page.click('Link SaaS account')
      await page.fill('link-reseller', 'r1')
      await page.fill('link-reseller', 'r2')
      assert.ok(page.text().includes('Galle Customer'))
      slow.resolve([{ id: 'c1', displayName: 'Kandy Customer' }])
      await page.settle()
      assert.ok(page.text().includes('Galle Customer'))
      assert.ok(!page.text().includes('Kandy Customer'), 'the answer for r1 must not replace the list for r2')
    })

    it('a customers failure that arrives late does not show on another partner', async () => {
      listScript = [ok(listOf(['Nimal Stores']))]
      const slow = deferred<unknown>()
      otherScript = { ...optionScripts(), '/customers': [() => slow.promise, ok([])] }
      const page = await open()
      await page.click('Link SaaS account')
      await page.fill('link-reseller', 'r1')
      await page.fill('link-reseller', 'r2')
      slow.reject(new ApiError('late failure', 500))
      await page.settle()
      assert.ok(!page.text().includes('late failure'))
    })
  })

  describe('Link SaaS account dialog: submitting (D5)', () => {
    const fillAndSubmit = async (page: Awaited<ReturnType<typeof open>>, over: { customer?: string } = {}) => {
      await page.click('Link SaaS account')
      await page.fill('link-reseller', 'r1')
      await page.fill('link-product', 'p1')
      if (over.customer) await page.fill('link-customer', over.customer)
      else await page.fill('link-customerName', '  Nimal Stores ')
      await page.fill('link-externalTenantId', ' tenant-100 ')
      await page.fill('link-externalAccountId', ' owner-7 ')
      await page.click('Link account')
    }

    it('never offers PENDING: the status is a fixed Trial, and TRIAL is what is sent', async () => {
      listScript = [ok(listOf(['Nimal Stores'])), ok(listOf(['Nimal Stores']))]
      otherScript = { ...optionScripts(), '/customers': [ok([])], '/customer-accounts': [ok(account('Nimal Stores'))] }
      const page = await open()
      await page.click('Link SaaS account')
      assert.equal(page.valueOf('link-status'), 'Trial')
      assert.ok(!page.text().includes('Pending'), 'the dialog has no "Pending" option')

      await page.click('Cancel')
      await fillAndSubmit(page)
      const post = otherCalls.find((c) => c.method === 'POST')!
      assert.equal(post.path, '/customer-accounts')
      assert.deepEqual(post.body, {
        resellerId: 'r1',
        productId: 'p1',
        externalTenantId: 'tenant-100',
        status: 'TRIAL',
        customerName: 'Nimal Stores',
        externalAccountId: 'owner-7',
      })
    })

    it('links an existing customer by id (no customerName), reports success and reloads the list', async () => {
      listScript = [ok(listOf(['Nimal Stores'])), ok(listOf(['Nimal Stores', 'Kandy Mobiles']))]
      otherScript = {
        ...optionScripts(),
        '/customers': [ok([{ id: 'c1', displayName: 'Kandy Mobiles' }])],
        '/customer-accounts': [ok(account('Kandy Mobiles'))],
      }
      const page = await open()
      await fillAndSubmit(page, { customer: 'c1' })
      const post = otherCalls.find((c) => c.method === 'POST')!
      assert.equal(post.body!.customerId, 'c1')
      assert.ok(!('customerName' in post.body!))
      assert.equal(post.body!.status, 'TRIAL')
      assert.deepEqual(page.textOfClass('alert success'), ['Kandy Mobiles linked to Hexalyte Salon.'])
      assert.equal(listCalls.length, 2, 'the list is reloaded after linking')
      assert.ok(!page.text().includes('Link SaaS account to partner'), 'the dialog closes')
    })

    it('shows the server\'s 409 and 422 messages in the dialog and keeps it open for another try', async () => {
      listScript = [ok(listOf(['Nimal Stores']))]
      otherScript = {
        ...optionScripts(),
        '/customers': [ok([])],
        '/customer-accounts': [
          fail(new ApiError('This SaaS tenant is already linked to another customer account', 409)),
          fail(new ApiError('Validation error', 422, undefined, ['status: A PENDING account cannot have a tenant ID. Link an existing tenant as TRIAL.'])),
        ],
      }
      const page = await open()
      await fillAndSubmit(page)
      assert.deepEqual(alerts(page), ['This SaaS tenant is already linked to another customer account'])
      assert.ok(page.text().includes('Link SaaS account to partner'))
      assert.equal(page.isDisabled('Link account'), false)

      await page.click('Link account')
      assert.deepEqual(alerts(page), ['status: A PENDING account cannot have a tenant ID. Link an existing tenant as TRIAL.'])
    })
  })

  describe('Record subscription event dialog', () => {
    const LABELS: Record<string, string> = {
      PAYMENT_VERIFIED: 'Payment verified (subscription active)',
      CANCELLED: 'Subscription cancelled (no refund)',
      REFUNDED: 'Payment refunded',
    }
    const ALL = ['PAYMENT_VERIFIED', 'CANCELLED', 'REFUNDED']
    const result = (over: Row = {}) => ({
      commission: null,
      reversed: [],
      level: { level: 1, activeCustomerCount: 1, changed: false },
      accountStatus: 'ACTIVE',
      subscriptionEnded: false,
      ...over,
    })

    const openDialog = async (status: string) => {
      listScript = [ok({ data: [account('Nimal Stores', { status })], meta: meta(1, 1, 1) })]
      const page = await open()
      await page.click('Record subscription event')
      return page
    }
    const offered = (page: Awaited<ReturnType<typeof open>>) => ALL.filter((type) => page.text().includes(LABELS[type]))
    const posted = () => otherCalls.filter((c) => c.method === 'POST' && c.path === '/subscription-events')

    it('defaults the billing month to the current month in Colombo time, whatever the browser clock says, and shows the allowed range', async () => {
      // 19:00 UTC on 30 September is already 1 October in Colombo (and still September in UTC / the Americas).
      mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-30T19:00:00Z') })
      try {
        const page = await openDialog('TRIAL')
        assert.equal(page.valueOf('ev-month'), '2026-10')
        assert.ok(page.text().includes('Allowed billing months: Sep 2026 to Dec 2026'), 'last month … two months ahead')
      } finally {
        mock.timers.reset()
      }
    })

    it('offers only the events that fit the account', async () => {
      const cases: Array<[string, string[]]> = [
        ['TRIAL', ['PAYMENT_VERIFIED']],
        ['PENDING', ['PAYMENT_VERIFIED']],
        ['ACTIVE', ALL],
        ['SUSPENDED', ALL],
        ['CANCELLED', ['REFUNDED']],
      ]
      for (const [status, expected] of cases) {
        const page = await openDialog(status)
        assert.deepEqual(offered(page), expected, status)
        assert.equal(page.valueOf('ev-type'), expected[0], `${status}: starts on the first event that is offered`)
      }
    })

    it('explains why Cancelled / Refunded are missing for an unpaid trial, and how a cancelled account is reactivated', async () => {
      const trial = await openDialog('TRIAL')
      assert.ok(trial.text().includes('Cancelled and Refunded events apply only to paid subscriptions'))

      const cancelled = await openDialog('CANCELLED')
      assert.ok(cancelled.text().includes('paid activation request'))
    })

    it('explains in the payment note what a verified payment needs', async () => {
      const page = await openDialog('TRIAL')
      assert.ok(page.text().includes('linked tenant'))
      assert.ok(page.text().includes('no open activation request'))
    })

    it('says the refund ends the subscription only for the current month', async () => {
      const page = await openDialog('ACTIVE')
      await page.fill('ev-type', 'REFUNDED')
      assert.ok(page.text().includes('only when refunding the current month'))
    })

    it('sends a payment event with the trimmed reference and note, and no endSubscription', async () => {
      const page = await openDialog('TRIAL')
      otherScript = { '/subscription-events': [ok(result({ commission: { amount: '550', currency: 'LKR' } }))] }
      listScript = [ok(listOf(['Nimal Stores']))]
      await page.fill('ev-ref', ' INV-9 ')
      await page.fill('ev-note', '  verified by phone ')
      await page.click('Record')
      assert.deepEqual(posted()[0].body, {
        customerAccountId: 'a-Nimal Stores',
        type: 'PAYMENT_VERIFIED',
        periodMonth: format.businessPeriod(),
        externalRef: 'INV-9',
        note: 'verified by phone',
      })
      assert.ok(page.textOfClass('alert success')[0].includes('Commission'))
    })

    it('sends endSubscription with a refund', async () => {
      const page = await openDialog('ACTIVE')
      otherScript = { '/subscription-events': [ok(result({ subscriptionEnded: true, accountStatus: 'CANCELLED' }))] }
      listScript = [ok(listOf(['Nimal Stores']))]
      await page.fill('ev-type', 'REFUNDED')
      await page.click('Record')
      assert.equal(posted()[0].body!.type, 'REFUNDED')
      assert.equal(posted()[0].body!.endSubscription, true)
    })

    it('tells the admin when a refund did not end the subscription, and when it did', async () => {
      const notEnded = await openDialog('ACTIVE')
      otherScript = { '/subscription-events': [ok(result({ subscriptionEnded: false, reversed: [{ id: 'c1' }] }))] }
      listScript = [ok(listOf(['Nimal Stores']))]
      await notEnded.fill('ev-type', 'REFUNDED')
      await notEnded.click('Record')
      const message = notEnded.textOfClass('alert success')[0]
      assert.ok(message.includes('1 commission(s) reversed'), message)
      assert.ok(message.includes('The subscription was not ended'), message)
      assert.ok(message.includes('only refunding the current month ends it'), message)
      assert.ok(message.includes('Cancelled'), message)

      const ended = await openDialog('ACTIVE')
      otherScript = { '/subscription-events': [ok(result({ subscriptionEnded: true, accountStatus: 'CANCELLED' }))] }
      listScript = [ok(listOf(['Nimal Stores']))]
      await ended.fill('ev-type', 'REFUNDED')
      await ended.click('Record')
      const endedMessage = ended.textOfClass('alert success')[0]
      assert.ok(endedMessage.includes('The subscription has ended'), endedMessage)
      assert.ok(!endedMessage.includes('was not ended'), endedMessage)
    })

    it('a payment that only renews does not claim the subscription ended or not ended', async () => {
      const page = await openDialog('ACTIVE')
      otherScript = { '/subscription-events': [ok(result())] }
      listScript = [ok(listOf(['Nimal Stores']))]
      await page.click('Record')
      const message = page.textOfClass('alert success')[0]
      assert.ok(!message.includes('subscription was not ended') && !message.includes('subscription has ended'), message)
    })

    it('shows the server\'s refusal in the dialog, keeps it open and lets the admin try again', async () => {
      const page = await openDialog('TRIAL')
      otherScript = {
        '/subscription-events': [
          fail(new ApiError('An activation request (AR-K7M2PQ) is already pending review for this customer account. Complete or reject it before recording a subscription event.', 409)),
          fail(new ApiError('Billing month must be between 2026-09 and 2026-12 (last month to two months ahead, Asia/Colombo time)', 400)),
        ],
      }
      await page.click('Record')
      assert.deepEqual(page.textOfClass('alert error'), ['An activation request (AR-K7M2PQ) is already pending review for this customer account. Complete or reject it before recording a subscription event.'])
      assert.ok(page.text().includes('Record subscription event'))
      assert.equal(page.isDisabled('Record'), false)
      assert.equal(listCalls.length, 1, 'nothing is reloaded after a refusal')

      await page.click('Record')
      assert.deepEqual(page.textOfClass('alert error'), ['Billing month must be between 2026-09 and 2026-12 (last month to two months ahead, Asia/Colombo time)'])
    })
  })
})
