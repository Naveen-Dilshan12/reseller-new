import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { installHermeticBackend, strictFake } from './helpers/hermetic-backend'

/**
 * The login-page theme through the real Express `app`: the public (logged-out) endpoint the login pages read, and the existing
 * admin appearance endpoint that saves it (auth, permissions, validation, service, audit and notification). It is a field of the
 * existing appearance settings, not a new endpoint or settings system.
 *
 * Database-free (see tests/helpers/hermetic-backend.ts): nothing here reads `.env`, runs Prisma or opens a connection.
 * PlatformSetting, AuditLog, Notification and User are in-memory stand-ins; a transaction is rolled back if its callback throws.
 * Separate from the other appearance tests so it has its own request budget under the global rate limit.
 */

type Row = Record<string, any>

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
}

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

const KEY = 'APPEARANCE_LOGIN_THEME'
const REASON = 'Match the new brand colors'
const theme = require('../../web/src/lib/login-theme')
const preset = (id: string): Record<string, string> => ({ ...theme.LOGIN_THEME_PRESETS.find((p: { id: string }) => p.id === id).colors })
const KEYS: string[] = [...theme.LOGIN_THEME_COLOR_KEYS]

describe('Login page theme API', () => {
  let base = ''
  let server: http.Server
  const tokens: Record<string, string> = {}

  const json = async (method: string, urlPath: string, opts: { token?: string; body?: unknown } = {}) => {
    const res = await fetch(`${base}/api/v1${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    })
    return { status: res.status, json: (await res.json().catch(() => null)) as any }
  }
  const publicBranding = () => json('GET', '/public/login-branding')
  const adminAppearance = () => json('GET', '/admin/settings/appearance', { token: tokens.admin })
  const putPrefs = (body: unknown, token = tokens.admin) => json('PUT', '/admin/settings/appearance', { token, body })
  const saveTheme = (colors: Record<string, unknown>, extra: Row = {}) => putPrefs({ loginTheme: { colors }, reason: REASON, ...extra })
  const row = () => state.settings.get(KEY)
  const auditActions = () => state.audit.map((a) => a.action)

  before(async () => {
    installHermeticBackend(fakePrisma)
    const { signAccessToken } = await import('../src/utils/jwt')
    const { default: app } = await import('../src/app')
    for (const [name, id] of [['admin', 'u-admin'], ['seller', 'u-seller']] as const) {
      const u = USERS[id]
      tokens[name] = signAccessToken({ userId: u.id, email: u.email, role: u.role, resellerId: u.resellerId })
    }
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  beforeEach(() => {
    state.settings.clear()
    state.audit.length = 0
    state.notifications.length = 0
    state.failAudit = undefined
  })

  describe('before an admin saves anything', () => {
    it('serves no theme, so the login pages keep their built-in colors, and stores nothing', async () => {
      const res = await publicBranding()
      assert.equal(res.status, 200)
      assert.equal(res.json.data.theme, null)
      assert.equal(state.settings.size, 0)
      const admin = (await adminAppearance()).json.data
      assert.equal(admin.loginBranding.theme, null)
      assert.deepEqual(admin.details.loginTheme, { custom: false, updatedAt: null, updatedBy: null })
    })

    it('does not change when other appearance settings are saved', async () => {
      assert.equal((await putPrefs({ loginBranding: { heading: 'Welcome to Acme' }, reason: REASON })).status, 200)
      assert.equal((await publicBranding()).json.data.theme, null)
      assert.equal(row(), undefined)
    })
  })

  describe('saving a theme', () => {
    it('stores the nine colors, serves them to logged-out visitors, and audits and announces the change', async () => {
      const dark = preset('dark')
      const res = await saveTheme(dark)
      assert.equal(res.status, 200)
      assert.deepEqual(res.json.data.loginBranding.theme, { colors: dark })
      assert.equal(res.json.data.details.loginTheme.custom, true)
      assert.deepEqual(res.json.data.details.loginTheme.updatedBy, { name: 'Ada Admin', email: 'admin@test.invalid' })

      // Stored as one JSON text in a fixed key order, by the admin who saved it.
      assert.deepEqual(JSON.parse(row()!.value), { colors: dark })
      assert.deepEqual(Object.keys(JSON.parse(row()!.value).colors), KEYS)
      assert.equal(row()!.updatedById, 'u-admin')

      // The login pages read it without signing in, next to (and not instead of) the other branding.
      const pub = await publicBranding()
      assert.equal(pub.status, 200)
      assert.deepEqual(Object.keys(pub.json.data).sort(), ['heading', 'heroImage', 'text', 'theme'])
      assert.deepEqual(pub.json.data.theme, { colors: dark })

      assert.deepEqual(auditActions(), ['SETTINGS_APPEARANCE_UPDATED'])
      const audit = state.audit[0]
      assert.equal(audit.metadata.reason, REASON)
      assert.deepEqual(audit.metadata.changes.map((c: Row) => [c.setting, c.before, JSON.parse(c.after)]), [['login page theme', null, { colors: dark }]])
      assert.equal(state.notifications.length >= 1, true, 'admins are told')
      assert.ok(state.notifications.every((n) => /login page theme/.test(n.body)))
    })

    it('stores one canonical text per color: #RRGGBB in capitals, 3-digit and lowercase values expanded', async () => {
      const res = await saveTheme({ ...preset('light'), accent: '#16a34a', buttonBg: '#15803d', inputBg: ' #fff ', pageBg: '#ABC' })
      assert.equal(res.status, 200)
      const stored = JSON.parse(row()!.value).colors
      assert.equal(stored.accent, '#16A34A')
      assert.equal(stored.buttonBg, '#15803D')
      assert.equal(stored.inputBg, '#FFFFFF')
      assert.equal(stored.pageBg, '#AABBCC')
    })

    it('can be replaced by another theme, and an unchanged save writes and audits nothing', async () => {
      await saveTheme(preset('light'))
      await saveTheme(preset('green'))
      assert.deepEqual(JSON.parse(row()!.value).colors, preset('green'))
      assert.equal(auditActions().length, 2)
      const before = { ...row()! }
      assert.equal((await saveTheme({ ...preset('green'), accent: '#166534' })).status, 200, 'same colors, different spelling')
      assert.equal(auditActions().length, 2)
      assert.deepEqual(row(), before)
    })

    it('saves together with the other appearance fields in one audited change', async () => {
      const res = await putPrefs({ loginTheme: { colors: preset('gray') }, loginBranding: { heading: 'Welcome to Acme' }, reason: REASON })
      assert.equal(res.status, 200)
      assert.deepEqual(auditActions(), ['SETTINGS_APPEARANCE_UPDATED'])
      assert.deepEqual(state.audit[0].metadata.changes.map((c: Row) => c.setting), ['login page heading', 'login page theme'])
    })

    it('allows colors that are only hard to read (a warning in the admin screen, not an error): white text on #16A34A is 3.3 : 1', async () => {
      const res = await saveTheme({ ...preset('green'), buttonBg: '#16A34A', buttonText: '#FFFFFF' })
      assert.equal(res.status, 200)
      assert.equal(JSON.parse(row()!.value).colors.buttonBg, '#16A34A')
    })
  })

  describe('invalid colors', () => {
    const errorsOf = (res: { json: any }): string[] => res.json?.errors ?? []

    it('are refused with 422 and a clear message naming the field, and nothing is stored or audited', async () => {
      const cases: Array<[unknown, RegExp]> = [
        ['16A34A', /^loginTheme\.colors\.accent: A HEX color starts with #/],
        ['#16A3', /^loginTheme\.colors\.accent: A HEX color has 3 or 6 digits/],
        ['#16A34A7F', /^loginTheme\.colors\.accent: A HEX color has 3 or 6 digits/],
        ['#GGGGGG', /^loginTheme\.colors\.accent: A HEX color can only use the digits 0-9/],
        ['', /^loginTheme\.colors\.accent: Enter a HEX color such as #16A34A\./],
        ['red', /^loginTheme\.colors\.accent: A HEX color starts with #/],
        ['#16A34A; background: url(x)', /^loginTheme\.colors\.accent: A HEX color can only use the digits 0-9/],
        [123456, /^loginTheme\.colors\.accent: A color must be text such as #16A34A\./],
        [null, /^loginTheme\.colors\.accent: A color must be text such as #16A34A\./],
      ]
      for (const [value, expected] of cases) {
        const res = await saveTheme({ ...preset('light'), accent: value })
        assert.equal(res.status, 422, JSON.stringify(value))
        assert.match(errorsOf(res).join('\n'), expected, JSON.stringify(value))
      }
      assert.equal(state.settings.size, 0)
      assert.deepEqual(state.audit, [])
    })

    it('are refused in every one of the nine fields', async () => {
      for (const key of KEYS) {
        const res = await saveTheme({ ...preset('light'), [key]: 'nope' })
        assert.equal(res.status, 422, key)
        assert.match(errorsOf(res).join('\n'), new RegExp(`loginTheme\\.colors\\.${key}: A HEX color starts with #`), key)
      }
      assert.equal(state.settings.size, 0)
    })

    it('incomplete or unknown theme shapes are refused', async () => {
      const { heroOverlay, ...missing } = preset('light')
      assert.equal(heroOverlay, '#0F172A')
      const bodies: unknown[] = [
        { loginTheme: { colors: missing }, reason: REASON },
        { loginTheme: { colors: { ...preset('light'), extra: '#FFFFFF' } }, reason: REASON },
        { loginTheme: { colors: preset('light'), preset: 'light' }, reason: REASON },
        { loginTheme: { colors: {} }, reason: REASON },
        { loginTheme: {}, reason: REASON },
        { loginTheme: 'dark', reason: REASON },
        { loginTheme: [], reason: REASON },
      ]
      for (const body of bodies) assert.equal((await putPrefs(body)).status, 422, JSON.stringify(body))
      assert.match((await saveTheme(missing)).json.errors.join('\n'), /loginTheme\.colors\.heroOverlay: Enter a HEX color/)
      assert.equal(state.settings.size, 0)
      assert.deepEqual(state.audit, [])
    })

    it('a theme the sign-in form could not be read in is refused with the pair named; only severe cases', async () => {
      const unreadable = [
        { ...preset('light'), text: '#FFFFFF' },
        { ...preset('dark'), pageBg: '#1E293B', text: '#0F172A' },
        { ...preset('light'), buttonText: '#1D4ED8' },
      ]
      const messages = ['Main text on the page background', 'Main text on the page background', 'Primary button text on the button']
      for (const [i, colors] of unreadable.entries()) {
        const res = await saveTheme(colors)
        assert.equal(res.status, 422, JSON.stringify(colors))
        assert.match(errorsOf(res).join('\n'), new RegExp(`${messages[i]} is too hard to read \\(\\d\\.\\d : 1\\)\\. .* need at least 3 : 1`), JSON.stringify(colors))
      }
      assert.equal(state.settings.size, 0)
    })
  })

  describe('reset to default', () => {
    it('removes the saved theme, so visitors get the built-in colors again, with an audit entry', async () => {
      await saveTheme(preset('dark'))
      const res = await putPrefs({ loginTheme: null, reason: 'Back to the original look' })
      assert.equal(res.status, 200)
      assert.equal(res.json.data.loginBranding.theme, null)
      assert.deepEqual(res.json.data.details.loginTheme, { custom: false, updatedAt: null, updatedBy: null })
      assert.equal(row(), undefined, 'the row is deleted, not set to a value')
      assert.equal((await publicBranding()).json.data.theme, null)
      assert.deepEqual(auditActions(), ['SETTINGS_APPEARANCE_UPDATED', 'SETTINGS_APPEARANCE_UPDATED'])
      const change = state.audit[1].metadata.changes[0]
      assert.equal(change.setting, 'login page theme')
      assert.deepEqual(JSON.parse(change.before), { colors: preset('dark') })
      assert.equal(change.after, null)
    })

    it('does nothing (and records nothing) when there is no saved theme', async () => {
      assert.equal((await putPrefs({ loginTheme: null, reason: REASON })).status, 200)
      assert.deepEqual(state.audit, [])
      assert.deepEqual(state.notifications, [])
    })

    it('leaves the other login branding alone', async () => {
      await putPrefs({ loginBranding: { heading: 'Welcome to Acme' }, loginTheme: { colors: preset('green') }, reason: REASON })
      await putPrefs({ loginTheme: null, reason: REASON })
      const pub = (await publicBranding()).json.data
      assert.equal(pub.heading, 'Welcome to Acme')
      assert.equal(pub.theme, null)
    })
  })

  describe('who may change it, and when', () => {
    it('needs a reason like every other appearance change', async () => {
      assert.equal((await putPrefs({ loginTheme: { colors: preset('dark') } })).status, 422)
      assert.equal((await putPrefs({ loginTheme: { colors: preset('dark') }, reason: 'abc' })).status, 422)
      assert.equal((await putPrefs({ loginTheme: null })).status, 422)
      assert.equal(state.settings.size, 0)
    })

    it('needs settings:manage: a reseller and a signed-out caller cannot save or reset it', async () => {
      assert.equal((await putPrefs({ loginTheme: { colors: preset('dark') }, reason: REASON }, tokens.seller)).status, 403)
      assert.equal((await json('PUT', '/admin/settings/appearance', { body: { loginTheme: { colors: preset('dark') }, reason: REASON } })).status, 401)
      await saveTheme(preset('dark'))
      assert.equal((await putPrefs({ loginTheme: null, reason: REASON }, tokens.seller)).status, 403)
      assert.deepEqual(JSON.parse(row()!.value).colors, preset('dark'))
      assert.equal(auditActions().length, 1)
    })

    it('is not part of the portal appearance: a signed-in reseller\'s /appearance has no login theme and keeps the portal color mode', async () => {
      await putPrefs({ defaultTheme: 'light', reason: REASON })
      await saveTheme(preset('dark'))
      const res = await json('GET', '/appearance', { token: tokens.seller })
      assert.equal(res.status, 200)
      assert.equal(res.json.data.defaultTheme, 'light', 'the portal color mode is what the admin set for the portal')
      assert.equal(JSON.stringify(res.json.data).includes(preset('dark').pageBg), false)
      assert.equal('theme' in res.json.data || 'loginBranding' in res.json.data, false)
    })

    it('saving the portal color mode does not touch the login theme', async () => {
      await saveTheme(preset('green'))
      await putPrefs({ defaultTheme: 'dark', reason: REASON })
      assert.deepEqual((await publicBranding()).json.data.theme, { colors: preset('green') })
    })
  })

  describe('robustness', () => {
    it('ignores a stored theme that is no longer valid (edited by hand, or not JSON) and shows the built-in colors', async () => {
      for (const value of ['not json', '{}', JSON.stringify({ colors: { ...preset('light'), accent: 'javascript:alert(1)' } }), JSON.stringify({ colors: { ...preset('light'), text: '#FFFFFF' } })]) {
        state.settings.set(KEY, { key: KEY, value, updatedAt: new Date(), updatedById: 'u-admin' })
        const res = await publicBranding()
        assert.equal(res.status, 200, value)
        assert.equal(res.json.data.theme, null, value)
      }
    })

    it('rolls the save back when the audit entry cannot be written', async () => {
      state.failAudit = new Error('audit table unavailable')
      const res = await saveTheme(preset('dark'))
      assert.equal(res.status >= 500, true)
      assert.equal(row(), undefined)
      assert.equal((await publicBranding()).json.data.theme, null)
    })
  })
})
