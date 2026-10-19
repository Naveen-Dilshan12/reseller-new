import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { jsx, mountPage } from './helpers/render-page'

/**
 * Admin → SaaS products: how the product list and the product detail page behave when requests fail or succeed.
 *  - the list shows a real error with Retry instead of "Loading…" forever;
 *  - the detail page shows failures to load integration calls / implementations / the product itself (with retry and a
 *    way back) instead of an empty list;
 *  - a connection test reports success in the success style and failure in the error style.
 *
 * The real, unmodified pages run in Node through tests/helpers/render-page.ts (a minimal hook runtime, no DOM) against
 * scripted API stubs. Database-free; nothing here reads `.env`, runs Prisma or opens a connection.
 */

const LIST_PAGE = path.resolve(__dirname, '../../web/src/app/admin/products/page.tsx')
const DETAIL_PAGE = path.resolve(__dirname, '../../web/src/app/admin/products/[id]/page.tsx')

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

const productTypes = require('../../web/src/lib/product-types')
const common = {
  'next/link': { __esModule: true, default: ({ href, children }: { href: string; children: unknown }) => jsx('a', { href, children }) },
  '@/lib/format': { formatMoney: (amount: string, currency: string) => `${currency} ${amount}`, formatDate: (value: string | null) => value ?? '—' },
  '@/lib/product-types': productTypes,
  '@/components/ui/Modal': { Modal: () => null },
  '@/components/admin/ProductLifecycleDialog': { ProductLifecycleDialog: () => null },
}

const listItem = (over: Row = {}): Row => ({
  id: 'p1', code: 'SALON', name: 'Hexalyte Salon', description: null, status: 'ACTIVE', monthlyPrice: '5500', currency: 'LKR',
  trialAvailable: false, trialDays: null, integrationStatus: 'CONFIGURED', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
  integration: { provider: 'MANUAL', lastCheckedAt: null, lastCheckOk: null }, _count: { resellerAccess: 2, accounts: 3 }, ...over,
})

// ------------------------------------------------------------------------------------------------ product list

describe('Product list page: loading and failing', () => {
  let script: Step[]
  let calls: number

  const open = async () => {
    const page = mountPage(LIST_PAGE, {
      ...common,
      'next/navigation': { useRouter: () => ({ push: () => undefined }) },
      '@/components/admin/AdminPageHeader': { AdminPageHeader: ({ title, actions }: { title: string; actions: unknown }) => jsx('div', { children: [jsx('h1', { children: title }), actions] }) },
      '@/lib/api': {
        ApiError,
        api: async () => {
          calls++
          const next = script.shift()
          if (!next) throw new Error('unexpected extra request')
          return next()
        },
      },
    })
    await page.settle()
    return page
  }

  beforeEach(() => {
    script = []
    calls = 0
  })

  it('shows "Loading…" while the request is in flight, with no error', async () => {
    const pending = deferred<unknown>()
    script = [() => pending.promise]
    const page = await open()
    assert.ok(page.text().includes('Loading…'))
    assert.deepEqual(page.textOfClass('alert'), [])
    pending.resolve([listItem()])
    await page.settle()
    assert.ok(page.text().includes('Hexalyte Salon'))
    assert.equal(page.text().includes('Loading…'), false)
  })

  it('a failed load shows the server message and a Retry button, and stops saying "Loading…"', async () => {
    script = [fail(new ApiError('Service unavailable', 503))]
    const page = await open()
    assert.deepEqual(page.textOfClass('alert error').map((t) => t.replace(/\s*Retry\s*$/, '')), ['Service unavailable'])
    assert.ok(page.hasButton('Retry'))
    assert.equal(page.text().includes('Loading…'), false, 'the error replaces the loading text')
    assert.equal(page.text().includes('No products yet.'), false, 'a failure is not an empty catalogue')
  })

  it('a failure without a server message gets a plain fallback', async () => {
    script = [fail(new TypeError('network down'))]
    const page = await open()
    assert.match(page.textOfClass('alert error').join(' '), /Failed to load products/)
    assert.ok(page.hasButton('Retry'))
  })

  it('Retry asks again, shows "Loading…" meanwhile, then the products with the error gone', async () => {
    const retry = deferred<unknown>()
    script = [fail(new ApiError('Service unavailable', 503)), () => retry.promise]
    const page = await open()
    const clicking = page.click('Retry')
    await clicking
    assert.equal(calls, 2)
    assert.ok(page.text().includes('Loading…'))
    assert.deepEqual(page.textOfClass('alert error'), [], 'the old error is cleared while retrying')
    retry.resolve([listItem(), listItem({ id: 'p2', code: 'SHOP', name: 'Mobile Shop' })])
    await page.settle()
    assert.ok(page.text().includes('Hexalyte Salon') && page.text().includes('Mobile Shop'))
    assert.equal(page.hasButton('Retry'), false)
  })

  it('a second failure shows the error again, still with Retry', async () => {
    script = [fail(new ApiError('Service unavailable', 503)), fail(new ApiError('Still down', 503))]
    const page = await open()
    await page.click('Retry')
    assert.match(page.textOfClass('alert error').join(' '), /Still down/)
    assert.ok(page.hasButton('Retry'))
  })

  it('an empty catalogue is reported as empty, not as an error', async () => {
    script = [ok([])]
    const page = await open()
    assert.ok(page.text().includes('No products yet.'))
    assert.deepEqual(page.textOfClass('alert error'), [])
    assert.equal(page.hasButton('Retry'), false)
  })

  it('a successful load still lists the products and offers "New product"', async () => {
    script = [ok([listItem()])]
    const page = await open()
    assert.ok(page.text().includes('Hexalyte Salon') && page.text().includes('SALON'))
    assert.ok(page.hasButton('New product'))
    assert.equal(calls, 1)
  })
})

