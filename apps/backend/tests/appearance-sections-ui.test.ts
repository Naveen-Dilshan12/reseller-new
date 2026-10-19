import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { jsx, mountPage, type Elem } from './helpers/render-page'

/**
 * Admin → Settings → Appearance: the internal section navigation (General appearance / Login page branding / Login page theme).
 *  - navigation: one native button per section, the open one marked with aria-current, only its panel shown;
 *  - nothing is duplicated or lost: every field exists exactly once, in its own panel, and what was typed or saved survives switching;
 *  - the open section can be linked to (URL hash), follows hash changes, and is written back without adding history entries;
 *  - responsive: the stylesheet makes the nav a one-row tab bar by default (labels wrap inside equal-width items) and a sticky side list only when the card is wide enough;
 *  - keyboard: plain `<button type="button">` items (Tab, Enter, Space) with a visible focus outline.
 *
 * The real, unmodified component runs in Node through tests/helpers/render-page.ts against scripted API stubs, with a stand-in
 * `window`/`document` for the URL and scrolling; the CSS is read from globals.css. There is no browser, so this checks structure
 * and the rules in the stylesheet, not pixels. Database-free; nothing here reads `.env`, runs Prisma or opens a connection.
 */

const WEB = path.resolve(__dirname, '../../web/src')
const FILE = path.join(WEB, 'components/admin/AppearanceSettings.tsx')
const CSS = fs.readFileSync(path.join(WEB, 'app/globals.css'), 'utf8').replace(/\r\n/g, '\n')
const utils = require('../../web/src/lib/appearance-utils')
const { builtInText } = require('../../web/src/lib/i18n')
const { APPEARANCE_SECTIONS, appearanceSectionFromHash } = utils

class ApiError extends Error {
  constructor(message: string, public status = 0, public code?: string, public errors: string[] = []) {
    super(message)
  }
}

type Row = Record<string, any>
const MB = 1024 * 1024
const detail = (custom = false): Row => ({ custom, updatedAt: custom ? '2026-10-01T05:00:00.000Z' : null, updatedBy: custom ? { name: 'Ada Admin', email: 'admin@test.invalid' } : null })
const appearance = (loginBranding: Row = { heading: null, text: null, heroImage: null }, custom: string[] = []): Row => ({
  defaultTheme: 'dark',
  welcomeText: { en: null, si: null },
  heroImage: null,
  logo: null,
  loginBranding,
  details: Object.fromEntries(['heroImage', 'logo', 'welcomeTextEn', 'welcomeTextSi', 'defaultTheme', 'loginImage', 'loginHeading', 'loginText', 'loginTheme'].map((k) => [k, detail(custom.includes(k))])),
  limits: {
    imageTypes: ['image/jpeg', 'image/png', 'image/webp'],
    hero: { maxBytes: 5 * MB, minWidth: 800, minHeight: 300, maxSide: 8000 },
    logo: { maxBytes: 2 * MB, minWidth: 32, minHeight: 32, maxSide: 4000 },
    login: { maxBytes: 5 * MB, minWidth: 800, minHeight: 600, maxSide: 8000 },
    welcomeTextMaxLength: 120,
    loginHeadingMaxLength: 80,
    loginTextMaxLength: 200,
  },
})

/* ─── a stand-in browser: URL hash, history, scroll position ─────────────── */

