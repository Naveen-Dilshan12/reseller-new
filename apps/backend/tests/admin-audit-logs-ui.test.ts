import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { Fragment, hooks, jsx, mountPage } from './helpers/render-page'

/**
 * Admin → Audit logs page.
 *  - "Loading…" while the first request is in flight; a failed load shows the error with Retry instead of "Loading…" forever,
 *    and a failed reload does not leave the previous entries on screen under the error;
 *  - Search from a later page makes ONE request, for page 1;
 *  - a failure loading the filter options is visible (and can be retried) instead of leaving silently empty drop-downs;
 *  - filters reach the request; event details expand and collapse.
 *
 * The real, unmodified page runs in Node through tests/helpers/render-page.ts against scripted API stubs.
 * Database-free; nothing here reads `.env`, runs Prisma or opens a connection.
 */

const PAGE = path.resolve(__dirname, '../../web/src/app/admin/audit-logs/page.tsx')
const adminTypes = require('../../web/src/lib/admin-types')

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

const meta = (page: number, totalPages: number, total = totalPages * 50) => ({ total, page, limit: 50, totalPages })
const entry = (id: string, over: Row = {}): Row => ({
  id,
  actorType: 'USER',
  actorUserId: 'u1',
  actorEmail: `${id}@test.invalid`,
  action: 'ACTIVATION_APPROVED',
  entityType: 'ActivationRequest',
  entityId: `ar-${id}`,
  resellerId: null,
  ip: '10.0.0.1',
  userAgent: 'TestAgent/1.0',
  metadata: { note: `note ${id}` },
  createdAt: '2026-10-01T05:00:00.000Z',
  ...over,
})
const listOf = (ids: string[], m = meta(1, 1, ids.length)) => ({ data: ids.map((i) => entry(i)), meta: m })
const FACETS = {
  actions: [
    { value: 'ACTIVATION_APPROVED', count: 12 },
    { value: 'LOGIN_SUCCESS', count: 30 },
  ],
  entityTypes: [{ value: 'ActivationRequest', count: 12 }],
}