// ---------------------------------------------------------------------------------------------- product detail

const detailProduct = (over: Row = {}): Row => ({
  ...listItem(),
  integration: {
    provider: 'MANUAL', providerLabel: 'Manual fulfilment', requiresCredentials: false, baseUrl: null, hasApiKey: false, hasSigningSecret: false,
    lastCheckedAt: null, lastCheckOk: null, lastError: null, updatedAt: '2025-01-01T00:00:00.000Z',
  },
  ...over,
})
const PROVIDERS = [
  { key: 'MANUAL', label: 'Manual fulfilment', description: 'No remote API', requiresCredentials: false },
  { key: 'MOBILE_SHOP', label: 'Mobile Shop partner API', description: 'Partner API', requiresCredentials: true },
]
const LOGS = [
  { id: 'l1', operation: 'HEALTH_CHECK', entityId: null, success: true, httpStatus: 200, durationMs: 41, errorMessage: null, createdAt: '2025-03-01T10:00:00.000Z' },
  { id: 'l2', operation: 'CREATE_TRIAL', entityId: 'a1', success: false, httpStatus: 503, durationMs: 900, errorMessage: 'Upstream unavailable', createdAt: '2025-03-01T11:00:00.000Z' },
]

describe('Product detail page: failing requests and connection-test messages', () => {
  const script = { product: [] as Step[], logs: [] as Step[], providers: [] as Step[], test: [] as Step[], patch: [] as Step[] }
  let permissions: string[]
  const counts = { product: 0, logs: 0, providers: 0, test: 0 }
  const take = (name: keyof typeof script, fallback: Step) => (script[name].shift() ?? fallback)()

  const open = async () => {
    const page = mountPage(DETAIL_PAGE, {
      ...common,
      'next/navigation': { useParams: () => ({ id: 'p1' }) },
      '@/lib/admin-context': { useAdminUser: () => ({ permissions }) },
      '@/lib/api': {
        ApiError,
        apiRequest: async () => {
          counts.logs++
          return take('logs', ok({ data: [] }))
        },
        api: async (apiPath: string, init: { method?: string } = {}) => {
          const method = init.method ?? 'GET'
          if (method === 'GET' && apiPath === '/admin/saas-products/p1') {
            counts.product++
            return take('product', ok(detailProduct()))
          }
          if (method === 'GET' && apiPath === '/admin/saas-products/providers') {
            counts.providers++
            return take('providers', ok(PROVIDERS))
          }
          if (method === 'POST' && apiPath === '/admin/saas-products/p1/integration/test') {
            counts.test++
            return take('test', ok({ ok: true, message: null }))
          }
          if (method === 'PATCH' && apiPath === '/admin/saas-products/p1') return take('patch', ok(detailProduct({ name: 'Renamed', updatedAt: '2025-01-01T00:01:00.000Z' })))
          throw new Error(`unexpected API call ${method} ${apiPath}`)
        },
      },
    })
    await page.settle()
    return page
  }
  const alerts = (page: Awaited<ReturnType<typeof open>>, tone: 'info' | 'success' | 'error') => page.textOfClass(`alert ${tone}`).map((t) => t.replace(/\s+/g, ' ').trim())

  beforeEach(() => {
    for (const k of Object.keys(script) as Array<keyof typeof script>) script[k] = []
    permissions = ['products:manage', 'integrations:read', 'integrations:manage']
    counts.product = counts.logs = counts.providers = counts.test = 0
  })

  describe('integration calls', () => {
    it('shows "Loading…" (not "No calls yet.") until the calls have arrived', async () => {
      const pending = deferred<unknown>()
      script.logs = [() => pending.promise]
      const page = await open()
      assert.equal(page.text().includes('No calls yet.'), false)
      assert.ok(page.text().includes('Loading…'))
      pending.resolve({ data: LOGS })
      await page.settle()
      assert.ok(page.text().includes('HEALTH_CHECK') && page.text().includes('Upstream unavailable'))
    })

    it('a failed request is reported with the server message and a retry, never as an empty list', async () => {
      script.logs = [fail(new ApiError('Service unavailable', 503))]
      const page = await open()
      assert.match(alerts(page, 'error').join(' '), /Service unavailable/)
      assert.ok(page.hasButton('Retry loading calls'))
      assert.equal(page.text().includes('No calls yet.'), false)
      assert.ok(page.text().includes('Hexalyte Salon'), 'the rest of the page is unaffected')
    })

    it('a failure without a server message gets a plain fallback', async () => {
      script.logs = [fail(new TypeError('network down'))]
      const page = await open()
      assert.match(alerts(page, 'error').join(' '), /Failed to load integration calls/)
    })

    it('Retry loads the calls, or truthfully reports that there are none', async () => {
      script.logs = [fail(new ApiError('Service unavailable', 503)), ok({ data: LOGS })]
      const page = await open()
      await page.click('Retry loading calls')
      assert.equal(counts.logs, 2)
      assert.ok(page.text().includes('HEALTH_CHECK'))
      assert.equal(page.hasButton('Retry loading calls'), false)
      assert.deepEqual(alerts(page, 'error'), [])

      script.logs = [fail(new ApiError('Service unavailable', 503)), ok({ data: [] })]
      const second = await open()
      await second.click('Retry loading calls')
      assert.ok(second.text().includes('No calls yet.'))
    })
  })

  describe('integration implementations', () => {
    it('a failed request is reported with a retry, and Configure is not offered until it has loaded', async () => {
      script.providers = [fail(new ApiError('Service unavailable', 503))]
      const page = await open()
      assert.match(alerts(page, 'error').join(' '), /Service unavailable/)
      assert.ok(page.hasButton('Retry loading implementations'))
      assert.equal(page.isDisabled('Configure'), true)

      await page.click('Retry loading implementations')
      assert.equal(counts.providers, 2)
      assert.equal(page.isDisabled('Configure'), false)
      assert.equal(page.hasButton('Retry loading implementations'), false)
      assert.deepEqual(alerts(page, 'error'), [])
    })

    it('a failure without a server message gets a plain fallback', async () => {
      script.providers = [fail(new TypeError('network down'))]
      const page = await open()
      assert.match(alerts(page, 'error').join(' '), /Failed to load the available integration implementations/)
    })

    it('is not shown to someone who cannot configure integrations', async () => {
      permissions = ['products:manage', 'integrations:read']
      script.providers = [fail(new ApiError('Service unavailable', 503))]
      const page = await open()
      assert.deepEqual(alerts(page, 'error'), [])
      assert.equal(page.hasButton('Configure'), false)
    })

    it('Configure is available once the implementations have loaded', async () => {
      const page = await open()
      assert.equal(page.isDisabled('Configure'), false)
    })
  })

  describe('the product itself', () => {
    it('a failed first load shows the error, a way back to all products, and Retry', async () => {
      script.product = [fail(new ApiError('SaaS product not found', 404))]
      const page = await open()
      assert.match(alerts(page, 'error').join(' '), /SaaS product not found/)
      assert.ok(page.links().some((l) => l.href === '/admin/products' && /All products/.test(l.text)))
      assert.ok(page.hasButton('Retry'))
    })

    it('Retry loads the product', async () => {
      script.product = [fail(new TypeError('network down')), ok(detailProduct())]
      const page = await open()
      assert.match(alerts(page, 'error').join(' '), /Failed to load product/)
      await page.click('Retry')
      assert.equal(counts.product, 2)
      assert.ok(page.text().includes('Hexalyte Salon'))
      assert.deepEqual(alerts(page, 'error'), [])
    })

    it('a failed refresh keeps the page on screen, with an inline error and Retry', async () => {
      script.product = [ok(detailProduct()), fail(new ApiError('Service unavailable', 503))]
      const page = await open()
      await page.click('Test connection') // reloads the product afterwards
      assert.ok(page.text().includes('Hexalyte Salon'), 'the product stays visible')
      assert.match(alerts(page, 'error').join(' '), /Service unavailable/)
      assert.match(alerts(page, 'success').join(' '), /Connection OK/, 'the test result is not lost')
      await page.click('Retry')
      assert.deepEqual(alerts(page, 'error'), [])
    })
  })

  describe('connection test messages', () => {
    it('a passing test is shown in the success style', async () => {
      const page = await open()
      await page.click('Test connection')
      assert.deepEqual(alerts(page, 'success'), ['Connection OK.'])
      assert.deepEqual(alerts(page, 'error'), [])
      assert.deepEqual(alerts(page, 'info'), [])
    })

    it('a passing test with details keeps its text', async () => {
      script.test = [ok({ ok: true, message: '42 ms' })]
      const page = await open()
      await page.click('Test connection')
      assert.deepEqual(alerts(page, 'success'), ['Connection OK – 42 ms.'])
    })

    it('a failing test is shown in the error style, with its reason', async () => {
      script.test = [ok({ ok: false, message: 'timeout' })]
      const page = await open()
      await page.click('Test connection')
      assert.deepEqual(alerts(page, 'error'), ['Connection failed: timeout'])
      assert.deepEqual(alerts(page, 'success'), [])
      assert.deepEqual(alerts(page, 'info'), [])
    })

    it('a failing test without a reason says so', async () => {
      script.test = [ok({ ok: false, message: null })]
      const page = await open()
      await page.click('Test connection')
      assert.deepEqual(alerts(page, 'error'), ['Connection failed: unknown error'])
    })

    it('a request that fails outright is also an error', async () => {
      script.test = [fail(new ApiError('Integration is disabled for this product', 400))]
      const page = await open()
      await page.click('Test connection')
      assert.deepEqual(alerts(page, 'error'), ['Integration is disabled for this product'])
      script.test = [fail(new TypeError('network down'))]
      const other = await open()
      await other.click('Test connection')
      assert.deepEqual(alerts(other, 'error'), ['Connection test failed'])
    })

    it('a new test clears the previous result while it runs', async () => {
      const second = deferred<unknown>()
      script.test = [ok({ ok: false, message: 'timeout' }), () => second.promise]
      const page = await open()
      await page.click('Test connection')
      assert.equal(alerts(page, 'error').length, 1)
      const running = page.click('Test connection') // stays pending until `second` is resolved below
      await page.settle()
      assert.deepEqual([alerts(page, 'error'), alerts(page, 'success')], [[], []])
      second.resolve({ ok: true, message: null })
      await running
      assert.deepEqual([alerts(page, 'error'), alerts(page, 'success')], [[], ['Connection OK.']])
    })

    it('other notices keep their ordinary style', async () => {
      const page = await open()
      await page.click('Edit details')
      await page.fill('pd-name', 'Renamed')
      await page.click('Save')
      assert.deepEqual(alerts(page, 'info'), ['Product updated.'])
      assert.deepEqual(alerts(page, 'success'), [])
    })
  })
})
