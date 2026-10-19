import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { jsx, mountPage } from './helpers/render-page'

/**
 * The Admin header (apps/web/src/app/admin/layout.tsx):
 *  - the notification bell shows the signed-in admin's REAL unread count (GET /notifications/unread-count, the endpoint the reseller
 *    header already uses) — never a made-up number: hidden at 0 and when the count cannot be loaded, "99+" above 99, refreshed on focus
 *    and when the inbox changes read state;
 *  - the role chip shows the role the server returned for the signed-in user instead of a fixed "SUPER ADMIN";
 *  - the user chip is painted with theme tokens (not fixed light-on-dark colours), and those tokens give readable text in Light and Dark.
 *
 * The real, unmodified layout and bell run in Node through tests/helpers/render-page.ts against scripted stubs.
 * Database-free; nothing here reads `.env`, runs Prisma or opens a connection.
 */

const WEB = path.resolve(__dirname, '../../web/src')
const LAYOUT = path.join(WEB, 'app/admin/layout.tsx')
const BELL = path.join(WEB, 'components/notifications/NotificationBell.tsx')
const { roleLabel } = require('../../web/src/lib/role-label') as typeof import('../../web/src/lib/role-label')

type Row = Record<string, any>
type Step = () => Promise<unknown>
const ok = (value: unknown): Step => async () => structuredClone(value)
const fail = (error: unknown): Step => async () => {
  throw error
}
/** Text of every element whose inline style has this colour (the role line is the only text in the header that uses it). */
const flatten = (node: any): string =>
  node === null || node === undefined ? '' : typeof node === 'object' ? (Array.isArray(node) ? node.map(flatten).join('') : flatten(node.props?.children)) : String(node)
const textWithColor = (node: any, color: string): string[] => {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap((n) => textWithColor(n, color))
  const own = node.props?.style?.color === color ? [flatten(node.props.children)] : []
  return [...own, ...textWithColor(node.props?.children, color)]
}
const ROLE_CHIP_COLOR = 'var(--text-secondary)'
const link = { __esModule: true, default: ({ href, children }: { href: string; children: unknown }) => jsx('a', { href, children }) }

describe('roleLabel', () => {
  it('turns the server role into a display name', () => {
    assert.equal(roleLabel('ADMIN'), 'Admin')
    assert.equal(roleLabel('SELLER'), 'Seller')
  })

  it('handles multi-word roles and odd casing', () => {
    assert.equal(roleLabel('SUPER_ADMIN'), 'Super Admin')
    assert.equal(roleLabel('finance'), 'Finance')
    assert.equal(roleLabel('RESELLER__AGENT'), 'Reseller Agent')
  })

  it('returns nothing (not a made-up role) when there is no role', () => {
    assert.equal(roleLabel(undefined), '')
    assert.equal(roleLabel(null), '')
    assert.equal(roleLabel(''), '')
  })
})

describe('Admin header notification bell', () => {
  let calls: string[]
  let script: Step[]
  let listeners: Record<string, Array<() => void>>
  let visibility: string
  let mounted: Array<{ unmount: () => void }>

  const open = async () => {
    const page = mountPage(BELL, { 'next/link': link, '@/lib/api': { api: async (url: string) => (calls.push(url), (script.shift() ?? (() => Promise.reject(new Error('unexpected extra request'))))()) } }, {
      exportName: 'NotificationBell',
      props: { href: '/admin/notifications' },
    })
    mounted.push(page)
    await page.settle()
    return page
  }
  const fire = async (page: Awaited<ReturnType<typeof open>>, event: string) => {
    for (const fn of listeners[event] ?? []) fn()
    await page.settle()
  }

  beforeEach(() => {
    calls = []
    script = []
    listeners = {}
    visibility = 'visible'
    mounted = []
    ;(globalThis as any).window = {
      addEventListener: (name: string, fn: () => void) => (listeners[name] ??= []).push(fn),
      removeEventListener: (name: string, fn: () => void) => (listeners[name] = (listeners[name] ?? []).filter((f) => f !== fn)),
    }
    ;(globalThis as any).document = {
      get visibilityState() {
        return visibility
      },
    }
  })
  afterEach(() => {
    for (const page of mounted) page.unmount()
    delete (globalThis as any).window
    delete (globalThis as any).document
  })

  it('asks the existing unread-count endpoint and links to the admin inbox', async () => {
    script = [ok({ count: 4 })]
    const page = await open()
    assert.deepEqual(calls, ['/notifications/unread-count'])
    assert.deepEqual(page.links().map((l) => l.href), ['/admin/notifications'])
  })

  it('shows the count the server returned', async () => {
    script = [ok({ count: 7 })]
    const page = await open()
    assert.equal(page.textOfClass('header-bell-count')[0], '7')
  })

  it('caps the badge at 99+', async () => {
    script = [ok({ count: 250 })]
    const page = await open()
    assert.equal(page.textOfClass('header-bell-count')[0], '99+')
  })

  it('shows no badge when nothing is unread', async () => {
    script = [ok({ count: 0 })]
    const page = await open()
    assert.deepEqual(page.textOfClass('header-bell-count'), [])
  })

  it('shows no badge — and no invented number — when the count cannot be loaded', async () => {
    script = [fail(new Error('network down'))]
    const page = await open()
    assert.deepEqual(page.textOfClass('header-bell-count'), [])
    assert.ok(!/\d/.test(page.text()))
  })

  it('shows no badge when the response has no numeric count', async () => {
    script = [ok({})]
    const page = await open()
    assert.deepEqual(page.textOfClass('header-bell-count'), [])
  })

  it('refreshes when the inbox marks notifications read, and when the window regains focus', async () => {
    script = [ok({ count: 3 }), ok({ count: 0 }), ok({ count: 2 })]
    const page = await open()
    assert.equal(page.textOfClass('header-bell-count')[0], '3')
    await fire(page, 'hxr:notifications-changed')
    assert.deepEqual(page.textOfClass('header-bell-count'), [], 'read-all cleared the badge straight away')
    await fire(page, 'focus')
    assert.equal(page.textOfClass('header-bell-count')[0], '2')
    assert.equal(calls.length, 3)
  })

  it('stops listening when the header unmounts', async () => {
    script = [ok({ count: 1 })]
    const page = await open()
    page.unmount()
    assert.deepEqual(listeners['focus'], [])
    assert.deepEqual(listeners['hxr:notifications-changed'], [])
  })
})

