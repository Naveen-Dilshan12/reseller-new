import { after, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hooks, jsx, mountPage } from './helpers/render-page'

/**
 * Reseller portal: what a failed request looks like. Found in the browser (QA results items 5, 7, 11, 12, 25, 27):
 *  - Demo Requests and Commissions → By customer showed the error AND a permanent "Loading…", with no way to try again;
 *  - the Commissions summary left four skeleton cards for ever (no message, no Retry);
 *  - the Dashboard replaced the whole page, hero included, with a bare red alert;
 *  - Customers and Products showed the error with no Retry (both also showed "0" counts as if they were real; they now show "—").
 * Each now shows the error, a working Retry, no stale data and no "Loading…" left behind, and keeps the rest of the page usable.
 *
 * The real, unmodified pages and components run in Node through tests/helpers/render-page.ts against scripted API stubs. (The
 * Dashboard's inner component is not exported, and a Next page may not export extras, so the test loads a temporary copy of the real
 * source with one added export.) Database-free; nothing here reads `.env`, runs Prisma or opens a connection.
 */

const WEB = path.resolve(__dirname, '../../web/src')
const format = require('../../web/src/lib/format')
const demoTypes = require('../../web/src/lib/demo-types')
const dashboardTypes = require('../../web/src/lib/dashboard-types')
const appearanceUtils = require('../../web/src/lib/appearance-utils')

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
const down = (message = 'The server is down') => fail(new ApiError(message, 500))

const findAll = (node: any, test: (el: Row) => boolean): Row[] => {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap((n) => findAll(n, test))
  return [...(test(node) ? [node] : []), ...findAll(node.props?.children, test)]
}
const hasClass = (name: string) => (el: Row) => typeof el.props?.className === 'string' && el.props.className.split(/\s+/).includes(name)
const alerts = (page: { textOfClass: (n: string) => string[] }) => page.textOfClass('alert').map((t) => t.replace(/\s+/g, ' ').trim())

const link = ({ href, children }: { href: string; children: unknown }) => jsx('a', { href, children })
const nextLink = { __esModule: true, default: link }
/** The page's own "Retry" buttons (the harness matches buttons by their text). */
const RETRY = 'Retry'

/* ═══ Demo Requests (shared DemoRequestList) ═════════════════════════════════ */

