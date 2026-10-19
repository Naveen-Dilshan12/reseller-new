import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { jsx, mountPage } from './helpers/render-page'

/**
 * Admin → Activation requests: the list (shared ActivationList component, also used by the partner's own list).
 *  - "Loading…" while the first request is in flight; a failed load shows the error with Retry instead of "Loading…" forever;
 *  - a page that no longer exists is corrected to the last real page, and an empty page keeps its Prev / Next controls;
 *  - "Clear filters" reloads the list even when only a search was applied;
 *  - the empty state speaks to the right audience and says when filters hide everything.
 *
 * The real, unmodified component runs in Node through tests/helpers/render-page.ts against scripted API stubs.
 * Database-free; nothing here reads `.env`, runs Prisma or opens a connection.
 */

const LIST = path.resolve(__dirname, '../../web/src/components/activations/ActivationList.tsx')
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

const EMPTY = 'No activation requests found'
const NEEDS_REVIEW = 'PENDING_REVIEW,UNDER_REVIEW'
const meta = (page: number, totalPages: number, total = totalPages * 25) => ({
  total,
  page,
  limit: 25,
  totalPages,
  pipelineCounts: { total: 40, pendingReview: 3, underReview: 2, completed: 30 },
})
const request = (reference: string, over: Row = {}): Row => ({
  id: `id-${reference}`,
  reference,
  status: 'PENDING_REVIEW',
  periodMonth: '2026-10',
  amount: '5500',
  currency: 'LKR',
  transactionRef: 'TX-1',
  submittedAt: '2026-10-01T05:00:00.000Z',
  paymentVerifiedAt: null,
  activatedAt: null,
  product: { id: 'p1', code: 'SALON', name: 'Hexalyte Salon' },
  reseller: { id: 'r1', code: 'RS-1', businessName: 'Kandy Traders' },
  customerAccount: { id: 'a1', externalTenantId: 't1', customer: { id: 'c1', displayName: `Customer ${reference}` } },
  ...over,
})
const listOf = (refs: string[], m = meta(1, 1, refs.length)) => ({ data: refs.map((r) => request(r)), meta: m })

