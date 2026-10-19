import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { jsx, mountPage } from './helpers/render-page'

/**
 * The Admin's hero image on every reseller page, not just the dashboard.
 *  - the stylesheet: every rule that paints the hero (the dashboard's and the shared PageHero banner, dark and light)
 *    reads `--dash-hero-image` and falls back to a neutral gradient (no picture ships with the app); no rule references a picture file, and
 *    the dark / light overlays are untouched;
 *  - the page tree: every page that shows a hero sits inside ResellerShell, nothing else in the reseller pages hardcodes a
 *    hero picture, and no admin page shows one (it would sit outside the shell and silently keep the default gradient);
 *  - the shell is the single place that sets the variable, so a change or a reset reaches all pages together: custom image
 *    ready → set, still downloading → picture switched off (no flash of the default gradient), unset / failed / not loaded →
 *    not set, so the default gradient from the stylesheet shows.
 *
 * Database-free; nothing here reads `.env`, runs Prisma or opens a connection. Files are scanned and the real shell runs in
 * Node through tests/helpers/render-page.ts. There is no browser, so how a hero looks is not checked here.
 */

const WEB = path.resolve(__dirname, '../../web/src')
const utils = require('../../web/src/lib/appearance-utils')
const CRLF = new RegExp(String.fromCharCode(13) + String.fromCharCode(10), 'g')
const read = (file: string) => fs.readFileSync(path.join(WEB, file), 'utf8').replace(CRLF, '\n')
const relative = (file: string) => path.relative(WEB, file).split(path.sep).join('/')

