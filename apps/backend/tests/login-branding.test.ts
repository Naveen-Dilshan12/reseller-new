import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { hooks, jsx, mountPage } from './helpers/render-page'
import { LOGIN_HEADING_MAX_LENGTH, LOGIN_TEXT_MAX_LENGTH, loginHeadingSchema, loginTextSchema } from '../src/modules/settings/appearance.schema'

/**
 * Login-page branding on the web side: the built-in defaults, the Admin's heading / supporting text / hero image, the
 * public (logged-out) loading hook, and the shared auth layout that draws them. Also checks that the district picker,
 * the random-district button and the weather widget are gone while the split-screen layout, the responsive rules and
 * the authentication pages that use the layout are untouched.
 *
 * Real web files run in Node with scripted stubs (API, images, the hooks around them). Database-free; nothing here
 * reads `.env`, runs Prisma or opens a connection. There is no browser, so how the page looks is not checked here.
 */

const WEB = path.resolve(__dirname, '../../web/src')
const utils = require('../../web/src/lib/appearance-utils')
const loginTheme = require('../../web/src/lib/login-theme')
const read = (file: string) => fs.readFileSync(path.join(WEB, file), 'utf8').replace(/\r\n/g, '\n')

const BRANDING = (over: Record<string, unknown> = {}) => ({ heading: null, text: null, heroImage: null, theme: null, ...over })

describe('built-in defaults', () => {
  it('are exactly what the login page showed before the Admin could change it (text), with a plain gradient instead of a picture', () => {
    assert.equal(utils.BUILT_IN_LOGIN_HEADING, 'Empowering Businesses Across Sri Lanka')
    assert.equal(utils.BUILT_IN_LOGIN_TEXT, '“Simple Solutions for a Stronger Tomorrow”')
    assert.equal(utils.BUILT_IN_LOGIN_TAGLINE, '“Built for a Better Sri Lanka.”')
    assert.ok(utils.LOGIN_FALLBACK_GRADIENT.startsWith('linear-gradient(') && !utils.LOGIN_FALLBACK_GRADIENT.includes('url('), 'the default panel is a gradient')
    assert.equal(utils.LOGIN_BACKGROUND_LABEL, 'Hexalyte Innovation login background')
    assert.equal('BUILT_IN_LOGIN_IMAGE' in utils, false, 'no built-in picture ships with the app')
  })

  it('are used until the Admin saves a value, for the heading and the supporting lines separately', () => {
    for (const none of [null, BRANDING(), BRANDING({ heading: '', text: '' })]) {
      assert.equal(utils.loginHeading(none), utils.BUILT_IN_LOGIN_HEADING)
      assert.deepEqual(utils.loginSupportingLines(none), { text: utils.BUILT_IN_LOGIN_TEXT, tagline: utils.BUILT_IN_LOGIN_TAGLINE })
    }
    assert.equal(utils.loginHeading(BRANDING({ heading: 'Welcome to Acme' })), 'Welcome to Acme')
    assert.deepEqual(utils.loginSupportingLines(BRANDING({ heading: 'Welcome to Acme' })), { text: utils.BUILT_IN_LOGIN_TEXT, tagline: utils.BUILT_IN_LOGIN_TAGLINE })
    assert.equal(utils.loginHeading(BRANDING({ text: 'Run your shop with us.' })), utils.BUILT_IN_LOGIN_HEADING)
  })

  it('a custom supporting text replaces both built-in lines, so the old tagline does not linger under it', () => {
    assert.deepEqual(utils.loginSupportingLines(BRANDING({ text: 'Run your shop with us.' })), { text: 'Run your shop with us.' })
  })
})

