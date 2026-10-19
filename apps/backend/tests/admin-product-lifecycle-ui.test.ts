import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { jsx, mountPage } from './helpers/render-page'

/**
 * Admin → SaaS product page: retire / restore and the review of partners without access.
 *  - ProductLifecycleDialog (apps/web/src/components/admin/ProductLifecycleDialog.tsx) is mounted on its own with props;
 *  - the product page (apps/web/src/app/admin/products/[id]/page.tsx) is mounted with a stand-in dialog that records the
 *    props it was given, to check the page's wiring.
 * Both run unmodified in Node through tests/helpers/render-page.ts (minimal hook runtime, no DOM) against scripted API
 * stubs. Database-free; nothing here reads `.env`, runs Prisma or opens a connection.
 */

const DIALOG = path.resolve(__dirname, '../../web/src/components/admin/ProductLifecycleDialog.tsx')
const PAGE = path.resolve(__dirname, '../../web/src/app/admin/products/[id]/page.tsx')
const V1 = '2025-01-01T00:00:00.000Z'
const V2 = '2025-01-01T00:01:00.000Z'

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
const formatStub = {
  formatMoney: (amount: string, currency: string) => `${currency} ${amount}`,
  formatDate: (value: string | null) => (value ? `on ${value.slice(0, 10)}` : '—'),
}
const flat = (s: string) => s.replace(/\s+/g, ' ').trim()

const IMPACT = {
  productId: 'p1',
  status: 'ACTIVE',
  customerAccounts: { active: 3, trial: 2, pending: 1 },
  openActivationRequests: 3,
  openDemoRequests: { total: 4, awaitingConfirmation: 2 },
  unpaidCommissions: { count: 5, totals: [{ currency: 'LKR', amount: '550.55' }, { currency: 'USD', amount: '10.00' }] },
  resellers: { withAccess: 2, approvedWithoutAccess: 2 },
}
const withImpact = (over: Row) => ({ ...structuredClone(IMPACT), ...over })

const productFixture = (over: Row = {}): Row => ({
  id: 'p1', code: 'SALON', name: 'Hexalyte Salon', description: null, status: 'ACTIVE', monthlyPrice: '5500', currency: 'LKR',
  trialAvailable: true, trialDays: 14, integrationStatus: 'CONFIGURED', createdAt: '2024-12-01T00:00:00.000Z', updatedAt: V1,
  integration: {
    provider: 'MANUAL', providerLabel: 'Manual fulfilment', requiresCredentials: false, baseUrl: null, hasApiKey: false, hasSigningSecret: false,
    lastCheckedAt: null, lastCheckOk: null, lastError: null, updatedAt: V1,
  },
  _count: { resellerAccess: 2, accounts: 3 },
  ...over,
})

// ------------------------------------------------------------------------------------------------- the dialog

type Action = 'retire' | 'restore' | 'coming-soon' | 'launch'
/** The status a product has when each action is offered (the page offers "Set coming soon" on an active product first), and the one it ends in. */
const STATUS_BEFORE: Record<Action, string> = { retire: 'ACTIVE', restore: 'INACTIVE', 'coming-soon': 'ACTIVE', launch: 'COMING_SOON' }
const STATUS_AFTER: Record<Action, string> = { retire: 'INACTIVE', restore: 'ACTIVE', 'coming-soon': 'COMING_SOON', launch: 'ACTIVE' }