describe('Admin layout header', () => {
  let bellProps: Row[]

  const open = async (user: Row) => {
    const page = mountPage(
      LAYOUT,
      {
        'next/link': link,
        'next/navigation': { usePathname: () => '/admin', useRouter: () => ({ replace() {} }) },
        '@/lib/auth': { isPlatformUser: () => true, logout: async () => {}, useCurrentUser: () => user },
        '@/lib/admin-context': { AdminUserContext: { Provider: ({ children }: { children: unknown }) => children } },
        '@/components/ThemeToggle': { ThemeToggle: () => null },
        '@/components/PlatformLogo': { PlatformLogo: ({ fallback }: { fallback: unknown }) => fallback },
        '@/components/notifications/NotificationBell': {
          NotificationBell: (props: Row) => (bellProps.push(props), jsx('span', { className: 'bell-stub', children: 'bell' })),
        },
        '@/lib/appearance': { useAppearance: () => null },
        '@/lib/role-label': require('../../web/src/lib/role-label'),
      },
      { props: { children: jsx('main', { children: 'content' }) } },
    )
    await page.settle()
    return page
  }

  beforeEach(() => {
    bellProps = []
  })

  const admin = (over: Row = {}): Row => ({ id: 'u1', name: 'Kasun Perera', email: 'k@test.invalid', role: 'ADMIN', permissions: [], ...over })

  it('renders the real notification bell pointing at the admin inbox, not a fixed badge', async () => {
    const page = await open(admin())
    assert.equal(bellProps.length, 1)
    assert.equal(bellProps[0].href, '/admin/notifications')
    assert.equal(page.textOfClass('bell-stub').length, 1)
  })

  it('shows the signed-in user\'s own role in the chip, not "SUPER ADMIN"', async () => {
    const page = await open(admin({ role: 'ADMIN' }))
    assert.deepEqual(textWithColor(page.root(), ROLE_CHIP_COLOR), ['Admin'])
    assert.ok(!/super admin/i.test(page.text()), 'a plain Admin is no longer labelled Super Admin')
    assert.ok(page.text().includes('Kasun Perera'))
  })

  it('follows whatever role the server returns for the signed-in user', async () => {
    const page = await open(admin({ role: 'FINANCE' }))
    assert.deepEqual(textWithColor(page.root(), ROLE_CHIP_COLOR), ['Finance'])
  })

  it('shows an empty chip rather than an invented role when the user has none', async () => {
    const page = await open(admin({ role: undefined }))
    assert.deepEqual(textWithColor(page.root(), ROLE_CHIP_COLOR), [''])
    assert.ok(!/super admin/i.test(page.text()))
  })

  it('does not contain the old hard-coded badge or label in its source', () => {
    const src = fs.readFileSync(LAYOUT, 'utf8')
    assert.doesNotMatch(src, /SUPER ADMIN/)
    assert.doesNotMatch(src, />\s*3\s*<\/span>/)
    assert.match(src, /<NotificationBell\b/)
    assert.match(src, /roleLabel\(user\.role\)/)
  })
})

/* ─── user chip: readable in both themes ─────────────────────────────────── */

const GLOBALS = path.join(WEB, 'app/globals.css')
type Rgba = [number, number, number, number]

const findAll = (node: any, test: (el: Row) => boolean): Row[] => {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap((n) => findAll(n, test))
  return [...(test(node) ? [node] : []), ...findAll(node.props?.children, test)]
}