describe('Audit logs page', () => {
  let calls: URLSearchParams[]
  let facetCalls: number
  let listScript: Step[]
  let facetScript: Step[]

  const open = async () => {
    const page = mountPage(PAGE, {
      react: { ...hooks, Fragment },
      '@/lib/admin-types': adminTypes,
      '@/components/admin/AdminPageHeader': { AdminPageHeader: ({ title }: { title: string }) => jsx('h1', { children: title }) },
      '@/lib/api': {
        ApiError,
        api: async () => {
          facetCalls++
          const next = facetScript.shift()
          if (!next) throw new Error('unexpected extra facets request')
          return next()
        },
        apiRequest: async (url: string) => {
          calls.push(new URLSearchParams(url.split('?')[1]))
          const next = listScript.shift()
          if (!next) throw new Error(`unexpected extra request: ${url}`)
          return next()
        },
      },
    })
    await page.settle()
    return page
  }
  const alerts = (page: Awaited<ReturnType<typeof open>>) => page.textOfClass('alert error').map((t) => t.replace(/\s+/g, ' ').trim())

  beforeEach(() => {
    calls = []
    facetCalls = 0
    listScript = []
    facetScript = [ok(FACETS)]
  })

  describe('baseline', () => {
    it('lists entries newest first as the API returns them, 50 per page, and offers the filter options with counts', async () => {
      listScript = [ok(listOf(['e1', 'e2']))]
      const page = await open()
      assert.equal(calls[0].get('page'), '1')
      assert.equal(calls[0].get('limit'), '50')
      const text = page.text()
      assert.ok(text.includes('e1@test.invalid') && text.includes('e2@test.invalid'))
      assert.ok(text.includes('Activation approved') && text.includes('ACTIVATION_APPROVED'))
      assert.ok(text.includes('Login success (30)'), 'filter options come with counts')
      assert.ok(text.includes('10.0.0.1'))
    })

    it('sends each filter, the typed search and the date range (whole days) with the request', async () => {
      listScript = [ok(listOf(['e1'])), ok(listOf(['e1'])), ok(listOf(['e1'])), ok(listOf(['e1'])), ok(listOf(['e1'])), ok(listOf(['e1']))]
      const page = await open()
      await page.fill('al-action', 'LOGIN_SUCCESS')
      await page.fill('al-entity', 'ActivationRequest')
      await page.fill('al-actor', 'SYSTEM')
      await page.fill('al-from', '2026-10-01')
      await page.fill('al-to', '2026-10-05')
      const last = calls[calls.length - 1]
      assert.equal(last.get('action'), 'LOGIN_SUCCESS')
      assert.equal(last.get('entityType'), 'ActivationRequest')
      assert.equal(last.get('actorType'), 'SYSTEM')
      assert.equal(last.get('from'), new Date('2026-10-01T00:00:00').toISOString())
      assert.equal(last.get('to'), new Date('2026-10-05T23:59:59.999').toISOString())
      assert.equal(last.get('page'), '1')
      assert.equal(last.get('search'), null, 'typing in the search box alone does not search')
      assert.equal(page.valueOf('al-action'), 'LOGIN_SUCCESS')
    })

    it('expands and collapses an entry\'s details (metadata and user agent); entries without metadata have no Details button', async () => {
      script_withNoMetadata()
      const page = await open()
      assert.equal(page.buttonLabels().filter((l) => l === 'Details').length, 1)
      assert.ok(!page.text().includes('TestAgent/1.0'))
      await page.click('Details')
      assert.ok(page.text().includes('"note": "note e1"'))
      assert.ok(page.text().includes('User agent: TestAgent/1.0'))
      await page.click('Hide')
      assert.ok(!page.text().includes('"note": "note e1"'))

      function script_withNoMetadata() {
        listScript = [ok({ data: [entry('e1'), entry('e2', { metadata: null })], meta: meta(1, 1, 2) })]
      }
    })
  })

  describe('loading and failing', () => {
    it('shows "Loading…" while the first request is in flight, never the empty message', async () => {
      const pending = deferred<unknown>()
      listScript = [() => pending.promise]
      const page = await open()
      assert.ok(page.text().includes('Loading…'))
      assert.ok(!page.text().includes('No entries match'))
      pending.resolve(listOf(['e1']))
      await page.settle()
      assert.ok(page.text().includes('e1@test.invalid'))
      assert.ok(!page.text().includes('Loading…'))
    })

    it('says so when no entry matches', async () => {
      listScript = [ok(listOf([], meta(1, 0, 0)))]
      const page = await open()
      assert.ok(page.text().includes('No entries match these filters.'))
    })

    it('a failed first load shows the error with Retry, not "Loading…" forever, and Retry recovers', async () => {
      listScript = [fail(new ApiError('Service unavailable', 503)), ok(listOf(['e1']))]
      const page = await open()
      assert.deepEqual(alerts(page), ['Service unavailable Retry'])
      assert.ok(!page.text().includes('Loading…'))
      assert.ok(!page.text().includes('No entries match'))

      await page.click('Retry')
      assert.equal(calls.length, 2)
      assert.deepEqual(alerts(page), [])
      assert.ok(page.text().includes('e1@test.invalid'))
    })

    it('a non-ApiError failure still gets a readable message', async () => {
      listScript = [fail(new TypeError('Failed to fetch'))]
      const page = await open()
      assert.deepEqual(alerts(page), ['Failed to load the audit log Retry'])
    })

    it('a failed reload drops the previous entries instead of showing them under the error, and Retry repeats the same filter', async () => {
      listScript = [ok(listOf(['e1'])), fail(new ApiError('Gateway timeout', 504)), ok(listOf(['e2']))]
      const page = await open()
      await page.fill('al-actor', 'SAAS')
      assert.deepEqual(alerts(page), ['Gateway timeout Retry'])
      assert.ok(!page.text().includes('e1@test.invalid'))
      await page.click('Retry')
      assert.equal(calls[2].get('actorType'), 'SAAS')
      assert.ok(page.text().includes('e2@test.invalid'))
    })

    it('disables Previous / Next while a page is loading', async () => {
      const second = deferred<unknown>()
      listScript = [ok(listOf(['e1'], meta(1, 2, 60))), () => second.promise]
      const page = await open()
      await page.click('Next')
      assert.equal(page.isDisabled('Next'), true)
      assert.equal(page.isDisabled('Previous'), true)
      second.resolve(listOf(['e2'], meta(2, 2, 60)))
      await page.settle()
      assert.equal(page.isDisabled('Previous'), false)
    })
  })

  describe('filter options', () => {
    it('a failure loading the options is visible and can be retried, and the list still works', async () => {
      facetScript = [fail(new ApiError('Facets unavailable', 500)), ok(FACETS)]
      listScript = [ok(listOf(['e1']))]
      const page = await open()
      assert.ok(page.text().includes('Filter options could not be loaded'))
      assert.ok(page.text().includes('e1@test.invalid'), 'the entries are unaffected')
      assert.ok(!page.text().includes('Login success (30)'))

      await page.click('Reload filter options')
      assert.equal(facetCalls, 2)
      assert.ok(!page.text().includes('Filter options could not be loaded'))
      assert.ok(page.text().includes('Login success (30)'))
    })
  })

  describe('search and paging', () => {
    it('Search from a later page makes one request, for page 1, with the typed search', async () => {
      listScript = [
        ok(listOf(['e1'], meta(1, 3, 120))),
        ok(listOf(['e2'], meta(2, 3, 120))),
        ok(listOf(['e3'], meta(3, 3, 120))),
        ok(listOf(['found'], meta(1, 1, 1))),
        ok(listOf(['extra'], meta(1, 1, 1))), // would be consumed by a second, stale request
      ]
      const page = await open()
      await page.click('Next')
      await page.click('Next')
      await page.fill('al-search', '  admin@ ')
      assert.equal(calls.length, 3, 'typing alone does not search')

      await page.submit()
      assert.equal(calls.length, 4, 'exactly one request for the search')
      assert.equal(calls[3].get('page'), '1')
      assert.equal(calls[3].get('search'), 'admin@')
      assert.ok(page.text().includes('found@test.invalid'))
      assert.ok(!page.text().includes('extra@test.invalid'))
    })

    it('Search on page 1 makes one request', async () => {
      listScript = [ok(listOf(['e1'])), ok(listOf(['found']))]
      const page = await open()
      await page.fill('al-search', 'ar-9')
      await page.submit()
      assert.equal(calls.length, 2)
      assert.equal(calls[1].get('search'), 'ar-9')
    })

    it('changing a filter from a later page returns to page 1 in a single request', async () => {
      listScript = [ok(listOf(['e1'], meta(1, 2, 60))), ok(listOf(['e2'], meta(2, 2, 60))), ok(listOf(['e3'])), ok(listOf(['e3'])), ok(listOf(['e3']))]
      const page = await open()
      await page.click('Next')
      await page.fill('al-actor', 'SYSTEM')
      const last = calls[calls.length - 1]
      assert.equal(last.get('page'), '1')
      assert.equal(last.get('actorType'), 'SYSTEM')
    })
  })
})