describe('Demo Requests list: a failed load shows the error with Retry, never "Loading…" for ever', () => {
  const LIST = path.join(WEB, 'components/demos/DemoRequestList.tsx')
  let calls: URLSearchParams[]
  let script: Step[]

  const demo = (name: string, status = 'PENDING'): Row => ({
    id: `d-${name}`,
    businessName: name,
    contactName: 'Contact',
    contactEmail: `${name}@example.com`,
    status,
    submittedAt: '2026-10-01T05:00:00.000Z',
    product: { id: 'p1', name: 'Hexalyte Salon' },
    reseller: { businessName: 'Kandy Traders', code: 'RS-1' },
  })
  const listOf = (names: string[]) => ({ data: names.map((n) => demo(n)), meta: { total: names.length, page: 1, limit: 25, totalPages: 1, pipelineCounts: { total: 7, pending: 2, approved: 1, demoCreated: 1, confirmed: 3 } } })

  const open = async () => {
    const page = mountPage(
      LIST,
      {
        'next/link': nextLink,
        '@/lib/format': format,
        '@/lib/demo-types': demoTypes,
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
          KpiGrid: ({ children }: { children: unknown }) => jsx('div', { children }),
          KpiRefCard: ({ value }: { value: unknown }) => jsx('span', { className: 'kpi-value', children: String(value) }),
        },
        '@/components/ui/EmptyState': { EmptyState: ({ title }: { title: string }) => jsx('div', { className: 'empty', children: title }) },
        '@/components/ui/Pagination': { Pagination: () => null },
      },
      { exportName: 'DemoRequestList', props: { basePath: '/demo-requests' } },
    )
    await page.settle()
    return page
  }

  beforeEach(() => {
    calls = []
    script = []
  })

  it('shows the server\'s message and a Retry button, no "Loading…", no rows, and "—" in the counters', async () => {
    script = [down('Demo requests are unavailable')]
    const page = await open()
    assert.deepEqual(alerts(page), ['Demo requests are unavailable Retry'])
    assert.equal(page.text().includes('Loading…'), false, 'the old behaviour: the error AND a permanent Loading…')
    assert.equal(page.text().includes('No demo requests found'), false, 'a failure is not an empty list')
    assert.deepEqual(page.textOfClass('kpi-value'), ['—', '—', '—', '—', '—'])
    assert.ok(page.hasButton(RETRY))
  })

  it('a failure that is not an ApiError still gets a readable message', async () => {
    script = [fail(new TypeError('fetch failed'))]
    const page = await open()
    assert.deepEqual(alerts(page), ['Failed to load demo requests Retry'])
  })

  it('Retry asks again with the same filters; while it runs there is "Loading…" and no alert; on success the rows appear', async () => {
    const pending = deferred<unknown>()
    script = [down(), () => pending.promise]
    const page = await open()
    await page.click(RETRY)
    assert.equal(calls.length, 2)
    assert.equal(calls[1].toString(), calls[0].toString(), 'same page, status and search as the failed request')
    assert.ok(page.text().includes('Loading…'))
    assert.deepEqual(alerts(page), [], 'the old error is gone while the new request runs')
    pending.resolve(structuredClone(listOf(['Kandy Salon'])))
    await page.settle()
    assert.deepEqual(alerts(page), [])
    assert.equal(page.text().includes('Loading…'), false)
    assert.ok(page.text().includes('Kandy Salon'))
    assert.deepEqual(page.textOfClass('kpi-value'), ['7', '2', '1', '1', '3'], 'the server\'s counters are back')
    assert.deepEqual(page.links().map((l) => l.href), ['/demo-requests/d-Kandy Salon'])
  })

  it('Retry that fails again shows the error again, still with Retry', async () => {
    script = [down('first'), down('second')]
    const page = await open()
    await page.click(RETRY)
    assert.deepEqual(alerts(page), ['second Retry'])
    assert.equal(page.text().includes('Loading…'), false)
  })

  it('a failure after rows were on screen removes those rows (no stale list next to the error)', async () => {
    script = [ok(listOf(['Kandy Salon'])), down('Gone')]
    const page = await open()
    assert.ok(page.text().includes('Kandy Salon'))
    await page.fill('dr-status', 'APPROVED')
    assert.deepEqual(alerts(page), ['Gone Retry'])
    assert.equal(page.text().includes('Kandy Salon'), false)
    assert.equal(page.text().includes('Loading…'), false)
  })
})

/* ═══ Commissions → By customer ══════════════════════════════════════════════ */

describe('Commissions → By customer: a failed load shows the error with Retry, never "Loading…" for ever', () => {
  const COMPONENT = path.join(WEB, 'components/commissions/CustomerCommissions.tsx')
  let urls: string[]
  let script: Step[]

  const row = (name: string): Row => ({
    customerAccount: { id: `a-${name}`, status: 'ACTIVE', customer: { displayName: name }, product: { name: 'Hexalyte Salon' }, reseller: { businessName: 'Kandy Traders' } },
    entries: 2,
    lastPeriod: '2026-10',
    netEarned: '550',
    paid: '0',
    reversed: '0',
  })

  const open = async () => {
    const page = mountPage(
      COMPONENT,
      {
        '@/lib/format': format,
        '@/lib/api': {
          ApiError,
          api: async (url: string) => {
            urls.push(url)
            const next = script.shift()
            if (!next) throw new Error(`unexpected extra request: ${url}`)
            return next()
          },
        },
        '@/components/ui/EmptyState': { EmptyState: ({ title }: { title: string }) => jsx('div', { className: 'empty', children: title }) },
      },
      { exportName: 'CustomerCommissions' },
    )
    await page.settle()
    return page
  }

  beforeEach(() => {
    urls = []
    script = []
  })

  it('shows the error and Retry, and neither "Loading…" nor an empty table', async () => {
    script = [down('Commissions are unavailable')]
    const page = await open()
    assert.deepEqual(alerts(page), ['Commissions are unavailable Retry'])
    assert.equal(page.text().includes('Loading…'), false)
    assert.equal(page.text().includes('No customer commissions yet'), false)
    assert.ok(page.hasButton(RETRY))
  })

  it('Retry asks the same URL again and shows the rows when it works', async () => {
    script = [down(), ok([row('ruwan shop')])]
    const page = await open()
    await page.click(RETRY)
    assert.equal(urls.length, 2)
    assert.equal(urls[1], urls[0])
    assert.deepEqual(alerts(page), [])
    assert.ok(page.text().includes('ruwan shop'))
    assert.equal(page.hasButton(RETRY), false)
  })

  it('a failure for another month removes the previous month\'s rows instead of showing them under the error', async () => {
    script = [ok([row('ruwan shop')]), down('Month failed')]
    const page = await open()
    assert.ok(page.text().includes('ruwan shop'))
    await page.fill('cust-month', '2026-09')
    assert.match(urls[1], /periodMonth=2026-09/)
    assert.deepEqual(alerts(page), ['Month failed Retry'])
    assert.equal(page.text().includes('ruwan shop'), false)
    assert.equal(page.text().includes('Loading…'), false)
  })

  it('a slow answer for a month the user already left cannot replace the current one', async () => {
    const slow = deferred<unknown>()
    script = [() => slow.promise, ok([row('September customer')])]
    const page = await open()
    await page.fill('cust-month', '2026-09')
    assert.ok(page.text().includes('September customer'))
    slow.resolve([row('All-time customer')])
    await page.settle()
    assert.ok(page.text().includes('September customer'))
    assert.equal(page.text().includes('All-time customer'), false)
  })
})

