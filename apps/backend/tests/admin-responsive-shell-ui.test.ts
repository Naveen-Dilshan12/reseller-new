import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { jsx, mountPage, type Elem } from './helpers/render-page'

/**
 * The Admin panel on tablets and phones (apps/web/src/app/admin/layout.tsx + globals.css).
 *  - drawer: up to 1024px the 260px sidebar is a drawer opened by a labelled menu button (aria-expanded / aria-controls); it closes on a
 *    second press, on the backdrop, on a link, on a route change, on Escape and when the window grows to a desktop width; while it is open
 *    the page behind is inert and does not scroll; every listener and the scroll lock are released when it closes;
 *  - stylesheet: desktop keeps the fixed 260px sidebar and the offset content; at 1024px and below the content uses the full width, a closed
 *    drawer is off screen AND out of the tab order, the header sheds pieces step by step so it fits 320px, content padding shrinks;
 *  - no sideways scroll: long names, IDs, file names and URLs wrap; grids use shrinkable tracks; tables in cards wrap their cells; tables
 *    elsewhere scroll inside their own box; dialogs never outgrow the screen; short labels (buttons, badges) never break inside a word.
 *
 * The real, unmodified layout runs in Node through tests/helpers/render-page.ts against scripted stubs (a stand-in window/document for the
 * listeners); the CSS is read from globals.css. There is no browser here: focus movement, Tab wrapping and the actual pixel widths were
 * checked separately in a real browser. Database-free; nothing here reads `.env`, runs Prisma or opens a connection.
 */

const WEB = path.resolve(__dirname, '../../web/src')
const LAYOUT = path.join(WEB, 'app/admin/layout.tsx')
const LAYOUT_SRC = fs.readFileSync(LAYOUT, 'utf8').replace(/\r\n/g, '\n')
const CSS = fs.readFileSync(path.join(WEB, 'app/globals.css'), 'utf8').replace(/\r\n/g, '\n')

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
const hasClass = (el: Elem, name: string) => typeof el.props?.className === 'string' && el.props.className.split(/\s+/).includes(name)
const textOf = (node: any): string => (node == null ? '' : typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(textOf).join('') : textOf(node.props?.children))

/* ─── reading the stylesheet ─────────────────────────────────────────────── */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const ruleBody = (selector: string, source = CSS): string => {
  const match = new RegExp(`(?:^|\\n|\\})\\s*${escapeRe(selector)}\\s*\\{([^{}]*)\\}`).exec(source)
  assert.ok(match, `no "${selector}" rule`)
  return match[1]
}
const declared = (body: string, property: string): string | undefined => new RegExp(`(?:^|[;\\s])${escapeRe(property)}\\s*:\\s*([^;]+)`).exec(body)?.[1].trim()
/** Every `head { … }` block (brace-matched, so nested rules are included), in file order. */
const blocks = (head: string): string[] => {
  const found: string[] = []
  for (let at = CSS.indexOf(head); at >= 0; at = CSS.indexOf(head, at + 1)) {
    let depth = 0
    const open = CSS.indexOf('{', at)
    for (let i = open; i < CSS.length; i++) {
      if (CSS[i] === '{') depth++
      else if (CSS[i] === '}' && --depth === 0) {
        found.push(CSS.slice(open + 1, i))
        break
      }
    }
  }
  return found
}
/** The one `head` block that contains `marker` (there are several `@media (max-width: …)` blocks). */
const blockWith = (head: string, marker: string): string => {
  const hit = blocks(head).find((b) => b.includes(marker))
  assert.ok(hit, `no "${head}" block containing "${marker}"`)
  return hit
}
const DRAWER = '@media (max-width: 1024px)'
const drawerCss = () => blockWith(DRAWER, '.admin-sidebar.open')
/** Every rule (outermost declarations only) whose selector list mentions `name`. */
const rulesMentioning = (name: RegExp): Array<{ selector: string; body: string }> =>
  [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] })).filter((r) => name.test(r.selector))