interface FakeBrowser {
  window: any
  card: { top: number; scrolled: Array<unknown> }
  replaced: string[]
  pushed: number
  listeners: Map<string, Set<(...args: unknown[]) => void>>
  setHash(hash: string): void
  fireHashChange(): void
}
const installBrowser = (hash = ''): FakeBrowser => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const card = { top: 0, scrolled: [] as unknown[] }
  const state = { stateObject: { from: 'next-router' } }
  const browser = {} as FakeBrowser
  const win = {
    location: { hash },
    history: {
      get state() {
        return state.stateObject
      },
      replaceState(_state: unknown, _title: string, url: string) {
        browser.replaced.push(String(url))
        win.location.hash = String(url)
      },
      pushState() {
        browser.pushed++
      },
    },
    addEventListener(type: string, fn: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn)
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.get(type)?.delete(fn)
    },
  }
  Object.assign(browser, {
    window: win,
    card,
    replaced: [] as string[],
    pushed: 0,
    listeners,
    setHash: (next: string) => void (win.location.hash = next),
    fireHashChange: () => listeners.get('hashchange')?.forEach((fn) => fn()),
  })
  ;(globalThis as any).window = win
  ;(globalThis as any).document = {
    getElementById: (id: string) =>
      id === 'appearance' ? { getBoundingClientRect: () => ({ top: card.top }), scrollIntoView: (options: unknown) => void card.scrolled.push(options) } : null,
  }
  return browser
}
const removeBrowser = () => {
  delete (globalThis as any).window
  delete (globalThis as any).document
}

/* ─── reading the rendered tree ──────────────────────────────────────────── */

const walk = (node: any, visit: (el: Elem) => void) => {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit))
  visit(node)
  walk(node.props?.children, visit)
}
const findAll = (page: { root(): Elem }, test: (el: Elem) => boolean): Elem[] => {
  const found: Elem[] = []
  walk(page.root(), (el) => test(el) && found.push(el))
  return found
}
const textOf = (node: any): string => (node == null ? '' : typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(textOf).join('') : textOf(node.props?.children))
const hasClass = (el: Elem, name: string) => typeof el.props?.className === 'string' && el.props.className.split(/\s+/).includes(name)

/* ─── reading the stylesheet ─────────────────────────────────────────────── */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Declarations of the top-level rule whose selector is exactly `selector`, or of the one at the same place inside `source`. */
const ruleBody = (selector: string, source = CSS): string => {
  const match = new RegExp(`(?:^|\\n)\\s*${escapeRe(selector)}\\s*\\{([^}]*)\\}`).exec(source)
  assert.ok(match, `globals.css has no "${selector}" rule`)
  return match[1]
}
const declared = (body: string, property: string): string | undefined => new RegExp(`(?:^|[;\\s])${escapeRe(property)}\\s*:\\s*([^;]+)`).exec(body)?.[1].trim()
/** The text between the braces of the at-rule that starts with `head` (brace-matched, so nested rules are included). */
const atRule = (head: string): string => {
  const from = CSS.indexOf(head)
  assert.ok(from >= 0, `globals.css has no "${head}" block`)
  let depth = 0
  for (let i = CSS.indexOf('{', from); i < CSS.length; i++) {
    if (CSS[i] === '{') depth++
    else if (CSS[i] === '}' && --depth === 0) return CSS.slice(CSS.indexOf('{', from) + 1, i)
  }
  throw new Error(`unterminated "${head}" block`)
}