describe('Activation requests list', () => {
  let calls: URLSearchParams[]
  let script: Step[]

  const open = async (props: Row = { basePath: '/admin/activations', showReseller: true, defaultStatus: NEEDS_REVIEW }) => {
    const page = mountPage(
      LIST,
      {
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
        '@/components/PageHero': { PageHero: ({ children }: { children: unknown }) => jsx('div', { children }) },
        '@/components/ui/KpiRefCard': {
          KpiGrid: ({ children }: { children: unknown }) => jsx('div', { className: 'kpi-grid', children }),
          KpiRefCard: ({ label, value, onClick }: { label: string; value: unknown; onClick: () => void }) =>
            jsx('div', { children: [jsx('button', { onClick, children: label }), jsx('span', { className: 'kpi-value', children: String(value) })] }),
        },
        '@/components/ui/EmptyState': {
          EmptyState: ({ title, hint, children }: { title: string; hint: string; children: unknown }) =>
            jsx('div', { className: 'empty', children: [jsx('strong', { children: title }), jsx('span', { children: hint }), children] }),
        },
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
      },
      { exportName: 'ActivationList', props },
    )
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
    it('asks for the first page of the default status filter and shows rows linking to the admin detail page', async () => {
      script = [ok(listOf(['AR-AAA111']))]
      const page = await open()
      assert.equal(calls[0].get('status'), NEEDS_REVIEW)
      assert.equal(calls[0].get('page'), '1')
      assert.equal(calls[0].get('limit'), '25')
      assert.equal(calls[0].get('search'), null)
      assert.ok(page.text().includes('Customer AR-AAA111'))
      assert.ok(page.text().includes('Kandy Traders'), 'admins see the partner column')
      assert.deepEqual(page.links().map((l) => l.href), ['/admin/activations/id-AR-AAA111'])
    })

    it('shows the server\'s pipeline counts in the KPI cards, not just the rows on this page', async () => {
      script = [ok(listOf(['AR-AAA111'], meta(1, 1, 1)))]
      const page = await open()
      assert.deepEqual(page.textOfClass('kpi-value'), ['40', '3', '2', '30'])
    })
  })

  describe('loading and failing', () => {
    it('shows "Loading…" while the first request is in flight, never the empty state', async () => {
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
      assert.deepEqual(alerts(page), ['Failed to load activation requests Retry'])
    })

    it('a failed reload drops the stale rows and counts instead of showing them under the error', async () => {
      script = [ok(listOf(['AR-AAA111'])), fail(new ApiError('Gateway timeout', 504)), ok(listOf(['AR-BBB222']))]
      const page = await open()
      assert.ok(page.text().includes('AR-AAA111'))

      await page.fill('ar-status', 'APPROVED')
      assert.deepEqual(alerts(page), ['Gateway timeout Retry'])
      assert.ok(!page.text().includes('AR-AAA111'))
      assert.deepEqual(page.textOfClass('kpi-value'), ['—', '—', '—', '—'])

      await page.click('Retry')
      assert.equal(calls[2].get('status'), 'APPROVED', 'Retry repeats the same filter')
      assert.ok(page.text().includes('AR-BBB222'))
    })
  })

  describe('pagination when the current page is empty', () => {
    it('a page past the end is corrected to the last real page, without showing "no requests"', async () => {
      const corrected = deferred<unknown>()
      script = [ok(listOf(['AR-AAA111'], meta(1, 2, 30))), ok({ data: [], meta: meta(2, 1, 25) }), () => corrected.promise]
      const page = await open()
      await page.click('Next →')
      assert.deepEqual(pages(), [1, 2, 1])
      assert.ok(!page.text().includes(EMPTY))
      corrected.resolve(listOf(['AR-BBB222'], meta(1, 1, 25)))
      await page.settle()
      assert.ok(page.text().includes('AR-BBB222'))
      assert.deepEqual(pages(), [1, 2, 1])
    })

    it('an empty page that is still within the page count keeps Prev / Next', async () => {
      script = [
        ok(listOf(['AR-AAA111'], meta(1, 3, 60))),
        ok(listOf(['AR-BBB222'], meta(2, 3, 60))),
        ok({ data: [], meta: meta(3, 3, 60) }),
        ok(listOf(['AR-BBB222'], meta(2, 3, 60))),
      ]
      const page = await open()
      await page.click('Next →')
      await page.click('Next →')
      assert.ok(page.text().includes(EMPTY))
      assert.ok(page.hasButton('← Prev'))
      await page.click('← Prev')
      assert.deepEqual(pages(), [1, 2, 3, 2])
    })

    it('a genuinely empty list is requested once: no correction loop', async () => {
      script = [ok({ data: [], meta: meta(1, 0, 0) })]
      const page = await open()
      assert.deepEqual(pages(), [1])
      assert.ok(page.text().includes(EMPTY))
      assert.equal(page.hasButton('Next →'), false)
    })
  })

  describe('Clear filters', () => {
    it('reloads without the search even when the status filter is already "All"', async () => {
      script = [
        ok(listOf(['AR-AAA111'])), // mount (Needs review)
        ok(listOf(['AR-AAA111'])), // status → Approved (applies the typed search)
        ok(listOf([])), //            status → All
        ok(listOf(['AR-AAA111', 'AR-BBB222'])), // Clear filters
      ]
      const page = await open()
      await page.fill('ar-search', 'zzz')
      await page.fill('ar-status', 'APPROVED')
      await page.fill('ar-status', '')
      assert.equal(calls[2].get('status'), null)
      assert.equal(calls[2].get('search'), 'zzz', 'the search is applied and the list is filtered by it')

      await page.click('Clear filters')
      assert.equal(calls.length, 4, 'clearing the search must reload the list')
      assert.equal(calls[3].get('search'), null)
      assert.equal(calls[3].get('status'), null)
      assert.equal(page.valueOf('ar-search'), '')
      assert.ok(page.text().includes('AR-BBB222'))
      assert.equal(page.hasButton('Clear filters'), false)
    })

    // The page harness applies state updates one by one (a browser batches them), so these two check where the list ends up:
    // the last request and what is on screen, not how many requests it took to get there.
    const final = ok(listOf(['AR-FINAL99']))

    it('ends on page 1 of the unfiltered list when a status filter was active on a later page', async () => {
      script = [ok(listOf(['AR-AAA111'], meta(1, 2, 30))), ok(listOf(['AR-BBB222'], meta(2, 2, 30))), final, final, final]
      const page = await open()
      await page.click('Next →')
      await page.click('Clear filters')
      const last = calls[calls.length - 1]
      assert.equal(last.get('page'), '1')
      assert.equal(last.get('status'), null)
      assert.equal(last.get('search'), null)
      assert.ok(page.text().includes('AR-FINAL99'))
    })

    it('ends on page 1 without the search when the status is already "All" and the admin is on a later page', async () => {
      script = [ok(listOf(['AR-AAA111'], meta(1, 2, 30))), ok(listOf(['AR-AAA111'], meta(1, 2, 30))), ok(listOf(['AR-BBB222'], meta(2, 2, 30))), final, final, final]
      const page = await open()
      await page.fill('ar-status', '')
      await page.fill('ar-search', 'x')
      await page.click('Next →')
      assert.equal(calls[calls.length - 1].get('search'), 'x', 'the typed search is applied with the page change')
      await page.click('Clear filters')
      const last = calls[calls.length - 1]
      assert.equal(last.get('page'), '1')
      assert.equal(last.get('search'), null)
      assert.ok(page.text().includes('AR-FINAL99'))
    })
  })

  describe('empty state', () => {
    it('tells an admin that resellers\' requests will appear here, not to submit payment slips', async () => {
      script = [ok(listOf([], meta(1, 0, 0)))]
      const page = await open({ basePath: '/admin/activations', showReseller: true })
      const text = page.text()
      assert.ok(text.includes(EMPTY))
      assert.ok(text.includes('Requests submitted by partners will appear here'))
      assert.ok(!text.includes('Submit customer payment slips'))
      assert.equal(page.links().length, 0, 'no "New Activation Request" link on the admin list')
    })

    it('says when the current filters hide everything', async () => {
      script = [ok(listOf([], meta(1, 0, 0)))]
      const page = await open()
      assert.ok(page.text().includes('No requests match the current filters'))
    })

    it('keeps the partner wording and the New Activation Request link on the reseller\'s own list', async () => {
      script = [ok(listOf([], meta(1, 0, 0)))]
      const page = await open({ basePath: '/activations' })
      assert.ok(page.text().includes('Submit customer payment slips to activate SaaS subscriptions'))
      assert.deepEqual(page.links().map((l) => l.href), ['/activations/new'])
    })

    it('reseller rows link to the partner detail page', async () => {
      script = [ok(listOf(['AR-AAA111']))]
      const page = await open({ basePath: '/activations' })
      assert.deepEqual(page.links().map((l) => l.href), ['/activations/id-AR-AAA111'])
      assert.ok(!page.text().includes('Kandy Traders'), 'no partner column for partners')
    })
  })
})