function files(dir: string, ext: string): string[] {
  return fs.readdirSync(path.join(WEB, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`
    return e.isDirectory() ? files(rel, ext) : rel.endsWith(ext) ? [rel] : []
  })
}

const WITH_FALLBACK = {
  dark: `var(--dash-hero-image, ${utils.HERO_FALLBACK_DARK})`,
  light: `var(--dash-hero-image, ${utils.HERO_FALLBACK_LIGHT})`,
}

describe('stylesheet', () => {
  const css = read('app/globals.css')
  /** The declarations of the first rule whose selector list is exactly `selector`. */
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`)
    assert.ok(at >= 0, `rule not found: ${selector}`)
    return css.slice(at, css.indexOf('}', at))
  }

  const HERO_RULES = {
    'dashboard (dark)': { mode: 'dark', selector: '.dash-hero-kpi-backdrop', overlay: 'rgba(14, 21, 38' },
    'dashboard (light)': { mode: 'light', selector: ".dash-hero-kpi-backdrop,\n.light-theme .dash-hero-kpi-backdrop", overlay: 'rgba(248, 246, 240' },
    'PageHero banner (dark)': { mode: 'dark', selector: '.compact-hero-backdrop,\n.compact-hero-banner', overlay: 'rgba(14, 21, 38' },
    'PageHero banner (light)': {
      mode: 'light',
      selector: "html[data-theme='light'] .compact-hero-backdrop,\nhtml[data-theme='light'] .compact-hero-banner,\n.light-theme .compact-hero-backdrop,\n.light-theme .compact-hero-banner",
      overlay: 'rgba(248, 246, 240',
    },
  }

  for (const [name, { mode, selector, overlay }] of Object.entries(HERO_RULES)) {
    it(`${name}: paints --dash-hero-image with the ${mode} gradient as the fallback, keeping its overlays and placement`, () => {
      const body = rule(selector)
      assert.ok(body.includes(`${WITH_FALLBACK[mode as 'dark' | 'light']} center 32% / cover no-repeat`), 'image layer')
      assert.equal((body.match(/linear-gradient\((?:90|180)deg/g) ?? []).length, 2, 'both overlay gradients are still there')
      assert.equal((body.match(/linear-gradient\(/g) ?? []).length, 3, 'the two overlays plus the fallback gradient, nothing else')
      assert.ok(body.includes(`linear-gradient(90deg, ${overlay}`) && body.includes(`linear-gradient(180deg, ${overlay}`), 'overlay colours of this theme')
    })
  }

  it('no rule references a picture file: every hero rule reads the variable with a gradient behind it', () => {
    const urls = css.split('url(').slice(1).map((rest) => rest.split(')')[0])
    assert.deepEqual(urls.filter((u) => /[.](png|jpe?g|webp|avif|gif|svg)/i.test(u)), [], 'a rule still points at a picture file')
    assert.equal(css.split(WITH_FALLBACK.dark).length - 1, 2, 'dark rules')
    assert.equal(css.split(WITH_FALLBACK.light).length - 1, 2, 'light rules')
    assert.equal(css.split('var(--dash-hero-image').length - 1, Object.keys(HERO_RULES).length, 'every use of the variable is one of the four hero rules')
  })

  it('the old unused .dash-welcome-hero banner is not on any page (it keeps its own gradient and no picture)', () => {
    const rendered = files('app', '.tsx').concat(files('components', '.tsx')).filter((f) => /["'` ]dash-welcome-hero(["'` ])/.test(read(f)))
    assert.deepEqual(rendered, [])
  })
})

describe('pages', () => {
  const pages = files('app', 'page.tsx')
  const usesHero = (f: string) => /PageHero|heroProps/.test(read(f))
  const adminPages = pages.filter((f) => f.startsWith('app/admin/'))
  const heroPages = pages.filter((f) => !f.startsWith('app/admin/') && usesHero(f))

  it('every reseller page that shows a PageHero sits inside ResellerShell, so it inherits the Admin\'s image', () => {
    assert.ok(heroPages.length >= 8, `expected the reseller list / form pages, found ${heroPages.join(', ')}`)
    for (const f of ['customers', 'products', 'commissions', 'profile', 'notifications', 'activations', 'trials', 'demo-requests'])
      assert.ok(heroPages.some((p) => p.startsWith(`app/${f}/`)), `${f} has a hero`)
    const outside = heroPages.filter((f) => !read(f).includes('ResellerShell'))
    assert.deepEqual(outside, [])
  })

  it('no admin page shows a hero (it would be outside the shell and keep the default gradient)', () => {
    assert.deepEqual(adminPages.filter(usesHero), [])
    const components = files('components/admin', '.tsx').filter((f) => /PageHero|compact-hero/.test(read(f)))
    assert.deepEqual(components, [])
  })

  it('nothing but PageHero draws a banner of its own', () => {
    const users = [...files('app', '.tsx'), ...files('components', '.tsx')].filter((f) => f !== 'components/PageHero.tsx' && /compact-hero-backdrop|compact-hero-banner/.test(read(f)))
    assert.deepEqual(users, [])
  })

  it('no reseller page or component hardcodes a hero picture or an inline background image', () => {
    // The sign-in / registration screens have their own scenery and are not reseller pages. The Admin's login-theme editor draws a
    // small preview of that same scenery, so that one file is let through by name (nothing else under components/admin is).
    const skip = (f: string) =>
      /^app\/(login|register|forgot-password|reset-password|verify-email)\//.test(f) || f.startsWith('components/auth/') || f === 'components/admin/LoginThemeSettings.tsx'
    const offenders = [...files('app', '.tsx'), ...files('components', '.tsx')].filter((f) => !skip(f)).filter((f) => /Nine%20Arches|Nine Arches|ninearch|backgroundImage|srilanka-images|sri-lanka-images/.test(read(f)))
    assert.deepEqual(offenders, [])
  })

  it('only ResellerShell sets the hero variable, so it cannot differ between pages', () => {
    const setters = [...files('app', '.tsx'), ...files('components', '.tsx')].filter((f) => /heroBackgroundVars\(|--dash-hero-image/.test(read(f)))
    assert.deepEqual(setters, ['components/ResellerShell.tsx'])
  })
})

describe('ResellerShell', () => {
  const USER = { id: 'u1', name: 'Nimal Perera', role: 'SELLER', permissions: [], resellerId: 'r1', reseller: { id: 'r1', status: 'ACTIVE', businessName: 'Kandy Traders', code: 'RS-1' } }

  /** Mounts the real shell the way any reseller page does, with the appearance hooks answering as scripted. */
  const mountShell = async (appearance: object | null, image: { url: string | null; status: string }, pageName = 'page') => {
    const requested: Array<[string | null, string | undefined]> = []
    const page = mountPage(
      path.join(WEB, 'components/ResellerShell.tsx'),
      {
        'next/navigation': { usePathname: () => '/customers', useRouter: () => ({ replace() {} }) },
        'next/link': { __esModule: true, default: ({ href, children }: { href: string; children: unknown }) => jsx('a', { href, children }) },
        '@/lib/auth': { isPlatformUser: () => false, logout: async () => {}, useCurrentUser: () => USER },
        '@/components/ThemeToggle': { ThemeToggle: () => null },
        '@/components/PlatformLogo': { PlatformLogo: ({ fallback }: { fallback: unknown }) => fallback },
        '@/components/LanguageToggle': { LanguageToggle: () => null },
        '@/components/notifications/NotificationBell': { NotificationBell: () => null },
        '@/lib/api': { api: async () => ({}) },
        '@/lib/appearance': {
          useAppearance: () => appearance,
          useProtectedImage: (p: string | null, version?: string) => (requested.push([p, version]), image),
        },
        '@/lib/appearance-utils': utils,
        '@/lib/i18n': { useLanguage: () => ({ t: (k: string) => k, language: 'en' }) },
        '@/components/commissions/LevelBadge': { LevelBadge: () => null },
        '@/components/commissions/LevelUpCelebration': { LevelUpCelebration: () => null },
        '@/components/commissions/PartnerSummaryContext': { PartnerSummaryProvider: ({ children }: { children: unknown }) => children },
        '@/components/onboarding/ApplicationNotices': { ApplicationPopups: () => null, ApplicationStatusCard: () => null },
      },
      { exportName: 'ResellerShell', props: { children: () => jsx('main', { id: pageName, children: pageName }) } },
    )
    await page.settle()
    return { page, style: (page.root().props.style ?? {}) as Record<string, string>, requested }
  }
  const settings = (heroImage: object | null) => ({ defaultTheme: 'dark', welcomeText: { en: null, si: null }, heroImage, logo: null })

  it('sets the variable on the outermost box when a custom image is ready, so every hero inside inherits it', async () => {
    const { page, style, requested } = await mountShell(settings({ version: 'v1' }), { url: 'blob:http://localhost:3000/hero-1', status: 'ready' })
    assert.equal(style['--dash-hero-image'], 'url("blob:http://localhost:3000/hero-1")')
    assert.deepEqual(requested.at(-1), ['/appearance/hero-image', 'v1'], 'the private hero endpoint, versioned')
    assert.ok(page.text().includes('page'), 'the page renders inside it')
  })

  it('keeps the shell\'s own look when it sets the variable', async () => {
    const { style } = await mountShell(settings({ version: 'v1' }), { url: 'blob:x', status: 'ready' })
    assert.equal(style.minHeight, '100vh')
    assert.equal(style.background, 'var(--bg)')
    assert.equal(style.color, 'var(--text)')
  })

  it('switches the picture off while the custom image is still downloading, rather than flashing the default gradient', async () => {
    const { style } = await mountShell(settings({ version: 'v1' }), { url: null, status: 'loading' })
    assert.equal(style['--dash-hero-image'], 'none')
  })

  it('leaves the variable unset, so the stylesheet\'s default gradient shows, when nothing is customized, nothing has loaded, or the download failed', async () => {
    for (const [label, appearance, image] of [
      ['no custom image', settings(null), { url: null, status: 'none' }],
      ['settings not loaded', null, { url: null, status: 'none' }],
      ['download failed', settings({ version: 'v1' }), { url: null, status: 'failed' }],
    ] as const) {
      const { style, requested } = await mountShell(appearance, image)
      assert.ok(!('--dash-hero-image' in style), label)
      if (label !== 'download failed') assert.equal(requested.at(-1)?.[0], null, `${label}: no image is requested`)
    }
  })

  it('every page gets the same value, and a replaced or reset image reaches the next page that opens', async () => {
    // Each reseller page renders its own ResellerShell and reads the shared settings, so what matters is that the value
    // depends only on those settings, not on the page.
    const first = await mountShell(settings({ version: 'v1' }), { url: 'blob:hero-v1', status: 'ready' }, 'customers')
    const second = await mountShell(settings({ version: 'v1' }), { url: 'blob:hero-v1', status: 'ready' }, 'commissions')
    assert.equal(first.style['--dash-hero-image'], second.style['--dash-hero-image'])

    const replaced = await mountShell(settings({ version: 'v2' }), { url: 'blob:hero-v2', status: 'ready' }, 'products')
    assert.equal(replaced.style['--dash-hero-image'], 'url("blob:hero-v2")')
    assert.deepEqual(replaced.requested.at(-1), ['/appearance/hero-image', 'v2'], 'the new version is what is fetched')

    const reset = await mountShell(settings(null), { url: null, status: 'none' }, 'trials')
    assert.ok(!('--dash-hero-image' in reset.style), 'reset: back to the default gradient on this page too')
  })

  it('never puts a value in the variable that could break out of url()', async () => {
    const { style } = await mountShell(settings({ version: 'v1' }), { url: 'blob:x") , url("https://evil.example/x', status: 'ready' })
    assert.ok(!('--dash-hero-image' in style))
  })
})
