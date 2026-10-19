import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { hooks, mountPage } from './helpers/render-page'
import { welcomeTextSchema } from '../src/modules/settings/appearance.schema'

/**
 * Portal appearance on the web side: the defaults every screen falls back to, the color-mode precedence (a person's own
 * choice always beats the admin default), the page-load theme script, and the hooks that load the settings and images.
 *
 * Real web files run in Node with fake browser pieces (localStorage, document, matchMedia) and scripted API stubs.
 * Database-free; nothing here reads `.env`, runs Prisma or opens a connection. There is no browser, so how the page
 * looks is not checked here.
 */

const WEB = path.resolve(__dirname, '../../web/src')
const utils = require('../../web/src/lib/appearance-utils')
const { themeScript } = require('../../web/src/lib/theme-script')
const { builtInText } = require('../../web/src/lib/i18n')

const settings = (over: Record<string, unknown> = {}) => ({ defaultTheme: 'dark', welcomeText: { en: null, si: null }, heroImage: null, logo: null, ...over })

describe('built-in defaults', () => {
  it('uses the built-in welcome heading, in the right language, until the admin saves a text for it', () => {
    const builtIn = (lang: 'en' | 'si') => builtInText(lang, 'dash.hero.welcome').replace('{name}', 'Nimal')
    assert.equal(utils.welcomeHeading('en', null, 'Nimal', builtIn('en')), 'Welcome back, Nimal!')
    assert.equal(utils.welcomeHeading('en', settings(), 'Nimal', builtIn('en')), 'Welcome back, Nimal!')
    assert.equal(utils.welcomeHeading('si', settings(), 'Nimal', builtIn('si')), 'නැවත සාදරයෙන් පිළිගනිමු, Nimal!')
    assert.equal(utils.welcomeHeading('en', settings({ welcomeText: { en: '', si: '' } }), 'Nimal', builtIn('en')), builtIn('en'), 'an empty value is not a custom text')
  })

  it('keeps English and Sinhala independent: a custom text never stands in for the other language', () => {
    const only = settings({ welcomeText: { en: 'Hello, {name}!', si: null } })
    assert.equal(utils.welcomeHeading('en', only, 'Nimal', 'BUILT-IN EN'), 'Hello, Nimal!')
    assert.equal(utils.welcomeHeading('si', only, 'Nimal', 'BUILT-IN SI'), 'BUILT-IN SI')
    const both = settings({ welcomeText: { en: 'Hello {name}', si: 'ආයුබෝවන් {name}' } })
    assert.equal(utils.welcomeHeading('si', both, 'Nimal', 'x'), 'ආයුබෝවන් Nimal')
  })

  it('puts the name in every {name} and keeps odd names literal', () => {
    assert.equal(utils.fillWelcomeName('{name}, {name}!', 'Kamal'), 'Kamal, Kamal!')
    assert.equal(utils.fillWelcomeName('Hi {name}', "$& $1 $' $$"), "Hi $& $1 $' $$")
    assert.equal(utils.fillWelcomeName('No placeholder', 'Kamal'), 'No placeholder')
  })

  it('the hero keeps the default gradient unless a custom image is ready', () => {
    assert.equal(utils.heroBackgroundVars({ url: null, status: 'none' }, false), undefined)
    assert.equal(utils.heroBackgroundVars({ url: null, status: 'failed' }, true), undefined, 'a failed download falls back to the default gradient')
    assert.deepEqual(utils.heroBackgroundVars({ url: 'blob:http://localhost:3000/abc-123', status: 'ready' }, true), { '--dash-hero-image': 'url("blob:http://localhost:3000/abc-123")' })
    assert.deepEqual(utils.heroBackgroundVars({ url: null, status: 'loading' }, true), { '--dash-hero-image': 'none' }, 'no flash of the default gradient before the custom one')
    assert.equal(utils.heroBackgroundVars({ url: null, status: 'loading' }, false), undefined)
    assert.equal(utils.heroBackgroundVars({ url: 'blob:x") , url("https://evil.example/x', status: 'ready' }, true), undefined, 'a URL that could break out of url() is never used')
  })

  it('the dashboard hero rules fall back to a neutral gradient per color mode, never to a picture (the page-wide rules are checked in hero-image-all-pages.test.ts)', () => {
    const css = fs.readFileSync(path.join(WEB, 'app/globals.css'), 'utf8').replace(/\r\n/g, '\n')
    const block = (selector: string) => css.slice(css.indexOf(selector), css.indexOf('}', css.indexOf(selector)))
    const dark = '.dash-hero-kpi-backdrop {'
    const light = ['.dash-hero-kpi-backdrop,', '.light-theme .dash-hero-kpi-backdrop {'].join(String.fromCharCode(10))
    assert.ok(block(dark).includes(`var(--dash-hero-image, ${utils.HERO_FALLBACK_DARK})`), 'dark mode')
    assert.ok(block(light).includes(`var(--dash-hero-image, ${utils.HERO_FALLBACK_LIGHT})`), 'light mode')
    assert.notEqual(utils.HERO_FALLBACK_DARK, utils.HERO_FALLBACK_LIGHT)
    for (const fallback of [utils.HERO_FALLBACK_DARK, utils.HERO_FALLBACK_LIGHT]) assert.ok(fallback.startsWith('linear-gradient(135deg, #') && !fallback.includes('url('), fallback)
  })
})

