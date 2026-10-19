import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { jsx, mountPage } from './helpers/render-page'

/**
 * Two Admin UI regressions found in the browser:
 *  1. /admin in Light mode: the KPI tiles stay dark but their values used --text-heading (dark in Light), so the numbers were
 *     unreadable (1.01:1); the chart month labels (#94a3b8 on a white card), the "Peak" / count chips and the pending-activation
 *     amounts were light colours on a theme surface (2.5:1 or less). Text on the always-dark tile is now a fixed light colour;
 *     text on theme surfaces follows the theme and reaches AA (4.5:1) in Light and Dark.
 *  2. The shared .tabs bar scrolled vertically by 2px (an 8px scrollbar thumb on every tab bar): its 2px border plus the tabs'
 *     -2px margin overflowed the padding box. The rule is now an inset shadow with no overlap, and the bar is the same height.
 *
 * The real, unmodified dashboard page runs in Node through tests/helpers/render-page.ts against scripted API stubs; the CSS is read
 * from globals.css. Database-free; nothing here reads `.env`, runs Prisma or opens a connection.
 */

const WEB = path.resolve(__dirname, '../../web/src')
const PAGE = path.join(WEB, 'app/admin/page.tsx')
const CSS = fs.readFileSync(path.join(WEB, 'app/globals.css'), 'utf8')
const PAGE_SRC = fs.readFileSync(PAGE, 'utf8')
const format = require('../../web/src/lib/format')
const activationTypes = require('../../web/src/lib/activation-types')
const adminTypes = require('../../web/src/lib/admin-types')

type Row = Record<string, any>
type Rgba = [number, number, number, number]

/* ─── colour helpers ─────────────────────────────────────────────────────── */

const parseColor = (value: string): Rgba => {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim())
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1) as Rgba
  const rgba = /^rgba?\(([^)]+)\)$/.exec(value.trim())
  assert.ok(rgba, `cannot read the colour "${value}"`)
  const [r, g, b, a = 1] = rgba[1].split(',').map(Number)
  return [r, g, b, a]
}
const over = (top: Rgba, bottom: Rgba): Rgba => [0, 1, 2].map((i) => top[i] * top[3] + bottom[i] * (1 - top[3])).concat(1) as Rgba
const luminance = ([r, g, b]: Rgba) => {
  const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
const contrast = (a: Rgba, b: Rgba) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05)

