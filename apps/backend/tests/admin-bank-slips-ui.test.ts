import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { jsx, mountPage } from './helpers/render-page'

/**
 * Admin → Bank slips register (the page behind /admin/bank-slips).
 *  - "Loading…" while the first request is in flight; a failed load shows the error with Retry instead of "Loading…" forever;
 *  - Search from a later page makes ONE request, for page 1 (it used to also fire one for the old page, and either answer could win);
 *  - a page that no longer exists is corrected to the last real page;
 *  - rows, duplicate flag, links and the slip viewer open with the right request and slip.
 *
 * The real, unmodified page runs in Node through tests/helpers/render-page.ts against scripted API stubs; the slip viewer
 * (which loads the file through the audited endpoint) is replaced by a marker. Database-free; nothing here reads `.env`,
 * runs Prisma or opens a connection.
 */

const PAGE = path.resolve(__dirname, '../../web/src/app/admin/bank-slips/page.tsx')
const format = require('../../web/src/lib/format')
const activationTypes = require('../../web/src/lib/activation-types')

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

const EMPTY = 'No bank slips found.'
const meta = (page: number, totalPages: number, total = totalPages * 25) => ({ total, page, limit: 25, totalPages })
const slip = (reference: string, over: Row = {}): Row => ({
  id: `slip-${reference}`,
  originalName: `${reference}.pdf`,
  mimeType: 'application/pdf',
  sizeBytes: 204800,
  createdAt: '2026-10-01T05:00:00.000Z',
  uploadedTimes: 1,
  reseller: { id: 'r1', code: 'RS-1', businessName: 'Kandy Traders' },
  activationRequest: {
    id: `ar-${reference}`,
    reference,
    status: 'UNDER_REVIEW',
    amount: '5500',
    currency: 'LKR',
    transactionRef: `TX-${reference}`,
    periodMonth: '2026-10',
    paymentVerifiedAt: null,
    product: { name: 'Hexalyte Salon' },
    customerAccount: { customer: { displayName: `Customer ${reference}` } },
  },
  ...over,
})
const listOf = (refs: string[], m = meta(1, 1, refs.length)) => ({ data: refs.map((r) => slip(r)), meta: m })

