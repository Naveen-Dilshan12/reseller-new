import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import express from 'express'
import { installHermeticBackend, serve } from './helpers/hermetic-backend'
import { ACCOUNT_NUMBER, LAST4, createApplicationsFake } from './helpers/applications-fake'
import { jsx, mountPage } from './helpers/render-page'

/**
 * The reseller profile page's bank section (apps/web/src/app/admin/reseller-applications/[id]/page.tsx):
 * the account number is hidden until "Reveal (logged)", hides itself 30 seconds later, and can be hidden by hand.
 *
 * The real, unmodified page runs in Node through tests/helpers/render-page.ts (a minimal hook runtime, no DOM) with
 * fake timers. Its data is the backend's own GET-profile and reveal responses, captured from the real router
 * and service over a hermetic fake, so the page is checked against the actual API shape.
 * Database-free; nothing here reads `.env`, runs Prisma or opens a connection.
 */

const PAGE = path.resolve(__dirname, '../../web/src/app/admin/reseller-applications/[id]/page.tsx')
const REVEAL_PATH = '/admin/reseller-applications/rs-1/bank-account/reveal'
const PROFILE_PATH = '/admin/reseller-applications/rs-1'
const MASKED = `•••• •••• ${LAST4}`

const fake = createApplicationsFake()

/** Tracks the page's pending timers (on top of the fake clock), so a countdown that is never cancelled is visible. */
function trackTimers() {
  const original = { set: globalThis.setTimeout, clear: globalThis.clearTimeout }
  const live = new Set<unknown>()
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const handle: unknown = original.set((...a: unknown[]) => {
      live.delete(handle)
      fn(...a)
    }, ms, ...args)
    live.add(handle)
    return handle
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((handle?: unknown) => {
    live.delete(handle)
    return original.clear(handle as never)
  }) as typeof clearTimeout
  return {
    live,
    stop() {
      globalThis.setTimeout = original.set
      globalThis.clearTimeout = original.clear
    },
  }
}

class ApiError extends Error {
  constructor(message: string, public status = 0, public code?: string, public errors: string[] = []) {
    super(message)
  }
}

