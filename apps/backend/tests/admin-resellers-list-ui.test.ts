import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Admin → Resellers page: the list-view logic that decides which request is sent and which response is shown.
 *
 * The web app has no test runner and no DOM here, so this logic lives in a dependency-free module
 * (apps/web/src/lib/paged-list.ts) that the page calls, and is tested directly. The last block checks that the
 * page really goes through that module. Pure and database-free: no backend module, `.env` or connection is touched.
 */

type Lib = typeof import('../../web/src/lib/paged-list')
let lib: Lib
const PAGE = path.resolve(__dirname, '../../web/src/app/admin/resellers/page.tsx')

const deferred = <T>() => {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}
const settle = () => new Promise<void>((r) => setImmediate(r))

before(async () => {
  lib = await import('../../web/src/lib/paged-list')
})

describe('list view state: filters and search always return to page 1', () => {
  it('starts on page 1 with no filter and no search', () => {
    assert.deepEqual(lib.INITIAL_LIST_VIEW, { status: '', query: '', page: 1 })
  })

  it('choosing a status tab goes back to page 1 and keeps the search', () => {
    assert.deepEqual(lib.withStatus({ status: '', query: 'acme', page: 3 }, 'ACTIVE'), { status: 'ACTIVE', query: 'acme', page: 1 })
    assert.deepEqual(lib.withStatus({ status: 'ACTIVE', query: '', page: 2 }, ''), { status: '', query: '', page: 1 }, 'the All tab clears the status')
  })

  it('clicking the current tab on a later page also goes back to page 1; on page 1 it is a no-op', () => {
    assert.deepEqual(lib.withStatus({ status: 'SUSPENDED', query: '', page: 4 }, 'SUSPENDED'), { status: 'SUSPENDED', query: '', page: 1 })
    const view = { status: 'SUSPENDED', query: '', page: 1 }
    assert.equal(lib.withStatus(view, 'SUSPENDED'), view, 'same object, so the list is not reloaded')
  })

  it('submitting a search trims it, goes back to page 1 and keeps the status', () => {
    assert.deepEqual(lib.withSearch({ status: 'ACTIVE', query: '', page: 5 }, '  Perera  '), { status: 'ACTIVE', query: 'Perera', page: 1 })
    assert.deepEqual(lib.withSearch({ status: '', query: 'old', page: 2 }, '   '), { status: '', query: '', page: 1 }, 'a blank search clears it')
  })

  it('re-submitting the same search on page 1 is a no-op, on a later page it returns to page 1', () => {
    const view = { status: '', query: 'acme', page: 1 }
    assert.equal(lib.withSearch(view, ' acme '), view)
    assert.equal(lib.withSearch({ ...view, page: 3 }, 'acme').page, 1)
  })

  it('paging moves within the current filter and never goes below page 1', () => {
    const view = { status: 'ACTIVE', query: 'a', page: 2 }
    assert.deepEqual(lib.withPage(view, 3), { status: 'ACTIVE', query: 'a', page: 3 })
    assert.equal(lib.withPage(view, 0).page, 1)
    assert.equal(lib.withPage(view, -4).page, 1)
    assert.equal(lib.withPage(view, 2.9).page, 2)
    assert.equal(lib.withPage(view, 2), view)
  })
})

describe('list request', () => {
  it('sends only the page and limit when nothing is filtered (the All tab sends no status)', () => {
    assert.equal(lib.listQuery(lib.INITIAL_LIST_VIEW, 25).toString(), 'page=1&limit=25')
  })

  it('adds the status and the search when set, encoding the search safely', () => {
    const params = lib.listQuery({ status: 'SUSPENDED', query: 'a&b=c d', page: 2 }, 25)
    assert.equal(params.get('status'), 'SUSPENDED')
    assert.equal(params.get('search'), 'a&b=c d')
    assert.equal(params.get('page'), '2')
    assert.equal([...params.keys()].filter((k) => k === 'b').length, 0, 'the "&" did not start a new parameter')
  })
})

describe('a page that no longer exists after the list shrinks', () => {
  it('moves to the last real page when the current one is past the end', () => {
    assert.equal(lib.outOfRangePage(2, 25, 1), 1, 'reactivated the only row on page 2')
    assert.equal(lib.outOfRangePage(5, 60, 3), 3)
  })

  it('leaves valid pages and genuinely empty results alone', () => {
    assert.equal(lib.outOfRangePage(1, 60, 3), null)
    assert.equal(lib.outOfRangePage(3, 60, 3), null)
    assert.equal(lib.outOfRangePage(1, 0, 0), null, 'no results at all is not an out-of-range page')
    assert.equal(lib.outOfRangePage(2, undefined, undefined), null, 'no pagination info')
  })
})

