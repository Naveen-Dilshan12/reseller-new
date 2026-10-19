import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { jsx, mountPage } from './helpers/render-page'

/**
 * The login-page theme on the web side:
 *  - the shared auth layout applies a saved theme (as CSS variables on its own root) and keeps the Admin's heading, supporting
 *    text, hero picture and the built-in Sigiriya fallback working; with no theme it adds nothing;
 *  - the theme stays out of the signed-in portal: nothing in the layout touches the document, storage or the portal color mode;
 *  - every authentication page sits inside that layout;
 *  - the Admin editor (Appearance → Login page theme): presets, color picker + HEX field, live preview, contrast warnings,
 *    validation messages, Save and Reset to default, read-only mode.
 *
 * The real, unmodified components run in Node through tests/helpers/render-page.ts against scripted API stubs. There is no
 * browser, so how a page looks is not checked here, only the markup, the variables and the requests. Database-free; nothing
 * here reads `.env`, runs Prisma or opens a connection.
 */

const WEB = path.resolve(__dirname, '../../web/src')
const read = (file: string) => fs.readFileSync(path.join(WEB, file), 'utf8').replace(/\r\n/g, '\n')
const utils = require('../../web/src/lib/appearance-utils')
const theme = require('../../web/src/lib/login-theme')

type Row = Record<string, any>
const preset = (id: string): Record<string, string> => ({ ...theme.LOGIN_THEME_PRESETS.find((p: { id: string }) => p.id === id).colors })
const all = (node: any, out: Row[] = []): Row[] => {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) return node.forEach((n) => all(n, out)), out
  out.push(node)
  all(node.props?.children, out)
  return out
}
const classes = (el: Row): string[] => (typeof el.props?.className === 'string' ? el.props.className.split(/\s+/) : [])
const textOf = (node: any): string => (node == null ? '' : typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(textOf).join(' ') : textOf(node.props?.children))
const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

/* ═══ The auth layout ═══════════════════════════════════════════════════════ */