/* ═══ Commissions page: the summary ══════════════════════════════════════════ */

describe('Commissions page: a failed summary is an error with Retry, not skeleton cards for ever', () => {
  const PAGE = path.join(WEB, 'app/commissions/page.tsx')
  let calls: string[]
  let script: Step[]

  const summary: Row = {
    level: { level: 1, name: 'Level 1', effectiveRatePercent: '10', nextLevel: null },
    totals: { pending: '0', paid: '0' },
    currentMonth: { earnings: '550', periodMonth: '2026-10' },
  }
  const marker = (name: string) => () => jsx('div', { className: name, children: name })

  const open = async () => {
    const page = mountPage(PAGE, {
      '@/lib/format': format,
      '@/lib/api': {
        ApiError,
        api: async (url: string) => {
          calls.push(url)
          const next = script.shift()
          if (!next) throw new Error(`unexpected extra request: ${url}`)
          return next()
        },
      },
      '@/components/ResellerShell': { ResellerShell: ({ children }: { children: (user: object) => unknown }) => children({}) },
      '@/components/PageHero': { PageHero: ({ children }: { children: unknown }) => jsx('header', { className: 'hero', children }) },
      '@/components/Tabs': {
        Tabs: ({ tabs }: { tabs: { key: string; label: string }[] }) => jsx('div', { className: 'tabs', children: tabs.map((t) => jsx('button', { children: t.label })) }),
      },
      '@/components/commissions/CommissionLedger': { CommissionLedger: marker('ledger-tab') },
      '@/components/commissions/CustomerCommissions': { CustomerCommissions: marker('customers-tab') },
      '@/components/commissions/MonthlyReport': { MonthlyReport: marker('monthly-tab') },
      '@/components/commissions/PayoutHistory': { PayoutHistory: marker('payouts-tab') },
      '@/components/commissions/LevelBadge': { LevelBadge: () => null },
      '@/components/commissions/CommissionSplit': { CommissionSplit: marker('split-card') },
    })
    await page.settle()
    return page
  }
  const skeletons = (page: Awaited<ReturnType<typeof open>>) => findAll(page.root(), hasClass('skel')).length

  beforeEach(() => {
    calls = []
    script = []
  })

  it('shows skeleton cards while the summary is loading (and no error)', async () => {
    const pending = deferred<unknown>()
    script = [() => pending.promise]
    const page = await open()
    assert.ok(skeletons(page) > 0)
    assert.deepEqual(alerts(page), [])
  })

  it('on failure: a message with the server\'s reason and Retry replace the skeletons, and the tabs below stay usable', async () => {
    script = [down('Summary is unavailable')]
    const page = await open()
    assert.equal(skeletons(page), 0, 'no stuck skeletons')
    assert.deepEqual(alerts(page), ['Your commission summary could not be loaded. Summary is unavailable Retry'])
    assert.equal(page.text().includes('Commission This Month'), false, 'no invented numbers')
    assert.ok(page.hasButton('Commission history') && page.hasButton('Payouts'), 'the tab bar is still there')
    assert.ok(page.text().includes('ledger-tab'), 'the commission history tab still loads on its own')
  })

  it('a failure that is not an ApiError still says what happened and what to do', async () => {
    script = [fail(new TypeError('fetch failed'))]
    const page = await open()
    assert.deepEqual(alerts(page), ['Your commission summary could not be loaded. Please try again. Retry'])
  })

  it('Retry asks again; skeletons show while it runs; on success the cards and the commission split appear and the alert is gone', async () => {
    const pending = deferred<unknown>()
    script = [down(), () => pending.promise]
    const page = await open()
    await page.click(RETRY)
    assert.equal(calls.length, 2)
    assert.ok(skeletons(page) > 0)
    assert.deepEqual(alerts(page), [])
    pending.resolve(structuredClone(summary))
    await page.settle()
    assert.equal(skeletons(page), 0)
    assert.deepEqual(alerts(page), [])
    assert.ok(page.text().includes('Commission This Month'))
    assert.ok(page.text().includes('split-card'))
    assert.equal(page.hasButton(RETRY), false)
  })
})

