import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { installHermeticBackend, strictFake } from './helpers/hermetic-backend'
import { jpegImage, pngImage, webpImage } from './helpers/image-fixtures'

/**
 * Login-page branding (hero image, heading, supporting text) through the real Express `app`: the public, logged-out
 * endpoints the login page reads, and the admin endpoints that change them (auth, permissions, multer, validation,
 * service, audit and encrypted private storage). The admin side reuses the appearance endpoints, which
 * tests/appearance-api.test.ts covers for the dashboard hero image and logo.
 *
 * Database-free (see tests/helpers/hermetic-backend.ts): nothing here reads `.env`, runs Prisma or opens a connection.
 * PlatformSetting, AuditLog, Notification and User are in-memory stand-ins; a transaction is rolled back if its
 * callback throws. Files are really encrypted and written, but to a throwaway directory under the OS temp folder.
 * This file is separate from the other appearance tests so it has its own request budget under the global rate limit.
 */

type Row = Record<string, any>
const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hxr-login-branding-'))

const state = {
  settings: new Map<string, Row>(),
  audit: [] as Row[],
  notifications: [] as Row[],
  failAudit: undefined as Error | undefined,
  clock: 0,
}

const USERS: Record<string, Row> = {
  'u-admin': { id: 'u-admin', name: 'Ada Admin', email: 'admin@test.invalid', role: 'ADMIN', status: 'ACTIVE', emailVerified: null, resellerId: null, reseller: null },
  'u-seller': { id: 'u-seller', name: 'Sam Seller', email: 'seller@test.invalid', role: 'SELLER', status: 'ACTIVE', emailVerified: new Date(), resellerId: 'r1', reseller: { status: 'ACTIVE' } },
  'u-pending': { id: 'u-pending', name: 'Pat Pending', email: 'pending@test.invalid', role: 'SELLER', status: 'ACTIVE', emailVerified: new Date(), resellerId: 'r2', reseller: { status: 'PENDING' } },
}

/** A database answers after a round trip, so two requests really do overlap. */
const roundTrip = () => new Promise<void>((resolve) => setImmediate(resolve))

const platformSetting = {
  findMany: async ({ where }: { where: { key: { in: string[] } } }) => [...state.settings.values()].filter((r) => where.key.in.includes(r.key)).map((r) => ({ ...r })),
  findUnique: async ({ where }: { where: { key: string } }) => {
    await roundTrip()
    const row = state.settings.get(where.key)
    return row ? { ...row } : null
  },
  upsert: async ({ where, create, update }: { where: { key: string }; create: Row; update: Row }) => {
    await roundTrip()
    const existing = state.settings.get(where.key)
    state.settings.set(where.key, { ...(existing ?? create), ...(existing ? update : {}), updatedAt: new Date(Date.UTC(2026, 0, 1) + ++state.clock * 60_000) })
  },
  deleteMany: async ({ where }: { where: { key: string } }) => ({ count: state.settings.delete(where.key) ? 1 : 0 }),
}
const auditLog = {
  create: async ({ data }: { data: Row }) => {
    if (state.failAudit) {
      const err = state.failAudit
      state.failAudit = undefined
      throw err
    }
    state.audit.push({ ...data })
  },
}
const tx = { platformSetting, auditLog }

const fakePrisma = strictFake('prisma', {
  user: {
    findUnique: async ({ where }: { where: { id: string } }) => USERS[where.id] ?? null,
    findMany: async ({ where }: { where: Row }) =>
      Object.values(USERS).filter((u) => (where.id?.in ? where.id.in.includes(u.id) : where.role?.in?.includes(u.role) && u.status === where.status)),
  },
  notification: { createMany: async ({ data }: { data: Row[] }) => void state.notifications.push(...data) },
  platformSetting,
  $transaction: async <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => {
    const snapshot = new Map([...state.settings].map(([k, v]) => [k, { ...v }] as const))
    const auditLength = state.audit.length
    try {
      return await fn(tx)
    } catch (err) {
      state.settings.clear()
      snapshot.forEach((v, k) => state.settings.set(k, v))
      state.audit.length = auditLength
      throw err
    }
  },
})