describe('Admin → Settings → Appearance sections', () => {
  let calls: Array<{ path: string; method: string; body: any }>
  let script: Array<() => Promise<unknown>>
  let browser: FakeBrowser

  const answer = (value: unknown) => async () => structuredClone(value)
  const recordApi = async (url: string, init: { method?: string; body?: unknown } = {}) => {
    calls.push({ path: url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body })
    const next = script.shift()
    if (!next) throw new Error(`unexpected extra request: ${url}`)
    return next()
  }

  /** The login-theme editor has its own tests (login-theme-ui.test.ts); here a marker shows which panel it sits in. */
  const loginThemeMarker = { LoginThemeSettings: () => jsx('div', { id: 'login-theme-editor' }) }

  const open = async (props: { canManage?: boolean } = {}) => {
    const page = mountPage(
      FILE,
      {
        '@/lib/api': { ApiError, api: recordApi },
        '@/lib/appearance': { refreshAppearance: async () => {}, useProtectedImage: (p: string | null) => (p ? { url: `blob:${p}`, status: 'ready' } : { url: null, status: 'none' }) },
        '@/lib/appearance-utils': utils,
        '@/lib/i18n': { builtInText },
        './LoginThemeSettings': loginThemeMarker,
      },
      { exportName: 'AppearanceSettings', props: { canManage: props.canManage ?? true } },
    )
    await page.settle()
    return page
  }
  type Page = Awaited<ReturnType<typeof open>>

  const navButtons = (page: Page) => findAll(page, (el) => el.type === 'button' && hasClass(el, 'appearance-nav-item'))
  const panels = (page: Page) => findAll(page, (el) => hasClass(el, 'appearance-panel'))
  const panelById = (page: Page, section: string) => panels(page).find((p) => p.props.id === `appearance-panel-${section}`)!
  const shown = (page: Page) => panels(page).filter((p) => !p.props.hidden).map((p) => p.props.id.replace('appearance-panel-', ''))
  const current = (page: Page) => navButtons(page).filter((b) => b.props['aria-current'] === 'true').map((b) => textOf(b))
  const idsIn = (el: Elem) => findAll({ root: () => el }, (e) => typeof e.props?.id === 'string').map((e) => e.props.id as string)
  const sectionOf = (page: Page, id: string) => APPEARANCE_SECTIONS.find((s: { id: string }) => idsIn(panelById(page, s.id)).includes(id))?.id

  beforeEach(() => {
    calls = []
    script = [answer(appearance())]
    browser = installBrowser()
  })
  afterEach(removeBrowser)

  describe('navigation', () => {
    it('offers the three sections in order, in a labelled nav, with General appearance open', async () => {
      const page = await open()
      assert.deepEqual(APPEARANCE_SECTIONS.map((s: { label: string }) => s.label), ['General appearance', 'Login page branding', 'Login page theme'])
      assert.deepEqual(navButtons(page).map(textOf), ['General appearance', 'Login page branding', 'Login page theme'])
      const [nav] = findAll(page, (el) => el.type === 'nav')
      assert.equal(nav.props['aria-label'], 'Appearance sections')
      assert.deepEqual(current(page), ['General appearance'], 'exactly one item is marked current')
      assert.deepEqual(shown(page), ['general'], 'and only its panel is shown')
    })

    it('shows the clicked section, hides the others and moves the highlight, without asking the server for anything', async () => {
      const page = await open()
      await page.click('Login page branding')
      assert.deepEqual(current(page), ['Login page branding'])
      assert.deepEqual(shown(page), ['login-branding'])
      await page.click('Login page theme')
      assert.deepEqual(current(page), ['Login page theme'])
      assert.deepEqual(shown(page), ['login-theme'])
      await page.click('General appearance')
      assert.deepEqual(current(page), ['General appearance'])
      assert.deepEqual(shown(page), ['general'])
      assert.equal(calls.length, 1, 'only the first load; switching sections is purely local')
    })

    it('ties each item to its panel: aria-controls ↔ id, and the panel is named by its item', async () => {
      const page = await open()
      for (const { id, label } of APPEARANCE_SECTIONS) {
        const tab = navButtons(page).find((b) => textOf(b) === label)!
        const panel = panelById(page, id)
        assert.ok(panel, `${id} has a panel`)
        assert.equal(tab.props['aria-controls'], panel.props.id)
        assert.equal(panel.props['aria-labelledby'], tab.props.id)
        assert.equal(panel.props.role, 'region')
      }
      assert.equal(new Set(panels(page).map((p) => p.props.id)).size, APPEARANCE_SECTIONS.length, 'panel ids are unique')
    })

    it('is available to read-only admins too, who still get no save, upload or reset button', async () => {
      const page = await open({ canManage: false })
      await page.click('Login page theme')
      assert.deepEqual(shown(page), ['login-theme'])
      const others = page.buttonLabels().filter((l) => !APPEARANCE_SECTIONS.some((s: { label: string }) => s.label === l))
      assert.deepEqual(others, [])
    })
  })

  describe('nothing is duplicated or lost', () => {
    const FIELDS: Record<string, string[]> = {
      general: ['hero-file', 'hero-reason', 'logo-file', 'logo-reason', 'welcome-en', 'welcome-si', 'appearance-theme', 'appearance-text-reason'],
      'login-branding': ['login-file', 'login-reason', 'login-heading', 'login-text', 'login-text-reason'],
      'login-theme': ['login-theme-editor'],
    }

    it('keeps every existing control exactly once, each in its own section', async () => {
      const page = await open()
      const every = findAll(page, (el) => typeof el.props?.id === 'string').map((el) => el.props.id as string)
      for (const [section, ids] of Object.entries(FIELDS)) {
        for (const id of ids) {
          assert.equal(every.filter((x) => x === id).length, 1, `${id} appears once`)
          assert.equal(sectionOf(page, id), section, `${id} lives in ${section}`)
        }
      }
      assert.equal(findAll(page, (el) => el.type === 'form').length, 2, 'the two text forms are not copied for the navigation')
      assert.equal(findAll(page, (el) => el.type === 'input' && el.props.type === 'file').length, 3, 'one picker per image')
    })

    it('keeps what was typed in a section that is not open, and drops nothing when coming back', async () => {
      const page = await open()
      await page.click('Login page branding')
      await page.fill('login-heading', 'A new heading')
      await page.fill('login-text-reason', 'Seasonal refresh')
      await page.click('General appearance')
      await page.fill('welcome-en', 'Hello {name}')
      assert.equal(page.valueOf('login-heading'), 'A new heading', 'still there while another section is open')
      await page.click('Login page branding')
      assert.equal(page.valueOf('login-heading'), 'A new heading')
      assert.equal(page.valueOf('login-text-reason'), 'Seasonal refresh')
      await page.click('General appearance')
      assert.equal(page.valueOf('welcome-en'), 'Hello {name}')
    })

    it('still checks the reason and sends the same audited request, from inside a section', async () => {
      const page = await open()
      await page.click('Login page branding')
      await page.fill('login-heading', 'A new heading')
      await page.submit(1)
      assert.equal(calls.length, 1, 'nothing is sent without a reason')
      assert.ok(page.textOfClass('alert error').some((t) => t.includes('Give a reason for the change')))

      script.push(answer(appearance({ heading: 'A new heading', text: null, heroImage: null }, ['loginHeading'])))
      await page.fill('login-text-reason', '  Seasonal refresh  ')
      await page.submit(1)
      assert.deepEqual(calls[1], { path: '/admin/settings/appearance', method: 'PUT', body: { loginBranding: { heading: 'A new heading' }, reason: 'Seasonal refresh' } })

      await page.click('Login page theme')
      assert.ok(page.textOfClass('alert success').some((t) => t.includes('Login page text saved.')), 'the confirmation is not tied to the section it was saved in')
    })
  })

  describe('address (URL hash)', () => {
    it('maps a hash to a section only for the three known ids, with or without "#"', () => {
      assert.equal(appearanceSectionFromHash('#login-theme'), 'login-theme')
      assert.equal(appearanceSectionFromHash('login-branding'), 'login-branding')
      assert.equal(appearanceSectionFromHash('#general'), 'general')
      for (const hash of ['', '#', '#nope', '#Login-Theme', '#login-theme-2', '#appearance', ' #general']) assert.equal(appearanceSectionFromHash(hash), null, JSON.stringify(hash))
      assert.deepEqual(APPEARANCE_SECTIONS.map((s: { id: string }) => s.id), ['general', 'login-branding', 'login-theme'])
    })

    it('opens the section named in the address, or General appearance for anything else', async () => {
      removeBrowser()
      browser = installBrowser('#login-theme')
      assert.deepEqual(shown(await open()), ['login-theme'])
      script = [answer(appearance())]
      removeBrowser()
      browser = installBrowser('#unknown')
      assert.deepEqual(shown(await open()), ['general'])
    })

    it('writes the open section into the address without adding a history entry, and keeps the router state', async () => {
      const page = await open()
      await page.click('Login page theme')
      await page.click('Login page branding')
      assert.deepEqual(browser.replaced, ['#login-theme', '#login-branding'])
      assert.equal(browser.pushed, 0, 'back still leaves the settings page')
    })

    it('follows a hash change (a link, or back/forward), ignores unknown ones, and stops listening when closed', async () => {
      const page = await open()
      assert.equal(browser.listeners.get('hashchange')?.size, 1)
      browser.setHash('#login-theme')
      browser.fireHashChange()
      await page.settle()
      assert.deepEqual(shown(page), ['login-theme'])
      browser.setHash('#somewhere-else')
      browser.fireHashChange()
      await page.settle()
      assert.deepEqual(shown(page), ['login-theme'], 'an unrelated anchor leaves the section alone')
      page.unmount()
      assert.equal(browser.listeners.get('hashchange')?.size, 0)
    })

    it('scrolls back to the top of the card only when it is scrolled out of view', async () => {
      const page = await open()
      await page.click('Login page theme')
      assert.deepEqual(browser.card.scrolled, [], 'the card top is on screen: leave the page where it is')
      browser.card.top = -240
      await page.click('Login page branding')
      assert.deepEqual(browser.card.scrolled, [{ block: 'start' }])
    })

    it('renders without a window (server render): no listener, no address access', async () => {
      removeBrowser()
      const page = await open()
      assert.deepEqual(shown(page), ['general'])
      await page.click('Login page theme')
      assert.deepEqual(shown(page), ['login-theme'])
    })
  })

  describe('keyboard', () => {
    it('uses plain buttons that Tab reaches and Enter / Space press, never a negative tab stop', async () => {
      const page = await open()
      for (const button of navButtons(page)) {
        assert.equal(button.type, 'button')
        assert.equal(button.props.type, 'button', 'never submits a form')
        assert.ok(button.props.tabIndex === undefined || button.props.tabIndex >= 0, 'not removed from the tab order')
        assert.equal(button.props.disabled, undefined)
        assert.equal(typeof button.props.onClick, 'function')
      }
      assert.equal(findAll(page, (el) => el.type === 'nav').length, 1)
      const navHasForm = findAll(page, (el) => el.type === 'nav').some((nav) => findAll({ root: () => nav }, (el) => el.type === 'form').length > 0)
      assert.ok(!navHasForm)
    })

    it('draws a focus outline on the items and a visible active state', () => {
      const focus = ruleBody('.appearance-nav-item:focus-visible')
      assert.match(declared(focus, 'outline') ?? '', /^2px solid var\(--border-focus\)$/)
      assert.notEqual(declared(focus, 'outline-offset'), undefined)
      const base = ruleBody('.appearance-nav-item')
      const active = ruleBody('.appearance-nav-item.active')
      assert.notEqual(declared(active, 'background'), undefined)
      assert.notEqual(declared(active, 'background'), declared(base, 'background'), 'the open section looks different from the others')
      assert.notEqual(declared(active, 'border-color'), declared(base, 'border-color'))
      assert.equal(declared(base, 'cursor'), 'pointer')
    })
  })

  describe('responsive layout (stylesheet)', () => {
    it('is a compact one-row tab bar by default: one column, sticky under the header, labels wrapping inside equal-width items, never wider than its box', () => {
      assert.equal(declared(ruleBody('.appearance-layout'), 'grid-template-columns'), 'minmax(0, 1fr)')
      const nav = ruleBody('.appearance-nav')
      assert.equal(declared(nav, 'display'), 'flex')
      assert.equal(declared(nav, 'flex-wrap'), 'nowrap', 'one row: three short tabs, not three stacked rows of sticky chrome')
      assert.equal(declared(nav, 'position'), 'sticky')
      assert.equal(declared(nav, 'top'), '64px', 'sits right under the 64px admin header')
      assert.match(declared(nav, 'background') ?? '', /^var\(--surface\)$/, 'opaque, so content scrolls underneath it')
      assert.notEqual(declared(nav, 'z-index'), undefined)
      const item = ruleBody('.appearance-nav-item')
      assert.equal(declared(item, 'flex'), '1 1 0', 'equal-width items that share the row')
      assert.equal(declared(item, 'min-width'), '0', 'an item can shrink instead of pushing the page wider')
      assert.equal(declared(item, 'overflow-wrap'), 'anywhere')
      assert.equal(declared(item, 'white-space'), undefined, 'no nowrap')
      assert.equal(declared(item, 'width'), undefined, 'no fixed width')
      assert.ok(Number.parseFloat(declared(item, 'min-height') ?? '0') >= 2.5, 'a comfortable touch target')
      for (const selector of ['.appearance-shell', '.appearance-content']) assert.equal(declared(ruleBody(selector), 'min-width'), '0', `${selector} may shrink`)
      assert.ok(!/overflow-x\s*:\s*(auto|scroll)/.test(ruleBody('.appearance-nav')), 'the labels wrap; the bar does not scroll sideways')
      const narrow = atRule('@container appearance (max-width: 32rem)')
      assert.ok(Number.parseFloat(declared(ruleBody('.appearance-nav-item', narrow), 'font-size') ?? '9') < 0.9, 'a narrow card sets the labels a little smaller so three fit across')
    })

    it('becomes a sticky side list only when the card is wide enough, measured on the card (the admin sidebar takes room too)', () => {
      const shell = ruleBody('.appearance-shell')
      assert.equal(declared(shell, 'container'), 'appearance / inline-size')
      const side = atRule('@container appearance (min-width: 46rem)')
      assert.match(side, /\.appearance-layout\s*\{[^}]*grid-template-columns:\s*12rem minmax\(0, 1fr\)/, 'a fixed-width list beside a shrinkable content column')
      const nav = ruleBody('.appearance-nav', side)
      assert.equal(declared(nav, 'flex-direction'), 'column')
      assert.equal(declared(ruleBody('.appearance-nav-item', side), 'flex'), 'none', 'list items keep their natural height')
      assert.equal(declared(nav, 'top'), '5rem', 'a little below the header')
      assert.ok(!/position\s*:/.test(nav), 'it stays sticky (inherited from the base rule)')
      assert.match(ruleBody('.appearance-layout', side), /align-items:\s*start/, 'a sticky list must not stretch to the content height')
      assert.ok(!/@media[^{]*\{[^]*\.appearance-/.test(CSS.slice(CSS.indexOf('.appearance-card'), CSS.indexOf('@container appearance'))), 'the default (narrow) rules are not behind a window query')
    })

    it('puts related settings side by side only while each gets enough room, and a hidden section takes none', () => {
      const grid = ruleBody('.appearance-grid')
      assert.equal(declared(grid, 'display'), 'grid')
      assert.match(declared(grid, 'grid-template-columns') ?? '', /^repeat\(auto-fit, minmax\(min\(100%, 19rem\), 1fr\)\)$/, 'a column never exceeds its box, so a phone gets one column')
      assert.equal(declared(ruleBody('.appearance-grid > *'), 'min-width'), '0')
      assert.equal(declared(ruleBody('.appearance-panel[hidden]'), 'display'), 'none')
    })

    it('keeps the active state visible in forced-colors (high-contrast) mode, after the rules that would hide it', () => {
      const forced = atRule('@media (forced-colors: active)')
      assert.match(forced, /\.appearance-nav-item\.active\s*\{[^}]*border-color:\s*Highlight/)
      assert.ok(CSS.indexOf('@media (forced-colors: active) {') > CSS.indexOf('@container appearance (min-width'), 'later than the side-list rules, so it wins')
    })

    it('uses theme tokens for its colours, so Light and Dark both follow', () => {
      const css = [ruleBody('.appearance-nav'), ruleBody('.appearance-nav-item'), ruleBody('.appearance-nav-item:hover'), ruleBody('.appearance-nav-item.active')].join('\n')
      assert.deepEqual([...new Set(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [])], [], 'no hard-coded hex colours')
      for (const token of ['--surface', '--border', '--muted', '--text-heading', '--primary', '--surface-hover']) assert.ok(css.includes(`var(${token})`), `uses ${token}`)
    })
  })
})