describe('welcome text rules match the server', () => {
  it('accepts and refuses the same texts as the API (empty means "reset" on the client and is handled before this check)', () => {
    const samples = [
      'Welcome back, {name}!', 'Hello', '{name}', 'නැවත සාදරයෙන් පිළිගනිමු, {name}!', 'Rs. $ for {name}', 'x'.repeat(120),
      'x'.repeat(121), 'Hi {user}', 'Hi {Name}', 'Hi {name', 'Hi name}', '{{name}}', '{}', 'two\nlines', 'tab\there', 'bell\u0007', '  padded {name}  ',
    ]
    for (const text of samples) {
      assert.equal(utils.validateWelcomeText(text) === null, welcomeTextSchema.safeParse(text).success, JSON.stringify(text))
    }
    assert.equal(utils.WELCOME_TEXT_MAX_LENGTH, 120)
  })
})

describe('upload pre-check', () => {
  const types = ['image/jpeg', 'image/png', 'image/webp']
  const limit = { maxBytes: 2 * 1024 * 1024 }
  const check = (name: string, size: number, type: string) => utils.checkImageChoice({ name, size, type }, limit, types)

  it('accepts JPG, PNG and WEBP up to the limit, by declared type or by extension', () => {
    assert.equal(check('a.png', 1000, 'image/png'), null)
    assert.equal(check('a.jpeg', 1000, 'image/jpeg'), null)
    assert.equal(check('a.webp', limit.maxBytes, 'image/webp'), null)
    assert.equal(check('a.PNG', 1000, ''), null)
    assert.equal(check('photo.jpg', 1000, 'application/octet-stream'), null)
  })

  it('refuses other types, empty files and oversized files with a plain message', () => {
    for (const [name, type] of [['a.gif', 'image/gif'], ['a.svg', 'image/svg+xml'], ['a.pdf', 'application/pdf'], ['a', ''], ['a.exe', 'application/x-msdownload']]) {
      assert.equal(check(name, 1000, type), 'Choose a JPG, PNG or WEBP image.', name)
    }
    assert.equal(check('a.png', 0, 'image/png'), 'That file is empty.')
    assert.equal(check('a.png', limit.maxBytes + 1, 'image/png'), 'The image must be 2 MB or smaller (this one is 2 MB).')
    assert.equal(check('a.png', 5 * 1024 * 1024, 'image/png'), 'The image must be 2 MB or smaller (this one is 5 MB).')
  })
})

