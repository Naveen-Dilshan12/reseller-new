import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { jsx, mountPage } from './helpers/render-page'

/**
 * The notification inbox (Admin → Notifications, and the reseller's own inbox: one shared component).
 *  - "Loading…" while the first request is in flight; a failed load shows the error with Retry instead of "Loading…" forever,
 *    and a failed reload does not leave the previous list on screen under the error;
 *  - "Mark all as read" is available whenever the user has notifications, not only when the page on screen has unread ones
 *    (it marks every unread notification, wherever it is listed);
 *  - a failure to mark something read is reported separately from a failure to load, and the list stays;
 *  - an answer for a view the user has already left (Unread only toggled) is ignored;
 *  - only in-app paths become "Open" links.
 *
 * The real, unmodified component runs in Node through tests/helpers/render-page.ts against scripted API stubs.
 * Database-free; nothing here reads `.env`, runs Prisma or opens a connection.
 */

const COMPONENT = path.resolve(__dirname, '../../web/src/components/notifications/NotificationInbox.tsx')

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

const meta = (page: number, totalPages: number, total = totalPages * 30) => ({ total, page, limit: 30, totalPages })
const note = (id: string, over: Row = {}): Row => ({
  id,
  type: 'TEST',
  title: `Title ${id}`,
  body: `Body ${id}`,
  link: `/admin/activations/${id}`,
  readAt: null,
  createdAt: '2026-10-01T05:00:00.000Z',
  ...over,
})
const listOf = (ids: string[], m = meta(1, 1, ids.length), over: Row = {}) => ({ data: ids.map((i) => note(i, over)), meta: m })