describe('rules match the server', () => {
  it('accept and refuse the same login texts as the API', () => {
    const samples = ['Welcome to Acme', 'Acme {Shop} & Co.', 'සාදරයෙන් පිළිගනිමු', 'x'.repeat(80), 'x'.repeat(81), 'x'.repeat(200), 'x'.repeat(201), 'two\nlines', 'tab\there', 'bell\u0007', '  padded  ']
    for (const text of samples) {
      assert.equal(utils.validateLoginText(text, utils.LOGIN_HEADING_MAX_LENGTH) === null, loginHeadingSchema.safeParse(text).success, `heading ${JSON.stringify(text)}`)
      assert.equal(utils.validateLoginText(text, utils.LOGIN_TEXT_MAX_LENGTH) === null, loginTextSchema.safeParse(text).success, `text ${JSON.stringify(text)}`)
    }
    assert.deepEqual([utils.LOGIN_HEADING_MAX_LENGTH, utils.LOGIN_TEXT_MAX_LENGTH], [LOGIN_HEADING_MAX_LENGTH, LOGIN_TEXT_MAX_LENGTH])
  })

  it('fetch the public image from the route the API mounts for logged-out visitors', () => {
    assert.equal(utils.LOGIN_IMAGE_PATH, '/public/login-branding/hero-image')
  })
})

describe('cssUrl', () => {
  it('wraps a safe address and refuses one that could break out of url()', () => {
    assert.equal(utils.cssUrl('blob:http://localhost:3000/abc-123'), 'url("blob:http://localhost:3000/abc-123")')
    for (const bad of ['blob:x") , url("https://evil.example/x', "a'b", 'a)b', 'a\\b', 'a b']) assert.equal(utils.cssUrl(bad), null, bad)
  })
})