describe('color mode precedence', () => {
  it('the personal choice beats the admin default, which beats dark', () => {
    assert.equal(utils.resolveThemeMode(null, null), 'dark')
    assert.equal(utils.resolveThemeMode(undefined, undefined), 'dark')
    assert.equal(utils.resolveThemeMode(null, 'light'), 'light')
    assert.equal(utils.resolveThemeMode(null, 'system'), 'system')
    assert.equal(utils.resolveThemeMode('dark', 'light'), 'dark')
    assert.equal(utils.resolveThemeMode('light', 'dark'), 'light')
    assert.equal(utils.resolveThemeMode('system', 'light'), 'system')
    assert.equal(utils.resolveThemeMode('purple', 'light'), 'light', 'junk is ignored')
    assert.equal(utils.resolveThemeMode('purple', 'green'), 'dark')
  })

  describe('page-load script (runs before the first paint)', () => {
    const run = (env: { stored?: Record<string, string>; osLight?: boolean; storageBlocked?: boolean }) => {
      const attrs: Record<string, string> = {}
      const classes = new Set<string>()
      const localStorage = {
        getItem: (key: string) => {
          if (env.storageBlocked) throw new Error('storage blocked')
          return env.stored?.[key] ?? null
        },
      }
      const document = { documentElement: { setAttribute: (k: string, v: string) => void (attrs[k] = v), classList: { add: (c: string) => void classes.add(c) } } }
      const window = { matchMedia: (query: string) => ({ matches: query.includes('light') ? Boolean(env.osLight) : false }) }
      new Function('localStorage', 'document', 'window', themeScript)(localStorage, document, window)
      return { theme: attrs['data-theme'], classes: [...classes], attrs }
    }
    const OWN = 'hexalyte-theme-preference'
    const DEFAULT = 'hexalyte-theme-default'

    it('is dark when nothing is stored, exactly as before the admin setting existed', () => {
      const r = run({})
      assert.equal(r.theme, 'dark')
      assert.deepEqual(r.classes, ['dark-theme'])
    })

    it('follows the admin default when the person has not chosen', () => {
      assert.equal(run({ stored: { [DEFAULT]: 'light' } }).theme, 'light')
      assert.equal(run({ stored: { [DEFAULT]: 'dark' } }).theme, 'dark')
      assert.equal(run({ stored: { [DEFAULT]: 'system' }, osLight: true }).theme, 'light')
      assert.equal(run({ stored: { [DEFAULT]: 'system' }, osLight: false }).theme, 'dark')
    })

    it('keeps the personal choice whatever the admin default is', () => {
      assert.equal(run({ stored: { [OWN]: 'dark', [DEFAULT]: 'light' } }).theme, 'dark')
      assert.equal(run({ stored: { [OWN]: 'light', [DEFAULT]: 'dark' } }).theme, 'light')
      assert.equal(run({ stored: { [OWN]: 'system', [DEFAULT]: 'dark' }, osLight: true }).theme, 'light')
      assert.equal(run({ stored: { [OWN]: 'system', [DEFAULT]: 'light' }, osLight: false }).theme, 'dark')
    })

    it('ignores values it does not know', () => {
      assert.equal(run({ stored: { [OWN]: 'purple', [DEFAULT]: 'light' } }).theme, 'light')
      assert.equal(run({ stored: { [OWN]: 'purple', [DEFAULT]: 'green' } }).theme, 'dark')
    })

    it('does nothing (and does not throw) when storage is blocked, leaving the stylesheet default', () => {
      assert.deepEqual(run({ storageBlocked: true }).attrs, {})
    })

    it('still sets the language', () => {
      assert.equal(run({ stored: { 'hexalyte-language-preference': 'si' } }).attrs.lang, 'si')
      assert.equal(run({}).attrs.lang, 'en')
    })
  })

  describe('ThemeProvider', () => {
    const OWN = 'hexalyte-theme-preference'
    const DEFAULT = 'hexalyte-theme-default'
    let store: Map<string, string>
    let blocked: boolean
    let osDark: boolean
    let root: { attrs: Record<string, string>; classList: { add(c: string): void; remove(c: string): void } }
    let ctx: { theme: string; resolvedTheme: string; setTheme(t: string): void; setDefaultTheme(t: string): void }

    const mount = async () => {
      let provided: any
      const react = {
        ...hooks,
        createContext: (initial: unknown) => ({ Provider: ({ value, children }: { value: unknown; children: unknown }) => ((provided = value), children), initial }),
        useContext: (c: { initial: unknown }) => provided ?? c.initial,
      }
      const page = mountPage(path.join(WEB, 'lib/theme.tsx'), { react, './appearance-utils': utils }, { exportName: 'ThemeProvider', props: { children: null } })
      await page.settle()
      const get = () => provided as typeof ctx
      return { page, ctx: get }
    }

    beforeEach(() => {
      store = new Map()
      blocked = false
      osDark = true
      const classes = new Set<string>()
      root = { attrs: {}, classList: { add: (c) => void classes.add(c), remove: (c) => void classes.delete(c) } }
      Object.assign(root, { setAttribute: (k: string, v: string) => void (root.attrs[k] = v) })
      Object.assign(globalThis, {
        window: { matchMedia: () => ({ get matches() { return osDark }, addEventListener() {}, removeEventListener() {} }) },
        document: { documentElement: root },
        localStorage: {
          getItem: (k: string) => {
            if (blocked) throw new Error('blocked')
            return store.get(k) ?? null
          },
          setItem: (k: string, v: string) => {
            if (blocked) throw new Error('blocked')
            store.set(k, v)
          },
        },
      })
    })

    it('starts dark when nobody has chosen anything', async () => {
      const { ctx: c } = await mount()
      assert.equal(c().theme, 'dark')
      assert.equal(root.attrs['data-theme'], 'dark')
    })

    it('uses the admin default for someone who has not chosen, remembers it separately, and never stores it as their choice', async () => {
      const { page, ctx: c } = await mount()
      c().setDefaultTheme('light')
      await page.settle()
      assert.equal(c().theme, 'light')
      assert.equal(root.attrs['data-theme'], 'light')
      assert.equal(store.get(DEFAULT), 'light')
      assert.equal(store.has(OWN), false, 'a default is not a personal choice')
      c().setDefaultTheme('system')
      await page.settle()
      assert.equal(c().theme, 'system')
      assert.equal(c().resolvedTheme, 'dark', 'system follows the device')
      osDark = false
      c().setDefaultTheme('system')
      c().setDefaultTheme('light')
      await page.settle()
      assert.equal(c().theme, 'light')
    })

    it('opens in the last admin default seen on this browser', async () => {
      store.set(DEFAULT, 'light')
      const { ctx: c } = await mount()
      assert.equal(c().theme, 'light')
      assert.equal(root.attrs['data-theme'], 'light')
    })

    it('keeps a stored personal choice when the admin default is applied or changes', async () => {
      store.set(OWN, 'dark')
      store.set(DEFAULT, 'light')
      const { page, ctx: c } = await mount()
      assert.equal(c().theme, 'dark')
      c().setDefaultTheme('light')
      c().setDefaultTheme('system')
      await page.settle()
      assert.equal(c().theme, 'dark')
      assert.equal(root.attrs['data-theme'], 'dark')
      assert.equal(store.get(OWN), 'dark')
      assert.equal(store.get(DEFAULT), 'system', 'the default is still tracked')
    })

    it('a choice made with the theme switch is stored and from then on beats the admin default', async () => {
      const { page, ctx: c } = await mount()
      c().setDefaultTheme('light')
      c().setTheme('system')
      await page.settle()
      assert.equal(store.get(OWN), 'system')
      c().setDefaultTheme('dark')
      await page.settle()
      assert.equal(c().theme, 'system')
    })

    it('still honours a choice that could not be stored (storage blocked)', async () => {
      blocked = true
      const { page, ctx: c } = await mount()
      c().setTheme('light')
      await page.settle()
      assert.equal(c().theme, 'light')
      c().setDefaultTheme('dark')
      await page.settle()
      assert.equal(c().theme, 'light', 'the in-memory choice is not overwritten')
    })
  })
})

