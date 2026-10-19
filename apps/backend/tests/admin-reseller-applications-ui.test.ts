import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { Fragment, hooks, jsx, mountPage } from './helpers/render-page'

/**
 * Admin → Partners → Applications (/admin/reseller-applications): the list page.
 *  - uses the shared Admin page header, the shared Pagination and the shared list-view helpers (paged-list);
 *  - opens on the Pending tab; tabs, search and paging all send one request for the right page, and a new filter or search returns to page 1;
 *  - "Loading…" while the first request is in flight; a failed load shows the error with Retry instead of "Loading…" forever;
 *  - an older, slower response can never overwrite a newer one; a page past the end after the list shrank moves to the last real page;
 *  - Review / View links and the Approved label for ACTIVE are unchanged.
 *
 * The real, unmodified page runs in Node through tests/helpers/render-page.ts against scripted API stubs.
 * Database-free; nothing here reads `.env`, runs Prisma or opens a connection.
 */

const PAGE = path.resolve(__dirname, '../../web/src/app/admin/reseller-applications/page.tsx')
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

const application = (code: string, over: Row = {}): Row => ({
  id: `id-${code}`,
  code,
  fullName: `Owner ${code}`,
  email: `${code.toLowerCase()}@test.invalid`,
  mobile: '+94770000000',
  businessName: `Trader ${code}`,
  businessRegistrationNo: `BR-${code}`,
  status: 'PENDING',
  submittedAt: '2026-10-01T09:00:00.000Z',
  reviewedAt: null,
  ...over,
})
const listOf = (codes: string[], meta: Row = {}, over: Row = {}) => ({
  success: true,
  data: codes.map((c) => application(c, over)),
  meta: { total: codes.length, page: 1, limit: 20, totalPages: 1, pendingCount: codes.length, ...meta },
})