describe('Notification inbox', () => {
  let calls: URLSearchParams[]
  let posts: string[]
  let events: string[]
  let listScript: Step[]
  let postScript: Record<string, Step[]>

  const open = async () => {
    const page = mountPage(
      COMPONENT,
      {
        'next/link': { __esModule: true, default: ({ href, children }: { href: string; children: unknown }) => jsx('a', { href, children }) },
        './NotificationBell': { NOTIFICATIONS_CHANGED: 'hxr:notifications-changed' },
        '@/components/ui/EmptyState': { EmptyState: ({ title }: { title: string }) => jsx('div', { className: 'empty', children: title }) },
        '@/components/ui/Pagination': {
          Pagination: ({ meta: m, onPage }: { meta: { page: number; totalPages: number } | null; onPage: (p: number) => void }) =>
            !m || m.totalPages <= 1
              ? null
              : jsx('nav', {
                  children: [
                    jsx('button', { disabled: m.page <= 1, onClick: () => onPage(m.page - 1), children: '← Prev' }),
                    jsx('button', { disabled: m.page >= m.totalPages, onClick: () => onPage(m.page + 1), children: 'Next →' }),
                  ],
                }),
        },
        '@/lib/api': {
          ApiError,
          apiRequest: async (url: string) => {
            calls.push(new URLSearchParams(url.split('?')[1]))
            const next = listScript.shift()
            if (!next) throw new Error(`unexpected extra list request: ${url}`)
            return next()
          },
          api: async (url: string) => {
            posts.push(url)
            const next = postScript[url]?.shift()
            if (!next) throw new Error(`unexpected request: ${url}`)
            return next()
          },
        },
      },
      { exportName: 'NotificationInbox' },
    )
    await page.settle()
    return page
  }
  const alerts = (page: Awaited<ReturnType<typeof open>>) => page.textOfClass('alert').map((t) => t.replace(/\s+/g, ' ').trim())

  beforeEach(() => {
    calls = []
    posts = []
    events = []
    listScript = []
    postScript = {}
    ;(globalThis as any).window = { dispatchEvent: (e: { type: string }) => events.push(e.type) }
  })
  afterEach(() => {
    delete (globalThis as any).window
  })

  describe('baseline', () => {
    it('asks for the first page of 30 and lists the notifications, flagging the unread ones', async () => {
      listScript = [ok({ data: [note('n1'), note('n2', { readAt: '2026-10-02T00:00:00.000Z' })], meta: meta(1, 1, 2) })]
      const page = await open()
      assert.equal(calls[0].get('page'), '1')
      assert.equal(calls[0].get('limit'), '30')
      assert.equal(calls[0].get('unread'), null)
      const text = page.text()
      assert.ok(text.includes('Title n1') && text.includes('Body n1') && text.includes('Title n2'))
      assert.equal((text.match(/\(unread\)/g) ?? []).length, 1, 'only the unread one is flagged')
      assert.equal(page.buttonLabels().filter((l) => l === 'Mark read').length, 1)
    })

    it('marks one notification read in place, without reloading the list, and tells the bell', async () => {
      listScript = [ok(listOf(['n1', 'n2']))]
      postScript = { '/notifications/n1/read': [ok(null)] }
      const page = await open()
      await page.click('Mark read')
      assert.deepEqual(posts, ['/notifications/n1/read'])
      assert.equal(page.buttonLabels().filter((l) => l === 'Mark read').length, 1, 'n1 is read, n2 still is not')
      assert.equal(calls.length, 1)
      assert.deepEqual(events, ['hxr:notifications-changed'])
    })

    it('"Unread only" asks for unread notifications from page 1, and says so when there are none', async () => {
      listScript = [ok(listOf(['n1'], meta(1, 2, 31))), ok(listOf([], meta(1, 0, 0)))]
      const page = await open()
      await page.toggle('ni-unread', true)
      assert.equal(calls[1].get('unread'), 'true')
      assert.equal(calls[1].get('page'), '1')
      assert.ok(page.text().includes('No unread notifications'))
    })

    it('only in-app paths become "Open" links', async () => {
      listScript = [
        ok({
          data: [
            note('ok1', { link: '/admin/activations/ar1' }),
            note('bad1', { link: '//evil.example/x' }),
            note('bad2', { link: 'https://evil.example/x' }),
            note('bad3', { link: '/\\evil.example/x' }),
            note('bad4', { link: '\\\\evil.example\\x' }),
            note('none', { link: null }),
          ],
          meta: meta(1, 1, 6),
        }),
      ]
      const page = await open()
      assert.deepEqual(page.links().map((l) => l.href), ['/admin/activations/ar1'])
    })
  })

  describe('loading and failing', () => {
    it('shows "Loading…" while the first request is in flight, never the empty state', async () => {
      const pending = deferred<unknown>()
      listScript = [() => pending.promise]
      const page = await open()
      assert.ok(page.text().includes('Loading…'))
      assert.ok(!page.text().includes('No notifications yet'))
      pending.resolve(listOf(['n1']))
      await page.settle()
      assert.ok(page.text().includes('Title n1'))
      assert.ok(!page.text().includes('Loading…'))
    })

    it('a failed first load shows the error with Retry, not "Loading…" forever, and Retry recovers', async () => {
      listScript = [fail(new ApiError('Service unavailable', 503)), ok(listOf(['n1']))]
      const page = await open()
      assert.deepEqual(alerts(page), ['Service unavailable Retry'])
      assert.ok(!page.text().includes('Loading…'))
      assert.ok(!page.text().includes('No notifications yet'))

      await page.click('Retry')
      assert.equal(calls.length, 2)
      assert.deepEqual(alerts(page), [])
      assert.ok(page.text().includes('Title n1'))
    })

    it('a non-ApiError failure still gets a readable message', async () => {
      listScript = [fail(new TypeError('Failed to fetch'))]
      const page = await open()
      assert.deepEqual(alerts(page), ['Failed to load notifications Retry'])
    })

    it('a failed reload drops the previous list instead of showing it under the error, and Retry repeats the same view', async () => {
      listScript = [ok(listOf(['n1'])), fail(new ApiError('Gateway timeout', 504)), ok(listOf(['n2']))]
      const page = await open()
      await page.toggle('ni-unread', true)
      assert.deepEqual(alerts(page), ['Gateway timeout Retry'])
      assert.ok(!page.text().includes('Title n1'))
      await page.click('Retry')
      assert.equal(calls[2].get('unread'), 'true')
      assert.ok(page.text().includes('Title n2'))
    })

    it('ignores a late answer for a view the user has already left', async () => {
      const slow = deferred<unknown>()
      listScript = [ok(listOf(['all1'])), () => slow.promise, ok(listOf(['all2']))]
      const page = await open()
      await page.toggle('ni-unread', true)
      await page.toggle('ni-unread', false)
      assert.ok(page.text().includes('Title all2'))
      slow.resolve(listOf(['unread1']))
      await page.settle()
      assert.ok(!page.text().includes('Title unread1'), 'the unread-only answer arrived after the user went back to all')
      assert.ok(page.text().includes('Title all2'))
    })

    it('a late failure for a view the user has left does not replace the list on screen', async () => {
      const slow = deferred<unknown>()
      listScript = [ok(listOf(['all1'])), () => slow.promise, ok(listOf(['all2']))]
      const page = await open()
      await page.toggle('ni-unread', true)
      await page.toggle('ni-unread', false)
      slow.reject(new ApiError('late failure', 500))
      await page.settle()
      assert.deepEqual(alerts(page), [])
      assert.ok(page.text().includes('Title all2'))
    })
  })

  describe('Mark all as read', () => {
    it('is available when the page on screen has no unread notifications but others exist (it marks all of them)', async () => {
      listScript = [ok({ data: [note('n1', { readAt: '2026-10-02T00:00:00.000Z' })], meta: meta(1, 2, 31) }), ok(listOf([]))]
      postScript = { '/notifications/read-all': [ok({ updated: 1 })] }
      const page = await open()
      assert.equal(page.isDisabled('Mark all as read'), false)
      await page.click('Mark all as read')
      assert.deepEqual(posts, ['/notifications/read-all'])
      assert.equal(calls.length, 2, 'the list is reloaded')
      assert.deepEqual(events, ['hxr:notifications-changed'])
    })

    it('is disabled when there are no notifications at all', async () => {
      listScript = [ok(listOf([], meta(1, 0, 0)))]
      const page = await open()
      assert.equal(page.isDisabled('Mark all as read'), true)
      assert.ok(page.text().includes('No notifications yet'))
    })

    it('is disabled in the Unread only view when nothing is unread', async () => {
      listScript = [ok(listOf(['n1'])), ok(listOf([], meta(1, 0, 0)))]
      const page = await open()
      await page.toggle('ni-unread', true)
      assert.equal(page.isDisabled('Mark all as read'), true)
    })

    it('reloads the Unread only view, which becomes empty', async () => {
      listScript = [ok(listOf(['n1', 'n2'])), ok(listOf(['n1', 'n2'])), ok(listOf([], meta(1, 0, 0)))]
      postScript = { '/notifications/read-all': [ok({ updated: 2 })] }
      const page = await open()
      await page.toggle('ni-unread', true)
      await page.click('Mark all as read')
      assert.equal(calls[2].get('unread'), 'true')
      assert.ok(page.text().includes('No unread notifications'))
    })

    it('reports a failure without a Retry that would only reload the list, and keeps the list', async () => {
      listScript = [ok(listOf(['n1']))]
      postScript = { '/notifications/read-all': [fail(new ApiError('Could not reach the server', 500))] }
      const page = await open()
      await page.click('Mark all as read')
      assert.deepEqual(alerts(page), ['Could not reach the server'])
      assert.ok(page.text().includes('Title n1'))
      assert.equal(page.hasButton('Retry'), false)
      assert.equal(page.isDisabled('Mark all as read'), false, 'the user can try again')
      assert.deepEqual(events, [])
    })
  })

  describe('marking one read fails', () => {
    it('is reported without a Retry that would only reload the list, keeps the list, and clears once a load succeeds', async () => {
      listScript = [ok(listOf(['n1'])), ok(listOf(['n1']))]
      postScript = { '/notifications/n1/read': [fail(new ApiError('Could not reach the server', 500))] }
      const page = await open()
      await page.click('Mark read')
      assert.deepEqual(alerts(page), ['Could not reach the server'])
      assert.ok(page.text().includes('Title n1'))
      assert.equal(page.hasButton('Retry'), false)
      assert.equal(page.buttonLabels().filter((l) => l === 'Mark read').length, 1, 'still unread, can be tried again')
      assert.deepEqual(events, [])

      await page.toggle('ni-unread', true)
      assert.deepEqual(alerts(page), [], 'the message goes away when the view is reloaded')
    })
  })
})