describe('Profile page: bank account reveal', () => {
  let profileData: unknown
  let revealData: unknown
  let permissions: string[]
  let revealFails: boolean
  let calls: Array<{ method: string; path: string }>

  const stubs = {
    'next/link': { __esModule: true, default: ({ href, children }: { href: string; children: unknown }) => jsx('a', { href, children }) },
    'next/navigation': { useParams: () => ({ id: 'rs-1' }) },
    '@/lib/api': {
      ApiError,
      api: async (apiPath: string, init: { method?: string } = {}) => {
        const method = init.method ?? 'GET'
        calls.push({ method, path: apiPath })
        if (method === 'GET' && apiPath === PROFILE_PATH) return structuredClone(profileData)
        if (method === 'POST' && apiPath === REVEAL_PATH) {
          if (revealFails) throw new ApiError('Insufficient permissions', 403)
          return structuredClone(revealData)
        }
        throw new Error(`unexpected API call ${method} ${apiPath}`)
      },
    },
    '@/lib/admin-context': { useAdminUser: () => ({ permissions }) },
    '@/components/admin/ResellerStatusDialog': { ResellerStatusDialog: () => null },
    '@/components/ui/Modal': { Modal: () => null },
  }

  const open = async () => {
    const page = mountPage(PAGE, stubs)
    await page.settle()
    return page
  }

  before(async () => {
    installHermeticBackend(fake.fakePrisma)
    const { signAccessToken } = await import('../src/utils/jwt')
    const { encryptAccountNumber } = await import('../src/modules/resellers/bank-account.util')
    const { errorHandler } = await import('../src/middleware/error.middleware')
    const { applicationsRouter } = await import('../src/modules/resellers/resellers.routes')
    fake.seed(encryptAccountNumber)

    // Capture what the real API sends for this reseller.
    const app = express()
    app.use(express.json())
    app.use('/admin/reseller-applications', applicationsRouter)
    app.use(errorHandler)
    const api = await serve(app)
    const admin = fake.state.users.get('u-admin')!
    const token = signAccessToken({ userId: admin.id, email: admin.email, role: admin.role, resellerId: null })
    profileData = (await api.call('GET', PROFILE_PATH, { token })).json.data
    revealData = (await api.call('POST', REVEAL_PATH, { token })).json.data
    await api.close()
  })
  after(() => mock.timers.reset())

  beforeEach(() => {
    permissions = ['resellers:read', 'resellers:manage', 'resellers:bank-reveal']
    revealFails = false
    calls = []
    mock.timers.enable({ apis: ['setTimeout'] })
  })
  afterEach(() => mock.timers.reset())

  it('uses the shapes the real API sends (masked number in the profile, accountNumber in the reveal)', () => {
    assert.equal((profileData as { bank: { accountNumberMasked: string } }).bank.accountNumberMasked, MASKED)
    assert.deepEqual(revealData, { accountNumber: ACCOUNT_NUMBER })
  })

  it('shows only the masked number, and offers the audited Reveal button, until asked', async () => {
    const page = await open()
    assert.ok(page.text().includes(MASKED))
    assert.equal(page.text().includes(ACCOUNT_NUMBER), false)
    assert.ok(page.hasButton('Reveal (logged)'))
    assert.equal(page.hasButton('Hide'), false)
    assert.deepEqual(calls, [{ method: 'GET', path: PROFILE_PATH }], 'nothing is revealed just by opening the page')
  })

  it('offers no Reveal button without the bank-reveal permission', async () => {
    permissions = ['resellers:read', 'resellers:manage']
    const page = await open()
    assert.equal(page.hasButton('Reveal (logged)'), false)
    assert.ok(page.text().includes(MASKED))
  })

  it('Reveal posts to the reveal endpoint and shows the number with a Hide button instead', async () => {
    const page = await open()
    await page.click('Reveal (logged)')
    assert.deepEqual(calls.at(-1), { method: 'POST', path: REVEAL_PATH })
    assert.ok(page.text().includes(ACCOUNT_NUMBER))
    assert.equal(page.text().includes(MASKED), false, 'the number replaces the mask')
    assert.ok(page.hasButton('Hide'))
    assert.equal(page.hasButton('Reveal (logged)'), false)
  })

  it('hides the number again after exactly 30 seconds', async () => {
    const page = await open()
    await page.click('Reveal (logged)')

    mock.timers.tick(29_999)
    await page.settle()
    assert.ok(page.text().includes(ACCOUNT_NUMBER), 'still visible 1 ms before the limit')

    mock.timers.tick(1)
    await page.settle()
    assert.equal(page.text().includes(ACCOUNT_NUMBER), false, 'gone at 30 seconds')
    assert.ok(page.text().includes(MASKED))
    assert.ok(page.hasButton('Reveal (logged)'))
    assert.equal(page.hasButton('Hide'), false)
  })

  it('Hide hides it immediately', async () => {
    const page = await open()
    await page.click('Reveal (logged)')
    await page.click('Hide')
    assert.equal(page.text().includes(ACCOUNT_NUMBER), false)
    assert.ok(page.text().includes(MASKED))
    assert.ok(page.hasButton('Reveal (logged)'))
  })

  it('Hide cancels the countdown: a second reveal gets its own full 30 seconds', async () => {
    const page = await open()
    await page.click('Reveal (logged)')
    mock.timers.tick(10_000)
    await page.click('Hide')
    await page.click('Reveal (logged)') // at t = 10 s; the first countdown would have ended at t = 30 s

    mock.timers.tick(29_000) // t = 39 s: past the first countdown, inside the second
    await page.settle()
    assert.ok(page.text().includes(ACCOUNT_NUMBER), 'a leftover timer must not hide the new reveal early')

    mock.timers.tick(1_000) // t = 40 s: exactly 30 s after the second reveal
    await page.settle()
    assert.equal(page.text().includes(ACCOUNT_NUMBER), false)
    assert.equal(calls.filter((c) => c.method === 'POST').length, 2, 'each reveal is a separate, audited request')
  })

  it('a refused reveal never shows a number and tells the user why', async () => {
    revealFails = true
    const page = await open()
    await page.click('Reveal (logged)')
    assert.equal(page.text().includes(ACCOUNT_NUMBER), false)
    assert.ok(page.text().includes(MASKED))
    assert.deepEqual(page.textOfClass('alert'), ['Insufficient permissions'])
    assert.ok(page.hasButton('Reveal (logged)'), 'they can try again')
  })

  it('Hide stops the countdown instead of leaving it running', async () => {
    const timers = trackTimers()
    try {
      const page = await open()
      await page.click('Reveal (logged)')
      assert.equal(timers.live.size, 1, 'one countdown while the number is shown')
      await page.click('Hide')
      assert.equal(timers.live.size, 0)
    } finally {
      timers.stop()
    }
  })

  it('closing the page stops the countdown instead of leaving it running', async () => {
    const timers = trackTimers()
    try {
      const page = await open()
      await page.click('Reveal (logged)')
      assert.equal(timers.live.size, 1)
      page.unmount()
      assert.equal(timers.live.size, 0, 'a timer left behind would keep holding the number in memory')
    } finally {
      timers.stop()
    }
  })
})