/** Runs a real web module with its imports replaced by stubs (fresh module state each time, as for a full page load). */
function loadModule(file: string, stubs: Record<string, unknown>) {
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

describe('loading the branding for a logged-out visitor', () => {
  let calls: Array<{ path: string; signal: unknown }>
  let answers: Array<() => Promise<unknown>>
  const realNow = Date.now

  const open = () => {
    const hook = loadModule(path.join(WEB, 'lib/login-branding.ts'), {
      react: hooks,
      './api': {
        api: async (p: string, init?: { signal?: unknown }) => (calls.push({ path: p, signal: init?.signal }), (answers.shift() ?? (() => Promise.reject(new Error('no scripted answer'))))()),
      },
    })
    return async () => {
      const page = mountPage(path.resolve(__dirname, 'helpers/login-branding-probe.tsx'), { '@/lib/login-branding': hook }, { exportName: 'Probe' })
      await page.settle()
      return page
    }
  }
  const seen = (page: Awaited<ReturnType<ReturnType<typeof open>>>) => JSON.parse(page.valueOf('state'))

  beforeEach(() => {
    calls = []
    answers = []
  })
  afterEach(() => {
    Date.now = realNow
  })

  it('asks the public endpoint (no sign-in), with a time limit, and is "loading" until it answers', async () => {
    let answer!: (v: unknown) => void
    answers = [() => new Promise((resolve) => (answer = resolve))]
    const mount = open()
    const page = await mount()
    assert.deepEqual(seen(page), { branding: null, status: 'loading' })
    answer(BRANDING({ heading: 'Welcome to Acme' }))
    await page.settle()
    assert.deepEqual(seen(page), { branding: BRANDING({ heading: 'Welcome to Acme' }), status: 'ready' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].path, '/public/login-branding')
    assert.ok(calls[0].signal instanceof AbortSignal, 'a slow server cannot hold the page back forever')
  })

  it('reports "failed" with no branding (the page then shows its built-in look), and tries again on the next page', async () => {
    answers = [() => Promise.reject(new Error('network down')), async () => BRANDING({ text: 'Run your shop with us.' })]
    const mount = open()
    const first = await mount()
    assert.deepEqual(seen(first), { branding: null, status: 'failed' })
    first.unmount()
    const second = await mount()
    assert.equal(calls.length, 2)
    assert.equal(seen(second).branding.text, 'Run your shop with us.')
  })

  it('shares one answer between the auth pages for a minute: moving from sign-in to registration does not refetch or flash', async () => {
    answers = [async () => BRANDING({ heading: 'Welcome to Acme' })]
    const mount = open()
    const first = await mount()
    first.unmount()
    const second = await mount()
    assert.deepEqual(seen(second), { branding: BRANDING({ heading: 'Welcome to Acme' }), status: 'ready' }, 'ready on the very first paint')
    assert.equal(calls.length, 1)
  })

  it('asks again after a minute, showing the earlier answer meanwhile, and keeps it if the refresh fails', async () => {
    answers = [async () => BRANDING({ heading: 'Old heading' }), async () => BRANDING({ heading: 'New heading' }), () => Promise.reject(new Error('down'))]
    const mount = open()
    ;(await mount()).unmount()

    const start = realNow()
    Date.now = () => start + 61_000
    const refreshed = await mount()
    assert.equal(calls.length, 2)
    assert.equal(seen(refreshed).branding.heading, 'New heading')
    refreshed.unmount()

    Date.now = () => start + 200_000
    const failedRefresh = await mount()
    assert.equal(calls.length, 3)
    assert.deepEqual(seen(failedRefresh), { branding: BRANDING({ heading: 'New heading' }), status: 'ready' })
  })
})

describe('AuthLayout', () => {
  type ImageStub = { src: string; onload?: () => void; onerror?: () => void }
  let images: ImageStub[]
  let fetched: unknown[]
  /** The viewport as the browser reports it: `narrow` = the "(max-width: 1024px)" query matches (panel hidden). */
  let viewport: { narrow: boolean; listeners: Set<() => void>; queries: string[]; answersQueries: boolean }
  const realImage = (globalThis as any).Image
  const realWindow = (globalThis as any).window
  const realFetch = globalThis.fetch

  beforeEach(() => {
    images = []
    fetched = []
    viewport = { narrow: false, listeners: new Set(), queries: [], answersQueries: true }
    ;(globalThis as any).window = {
      get matchMedia() {
        return viewport.answersQueries
          ? (query: string) => (
              viewport.queries.push(query),
              {
                get matches() {
                  return viewport.narrow
                },
                addEventListener: (_: string, fn: () => void) => viewport.listeners.add(fn),
                removeEventListener: (_: string, fn: () => void) => viewport.listeners.delete(fn),
              }
            )
          : undefined
      },
    }
    ;(globalThis as any).Image = class {
      onload?: () => void
      onerror?: () => void
      set src(value: string) {
        images.push({ src: value, onload: () => this.onload?.(), onerror: () => this.onerror?.() })
      }
    }
    globalThis.fetch = (async (...args: unknown[]) => void fetched.push(args)) as typeof fetch
  })
  afterEach(() => {
    ;(globalThis as any).Image = realImage
    if (realWindow === undefined) delete (globalThis as any).window
    else (globalThis as any).window = realWindow
    globalThis.fetch = realFetch
  })

  const FORM = jsx('form', { id: 'the-form', children: jsx('button', { children: 'Sign in' }) })
  const mount = async (
    state: { branding: unknown; status: 'loading' | 'ready' | 'failed' },
    image: { url: string | null; status: string } = { url: null, status: 'none' },
    ariaLabel = 'Sign In Form',
  ) => {
    const requested: Array<[string | null, string | undefined]> = []
    const page = mountPage(
      path.join(WEB, 'components/auth/AuthLayout.tsx'),
      {
        // Like the real hook: with no path there is nothing to fetch and nothing to show.
        '@/lib/appearance': { useProtectedImage: (p: string | null, version?: string) => (requested.push([p, version]), p ? image : { url: null, status: 'none' }) },
        '@/lib/appearance-utils': utils,
        '@/lib/login-theme': loginTheme,
        '@/lib/login-branding': { useLoginBranding: () => state },
        '@/app/login/login.css': {},
      },
      { exportName: 'AuthLayout', props: { ariaLabel, children: FORM } },
    )
    await page.settle()
    return { page, requested }
  }
  const all = (node: any, out: any[] = []): any[] => {
    if (!node || typeof node !== 'object') return out
    if (Array.isArray(node)) return node.forEach((n) => all(n, out)), out
    out.push(node)
    all(node.props?.children, out)
    return out
  }
  const byClass = (page: Awaited<ReturnType<typeof mount>>['page'], name: string) => all(page.root()).find((el) => typeof el.props?.className === 'string' && el.props.className.split(' ').includes(name))
  const background = (page: Awaited<ReturnType<typeof mount>>['page']) => all(page.root()).find((el) => String(el.props?.className ?? '').startsWith('login-left-bg'))
  const hero = (page: Awaited<ReturnType<typeof mount>>['page']) => byClass(page, 'login-left-hero')
  const heroText = (page: Awaited<ReturnType<typeof mount>>['page']) => all(hero(page)).filter((el) => ['h2', 'p'].includes(el.type)).map((el) => String(el.props.children))
  const NONE = { branding: BRANDING(), status: 'ready' as const }

  it('shows the built-in heading, both built-in lines and the default gradient (no picture) when nothing is customized', async () => {
    const { page, requested } = await mount(NONE)
    assert.deepEqual(heroText(page), [utils.BUILT_IN_LOGIN_HEADING, utils.BUILT_IN_LOGIN_TEXT, utils.BUILT_IN_LOGIN_TAGLINE])
    assert.equal(hero(page).props.className, 'login-left-hero', 'not hidden')
    assert.equal(page.root().props.className, 'login-split', 'the default colour scheme, no weather theme')
    assert.equal(requested.at(-1)?.[0], null, 'no custom image is requested')
    assert.deepEqual(images, [], 'nothing is downloaded for the default look')
    assert.equal(background(page).props.className, 'login-left-bg loaded', 'the gradient is ready at once')
    assert.equal(background(page).props.style.backgroundImage, utils.LOGIN_FALLBACK_GRADIENT)
    assert.equal(background(page).props['aria-label'], utils.LOGIN_BACKGROUND_LABEL)
  })

  it('shows the Admin\'s heading and supporting text, and the supporting text replaces both built-in lines', async () => {
    const { page } = await mount({ branding: BRANDING({ heading: 'Welcome to Acme', text: 'Run your shop with us.' }), status: 'ready' })
    assert.deepEqual(heroText(page), ['Welcome to Acme', 'Run your shop with us.'])
    assert.ok(!page.text().includes('Built for a Better Sri Lanka'))
    // Either one alone: the other keeps its built-in text.
    assert.deepEqual(heroText((await mount({ branding: BRANDING({ heading: 'Welcome to Acme' }), status: 'ready' })).page), ['Welcome to Acme', utils.BUILT_IN_LOGIN_TEXT, utils.BUILT_IN_LOGIN_TAGLINE])
    assert.deepEqual(heroText((await mount({ branding: BRANDING({ text: 'Run your shop with us.' }), status: 'ready' })).page), [utils.BUILT_IN_LOGIN_HEADING, 'Run your shop with us.'])
  })

  it('shows the Admin\'s hero image, fetched by its version from the public login endpoint, instead of the built-in one', async () => {
    const { page, requested } = await mount({ branding: BRANDING({ heroImage: { version: 'v7' } }), status: 'ready' }, { url: 'blob:http://localhost:3000/login-v7', status: 'ready' })
    assert.deepEqual(requested.at(-1), ['/public/login-branding/hero-image', 'v7'])
    assert.deepEqual(images.map((i) => i.src), ['blob:http://localhost:3000/login-v7'])
    images[0].onload!()
    await page.settle()
    assert.equal(background(page).props.style.backgroundImage, 'url("blob:http://localhost:3000/login-v7")')
    assert.equal(background(page).props.className, 'login-left-bg loaded')
  })

  it('paints nothing until it knows whether a custom picture exists, so the built-in one never flashes first', async () => {
    const stillLoading = await mount({ branding: null, status: 'loading' })
    assert.equal(images.length, 0, 'no picture is requested yet')
    assert.equal(background(stillLoading.page).props.className, 'login-left-bg loading')
    assert.equal(hero(stillLoading.page).props.className, 'login-left-hero pending', 'the text waits too')

    const downloading = await mount({ branding: BRANDING({ heroImage: { version: 'v1' } }), status: 'ready' }, { url: null, status: 'loading' })
    assert.equal(images.length, 0, 'the custom picture is still downloading')
    assert.equal(background(downloading.page).props.className, 'login-left-bg loading')
    assert.equal(hero(downloading.page).props.className, 'login-left-hero', 'the text is already known')
  })

  it('falls back to the default gradient when the custom picture cannot be downloaded', async () => {
    const { page } = await mount({ branding: BRANDING({ heroImage: { version: 'v1' } }), status: 'ready' }, { url: null, status: 'failed' })
    assert.deepEqual(images, [], 'no picture is loaded')
    assert.equal(background(page).props.className, 'login-left-bg loaded')
    assert.equal(background(page).props.style.backgroundImage, utils.LOGIN_FALLBACK_GRADIENT)
  })

  it('shows the built-in look, with the text visible, when the branding cannot be loaded', async () => {
    const { page } = await mount({ branding: null, status: 'failed' })
    assert.deepEqual(heroText(page), [utils.BUILT_IN_LOGIN_HEADING, utils.BUILT_IN_LOGIN_TEXT, utils.BUILT_IN_LOGIN_TAGLINE])
    assert.equal(hero(page).props.className, 'login-left-hero')
    assert.deepEqual(images, [], 'nothing is downloaded')
    assert.equal(background(page).props.style.backgroundImage, utils.LOGIN_FALLBACK_GRADIENT)
  })

  it('shows the dark gradient, never a broken picture, if the picture cannot be loaded or has an unsafe address', async () => {
    const broken = await mount({ branding: BRANDING({ heroImage: { version: 'v1' } }), status: 'ready' }, { url: 'blob:http://localhost:3000/login-v1', status: 'ready' })
    assert.equal(images.length, 1, 'the custom picture is being loaded')
    images[0].onerror!()
    await broken.page.settle()
    assert.equal(background(broken.page).props.style.backgroundImage, utils.LOGIN_FALLBACK_GRADIENT)
    assert.equal(background(broken.page).props.className, 'login-left-bg loaded')

    const unsafe = await mount({ branding: BRANDING({ heroImage: { version: 'v1' } }), status: 'ready' }, { url: 'blob:x") , url("https://evil.example/x', status: 'ready' })
    images.at(-1)!.onload!()
    await unsafe.page.settle()
    assert.equal(background(unsafe.page).props.style.backgroundImage, utils.LOGIN_FALLBACK_GRADIENT)
  })

  it('has no district selector or label, no random-district button and no weather widget, and asks no weather service', async () => {
    const { page } = await mount(NONE)
    await page.settle()
    assert.deepEqual(page.buttonLabels(), ['Sign in'], 'the only button is the page\'s own')
    assert.ok(!/district|weather|atmosphere|random|°C|live\)/i.test(page.text()), page.text())
    const classes = all(page.root()).map((el) => String(el.props?.className ?? '')).join(' ')
    assert.ok(!/district|weather|location|greeting|theme-/.test(classes), classes)
    assert.deepEqual(fetched, [], 'no request leaves the layout (branding comes from the hook)')
  })

  it('keeps the split-screen layout and the page\'s own form, with its label, on the right', async () => {
    const { page } = await mount(NONE, undefined, 'Register Account')
    const sections = all(page.root()).filter((el) => el.type === 'section')
    assert.deepEqual(sections.map((s) => s.props.className), ['login-left', 'login-right'])
    assert.equal(sections[1].props['aria-label'], 'Register Account')
    assert.ok(all(sections[1]).some((el) => el.props?.id === 'the-form'), 'the page\'s form is rendered unchanged')
    assert.equal(page.text().split('Hexalyte Innovation').length - 1, 2, 'desktop and mobile brand rows')
    assert.ok(page.text().includes('Central Partner Platform'))
  })

  describe('hero picture and the 1024px breakpoint (the panel is hidden at 1024px and below)', () => {
    const CUSTOM_STATE = { branding: BRANDING({ heroImage: { version: 'v1' } }), status: 'ready' as const }
    const READY = { url: 'blob:http://localhost:3000/login-v1', status: 'ready' }
    const resize = async (page: { settle(): Promise<void> }, narrow: boolean) => {
      viewport.narrow = narrow
      for (const listener of [...viewport.listeners]) listener()
      await page.settle()
    }

    it('downloads nothing at or below the breakpoint: no picture request and no custom-image fetch, built-in or custom', async () => {
      viewport.narrow = true
      const custom = await mount(CUSTOM_STATE, READY)
      const builtIn = await mount(NONE)
      assert.deepEqual(images, [], 'no <img> preload at all')
      assert.ok(custom.requested.every(([p]) => p === null), `the custom picture was requested: ${JSON.stringify(custom.requested)}`)
      assert.ok(builtIn.requested.every(([p]) => p === null))
      assert.equal(background(custom.page).props.className, 'login-left-bg loading')
      assert.equal(background(custom.page).props.style.backgroundImage, utils.LOGIN_FALLBACK_GRADIENT, 'no picture address in the background either')
    })

    it('still renders the same heading, lines and form when narrow (only the download is skipped)', async () => {
      viewport.narrow = true
      const { page } = await mount({ branding: BRANDING({ heading: 'Welcome to Acme', text: 'Run your shop with us.' }), status: 'ready' })
      assert.deepEqual(heroText(page), ['Welcome to Acme', 'Run your shop with us.'])
      assert.ok(all(page.root()).some((el) => el.props?.id === 'the-form'))
      assert.equal(page.root().props.className, 'login-split')
    })

    it('asks the browser with the very query the stylesheet uses to hide the panel', async () => {
      await mount(NONE)
      assert.ok(viewport.queries.length >= 1)
      assert.ok(viewport.queries.every((q) => q === utils.HERO_PANEL_HIDDEN_QUERY), JSON.stringify(viewport.queries))
    })

    it('loads on a wide screen: nothing for the default look, or the custom one fetched by its version', async () => {
      const builtIn = await mount(NONE)
      assert.deepEqual(images, [], 'the default gradient needs no download')
      assert.equal(background(builtIn.page).props.className, 'login-left-bg loaded')
      assert.equal(builtIn.requested.at(-1)?.[0], null, 'no custom picture is fetched when there is none')
      images.length = 0
      const custom = await mount({ branding: BRANDING({ heroImage: { version: 'v7' } }), status: 'ready' }, READY)
      assert.deepEqual(custom.requested.at(-1), ['/public/login-branding/hero-image', 'v7'])
      assert.deepEqual(images.map((i) => i.src), [READY.url])
    })

    it('makes no picture request during the first render on any viewport, so server and first client render stay identical', async () => {
      for (const narrow of [false, true]) {
        viewport.narrow = narrow
        const { requested } = await mount(CUSTOM_STATE, READY)
        assert.deepEqual(requested[0], [null, 'v1'], `first render, narrow=${narrow}`)
      }
    })

    it('shows the gradient, or starts loading the custom picture, when the window grows past the breakpoint', async () => {
      viewport.narrow = true
      const builtIn = await mount(NONE)
      assert.deepEqual(images, [])
      assert.equal(background(builtIn.page).props.className, 'login-left-bg loading', 'nothing is painted while the panel is hidden')
      await resize(builtIn.page, false)
      assert.deepEqual(images, [], 'the default gradient needs no download')
      assert.equal(background(builtIn.page).props.className, 'login-left-bg loaded')
      assert.equal(background(builtIn.page).props.style.backgroundImage, utils.LOGIN_FALLBACK_GRADIENT)

      images.length = 0
      viewport.narrow = true
      const custom = await mount(CUSTOM_STATE, READY)
      assert.deepEqual(images, [])
      await resize(custom.page, false)
      assert.deepEqual(custom.requested.at(-1), ['/public/login-branding/hero-image', 'v1'])
      assert.deepEqual(images.map((i) => i.src), [READY.url])
      images[0].onload!()
      await custom.page.settle()
      assert.equal(background(custom.page).props.className, 'login-left-bg loaded')
    })

    it('keeps a loaded picture when the window shrinks again, and leaves no listener behind', async () => {
      const { page } = await mount(CUSTOM_STATE, READY)
      images[0].onload!()
      await page.settle()
      assert.equal(viewport.listeners.size, 0, 'the listener is dropped once the panel has been shown')
      await resize(page, true)
      assert.equal(images.length, 1, 'no second download')
      assert.equal(background(page).props.className, 'login-left-bg loaded')
      assert.equal(background(page).props.style.backgroundImage, `url("${READY.url}")`)
    })

    it('removes its listener when the page goes away while narrow', async () => {
      viewport.narrow = true
      const { page } = await mount(NONE)
      assert.equal(viewport.listeners.size, 1)
      page.unmount()
      assert.equal(viewport.listeners.size, 0)
    })

    it('still loads the picture where the browser cannot answer media queries (behaves as before)', async () => {
      viewport.answersQueries = false
      const plain = await mount(NONE)
      assert.deepEqual(images, [], 'the default gradient needs no download')
      assert.equal(background(plain.page).props.className, 'login-left-bg loaded')
      await mount(CUSTOM_STATE, READY)
      assert.deepEqual(images.map((i) => i.src), [READY.url])
    })
  })
})

