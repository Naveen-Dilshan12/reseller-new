import { after, before, beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { installHermeticBackend, strictFake } from './helpers/hermetic-backend'
import { jpegImage, pngImage, webpImage } from './helpers/image-fixtures'

/**
 * Portal appearance settings (hero image, logo, welcome texts, default color mode) through the real Express `app`
 * (helmet, CORS, global limiter, auth, permissions, multer, validation, service, audit and encrypted private storage).
 *
 * Database-free (see tests/helpers/hermetic-backend.ts): nothing here reads `.env`, runs Prisma or opens a connection.
 * PlatformSetting, AuditLog, Notification and User are in-memory stand-ins; a transaction is rolled back if its
 * callback throws. Files are really encrypted and written, but to a throwaway directory under the OS temp folder.
 */

type Row = Record<string, any>
const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hxr-appearance-'))

const state = {
  settings: new Map<string, Row>(),
  audit: [] as Row[],
  notifications: [] as Row[],
  failAudit: undefined as Error | undefined,
  clock: 0,
  /** Holds each setting read until `expected` requests have reached it (or 150 ms pass), so concurrent requests truly overlap. */
  overlap: undefined as { expected: number; arrived: number; release: () => void; ready: Promise<void> } | undefined,
}

const USERS: Record<string, Row> = {
  'u-admin': { id: 'u-admin', name: 'Ada Admin', email: 'admin@test.invalid', role: 'ADMIN', status: 'ACTIVE', emailVerified: null, resellerId: null, reseller: null },
  'u-seller': { id: 'u-seller', name: 'Sam Seller', email: 'seller@test.invalid', role: 'SELLER', status: 'ACTIVE', emailVerified: new Date(), resellerId: 'r1', reseller: { status: 'ACTIVE' } },
  'u-pending': { id: 'u-pending', name: 'Pat Pending', email: 'pending@test.invalid', role: 'SELLER', status: 'ACTIVE', emailVerified: new Date(), resellerId: 'r2', reseller: { status: 'PENDING' } },
  'u-suspended': { id: 'u-suspended', name: 'Sue Suspended', email: 'suspended@test.invalid', role: 'SELLER', status: 'ACTIVE', emailVerified: new Date(), resellerId: 'r3', reseller: { status: 'SUSPENDED' } },
}

/** A database answers after a round trip, so two requests really do overlap. */
const roundTrip = () => new Promise<void>((resolve) => setImmediate(resolve))

const platformSetting = {
  findMany: async ({ where }: { where: { key: { in: string[] } } }) => [...state.settings.values()].filter((r) => where.key.in.includes(r.key)).map((r) => ({ ...r })),
  findUnique: async ({ where }: { where: { key: string } }) => {
    await roundTrip()
    const gate = state.overlap
    if (gate) {
      if (++gate.arrived >= gate.expected) gate.release()
      await Promise.race([gate.ready, new Promise((resolve) => setTimeout(resolve, 150))])
    }
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

const KEY = { hero: 'APPEARANCE_HERO_IMAGE', logo: 'APPEARANCE_LOGO_IMAGE', en: 'APPEARANCE_WELCOME_TEXT_EN', si: 'APPEARANCE_WELCOME_TEXT_SI', theme: 'APPEARANCE_DEFAULT_THEME' }
const REASON = 'Seasonal refresh'

describe('Portal appearance settings', () => {
  let base = ''
  let server: http.Server
  let signAccessToken: typeof import('../src/utils/jwt')['signAccessToken']
  let privateStorage: typeof import('../src/modules/storage/private-storage')['privateStorage']
  const tokens: Record<string, string> = {}

  /** Files currently on disk for one image folder (hero → "appearance-hero"). */
  const filesIn = (folder: string): string[] => {
    const dir = path.join(UPLOAD_DIR, folder)
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name))
  }
  const heroFiles = () => filesIn('appearance-hero')
  const logoFiles = () => filesIn('appearance-logo')
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
  const upload = async (kind: 'hero-image' | 'logo', file: Buffer | null, opts: { token?: string; reason?: string | null; type?: string; name?: string } = {}) => {
    const form = new FormData()
    if (opts.reason !== null) form.append('reason', opts.reason ?? REASON)
    if (file) form.append('image', new Blob([file], { type: opts.type ?? 'image/png' }), opts.name ?? 'upload.png')
    const res = await fetch(`${base}/api/v1/admin/settings/appearance/${kind}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${opts.token ?? tokens.admin}` },
      body: form,
    })
    return { status: res.status, json: (await res.json().catch(() => null)) as any }
  }
  const putPrefs = (body: unknown, token = tokens.admin) => json('PUT', '/admin/settings/appearance', { token, body })
  const reset = (kind: 'hero-image' | 'logo', body: unknown = { reason: REASON }, token = tokens.admin) =>
    json('POST', `/admin/settings/appearance/${kind}/reset`, { token, body })

  const hero = (tail = 'A', w = 1920, h = 640) => pngImage(w, h, Buffer.from(`hero-${tail}`))
  const noStoragePaths = (value: unknown, label: string) => {
    const text = JSON.stringify(value)
    assert.equal(/appearance-(hero|logo)\//.test(text), false, `${label}: private storage path leaked`)
    assert.equal(/\.enc\b/.test(text), false, `${label}: storage file name leaked`)
    for (const r of state.settings.values()) {
      if (/\.enc$/.test(r.value)) assert.equal(text.includes(r.value), false, `${label}: storage key leaked`)
    }
  }

  before(async () => {
    installHermeticBackend(fakePrisma)
    process.env.UPLOAD_DIR = UPLOAD_DIR
    ;({ signAccessToken } = await import('../src/utils/jwt'))
    ;({ privateStorage } = await import('../src/modules/storage/private-storage'))
    const { default: app } = await import('../src/app')
    for (const [name, id] of [['admin', 'u-admin'], ['seller', 'u-seller'], ['pending', 'u-pending'], ['suspended', 'u-suspended']] as const) {
      const u = USERS[id]
      tokens[name] = signAccessToken({ userId: u.id, email: u.email, role: u.role, resellerId: u.resellerId })
    }
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(async () => {
    mock.restoreAll()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(UPLOAD_DIR, { recursive: true, force: true })
  })
  beforeEach(async () => {
    mock.restoreAll()
    state.settings.clear()
    state.audit.length = 0
    state.notifications.length = 0
    state.failAudit = undefined
    state.overlap = undefined
    fs.rmSync(path.join(UPLOAD_DIR, 'appearance-hero'), { recursive: true, force: true })
    fs.rmSync(path.join(UPLOAD_DIR, 'appearance-logo'), { recursive: true, force: true })
  })

  describe('built-in defaults', () => {
    it('reports the built-in values and no images while nothing has been saved', async () => {
      const res = await json('GET', '/appearance', { token: tokens.seller })
      assert.equal(res.status, 200)
      assert.deepEqual(res.json.data, { defaultTheme: 'dark', welcomeText: { en: null, si: null }, heroImage: null, logo: null })
    })

    it('answers 404 for the images, so the portal keeps its own hero image and logo', async () => {
      assert.equal((await raw('/appearance/hero-image', tokens.seller)).status, 404)
      assert.equal((await raw('/appearance/logo', tokens.seller)).status, 404)
    })

    it('shows the admin which values are custom, with the upload rules', async () => {
      const res = await json('GET', '/admin/settings/appearance', { token: tokens.admin })
      assert.equal(res.status, 200)
      const d = res.json.data
      for (const k of ['heroImage', 'logo', 'welcomeTextEn', 'welcomeTextSi', 'defaultTheme']) assert.equal(d.details[k].custom, false, k)
      assert.deepEqual(d.limits.imageTypes, ['image/jpeg', 'image/png', 'image/webp'])
      assert.equal(d.limits.welcomeTextMaxLength, 120)
      assert.ok(d.limits.hero.maxBytes > d.limits.logo.maxBytes - 1 && d.limits.logo.maxBytes <= 2 * 1024 * 1024)
    })

    it('ignores a stored value that is not valid any more (hand-edited database) instead of showing it', async () => {
      state.settings.set(KEY.theme, { key: KEY.theme, value: 'neon', updatedAt: new Date(), updatedById: null })
      state.settings.set(KEY.en, { key: KEY.en, value: 'Hi {user}', updatedAt: new Date(), updatedById: null })
      const res = await json('GET', '/appearance', { token: tokens.seller })
      assert.equal(res.json.data.defaultTheme, 'dark')
      assert.equal(res.json.data.welcomeText.en, null)
    })
  })

  describe('who may read and who may change', () => {
    it('refuses every endpoint without a token (401)', async () => {
      for (const [method, p] of [
        ['GET', '/appearance'],
        ['GET', '/appearance/hero-image'],
        ['GET', '/appearance/logo'],
        ['GET', '/admin/settings/appearance'],
        ['PUT', '/admin/settings/appearance'],
        ['PUT', '/admin/settings/appearance/hero-image'],
        ['POST', '/admin/settings/appearance/logo/reset'],
      ] as const) {
        assert.equal((await json(method, p, { body: method === 'GET' ? undefined : { reason: REASON } })).status, 401, `${method} ${p}`)
      }
    })

    it('lets any signed-in reseller, including one whose application is still pending, read the appearance and images', async () => {
      await upload('hero-image', hero())
      await upload('logo', pngImage(256, 256, Buffer.from('logo')))
      for (const who of ['seller', 'pending', 'admin'] as const) {
        assert.equal((await json('GET', '/appearance', { token: tokens[who] })).status, 200, `${who} settings`)
        const img = await raw('/appearance/hero-image', tokens[who])
        assert.equal(img.status, 200, `${who} hero`)
        assert.equal((await raw('/appearance/logo', tokens[who])).status, 200, `${who} logo`)
      }
    })

    it('still blocks a suspended reseller from everything', async () => {
      assert.equal((await json('GET', '/appearance', { token: tokens.suspended })).status, 403)
      assert.equal((await raw('/appearance/hero-image', tokens.suspended)).status, 403)
    })

    it('refuses a reseller on every admin read and write (403), changing and storing nothing', async () => {
      assert.equal((await json('GET', '/admin/settings/appearance', { token: tokens.seller })).status, 403)
      assert.equal((await putPrefs({ defaultTheme: 'light', reason: REASON }, tokens.seller)).status, 403)
      assert.equal((await upload('hero-image', hero(), { token: tokens.seller })).status, 403)
      assert.equal((await upload('logo', pngImage(256, 256), { token: tokens.seller })).status, 403)
      assert.equal((await reset('hero-image', { reason: REASON }, tokens.seller)).status, 403)
      assert.equal((await reset('logo', { reason: REASON }, tokens.pending)).status, 403)
      assert.equal(state.settings.size, 0)
      assert.deepEqual(state.audit, [])
      assert.deepEqual(state.notifications, [])
      assert.deepEqual([...heroFiles(), ...logoFiles()], [])
    })
  })

  describe('welcome texts and default color mode', () => {
    it('saves a color mode and both welcome texts, audits the change with its reason and tells every admin', async () => {
      const res = await putPrefs({ defaultTheme: 'light', welcomeText: { en: ' Hello, {name}! ', si: 'සාදරයෙන් පිළිගනිමු, {name}!' }, reason: REASON })
      assert.equal(res.status, 200)
      assert.equal(row(KEY.theme)!.value, 'light')
      assert.equal(row(KEY.en)!.value, 'Hello, {name}!')
      assert.equal(row(KEY.si)!.value, 'සාදරයෙන් පිළිගනිමු, {name}!')
      assert.equal(row(KEY.theme)!.updatedById, 'u-admin')

      assert.deepEqual(auditActions(), ['SETTINGS_APPEARANCE_UPDATED'])
      const audit = state.audit[0]
      assert.equal(audit.actorEmail, 'admin@test.invalid')
      assert.equal(audit.metadata.reason, REASON)
      assert.deepEqual(audit.metadata.changes.map((c: Row) => [c.setting, c.before, c.after]), [
        ['default color mode', null, 'light'],
        ['English welcome text', null, 'Hello, {name}!'],
        ['Sinhala welcome text', null, 'සාදරයෙන් පිළිගනිමු, {name}!'],
      ])
      assert.equal(state.notifications.length, 1, 'one active admin')
      assert.equal(state.notifications[0].type, 'SETTINGS_CHANGED')
      assert.equal(state.notifications[0].userId, 'u-admin')
      assert.ok(state.notifications[0].body.includes(REASON))

      const pub = (await json('GET', '/appearance', { token: tokens.seller })).json.data
      assert.deepEqual(pub, { defaultTheme: 'light', welcomeText: { en: 'Hello, {name}!', si: 'සාදරයෙන් පිළිගනිමු, {name}!' }, heroImage: null, logo: null })
      const admin = (await json('GET', '/admin/settings/appearance', { token: tokens.admin })).json.data
      assert.equal(admin.details.welcomeTextEn.custom, true)
      assert.deepEqual(admin.details.welcomeTextEn.updatedBy, { name: 'Ada Admin', email: 'admin@test.invalid' })
    })

    it('keeps English and Sinhala independent', async () => {
      await putPrefs({ welcomeText: { en: 'Hello {name}' }, reason: REASON })
      assert.equal(row(KEY.si), undefined)
      await putPrefs({ welcomeText: { si: 'ආයුබෝවන් {name}' }, reason: REASON })
      assert.equal(row(KEY.en)!.value, 'Hello {name}')
      await putPrefs({ welcomeText: { en: null }, reason: REASON })
      assert.equal(row(KEY.en), undefined)
      assert.equal(row(KEY.si)!.value, 'ආයුබෝවන් {name}')
    })

    it('goes back to the built-in values when reset with null', async () => {
      await putPrefs({ defaultTheme: 'system', welcomeText: { en: 'Hello', si: 'ආයුබෝවන්' }, reason: REASON })
      const res = await putPrefs({ defaultTheme: null, welcomeText: { en: null, si: null }, reason: 'Back to the standard look' })
      assert.equal(res.status, 200)
      assert.equal(state.settings.size, 0)
      assert.deepEqual((await json('GET', '/appearance', { token: tokens.seller })).json.data, { defaultTheme: 'dark', welcomeText: { en: null, si: null }, heroImage: null, logo: null })
    })

    it('leaves no audit entry and sends no notification when nothing actually changes', async () => {
      await putPrefs({ defaultTheme: 'light', reason: REASON })
      state.audit.length = 0
      state.notifications.length = 0
      assert.equal((await putPrefs({ defaultTheme: 'light', reason: REASON })).status, 200)
      assert.equal((await putPrefs({ welcomeText: { en: null }, reason: REASON })).status, 200)
      assert.deepEqual(state.audit, [])
      assert.deepEqual(state.notifications, [])
    })

    it('rejects invalid input with 422 and changes nothing', async () => {
      const bad: unknown[] = [
        { defaultTheme: 'light' },
        { defaultTheme: 'light', reason: 'abc' },
        { reason: REASON },
        { defaultTheme: 'purple', reason: REASON },
        { defaultTheme: 'light', reason: REASON, accentColor: '#f00' },
        { welcomeText: { en: '' }, reason: REASON },
        { welcomeText: { en: 'x'.repeat(121) }, reason: REASON },
        { welcomeText: { en: 'Hi {user}' }, reason: REASON },
        { welcomeText: { si: 'two\nlines' }, reason: REASON },
        { welcomeText: { de: 'Hallo' }, reason: REASON },
        { defaultTheme: 'light', welcomeText: { en: 'ok', si: 'Hi {oops}' }, reason: REASON },
      ]
      for (const body of bad) {
        const res = await putPrefs(body)
        assert.equal(res.status, 422, JSON.stringify(body))
        assert.ok(Array.isArray(res.json.errors) && res.json.errors.length > 0)
      }
      assert.equal(state.settings.size, 0, 'a partly valid request is rejected as a whole')
      assert.deepEqual(state.audit, [])
    })

    it('rolls everything back when the audit entry cannot be written', async () => {
      await putPrefs({ defaultTheme: 'light', reason: REASON })
      state.failAudit = new Error('audit table unavailable')
      const res = await putPrefs({ defaultTheme: 'system', welcomeText: { en: 'New text' }, reason: REASON })
      assert.equal(res.status, 500)
      assert.equal(row(KEY.theme)!.value, 'light')
      assert.equal(row(KEY.en), undefined)
    })
  })

  describe('uploading the hero image and the logo', () => {
    it('stores the image encrypted, serves the same bytes back to signed-in users, and audits the upload', async () => {
      const image = hero()
      const res = await upload('hero-image', image)
      assert.equal(res.status, 200)
      assert.equal(res.json.data.heroImage.version, row(KEY.hero)!.updatedAt.toISOString())
      assert.equal(res.json.data.details.heroImage.custom, true)
      assert.equal(res.json.data.logo, null, 'the logo is a separate setting')

      const files = heroFiles()
      assert.equal(files.length, 1)
      const onDisk = fs.readFileSync(files[0])
      assert.equal(onDisk.includes(Buffer.from('hero-A')), false, 'the file on disk is encrypted')
      assert.notDeepEqual(onDisk.subarray(0, 8), image.subarray(0, 8))

      const served = await raw('/appearance/hero-image', tokens.seller)
      assert.equal(served.status, 200)
      assert.equal(served.headers.get('content-type'), 'image/png')
      assert.equal(served.headers.get('x-content-type-options'), 'nosniff')
      assert.match(served.headers.get('cache-control') ?? '', /no-store/)
      assert.match(served.headers.get('content-security-policy') ?? '', /default-src 'none'/)
      assert.deepEqual(served.bytes, image)

      assert.deepEqual(auditActions(), ['SETTINGS_APPEARANCE_IMAGE_UPDATED'])
      assert.equal(state.audit[0].metadata.reason, REASON)
      assert.equal(state.audit[0].metadata.image, 'hero')
      assert.equal(state.audit[0].metadata.replacedCustomImage, false)
      assert.equal(state.audit[0].metadata.width, 1920)
      assert.equal(state.notifications.length, 1)
    })

    it('accepts JPEG and WEBP too, and identifies the type from the content rather than the file name or declared type', async () => {
      const jpg = jpegImage(1600, 900, Buffer.from('jpg'))
      assert.equal((await upload('hero-image', jpg, { type: 'application/octet-stream', name: 'banner.dat' })).status, 200)
      assert.equal((await raw('/appearance/hero-image', tokens.seller)).headers.get('content-type'), 'image/jpeg')
      const webp = webpImage(1600, 900, Buffer.from('webp'))
      assert.equal((await upload('hero-image', webp, { type: 'image/jpeg', name: 'banner.jpg' })).status, 200)
      assert.equal((await raw('/appearance/hero-image', tokens.seller)).headers.get('content-type'), 'image/webp')
    })

    it('never exposes the private storage path or key in any response', async () => {
      const res = await upload('hero-image', hero())
      noStoragePaths(res.json, 'upload response')
      noStoragePaths((await json('GET', '/appearance', { token: tokens.seller })).json, 'public settings')
      noStoragePaths((await json('GET', '/admin/settings/appearance', { token: tokens.admin })).json, 'admin settings')
      noStoragePaths(state.audit, 'audit log')
      noStoragePaths(state.notifications, 'notifications')
    })

    it('handles the logo the same way, with its own storage and its own setting', async () => {
      const logo = pngImage(256, 256, Buffer.from('logo-A'))
      assert.equal((await upload('hero-image', hero())).status, 200)
      assert.equal((await upload('logo', logo)).status, 200)
      assert.equal(heroFiles().length, 1)
      assert.equal(logoFiles().length, 1)
      assert.deepEqual((await raw('/appearance/logo', tokens.seller)).bytes, logo)
      assert.deepEqual((await raw('/appearance/hero-image', tokens.seller)).bytes, hero())
    })

    it('needs a reason and a file, and refuses extra fields', async () => {
      for (const reasonValue of [null, 'abc']) {
        const res = await upload('hero-image', hero(), { reason: reasonValue })
        assert.equal(res.status, 422, String(reasonValue))
      }
      assert.equal((await upload('hero-image', null)).status, 400)
      assert.equal(state.settings.size, 0)
      assert.deepEqual(heroFiles(), [])
      assert.deepEqual(state.audit, [])
    })

    it('rejects anything that is not a real JPG, PNG or WEBP, even when named and typed like one', async () => {
      const rejected: Array<[string, Buffer]> = [
        ['HTML', Buffer.from('<html><script>alert(1)</script></html>')],
        ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1000"><script>alert(1)</script></svg>')],
        ['PDF', Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(200)])],
        ['Windows program', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(500)])],
        ['GIF', Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(200)])],
        ['plain text', Buffer.from('just some text, not a picture')],
        ['empty file', Buffer.alloc(0)],
        ['PNG signature only', pngImage(1920, 640).subarray(0, 10)],
        ['PNG with a damaged header', Buffer.concat([pngImage(1920, 640).subarray(0, 12), Buffer.from('XXXX'), Buffer.alloc(30)])],
        ['truncated JPEG', jpegImage(1920, 640).subarray(0, 12)],
        ['truncated WEBP', webpImage(1920, 640).subarray(0, 16)],
      ]
      for (const [label, bytes] of rejected) {
        const res = await upload('hero-image', bytes, { type: 'image/png', name: 'picture.png' })
        assert.equal(res.status, 400, label)
        assert.ok(/image/i.test(res.json.message), `${label}: ${res.json.message}`)
      }
      assert.equal(state.settings.size, 0)
      assert.deepEqual(heroFiles(), [], 'nothing was written to storage')
      assert.deepEqual(state.audit, [])
      assert.deepEqual(state.notifications, [])
    })

    it('rejects images that are too small or too large in pixels', async () => {
      const cases: Array<['hero-image' | 'logo', Buffer, RegExp]> = [
        ['hero-image', pngImage(400, 150), /at least 800 × 300/],
        ['hero-image', pngImage(1920, 200), /at least 800 × 300/],
        ['hero-image', pngImage(9000, 1000), /at most 8000/],
        ['logo', pngImage(16, 16), /at least 32 × 32/],
        ['logo', pngImage(4500, 4500), /at most 4000/],
      ]
      for (const [kind, bytes, message] of cases) {
        const res = await upload(kind, bytes)
        assert.equal(res.status, 400)
        assert.match(res.json.message, message)
      }
      assert.equal(state.settings.size, 0)
    })

    it('rejects files over the size limit (5 MB for the hero image, 2 MB for the logo) before storing anything', async () => {
      const bigHero = await upload('hero-image', pngImage(1920, 640, Buffer.alloc(5 * 1024 * 1024)))
      assert.equal(bigHero.status, 400)
      assert.equal(bigHero.json.message, 'File too large')
      const bigLogo = await upload('logo', pngImage(512, 512, Buffer.alloc(2 * 1024 * 1024)))
      assert.equal(bigLogo.status, 400)
      assert.equal(bigLogo.json.message, 'File too large')
      // The hero limit is higher, so a 3 MB file is fine for it but not for the logo.
      assert.equal((await upload('logo', pngImage(512, 512, Buffer.alloc(3 * 1024 * 1024)))).status, 400)
      assert.equal((await upload('hero-image', pngImage(1920, 640, Buffer.alloc(3 * 1024 * 1024)))).status, 200)
      assert.deepEqual(logoFiles(), [])
    })

    it('rejects a second file field or a wrongly named one', async () => {
      const form = new FormData()
      form.append('reason', REASON)
      form.append('file', new Blob([hero()], { type: 'image/png' }), 'x.png')
      const res = await fetch(`${base}/api/v1/admin/settings/appearance/hero-image`, { method: 'PUT', headers: { Authorization: `Bearer ${tokens.admin}` }, body: form })
      assert.equal(res.status, 400)
      assert.equal(state.settings.size, 0)
      assert.deepEqual(heroFiles(), [])
    })
  })

  describe('replacing an image', () => {
    it('serves the new image, deletes the old file only after the new one is saved, and records the replacement', async () => {
      assert.equal((await upload('hero-image', hero('A'))).status, 200)
      const oldKey = row(KEY.hero)!.value
      const oldFile = heroFiles()[0]
      assert.equal((await upload('hero-image', hero('B'))).status, 200)

      assert.notEqual(row(KEY.hero)!.value, oldKey)
      assert.equal(fs.existsSync(oldFile), false, 'old file removed')
      assert.equal(heroFiles().length, 1)
      assert.deepEqual((await raw('/appearance/hero-image', tokens.seller)).bytes, hero('B'))
      await assert.rejects(privateStorage.read(oldKey))
      assert.deepEqual(state.audit.map((a) => a.metadata.replacedCustomImage), [false, true])
      noStoragePaths(state.audit, 'audit log')
    })

    it('changes the version, so browsers fetch the replacement', async () => {
      const first = (await upload('hero-image', hero('A'))).json.data.heroImage.version
      const second = (await upload('hero-image', hero('B'))).json.data.heroImage.version
      assert.notEqual(first, second)
    })

    it('keeps the previous image untouched when saving the replacement fails, and removes the new file', async () => {
      await upload('hero-image', hero('A'))
      const keyA = row(KEY.hero)!.value
      const filesBefore = heroFiles()
      state.audit.length = 0
      state.notifications.length = 0

      state.failAudit = new Error('audit table unavailable')
      const res = await upload('hero-image', hero('B'))
      assert.equal(res.status, 500)

      assert.equal(row(KEY.hero)!.value, keyA, 'still points at the previous image')
      assert.deepEqual(heroFiles(), filesBefore, 'the half-saved new file is gone and the old one is still there')
      assert.deepEqual((await raw('/appearance/hero-image', tokens.seller)).bytes, hero('A'))
      assert.deepEqual(state.audit, [])
      assert.deepEqual(state.notifications, [])
      assert.equal((await upload('hero-image', hero('C'))).status, 200, 'the next upload works normally')
    })

    it('does not fail the replacement when the old file cannot be deleted', async () => {
      await upload('hero-image', hero('A'))
      mock.method(privateStorage, 'remove', async () => {
        throw new Error('disk busy')
      })
      const res = await upload('hero-image', hero('B'))
      assert.equal(res.status, 200)
      assert.deepEqual((await raw('/appearance/hero-image', tokens.seller)).bytes, hero('B'))
    })

    it('keeps exactly one file when several admins upload at the same moment', async () => {
      let release!: () => void
      state.overlap = { expected: 3, arrived: 0, release: () => release(), ready: new Promise<void>((resolve) => (release = resolve)) }
      const results = await Promise.all([upload('hero-image', hero('A')), upload('hero-image', hero('B')), upload('hero-image', hero('C'))])
      state.overlap = undefined
      assert.deepEqual(results.map((r) => r.status), [200, 200, 200])
      assert.equal(heroFiles().length, 1, 'no orphaned files')
      const served = (await raw('/appearance/hero-image', tokens.seller)).bytes
      assert.ok([hero('A'), hero('B'), hero('C')].some((b) => b.equals(served)))
    })

    it('shows the built-in image again if the stored file has gone missing (404), without breaking the settings', async () => {
      await upload('hero-image', hero('A'))
      fs.rmSync(heroFiles()[0])
      assert.equal((await raw('/appearance/hero-image', tokens.seller)).status, 404)
      assert.equal((await json('GET', '/appearance', { token: tokens.seller })).status, 200)
    })
  })

  describe('resetting an image', () => {
    it('removes the setting and the file, audits the reset with its reason, and the built-in image is used again', async () => {
      await upload('hero-image', hero('A'))
      await upload('logo', pngImage(256, 256, Buffer.from('logo')))
      state.audit.length = 0
      state.notifications.length = 0

      const res = await reset('hero-image', { reason: 'Campaign ended' })
      assert.equal(res.status, 200)
      assert.equal(res.json.data.heroImage, null)
      assert.notEqual(res.json.data.logo, null, 'the logo is not affected')
      assert.equal(row(KEY.hero), undefined)
      assert.deepEqual(heroFiles(), [])
      assert.equal(logoFiles().length, 1)
      assert.equal((await raw('/appearance/hero-image', tokens.seller)).status, 404)
      assert.deepEqual(auditActions(), ['SETTINGS_APPEARANCE_IMAGE_RESET'])
      assert.equal(state.audit[0].metadata.reason, 'Campaign ended')
      assert.equal(state.notifications.length, 1)
    })

    it('needs a valid reason', async () => {
      await upload('logo', pngImage(256, 256))
      for (const body of [{}, { reason: 'abc' }, { reason: REASON, extra: 1 }]) assert.equal((await reset('logo', body)).status, 422)
      assert.equal(logoFiles().length, 1)
      assert.notEqual(row(KEY.logo), undefined)
    })

    it('does nothing, without an audit entry or notification, when no custom image is set', async () => {
      const res = await reset('hero-image')
      assert.equal(res.status, 200)
      assert.deepEqual(state.audit, [])
      assert.deepEqual(state.notifications, [])
    })

    it('keeps the image when the audit entry cannot be written', async () => {
      await upload('hero-image', hero('A'))
      state.failAudit = new Error('audit table unavailable')
      assert.equal((await reset('hero-image')).status, 500)
      assert.notEqual(row(KEY.hero), undefined)
      assert.equal(heroFiles().length, 1)
      assert.deepEqual((await raw('/appearance/hero-image', tokens.seller)).bytes, hero('A'))
    })

    it('still resets when the old file cannot be deleted', async () => {
      await upload('hero-image', hero('A'))
      mock.method(privateStorage, 'remove', async () => {
        throw new Error('disk busy')
      })
      const res = await reset('hero-image')
      assert.equal(res.status, 200)
      assert.equal(res.json.data.heroImage, null)
    })
  })
})
