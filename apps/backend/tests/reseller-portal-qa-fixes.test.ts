import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { jsx, mountPage } from './helpers/render-page'

/**
 * Reseller portal fixes confirmed in the browser QA (results items 6, 22, 23, 24):
 *  - 23: the 404 page was invisible in dark mode (Next's built-in page sets its own colours); the app now has its own
 *        `not-found.tsx` that only uses the portal's theme classes, readable in both modes;
 *  - the error page (`error.tsx`) hard-coded its own greys and a dark button, so it clashed with Light mode; it now uses the same
 *        theme classes as the 404 page;
 *  - 6:  Demo Requests "Clear filters" emptied the search box but did not reload the list unless the status or page also changed;
 *  - 22: a long unbroken bank-slip file name made the activation detail scroll sideways on phones;
 *  - 24: the dashboard's "Last 6 Months ▾" looked like a drop-down but did nothing. The server always returns exactly six
 *        months (no range parameter exists), so it is now a plain label.
 *
 * The real, unmodified components run in Node through tests/helpers/render-page.ts against scripted API stubs; the stylesheet
 * is read as text. There is no browser here, so how a page looks is not checked, only the markup, the requests and the CSS
 * rules that decide it. Database-free; nothing here reads `.env`, runs Prisma or opens a connection.
 */

const WEB = path.resolve(__dirname, '../../web/src')
const read = (file: string) => fs.readFileSync(path.join(WEB, file), 'utf8').replace(/\r\n/g, '\n')
const css = read('app/globals.css')
const format = require('../../web/src/lib/format')
const demoTypes = require('../../web/src/lib/demo-types')
const activationTypes = require('../../web/src/lib/activation-types')
const { builtInText } = require('../../web/src/lib/i18n')

type Row = Record<string, any>
type Step = () => Promise<unknown>
const ok = (value: unknown): Step => async () => structuredClone(value)
const fail = (error: unknown): Step => async () => {
  throw error
}
class ApiError extends Error {
  constructor(message: string, public status = 0, public code?: string, public errors: string[] = []) {
    super(message)
  }
}
const all = (node: any, out: Row[] = []): Row[] => {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) return node.forEach((n) => all(n, out)), out
  out.push(node)
  all(node.props?.children, out)
  return out
}
const hasClass = (el: Row, name: string) => typeof el.props?.className === 'string' && el.props.className.split(/\s+/).includes(name)

/** The declarations of every top-level rule whose selector list is exactly `selector` (a selector can be set in several places). */
const rule = (selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const blocks = [...css.matchAll(new RegExp(`(?:^|\\n)${escaped} \\{[^}]*\\}`, 'g'))].map((m) => m[0])
  assert.ok(blocks.length > 0, `rule not found: ${selector}`)
  return blocks.join('\n')
}

/** WCAG contrast ratio of two #rrggbb colours. */
const channel = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
const THEMES = {
  dark: ":root,\nhtml[data-theme='dark'],\n.dark-theme",
  light: "html[data-theme='light'],\n.light-theme",
}
const token = (theme: 'dark' | 'light', name: string): string => {
  const m = rule(THEMES[theme]).match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))
  assert.ok(m, `${theme}: ${name} is not a #rrggbb colour`)
  return m[1]
}

/* ═══ 23: the 404 page ═══════════════════════════════════════════════════════ */

