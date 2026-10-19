import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { jsx, mountPage } from './helpers/render-page'

/**
 * Admin → SaaS product page: editing details when the product may have been changed by someone else.
 *
 * The real, unmodified page runs in Node through tests/helpers/render-page.ts (a minimal hook runtime, no DOM).
 * Its API is a small stub server that follows the same contract as PATCH /admin/saas-products/:id: the request
 * carries `expectedUpdatedAt`, a mismatch is answered with 409, a status other than the stored one is answered with 422
 * (status changes only through Retire / Restore), and a save returns the product with a new `updatedAt`.
 * Database-free; nothing here reads `.env`, runs Prisma or opens a connection.
 */

const PAGE = path.resolve(__dirname, '../../web/src/app/admin/products/[id]/page.tsx')
const V1 = '2025-01-01T00:00:00.000Z'
const V2 = '2025-01-01T00:01:00.000Z'
const V3 = '2025-01-01T00:02:00.000Z'

class ApiError extends Error {
  constructor(message: string, public status = 0, public code?: string, public errors: string[] = []) {
    super(message)
  }
}

type Product = Record<string, any>
const baseProduct = (over: Product = {}): Product => ({
  id: 'p1',
  code: 'SALON',
  name: 'Hexalyte Salon',
  description: null,
  status: 'ACTIVE',
  monthlyPrice: '5500',
  currency: 'LKR',
  trialAvailable: false,
  trialDays: null,
  integrationStatus: 'CONFIGURED',
  createdAt: '2024-12-01T00:00:00.000Z',
  updatedAt: V1,
  integration: {
    provider: 'MANUAL',
    providerLabel: 'Manual fulfilment',
    requiresCredentials: false,
    baseUrl: null,
    hasApiKey: false,
    hasSigningSecret: false,
    lastCheckedAt: null,
    lastCheckOk: null,
    lastError: null,
    updatedAt: V1,
  },
  _count: { resellerAccess: 2, accounts: 3 },
  ...over,
})

