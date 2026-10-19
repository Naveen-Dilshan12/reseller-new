import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Reseller portal, Light theme: text that was tuned for the dark theme was only 1.5–3.7:1 on the pale surfaces (found in the
 * browser, results.md items 2/3/13/18/21):
 *  - hero text over the admin's hero photo (tag, greeting, subtitle: 1.1–2.8:1 where the cream wash fades out),
 *  - the activation confirmation checkbox text (#cbd5e1 on white, 1.48:1),
 *  - "You earn" amounts (2.54:1), the status stepper (done 2.19, active 4.18, failed 3.07),
 *  - dashboard pills / level badges / ladder rates / "View All", and the product commission pill (1.7–3.7:1).
 *
 * Every Light colour is checked against the Light surface it sits on at WCAG AA (4.5:1), and every Dark colour is pinned to its old
 * value so the Dark appearance cannot drift. Database-free: it only reads globals.css and two page sources; nothing here reads
 * `.env`, runs Prisma or opens a connection. (The browser measurements that found these are in the QA results file; this test
 * guards the stylesheet values.)
 */

const WEB = path.resolve(__dirname, '../../web/src')
// Comments are removed first: they may contain braces or selectors and would confuse the rule scan.
const CSS = fs.readFileSync(path.join(WEB, 'app/globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

type Rgba = [number, number, number, number]

/* ─── colour helpers ─────────────────────────────────────────────────────── */

const parseColor = (value: string, tokens: Record<string, string> = {}): Rgba => {
  const v = value.trim()
  const variable = /^var\((--[\w-]+)\)$/.exec(v)
  if (variable) {
    assert.ok(tokens[variable[1]], `token ${variable[1]} is not defined`)
    return parseColor(tokens[variable[1]], tokens)
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(v)
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1) as Rgba
  const rgba = /^rgba?\(([^)]+)\)$/.exec(v)
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

/* ─── stylesheet helpers ─────────────────────────────────────────────────── */

interface Rule {
  selectors: string[]
  body: string
}
const RULES: Rule[] = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: m[1].split(',').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean),
  body: m[2],
}))
const declaration = (body: string, property: string): string | undefined => new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+)`).exec(body)?.[1].trim()

const themeTokens = (start: string): Record<string, string> => {
  const rule = RULES.find((r) => r.selectors.includes(start))
  assert.ok(rule, `globals.css has no ${start} block`)
  return Object.fromEntries([...rule.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
}
const LIGHT = themeTokens("html[data-theme='light']")
const surface = parseColor(LIGHT['--surface'])
const page = parseColor(LIGHT['--bg'])
const hover = parseColor(LIGHT['--surface-hover'])

/** The plain (Dark / unscoped) value of `property` for exactly this selector: the first rule that declares it. */
const base = (selector: string, property = 'color'): string => {
  const rule = RULES.find((r) => r.selectors.includes(selector) && declaration(r.body, property))
  assert.ok(rule, `globals.css has no ${property} for ${selector}`)
  return declaration(rule.body, property)!
}
/** The Light value: the LAST rule scoped to the Light theme (both `html[data-theme='light']` and `.light-theme`) that declares it. */
const light = (selector: string, property = 'color'): string => {
  const rules = RULES.filter(
    (r) => r.selectors.includes(`html[data-theme='light'] ${selector}`) && r.selectors.includes(`.light-theme ${selector}`) && declaration(r.body, property),
  )
  assert.ok(rules.length, `the Light theme has no ${property} rule for ${selector}`)
  return declaration(rules[rules.length - 1].body, property)!
}
const ratio = (colour: string, background: Rgba) => {
  const text = parseColor(colour, LIGHT)
  // translucent text would be composited too; none is used here, but be strict about it
  assert.equal(text[3], 1, `${colour} is translucent`)
  return contrast(text, background)
}

/* ─── Dark is pinned to its old values ───────────────────────────────────── */

describe('Dark theme keeps its colours (only Light-scoped rules were added)', () => {
  const DARK: Array<[string, string]> = [
    ['.amount-you', '#10b981'],
    ['.step.active', 'var(--primary-light)'],
    ['.step.done', '#10b981'],
    ['.step.failed', '#ef4444'],
    ['.partner-growth-levelup', '#f59e0b'],
    ['.partner-growth-v2-level-badge', '#10b981'],
    ['.partner-growth-box-val.blue', '#3b82f6'],
    ['.partner-growth-box-val.emerald', '#10b981'],
    ['.lvl-ladder-rate', '#10b981'],
    ['.dash-pill-emerald', '#10b981'],
    ['.dash-pill-blue', '#3b82f6'],
    ['.dash-pill-amber', '#f59e0b'],
    ['.dash-pill-muted', '#94a3b8'],
    ['.activity-v2-viewall', '#3b82f6'],
    ['.checkbox', '#cbd5e1'],
    ['.product-commission-pill', '#34d399'],
    ['.compact-hero-tag', '#F4C76B'],
    ['.compact-hero-title', '#ffffff'],
    ['.compact-hero-subtitle', 'rgba(226, 232, 240, 0.90)'],
    ['.dash-hero-greeting', '#F4C76B'],
    ['.dash-hero-title', '#ffffff'],
    ['.dash-hero-subtitle', '#cbd5e1'],
  ]
  for (const [selector, value] of DARK) {
    it(`${selector} is still ${value}`, () => assert.equal(base(selector), value))
  }

  it('the product commission pill keeps its old Dark background and border (they moved from inline style into the class unchanged)', () => {
    assert.equal(base('.product-commission-pill', 'background'), 'rgba(16, 185, 129, 0.12)')
    assert.equal(base('.product-commission-pill', 'border'), '1px solid rgba(16, 185, 129, 0.28)')
  })

  it('the hero text backing exists only for the Light theme: every selector that draws it is scoped to Light', () => {
    const drawing = RULES.filter((r) => /rgba\(248, 246, 240, 0\.88\)/.test(r.body) && r.selectors.some((s) => /(compact|dash)-hero-content/.test(s)))
    assert.ok(drawing.length >= 1, 'the Light backing rule is there')
    for (const rule of drawing) {
      for (const selector of rule.selectors) assert.match(selector, /^(html\[data-theme='light'\]|\.light-theme) /, `${selector} would also draw the backing in Dark`)
    }
    const anyUnscoped = RULES.some((r) => r.selectors.some((s) => /(compact|dash)-hero-content(::before|::after)/.test(s) && !/^(html\[data-theme='light'\]|\.light-theme) /.test(s)))
    assert.equal(anyUnscoped, false)
  })
})

/* ─── Light reaches AA on the surface each element sits on ───────────────── */

describe('Light theme: status and money text is at least 4.5:1 on its own surface', () => {
  const tinted = (selector: string, under: Rgba[]): Rgba[] => under.map((u) => over(parseColor(base(selector, 'background')), u))

  const CASES: Array<[string, string, Rgba[]]> = [
    ['"You earn" amounts (.amount-you)', '.amount-you', [surface, hover, page]],
    ['stepper, done step', '.step.done', [...tinted('.step.done', [page, surface])]],
    ['stepper, active step', '.step.active', [...tinted('.step.active', [page, surface])]],
    ['stepper, failed step', '.step.failed', [...tinted('.step.failed', [page, surface])]],
    ['"Level up!" pill', '.partner-growth-levelup', tinted('.partner-growth-levelup', [surface])],
    ['"qualifying customers" badge', '.partner-growth-v2-level-badge', tinted('.partner-growth-v2-level-badge', [surface])],
    ['current commission (blue) value', '.partner-growth-box-val.blue', [over(parseColor(light('.partner-growth-box', 'background')), surface), surface]],
    ['next commission (green) value', '.partner-growth-box-val.emerald', [over(parseColor(light('.partner-growth-box', 'background')), surface), surface]],
    ['level ladder rate', '.lvl-ladder-rate', [hover]],
    ['"Active" pill', '.dash-pill-emerald', tinted('.dash-pill-emerald', [surface])],
    ['"Pending/Review" pill', '.dash-pill-blue', tinted('.dash-pill-blue', [surface])],
    ['"Trial" pill', '.dash-pill-amber', tinted('.dash-pill-amber', [surface])],
    ['neutral pill ("Activated")', '.dash-pill-muted', tinted('.dash-pill-muted', [surface])],
    ['"View All" link', '.activity-v2-viewall', [surface, page]],
    ['checkbox label (activation confirmation, "Unread only", …)', '.checkbox', [surface, page]],
    ['product partner-commission pill', '.product-commission-pill', tinted('.product-commission-pill', [surface])],
  ]
  for (const [name, selector, backgrounds] of CASES) {
    it(`${name}`, () => {
      const colour = light(selector)
      backgrounds.forEach((background, i) => {
        const value = ratio(colour, background)
        assert.ok(value >= 4.5, `${selector} (${colour}) on surface #${i + 1} is ${value.toFixed(2)}:1`)
      })
    })
  }

  it('each of those Light colours is a real change from the dark-tuned one (the old colour was below AA on the same surface)', () => {
    const before: Array<[string, Rgba]> = [
      ['.amount-you', surface],
      ['.partner-growth-levelup', tinted('.partner-growth-levelup', [surface])[0]],
      ['.dash-pill-emerald', tinted('.dash-pill-emerald', [surface])[0]],
      ['.step.done', tinted('.step.done', [page])[0]],
      ['.step.active', tinted('.step.active', [page])[0]],
      ['.step.failed', tinted('.step.failed', [page])[0]],
      ['.checkbox', surface],
      ['.product-commission-pill', tinted('.product-commission-pill', [surface])[0]],
    ]
    for (const [selector, background] of before) {
      const old = ratio(base(selector).startsWith('var(') ? LIGHT['--primary-light'] : base(selector), background)
      assert.ok(old < 4.5, `${selector} was ${old.toFixed(2)}:1 in Light, so it needed the override`)
      assert.notEqual(light(selector), base(selector))
    }
  })

  it('the Light overrides keep their own specificity (no :is()), so a locked level still beats the green rate', () => {
    const lightBlock = CSS.slice(CSS.indexOf('.product-commission-pill {'))
    assert.doesNotMatch(lightBlock, /:is\(/)
    assert.equal(base('.lvl-ladder-item.locked .lvl-ladder-rate'), 'var(--muted)')
    // (0,3,0) for the locked rule beats html[data-theme='light'] .lvl-ladder-rate = (0,2,1)
    assert.ok(RULES.some((r) => r.selectors.includes('.lvl-ladder-item.locked .lvl-ladder-rate')))
  })

  it('the Light active and done steps keep the same order as the base rules, so "done active" still reads as done', () => {
    const index = (sel: string) => RULES.findIndex((r) => r.selectors.includes(`html[data-theme='light'] ${sel}`))
    assert.ok(index('.step.active') >= 0 && index('.step.done') > index('.step.active'))
    assert.ok(RULES.findIndex((r) => r.selectors.includes('.step.done')) > RULES.findIndex((r) => r.selectors.includes('.step.active')))
  })
})