describe('404 page (dark and light mode)', () => {
  const FILE = path.join(WEB, 'app/not-found.tsx')
  const link = ({ href, className, children }: Row) => jsx('a', { href, className, children })
  const mount = () => mountPage(FILE, { 'next/link': { __esModule: true, default: link } })

  it('is the app\'s own page (not Next\'s built-in one): a heading, an explanation and a way back', async () => {
    const page = mount()
    await page.settle()
    const text = page.text().replace(/\s+/g, ' ')
    assert.ok(text.includes('404'), text)
    assert.ok(text.includes('Page not found'), text)
    assert.deepEqual(page.links(), [{ href: '/dashboard', text: 'Go to dashboard' }])
    assert.equal(all(page.root()).filter((el) => el.type === 'h1').length, 1)
    assert.equal(page.root().type, 'main')
  })

  it('sets no colour or background of its own: every colour comes from the portal\'s theme classes, so it follows dark and light mode', async () => {
    const page = mount()
    await page.settle()
    for (const el of all(page.root())) {
      const style = (el.props?.style ?? {}) as Row
      for (const key of Object.keys(style)) assert.ok(!/color|background|border|opacity/i.test(key), `<${el.type}> sets ${key}`)
    }
    const source = read('app/not-found.tsx')
    assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(|\b(white|black)\b/i.test(source.replace(/\/\*[\s\S]*?\*\//g, '')), 'a hard-coded colour in not-found.tsx')
    const classes = all(page.root()).flatMap((el) => String(el.props?.className ?? '').split(/\s+/)).filter(Boolean)
    for (const name of ['container', 'card', 'muted', 'btn']) assert.ok(classes.includes(name), `uses .${name}`)
  })

  for (const theme of ['dark', 'light'] as const) {
    it(`is readable in ${theme} mode: heading and body text on the card, and the button label, pass WCAG AA (4.5 : 1)`, () => {
      // The theme classes the page uses are what paint it: confirm each one reads the token we measure.
      assert.match(rule('.card'), /background: var\(--surface\)/)
      assert.match(rule('h1, h2, h3, h4'), /color: var\(--text-heading\)/)
      assert.match(rule('.muted'), /color: var\(--muted\)/)
      assert.match(rule('html, body'), /color: var\(--text\)/)
      assert.match(rule('.btn'), /background: var\(--primary\)/)
      assert.match(rule('.btn'), /color: #ffffff !important/)

      const surface = token(theme, '--surface')
      const results = {
        heading: contrast(token(theme, '--text-heading'), surface),
        muted: contrast(token(theme, '--muted'), surface),
        button: contrast('#ffffff', token(theme, '--primary')),
      }
      for (const [what, ratio] of Object.entries(results)) assert.ok(ratio >= 4.5, `${theme} ${what}: ${ratio.toFixed(2)} : 1`)
    })
  }
})

/* ═══ The error page (error.tsx) ═════════════════════════════════════════════ */

describe('Error page (dark and light mode)', () => {
  const FILE = path.join(WEB, 'app/error.tsx')
  const mount = (error: Error & { digest?: string }, reset: () => void = () => {}) => {
    // The page logs the error from an effect, which runs during the mount; keep that out of the test output and capture it.
    const logged: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => void logged.push(...args)
    try {
      return { page: mountPage(FILE, {}, { props: { error, reset } }), logged }
    } finally {
      console.error = original
    }
  }

  it('shows a heading, the error message and a Try again button that calls reset; the error is logged', async () => {
    const error = new Error('Request failed with 500')
    let resets = 0
    const { page, logged } = mount(error, () => resets++)
    await page.settle()
    assert.equal(page.root().type, 'main')
    assert.equal(all(page.root()).filter((el) => el.type === 'h1').length, 1)
    const text = page.text().replace(/\s+/g, ' ')
    assert.ok(text.includes('Something went wrong'), text)
    assert.ok(text.includes('Request failed with 500'), text)
    assert.deepEqual(page.buttonLabels(), ['Try again'])
    assert.equal(resets, 0)
    await page.click('Try again')
    assert.equal(resets, 1)
    assert.deepEqual(logged, [error])
  })

  it('falls back to a readable message when the error has none', async () => {
    const { page } = mount(new Error(''))
    await page.settle()
    assert.ok(page.text().includes('The server could not be reached.'))
  })

  it('sets no colour or background of its own (the old page hard-coded #6b7280, #111827 and #d1d5db): every colour comes from the portal\'s theme classes', async () => {
    const { page } = mount(new Error('boom'))
    await page.settle()
    for (const el of all(page.root())) {
      const style = (el.props?.style ?? {}) as Row
      for (const key of Object.keys(style)) assert.ok(!/color|background|border|opacity/i.test(key), `<${el.type}> sets ${key}`)
    }
    const source = read('app/error.tsx')
    assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(|\b(white|black)\b/i.test(source.replace(/\/\*[\s\S]*?\*\//g, '')), 'a hard-coded colour in error.tsx')
    const classes = all(page.root()).flatMap((el) => String(el.props?.className ?? '').split(/\s+/)).filter(Boolean)
    for (const name of ['container', 'card', 'muted', 'btn']) assert.ok(classes.includes(name), `uses .${name}`)
    const button = all(page.root()).find((el) => el.type === 'button')
    assert.ok(button && hasClass(button, 'btn'), 'the button is a .btn')
  })

  for (const theme of ['dark', 'light'] as const) {
    it(`is readable in ${theme} mode: heading and message on the card, and the button label, pass WCAG AA (4.5 : 1)`, () => {
      // The theme classes the page uses are what paint it: confirm each one reads the token we measure.
      assert.match(rule('.card'), /background: var\(--surface\)/)
      assert.match(rule('h1, h2, h3, h4'), /color: var\(--text-heading\)/)
      assert.match(rule('.muted'), /color: var\(--muted\)/)
      assert.match(rule('.btn'), /background: var\(--primary\)/)
      assert.match(rule('.btn'), /color: #ffffff !important/)

      const surface = token(theme, '--surface')
      const results = {
        heading: contrast(token(theme, '--text-heading'), surface),
        message: contrast(token(theme, '--muted'), surface),
        button: contrast('#ffffff', token(theme, '--primary')),
      }
      for (const [what, ratio] of Object.entries(results)) assert.ok(ratio >= 4.5, `${theme} ${what}: ${ratio.toFixed(2)} : 1`)
    })
  }
})

/* ═══ 6: Demo Requests "Clear filters" ═══════════════════════════════════════ */

describe('Demo Requests list: "Clear filters" reloads the list', () => {
  const LIST = path.join(WEB, 'components/demos/DemoRequestList.tsx')
  let calls: URLSearchParams[]
  let script: Step[]

  const demo = (name: string): Row => ({
    id: `d-${name}`,
    businessName: name,
    contactName: 'Contact',
    contactEmail: `${name}@example.com`,
    status: 'PENDING',
    submittedAt: '2026-10-01T05:00:00.000Z',
    product: { id: 'p1', name: 'Hexalyte Salon' },
    reseller: { businessName: 'Kandy Traders', code: 'RS-1' },
  })
  const rows = (...names: string[]) => ({ data: names.map(demo), meta: { total: names.length, page: 1, limit: 25, totalPages: 3, pipelineCounts: { total: 2, pending: 2, approved: 0, demoCreated: 0, confirmed: 0 } } })
  const none = { data: [], meta: { total: 0, page: 1, limit: 25, totalPages: 0 } }

  const open = async () => {
    const page = mountPage(
      LIST,
      {
        'next/link': { __esModule: true, default: ({ href, children }: Row) => jsx('a', { href, children }) },
        '@/lib/format': format,
        '@/lib/demo-types': demoTypes,
        '@/lib/api': {
          ApiError,
          apiRequest: async (url: string) => {
            calls.push(new URLSearchParams(url.split('?')[1]))
            const next = script.shift()
            if (!next) throw new Error(`unexpected extra request: ${url}`)
            return next()
          },
        },
        '@/components/PageHero': { PageHero: ({ children }: Row) => jsx('div', { children }) },
        '@/components/ui/KpiRefCard': {
          KpiGrid: ({ children }: Row) => jsx('div', { children }),
          KpiRefCard: ({ value }: Row) => jsx('span', { className: 'kpi-value', children: String(value) }),
        },
        '@/components/ui/EmptyState': { EmptyState: ({ title }: Row) => jsx('div', { className: 'empty', children: title }) },
        // A page button, so a test can move to page 2.
        '@/components/ui/Pagination': { Pagination: ({ onPage }: Row) => jsx('button', { onClick: () => onPage(2), children: 'Next page' }) },
      },
      { exportName: 'DemoRequestList', props: { basePath: '/demo-requests' } },
    )
    await page.settle()
    return page
  }
  const queryOf = (p: URLSearchParams) => Object.fromEntries(p.entries())

  beforeEach(() => {
    calls = []
    script = []
  })

  it('after a search with no matches, clearing reloads the full list at once (the reported bug: no request, "No demo requests found" stayed)', async () => {
    script = [ok(rows('Acme', 'Bolt')), ok(none), ok(rows('Acme', 'Bolt'))]
    const page = await open()
    await page.fill('dr-search', 'zzz-no-match')
    await page.submit()
    assert.equal(calls.length, 2)
    assert.equal(calls[1].get('search'), 'zzz-no-match')
    assert.ok(page.text().includes('No demo requests found'))

    await page.click('Clear filters')
    assert.equal(calls.length, 3, 'exactly one reload')
    assert.deepEqual(queryOf(calls[2]), { limit: '25', page: '1' }, 'no search term, no status')
    assert.equal(page.valueOf('dr-search'), '')
    assert.ok(!page.text().includes('No demo requests found'))
    assert.ok(page.text().includes('Acme') && page.text().includes('Bolt'), 'the rows are back')
    assert.equal(page.hasButton('Clear filters'), false, 'nothing left to clear')
  })

  it('clearing a status and a search together reloads once, with neither', async () => {
    script = [ok(rows('Acme')), ok(rows('Acme')), ok(none), ok(rows('Acme', 'Bolt'))]
    const page = await open()
    await page.fill('dr-status', 'PENDING')
    await page.fill('dr-search', 'zzz')
    await page.submit()
    assert.deepEqual(queryOf(calls[2]), { limit: '25', page: '1', status: 'PENDING', search: 'zzz' })

    await page.click('Clear filters')
    assert.equal(calls.length, 4, 'exactly one reload')
    assert.deepEqual(queryOf(calls[3]), { limit: '25', page: '1' })
    assert.equal(page.valueOf('dr-status'), '')
    assert.equal(page.valueOf('dr-search'), '')
  })

  it('clearing only a status still reloads once (unchanged behaviour)', async () => {
    script = [ok(rows('Acme')), ok(none), ok(rows('Acme'))]
    const page = await open()
    await page.fill('dr-status', 'CONFIRMED')
    await page.click('Clear filters')
    assert.equal(calls.length, 3)
    assert.deepEqual(queryOf(calls[2]), { limit: '25', page: '1' })
  })

  it('clearing a search typed on page 2 goes back to page 1 of the full list', async () => {
    script = [ok(rows('Acme')), ok(rows('Acme')), ok(rows('Acme', 'Bolt'))]
    const page = await open()
    await page.fill('dr-search', 'ac')
    await page.click('Next page')
    assert.deepEqual(queryOf(calls[1]), { limit: '25', page: '2', search: 'ac' })
    await page.click('Clear filters')
    assert.equal(calls.length, 3)
    assert.deepEqual(queryOf(calls[2]), { limit: '25', page: '1' })
  })

  it('offers "Clear filters" only while a filter or search is active', async () => {
    script = [ok(rows('Acme'))]
    const page = await open()
    assert.equal(page.hasButton('Clear filters'), false)
    await page.fill('dr-search', 'a')
    assert.equal(page.hasButton('Clear filters'), true)
  })

  it('if the reload after clearing fails, the error shows with Retry, and Retry asks for the cleared list', async () => {
    script = [ok(rows('Acme')), ok(none), fail(new ApiError('Demo requests are unavailable', 500)), ok(rows('Acme'))]
    const page = await open()
    await page.fill('dr-search', 'zzz')
    await page.submit()
    await page.click('Clear filters')
    assert.ok(page.textOfClass('alert').some((t) => t.includes('Demo requests are unavailable')))
    await page.click('Retry')
    assert.equal(calls.length, 4)
    assert.deepEqual(queryOf(calls[3]), { limit: '25', page: '1' }, 'Retry does not bring the old search back')
  })
})

/* ═══ 22: bank slip file names on phones ═════════════════════════════════════ */

describe('Bank slip row: a long file name wraps instead of widening the page', () => {
  const FILE = path.join(WEB, 'components/activations/ActivationParts.tsx')
  // The kind of name phones and social apps produce: one unbroken 80-character token.
  const LONG = '839932846_1234567890123456_9876543210987654321_n_final_scan_of_the_transfer_slip.jpg'
  const slip = { id: 's1', originalName: LONG, mimeType: 'image/jpeg', sizeBytes: 52_000 }

  const mount = () =>
    mountPage(
      FILE,
      { '@/lib/api': { ApiError, apiBlob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }) }, '@/lib/activation-types': activationTypes },
      { exportName: 'BankSlipViewer', props: { requestId: 'r1', slip } },
    )

  it('puts the name in a container that is allowed to shrink and break (class slip-info), next to the View button', async () => {
    const page = mount()
    await page.settle()
    const info = all(page.root()).find((el) => hasClass(el, 'slip-info'))
    assert.ok(info, 'the name container has the slip-info class')
    assert.ok(all(info).some((el) => el.type === 'strong' && el.props.children === LONG), 'the whole file name is still shown')
    assert.ok(page.text().includes('Image · 51 KB'))
    assert.ok(page.hasButton('View bank slip'))
  })

  it('shows an opened slip image with the class that caps it to the screen width', async () => {
    const page = mount()
    await page.settle()
    await page.click('View bank slip')
    const image = all(page.root()).find((el) => el.type === 'img')
    assert.ok(image && hasClass(image, 'slip-image'))
  })

  it('the stylesheet lets the name shrink (min-width: 0), break anywhere, and never exceed its line; the image never exceeds the screen', () => {
    const info = rule('.slip-info')
    assert.match(info, /min-width: 0;/)
    assert.match(info, /max-width: 100%;/)
    assert.match(info, /overflow-wrap: anywhere;/)
    const image = rule('.slip-image')
    assert.match(image, /max-width: 100%;/)
    assert.match(image, /height: auto;/)
  })

  it('is the shared viewer: the reseller and the admin activation pages and the admin bank-slips page all use it', () => {
    for (const page of ['app/activations/[id]/page.tsx', 'app/admin/activations/[id]/page.tsx', 'app/admin/bank-slips/page.tsx']) {
      assert.match(read(page), /<BankSlipViewer\b/, page)
    }
  })
})

/* ═══ 24: dashboard "Last 6 Months" ══════════════════════════════════════════ */

describe('Dashboard analytics period: a label, not a fake drop-down', () => {
  const page = read('app/dashboard/page.tsx')
  /** The JSX of the element that carries the period label, up to its closing </div>. */
  const labelBlock = (() => {
    const start = page.indexOf('<div className="analytics-v2-range-label">')
    assert.ok(start >= 0, 'the range label element is missing')
    return page.slice(start, page.indexOf('</div>', start))
  })()

  it('still says which period the charts cover, in English and Sinhala', () => {
    assert.match(labelBlock, /\{t\('dash\.analytics\.range6m'\)\}/)
    assert.equal(builtInText('en', 'dash.analytics.range6m'), 'Last 6 Months')
    assert.match(builtInText('si', 'dash.analytics.range6m'), /6/)
  })

  it('has nothing that suggests or offers interaction: no chevron, no handler, no role, not focusable, not a button', () => {
    assert.ok(!labelBlock.includes('&#9662;'), 'the drop-down chevron is gone')
    assert.ok(!/onClick|onKeyDown|role=|tabIndex|<button|<select|aria-haspopup|aria-expanded/.test(labelBlock), labelBlock)
    assert.ok(!page.includes('analytics-v2-filter-btn'), 'the old "button" class is gone from the page')
  })

  it('is styled as a label: default cursor and no hover state (and the old interactive rule is gone)', () => {
    const label = rule('.analytics-v2-range-label')
    assert.match(label, /cursor: default;/)
    assert.ok(!/cursor:\s*pointer/.test(label))
    assert.ok(!css.includes('.analytics-v2-range-label:hover'), 'no hover state')
    assert.ok(!css.includes('analytics-v2-filter-btn'), 'the old interactive rule is gone from the stylesheet')
  })

  it('tells the truth: the server always returns the same six months, and the dashboard query has no range parameter to select another', () => {
    const service = fs.readFileSync(path.resolve(__dirname, '../src/modules/dashboard/dashboard.service.ts'), 'utf8')
    const windows = [...service.matchAll(/recentPeriods\((\d+),/g)].map((m) => Number(m[1]))
    assert.ok(windows.length >= 1 && windows.every((n) => n === 6), `server windows: ${windows}`)
    assert.equal(Number(builtInText('en', 'dash.analytics.range6m').match(/\d+/)![0]), windows[0], 'the label matches the window')
    const schema = fs.readFileSync(path.resolve(__dirname, '../src/modules/dashboard/dashboard.schema.ts'), 'utf8')
    assert.ok(!/months|range|period/i.test(schema.replace(/optionalId|periodMonth/g, '')), 'a range parameter now exists: make the label a real selector')
  })
})