describe('Product page: editing details', () => {
  let server: Product
  let nextVersion: string
  let patches: Array<Record<string, any>>
  let gets: number
  let permissions: string[]
  let patchError: ApiError | undefined

  const productTypes = require('../../web/src/lib/product-types')
  const stubs = () => ({
    'next/link': { __esModule: true, default: ({ href, children }: { href: string; children: unknown }) => jsx('a', { href, children }) },
    'next/navigation': { useParams: () => ({ id: 'p1' }) },
    '@/lib/admin-context': { useAdminUser: () => ({ permissions }) },
    '@/lib/format': { formatMoney: (amount: string, currency: string) => `${currency} ${amount}`, formatDate: (value: string | null) => value ?? '—' },
    '@/lib/product-types': productTypes,
    '@/components/ui/Modal': { Modal: () => null },
    '@/components/admin/ProductLifecycleDialog': { ProductLifecycleDialog: () => null },
    '@/lib/api': {
      ApiError,
      apiRequest: async () => ({ data: [] }),
      api: async (apiPath: string, init: { method?: string; body?: string } = {}) => {
        const method = init.method ?? 'GET'
        if (method === 'GET' && apiPath === '/admin/saas-products/p1') {
          gets++
          return structuredClone(server)
        }
        if (method === 'GET' && apiPath === '/admin/saas-products/providers') return []
        if (method === 'POST' && apiPath === '/admin/saas-products/p1/integration/test') {
          return { ok: true, message: null }
        }
        if (method === 'PATCH' && apiPath === '/admin/saas-products/p1') {
          const body = JSON.parse(init.body ?? '{}')
          patches.push(body)
          if (patchError) throw patchError
          // The server's side of the contract.
          if (body.expectedUpdatedAt !== undefined && body.expectedUpdatedAt !== server.updatedAt) {
            throw new ApiError('This product was changed since you opened it.', 409)
          }
          if (body.status !== undefined && body.status !== server.status) {
            throw new ApiError('Validation error', 422, undefined, ['status: Status cannot be changed by editing a product.'])
          }
          const { expectedUpdatedAt, ...fields } = body
          server = { ...server, ...fields, monthlyPrice: String(fields.monthlyPrice), updatedAt: nextVersion }
          return structuredClone(server)
        }
        throw new Error(`unexpected API call ${method} ${apiPath}`)
      },
    },
  })

  const open = async () => {
    const page = mountPage(PAGE, stubs())
    await page.settle()
    return page
  }

  beforeEach(() => {
    server = baseProduct()
    nextVersion = V2
    patches = []
    gets = 0
    permissions = ['products:manage', 'integrations:read']
    patchError = undefined
  })

  it('a save carries the version of the product the form was opened on', async () => {
    const page = await open()
    await page.click('Edit details')
    await page.fill('pd-name', 'Renamed')
    await page.click('Save')
    assert.equal(patches.length, 1)
    assert.equal(patches[0].expectedUpdatedAt, V1)
    assert.equal(patches[0].name, 'Renamed')
    assert.ok(page.text().includes('Product updated.'))
  })

  it('the form does not offer a status: it is shown read-only with a pointer to Retire / Restore, and a save never sends one', async () => {
    const page = await open()
    await page.click('Edit details')
    assert.equal(page.valueOf('pd-status'), undefined, 'no status control in the form')
    assert.match(page.text(), /Status is not changed here/)
    for (const label of ['Retire product', 'Restore product', 'Set coming soon', 'Launch product']) assert.match(page.text(), new RegExp(label))
    await page.fill('pd-name', 'Renamed')
    await page.click('Save')
    assert.equal(patches.length, 1)
    assert.equal('status' in patches[0], false)
    assert.deepEqual(Object.keys(patches[0]).sort(), ['description', 'expectedUpdatedAt', 'monthlyPrice', 'name', 'trialAvailable', 'trialDays'])
    assert.equal(server.status, 'ACTIVE')
    assert.ok(page.text().includes('Product updated.'))
  })

  it('a retired product is edited the same way: no status is sent, it stays retired, and Restore is still offered', async () => {
    server = baseProduct({ status: 'INACTIVE' })
    const page = await open()
    await page.click('Edit details')
    await page.fill('pd-name', 'Renamed')
    await page.click('Save')
    assert.equal('status' in patches[0], false)
    assert.equal(server.status, 'INACTIVE')
    assert.equal(server.name, 'Renamed')
    assert.ok(page.hasButton('Restore product'))
    assert.equal(page.hasButton('Retire product'), false)
  })

  it('the next edit is based on the version the previous save returned', async () => {
    const page = await open()
    await page.click('Edit details')
    await page.fill('pd-name', 'First')
    await page.click('Save')
    nextVersion = V3
    await page.click('Edit details')
    await page.fill('pd-name', 'Second')
    await page.click('Save')
    assert.deepEqual(patches.map((p) => p.expectedUpdatedAt), [V1, V2])
    assert.equal(server.name, 'Second')
    assert.ok(page.text().includes('Product updated.'))
  })

  it('a stale save is reported clearly: not saved, what was typed is kept, no retry, no overwrite', async () => {
    const page = await open()
    await page.click('Edit details')
    await page.fill('pd-name', 'My rename')
    server = baseProduct({ monthlyPrice: '6000', updatedAt: V2 }) // someone else saved meanwhile
    await page.click('Save')

    const alerts = page.textOfClass('alert').join(' ')
    assert.match(alerts, /changed by someone else/i)
    assert.match(alerts, /not saved/i)
    assert.equal(patches.length, 1, 'no automatic retry')
    assert.equal(server.name, 'Hexalyte Salon', 'nothing was overwritten')
    assert.equal(server.monthlyPrice, '6000')
    assert.equal(page.valueOf('pd-name'), 'My rename', 'what the admin typed is still there')
    assert.ok(page.hasButton('Reload latest version'))
    assert.equal(page.isDisabled('Save'), true, 'saving the stale form again is not offered')
  })

  it('"Reload latest version" shows what the other admin saved and starts a fresh edit from it', async () => {
    const page = await open()
    await page.click('Edit details')
    await page.fill('pd-name', 'My rename')
    server = baseProduct({ name: 'Changed by A', monthlyPrice: '6000', updatedAt: V2 })
    await page.click('Save')
    const getsBefore = gets

    await page.click('Reload latest version')
    assert.equal(gets, getsBefore + 1, 'the product was fetched again')
    assert.equal(page.valueOf('pd-name'), 'Changed by A')
    assert.equal(page.valueOf('pd-price'), '6000')
    assert.equal(page.textOfClass('alert').join(' ').match(/changed by someone else/i), null, 'the conflict message is gone')
    assert.equal(page.isDisabled('Save'), false)

    nextVersion = V3
    await page.fill('pd-name', 'Merged name')
    await page.click('Save')
    assert.equal(patches.at(-1)?.expectedUpdatedAt, V2, 'the new edit is based on the reloaded version')
    assert.equal(server.name, 'Merged name')
    assert.equal(server.monthlyPrice, '6000', "A's price survived")
  })

  it('a background refresh does not move the version an open form is based on', async () => {
    permissions = ['products:manage', 'integrations:read', 'integrations:manage']
    const page = await open()
    await page.click('Edit details')
    await page.fill('pd-name', 'My rename')
    server = baseProduct({ updatedAt: V2, integrationStatus: 'CONNECTED' }) // e.g. a health check ran
    await page.click('Test connection') // refreshes the displayed product to V2
    await page.click('Save')
    assert.equal(patches[0].expectedUpdatedAt, V1, 'still the version the form was opened on')
    assert.match(page.textOfClass('alert').join(' '), /changed by someone else/i)
  })

  it('other errors keep showing the server message, not the conflict message', async () => {
    patchError = new ApiError('Validation error', 422, undefined, ['name: String must contain at least 2 character(s)'])
    const page = await open()
    await page.click('Edit details')
    await page.fill('pd-name', 'x')
    await page.click('Save')
    const alerts = page.textOfClass('alert').join(' ')
    assert.match(alerts, /must contain at least 2/)
    assert.equal(/changed by someone else/i.test(alerts), false)
    assert.equal(page.hasButton('Reload latest version'), false)
    assert.equal(page.isDisabled('Save'), false)
  })
})