describe('source and stylesheet', () => {
  const css = read('app/login/login.css')

  it('hide the landscape panel at the same width the component stops downloading for it', () => {
    const rule = css.match(/@media \(max-width: (\d+)px\) \{\n  \.login-split \{\n    grid-template-columns: 1fr;\n  \}\n\n  \.login-left \{\n    display: none;/)
    assert.ok(rule, 'the rule that hides .login-left was not found')
    assert.equal(utils.HERO_PANEL_HIDDEN_QUERY, `(max-width: ${rule[1]}px)`)
  })

  it('no longer contain the district picker, the random button, the weather widget or its data and rules', () => {
    assert.equal(fs.existsSync(path.join(WEB, 'lib/sri-lanka-images.ts')), false, 'the district / weather data is gone')
    const code = [read('components/auth/AuthLayout.tsx'), read('lib/login-branding.ts'), read('lib/appearance-utils.ts')].join('\n')
    assert.ok(!/district|weather|open-meteo|pickRandom|MapPin|Compass|RefreshCw/i.test(code))
    assert.ok(!/district|weather|auth-greeting|auth-picker|login-location|login-sinhala|login-left-bottom|theme-(sunny|rainy|cloudy|misty|evening)/i.test(css))
  })

  it('keep the split-screen layout, the default colour scheme and the responsive rules', () => {
    assert.match(css, /\.login-split \{\n  --theme-right-bg:/, 'the default (warm cream) colour scheme is still on .login-split')
    assert.match(css, /\.login-split \{\n  display: grid;\n  grid-template-columns: 55fr 45fr;/)
    assert.match(css, /@media \(max-width: 1024px\) \{\n  \.login-split \{\n    grid-template-columns: 1fr;\n  \}\n\n  \.login-left \{\n    display: none;\n  \}\n\n  \.login-mobile-brand \{\n    display: flex;/)
    assert.match(css, /\.login-left-bg\.loading \{\n  opacity: 0;/)
    assert.match(css, /\.login-left-hero\.pending \{\n  opacity: 0;/)
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n  \.login-left-bg,\n  \.login-left-hero \{\n    transition: none !important;/)
  })

  it('leave every authentication page on the shared layout, so sign-in, registration and password flows look the same', () => {
    for (const page of ['login', 'register', 'forgot-password', 'reset-password', 'verify-email']) {
      assert.match(read(`app/${page}/page.tsx`), /import \{ AuthLayout \} from '@\/components\/auth\/AuthLayout'/, page)
      assert.ok(!/sri-lanka-images/.test(read(`app/${page}/page.tsx`)), page)
    }
  })
})