describe('Lifecycle dialog (retire, restore, set coming soon, launch)', () => {
  const script = { impact: [] as Step[], post: [] as Step[] }
  let posts: Array<{ path: string; body: Row }>
  let impactRequests: number

  const open = async (action: Action, status: string = STATUS_BEFORE[action]) => {
    const calls = { closed: 0, reloaded: 0, done: [] as Array<{ updated: Row; message: string }> }
    const page = mountPage(
      DIALOG,
      {
        '@/lib/format': formatStub,
        '@/lib/product-types': productTypes,
        '@/components/ui/Modal': { Modal: ({ children }: { children: unknown }) => children },
        '@/lib/api': {
          ApiError,
          api: async (apiPath: string, init: { method?: string; body?: string } = {}) => {
            const method = init.method ?? 'GET'
            if (method === 'GET' && apiPath === '/admin/saas-products/p1/impact') {
              impactRequests++
              return (script.impact.shift() ?? ok(IMPACT))()
            }
            if (method === 'POST' && apiPath === `/admin/saas-products/p1/${action}`) {
              posts.push({ path: apiPath, body: JSON.parse(init.body ?? '{}') })
              return (script.post.shift() ?? ok(productFixture({ status: STATUS_AFTER[action], updatedAt: V2 })))()
            }
            throw new Error(`unexpected API call ${method} ${apiPath}`)
          },
        },
      },
      {
        exportName: 'ProductLifecycleDialog',
        props: {
          product: { id: 'p1', name: 'Hexalyte Salon', status, updatedAt: V1 },
          action,
          onClose: () => calls.closed++,
          onReload: () => calls.reloaded++,
          onDone: (updated: Row, message: string) => calls.done.push({ updated, message }),
        },
      },
    )
    await page.settle()
    return { page, calls, text: () => flat(page.text()), alerts: (tone: string) => page.textOfClass(`alert ${tone}`).map(flat) }
  }

  beforeEach(() => {
    script.impact = []
    script.post = []
    posts = []
    impactRequests = 0
  })

  describe('retire', () => {
    it('loads what retiring affects first, and only then can it be confirmed', async () => {
      const pending = deferred<unknown>()
      script.impact = [() => pending.promise]
      const d = await open('retire')
      assert.ok(d.text().includes('Checking what this affects…'))
      assert.equal(d.page.isDisabled('Retire product'), true)

      pending.resolve(IMPACT)
      await d.page.settle()
      const text = d.text()
      assert.match(text, /Paid customer accounts 3 Stay active; their subscriptions and commissions continue\./)
      assert.match(text, /Trial accounts 2 Cannot be converted to paid while the product is inactive\. 1 more trial being set up\./)
      assert.match(text, /Open activation requests 3 Can still be reviewed and completed\./)
      assert.match(text, /Open demo requests 4 2 waiting for confirmation\./)
      assert.match(text, /Unpaid commissions 5 LKR 550\.55, USD 10\.00\. Unchanged; approve and pay them as usual\./)
      assert.match(text, /Partners with access 2 Kept as they are; nothing is revoked\./)
      assert.equal(d.page.isDisabled('Retire product'), false)
    })

    it('always warns that retiring blocks new sales and trial-to-paid conversion, and says what does not change', async () => {
      const d = await open('retire')
      const warning = d.alerts('warning').join(' ')
      assert.match(warning, /Retiring blocks new sales\./)
      assert.match(warning, /existing trial accounts cannot be converted to paid until it is restored/)
      assert.match(d.text(), /Nothing is deleted\. Partner access and the integration settings are not changed\./)
    })

    it('warns that demo requests waiting for confirmation cannot be confirmed while inactive, only when there are some', async () => {
      assert.match((await open('retire')).alerts('warning').join(' '), /2 demo requests are waiting for confirmation\. Confirmation is blocked while the product is inactive\./)

      script.impact = [ok(withImpact({ openDemoRequests: { total: 1, awaitingConfirmation: 1 } }))]
      assert.match((await open('retire')).alerts('warning').join(' '), /1 demo request is waiting for confirmation\./)

      script.impact = [ok(withImpact({ openDemoRequests: { total: 2, awaitingConfirmation: 0 } }))]
      const none = await open('retire')
      assert.equal(none.alerts('warning').join(' ').includes('waiting for confirmation'), false)
      assert.match(none.text(), /Open demo requests 2 Can still be reviewed\./)
    })

    it('a failed impact load is shown with Retry, and confirming stays disabled until it has loaded', async () => {
      script.impact = [fail(new ApiError('Service unavailable', 503)), ok(IMPACT)]
      const d = await open('retire')
      assert.match(d.alerts('error').join(' '), /Could not load what this affects: Service unavailable/)
      assert.equal(d.page.isDisabled('Retire product'), true)
      await d.page.click('Retry')
      assert.deepEqual(d.alerts('error'), [])
      assert.match(d.text(), /Paid customer accounts 3/)
      assert.equal(d.page.isDisabled('Retire product'), false)
    })

    it('a reason of at least 10 characters is required; nothing is sent without one', async () => {
      const d = await open('retire')
      for (const reason of ['', 'too short', '      short     ']) {
        await d.page.fill('pl-reason', reason)
        await d.page.click('Retire product')
        assert.deepEqual(d.alerts('error'), ['Give a reason of at least 10 characters.'], JSON.stringify(reason))
      }
      assert.deepEqual(posts, [])
      assert.equal(d.calls.done.length, 0)
    })

    it('confirming sends the trimmed reason and the version the page showed, then hands the result back', async () => {
      const d = await open('retire')
      await d.page.fill('pl-reason', '   Replaced by Salon Pro   ')
      await d.page.click('Retire product')
      assert.deepEqual(posts, [{ path: '/admin/saas-products/p1/retire', body: { reason: 'Replaced by Salon Pro', expectedUpdatedAt: V1 } }])
      assert.equal(d.calls.done.length, 1)
      assert.equal(d.calls.done[0].updated.status, 'INACTIVE')
      assert.equal(
        d.calls.done[0].message,
        'Hexalyte Salon retired. New sales and trial-to-paid conversions are blocked; paid subscriptions and commissions continue.',
      )
    })

    it('while saving, both buttons are disabled and the action says so', async () => {
      const saving = deferred<unknown>()
      script.post = [() => saving.promise]
      const d = await open('retire')
      await d.page.fill('pl-reason', 'Replaced by Salon Pro')
      const running = d.page.click('Retire product')
      await d.page.settle()
      assert.equal(d.page.isDisabled('Saving…'), true)
      assert.equal(d.page.isDisabled('Cancel'), true)
      saving.resolve(productFixture({ status: 'INACTIVE', updatedAt: V2 }))
      await running
      assert.equal(d.calls.done.length, 1)
    })

    it('a conflict (409) shows the server message and only offers reloading: nothing is retried or reported as done', async () => {
      const message = 'This product has been changed since you opened it. Reload it to see the latest version; nothing was changed.'
      script.post = [fail(new ApiError(message, 409, 'PRODUCT_CHANGED'))]
      const d = await open('retire')
      await d.page.fill('pl-reason', 'Replaced by Salon Pro')
      await d.page.click('Retire product')
      assert.match(d.alerts('error').join(' '), new RegExp(message.replace(/[.;]/g, '\\$&')))
      assert.equal(d.page.isDisabled('Retire product'), true, 'the stale dialog cannot be confirmed again')
      await d.page.click('Reload product')
      assert.equal(d.calls.reloaded, 1)
      assert.equal(posts.length, 1, 'no automatic retry')
      assert.equal(d.calls.done.length, 0)
    })

    it('other errors keep the dialog open with the message, and it can be confirmed again', async () => {
      script.post = [fail(new ApiError('Validation error', 422, undefined, ['reason: Give a reason of at least 10 characters'])), fail(new TypeError('network down'))]
      const d = await open('retire')
      await d.page.fill('pl-reason', 'Replaced by Salon Pro')
      await d.page.click('Retire product')
      assert.deepEqual(d.alerts('error'), ['reason: Give a reason of at least 10 characters'])
      await d.page.click('Retire product')
      assert.deepEqual(d.alerts('error'), ['Request failed'])
      await d.page.click('Retire product')
      assert.equal(d.calls.done.length, 1)
      assert.equal(posts.length, 3)
    })

    it('Cancel closes without sending anything', async () => {
      const d = await open('retire')
      await d.page.click('Cancel')
      assert.equal(d.calls.closed, 1)
      assert.deepEqual(posts, [])
    })
  })

  describe('restore', () => {
    it('shows who can sell again, and that approved partners without access are not given it', async () => {
      const d = await open('restore')
      const text = d.text()
      assert.match(text, /Partners with active access 2 Can sell it again straight away\./)
      assert.match(text, /Trial accounts 2 Can be converted to paid again\./)
      assert.match(
        d.alerts('warning').join(' '),
        /2 approved partners have no access record for this product, for example partners approved while it was inactive\. Restoring does not give them access\./,
      )
      assert.equal(text.includes('Retiring blocks new sales'), false)
    })

    it('a note is optional: without one only the version is sent', async () => {
      const d = await open('restore')
      await d.page.click('Restore product')
      assert.deepEqual(posts, [{ path: '/admin/saas-products/p1/restore', body: { expectedUpdatedAt: V1 } }])
      assert.equal(
        d.calls.done[0].message,
        'Hexalyte Salon restored. Partners with active access can sell it again. 2 approved partners without an access record were not given access; review them under “Partner access”.',
      )
    })

    it('a note, when given, is trimmed and sent', async () => {
      const d = await open('restore')
      await d.page.fill('pl-note', '  Back in the catalogue  ')
      await d.page.click('Restore product')
      assert.deepEqual(posts[0].body, { note: 'Back in the catalogue', expectedUpdatedAt: V1 })
    })

    it('when every approved partner has an access record there is nothing to warn about', async () => {
      script.impact = [ok(withImpact({ resellers: { withAccess: 6, approvedWithoutAccess: 0 } }))]
      const d = await open('restore')
      assert.deepEqual(d.alerts('warning'), [])
      assert.match(d.text(), /Every approved partner has an access record for this product\./)
      await d.page.click('Restore product')
      assert.equal(d.calls.done[0].message, 'Hexalyte Salon restored. Partners with active access can sell it again.')
    })

    it('a conflict offers reloading here too', async () => {
      script.post = [fail(new ApiError('This product is active; only inactive products can be restored.', 409, 'PRODUCT_LIFECYCLE_CONFLICT'))]
      const d = await open('restore')
      await d.page.click('Restore product')
      assert.match(d.alerts('error').join(' '), /only inactive products can be restored/)
      await d.page.click('Reload product')
      assert.equal(d.calls.reloaded, 1)
    })
  })

  describe('set coming soon (an active product)', () => {
    it('loads what it affects first, and only then can it be confirmed; the wording says coming soon, not retired', async () => {
      const pending = deferred<unknown>()
      script.impact = [() => pending.promise]
      const d = await open('coming-soon')
      assert.ok(d.text().includes('Checking what this affects…'))
      assert.equal(d.page.isDisabled('Set coming soon'), true)

      pending.resolve(IMPACT)
      await d.page.settle()
      const text = d.text()
      assert.match(text, /Set Hexalyte Salon to coming soon/)
      assert.match(text, /Setting a product to coming soon takes it off sale until it is launched\. Launching sets it to Active\./)
      assert.match(text, /Paid customer accounts 3 Stay active; their subscriptions and commissions continue\./)
      assert.match(text, /Trial accounts 2 Cannot be converted to paid while the product is coming soon\. 1 more trial being set up\./)
      assert.match(text, /Unpaid commissions 5 LKR 550\.55, USD 10\.00\. Unchanged; approve and pay them as usual\./)
      assert.match(text, /Partners with access 2 Kept as they are; nothing is revoked\./)
      const warning = d.alerts('warning').join(' ')
      assert.match(warning, /Setting coming soon blocks new sales\./)
      assert.match(warning, /existing trial accounts cannot be converted to paid until it is launched/)
      assert.match(warning, /2 demo requests are waiting for confirmation\. Confirmation is blocked while the product is coming soon\./)
      assert.equal(/retir|inactive|restored/i.test(text), false, 'none of the retire wording is reused')
      assert.match(text, /Nothing is deleted\. Partner access and the integration settings are not changed\./)
      assert.equal(d.page.isDisabled('Set coming soon'), false)
      assert.deepEqual(d.page.textOfClass('btn danger'), ['Set coming soon'], 'taking a product off sale is styled as the risky direction')
    })

    it('a failed impact load is shown with Retry, and confirming stays disabled until it has loaded', async () => {
      script.impact = [fail(new ApiError('Service unavailable', 503)), ok(IMPACT)]
      const d = await open('coming-soon')
      assert.match(d.alerts('error').join(' '), /Could not load what this affects: Service unavailable/)
      assert.equal(d.page.isDisabled('Set coming soon'), true)
      await d.page.click('Retry')
      assert.deepEqual(d.alerts('error'), [])
      assert.equal(d.page.isDisabled('Set coming soon'), false)
    })

    it('a reason of at least 10 characters is required, like retire; nothing is sent without one', async () => {
      const d = await open('coming-soon')
      assert.match(d.page.textOfClass('field').join(' '), /Reason \(recorded in the audit log\)/)
      for (const reason of ['', 'too short', '      short     ']) {
        await d.page.fill('pl-reason', reason)
        await d.page.click('Set coming soon')
        assert.deepEqual(d.alerts('error'), ['Give a reason of at least 10 characters.'], JSON.stringify(reason))
      }
      assert.deepEqual(posts, [])
      assert.equal(d.calls.done.length, 0)
    })

    it('confirming sends the trimmed reason and the version the page showed to /coming-soon, then hands the result back', async () => {
      const d = await open('coming-soon')
      await d.page.fill('pl-reason', '   Waiting for the partner API   ')
      await d.page.click('Set coming soon')
      assert.deepEqual(posts, [{ path: '/admin/saas-products/p1/coming-soon', body: { reason: 'Waiting for the partner API', expectedUpdatedAt: V1 } }])
      assert.equal(d.calls.done.length, 1)
      assert.equal(d.calls.done[0].updated.status, 'COMING_SOON')
      assert.equal(
        d.calls.done[0].message,
        'Hexalyte Salon set to coming soon. New sales and trial-to-paid conversions are blocked; paid subscriptions and commissions continue.',
      )
    })

    it('while saving, both buttons are disabled and the action says so', async () => {
      const saving = deferred<unknown>()
      script.post = [() => saving.promise]
      const d = await open('coming-soon')
      await d.page.fill('pl-reason', 'Waiting for the partner API')
      const running = d.page.click('Set coming soon')
      await d.page.settle()
      assert.equal(d.page.isDisabled('Saving…'), true)
      assert.equal(d.page.isDisabled('Cancel'), true)
      saving.resolve(productFixture({ status: 'COMING_SOON', updatedAt: V2 }))
      await running
      assert.equal(d.calls.done.length, 1)
    })

    it('a conflict (409) shows the server message and only offers reloading: nothing is retried or reported as done', async () => {
      const message = 'This product has been changed since you opened it. Reload it to see the latest version; nothing was changed.'
      script.post = [fail(new ApiError(message, 409, 'PRODUCT_CHANGED'))]
      const d = await open('coming-soon')
      await d.page.fill('pl-reason', 'Waiting for the partner API')
      await d.page.click('Set coming soon')
      assert.match(d.alerts('error').join(' '), new RegExp(message.replace(/[.;]/g, '\\$&')))
      assert.equal(d.page.isDisabled('Set coming soon'), true, 'the stale dialog cannot be confirmed again')
      await d.page.click('Reload product')
      assert.equal(d.calls.reloaded, 1)
      assert.equal(posts.length, 1, 'no automatic retry')
      assert.equal(d.calls.done.length, 0)
    })

    it('an invalid transition (409 from the server) is shown the same way, with a reload', async () => {
      script.post = [fail(new ApiError('This product is coming soon; only active or inactive products can be set to coming soon.', 409, 'PRODUCT_LIFECYCLE_CONFLICT'))]
      const d = await open('coming-soon')
      await d.page.fill('pl-reason', 'Waiting for the partner API')
      await d.page.click('Set coming soon')
      assert.match(d.alerts('error').join(' '), /only active or inactive products can be set to coming soon/)
      assert.ok(d.page.hasButton('Reload product'))
      assert.equal(d.calls.done.length, 0)
    })

    it('other errors keep the dialog open with the message, and it can be confirmed again', async () => {
      script.post = [fail(new ApiError('Validation error', 422, undefined, ['reason: Give a reason of at least 10 characters'])), fail(new TypeError('network down'))]
      const d = await open('coming-soon')
      await d.page.fill('pl-reason', 'Waiting for the partner API')
      await d.page.click('Set coming soon')
      assert.deepEqual(d.alerts('error'), ['reason: Give a reason of at least 10 characters'])
      await d.page.click('Set coming soon')
      assert.deepEqual(d.alerts('error'), ['Request failed'])
      await d.page.click('Set coming soon')
      assert.equal(d.calls.done.length, 1)
      assert.equal(posts.length, 3)
    })

    it('Cancel closes without sending anything', async () => {
      const d = await open('coming-soon')
      await d.page.click('Cancel')
      assert.equal(d.calls.closed, 1)
      assert.deepEqual(posts, [])
    })
  })

  describe('set coming soon (an inactive product)', () => {
    it('is already off sale: nothing is loaded, it says so, and there is no impact table', async () => {
      const d = await open('coming-soon', 'INACTIVE')
      assert.equal(impactRequests, 0, 'there is nothing to review, so nothing is requested')
      assert.equal(d.text().includes('Checking what this affects…'), false)
      assert.match(d.text(), /Setting a product to coming soon marks it as not launched yet\. It stays off sale until it is launched\./)
      assert.deepEqual(d.alerts('info'), ['This product is already off sale, so nothing changes for partners, trials or customers.'])
      assert.deepEqual(d.alerts('warning'), [])
      assert.equal(d.text().includes('Paid customer accounts'), false)
      assert.equal(d.page.isDisabled('Set coming soon'), false)
      assert.deepEqual(d.page.textOfClass('btn danger'), [], 'not styled as taking the product off sale')
    })

    it('still needs a reason of at least 10 characters', async () => {
      const d = await open('coming-soon', 'INACTIVE')
      await d.page.fill('pl-reason', 'too short')
      await d.page.click('Set coming soon')
      assert.deepEqual(d.alerts('error'), ['Give a reason of at least 10 characters.'])
      assert.deepEqual(posts, [])
    })

    it('confirming sends the reason and the version, and the summary says nothing changed for partners', async () => {
      const d = await open('coming-soon', 'INACTIVE')
      await d.page.fill('pl-reason', '  Relaunching next quarter  ')
      await d.page.click('Set coming soon')
      assert.deepEqual(posts, [{ path: '/admin/saas-products/p1/coming-soon', body: { reason: 'Relaunching next quarter', expectedUpdatedAt: V1 } }])
      assert.equal(d.calls.done[0].message, 'Hexalyte Salon set to coming soon. It was already off sale, so nothing changed for partners or customers.')
      assert.equal(impactRequests, 0)
    })

    it('a conflict offers reloading here too', async () => {
      script.post = [fail(new ApiError('This product has been changed since you opened it.', 409, 'PRODUCT_CHANGED'))]
      const d = await open('coming-soon', 'INACTIVE')
      await d.page.fill('pl-reason', 'Relaunching next quarter')
      await d.page.click('Set coming soon')
      assert.equal(d.page.isDisabled('Set coming soon'), true)
      await d.page.click('Reload product')
      assert.equal(d.calls.reloaded, 1)
      assert.equal(d.calls.done.length, 0)
    })
  })

  describe('launch', () => {
    it('loads who can sell it straight away first, and says approved partners without access are not given it', async () => {
      const pending = deferred<unknown>()
      script.impact = [() => pending.promise]
      const d = await open('launch')
      assert.equal(d.page.isDisabled('Launch product'), true)
      pending.resolve(IMPACT)
      await d.page.settle()
      const text = d.text()
      assert.match(text, /Launch Hexalyte Salon/)
      assert.match(text, /Launching sets a coming-soon product to Active, putting it on sale\./)
      assert.match(text, /Partners with active access 2 Can sell it straight away\./)
      assert.match(text, /Trial accounts 2 Can be converted to paid\./)
      assert.match(
        d.alerts('warning').join(' '),
        /2 approved partners have no access record for this product, for example partners approved while it was coming soon\. Launching does not give them access\. After launching, review them under “Partner access” on this page/,
      )
      assert.equal(/Retiring|restor|inactive/i.test(text), false, 'none of the restore wording is reused')
      assert.equal(d.page.isDisabled('Launch product'), false)
      assert.deepEqual(d.page.textOfClass('btn success'), ['Launch product'])
    })

    it('a note is optional: without one only the version is sent', async () => {
      const d = await open('launch')
      assert.match(d.page.textOfClass('field').join(' '), /Note \(optional, recorded in the audit log\)/)
      await d.page.click('Launch product')
      assert.deepEqual(posts, [{ path: '/admin/saas-products/p1/launch', body: { expectedUpdatedAt: V1 } }])
      assert.equal(d.calls.done[0].updated.status, 'ACTIVE')
      assert.equal(
        d.calls.done[0].message,
        'Hexalyte Salon launched. Partners with active access can sell it. 2 approved partners without an access record were not given access; review them under “Partner access”.',
      )
    })

    it('a note, when given, is trimmed and sent', async () => {
      const d = await open('launch')
      await d.page.fill('pl-note', '  Partner API is live  ')
      await d.page.click('Launch product')
      assert.deepEqual(posts[0].body, { note: 'Partner API is live', expectedUpdatedAt: V1 })
    })

    it('when every approved partner has an access record there is nothing to warn about', async () => {
      script.impact = [ok(withImpact({ resellers: { withAccess: 6, approvedWithoutAccess: 0 } }))]
      const d = await open('launch')
      assert.deepEqual(d.alerts('warning'), [])
      assert.match(d.text(), /Every approved partner has an access record for this product\./)
      await d.page.click('Launch product')
      assert.equal(d.calls.done[0].message, 'Hexalyte Salon launched. Partners with active access can sell it.')
    })

    it('a failed impact load is shown with Retry, and confirming stays disabled until it has loaded', async () => {
      script.impact = [fail(new ApiError('Service unavailable', 503)), ok(IMPACT)]
      const d = await open('launch')
      assert.match(d.alerts('error').join(' '), /Could not load what this affects: Service unavailable/)
      assert.equal(d.page.isDisabled('Launch product'), true)
      await d.page.click('Retry')
      assert.equal(d.page.isDisabled('Launch product'), false)
    })

    it('a conflict (409) offers only reloading: the dialog cannot be confirmed again and nothing is retried', async () => {
      script.post = [fail(new ApiError('This product is active; only coming-soon products can be launched.', 409, 'PRODUCT_LIFECYCLE_CONFLICT'))]
      const d = await open('launch')
      await d.page.click('Launch product')
      assert.match(d.alerts('error').join(' '), /only coming-soon products can be launched/)
      assert.equal(d.page.isDisabled('Launch product'), true)
      await d.page.click('Reload product')
      assert.equal(d.calls.reloaded, 1)
      assert.equal(posts.length, 1)
      assert.equal(d.calls.done.length, 0)
    })

    it('Cancel closes without sending anything', async () => {
      const d = await open('launch')
      await d.page.click('Cancel')
      assert.equal(d.calls.closed, 1)
      assert.deepEqual(posts, [])
    })
  })
})