describe('Bank slips register page', () => {
  let calls: URLSearchParams[]
  let script: Step[]

  const open = async () => {
    const page = mountPage(PAGE, {
      'next/link': { __esModule: true, default: ({ href, children }: { href: string; children: unknown }) => jsx('a', { href, children }) },
      '@/lib/format': format,
      '@/lib/activation-types': activationTypes,
      '@/lib/api': {
        ApiError,
        apiRequest: async (url: string) => {
          calls.push(new URLSearchParams(url.split('?')[1]))
          const next = script.shift()
          if (!next) throw new Error(`unexpected extra request: ${url}`)
          return next()
        },
      },
      '@/components/admin/AdminPageHeader': { AdminPageHeader: ({ title }: { title: string }) => jsx('h1', { children: title }) },
      '@/components/ui/Modal': { Modal: ({ children }: { children: unknown }) => jsx('div', { className: 'modal', children }) },
      '@/components/activations/ActivationParts': {
        BankSlipViewer: ({ requestId, slip: s }: { requestId: string; slip: { id: string } }) => jsx('div', { className: 'viewer', children: `viewer:${requestId}/${s.id}` }),
      },
    })
    await page.settle()
    return page
  }

  const pages = () => calls.map((q) => Number(q.get('page')))
  const alerts = (page: Awaited<ReturnType<typeof open>>) => page.textOfClass('alert').map((t) => t.replace(/\s+/g, ' ').trim())

  beforeEach(() => {
    calls = []
    script = []
  })

  describe('baseline', () => {
    it('lists slips with request, customer, reseller, amount and file details, linking to the admin request page', async () => {
      script = [ok({ data: [slip('AR-AAA111'), slip('AR-BBB222', { uploadedTimes: 2, mimeType: 'image/png' })], meta: meta(1, 1, 2) })]
      const page = await open()
      assert.equal(calls[0].get('page'), '1')
      assert.equal(calls[0].get('limit'), '25')
      assert.equal(calls[0].get('status'), null)
      const text = page.text()
      assert.ok(text.includes('Customer AR-AAA111') && text.includes('Kandy Traders') && text.includes('TX-AR-AAA111'))
      assert.ok(text.includes('Same file used 2×'), 'a re-used file is flagged')
      assert.equal((text.match(/Same file used/g) ?? []).length, 1, 'only the re-used one')
      assert.deepEqual(page.links().map((l) => l.href), ['/admin/activations/ar-AR-AAA111', '/admin/activations/ar-AR-BBB222'])
    })

    it('sends the status filter and the "duplicates only" switch', async () => {
      script = [ok(listOf(['AR-AAA111'])), ok(listOf(['AR-AAA111'])), ok(listOf(['AR-AAA111']))]
      const page = await open()
      await page.fill('bs-status', 'PENDING_REVIEW,UNDER_REVIEW')
      assert.equal(calls[1].get('status'), 'PENDING_REVIEW,UNDER_REVIEW')
      await page.fill('bs-status', '')
      assert.equal(calls[2].get('status'), null)
    })

    it('opens the slip viewer for the chosen row with its request and slip ids, and closes it again', async () => {
      script = [ok(listOf(['AR-AAA111', 'AR-BBB222']))]
      const page = await open()
      assert.ok(!page.text().includes('viewer:'))
      const views = page.buttonLabels().filter((l) => l === 'View')
      assert.equal(views.length, 2)
      await page.click('View')
      assert.ok(page.text().includes('viewer:ar-AR-AAA111/slip-AR-AAA111'))
      await page.click('Close')
      assert.ok(!page.text().includes('viewer:'))
    })
  })

  describe('loading and failing', () => {
    it('shows "Loading…" while the first request is in flight, never "No bank slips found."', async () => {
      const pending = deferred<unknown>()
      script = [() => pending.promise]
      const page = await open()
      assert.ok(page.text().includes('Loading…'))
      assert.ok(!page.text().includes(EMPTY))
      pending.resolve(listOf(['AR-AAA111']))
      await page.settle()
      assert.ok(page.text().includes('AR-AAA111'))
      assert.ok(!page.text().includes('Loading…'))
    })

    it('shows the empty message once an empty result has arrived', async () => {
      script = [ok(listOf([], meta(1, 0, 0)))]
      const page = await open()
      assert.ok(page.text().includes(EMPTY))
      assert.deepEqual(pages(), [1])
    })

    it('a failed first load shows the error with Retry, not "Loading…" forever, and Retry recovers', async () => {
      script = [fail(new ApiError('Service unavailable', 503)), ok(listOf(['AR-AAA111']))]
      const page = await open()
      assert.deepEqual(alerts(page), ['Service unavailable Retry'])
      assert.ok(!page.text().includes('Loading…'))
      assert.ok(!page.text().includes(EMPTY))

      await page.click('Retry')
      assert.equal(calls.length, 2)
      assert.deepEqual(alerts(page), [])
      assert.ok(page.text().includes('AR-AAA111'))
    })

    it('a non-ApiError failure still gets a readable message', async () => {
      script = [fail(new TypeError('Failed to fetch'))]
      const page = await open()
      assert.deepEqual(alerts(page), ['Failed to load bank slips Retry'])
    })

    it('a failed reload drops the stale rows instead of showing them under the error, and Retry repeats the same filter', async () => {
      script = [ok(listOf(['AR-AAA111'])), fail(new ApiError('Gateway timeout', 504)), ok(listOf(['AR-BBB222']))]
      const page = await open()
      await page.fill('bs-status', 'APPROVED')
      assert.deepEqual(alerts(page), ['Gateway timeout Retry'])
      assert.ok(!page.text().includes('AR-AAA111'))
      await page.click('Retry')
      assert.equal(calls[2].get('status'), 'APPROVED')
      assert.ok(page.text().includes('AR-BBB222'))
    })

    it('disables Previous / Next while a page is loading', async () => {
      const second = deferred<unknown>()
      script = [ok(listOf(['AR-AAA111'], meta(1, 2, 30))), () => second.promise]
      const page = await open()
      await page.click('Next')
      assert.equal(page.isDisabled('Next'), true)
      assert.equal(page.isDisabled('Previous'), true)
      second.resolve(listOf(['AR-BBB222'], meta(2, 2, 30)))
      await page.settle()
      assert.equal(page.isDisabled('Previous'), false)
    })
  })

  describe('search and paging', () => {
    it('Search from a later page makes one request, for page 1, with the typed search', async () => {
      script = [
        ok(listOf(['AR-AAA111'], meta(1, 3, 60))),
        ok(listOf(['AR-BBB222'], meta(2, 3, 60))),
        ok(listOf(['AR-CCC333'], meta(3, 3, 60))),
        ok(listOf(['AR-FOUND01'], meta(1, 1, 1))),
        ok(listOf(['AR-EXTRA99'], meta(1, 1, 1))), // would be consumed by a second, stale request
      ]
      const page = await open()
      await page.click('Next')
      await page.click('Next')
      await page.fill('bs-search', '  kandy ')
      assert.equal(calls.length, 3, 'typing alone does not search')

      await page.submit()
      assert.equal(calls.length, 4, 'exactly one request for the search')
      assert.equal(calls[3].get('page'), '1')
      assert.equal(calls[3].get('search'), 'kandy')
      assert.ok(page.text().includes('AR-FOUND01'))
      assert.ok(!page.text().includes('AR-EXTRA99'))
    })

    it('Search on page 1 makes one request', async () => {
      script = [ok(listOf(['AR-AAA111'])), ok(listOf(['AR-FOUND01']))]
      const page = await open()
      await page.fill('bs-search', 'tx-1')
      await page.submit()
      assert.equal(calls.length, 2)
      assert.equal(calls[1].get('search'), 'tx-1')
      assert.ok(page.text().includes('AR-FOUND01'))
    })

    it('a page past the end is corrected to the last real page, without showing "No bank slips found."', async () => {
      const corrected = deferred<unknown>()
      script = [ok(listOf(['AR-AAA111'], meta(1, 2, 30))), ok({ data: [], meta: meta(2, 1, 25) }), () => corrected.promise]
      const page = await open()
      await page.click('Next')
      assert.deepEqual(pages(), [1, 2, 1])
      assert.ok(!page.text().includes(EMPTY))
      corrected.resolve(listOf(['AR-BBB222'], meta(1, 1, 25)))
      await page.settle()
      assert.ok(page.text().includes('AR-BBB222'))
      assert.deepEqual(pages(), [1, 2, 1])
    })

    it('an empty page that is still within the page count keeps Previous / Next', async () => {
      script = [
        ok(listOf(['AR-AAA111'], meta(1, 3, 60))),
        ok(listOf(['AR-BBB222'], meta(2, 3, 60))),
        ok({ data: [], meta: meta(3, 3, 60) }),
        ok(listOf(['AR-BBB222'], meta(2, 3, 60))),
      ]
      const page = await open()
      await page.click('Next')
      await page.click('Next')
      assert.ok(page.text().includes(EMPTY))
      assert.ok(page.hasButton('Previous'))
      await page.click('Previous')
      assert.deepEqual(pages(), [1, 2, 3, 2])
    })

    it('a genuinely empty list is requested once: no correction loop', async () => {
      script = [ok(listOf([], meta(1, 0, 0)))]
      await open()
      assert.deepEqual(pages(), [1])
    })
  })
})