/* ═══ Customers ══════════════════════════════════════════════════════════════ */

describe('My Customers: a failed load offers Retry and shows "—", not zero counts', () => {
  const PAGE = path.join(WEB, 'app/customers/page.tsx')
  let calls: string[]
  let script: Step[]

  const open = async () => {
    const page = mountPage(PAGE, {
      // the harness has no useMemo; computing it every time is equivalent for these tests
      react: { ...hooks, useMemo: (fn: () => unknown) => fn() },
      'next/link': nextLink,
      '@/lib/format': format,
      '@/lib/dashboard-types': dashboardTypes,
      '@/lib/api': {
        ApiError,
        api: async () => [],
        apiRequest: async (url: string) => {
          calls.push(url)
          const next = script.shift()
          if (!next) throw new Error(`unexpected extra request: ${url}`)
          return next()
        },
      },
      '@/components/ResellerShell': { ResellerShell: ({ children }: { children: (user: object) => unknown }) => children({ permissions: ['demos:create', 'activations:create'] }) },
      '@/components/PageHero': { PageHero: ({ children }: { children: unknown }) => jsx('header', { children }) },
      '@/components/ui/KpiRefCard': {
        KpiGrid: ({ children }: { children: unknown }) => jsx('div', { children }),
        KpiRefCard: ({ value }: { value: unknown }) => jsx('span', { className: 'kpi-value', children: String(value) }),
      },
      '@/components/ui/Pagination': { Pagination: () => null },
      '@/components/ui/Modal': { Modal: () => null },
    })
    await page.settle()
    return page
  }
  const answer = (pipelineCounts = { active: 2, trial: 1, inReview: 0 }) => ({ data: [], meta: { total: 3, page: 1, limit: 50, totalPages: 1, pipelineCounts } })

  beforeEach(() => {
    calls = []
    script = []
  })

  it('shows the error with a Retry button, "—" for every counter, no row count and no table', async () => {
    script = [down('Customers are unavailable')]
    const page = await open()
    assert.deepEqual(alerts(page), ['Customers are unavailable Retry'])
    assert.deepEqual(page.textOfClass('kpi-value'), ['—', '—', '—', '—'])
    assert.equal(page.text().includes('Showing'), false, '"Showing 0 accounts" would read like a real, empty answer')
    assert.equal(page.text().includes('Customer'), true)
    assert.equal(findAll(page.root(), (el) => el.type === 'table').length, 0)
    assert.ok(page.hasButton(RETRY))
  })

  it('Retry asks again with the same query; on success the counters, the row count and the table are back and the alert is gone', async () => {
    script = [down(), ok(answer())]
    const page = await open()
    await page.click(RETRY)
    assert.equal(calls.length, 2)
    assert.equal(calls[1], calls[0], 'same search, filters and page')
    assert.deepEqual(alerts(page), [])
    assert.deepEqual(page.textOfClass('kpi-value'), ['3', '2', '1', '0'])
    assert.ok(page.text().includes('Showing 0 accounts on this page'))
    assert.equal(page.hasButton(RETRY), false)
  })

  it('a Retry that fails again keeps the error and the Retry button', async () => {
    script = [down('first'), down('second')]
    const page = await open()
    await page.click(RETRY)
    assert.deepEqual(alerts(page), ['second Retry'])
    assert.deepEqual(page.textOfClass('kpi-value'), ['—', '—', '—', '—'])
  })
})