describe('out-of-order responses', () => {
  const setup = () => {
    const load = lib.createLatestLoader()
    const shown: string[] = []
    const errors: string[] = []
    const run = (d: ReturnType<typeof deferred<string>>) =>
      load(() => d.promise, { onSuccess: (v) => shown.push(v), onError: (e) => errors.push(String(e)) })
    return { run, shown, errors }
  }

  it('shows the result of a single request', async () => {
    const { run, shown } = setup()
    const a = deferred<string>()
    run(a)
    a.resolve('A')
    await settle()
    assert.deepEqual(shown, ['A'])
  })

  it('an older response that arrives after a newer one cannot overwrite it', async () => {
    const { run, shown } = setup()
    const a = deferred<string>()
    const b = deferred<string>()
    run(a) // e.g. the Active tab
    run(b) // the user then clicks Suspended
    b.resolve('B')
    await settle()
    a.resolve('A')
    await settle()
    assert.deepEqual(shown, ['B'])
  })

  it('an older response that arrives first is dropped as soon as a newer request has started', async () => {
    const { run, shown } = setup()
    const a = deferred<string>()
    const b = deferred<string>()
    run(a)
    run(b)
    a.resolve('A')
    await settle()
    assert.deepEqual(shown, [], 'nothing stale is shown while the newer request is pending')
    b.resolve('B')
    await settle()
    assert.deepEqual(shown, ['B'])
  })

  it('a stale failure does not replace newer results with an error', async () => {
    const { run, shown, errors } = setup()
    const a = deferred<string>()
    const b = deferred<string>()
    run(a)
    run(b)
    b.resolve('B')
    await settle()
    a.reject(new Error('A failed'))
    await settle()
    assert.deepEqual({ shown, errors }, { shown: ['B'], errors: [] })
  })

  it('a stale failure that arrives before the newer success is also ignored', async () => {
    const { run, shown, errors } = setup()
    const a = deferred<string>()
    const b = deferred<string>()
    run(a)
    run(b)
    a.reject(new Error('A failed'))
    await settle()
    b.resolve('B')
    await settle()
    assert.deepEqual({ shown, errors }, { shown: ['B'], errors: [] })
  })

  it('the newest request’s failure is reported, and a late older success does not hide it', async () => {
    const { run, shown, errors } = setup()
    const a = deferred<string>()
    const b = deferred<string>()
    run(a)
    run(b)
    b.reject(new Error('B failed'))
    await settle()
    a.resolve('A')
    await settle()
    assert.deepEqual({ shown, errors }, { shown: [], errors: ['Error: B failed'] })
  })

  it('requests made one after another all show their own result', async () => {
    const { run, shown } = setup()
    for (const v of ['A', 'B', 'C']) {
      const d = deferred<string>()
      run(d)
      d.resolve(v)
      await settle()
    }
    assert.deepEqual(shown, ['A', 'B', 'C'])
  })
})

describe('the Resellers page uses them', () => {
  // Source-level wiring check: without a DOM there is no way to click through the page here.
  const page = () => fs.readFileSync(PAGE, 'utf8')

  it('loads through the latest-only loader and the shared view/request helpers', () => {
    const src = page()
    assert.match(src, /from '@\/lib\/paged-list'/)
    // createLatestLoader is handed to useState as a lazy initialiser, so it is matched by name, not as a call.
    assert.match(src, /\bcreateLatestLoader\b/)
    assert.match(src, /\bloadLatest\(/, 'the request goes through the loader')
    for (const call of ['listQuery(', 'withStatus(', 'withSearch(', 'withPage(', 'outOfRangePage(']) {
      assert.ok(src.includes(call), `expected the page to call ${call}`)
    }
  })

  it('no longer keeps page/status/search as separate pieces of state that could get out of step', () => {
    const src = page()
    assert.doesNotMatch(src, /setPage\(/)
    assert.doesNotMatch(src, /new URLSearchParams\(\{ page/)
  })

  it('shows active accounts over total accounts, in the same unit', () => {
    const src = page()
    assert.match(src, /r\.activeCustomerCount\}\s*\/\s*\{r\.customerAccounts/)
    assert.doesNotMatch(src, /\/\s*\{r\.customers\}/)
  })
})