describe('Partner applications page', () => {
  let calls: URLSearchParams[]
  let script: Step[]
  let pages: Array<{ unmount: () => void }>

  const open = async () => {
    const page = mountPage(PAGE, {
      react: { ...hooks, Fragment },
      'next/link': { __esModule: true, default: ({ href, children }: { href: string; children: unknown }) => jsx('a', { href, children }) },
      '@/lib/format': { formatDate: (v: string | null) => (v ? `date:${v.slice(0, 10)}` : '—') },
      '@/lib/paged-list': pagedList,
      '@/components/admin/AdminPageHeader': {
        AdminPageHeader: ({ title, subtitle, actions }: { title: string; subtitle?: unknown; actions?: unknown }) =>
          jsx('header', { className: 'admin-page-header', children: [jsx('h1', { children: title }), jsx('p', { children: subtitle }), actions] }),
      },
      '@/components/ui/EmptyState': { EmptyState: ({ title }: { title: string }) => jsx('div', { className: 'empty-state', children: title }) },
      '@/components/ui/Pagination': {
        Pagination: ({ meta, onPage, busy }: { meta: Row | null; onPage: (p: number) => void; busy?: boolean }) =>
          meta && meta.totalPages > 1
            ? jsx('nav', {
                className: 'pagination',
                children: [
                  jsx('span', { children: `Showing page ${meta.page} of ${meta.totalPages}` }),
                  jsx('button', { disabled: busy || meta.page <= 1, onClick: () => onPage(meta.page - 1), children: 'Prev' }),
                  jsx('button', { disabled: busy || meta.page >= meta.totalPages, onClick: () => onPage(meta.page + 1), children: 'Next' }),
                ],
              })
            : null,
      },
      '@/lib/api': {
        ApiError,
        apiRequest: async (url: string) => {
          assert.ok(url.startsWith('/admin/reseller-applications?'), `unexpected endpoint ${url}`)
          calls.push(new URLSearchParams(url.split('?')[1]))
          const next = script.shift()
          if (!next) throw new Error(`unexpected extra request: ${url}`)
          return next()
        },
      },
    })
    pages.push(page)
    await page.settle()
    return page
  }
  const alerts = (page: Awaited<ReturnType<typeof open>>) => page.textOfClass('alert error').map((t) => t.replace(/\s+/g, ' ').trim())

  beforeEach(() => {
    for (const p of pages ?? []) p.unmount()
    calls = []
    script = []
    pages = []
  })

  describe('shared Admin layout', () => {
    it('uses the shared page header, titled for the page, with a way back to the Partners list', async () => {
      script = [ok(listOf(['A1']))]
      const page = await open()
      assert.deepEqual(page.textOfClass('admin-page-header').length, 1)
      assert.ok(page.text().includes('Partner applications'))
      assert.ok(page.links().some((l) => l.href === '/admin/resellers'))
    })

    it('opens on the Pending tab: one request for page 1 of pending applications, 20 per page', async () => {
      script = [ok(listOf(['A1', 'A2']))]
      await open()
      assert.equal(calls.length, 1)
      assert.equal(calls[0].get('status'), 'PENDING')
      assert.equal(calls[0].get('page'), '1')
      assert.equal(calls[0].get('limit'), '20')
      assert.equal(calls[0].get('search'), null)
    })
  })

  describe('loading, errors and empty results', () => {
    it('shows "Loading…" while the first request is in flight, then the applications', async () => {
      const first = deferred<unknown>()
      script = [() => first.promise]
      const page = await open()
      assert.ok(page.text().includes('Loading…'))
      first.resolve(listOf(['A1']))
      await page.settle()
      assert.ok(!page.text().includes('Loading…'))
      assert.ok(page.text().includes('Trader A1'))
    })

    it('a failed first load shows the error with Retry, not "Loading…" forever; Retry loads the list', async () => {
      script = [fail(new ApiError('Server exploded', 500)), ok(listOf(['A1']))]
      const page = await open()
      assert.deepEqual(alerts(page), ['Server exploded Retry'])
      assert.ok(!page.text().includes('Loading…'))
      await page.click('Retry')
      assert.deepEqual(alerts(page), [])
      assert.ok(page.text().includes('Trader A1'))
      assert.equal(calls.length, 2)
    })

    it('a non-API failure falls back to a generic message', async () => {
      script = [fail(new Error('boom'))]
      const page = await open()
      assert.deepEqual(alerts(page), ['Failed to load applications Retry'])
    })

    it('an empty result shows the empty state instead of an empty table', async () => {
      script = [ok(listOf([], { total: 0, totalPages: 0, pendingCount: 0 }))]
      const page = await open()
      assert.deepEqual(page.textOfClass('empty-state'), ['No applications found'])
      assert.ok(!page.text().includes('Reference'))
    })
  })

  describe('rows', () => {
    it('shows reference, business, applicant and submitted date; pending rows say Review, decided rows say View', async () => {
      script = [
        ok({
          ...listOf(['A1']),
          data: [application('A1'), application('A2', { status: 'ACTIVE' }), application('A3', { status: 'REJECTED' })],
          meta: { total: 3, page: 1, limit: 20, totalPages: 1, pendingCount: 1 },
        }),
      ]
      const page = await open()
      const text = page.text()
      assert.ok(text.includes('A1') && text.includes('Trader A1') && text.includes('BR-A1') && text.includes('Owner A1') && text.includes('a1@test.invalid'))
      assert.ok(text.includes('date:2026-10-01'))
      const links = page.links()
      assert.deepEqual(links.find((l) => l.href === '/admin/reseller-applications/id-A1')?.text, 'Review')
      assert.deepEqual(links.find((l) => l.href === '/admin/reseller-applications/id-A2')?.text, 'View')
      assert.deepEqual(links.find((l) => l.href === '/admin/reseller-applications/id-A3')?.text, 'View')
      assert.ok(text.includes('APPROVED'), 'ACTIVE is shown to admins as Approved')
    })

    it('shows the number of pending applications on the Pending tab', async () => {
      script = [ok(listOf(['A1'], { pendingCount: 7 }))]
      const page = await open()
      assert.ok(page.hasButton('Pending (7)'))
    })
  })

  describe('tabs, search and paging', () => {
    it('each tab sends its status; the All tab sends none', async () => {
      script = [ok(listOf(['A1'])), ok(listOf(['A2'])), ok(listOf(['A3'])), ok(listOf(['A4']))]
      const page = await open()
      await page.click('Approved')
      assert.equal(calls[1].get('status'), 'ACTIVE')
      await page.click('Rejected')
      assert.equal(calls[2].get('status'), 'REJECTED')
      await page.click('All')
      assert.equal(calls[3].get('status'), null)
      assert.equal(calls.length, 4)
    })

    it('searching sends the trimmed text and keeps the current tab; a blank search clears it', async () => {
      script = [ok(listOf(['A1'])), ok(listOf(['A1'])), ok(listOf(['A1']))]
      const page = await open()
      await page.fill('app-search', '  Perera  ')
      assert.equal(calls.length, 1, 'typing alone does not search')
      await page.submit()
      assert.equal(calls[1].get('search'), 'Perera')
      assert.equal(calls[1].get('status'), 'PENDING')
      await page.fill('app-search', '   ')
      await page.submit()
      assert.equal(calls[2].get('search'), null)
    })

    it('Next and Prev move one page at a time and keep the tab and search', async () => {
      const meta = (p: number) => ({ total: 45, page: p, limit: 20, totalPages: 3, pendingCount: 45 })
      script = [ok(listOf(['A1'], meta(1))), ok(listOf(['A2'], meta(2))), ok(listOf(['A1'], meta(1)))]
      const page = await open()
      assert.ok(page.isDisabled('Prev'))
      await page.click('Next')
      assert.equal(calls[1].get('page'), '2')
      assert.equal(calls[1].get('status'), 'PENDING')
      await page.click('Prev')
      assert.equal(calls[2].get('page'), '1')
    })

    it('choosing a tab or searching from a later page goes back to page 1 with one request', async () => {
      const meta = (p: number) => ({ total: 45, page: p, limit: 20, totalPages: 3, pendingCount: 45 })
      script = [ok(listOf(['A1'], meta(1))), ok(listOf(['A2'], meta(2))), ok(listOf(['A3'], { pendingCount: 45 })), ok(listOf(['A4'], meta(1))), ok(listOf(['A5'], meta(2))), ok(listOf(['A6']))]
      const page = await open()
      await page.click('Next')
      await page.click('Approved')
      assert.equal(calls.length, 3)
      assert.equal(calls[2].get('page'), '1')
      assert.equal(calls[2].get('status'), 'ACTIVE')

      await page.click('Pending (45)')
      await page.click('Next')
      await page.fill('app-search', 'acme')
      await page.submit()
      assert.equal(calls.length, 6)
      assert.equal(calls[5].get('page'), '1')
      assert.equal(calls[5].get('search'), 'acme')
    })

    it('clicking the current tab on page 1 does not reload the list', async () => {
      script = [ok(listOf(['A1']))]
      const page = await open()
      await page.click('Pending (1)')
      assert.equal(calls.length, 1)
    })

    it('the paging buttons are disabled while a page is loading', async () => {
      const meta = (p: number) => ({ total: 45, page: p, limit: 20, totalPages: 3, pendingCount: 45 })
      const second = deferred<unknown>()
      script = [ok(listOf(['A1'], meta(1))), () => second.promise]
      const page = await open()
      await page.click('Next')
      assert.ok(page.isDisabled('Next') && page.isDisabled('Prev'))
      second.resolve(listOf(['A2'], meta(2)))
      await page.settle()
      assert.ok(!page.isDisabled('Prev'))
    })
  })

  describe('changing views quickly', () => {
    it('an older, slower response cannot overwrite the newer tab', async () => {
      const pending = deferred<unknown>()
      script = [ok(listOf(['P1'])), () => pending.promise, ok(listOf(['R1'], {}, { status: 'REJECTED' }))]
      const page = await open()
      await page.click('Approved') // slow
      await page.click('Rejected') // fast, newer
      assert.ok(page.text().includes('Trader R1'))
      pending.resolve(listOf(['SLOW'], {}, { status: 'ACTIVE' }))
      await page.settle()
      assert.ok(page.text().includes('Trader R1'))
      assert.ok(!page.text().includes('Trader SLOW'))
    })

    it('a stale failure does not replace newer results with an error', async () => {
      const slow = deferred<unknown>()
      script = [ok(listOf(['P1'])), () => slow.promise, ok(listOf(['R1']))]
      const page = await open()
      await page.click('Approved')
      await page.click('Rejected')
      slow.reject(new ApiError('stale failure', 500))
      await page.settle()
      assert.deepEqual(alerts(page), [])
      assert.ok(page.text().includes('Trader R1'))
    })

    it('when the list shrank and the current page is past the end, it moves to the last real page', async () => {
      script = [
        ok(listOf(['A1'], { total: 45, page: 1, limit: 20, totalPages: 3, pendingCount: 45 })),
        // page 2 was requested, but only 20 applications are left: the server answers an empty page past the end
        ok({ success: true, data: [], meta: { total: 20, page: 2, limit: 20, totalPages: 1, pendingCount: 20 } }),
        ok(listOf(['A1'], { total: 20, page: 1, limit: 20, totalPages: 1, pendingCount: 20 })),
      ]
      const page = await open()
      await page.click('Next')
      assert.equal(calls.length, 3)
      assert.equal(calls[1].get('page'), '2')
      assert.equal(calls[2].get('page'), '1', 'went back to the last real page')
      assert.ok(page.text().includes('Trader A1'))
      assert.ok(!page.text().includes('No applications found'), 'no flash of an empty page')
    })
  })
})