describe('Admin shell: the drawer (real layout)', () => {
  let pathname: string
  let listeners: Map<string, Set<(event: any) => void>>
  let mediaListeners: Set<() => void>
  let media: { matches: boolean }
  let body: { style: { overflow: string } }

  const user = { id: 'u1', name: 'Kasun Perera', email: 'k@test.invalid', role: 'ADMIN', permissions: ['resellers:read', 'settings:read'] }
  const link = { __esModule: true, default: ({ href, onClick, children, ...rest }: any) => jsx('a', { href, onClick, children, ...rest }) }
  const open = async () => {
    const page = mountPage(
      LAYOUT,
      {
        'next/link': link,
        'next/navigation': { usePathname: () => pathname, useRouter: () => ({ replace() {} }) },
        '@/lib/auth': { isPlatformUser: () => true, logout: async () => {}, useCurrentUser: () => user },
        '@/lib/admin-context': { AdminUserContext: { Provider: ({ children }: { children: unknown }) => children } },
        '@/components/ThemeToggle': { ThemeToggle: () => null },
        '@/components/PlatformLogo': { PlatformLogo: ({ fallback }: { fallback: unknown }) => fallback },
        '@/components/notifications/NotificationBell': { NotificationBell: () => null },
        '@/lib/appearance': { useAppearance: () => null },
        '@/lib/role-label': require('../../web/src/lib/role-label'),
      },
      { props: { children: jsx('main', { children: 'content' }) } },
    )
    await page.settle()
    return page
  }
  type Page = Awaited<ReturnType<typeof open>>

  const button = (page: Page) => findAll(page, (el) => el.type === 'button' && hasClass(el, 'admin-menu-btn'))[0]
  const sidebar = (page: Page) => findAll(page, (el) => el.props?.id === 'admin-sidebar')[0]
  const backdrop = (page: Page) => findAll(page, (el) => hasClass(el, 'admin-drawer-backdrop'))
  const content = (page: Page) => findAll(page, (el) => hasClass(el, 'admin-content'))[0]
  const links = (page: Page) => findAll(page, (el) => el.type === 'a')
  const press = async (page: Page, el: Elem) => {
    await el.props.onClick()
    await page.settle()
  }
  const key = async (page: Page, event: Partial<{ key: string; shiftKey: boolean }>) => {
    for (const fn of listeners.get('keydown') ?? []) fn({ preventDefault() {}, ...event })
    await page.settle()
  }
  const isOpen = (page: Page) => button(page).props['aria-expanded']

  beforeEach(() => {
    pathname = '/admin'
    listeners = new Map()
    mediaListeners = new Set()
    media = { matches: true }
    body = { style: { overflow: '' } }
    ;(globalThis as any).document = {
      body,
      activeElement: null,
      addEventListener: (type: string, fn: () => void) => (listeners.has(type) ? listeners : listeners.set(type, new Set())).get(type)!.add(fn),
      removeEventListener: (type: string, fn: () => void) => listeners.get(type)?.delete(fn),
    }
    ;(globalThis as any).window = {
      matchMedia: (query: string) => ({
        query,
        get matches() {
          return media.matches
        },
        addEventListener: (_: string, fn: () => void) => mediaListeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => mediaListeners.delete(fn),
      }),
    }
  })
  afterEach(() => {
    delete (globalThis as any).document
    delete (globalThis as any).window
  })

  it('starts closed: a labelled menu button that controls the sidebar, no backdrop, a live page, nothing locked', async () => {
    const page = await open()
    const btn = button(page)
    assert.equal(btn.props.type, 'button')
    assert.equal(btn.props['aria-label'], 'Admin navigation menu')
    assert.equal(btn.props['aria-expanded'], false)
    assert.equal(btn.props['aria-controls'], 'admin-sidebar')
    const nav = sidebar(page)
    assert.equal(nav.type, 'nav', 'the sidebar is a navigation landmark')
    assert.equal(nav.props['aria-label'], 'Admin navigation')
    assert.ok(!hasClass(nav, 'open'))
    assert.equal(backdrop(page).length, 0)
    assert.equal(content(page).props.inert, undefined)
    assert.equal(body.style.overflow, '')
    assert.equal(listeners.get('keydown')?.size ?? 0, 0, 'no key listener while closed')
  })

  it('opens from the button: the drawer is shown with a backdrop, the page behind is inert and does not scroll, Escape is listened for', async () => {
    const page = await open()
    await press(page, button(page))
    assert.equal(isOpen(page), true)
    assert.ok(hasClass(sidebar(page), 'open'))
    assert.equal(backdrop(page).length, 1)
    assert.equal(backdrop(page)[0].props['aria-hidden'], 'true', 'the backdrop is decoration, not a control')
    assert.equal(content(page).props.inert, true)
    assert.equal(body.style.overflow, 'hidden')
    assert.equal(listeners.get('keydown')?.size, 1)
    assert.equal(mediaListeners.size, 1, 'watches for the window growing to a desktop width')
  })

  it('closes on a second press of the button, and releases the scroll lock and every listener', async () => {
    const page = await open()
    body.style.overflow = 'auto'
    await press(page, button(page))
    assert.equal(body.style.overflow, 'hidden')
    await press(page, button(page))
    assert.equal(isOpen(page), false)
    assert.equal(backdrop(page).length, 0)
    assert.equal(content(page).props.inert, undefined)
    assert.equal(body.style.overflow, 'auto', 'the previous value is restored, not just cleared')
    assert.equal(listeners.get('keydown')?.size, 0)
    assert.equal(mediaListeners.size, 0)
  })

  it('closes when the backdrop is pressed', async () => {
    const page = await open()
    await press(page, button(page))
    await press(page, backdrop(page)[0])
    assert.equal(isOpen(page), false)
    assert.equal(backdrop(page).length, 0)
  })

  it('closes on Escape, ignores other keys, and stops listening afterwards', async () => {
    const page = await open()
    await press(page, button(page))
    await key(page, { key: 'a' })
    await key(page, { key: 'Enter' })
    assert.equal(isOpen(page), true, 'other keys leave it open')
    await key(page, { key: 'Escape' })
    assert.equal(isOpen(page), false)
    assert.equal(body.style.overflow, '')
    assert.equal(listeners.get('keydown')?.size, 0)
  })

  it('closes when a navigation link is pressed, even a link to the page already open', async () => {
    const page = await open()
    await press(page, button(page))
    const current = links(page).find((a) => a.props.href === '/admin')!
    assert.equal(current.props['aria-current'], 'page', 'the open page is marked for screen readers')
    await press(page, current)
    assert.equal(isOpen(page), false)
  })

  it('closes when the route changes (a link in the page itself, back/forward, a redirect)', async () => {
    const page = await open()
    await press(page, button(page))
    pathname = '/admin/resellers'
    page.setProps({ children: jsx('main', { children: 'resellers' }) })
    await page.settle()
    assert.equal(isOpen(page), false)
  })

  it('closes when the window grows past the drawer breakpoint, so a desktop is never left locked or inert', async () => {
    const page = await open()
    await press(page, button(page))
    media.matches = false
    for (const fn of mediaListeners) fn()
    await page.settle()
    assert.equal(isOpen(page), false)
    assert.equal(content(page).props.inert, undefined)
    assert.equal(body.style.overflow, '')
  })

  it('still lists only the links this admin may see (permissions unchanged), and registers no listener until the drawer is opened', async () => {
    const page = await open()
    assert.deepEqual(links(page).map((a) => textOf(a.props.children)), ['Dashboard', 'Partners', 'Notifications', 'Platform Settings'])
    assert.ok(!links(page).some((a) => a.props.href === '/admin/products'), 'SaaS Products needs products:manage, which this admin lacks')
    assert.equal(listeners.size, 0)
    assert.equal(mediaListeners.size, 0)
  })

  it('asks the browser the same question the stylesheet answers (1024px), and returns focus to the menu button on Escape and on the backdrop', () => {
    assert.match(LAYOUT_SRC, /const DRAWER_QUERY = '\(max-width: 1024px\)'/)
    assert.ok(CSS.includes(DRAWER + ' {'), 'the stylesheet has a block for the same width')
    assert.match(LAYOUT_SRC, /event\.key === 'Escape'[\s\S]{0,120}setMenuOpen\(false\)[\s\S]{0,60}menuButton\.current\?\.focus\(\)/, 'Escape returns focus to the button')
    assert.match(LAYOUT_SRC, /admin-drawer-backdrop[\s\S]{0,160}menuButton\.current\?\.focus\(\)/, 'so does the backdrop')
    assert.match(LAYOUT_SRC, /links\(\)\[0\]\?\.focus\(\)/, 'opening moves focus to the first link')
    assert.match(LAYOUT_SRC, /event\.key !== 'Tab'/, 'Tab is kept between the menu button and the drawer links')
  })

  it('does not animate the links\' visibility (a link "hidden" for its first frame cannot take focus)', () => {
    assert.doesNotMatch(LAYOUT_SRC, /transition:\s*'all /)
  })
})

describe('Admin shell: breakpoints (stylesheet)', () => {
  it('desktop: the fixed 260px sidebar under the 64px header, content offset by it, no menu button or backdrop', () => {
    const sidebar = ruleBody('.admin-sidebar')
    assert.equal(declared(sidebar, 'position'), 'fixed')
    assert.equal(declared(sidebar, 'top'), '64px')
    assert.equal(declared(sidebar, 'width'), '260px')
    assert.equal(declared(sidebar, 'bottom'), '0')
    assert.equal(declared(ruleBody('.admin-content'), 'margin-left'), '260px')
    assert.equal(declared(ruleBody('.admin-content'), 'padding'), '1.75rem 2.25rem', 'the desktop padding is unchanged')
    assert.equal(declared(ruleBody('.admin-menu-btn'), 'display'), 'none')
    assert.equal(declared(ruleBody('.admin-drawer-backdrop'), 'display'), 'none')
    assert.equal(declared(ruleBody('.admin-header-brand'), 'width'), '250px')
    assert.equal(declared(ruleBody('.admin-header'), 'padding'), '0 1.5rem')
  })

  it('tablet and phone (≤1024px): the content takes the full width and the menu button appears', () => {
    const css = drawerCss()
    assert.equal(declared(ruleBody('.admin-content', css), 'margin-left'), '0')
    assert.equal(declared(ruleBody('.admin-menu-btn', css), 'display'), 'inline-flex')
    assert.equal(declared(ruleBody('.admin-header-brand', css), 'width'), 'auto')
    assert.equal(declared(ruleBody('.admin-content', css), 'padding'), '1.5rem 1.25rem')
  })

  it('a closed drawer is off screen AND out of the tab order and the accessibility tree; an open one is shown', () => {
    const css = drawerCss()
    const closed = ruleBody('.admin-sidebar', css)
    assert.equal(declared(closed, 'visibility'), 'hidden', 'Tab can never land on a link nobody can see')
    assert.equal(declared(closed, 'transform'), 'translateX(-100%)')
    assert.match(declared(closed, 'transition') ?? '', /visibility 0s linear 0\.25s/, 'hidden only after the slide-out has finished')
    const shown = ruleBody('.admin-sidebar.open', css)
    assert.equal(declared(shown, 'visibility'), 'visible')
    assert.equal(declared(shown, 'transform'), 'translateX(0)')
    assert.match(declared(shown, 'transition') ?? '', /visibility 0s[,;]?/, 'visible at once when opening')
    assert.match(declared(shown, 'box-shadow') ?? '', /rgba/, 'the shadow only exists while open (a closed drawer\'s shadow would bleed onto the page)')
    assert.equal(declared(closed, 'width'), 'min(280px, 86vw)', 'a little page always stays visible next to it, even at 320px')
  })

  it('stacks the drawer above the dimmed page, and the dimmed page below the header, so the menu button stays usable', () => {
    const css = drawerCss()
    const header = 40 // inline zIndex of the header in layout.tsx
    assert.match(LAYOUT_SRC, /position: 'sticky',\s*top: 0,\s*zIndex: 40,/)
    const sidebarZ = Number(declared(ruleBody('.admin-sidebar', css), 'z-index'))
    const backdrop = ruleBody('.admin-drawer-backdrop', css)
    const backdropZ = Number(declared(backdrop, 'z-index'))
    assert.ok(sidebarZ > backdropZ && backdropZ > header, `sidebar ${sidebarZ} > backdrop ${backdropZ} > header ${header}`)
    assert.equal(declared(backdrop, 'position'), 'fixed')
    assert.equal(declared(backdrop, 'top'), '64px', 'starts under the header')
    assert.equal(declared(backdrop, 'display'), 'block')
  })

  it('respects reduced motion, and shows a visible focus ring on the menu button and on the drawer links', () => {
    assert.match(blockWith('@media (prefers-reduced-motion: reduce)', '.admin-sidebar'), /transition:\s*none/)
    assert.match(declared(ruleBody('.admin-menu-btn:focus-visible'), 'outline') ?? '', /^2px solid var\(--border-focus\)$/)
    const link = ruleBody('.admin-sidebar a:focus-visible')
    assert.match(declared(link, 'outline') ?? '', /^2px solid var\(--border-focus\)$/)
    assert.equal(declared(link, 'outline-offset'), '-2px', 'drawn inside the link: the list scrolls, so an outside ring would be cut off')
    assert.ok(Number.parseInt(declared(ruleBody('.admin-menu-btn'), 'width') ?? '0') >= 40, 'a comfortable touch target')
  })

  it('the header sheds pieces step by step so it fits 320px: status chip, user name, brand text, System theme and user chip', () => {
    assert.match(blockWith('@media (max-width: 900px)', '.admin-header-status'), /\.admin-header-status\s*\{\s*display:\s*none\s*!important/)
    const phone = blockWith('@media (max-width: 640px)', '.admin-header-user-text')
    assert.equal(declared(ruleBody('.admin-header-user-text', phone), 'display'), 'none')
    assert.equal(declared(ruleBody('.admin-content', phone), 'padding'), '1rem 0.75rem')
    assert.equal(declared(ruleBody('.admin-header', phone), 'padding'), '0 0.75rem')
    assert.equal(declared(ruleBody('.admin-header-brand-text', blockWith('@media (max-width: 480px)', '.admin-header-brand-text')), 'display'), 'none')
    const tiny = blockWith('@media (max-width: 380px)', '.admin-header-user')
    assert.match(tiny, /\.admin-header-theme > button:nth-child\(3\)/, 'the System option goes first (Light / Dark remain)')
    assert.match(tiny, /\.admin-header-user\s*\{\s*display:\s*none\s*!important/)
    // the pieces the rules above act on exist in the layout
    for (const name of ['admin-header', 'admin-header-brand', 'admin-header-brand-text', 'admin-header-status', 'admin-header-controls', 'admin-header-theme', 'admin-header-user', 'admin-header-user-text']) {
      assert.ok(LAYOUT_SRC.includes(name), `layout.tsx uses .${name}`)
    }
  })

  it('keeps Sign out and the notification bell on the header at every width (nothing that does something is hidden)', () => {
    const hidden = [...CSS.matchAll(/(\.admin-header[\w-]*|\.admin-header-theme > button:nth-child\(3\))[^{}]*\{[^{}]*display:\s*none/g)].map((m) => m[1])
    assert.ok(!hidden.some((h) => /controls/.test(h)), 'the controls row is never hidden')
    assert.match(LAYOUT_SRC, />\s*Sign out\s*</)
    assert.ok(!/admin-header-controls[^{}]*\{[^{}]*display:\s*none/.test(CSS))
  })
})

describe('Admin shell: no sideways scroll (stylesheet)', () => {
  it('long names, IDs, file names and URLs wrap anywhere inside the admin content', () => {
    assert.equal(declared(ruleBody('.admin-content'), 'overflow-wrap'), 'anywhere')
  })

  it('but tables scroll inside their own box instead of squeezing their columns, and short labels never break inside a word', () => {
    const exempt = CSS.match(/\.admin-content \.table-wrap,\n\.admin-content \.tabs,\n\.admin-content :where\(([^)]*)\) \{ overflow-wrap: normal; \}/)
    assert.ok(exempt, 'the exemption rule exists')
    for (const name of ['button', '.btn', '.badge', '.tab', '.admin-dash-chip', '.kpi-ref-badge']) assert.ok(exempt[1].includes(name), `${name} is exempt`)
    assert.equal(declared(ruleBody('.table-wrap'), 'overflow-x'), 'auto')
  })

  it('a table directly in a card (no scroll box) wraps its cells, and so does the notification list', () => {
    assert.match(CSS, /\.card > table th,\n\.card > table td \{ overflow-wrap: anywhere; \}/)
    assert.equal(declared(ruleBody('.notification-list'), 'overflow-wrap'), 'anywhere')
  })

  it('every table in the admin code sits in a scroll box or directly in a card', () => {
    const unwrapped: string[] = []
    const scan = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) scan(full)
        else if (/\.tsx$/.test(entry.name)) {
          const lines = fs.readFileSync(full, 'utf8').replace(/\r/g, '').split('\n')
          lines.forEach((line, i) => {
            if (!/<table[\s>]/.test(line)) return
            const nearby = lines.slice(Math.max(0, i - 3), i + 1).join(' ')
            if (/table-wrap|overflow/.test(nearby)) return
            // not in a scroll box: the line before must open a card, otherwise a wide table would push the page wider
            const parent = lines.slice(Math.max(0, i - 3), i).reverse().find((l) => /<[a-zA-Z]/.test(l)) ?? ''
            const heading = lines.slice(Math.max(0, i - 3), i).join(' ')
            if (!/className="card[ "]/.test(parent) && !/className="card[ "]/.test(heading)) unwrapped.push(`${path.relative(WEB, full)}:${i + 1}`)
          })
        }
      }
    }
    scan(path.join(WEB, 'app/admin'))
    scan(path.join(WEB, 'components'))
    assert.deepEqual(unwrapped, [])
  })

  it('grid tracks the admin pages use can shrink below their content (no bare 1fr), so one long value cannot stretch a column', () => {
    const offenders = rulesMentioning(/\.grid-2|\.kpi-grid|\.analytics-grid|\.dash-grid|\.bar-row|dl\.details/)
      .map((r) => ({ selector: r.selector, columns: declared(r.body, 'grid-template-columns') }))
      .filter((r) => r.columns !== undefined)
      // a track is only safe if its minimum is fixed: strip every minmax(<min>, <max>) and see whether any flexible track is left
      .filter((r) => /(^|[\s(,])[\d.]*fr\b/.test(r.columns!.replace(/minmax\([^()]*(\([^()]*\)[^()]*)*\)/g, '')))
    assert.deepEqual(offenders, [])
  })

  it('a details list gives its label column room to shrink on tablets, and stacks on phones; desktop keeps 220px', () => {
    assert.equal(declared(ruleBody('dl.details'), 'grid-template-columns'), '220px minmax(0, 1fr)')
    assert.equal(declared(ruleBody('dl.details', blockWith('@media (max-width: 1024px)', 'dl.details')), 'grid-template-columns'), 'minmax(6.5rem, min(220px, 35%)) minmax(0, 1fr)')
    assert.equal(declared(ruleBody('dl.details', blockWith('@media (max-width: 640px)', 'dl.details')), 'grid-template-columns'), 'minmax(0, 1fr)')
  })

  it('a dialog never outgrows the screen: it scrolls inside itself, with dvh for phone address bars and tighter padding on phones', () => {
    const modal = ruleBody('.modal')
    assert.match(modal, /max-height:\s*calc\(100vh - 2\.5rem\);\s*max-height:\s*calc\(100dvh - 2\.5rem\);/, 'vh first as a fallback, then dvh')
    assert.equal(declared(modal, 'overflow-y'), 'auto')
    assert.equal(declared(modal, 'overscroll-behavior'), 'contain')
    assert.equal(declared(modal, 'width'), '100%')
    assert.equal(declared(ruleBody('.modal-backdrop'), 'padding'), '1.25rem')
    const phone = blockWith('@media (max-width: 480px)', '.modal-backdrop')
    assert.equal(declared(ruleBody('.modal-backdrop', phone), 'padding'), '0.5rem')
    assert.match(ruleBody('.modal', phone), /max-height:\s*calc\(100dvh - 1rem\)/)
  })
})