describe('loading the settings and images', () => {
  const load = (file: string, stubs: Record<string, unknown>) => {
    const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    })
    const mod: { exports: any } = { exports: {} }
    new Function('require', 'module', 'exports', outputText)((name: string) => {
      if (!(name in stubs)) throw new Error(`${file} imports "${name}", which this test did not stub`)
      return stubs[name]
    }, mod, mod.exports)
    return mod.exports
  }

  let apiCalls: string[]
  let blobCalls: string[]
  let apiAnswers: Array<() => Promise<unknown>>
  let blobAnswers: Array<() => Promise<Blob>>
  let defaultThemeCalls: string[]
  const deferred = <T>() => {
    let resolve!: (v: T) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
    return { promise, resolve, reject }
  }

  /** Fresh module state (settings cache, image cache) for every test, as for every full page load. */
  const open = async () => {
    const appearance = load(path.join(WEB, 'lib/appearance.ts'), {
      react: hooks,
      './api': {
        api: async (p: string) => (apiCalls.push(p), (apiAnswers.shift() ?? (() => Promise.reject(new Error('no scripted answer'))))()),
        apiBlob: async (p: string) => (blobCalls.push(p), (blobAnswers.shift() ?? (() => Promise.reject(new Error('no scripted answer'))))()),
      },
      './theme': { useTheme: () => ({ setDefaultTheme: (t: string) => void defaultThemeCalls.push(t) }) },
    })
    const mountProbe = async () => {
      const page = mountPage(path.resolve(__dirname, 'helpers/appearance-probe.tsx'), { '@/lib/appearance': appearance }, { exportName: 'Probe' })
      await page.settle()
      return page
    }
    return { appearance, mountProbe }
  }
  const seen = (page: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['mountProbe']>>) => ({
    appearance: JSON.parse(page.valueOf('appearance')),
    hero: JSON.parse(page.valueOf('hero')),
  })
  const png = () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' })

  beforeEach(() => {
    apiCalls = []
    blobCalls = []
    apiAnswers = []
    blobAnswers = []
    defaultThemeCalls = []
  })

  it('shows nothing custom (the built-in look) until the settings arrive, then applies them and the admin default color mode', async () => {
    const pending = deferred<unknown>()
    apiAnswers = [() => pending.promise]
    const { mountProbe } = await open()
    const page = await mountProbe()
    assert.deepEqual(seen(page), { appearance: null, hero: { url: null, status: 'none' } })
    assert.deepEqual(defaultThemeCalls, [])

    pending.resolve(settings({ defaultTheme: 'light', welcomeText: { en: 'Hi {name}', si: null } }))
    await page.settle()
    assert.deepEqual(seen(page).appearance, settings({ defaultTheme: 'light', welcomeText: { en: 'Hi {name}', si: null } }))
    assert.deepEqual(apiCalls, ['/appearance'])
    assert.deepEqual(defaultThemeCalls, ['light'])
  })

  it('keeps the built-in look when the settings cannot be loaded, and tries again on the next page', async () => {
    apiAnswers = [() => Promise.reject(new Error('network down')), async () => settings({ defaultTheme: 'system' })]
    const { mountProbe } = await open()
    const first = await mountProbe()
    assert.equal(seen(first).appearance, null)
    assert.deepEqual(defaultThemeCalls, [], 'no default color mode is applied from a failed load')
    first.unmount()

    const second = await mountProbe()
    assert.equal(apiCalls.length, 2)
    assert.equal(seen(second).appearance.defaultTheme, 'system')
    assert.deepEqual(defaultThemeCalls, ['system'])
  })

  it('shares one answer between components and pages instead of asking again each time', async () => {
    apiAnswers = [async () => settings()]
    const { mountProbe } = await open()
    const a = await mountProbe()
    const b = await mountProbe()
    assert.equal(apiCalls.length, 1)
    assert.deepEqual(seen(a).appearance, settings())
    assert.deepEqual(seen(b).appearance, settings())
  })

  it('loads the custom hero image with the user\'s token, once, and reuses it across components', async () => {
    apiAnswers = [async () => settings({ heroImage: { version: 'v1' } })]
    const gate = deferred<Blob>()
    blobAnswers = [() => gate.promise]
    const { mountProbe } = await open()
    const a = await mountProbe()
    assert.deepEqual(seen(a).hero, { url: null, status: 'loading' })
    gate.resolve(png())
    await a.settle()
    const ready = seen(a).hero
    assert.equal(ready.status, 'ready')
    assert.match(ready.url, /^blob:/)

    const b = await mountProbe()
    assert.deepEqual(seen(b).hero, ready, 'the second component gets the same image straight away')
    assert.deepEqual(blobCalls, ['/appearance/hero-image'], 'downloaded once')
  })

  it('falls back to the built-in image when the custom one cannot be downloaded, and retries on the next page', async () => {
    apiAnswers = [async () => settings({ heroImage: { version: 'v1' } })]
    blobAnswers = [() => Promise.reject(new Error('404')), async () => png()]
    const { mountProbe } = await open()
    const first = await mountProbe()
    assert.deepEqual(seen(first).hero, { url: null, status: 'failed' })
    first.unmount()
    const second = await mountProbe()
    assert.equal(seen(second).hero.status, 'ready')
    assert.equal(blobCalls.length, 2)
  })

  it('downloads the image again when it has been replaced (new version)', async () => {
    apiAnswers = [async () => settings({ heroImage: { version: 'v1' } }), async () => settings({ heroImage: { version: 'v2' } })]
    blobAnswers = [async () => png(), async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })]
    const { appearance, mountProbe } = await open()
    const page = await mountProbe()
    const v1 = seen(page).hero.url
    await appearance.refreshAppearance()
    await page.settle()
    const v2 = seen(page).hero
    assert.equal(v2.status, 'ready')
    assert.notEqual(v2.url, v1)
    assert.equal(blobCalls.length, 2)
  })

  it('shows no custom image after the admin resets it', async () => {
    apiAnswers = [async () => settings({ heroImage: { version: 'v1' } }), async () => settings()]
    blobAnswers = [async () => png()]
    const { appearance, mountProbe } = await open()
    const page = await mountProbe()
    assert.equal(seen(page).hero.status, 'ready')
    await appearance.refreshAppearance()
    await page.settle()
    assert.deepEqual(seen(page).hero, { url: null, status: 'none' })
  })
})