/** The `--token: value;` declarations of one theme block of globals.css (from `start` to the next closing brace). */
const themeTokens = (start: string): Record<string, string> => {
  const from = CSS.indexOf(start)
  assert.ok(from >= 0, `globals.css has no ${start} block`)
  const block = CSS.slice(from, CSS.indexOf('}', from))
  return Object.fromEntries([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].replace(/\/\*.*?\*\//g, '').trim()]))
}
const THEMES = { Dark: themeTokens(':root,'), Light: themeTokens("html[data-theme='light'],") } as const

/** Declarations of the rule whose selector list is exactly `selector` (first match). */
const ruleBody = (selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(CSS)
  assert.ok(match, `globals.css has no rule for ${selector}`)
  return match[1]
}
const declaration = (body: string, property: string): string | undefined =>
  new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+);`).exec(body)?.[1].trim()

/* ─── 1a. dashboard rendered by the real page ────────────────────────────── */

const TILE_BACKGROUND = '#0f1523'
const dashboard = {
  period: '2026-10',
  kpis: {
    totalResellers: 2,
    suspendedResellers: 0,
    pendingApprovals: 0,
    activeCustomers: 1,
    activeSubscriptions: 1,
    trialAccounts: 0,
    pendingActivations: { total: 1, pendingReview: 1, underReview: 0, awaitingActivation: 0 },
    monthlyActivations: 1,
    commission: { currency: 'LKR', pending: '550', payable: '0', awaitingApprovalCount: 0, paid: '0', paidThisMonth: '0' },
  },
  activationTrend: [
    { periodMonth: '2026-08', count: 0 },
    { periodMonth: '2026-09', count: 0 },
    { periodMonth: '2026-10', count: 1 },
  ],
  queue: {
    applications: [],
    activations: [
      {
        id: 'a1',
        reference: 'AR-1',
        status: 'PENDING_REVIEW',
        amount: '550',
        currency: 'LKR',
        submittedAt: '2026-10-01T00:00:00.000Z',
        paymentVerifiedAt: null,
        product: { name: 'Hexalyte Salon' },
        reseller: { code: 'R1', businessName: 'Trader' },
        customerAccount: { customer: { displayName: 'Customer One' } },
      },
    ],
  },
  attention: { failedTrials7d: 0, integrationErrors: [], failedActivations: 0 },
  recentAudit: [],
  sections: {
    resellers: 2,
    pendingApplications: 0,
    products: 4,
    customers: 1,
    trials: 0,
    openActivations: 1,
    bankSlips: 1,
    unreadNotifications: 1,
    pendingDemoRequests: 0,
  },
}

const findAll = (node: any, test: (el: Row) => boolean): Row[] => {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap((n) => findAll(n, test))
  return [...(test(node) ? [node] : []), ...findAll(node.props?.children, test)]
}
const flatten = (node: any): string =>
  node === null || node === undefined ? '' : typeof node === 'object' ? (Array.isArray(node) ? node.map(flatten).join('') : flatten(node.props?.children)) : String(node)

const openDashboard = async () => {
  const page = mountPage(PAGE, {
    'next/link': { __esModule: true, default: ({ href, children, className, style }: Row) => jsx('a', { href, className, style, children }) },
    '@/lib/api': {
      ApiError: class extends Error {},
      api: async () => structuredClone(dashboard),
      apiRequest: async () => ({ data: [], meta: { pipelineCounts: { pending: 0, approved: 0, demoCreated: 0, total: 0 } } }),
    },
    '@/lib/admin-context': { useAdminUser: () => ({ permissions: ['demos:read'] }) },
    '@/lib/format': format,
    '@/lib/activation-types': activationTypes,
    '@/lib/admin-types': adminTypes,
  })
  await page.settle()
  return page
}

describe('Admin dashboard: text is readable in Light and Dark', () => {
  it('the KPI tiles are dark in both themes, so their values are a fixed light colour — never the theme heading colour', async () => {
    const root = (await openDashboard()).root()
    const tiles = findAll(root, (el) => el.props?.style?.background === TILE_BACKGROUND)
    assert.equal(tiles.length, 8, 'all eight tiles are rendered')
    for (const tile of tiles) {
      const value = findAll(tile, (el) => el.props?.style?.fontVariantNumeric === 'tabular-nums')
      assert.equal(value.length, 1)
      assert.equal(value[0].props.style.color, '#f8fafc', `value "${flatten(value[0].props.children)}"`)
    }
  })

  it('every colour inside a KPI tile reads on the tile background at AA (4.5:1) — in both themes, since the tile does not change', async () => {
    const root = (await openDashboard()).root()
    const background = parseColor(TILE_BACKGROUND)
    const [tile] = findAll(root, (el) => el.props?.style?.background === TILE_BACKGROUND)
    const colours = new Set(
      findAll(tile, (el) => typeof el.props?.style?.color === 'string' && flatten(el.props.children).trim() !== '').map((el) => el.props.style.color as string),
    )
    assert.ok(colours.size >= 2, 'the tile has a label, a value and a hint')
    for (const colour of colours) {
      assert.doesNotMatch(colour, /var\(/, `${colour} would change with the theme while the tile stays dark`)
      assert.ok(contrast(parseColor(colour), background) >= 4.5, `${colour} on the tile is ${contrast(parseColor(colour), background).toFixed(2)}:1`)
    }
  })

  it('the chart month labels follow the theme (they sit on the card), and the bar track is visible in both themes', async () => {
    const root = (await openDashboard()).root()
    const labels = findAll(root, (el) => el.props?.style?.width === '85px')
    assert.equal(labels.length, 3)
    for (const label of labels) assert.equal(label.props.style.color, 'var(--text-secondary)')
    const tracks = findAll(root, (el) => el.props?.style?.height === '14px' && el.props?.style?.borderRadius === '9999px' && el.props?.style?.overflow === 'hidden')
    assert.equal(tracks.length, 3)
    for (const track of tracks) assert.equal(track.props.style.background, 'var(--toggle-bg)', 'was white-at-5%, invisible on a white card')
  })

  it('the Peak chip, the directory count chips and the pending-activation amount take their colour from the stylesheet, not inline', async () => {
    const root = (await openDashboard()).root()
    const chips = findAll(root, (el) => String(el.props?.className ?? '').includes('admin-dash-chip'))
    assert.ok(chips.length >= 2, 'Peak chip plus at least one directory count chip')
    for (const chip of chips) {
      for (const property of ['color', 'background', 'border']) assert.equal(chip.props.style?.[property], undefined, `inline ${property} would beat the Light-theme rule`)
    }
    assert.ok(chips.some((c) => flatten(c.props.children).startsWith('Peak:')))
    const [amount] = findAll(root, (el) => String(el.props?.className ?? '').includes('admin-dash-amount'))
    assert.ok(amount, 'the pending activation shows its amount')
    assert.equal(amount.props.style?.color, undefined)
    assert.match(flatten(amount.props.children), /550/)
  })

  it('no light-only colour is left on text that sits on a theme surface (only the always-dark tile may use fixed light colours)', () => {
    const outsideTile = PAGE_SRC.slice(PAGE_SRC.indexOf('const ago = '))
    assert.doesNotMatch(outsideTile, /color:\s*'#(94a3b8|818cf8|34d399)'/i)
  })
})

describe('Admin dashboard stylesheet: chips and amounts reach AA on the card in both themes', () => {
  for (const theme of ['Dark', 'Light'] as const) {
    const tokens = THEMES[theme]
    const card = () => parseColor(tokens['--surface'])

    it(`${theme}: chart labels (--text-secondary) and values (--text-heading) on the card`, () => {
      for (const token of ['--text-secondary', '--text-heading']) {
        const ratio = contrast(parseColor(tokens[token]), card())
        assert.ok(ratio >= 4.5, `${token} on the ${theme} card is ${ratio.toFixed(2)}:1`)
      }
    })

    it(`${theme}: .admin-dash-chip and .admin-dash-amount text`, () => {
      const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const colorFor = (selector: string): string => {
        const base = declaration(ruleBody(selector), 'color')!
        if (theme === 'Dark') return base
        // Whitespace-tolerant (the file may use CRLF line endings).
        const match = new RegExp(`html\\[data-theme='light'\\]\\s+${escape(selector)}\\s*,\\s*\\.light-theme\\s+${escape(selector)}\\s*\\{([^}]*)\\}`).exec(CSS)
        assert.ok(match, `the Light theme has its own rule for ${selector}`)
        return declaration(match[1], 'color')!
      }
      const chipTint = parseColor(declaration(ruleBody('.admin-dash-chip'), 'background')!)
      const chipBackground = over(chipTint, card())
      const chip = contrast(parseColor(colorFor('.admin-dash-chip')), chipBackground)
      const amount = contrast(parseColor(colorFor('.admin-dash-amount')), card())
      assert.ok(chip >= 4.5, `chip text on the ${theme} card is ${chip.toFixed(2)}:1`)
      assert.ok(amount >= 4.5, `amount text on the ${theme} card is ${amount.toFixed(2)}:1`)
    })
  }

  it('the tokens the dashboard uses exist in both themes', () => {
    for (const theme of ['Dark', 'Light'] as const) {
      for (const token of ['--surface', '--text-secondary', '--text-heading', '--toggle-bg', '--border']) {
        assert.ok(THEMES[theme][token], `${token} is defined for the ${theme} theme`)
      }
    }
  })
})

/* ─── 2. shared tab bar ──────────────────────────────────────────────────── */

describe('Shared .tabs bar: no 2px overflow, no vertical scrollbar', () => {
  const tabs = () => ruleBody('.tabs')
  const tab = () => ruleBody('.tab')

  it('draws its 2px rule as an inset shadow instead of a border the tabs have to overlap', () => {
    assert.equal(declaration(tabs(), 'border-bottom'), undefined)
    assert.equal(declaration(tabs(), 'box-shadow'), 'inset 0 -2px 0 var(--border)')
  })

  it('the tabs no longer pull themselves 2px out of the box (the cause of the overflow)', () => {
    assert.equal(declaration(tab(), 'margin-bottom'), undefined)
    assert.equal(declaration(tab(), 'border-bottom'), '2px solid transparent', 'the active underline still has its 2px')
    assert.match(declaration(ruleBody('.tab.active'), 'border-bottom-color') ?? '', /var\(--primary\)/)
  })

  it('keeps sideways scrolling for narrow screens and never scrolls vertically', () => {
    assert.equal(declaration(tabs(), 'overflow-x'), 'auto')
    assert.equal(declaration(tabs(), 'overflow-y'), 'hidden')
    assert.equal(declaration(tabs(), 'display'), 'flex')
    assert.equal(declaration(tab(), 'white-space'), 'nowrap', 'tabs stay on one line and scroll instead of wrapping')
  })

  it('keeps the spacing below the bar and the gap between tabs', () => {
    assert.equal(declaration(tabs(), 'margin-bottom'), '1.25rem')
    assert.equal(declaration(tabs(), 'gap'), '0.4rem')
  })

  it('no other rule gives the tab bar a border or a tab a negative margin again', () => {
    const others = [...CSS.matchAll(/([^{}]*\.tabs?\b[^{}]*)\{([^}]*)\}/g)].filter((m) => !/^\s*\.tabs?\s*$/.test(m[1].trim()) || false)
    for (const [, selector, body] of others) {
      if (/\.tabs\b/.test(selector) && !/\.tab\b/.test(selector)) assert.doesNotMatch(body, /border-bottom/, `${selector.trim()} must not add a border`)
      assert.doesNotMatch(body, /margin-bottom:\s*-/, `${selector.trim()} must not use a negative margin`)
    }
  })
})