/* ─── hero text ──────────────────────────────────────────────────────────── */

describe('Light theme: hero text stays at AA over any hero picture', () => {
  const backing = () => {
    const rule = RULES.find((r) => r.selectors.includes("html[data-theme='light'] .compact-hero-content::before") && declaration(r.body, 'background'))
    assert.ok(rule, 'the Light hero text backing rule exists')
    for (const selector of ['.compact-hero-content', '.dash-hero-content']) {
      for (const prefix of ["html[data-theme='light']", '.light-theme']) assert.ok(rule.selectors.includes(`${prefix} ${selector}::before`), `${prefix} ${selector}::before`)
    }
    return rule
  }

  it('draws a pale, mostly opaque backing behind the text block without changing layout', () => {
    const rule = backing()
    const background = parseColor(declaration(rule.body, 'background')!)
    assert.ok(background[3] >= 0.85, `backing opacity ${background[3]}`)
    assert.ok(luminance(background) > 0.85, 'the backing is a pale colour')
    assert.equal(declaration(rule.body, 'position'), 'absolute')
    assert.equal(declaration(rule.body, 'z-index'), '-1', 'sits behind the text')
    assert.equal(declaration(rule.body, 'pointer-events'), 'none', 'never intercepts clicks')
    assert.match(declaration(rule.body, 'inset') ?? '', /^-/, 'extends outwards, so the text block itself is not resized')
    const host = RULES.find((r) => r.selectors.includes("html[data-theme='light'] .compact-hero-content") && declaration(r.body, 'position'))
    assert.equal(declaration(host!.body, 'position'), 'relative')
    assert.equal(declaration(host!.body, 'isolation'), 'isolate')
  })

  it('tag, greeting, subtitle and title are at least 4.5:1 on the backing even when the photo underneath is pure black', () => {
    const backgroundRule = parseColor(declaration(backing().body, 'background')!)
    const worst = over(backgroundRule, [0, 0, 0, 1]) // the darkest possible picture
    for (const selector of ['.compact-hero-tag', '.compact-hero-subtitle', '.compact-hero-title', '.dash-hero-greeting', '.dash-hero-subtitle', '.dash-hero-title']) {
      const value = ratio(light(selector), worst)
      assert.ok(value >= 4.5, `${selector} (${light(selector)}) over the worst-case backing is ${value.toFixed(2)}:1`)
    }
  })

  it('the old tag/greeting colour (#b45309) would not have been enough on the worst-case backing', () => {
    const worst = over(parseColor(declaration(backing().body, 'background')!), [0, 0, 0, 1])
    assert.ok(ratio('#b45309', worst) < 4.5)
  })
})

/* ─── the two pages that used inline colours ─────────────────────────────── */

describe('Pages leave these colours to the stylesheet (inline colours would beat the Light rules)', () => {
  it('the product commission pill is a class, with no inline colour, background or border', () => {
    const source = fs.readFileSync(path.join(WEB, 'app/products/page.tsx'), 'utf8')
    const start = source.indexOf('className="product-commission-pill"')
    assert.ok(start > 0, 'the pill uses the class')
    const style = source.slice(start, source.indexOf('Partner commission:', start))
    assert.doesNotMatch(style, /\b(color|background|border):/)
  })

  it('the activation confirmation checkbox label has no inline colour', () => {
    const source = fs.readFileSync(path.join(WEB, 'app/activations/new/page.tsx'), 'utf8')
    const label = /<label className="checkbox"[^>]*>/.exec(source)?.[0]
    assert.ok(label, 'the confirmation checkbox label is there')
    assert.doesNotMatch(label, /color/)
  })
})