/* ═══ Products ═══════════════════════════════════════════════════════════════ */

describe('SaaS Products: a failed load offers Retry', () => {
  const PAGE = path.join(WEB, 'app/products/page.tsx')
  let calls: string[]
  let products: Step[]

  const product = { id: 'p1', code: 'SALON', name: 'Hexalyte Salon', description: 'Salon management SaaS', monthlyPrice: '5500', currency: 'LKR' }

  const open = async () => {
    const page = mountPage(PAGE, {
      react: { ...hooks, useMemo: (fn: () => unknown) => fn() },
      'next/link': nextLink,
      '@/lib/format': format,
      '@/lib/api': {
        ApiError,
        api: async (url: string) => {
          calls.push(url)
          if (url === '/commissions/levels') return []
          const next = products.shift()
          if (!next) throw new Error(`unexpected extra request: ${url}`)
          return next()
        },
      },
      '@/components/ResellerShell': { ResellerShell: ({ children }: { children: (user: object) => unknown }) => children({ permissions: ['demos:create', 'activations:create'] }) },
      '@/components/PageHero': { PageHero: ({ children }: { children: unknown }) => jsx('header', { children }) },
    })
    await page.settle()
    return page
  }
  const productCalls = () => calls.filter((c) => c === '/products').length
  const skeletonCards = (page: Awaited<ReturnType<typeof open>>) => findAll(page.root(), (el) => el.props?.className === 'product-grid').length

  beforeEach(() => {
    calls = []
    products = []
  })

  it('shows the error with Retry, and no product cards', async () => {
    products = [down('Products are unavailable')]
    const page = await open()
    assert.deepEqual(alerts(page), ['Products are unavailable Retry'])
    assert.equal(page.text().includes('Hexalyte Salon'), false)
    assert.equal(page.text().includes('No products in your catalogue'), false, 'a failure is not an empty catalogue')
    assert.equal(skeletonCards(page), 0)
  })

  it('Retry asks for the products again; the cards show on success and the alert is gone', async () => {
    const pending = deferred<unknown>()
    products = [down(), () => pending.promise]
    const page = await open()
    await page.click(RETRY)
    assert.equal(productCalls(), 2)
    assert.deepEqual(alerts(page), [], 'the error is cleared while the new request runs')
    assert.equal(skeletonCards(page), 1, 'skeleton cards while it runs')
    pending.resolve([structuredClone(product)])
    await page.settle()
    assert.deepEqual(alerts(page), [])
    assert.ok(page.text().includes('Hexalyte Salon'))
    assert.equal(page.hasButton(RETRY), false)
  })

  it('a Retry that fails again keeps the error and Retry', async () => {
    products = [down('first'), down('second')]
    const page = await open()
    await page.click(RETRY)
    assert.deepEqual(alerts(page), ['second Retry'])
  })

  // The three KPI cards, in order: Active Solutions, Subscription Rate, Partner Margin (the levels request is stubbed as "no levels").
  const kpis = (page: Awaited<ReturnType<typeof open>>) => page.textOfClass('kpi-ref-value')
  const DASH = '—'

  it('after a failed load every KPI value is "—": no "0 Products" next to the error, and no "Showing 0 of 0 products" line', async () => {
    products = [down('Products are unavailable')]
    const page = await open()
    assert.deepEqual(kpis(page), [DASH, DASH, DASH])
    assert.equal(page.text().includes('0 Products'), false)
    assert.equal(page.text().includes('Showing'), false)
  })

  it('while the first answer is awaited the values are "—" too, and the count line is not shown yet', async () => {
    const pending = deferred<unknown>()
    products = [() => pending.promise]
    const page = await open()
    assert.deepEqual(kpis(page), [DASH, DASH, DASH])
    assert.equal(page.text().includes('Showing'), false)
  })

  it('after a Retry that works the real product count, price and "Showing" line replace the dashes', async () => {
    products = [down(), ok([product])]
    const page = await open()
    await page.click(RETRY)
    const [count, rate] = kpis(page)
    assert.match(count, /^1 Product/)
    assert.equal(rate, format.formatMoney(product.monthlyPrice, product.currency))
    assert.ok(page.text().includes('Showing 1 of 1 products'))
  })

  it('a catalogue that really is empty still says 0 (an answer, unlike a failure)', async () => {
    products = [ok([])]
    const page = await open()
    assert.equal(kpis(page)[0], '0 Products')
    assert.ok(page.text().includes('Showing 0 of 0 products'))
  })
})