// ----------------------------------------------------------------------------------------------- the product page

describe('Product page: lifecycle actions and partner access review', () => {
  const script = { product: [] as Step[], missing: [] as Step[] }
  let permissions: string[]
  let dialog: Row | null
  let calls: Array<{ method: string; path: string }>
  let status: string

  const MISSING = {
    total: 2,
    limit: 200,
    items: [
      { id: 'r6', code: 'RS-r6', businessName: 'Alpha Traders', approvedAt: '2025-02-01T00:00:00.000Z' },
      { id: 'r5', code: 'RS-r5', businessName: 'Zeta Mobiles', approvedAt: null },
    ],
  }

  const open = async () => {
    const page = mountPage(PAGE, {
      'next/link': { __esModule: true, default: ({ href, children }: { href: string; children: unknown }) => jsx('a', { href, children }) },
      'next/navigation': { useParams: () => ({ id: 'p1' }) },
      '@/lib/admin-context': { useAdminUser: () => ({ permissions }) },
      '@/lib/format': formatStub,
      '@/lib/product-types': productTypes,
      '@/components/ui/Modal': { Modal: () => null },
      '@/components/admin/ProductLifecycleDialog': {
        ProductLifecycleDialog: (props: Row) => {
          dialog = props
          return jsx('div', { className: 'lifecycle-dialog', children: `dialog:${props.action}` })
        },
      },
      '@/lib/api': {
        ApiError,
        apiRequest: async () => ({ data: [] }),
        api: async (apiPath: string, init: { method?: string } = {}) => {
          const method = init.method ?? 'GET'
          calls.push({ method, path: apiPath })
          if (method === 'GET' && apiPath === '/admin/saas-products/p1') return (script.product.shift() ?? ok(productFixture({ status })))()
          if (method === 'GET' && apiPath === '/admin/saas-products/providers') return []
          if (method === 'GET' && apiPath === '/admin/saas-products/p1/resellers-without-access') return (script.missing.shift() ?? ok(MISSING))()
          throw new Error(`unexpected API call ${method} ${apiPath}`)
        },
      },
    })
    await page.settle()
    return page
  }
  const dialogShown = (page: Awaited<ReturnType<typeof open>>) => page.textOfClass('lifecycle-dialog')

  beforeEach(() => {
    script.product = []
    script.missing = []
    permissions = ['products:manage', 'resellers:read', 'integrations:read', 'integrations:manage']
    dialog = null
    calls = []
    status = 'ACTIVE'
  })

  describe('retire and restore', () => {
    it('an active product offers "Retire product" to product managers', async () => {
      const page = await open()
      assert.ok(page.hasButton('Retire product'))
      assert.equal(page.hasButton('Restore product'), false)
    })

    it('a coming-soon product can be retired too', async () => {
      status = 'COMING_SOON'
      assert.ok((await open()).hasButton('Retire product'))
    })

    it('an inactive product offers "Restore product"', async () => {
      status = 'INACTIVE'
      const page = await open()
      assert.ok(page.hasButton('Restore product'))
      assert.equal(page.hasButton('Retire product'), false)
    })

    it('without products:manage there are no lifecycle actions', async () => {
      permissions = ['integrations:read']
      const page = await open()
      assert.equal(page.hasButton('Retire product'), false)
      assert.equal(page.hasButton('Restore product'), false)
    })

    it('the actions are hidden while the details are being edited', async () => {
      const page = await open()
      await page.click('Edit details')
      assert.equal(page.hasButton('Retire product'), false)
    })

    it('"Retire product" opens the dialog for this product, with the version the page is showing', async () => {
      const page = await open()
      assert.deepEqual(dialogShown(page), [])
      await page.click('Retire product')
      assert.deepEqual(dialogShown(page), ['dialog:retire'])
      assert.deepEqual(dialog!.product, { id: 'p1', name: 'Hexalyte Salon', status: 'ACTIVE', updatedAt: V1 })
    })

    it('when the dialog succeeds the page shows the saved product and the summary', async () => {
      const page = await open()
      await page.click('Retire product')
      dialog!.onDone(productFixture({ status: 'INACTIVE', updatedAt: V2 }), 'Hexalyte Salon retired. New sales are blocked.')
      await page.settle()
      assert.deepEqual(dialogShown(page), [])
      assert.ok(page.text().includes('Inactive'))
      assert.ok(page.hasButton('Restore product'), 'the next action is to restore')
      assert.deepEqual(page.textOfClass('alert info'), ['Hexalyte Salon retired. New sales are blocked.'])
    })

    it('when the dialog reports a conflict the page closes it and reloads the product', async () => {
      const page = await open()
      await page.click('Retire product')
      const gets = calls.filter((c) => c.path === '/admin/saas-products/p1').length
      script.product = [ok(productFixture({ status: 'INACTIVE', updatedAt: V2 }))] // someone else retired it
      dialog!.onReload()
      await page.settle()
      assert.deepEqual(dialogShown(page), [])
      assert.equal(calls.filter((c) => c.path === '/admin/saas-products/p1').length, gets + 1)
      assert.ok(page.hasButton('Restore product'))
    })

    it('closing the dialog changes nothing', async () => {
      const page = await open()
      await page.click('Retire product')
      const before = calls.length
      dialog!.onClose()
      await page.settle()
      assert.deepEqual(dialogShown(page), [])
      assert.equal(calls.length, before)
      assert.ok(page.hasButton('Retire product'))
    })

    it("the edit form has no status control; its note points to the status buttons and makes no claim about customer accounts", async () => {
      const page = await open()
      await page.click('Edit details')
      const text = flat(page.text())
      assert.equal(page.valueOf('pd-status'), undefined, 'status is changed by the lifecycle buttons, not by the edit form')
      assert.match(
        text,
        /Status is not changed here\. Save or cancel this edit, then use the status buttons at the top of the page: “Retire product” and “Set coming soon” need a reason, and “Launch product” and “Restore product” put a product on sale\. Each shows what it affects before you confirm, and is recorded\./,
      )
      // What a status change does to trial accounts is explained, with real counts, by the dialogs (tested above), not asserted here.
      assert.equal(text.includes('Existing customer accounts are not affected'), false)
      assert.equal(text.includes('converted to paid'), false)
    })
  })

  describe('status actions and status display', () => {
    const LIFECYCLE_BUTTONS = ['Retire product', 'Restore product', 'Set coming soon', 'Launch product']
    const offered = (page: Awaited<ReturnType<typeof open>>) => page.buttonLabels().filter((label) => LIFECYCLE_BUTTONS.includes(label))
    const OFFERS: Array<[string, string[]]> = [
      ['ACTIVE', ['Retire product', 'Set coming soon']],
      ['COMING_SOON', ['Launch product', 'Retire product']],
      ['INACTIVE', ['Restore product', 'Set coming soon']],
    ]

    for (const [productStatus, buttons] of OFFERS) {
      it(`a ${productStatus} product offers exactly: ${buttons.join(', ')}`, async () => {
        status = productStatus
        assert.deepEqual(offered(await open()), buttons)
      })
    }

    it('every offered button opens the dialog for its own action, with the version the page is showing', async () => {
      const ACTION_OF: Record<string, string> = { 'Retire product': 'retire', 'Restore product': 'restore', 'Set coming soon': 'coming-soon', 'Launch product': 'launch' }
      for (const [productStatus, buttons] of OFFERS) {
        for (const label of buttons) {
          status = productStatus
          dialog = null
          const page = await open()
          await page.click(label)
          assert.deepEqual(dialogShown(page), [`dialog:${ACTION_OF[label]}`], `${productStatus}: ${label}`)
          assert.deepEqual(dialog!.product, { id: 'p1', name: 'Hexalyte Salon', status: productStatus, updatedAt: V1 })
          assert.equal(dialog!.action, ACTION_OF[label])
        }
      }
    })

    it('without products:manage there are no lifecycle actions, whatever the status', async () => {
      permissions = ['integrations:read']
      for (const [productStatus] of OFFERS) {
        status = productStatus
        assert.deepEqual(offered(await open()), [], productStatus)
      }
    })

    it('the actions are hidden while the details are being edited, and come back afterwards', async () => {
      status = 'COMING_SOON'
      const page = await open()
      await page.click('Edit details')
      assert.deepEqual(offered(page), [])
      await page.click('Cancel')
      assert.deepEqual(offered(page), ['Launch product', 'Retire product'])
    })

    it('shows the status and what it means for selling', async () => {
      const MEANING: Record<string, [string, RegExp]> = {
        ACTIVE: ['Active', /On sale: partners with active access can sell it\./],
        COMING_SOON: ['Coming soon', /Not launched yet: partners cannot sell it until it is launched\. Existing paid subscriptions and commissions continue\./],
        INACTIVE: ['Inactive', /Off sale: partners cannot sell it\. Existing paid subscriptions and commissions continue\./],
      }
      for (const [productStatus, [label, meaning]] of Object.entries(MEANING)) {
        status = productStatus
        const page = await open()
        assert.ok(page.textOfClass(`badge ${productStatus}`).includes(label), `${productStatus}: badge says "${label}"`)
        assert.match(flat(page.text()), meaning, productStatus)
      }
    })

    it('after "Set coming soon" succeeds the page shows Coming soon, offers Launch and Retire next, and the next dialog uses the new version', async () => {
      const page = await open()
      await page.click('Set coming soon')
      dialog!.onDone(productFixture({ status: 'COMING_SOON', updatedAt: V2 }), 'Hexalyte Salon set to coming soon.')
      await page.settle()
      assert.deepEqual(dialogShown(page), [])
      assert.ok(page.textOfClass('badge COMING_SOON').includes('Coming soon'))
      assert.match(flat(page.text()), /Not launched yet/)
      assert.deepEqual(offered(page), ['Launch product', 'Retire product'])
      assert.deepEqual(page.textOfClass('alert info'), ['Hexalyte Salon set to coming soon.'])

      await page.click('Launch product')
      assert.equal(dialog!.action, 'launch')
      assert.equal(dialog!.product.updatedAt, V2)
      assert.equal(dialog!.product.status, 'COMING_SOON')
    })

    it('after "Launch product" succeeds the page shows Active and offers Retire and Set coming soon', async () => {
      status = 'COMING_SOON'
      const page = await open()
      await page.click('Launch product')
      dialog!.onDone(productFixture({ status: 'ACTIVE', updatedAt: V2 }), 'Hexalyte Salon launched.')
      await page.settle()
      assert.ok(page.textOfClass('badge ACTIVE').includes('Active'))
      assert.match(flat(page.text()), /On sale: partners with active access can sell it\./)
      assert.deepEqual(offered(page), ['Retire product', 'Set coming soon'])
    })

    it('when the dialog reports a conflict the page closes it and reloads, showing what someone else did', async () => {
      status = 'COMING_SOON'
      const page = await open()
      await page.click('Launch product')
      const gets = calls.filter((c) => c.path === '/admin/saas-products/p1').length
      script.product = [ok(productFixture({ status: 'ACTIVE', updatedAt: V2 }))] // someone else launched it first
      dialog!.onReload()
      await page.settle()
      assert.deepEqual(dialogShown(page), [])
      assert.equal(calls.filter((c) => c.path === '/admin/saas-products/p1').length, gets + 1)
      assert.deepEqual(offered(page), ['Retire product', 'Set coming soon'])
    })

    it('opening and closing a dialog sends nothing: the page itself only ever reads', async () => {
      status = 'INACTIVE'
      const page = await open()
      await page.click('Set coming soon')
      dialog!.onClose()
      await page.settle()
      assert.equal(calls.some((c) => c.method !== 'GET'), false)
      assert.deepEqual(offered(page), ['Restore product', 'Set coming soon'])
    })
  })

  describe('reviewing partners without access', () => {
    it('explains that access is never granted automatically', async () => {
      const text = flat((await open()).text())
      assert.match(text, /2 partners have active access\. Access is never granted automatically/)
    })

    it('lists approved partners without access on request, each linking to its product access page', async () => {
      const page = await open()
      assert.equal(calls.some((c) => c.path.endsWith('/resellers-without-access')), false, 'nothing is loaded until asked')
      await page.click('Review approved partners without access')
      const text = flat(page.text())
      assert.match(text, /2 approved partners have no access record for this product\. Nothing is granted from here/)
      assert.match(text, /Alpha Traders RS-r6 on 2025-02-01/)
      assert.match(text, /Zeta Mobiles RS-r5 —/)
      const links = page.links().filter((l) => l.text === 'Open product access').map((l) => l.href)
      assert.deepEqual(links, ['/admin/resellers/r6/products', '/admin/resellers/r5/products'])
      assert.deepEqual([...new Set(calls.map((c) => c.method))], ['GET'], 'the review only reads')
    })

    it('says so when every approved partner has an access record', async () => {
      script.missing = [ok({ total: 0, limit: 200, items: [] })]
      const page = await open()
      await page.click('Review approved partners without access')
      assert.match(flat(page.text()), /Every approved partner has an access record for this product\./)
    })

    it('says when the list is cut short, and can be refreshed', async () => {
      script.missing = [ok({ ...MISSING, total: 3 })]
      const page = await open()
      await page.click('Review approved partners without access')
      assert.match(flat(page.text()), /Showing the first 2 of 3\./)
      await page.click('Refresh list')
      assert.equal(calls.filter((c) => c.path.endsWith('/resellers-without-access')).length, 2)
    })

    it('a failed load shows the error and a retry', async () => {
      script.missing = [fail(new ApiError('Service unavailable', 503)), ok(MISSING)]
      const page = await open()
      await page.click('Review approved partners without access')
      assert.match(page.textOfClass('alert error').join(' '), /Service unavailable/)
      await page.click('Retry loading partners')
      assert.deepEqual(page.textOfClass('alert error'), [])
      assert.match(flat(page.text()), /Alpha Traders/)
    })

    it('without resellers:read the list cannot be opened', async () => {
      permissions = ['products:manage', 'integrations:read']
      const page = await open()
      assert.equal(page.hasButton('Review approved partners without access'), false)
      assert.match(flat(page.text()), /Access is never granted automatically/)
    })
  })
})