describe('AuthLayout with a login theme', () => {
  type ImageStub = { src: string; onload: () => void; onerror: () => void }
  let images: ImageStub[]
  let touched: string[]
  const realImage = (globalThis as any).Image
  const realWindow = (globalThis as any).window
  const realDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const realStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

  beforeEach(() => {
    images = []
    touched = []
    ;(globalThis as any).window = { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }
    ;(globalThis as any).Image = class {
      onload?: () => void
      onerror?: () => void
      set src(value: string) {
        images.push({ src: value, onload: () => this.onload?.(), onerror: () => this.onerror?.() })
      }
    }
    // The portal keeps its color mode on the document and in storage. If the login layout so much as looks at either, we hear about it.
    for (const name of ['document', 'localStorage', 'sessionStorage']) {
      Object.defineProperty(globalThis, name, { configurable: true, get: () => (touched.push(name), undefined) })
    }
  })
  afterEach(() => {
    ;(globalThis as any).Image = realImage
    if (realWindow === undefined) delete (globalThis as any).window
    else (globalThis as any).window = realWindow
    for (const [name, descriptor] of [['document', realDocument], ['localStorage', realStorage], ['sessionStorage', undefined]] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete (globalThis as any)[name]
    }
  })

  const BRANDING = (over: Row = {}) => ({ heading: null, text: null, heroImage: null, theme: null, ...over })
  const mount = async (state: { branding: unknown; status: 'loading' | 'ready' | 'failed' }, image: { url: string | null; status: string } = { url: null, status: 'none' }) => {
    const page = mountPage(
      path.join(WEB, 'components/auth/AuthLayout.tsx'),
      {
        '@/lib/appearance': { useProtectedImage: (p: string | null) => (p ? image : { url: null, status: 'none' }) },
        '@/lib/appearance-utils': utils,
        '@/lib/login-theme': theme,
        '@/lib/login-branding': { useLoginBranding: () => state },
        '@/app/login/login.css': {},
      },
      { exportName: 'AuthLayout', props: { ariaLabel: 'Sign In Form', children: jsx('form', { id: 'the-form', children: 'Sign in' }) } },
    )
    await page.settle()
    return page
  }
  const background = (page: Awaited<ReturnType<typeof mount>>) => all(page.root()).find((el) => String(el.props?.className ?? '').startsWith('login-left-bg'))!
  const heroText = (page: Awaited<ReturnType<typeof mount>>) =>
    all(all(page.root()).find((el) => classes(el).includes('login-left-hero'))).filter((el) => ['h2', 'p'].includes(el.type)).map((el) => String(el.props.children))
  const green = preset('green')

  it('adds nothing when no theme is saved: the root keeps its class, has no style, and the stylesheet\'s built-in colors show', async () => {
    const page = await mount({ branding: BRANDING(), status: 'ready' })
    assert.equal(page.root().props.className, 'login-split')
    assert.equal(page.root().props.style, undefined)
    assert.equal(background(page).props.style.backgroundColor, 'var(--theme-hero-bg, #0f172a)', 'falls back to the built-in dark blue')
  })

  it('also adds nothing while the branding is loading, after it failed, or when the server does not know themes yet', async () => {
    for (const state of [{ branding: null, status: 'loading' as const }, { branding: null, status: 'failed' as const }, { branding: { heading: null, text: null, heroImage: null }, status: 'ready' as const }]) {
      assert.equal((await mount(state)).root().props.style, undefined, JSON.stringify(state))
    }
  })

  it('applies a saved theme as CSS variables on the layout root, exactly the ones loginThemeVars builds', async () => {
    const page = await mount({ branding: BRANDING({ theme: { colors: green } }), status: 'ready' })
    assert.equal(page.root().props.className, 'login-split')
    assert.deepEqual(page.root().props.style, theme.loginThemeVars(green))
    assert.equal(page.root().props.style['--theme-btn-bg'], green.buttonBg)
    assert.equal(page.root().props.style['--theme-right-bg'], green.pageBg)
  })

  it('puts the variables on that one element only, so they reach the form and the hero panel and nothing outside the layout', async () => {
    const page = await mount({ branding: BRANDING({ theme: { colors: green } }), status: 'ready' })
    const withVars = all(page.root()).filter((el) => Object.keys(el.props?.style ?? {}).some((k) => k.startsWith('--')))
    assert.deepEqual(withVars.map((el) => el.type), ['main'])
    // The form (the page's own children) renders inside that element.
    assert.ok(all(page.root()).some((el) => el.props?.id === 'the-form'))
  })

  it('every color of a different preset changes the variables, so Light, Dark, Gray and Green really look different', async () => {
    const styles = []
    for (const p of theme.LOGIN_THEME_PRESETS) styles.push((await mount({ branding: BRANDING({ theme: { colors: p.colors } }), status: 'ready' })).root().props.style['--theme-right-bg'])
    assert.equal(new Set(styles).size, 4)
  })

  it('keeps the Admin\'s heading, supporting text and hero picture next to a theme', async () => {
    const branding = BRANDING({ heading: 'Welcome to Acme', text: 'Run your shop with us.', heroImage: { version: 'v1' }, theme: { colors: preset('dark') } })
    const page = await mount({ branding, status: 'ready' }, { url: 'blob:http://localhost/acme-hero', status: 'ready' })
    assert.deepEqual(heroText(page), ['Welcome to Acme', 'Run your shop with us.'])
    assert.deepEqual(images.map((i) => i.src), ['blob:http://localhost/acme-hero'])
    images[0].onload()
    await page.settle()
    assert.equal(background(page).props.style.backgroundImage, 'url("blob:http://localhost/acme-hero")')
    assert.equal(page.root().props.style['--theme-right-bg'], preset('dark').pageBg)
  })

  it('keeps the built-in text and shows the theme\'s overlay gradient, with no picture, when only the colors are customized', async () => {
    const page = await mount({ branding: BRANDING({ theme: { colors: preset('light') } }), status: 'ready' })
    assert.deepEqual(heroText(page), [utils.BUILT_IN_LOGIN_HEADING, utils.BUILT_IN_LOGIN_TEXT, utils.BUILT_IN_LOGIN_TAGLINE])
    assert.deepEqual(images, [], 'nothing is downloaded for the default look')
    assert.equal(background(page).props.className, 'login-left-bg loaded')
    assert.equal(background(page).props.style.backgroundImage, theme.heroFallbackGradient(preset('light').heroOverlay))
    assert.equal(background(page).props['aria-label'], utils.LOGIN_BACKGROUND_LABEL)
  })

  it('with no custom picture, or one that cannot be loaded, the panel shows the theme\'s overlay color, or the built-in gradient without a theme', async () => {
    // No custom picture: the gradient is shown at once and nothing is downloaded.
    const themed = await mount({ branding: BRANDING({ theme: { colors: green } }), status: 'ready' })
    assert.deepEqual(images, [])
    assert.equal(background(themed).props.style.backgroundImage, theme.heroFallbackGradient(green.heroOverlay))
    assert.notEqual(background(themed).props.style.backgroundImage, utils.LOGIN_FALLBACK_GRADIENT)
    const plain = await mount({ branding: BRANDING(), status: 'ready' })
    assert.deepEqual(images, [])
    assert.equal(background(plain).props.style.backgroundImage, utils.LOGIN_FALLBACK_GRADIENT)

    // A custom picture that fails to load falls back to the very same gradients.
    const CUSTOM = { url: 'blob:http://localhost/acme-hero', status: 'ready' }
    const failingThemed = await mount({ branding: BRANDING({ heroImage: { version: 'v1' }, theme: { colors: green } }), status: 'ready' }, CUSTOM)
    images[0].onerror()
    await failingThemed.settle()
    assert.equal(background(failingThemed).props.style.backgroundImage, theme.heroFallbackGradient(green.heroOverlay))

    images.length = 0
    const failingPlain = await mount({ branding: BRANDING({ heroImage: { version: 'v1' } }), status: 'ready' }, CUSTOM)
    images[0].onerror()
    await failingPlain.settle()
    assert.equal(background(failingPlain).props.style.backgroundImage, utils.LOGIN_FALLBACK_GRADIENT)
  })

  it('ignores a theme that is not a complete set of #RRGGBB colors (nothing else may reach the stylesheet)', async () => {
    for (const bad of [{ colors: { ...green, accent: 'red; background: url(https://evil.example/x)' } }, { colors: { ...green, accent: '#abc' } }, { colors: {} }, 'green']) {
      const page = await mount({ branding: BRANDING({ theme: bad }), status: 'ready' })
      assert.equal(page.root().props.style, undefined, JSON.stringify(bad))
    }
  })

  it('never looks at the document, storage or the portal color mode', async () => {
    await mount({ branding: BRANDING({ theme: { colors: preset('dark') } }), status: 'ready' })
    assert.deepEqual(touched, [])
    const sources = [read('components/auth/AuthLayout.tsx'), read('lib/login-theme.ts')].join('\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    assert.ok(!/data-theme|THEME_STORAGE_KEY|THEME_DEFAULT_KEY|setDefaultTheme|useTheme|documentElement|localStorage/.test(sources))
  })
})

describe('the signed-in portal and the login theme stay apart', () => {
  it('no portal file reads the login theme', () => {
    for (const file of ['components/ResellerShell.tsx', 'components/PlatformLogo.tsx', 'lib/theme.tsx', 'lib/theme-script.ts', 'lib/appearance.ts', 'app/layout.tsx', 'app/admin/layout.tsx', 'app/dashboard/page.tsx', 'lib/auth.ts']) {
      assert.ok(!/login-theme|loginTheme|LoginTheme/.test(read(file)), file)
    }
  })

  it('only the auth layout and the Admin editor use it', () => {
    const users: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(WEB, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`
        if (entry.isDirectory()) walk(rel)
        else if (/\.(tsx?|css)$/.test(entry.name) && /login-theme|loginTheme/.test(read(rel))) users.push(rel)
      }
    }
    for (const dir of ['app', 'components', 'lib']) walk(dir)
    // login.css holds the rules that size the Admin preview; appearance-utils only declares the type of the served theme.
    assert.deepEqual(users.sort(), ['app/login/login.css', 'components/admin/LoginThemeSettings.tsx', 'components/auth/AuthLayout.tsx', 'lib/appearance-utils.ts', 'lib/login-theme.ts'])
    assert.ok(read('components/admin/AppearanceSettings.tsx').includes("import { LoginThemeSettings } from './LoginThemeSettings'"))
  })

  it('the theme uses its own variables on the login layout; the portal\'s html[data-theme] rules are not part of login.css', () => {
    assert.ok(!/data-theme/.test(read('app/login/login.css')))
  })
})

describe('authentication pages', () => {
  it('all five render inside the shared layout, so a saved theme reaches every one of them', () => {
    for (const page of ['login', 'register', 'forgot-password', 'reset-password', 'verify-email']) {
      const source = read(`app/${page}/page.tsx`)
      assert.match(source, /import \{ AuthLayout \} from '@\/components\/auth\/AuthLayout'/, page)
      assert.match(source, /<AuthLayout\b/, page)
      assert.ok(!/--theme-[\w-]+['"]?\s*:/.test(source), `${page} does not set theme variables of its own`)
    }
  })

  it('the pages take their text, field and link colors from the theme variables (the verify-email accent included)', () => {
    assert.match(read('app/verify-email/page.tsx'), /var\(--theme-accent, #0284c7\)/)
    assert.match(read('app/forgot-password/page.tsx'), /var\(--theme-text-subtitle\)/)
  })
})

/* ═══ The Admin editor ═════════════════════════════════════════════════════ */

class ApiError extends Error {
  constructor(message: string, public status = 0, public code?: string, public errors: string[] = []) {
    super(message)
  }
}

describe('Admin → Appearance → Login page theme', () => {
  const FILE = path.join(WEB, 'components/admin/LoginThemeSettings.tsx')
  const REASON = 'Match the new brand colors'
  const KEYS: string[] = [...theme.LOGIN_THEME_COLOR_KEYS]
  let calls: Array<{ url: string; method?: string; body: any }>
  let answers: Array<() => Promise<unknown>>
  let confirmAnswer: boolean
  let confirmed: string[]

  const appearance = (themeColors: Record<string, string> | null = null, over: Row = {}) => ({
    defaultTheme: 'dark',
    welcomeText: { en: null, si: null },
    heroImage: null,
    logo: null,
    loginBranding: { heading: null, text: null, heroImage: null, theme: themeColors ? { colors: themeColors } : null },
    details: {
      loginTheme: themeColors ? { custom: true, updatedAt: '2026-10-01T10:00:00.000Z', updatedBy: { name: 'Ada Admin', email: 'admin@test.invalid' } } : { custom: false, updatedAt: null, updatedBy: null },
    },
    ...over,
  })

  const open = async (over: { data?: Row; canManage?: boolean; imageUrl?: string | null } = {}) => {
    const updates: Array<[Row, string]> = []
    const props = { data: over.data ?? appearance(), canManage: over.canManage ?? true, imageUrl: over.imageUrl ?? null, onSaved: (u: Row, m: string) => updates.push([u, m]) }
    const page = mountPage(
      FILE,
      {
        '@/lib/api': {
          ApiError,
          api: async (url: string, init?: { method?: string; body?: string }) => {
            calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined })
            const next = answers.shift()
            if (!next) throw new Error(`unexpected request: ${url}`)
            return next()
          },
        },
        '@/lib/appearance-utils': utils,
        '@/lib/login-theme': theme,
        '@/app/login/login.css': {},
      },
      { exportName: 'LoginThemeSettings', props },
    )
    await page.settle()
    // What the Appearance page does with onSaved: keep the server's answer and hand it back down.
    const parentKeeps = (data: Row) => page.setProps({ ...props, data })
    return { page, updates, parentKeeps }
  }
  type Opened = Awaited<ReturnType<typeof open>>['page']

  const previewOf = (page: Opened) => all(page.root()).find((el) => classes(el).includes('login-theme-preview'))!
  const previewVars = (page: Opened) => previewOf(page).props.style as Record<string, string> | undefined
  const hex = (page: Opened, key: string) => page.valueOf(`login-color-${key}`)
  const picker = (page: Opened, key: string) => page.valueOf(`login-color-${key}-picker`)
  const noteOf = (page: Opened, key: string) => squash(textOf(all(page.root()).find((el) => el.props?.id === `login-color-${key}-note`)))
  const alerts = (page: Opened, kind: 'success' | 'warning' | 'error') => page.textOfClass(`alert ${kind}`).map(squash)
  const button = (page: Opened, label: string) => all(page.root()).find((el) => el.type === 'button' && squash(textOf(el)) === label)
  const field = (page: Opened, id: string) => all(page.root()).find((el) => el.props?.id === id)
  const fillReason = (page: Opened, text = REASON) => page.fill('login-theme-reason', text)

  beforeEach(() => {
    calls = []
    answers = []
    confirmAnswer = true
    confirmed = []
    ;(globalThis as any).confirm = (question: string) => (confirmed.push(question), confirmAnswer)
  })

  describe('with nothing saved', () => {
    it('says the built-in colors are in use, offers the four presets, and previews the built-in look without any theme variables', async () => {
      const { page } = await open()
      assert.ok(page.text().includes('Using the built-in login colors'))
      assert.deepEqual(page.buttonLabels().filter((l) => ['Light', 'Dark', 'Gray', 'Green'].includes(l)), ['Light', 'Dark', 'Gray', 'Green'])
      assert.equal(previewVars(page), undefined)
      assert.equal(field(page, 'login-color-pageBg'), undefined, 'no color fields until a preset is chosen')
      assert.equal(page.hasButton('Reset to default'), false, 'nothing to reset')
      assert.equal(page.hasButton('Discard changes'), false)
      assert.deepEqual(calls, [])
    })

    it('draws the preview from the real login classes, the current heading and text, and hides it from assistive technology', async () => {
      const data = appearance(null, { loginBranding: { heading: 'Welcome to Acme', text: 'Run your shop with us.', heroImage: null, theme: null } })
      const { page } = await open({ data })
      const preview = previewOf(page)
      assert.equal(preview.props['aria-hidden'], 'true')
      assert.equal(preview.props.inert, true)
      const text = squash(page.text())
      assert.ok(text.includes('Welcome to Acme') && text.includes('Run your shop with us.') && text.includes('Sign in') && text.includes('Create an account'))
      for (const name of ['login-left', 'login-left-bg', 'login-right', 'login-form-wrapper', 'login-field-input', 'login-submit', 'login-register-btn', 'login-forgot']) {
        assert.ok(all(preview).some((el) => classes(el).includes(name)), `uses .${name}`)
      }
      const bg = all(preview).find((el) => classes(el).includes('login-left-bg'))!
      assert.equal(bg.props.style.backgroundImage, utils.LOGIN_FALLBACK_GRADIENT, 'the built-in gradient: no picture ships with the app, so the preview shows no broken image')
    })

    it('shows the custom login picture in the preview when one is set', async () => {
      const { page } = await open({ imageUrl: 'blob:http://localhost/acme-hero' })
      const bg = all(previewOf(page)).find((el) => classes(el).includes('login-left-bg'))!
      assert.equal(bg.props.style.backgroundImage, 'url("blob:http://localhost/acme-hero")')
    })
  })

  describe('presets and live preview', () => {
    it('choosing Green fills all nine fields, highlights it and previews it before anything is saved', async () => {
      const { page } = await open()
      await page.click('Green')
      for (const key of KEYS) {
        assert.equal(hex(page, key), preset('green')[key], key)
        assert.equal(picker(page, key), preset('green')[key].toLowerCase(), `${key} picker`)
      }
      assert.deepEqual(previewVars(page), theme.loginThemeVars(preset('green')))
      assert.equal(button(page, 'Green')!.props['aria-pressed'], true)
      assert.equal(button(page, 'Light')!.props['aria-pressed'], false)
      assert.ok(page.text().includes('not saved yet'))
      assert.deepEqual(calls, [], 'nothing is sent until Save')
    })

    it('each preset previews its own colors, including a dark page for Dark and a light page for Light', async () => {
      const { page } = await open()
      for (const id of ['light', 'dark', 'gray', 'green']) {
        await page.click(id[0].toUpperCase() + id.slice(1))
        assert.equal(previewVars(page)!['--theme-right-bg'], preset(id).pageBg, id)
        assert.equal(previewVars(page)!['--theme-text-heading'], preset(id).text, id)
      }
    })

    it('typing a HEX value updates the preview and the color picker at once (stored in capitals)', async () => {
      const { page } = await open()
      await page.click('Light')
      await page.fill('login-color-accent', '#7c3aed')
      assert.equal(previewVars(page)!['--theme-link'], '#7C3AED')
      assert.equal(picker(page, 'accent'), '#7c3aed')
      assert.equal(hex(page, 'accent'), '#7c3aed', 'what is typed stays as typed')
      assert.equal(button(page, 'Light')!.props['aria-pressed'], false, 'no longer exactly the Light preset')
    })

    it('accepts a 3-digit HEX value and previews its expanded form', async () => {
      const { page } = await open()
      await page.click('Light')
      await page.fill('login-color-accent', '#abc')
      assert.equal(previewVars(page)!['--theme-link'], '#AABBCC')
      assert.equal(noteOf(page, 'accent'), 'Links, focus ring and the secondary button.')
    })

    it('the native color picker writes its value into the HEX field and the preview', async () => {
      const { page } = await open()
      await page.click('Dark')
      await page.fill('login-color-buttonBg-picker', '#16a34a')
      assert.equal(hex(page, 'buttonBg'), '#16A34A')
      assert.equal(previewVars(page)!['--theme-btn-bg'], '#16A34A')
    })

    it('every one of the nine fields changes the preview', async () => {
      const { page } = await open()
      await page.click('Light')
      const before = JSON.stringify(previewVars(page))
      for (const key of KEYS) {
        await page.click('Light')
        await page.fill(`login-color-${key}`, '#123456')
        assert.notEqual(JSON.stringify(previewVars(page)), before, key)
      }
    })
  })

  describe('validation', () => {
    it('shows a clear message under a field with an invalid HEX value, marks it invalid, and keeps the last good color in the preview', async () => {
      const { page } = await open()
      await page.click('Light')
      await page.fill('login-color-accent', '#7c3aed')
      await page.fill('login-color-accent', 'banana')
      assert.equal(noteOf(page, 'accent'), 'A HEX color starts with # (for example #16A34A).')
      assert.equal(field(page, 'login-color-accent')!.props['aria-invalid'], true)
      assert.equal(previewVars(page)!['--theme-link'], '#7C3AED', 'the preview does not break while typing')
      assert.equal(field(page, 'login-color-text')!.props['aria-invalid'], false)
      assert.deepEqual(alerts(page, 'success').concat(alerts(page, 'warning')), [], 'no contrast verdict on incomplete input')
      assert.ok(page.text().includes('Enter a valid HEX color in every field to check the contrast.'))
    })

    it('says what is wrong for each kind of mistake', async () => {
      const { page } = await open()
      await page.click('Light')
      const messages: Array<[string, RegExp]> = [
        ['', /Enter a HEX color such as #16A34A\./],
        ['16A34A', /starts with #/],
        ['#16A3', /3 or 6 digits/],
        ['#ZZZZZZ', /digits 0-9 and the letters A-F/],
      ]
      for (const [value, expected] of messages) {
        await page.fill('login-color-accent', value)
        assert.match(noteOf(page, 'accent'), expected, JSON.stringify(value))
      }
    })

    it('refuses to save an invalid value, names the field, and sends nothing', async () => {
      const { page } = await open()
      await page.click('Light')
      await page.fill('login-color-buttonBg', '#12')
      await fillReason(page)
      await page.submit()
      assert.deepEqual(alerts(page, 'error'), ['Primary button background: A HEX color has 3 or 6 digits after the # (for example #16A34A).'])
      assert.deepEqual(calls, [])
    })

    it('refuses to save without a reason, and with a reason that is too short', async () => {
      const { page } = await open()
      await page.click('Dark')
      await page.submit()
      assert.deepEqual(alerts(page, 'error'), ['Give a reason for the change (at least 5 characters).'])
      await fillReason(page, 'abc')
      await page.submit()
      assert.deepEqual(alerts(page, 'error'), ['Give a reason for the change (at least 5 characters).'])
      assert.deepEqual(calls, [])
    })

    it('refuses to save nothing: no preset chosen, or nothing changed from what is saved', async () => {
      const fresh = await open()
      await fillReason(fresh.page)
      await fresh.page.submit()
      assert.deepEqual(alerts(fresh.page, 'error'), ['Nothing to save yet. Choose a preset or change a color first.'])

      const saved = await open({ data: appearance(preset('green')) })
      await fillReason(saved.page)
      await saved.page.submit()
      assert.deepEqual(alerts(saved.page, 'error'), ['Nothing to save yet. Change a color first.'])
      assert.deepEqual(calls, [])
    })
  })

  describe('contrast', () => {
    it('says the colors are fine for every preset', async () => {
      const { page } = await open()
      for (const id of ['Light', 'Dark', 'Gray', 'Green']) {
        await page.click(id)
        assert.deepEqual(alerts(page, 'warning').concat(alerts(page, 'error')), [], id)
        assert.match(alerts(page, 'success')[0], /^Contrast is good: text meets 4\.5 : 1 and field borders meet 3 : 1\.$/, id)
      }
    })

    it('warns, without blocking, about white button text on #16A34A (3.3 : 1), and the theme can still be saved', async () => {
      const { page, updates } = await open()
      await page.click('Green')
      await page.fill('login-color-buttonBg', '#16A34A')
      assert.deepEqual(alerts(page, 'warning'), ['Hard to read for some people. Primary button text on the button: 3.3 : 1 (4.5 : 1 is recommended)'])
      assert.deepEqual(alerts(page, 'error'), [])
      await fillReason(page)
      answers = [async () => appearance({ ...preset('green'), buttonBg: '#16A34A' })]
      await page.submit()
      assert.equal(calls.length, 1)
      assert.equal(calls[0].body.loginTheme.colors.buttonBg, '#16A34A')
      assert.equal(updates.length, 1)
    })

    it('blocks colors that would make the page unreadable, explains the pair, and sends nothing', async () => {
      const { page } = await open()
      await page.click('Light')
      await page.fill('login-color-text', '#FFFFFF')
      const errors = alerts(page, 'error')
      assert.equal(errors.length, 2, 'main text on the page, and typed text on the fields')
      assert.match(errors[0], /^Cannot be saved\. Main text on the page background: 1\.0 : 1\. At least 3 : 1 is required to save, and 4\.5 : 1 is recommended$/)
      await fillReason(page)
      await page.submit()
      assert.match(alerts(page, 'error').join(' | '), /These colors cannot be saved because the sign-in page would be unreadable\. Main text on the page background: 1\.0 : 1/)
      assert.deepEqual(calls, [])
    })
  })

  describe('saving', () => {
    it('sends the nine normalized colors and the reason to the existing appearance endpoint, then reports it and hands the answer on', async () => {
      const { page, updates, parentKeeps } = await open()
      await page.click('Light')
      await page.fill('login-color-accent', '#7c3aed')
      await page.fill('login-color-inputBg', '#fff')
      await fillReason(page, `  ${REASON}  `)
      const saved = appearance({ ...preset('light'), accent: '#7C3AED' })
      answers = [async () => saved]
      await page.submit()
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, '/admin/settings/appearance')
      assert.equal(calls[0].method, 'PUT')
      assert.deepEqual(calls[0].body, { loginTheme: { colors: { ...preset('light'), accent: '#7C3AED', inputBg: '#FFFFFF' } }, reason: REASON })
      assert.deepEqual(updates, [[saved, 'Login page theme saved. All admins have been notified.']])
      parentKeeps(saved)
      assert.equal(page.valueOf('login-theme-reason'), '', 'the reason is cleared')
      assert.equal(hex(page, 'accent'), '#7C3AED', 'the fields show what the server stored')
      assert.ok(page.text().includes('Custom · updated'), 'and the section now says a theme is saved')
      assert.equal(page.hasButton('Discard changes'), false, 'nothing is pending any more')
      assert.deepEqual(alerts(page, 'error'), [])
    })

    it('disables the controls and shows "Saving…" while the request is in flight, so it cannot be sent twice', async () => {
      const { page } = await open()
      await page.click('Dark')
      await fillReason(page)
      let finish!: (v: unknown) => void
      answers = [() => new Promise((resolve) => (finish = resolve))]
      const submitting = page.submit()
      await page.settle()
      assert.equal(page.isDisabled('Saving…'), true)
      assert.equal(page.isDisabled('Dark'), true)
      assert.equal(field(page, 'login-color-pageBg')!.props.disabled, true)
      finish(appearance(preset('dark')))
      await submitting
      await page.settle()
      assert.equal(calls.length, 1)
      assert.equal(page.hasButton('Save login theme'), true)
    })

    it('shows the server\'s reason for a rejection, without the field prefix, and keeps what was chosen so it can be fixed', async () => {
      const { page, updates } = await open()
      await page.click('Light')
      await fillReason(page)
      answers = [async () => { throw new ApiError('Validation error', 422, undefined, ['loginTheme.colors.text: Main text on the page background is too hard to read (1.4 : 1).']) }]
      await page.submit()
      assert.deepEqual(alerts(page, 'error'), ['Main text on the page background is too hard to read (1.4 : 1).'])
      assert.deepEqual(updates, [])
      assert.equal(hex(page, 'pageBg'), preset('light').pageBg)
      assert.equal(page.valueOf('login-theme-reason'), REASON, 'the reason is kept for the retry')
    })

    it('shows "Save failed" for a network failure', async () => {
      const { page } = await open()
      await page.click('Light')
      await fillReason(page)
      answers = [async () => { throw new Error('network down') }]
      await page.submit()
      assert.deepEqual(alerts(page, 'error'), ['Save failed'])
    })
  })

  describe('with a saved theme', () => {
    it('shows its colors, who saved it, previews it, and highlights the matching preset', async () => {
      const { page } = await open({ data: appearance(preset('gray')) })
      assert.match(squash(page.text()), /Custom · updated .* by Ada Admin/)
      for (const key of KEYS) assert.equal(hex(page, key), preset('gray')[key], key)
      assert.deepEqual(previewVars(page), theme.loginThemeVars(preset('gray')))
      assert.equal(button(page, 'Gray')!.props['aria-pressed'], true)
      assert.equal(page.hasButton('Reset to default'), true)
      assert.equal(page.hasButton('Discard changes'), false, 'nothing changed yet')
    })

    it('"Discard changes" goes back to the saved colors', async () => {
      const { page } = await open({ data: appearance(preset('gray')) })
      await page.click('Green')
      assert.equal(hex(page, 'pageBg'), preset('green').pageBg)
      await page.click('Discard changes')
      assert.equal(hex(page, 'pageBg'), preset('gray').pageBg)
      assert.deepEqual(previewVars(page), theme.loginThemeVars(preset('gray')))
      assert.equal(page.hasButton('Discard changes'), false)
    })

    it('"Reset to default" asks first, needs a reason, then removes the theme (loginTheme: null) and returns to the built-in look', async () => {
      const { page, updates, parentKeeps } = await open({ data: appearance(preset('gray')) })
      await page.click('Reset to default')
      assert.deepEqual(alerts(page, 'error'), ['Give a reason for the change (at least 5 characters).'])
      assert.deepEqual(calls, [])

      await fillReason(page, 'Back to the original look')
      confirmAnswer = false
      await page.click('Reset to default')
      assert.equal(confirmed.length, 1)
      assert.match(confirmed[0], /Reset the login page colors to the built-in look\?/)
      assert.deepEqual(calls, [], 'declining the confirmation sends nothing')

      confirmAnswer = true
      const reset = appearance(null)
      answers = [async () => reset]
      await page.click('Reset to default')
      assert.deepEqual(calls.map((c) => [c.url, c.method, c.body]), [['/admin/settings/appearance', 'PUT', { loginTheme: null, reason: 'Back to the original look' }]])
      assert.deepEqual(updates, [[reset, 'Login page theme reset to the built-in colors. All admins have been notified.']])
      parentKeeps(reset)
      assert.equal(previewVars(page), undefined, 'the preview shows the built-in look again')
      assert.ok(page.text().includes('Using the built-in login colors'))
      assert.equal(page.hasButton('Reset to default'), false)
      assert.equal(field(page, 'login-color-pageBg'), undefined)
    })
  })

  describe('without settings:manage', () => {
    it('shows the saved theme and its preview, but no presets, reason, Save, Reset or Discard, and disabled fields', async () => {
      const { page } = await open({ data: appearance(preset('dark')), canManage: false })
      assert.deepEqual(previewVars(page), theme.loginThemeVars(preset('dark')))
      for (const label of ['Light', 'Dark', 'Gray', 'Green', 'Save login theme', 'Reset to default', 'Discard changes']) assert.equal(page.hasButton(label), false, label)
      assert.equal(field(page, 'login-theme-reason'), undefined)
      for (const key of KEYS) {
        assert.equal(field(page, `login-color-${key}`)!.props.disabled, true, key)
        assert.equal(field(page, `login-color-${key}-picker`)!.props.disabled, true, `${key} picker`)
      }
    })
  })
})

describe('Appearance page hosts the editor', () => {
  it('passes the data, permission and current login picture to it, and shows what it reports after a save', async () => {
    let received: Row | null = null
    const data = {
      defaultTheme: 'dark',
      welcomeText: { en: null, si: null },
      heroImage: null,
      logo: null,
      loginBranding: { heading: null, text: null, heroImage: { version: 'v1' }, theme: null },
      details: Object.fromEntries(['heroImage', 'logo', 'welcomeTextEn', 'welcomeTextSi', 'defaultTheme', 'loginImage', 'loginHeading', 'loginText', 'loginTheme'].map((k) => [k, { custom: false, updatedAt: null, updatedBy: null }])),
      limits: { imageTypes: ['image/png'], hero: {}, logo: {}, login: {}, welcomeTextMaxLength: 120, loginHeadingMaxLength: 80, loginTextMaxLength: 200 },
    }
    const page = mountPage(
      path.join(WEB, 'components/admin/AppearanceSettings.tsx'),
      {
        '@/lib/api': { ApiError, api: async () => structuredClone(data) },
        '@/lib/appearance': { refreshAppearance: async () => {}, useProtectedImage: (p: string | null) => (p ? { url: `blob:${p}`, status: 'ready' } : { url: null, status: 'none' }) },
        '@/lib/appearance-utils': utils,
        '@/lib/i18n': require('../../web/src/lib/i18n'),
        './LoginThemeSettings': { LoginThemeSettings: (props: Row) => ((received = props), jsx('div', { id: 'theme-slot', children: 'editor' })) },
      },
      { exportName: 'AppearanceSettings', props: { canManage: true } },
    )
    await page.settle()
    assert.ok(received, 'the editor is rendered inside the Login page section')
    assert.equal(received!.canManage, true)
    assert.equal(received!.imageUrl, `blob:${utils.LOGIN_IMAGE_PATH}`, 'the picture the login page uses')
    assert.equal(received!.data.loginBranding.heroImage.version, 'v1')

    const updated = { ...data, loginBranding: { ...data.loginBranding, theme: { colors: preset('green') } } }
    received!.onSaved(updated, 'Login page theme saved. All admins have been notified.')
    await page.settle()
    assert.ok(page.text().includes('Login page theme saved. All admins have been notified.'))
    assert.deepEqual(received!.data.loginBranding.theme, { colors: preset('green') }, 'the page now holds the saved answer')
  })

  it('the editor is mounted after the login heading and text form, inside the Login page section', () => {
    const source = read('components/admin/AppearanceSettings.tsx')
    assert.ok(source.indexOf('Save login page text') < source.indexOf('<LoginThemeSettings'))
    assert.ok(source.indexOf('<h2 style={{ marginTop: \'1.5rem\' }}>Login page</h2>') < source.indexOf('<LoginThemeSettings'))
  })
})