/* ═══ Dashboard ══════════════════════════════════════════════════════════════ */

describe('Dashboard: a failed data request keeps the hero and shows a recoverable error', () => {
  // Dashboard() is not exported (a Next page may only export its default), so load a temporary copy of the real file with one export
  // added. The two charts keep their own hover state (hooks), which the harness cannot run in child components; they are not what
  // this test is about, so the copy swaps them for empty ones.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-under-test-'))
  const FILE = path.join(dir, 'page.tsx')
  fs.writeFileSync(
    FILE,
    `${fs.readFileSync(path.join(WEB, 'app/dashboard/page.tsx'), 'utf8')}\nexport { Dashboard }\n;(CustomerGrowthChart as any) = () => null\n;(CommissionEarningsChart as any) = () => null\n`,
  )
  after(() => fs.rmSync(dir, { recursive: true, force: true }))

  let calls: string[]
  let script: Step[]

  // `t` must keep its identity between renders: the page reloads its data whenever `t` changes.
  const LANG = { t: (key: string) => key, language: 'en' }
  const user = (permissions = ['demos:create', 'activations:read']): Row => ({
    id: 'u1',
    name: 'Nimal Perera',
    role: 'SELLER',
    permissions,
    reseller: { id: 'r1', code: 'RS-1', businessName: 'Kandy Traders', status: 'ACTIVE' },
  })
  const dashboard: Row = {
    reseller: { id: 'r1', code: 'RS-1', businessName: 'Kandy Traders' },
    products: [],
    filters: { from: null, to: null, productId: null },
    kpis: {
      level: { level: 1, name: 'Level 1', activeCount: 1, nextLevel: { name: 'Level 2', customersNeeded: 10 }, ratePercent: '10' },
      activeCustomers: 1,
      totalCustomers: 1,
      trialCustomers: 0,
      activeSubscriptions: 1,
      pendingActivationRequests: 0,
      commission: { currency: 'LKR', thisMonth: '550', pending: '0', paid: '0' },
    },
    period: { newCustomers: 0, trialsCreated: 0, activationsSubmitted: 0, commissionEarned: '0', commissionPaid: '0' },
    recent: { customers: [], trials: [], activations: [], commissions: [] },
    analytics: { customerGrowth: [], commissionEarnings: [] },
  }

  const open = async (u: Row = user()) => {
    const page = mountPage(
      FILE,
      {
        'next/link': nextLink,
        '@/lib/format': format,
        '@/lib/appearance-utils': appearanceUtils,
        '@/lib/api': {
          ApiError,
          api: async (url: string) => {
            calls.push(url)
            if (url === '/commissions/levels') return []
            const next = script.shift()
            if (!next) throw new Error(`unexpected extra request: ${url}`)
            return next()
          },
        },
        '@/components/ResellerShell': { ResellerShell: () => null },
        '@/lib/i18n': { useLanguage: () => LANG },
        '@/lib/appearance': { useAppearance: () => null },
        '@/components/commissions/LevelBadge': { LevelBadge: () => null, LevelLadder: () => null },
        '@/components/commissions/LevelUpCelebration': { recentLevelUp: () => null },
        '@/components/commissions/PartnerSummaryContext': { usePartnerSummaryContext: () => null },
      },
      { exportName: 'Dashboard', props: { user: u } },
    )
    await page.settle()
    return page
  }
  const dashCalls = () => calls.filter((c) => c === '/dashboard/reseller').length
  const heroKeys = ['dash.hero.greeting', 'dash.hero.welcome', 'dash.hero.subtitle']

  beforeEach(() => {
    calls = []
    script = []
  })

  it('on failure the hero (greeting, welcome heading, subtitle) and the New Demo Request button stay, with the error and Retry under them', async () => {
    script = [down('Dashboard is unavailable')]
    const page = await open()
    const text = page.text()
    for (const key of heroKeys) assert.ok(text.includes(key), key)
    assert.deepEqual(page.links().map((l) => l.href), ['/demo-requests/new'])
    assert.ok(page.text().includes('dash.newDemoRequestBtn'))
    assert.deepEqual(alerts(page), ['Dashboard is unavailable common.retry'])
    assert.ok(page.hasButton('common.retry'))
    assert.equal(findAll(page.root(), (el) => el.type === 'h1').length, 1, 'one welcome heading')
    assert.equal(text.includes('common.loading'), false)
  })

  it('shows no data sections and no invented numbers while the data is missing', async () => {
    script = [down()]
    const text = (await open()).text()
    for (const key of ['dash.kpi.totalCustomers', 'dash.kpi.commissionPaid', 'dash.growth.title']) assert.equal(text.includes(key), false, key)
  })

  it('a reseller without demo-request permission still gets the hero and the error, but no demo button', async () => {
    script = [down()]
    const page = await open(user(['activations:read']))
    assert.ok(page.text().includes('dash.hero.welcome'))
    assert.deepEqual(page.links(), [])
    assert.ok(page.hasButton('common.retry'))
  })

  it('a failure that is not an ApiError shows the translated fallback message', async () => {
    script = [fail(new TypeError('fetch failed'))]
    assert.deepEqual(alerts(await open()), ['dash.error.load common.retry'])
  })

  it('while the first request is running the hero is already there, with the loading text under it (no bare "Loading…" page)', async () => {
    const pending = deferred<unknown>()
    script = [() => pending.promise]
    const page = await open()
    for (const key of heroKeys) assert.ok(page.text().includes(key), key)
    assert.ok(page.text().includes('common.loading'))
    assert.deepEqual(alerts(page), [])
    pending.resolve(structuredClone(dashboard))
    await page.settle()
  })

  it('Retry reloads the dashboard data: the hero stays through the retry, the alert goes, and the KPI cards come back on success', async () => {
    const pending = deferred<unknown>()
    script = [down(), () => pending.promise]
    const page = await open()
    await page.click('common.retry')
    assert.equal(dashCalls(), 2)
    for (const key of heroKeys) assert.ok(page.text().includes(key), `${key} stays while retrying`)
    assert.ok(page.text().includes('common.loading'))
    assert.deepEqual(alerts(page), [])
    pending.resolve(structuredClone(dashboard))
    await page.settle()
    const text = page.text()
    assert.equal(page.hasButton('common.retry'), false)
    assert.deepEqual(alerts(page), [])
    for (const key of ['dash.kpi.totalCustomers', 'dash.kpi.commissionPaid', 'dash.growth.title']) assert.ok(text.includes(key), key)
    assert.equal(text.split('dash.hero.greeting').length - 1, 1, 'the hero is shown once, not duplicated')
    assert.equal(findAll(page.root(), (el) => el.type === 'h1').length, 1)
  })

  it('a Retry that fails again shows the error with Retry again', async () => {
    script = [down('first'), down('second')]
    const page = await open()
    await page.click('common.retry')
    assert.deepEqual(alerts(page), ['second common.retry'])
    assert.ok(page.text().includes('dash.hero.welcome'))
  })

  it('a successful first load is unchanged: hero once, then the KPI cards', async () => {
    script = [ok(dashboard)]
    const page = await open()
    const text = page.text()
    assert.equal(text.split('dash.hero.greeting').length - 1, 1)
    assert.ok(text.includes('dash.kpi.totalCustomers'))
    assert.deepEqual(alerts(page), [])
    assert.equal(dashCalls(), 1)
  })
})

/* ═══ Strings ════════════════════════════════════════════════════════════════ */

describe('Retry label and dashboard message exist in the translations', () => {
  const source = fs.readFileSync(path.join(WEB, 'lib/i18n.tsx'), 'utf8')

  it('common.retry is defined for English and Sinhala', () => {
    const values = [...source.matchAll(/'common\.retry':\s*'([^']+)'/g)].map((m) => m[1])
    assert.equal(values.length, 2)
    assert.equal(values[0], 'Retry')
    assert.match(values[1], /[඀-෿]/, 'the Sinhala label is in Sinhala')
  })

  it('the English dashboard message no longer tells people to refresh a page that now has a Retry button', () => {
    assert.match(source, /'dash\.error\.load': 'Could not load your dashboard\. Please try again\.'/)
  })
})