/** The `--token: value;` declarations of one theme block of globals.css (from `start` to the next closing brace). */
const themeTokens = (css: string, start: string): Record<string, string> => {
  const from = css.indexOf(start)
  assert.ok(from >= 0, `globals.css has no ${start} block`)
  const block = css.slice(from, css.indexOf('}', from))
  return Object.fromEntries([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].replace(/\/\*.*?\*\//g, '').trim()]))
}
const parseColor = (value: string): Rgba => {
  const hex = /^#([0-9a-f]{6})$/i.exec(value)
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1) as Rgba
  const rgba = /^rgba?\(([^)]+)\)$/.exec(value)
  assert.ok(rgba, `cannot read the colour "${value}"`)
  const [r, g, b, a = 1] = rgba[1].split(',').map(Number)
  return [r, g, b, a]
}
const over = (top: Rgba, bottom: Rgba): Rgba => {
  const a = top[3]
  return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a)).concat(1) as Rgba
}
const luminance = ([r, g, b]: Rgba) => {
  const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
const contrast = (a: Rgba, b: Rgba) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05)

describe('Admin header user chip: readable in Light and Dark', () => {
  const user = { id: 'u1', name: 'Kasun Perera', email: 'k@test.invalid', role: 'ADMIN', permissions: [] }
  const mountLayout = async () => {
    const page = mountPage(
      LAYOUT,
      {
        'next/link': link,
        'next/navigation': { usePathname: () => '/admin', useRouter: () => ({ replace() {} }) },
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
    return page.root()
  }
  const chipOf = (root: Row) => {
    const [chip] = findAll(root, (el) => Boolean(el.props?.style?.border) && flatten(el.props.children).includes(user.name))
    assert.ok(chip, 'the user chip is rendered')
    return chip
  }
  const css = fs.readFileSync(GLOBALS, 'utf8')
  const themes = { Dark: themeTokens(css, ':root,'), Light: themeTokens(css, "html[data-theme='light'],") }

  it('paints the chip, the name and the role with theme tokens, not fixed light-on-dark colours', async () => {
    const chip = chipOf(await mountLayout())
    assert.equal(chip.props.style.background, 'var(--badge-bg-subtle)')
    assert.equal(chip.props.style.border, '1px solid var(--border)')
    const [name] = findAll(chip, (el) => flatten(el.props?.children) === user.name && Boolean(el.props?.style?.color))
    assert.equal(name.props.style.color, 'var(--text-heading)')
    const [role] = findAll(chip, (el) => flatten(el.props?.children) === 'Admin' && Boolean(el.props?.style?.color))
    assert.equal(role.props.style.color, 'var(--text-secondary)')
    assert.equal(role.props.style.textTransform, 'uppercase')
  })

  it('has no hard-coded whitish or white-tinted colours left in the chip (they vanish on a light header)', async () => {
    const styles = JSON.stringify(findAll(chipOf(await mountLayout()), (el) => Boolean(el.props?.style)).map((el) => el.props.style))
    assert.doesNotMatch(styles, /#f8fafc|#34d399|rgba\(\s*255,\s*255,\s*255/i)
  })

  it('white text is only used on the avatar, which paints its own background', async () => {
    const white = findAll(chipOf(await mountLayout()), (el) => String(el.props?.style?.color).toLowerCase() === '#fff')
    assert.equal(white.length, 1)
    assert.match(String(white[0].props.style.background), /gradient|#/)
  })

  for (const theme of ['Dark', 'Light'] as const) {
    describe(`${theme} theme`, () => {
      const tokens = themes[theme]

      it('defines every token the chip uses', () => {
        for (const name of ['--badge-bg-subtle', '--border', '--text-heading', '--text-secondary', '--header-bg', '--bg']) {
          assert.ok(tokens[name], `${name} is defined for the ${theme} theme`)
        }
      })

      it('gives name and role text at least AA contrast (4.5:1) on the chip', () => {
        const header = over(parseColor(tokens['--header-bg']), parseColor(tokens['--bg']))
        const chipBackground = over(parseColor(tokens['--badge-bg-subtle']), header)
        for (const token of ['--text-heading', '--text-secondary']) {
          const ratio = contrast(parseColor(tokens[token]), chipBackground)
          assert.ok(ratio >= 4.5, `${token} on the ${theme} chip is ${ratio.toFixed(2)}:1`)
        }
      })
    })
  }
})

describe('Admin settings wording', () => {
  it('says "Admin" where settings are read-only, not "Super Admin" (there is no such role)', () => {
    const settings = fs.readFileSync(path.join(WEB, 'app/admin/settings/page.tsx'), 'utf8')
    const appearance = fs.readFileSync(path.join(WEB, 'components/admin/AppearanceSettings.tsx'), 'utf8')
    assert.match(settings, /Read-only\. Only an Admin can change settings\./)
    assert.match(appearance, /Read-only: only an Admin can change them\./)
  })

  it('no Admin page or component calls anyone a "Super Admin"', () => {
    const offenders: string[] = []
    const scan = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) scan(full)
        else if (/\.tsx?$/.test(entry.name) && /super[\s_-]?admin/i.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(WEB, full))
      }
    }
    scan(path.join(WEB, 'app/admin'))
    scan(path.join(WEB, 'components/admin'))
    assert.deepEqual(offenders, [])
  })
})