const KEY = {
  hero: 'APPEARANCE_HERO_IMAGE',
  loginImage: 'APPEARANCE_LOGIN_IMAGE',
  loginHeading: 'APPEARANCE_LOGIN_HEADING',
  loginText: 'APPEARANCE_LOGIN_TEXT',
}
const REASON = 'Seasonal refresh'

describe('Login-page branding API', () => {
  let base = ''
  let server: http.Server
  const tokens: Record<string, string> = {}

  /** Files currently on disk for one image folder (login image → "appearance-login"). */
  const filesIn = (folder: string): string[] => {
    const dir = path.join(UPLOAD_DIR, folder)
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name))
  }
  const heroFiles = () => filesIn('appearance-hero')
  const loginFiles = () => filesIn('appearance-login')
  const row = (key: string) => state.settings.get(key)
  const auditActions = () => state.audit.map((a) => a.action)

  const json = async (method: string, urlPath: string, opts: { token?: string; body?: unknown } = {}) => {
    const res = await fetch(`${base}/api/v1${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    })
    return { status: res.status, headers: res.headers, json: (await res.json().catch(() => null)) as any }
  }
  const raw = async (urlPath: string, token?: string) => {
    const res = await fetch(`${base}/api/v1${urlPath}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) }
  }
  /** What the admin page sends: a multipart form with the file in `image` and the reason beside it. */
  const upload = async (kind: 'hero-image' | 'logo' | 'login-image', file: Buffer | null, opts: { token?: string; reason?: string | null } = {}) => {
    const form = new FormData()
    if (opts.reason !== null) form.append('reason', opts.reason ?? REASON)
    if (file) form.append('image', new Blob([file], { type: 'image/png' }), 'upload.png')
    const res = await fetch(`${base}/api/v1/admin/settings/appearance/${kind}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${opts.token ?? tokens.admin}` },
      body: form,
    })
    return { status: res.status, json: (await res.json().catch(() => null)) as any }
  }
  const putPrefs = (body: unknown, token = tokens.admin) => json('PUT', '/admin/settings/appearance', { token, body })
  const reset = (kind: 'hero-image' | 'login-image', body: unknown = { reason: REASON }, token = tokens.admin) =>
    json('POST', `/admin/settings/appearance/${kind}/reset`, { token, body })

  const hero = (tail = 'A', w = 1920, h = 640) => pngImage(w, h, Buffer.from(`hero-${tail}`))
  const noStoragePaths = (value: unknown, label: string) => {
    const text = JSON.stringify(value)
    assert.equal(/appearance-(hero|logo|login)\//.test(text), false, `${label}: private storage path leaked`)
    assert.equal(/\.enc\b/.test(text), false, `${label}: storage file name leaked`)
    for (const r of state.settings.values()) {
      if (/\.enc$/.test(r.value)) assert.equal(text.includes(r.value), false, `${label}: storage key leaked`)
    }
  }

  before(async () => {
    installHermeticBackend(fakePrisma)
    process.env.UPLOAD_DIR = UPLOAD_DIR
    const { signAccessToken } = await import('../src/utils/jwt')
    const { default: app } = await import('../src/app')
    for (const [name, id] of [['admin', 'u-admin'], ['seller', 'u-seller'], ['pending', 'u-pending']] as const) {
      const u = USERS[id]
      tokens[name] = signAccessToken({ userId: u.id, email: u.email, role: u.role, resellerId: u.resellerId })
    }
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(UPLOAD_DIR, { recursive: true, force: true })
  })
  beforeEach(() => {
    state.settings.clear()
    state.audit.length = 0
    state.notifications.length = 0
    state.failAudit = undefined
    for (const folder of ['appearance-hero', 'appearance-logo', 'appearance-login']) fs.rmSync(path.join(UPLOAD_DIR, folder), { recursive: true, force: true })
  })

  describe('login page branding', () => {
    const BRANDING = '/public/login-branding'
    const publicBranding = () => json('GET', BRANDING)
    const loginHero = (tail = 'A', w = 1920, h = 1080) => pngImage(w, h, Buffer.from(`login-${tail}`))
    const BUILT_IN = { heading: null, text: null, heroImage: null, theme: null }

    describe('what a logged-out visitor can read', () => {
      it('is the built-in look (no custom heading, text or image) until the admin saves something', async () => {
        const res = await publicBranding()
        assert.equal(res.status, 200)
        assert.deepEqual(res.json.data, BUILT_IN)
        assert.equal((await raw(`${BRANDING}/hero-image`)).status, 404)
      })

      it('serves the saved heading, supporting text and image without a token, and nothing else', async () => {
        await putPrefs({ defaultTheme: 'light', welcomeText: { en: 'Hello {name}', si: 'ආයුබෝවන්' }, loginBranding: { heading: ' Welcome to Acme ', text: 'Run your shop with us.' }, reason: REASON })
        await upload('hero-image', hero('DASH'))
        await upload('logo', pngImage(256, 256, Buffer.from('logo')))
        const image = loginHero()
        assert.equal((await upload('login-image', image)).status, 200)

        const res = await publicBranding()
        assert.equal(res.status, 200)
        assert.deepEqual(Object.keys(res.json.data).sort(), ['heading', 'heroImage', 'text', 'theme'])
        assert.deepEqual(res.json.data, { heading: 'Welcome to Acme', text: 'Run your shop with us.', heroImage: { version: row(KEY.loginImage)!.updatedAt.toISOString() }, theme: null })
        const body = JSON.stringify(res.json)
        for (const private_ of ['light', 'Hello', 'ආයුබෝවන්', 'u-admin', 'admin@test.invalid', 'Ada Admin']) assert.equal(body.includes(private_), false, private_)
        noStoragePaths(res.json, 'public login branding')

        const img = await raw(`${BRANDING}/hero-image`)
        assert.equal(img.status, 200)
        assert.equal(img.headers.get('content-type'), 'image/png')
        assert.equal(img.headers.get('x-content-type-options'), 'nosniff')
        assert.match(img.headers.get('content-security-policy') ?? '', /default-src 'none'/)
        assert.deepEqual(img.bytes, image)
      })

      it('keeps every other appearance endpoint behind a sign-in, and never offers another image on the public route', async () => {
        await upload('hero-image', hero('DASH'))
        await upload('logo', pngImage(256, 256, Buffer.from('logo')))
        for (const p of ['/appearance', '/appearance/hero-image', '/appearance/logo', '/admin/settings/appearance']) assert.equal((await raw(p)).status, 401, p)

        // No login image is saved: the dashboard hero image and the logo are not served in its place.
        assert.equal((await raw(`${BRANDING}/hero-image`)).status, 404)
        assert.deepEqual((await publicBranding()).json.data, BUILT_IN)
        for (const p of [`${BRANDING}/logo`, `${BRANDING}/hero`, '/public/appearance', '/public']) assert.equal((await raw(p)).status, 404, p)
      })

      it('leaves the signed-in appearance settings exactly as they were: the login branding is not part of them', async () => {
        await putPrefs({ loginBranding: { heading: 'Welcome to Acme' }, reason: REASON })
        await upload('login-image', loginHero())
        const pub = (await json('GET', '/appearance', { token: tokens.seller })).json.data
        assert.deepEqual(pub, { defaultTheme: 'dark', welcomeText: { en: null, si: null }, heroImage: null, logo: null })
      })

      it('ignores a stored heading or text that is not valid any more (hand-edited database) instead of showing it', async () => {
        state.settings.set(KEY.loginHeading, { key: KEY.loginHeading, value: 'x'.repeat(500), updatedAt: new Date(), updatedById: null })
        state.settings.set(KEY.loginText, { key: KEY.loginText, value: 'two\nlines', updatedAt: new Date(), updatedById: null })
        assert.deepEqual((await publicBranding()).json.data, BUILT_IN)
      })

      it('answers 404 for the image if its file has gone missing, so the page keeps the built-in image', async () => {
        await upload('login-image', loginHero())
        fs.rmSync(loginFiles()[0])
        assert.equal((await raw(`${BRANDING}/hero-image`)).status, 404)
        assert.equal((await publicBranding()).status, 200)
      })
    })

    describe('heading and supporting text', () => {
      it('are saved independently, audited with their reason, and every admin is told', async () => {
        const res = await putPrefs({ loginBranding: { heading: ' Welcome to Acme ', text: 'Run your shop with us.' }, reason: REASON })
        assert.equal(res.status, 200)
        assert.equal(row(KEY.loginHeading)!.value, 'Welcome to Acme')
        assert.equal(row(KEY.loginText)!.value, 'Run your shop with us.')
        assert.equal(row(KEY.loginHeading)!.updatedById, 'u-admin')
        assert.deepEqual(res.json.data.loginBranding, { heading: 'Welcome to Acme', text: 'Run your shop with us.', heroImage: null, theme: null })

        assert.deepEqual(auditActions(), ['SETTINGS_APPEARANCE_UPDATED'])
        assert.equal(state.audit[0].metadata.reason, REASON)
        assert.deepEqual(state.audit[0].metadata.changes.map((c: Row) => [c.setting, c.before, c.after]), [
          ['login page heading', null, 'Welcome to Acme'],
          ['login page supporting text', null, 'Run your shop with us.'],
        ])
        assert.equal(state.notifications.length, 1)

        // Sending null for one goes back to the built-in text for that one only.
        await putPrefs({ loginBranding: { heading: null }, reason: REASON })
        assert.equal(row(KEY.loginHeading), undefined)
        assert.equal(row(KEY.loginText)!.value, 'Run your shop with us.')
        assert.deepEqual((await publicBranding()).json.data, { heading: null, text: 'Run your shop with us.', heroImage: null, theme: null })
      })

      it('shows the admin which values are custom and who changed them, with the limits', async () => {
        await putPrefs({ loginBranding: { heading: 'Welcome to Acme' }, reason: REASON })
        const d = (await json('GET', '/admin/settings/appearance', { token: tokens.admin })).json.data
        assert.deepEqual(d.loginBranding, { heading: 'Welcome to Acme', text: null, heroImage: null, theme: null })
        assert.equal(d.details.loginHeading.custom, true)
        assert.deepEqual(d.details.loginHeading.updatedBy, { name: 'Ada Admin', email: 'admin@test.invalid' })
        assert.equal(d.details.loginText.custom, false)
        assert.equal(d.details.loginImage.custom, false)
        assert.deepEqual([d.limits.loginHeadingMaxLength, d.limits.loginTextMaxLength], [80, 200])
        assert.deepEqual(d.limits.login, { maxBytes: d.limits.hero.maxBytes, minWidth: 800, minHeight: 600, maxSide: 8000 })
      })

      it('leaves no audit entry when nothing actually changes', async () => {
        await putPrefs({ loginBranding: { heading: 'Welcome to Acme' }, reason: REASON })
        state.audit.length = 0
        state.notifications.length = 0
        assert.equal((await putPrefs({ loginBranding: { heading: 'Welcome to Acme' }, reason: REASON })).status, 200)
        assert.equal((await putPrefs({ loginBranding: { text: null }, reason: REASON })).status, 200)
        assert.deepEqual(state.audit, [])
        assert.deepEqual(state.notifications, [])
      })

      it('rejects invalid input with 422 and changes nothing', async () => {
        const bad: unknown[] = [
          { loginBranding: { heading: '' }, reason: REASON },
          { loginBranding: { heading: 'x'.repeat(81) }, reason: REASON },
          { loginBranding: { text: 'x'.repeat(201) }, reason: REASON },
          { loginBranding: { text: 'two\nlines' }, reason: REASON },
          { loginBranding: { heading: 'ok', tagline: 'x' }, reason: REASON },
          { loginBranding: {}, reason: REASON },
          { loginBranding: { heading: 'Hello' } },
          { loginBranding: { heading: 'Hello' }, reason: 'abc' },
        ]
        for (const body of bad) assert.equal((await putPrefs(body)).status, 422, JSON.stringify(body))
        assert.equal(state.settings.size, 0)
        assert.deepEqual(state.audit, [])
      })
    })

    describe('hero image', () => {
      it('is stored encrypted in its own folder, apart from the dashboard hero image, and audited', async () => {
        await upload('hero-image', hero('DASH'))
        const image = loginHero()
        const res = await upload('login-image', image)
        assert.equal(res.status, 200)
        assert.equal(res.json.message, 'Login page hero image updated')
        assert.equal(res.json.data.loginBranding.heroImage.version, row(KEY.loginImage)!.updatedAt.toISOString())
        assert.equal(res.json.data.details.loginImage.custom, true)
        assert.notEqual(res.json.data.heroImage, null, 'the dashboard hero image is a separate setting and is untouched')

        assert.equal(loginFiles().length, 1)
        assert.equal(heroFiles().length, 1)
        assert.equal(fs.readFileSync(loginFiles()[0]).includes(Buffer.from('login-A')), false, 'the file on disk is encrypted')
        assert.deepEqual(auditActions(), ['SETTINGS_APPEARANCE_IMAGE_UPDATED', 'SETTINGS_APPEARANCE_IMAGE_UPDATED'])
        assert.equal(state.audit[1].metadata.image, 'login')
        assert.equal(state.audit[1].metadata.reason, REASON)
        noStoragePaths(res.json, 'upload response')
        noStoragePaths(state.audit, 'audit log')

        assert.deepEqual((await raw(`${BRANDING}/hero-image`)).bytes, image)
        assert.deepEqual((await raw('/appearance/hero-image', tokens.seller)).bytes, hero('DASH'), 'each endpoint serves its own image')
      })

      it('applies the login image rules: JPG, PNG or WEBP only, at least 800 × 600 and at most 8000 pixels', async () => {
        const rejected: Array<[Buffer, RegExp]> = [
          [pngImage(700, 900), /at least 800 × 600/],
          [pngImage(1920, 500), /at least 800 × 600/],
          [pngImage(9000, 1200), /at most 8000/],
          [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1000"><script>alert(1)</script></svg>'), /JPG, PNG or WEBP/],
          [Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(200)]), /JPG, PNG or WEBP/],
        ]
        for (const [bytes, message] of rejected) {
          const res = await upload('login-image', bytes)
          assert.equal(res.status, 400)
          assert.match(res.json.message, message)
        }
        assert.equal(state.settings.size, 0)
        assert.deepEqual(loginFiles(), [], 'nothing was written to storage')
        assert.deepEqual(state.audit, [])
        assert.equal((await upload('login-image', jpegImage(800, 600, Buffer.from('jpg')))).status, 200)
        assert.equal((await upload('login-image', webpImage(1600, 900, Buffer.from('webp')))).status, 200)
      })

      it('needs a reason and a file', async () => {
        assert.equal((await upload('login-image', loginHero(), { reason: null })).status, 422)
        assert.equal((await upload('login-image', loginHero(), { reason: 'abc' })).status, 422)
        assert.equal((await upload('login-image', null)).status, 400)
        assert.equal(state.settings.size, 0)
        assert.deepEqual(loginFiles(), [])
      })

      it('is replaced by a new upload: the old file goes only after the new one is saved, and the version changes', async () => {
        const first = (await upload('login-image', loginHero('A'))).json.data.loginBranding.heroImage.version
        const oldFile = loginFiles()[0]
        const second = (await upload('login-image', loginHero('B'))).json.data.loginBranding.heroImage.version
        assert.notEqual(first, second)
        assert.equal(fs.existsSync(oldFile), false, 'old file removed')
        assert.equal(loginFiles().length, 1)
        assert.deepEqual((await raw(`${BRANDING}/hero-image`)).bytes, loginHero('B'))
        assert.deepEqual(state.audit.map((a) => a.metadata.replacedCustomImage), [false, true])
      })

      it('keeps the previous image untouched when saving the replacement fails', async () => {
        await upload('login-image', loginHero('A'))
        const filesBefore = loginFiles()
        state.failAudit = new Error('audit table unavailable')
        assert.equal((await upload('login-image', loginHero('B'))).status, 500)
        assert.deepEqual(loginFiles(), filesBefore, 'the half-saved new file is gone and the old one is still there')
        assert.deepEqual((await raw(`${BRANDING}/hero-image`)).bytes, loginHero('A'))
      })

      it('resets to the built-in image: setting and file are removed, the reset is audited, and the public route answers 404 again', async () => {
        await upload('login-image', loginHero())
        state.audit.length = 0
        state.notifications.length = 0

        const res = await reset('login-image', { reason: 'Campaign ended' })
        assert.equal(res.status, 200)
        assert.equal(res.json.data.loginBranding.heroImage, null)
        assert.equal(row(KEY.loginImage), undefined)
        assert.deepEqual(loginFiles(), [])
        assert.equal((await raw(`${BRANDING}/hero-image`)).status, 404)
        assert.deepEqual((await publicBranding()).json.data, BUILT_IN)
        assert.deepEqual(auditActions(), ['SETTINGS_APPEARANCE_IMAGE_RESET'])
        assert.equal(state.audit[0].metadata.image, 'login')
        assert.equal(state.audit[0].metadata.reason, 'Campaign ended')
        assert.equal(state.notifications.length, 1)

        // Nothing custom is left, so resetting again does nothing.
        state.audit.length = 0
        assert.equal((await reset('login-image')).status, 200)
        assert.deepEqual(state.audit, [])
      })

      it('needs a valid reason to reset', async () => {
        await upload('login-image', loginHero())
        for (const body of [{}, { reason: 'abc' }, { reason: REASON, extra: 1 }]) assert.equal((await reset('login-image', body)).status, 422)
        assert.notEqual(row(KEY.loginImage), undefined)
        assert.equal(loginFiles().length, 1)
      })
    })

    describe('who may change it', () => {
      it('refuses a request without a token (401), and a reseller on every change (403), storing nothing', async () => {
        const anonymous = (method: string, p: string) => fetch(`${base}/api/v1/admin/settings/appearance${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: REASON }) })
        assert.equal((await anonymous('PUT', '/login-image')).status, 401)
        assert.equal((await anonymous('POST', '/login-image/reset')).status, 401)
        assert.equal((await anonymous('PUT', '')).status, 401)

        assert.equal((await upload('login-image', loginHero(), { token: tokens.seller })).status, 403)
        assert.equal((await reset('login-image', { reason: REASON }, tokens.seller)).status, 403)
        assert.equal((await putPrefs({ loginBranding: { heading: 'Hacked' }, reason: REASON }, tokens.seller)).status, 403)
        assert.equal((await putPrefs({ loginBranding: { heading: 'Hacked' }, reason: REASON }, tokens.pending)).status, 403)
        assert.equal(state.settings.size, 0)
        assert.deepEqual(state.audit, [])
        assert.deepEqual(loginFiles(), [])
      })
    })
  })
})
