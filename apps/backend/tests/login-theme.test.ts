import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  LOGIN_THEME_COLOR_KEYS as SERVER_COLOR_KEYS,
  LOGIN_THEME_MIN_RATIO as SERVER_MIN_RATIO,
  contrastRatio as serverContrast,
  hexColorProblem as serverHexProblem,
  loginThemeSchema,
} from '../src/modules/settings/appearance.schema'

/**
 * The login-page theme's rules, without a browser or a server: the four presets, HEX validation, the contrast check, and the CSS
 * variables a theme becomes. The rules exist twice on purpose (web: lib/login-theme.ts, which drives the editor and the page;
 * API: appearance.schema.ts, which has the final say), so this file also checks that the two agree.
 *
 * Database-free; nothing here reads `.env`, runs Prisma or opens a connection.
 */

const WEB = path.resolve(__dirname, '../../web/src')
const read = (file: string) => fs.readFileSync(path.join(WEB, file), 'utf8').replace(/\r\n/g, '\n')
const theme = require('../../web/src/lib/login-theme')
const css = read('app/login/login.css')

type Colors = Record<string, string>
const preset = (id: string): Colors => ({ ...theme.LOGIN_THEME_PRESETS.find((p: { id: string }) => p.id === id).colors })
const withColor = (id: string, over: Colors): Colors => ({ ...preset(id), ...over })

describe('presets', () => {
  it('are Light, Dark, Gray and Green, in that order', () => {
    assert.deepEqual(theme.LOGIN_THEME_PRESETS.map((p: { id: string }) => p.id), ['light', 'dark', 'gray', 'green'])
    assert.deepEqual(theme.LOGIN_THEME_PRESETS.map((p: { label: string }) => p.label), ['Light', 'Dark', 'Gray', 'Green'])
  })

  it('define the same nine colors the API stores, each as #RRGGBB', () => {
    assert.deepEqual([...theme.LOGIN_THEME_COLOR_KEYS], [...SERVER_COLOR_KEYS])
    assert.deepEqual(theme.LOGIN_THEME_FIELDS.map((f: { key: string }) => f.key), [...SERVER_COLOR_KEYS], 'every color has an editor field')
    for (const p of theme.LOGIN_THEME_PRESETS) {
      assert.deepEqual(Object.keys(p.colors).sort(), [...SERVER_COLOR_KEYS].sort(), p.id)
      for (const [key, value] of Object.entries(p.colors)) assert.match(String(value), /^#[0-9A-F]{6}$/, `${p.id}.${key}`)
    }
  })

  it('are readable: no preset trips any contrast warning or error', () => {
    for (const p of theme.LOGIN_THEME_PRESETS) assert.deepEqual(theme.contrastIssues(p.colors), [], p.id)
  })

  it('Light has a light page with dark text and Dark has a dark page with light text, both well above 4.5 : 1', () => {
    const light = preset('light')
    const dark = preset('dark')
    assert.ok(theme.luminance(light.pageBg) > 0.5 && theme.luminance(light.text) < 0.1)
    assert.ok(theme.luminance(dark.pageBg) < 0.1 && theme.luminance(dark.text) > 0.5)
    for (const c of [light, dark]) {
      assert.ok(theme.contrastRatio(c.text, c.pageBg) >= 7, 'main text')
      assert.ok(theme.contrastRatio(c.textSecondary, c.pageBg) >= 4.5, 'secondary text')
      assert.ok(theme.contrastRatio(c.buttonText, c.buttonBg) >= 4.5, 'button')
      assert.ok(theme.contrastRatio(c.accent, c.pageBg) >= 4.5, 'links')
    }
  })

  it('are accepted by the API unchanged', () => {
    for (const p of theme.LOGIN_THEME_PRESETS) {
      const parsed = loginThemeSchema.safeParse({ colors: p.colors })
      assert.ok(parsed.success, p.id)
      assert.deepEqual(parsed.data.colors, p.colors, p.id)
    }
  })

  it('are recognised by their colors, in any letter case, until one color is changed', () => {
    for (const p of theme.LOGIN_THEME_PRESETS) {
      assert.equal(theme.presetOf(p.colors), p.id)
      assert.equal(theme.presetOf(Object.fromEntries(Object.entries(p.colors).map(([k, v]) => [k, String(v).toLowerCase()]))), p.id)
      assert.equal(theme.presetOf({ ...p.colors, accent: '#123456' }), null, `${p.id} customized`)
    }
    assert.equal(theme.presetOf(null), null)
  })
})

describe('HEX colors', () => {
  const VALID = ['#16A34A', '#16a34a', '#FFF', '#abc', ' #16A34A ', '#000000', '#FFFFFF']
  const INVALID: Array<[string, RegExp]> = [
    ['', /Enter a HEX color/],
    ['   ', /Enter a HEX color/],
    ['16A34A', /starts with #/],
    ['red', /starts with #/],
    ['rgb(1,2,3)', /starts with #/],
    ['#', /3 or 6 digits/],
    ['#12', /3 or 6 digits/],
    ['#1234', /3 or 6 digits/],
    ['#16A34', /3 or 6 digits/],
    ['#16A34A7', /3 or 6 digits/],
    ['#16A34A7F', /3 or 6 digits/],
    ['#GGGGGG', /digits 0-9 and the letters A-F/],
    ['#12 456', /digits 0-9 and the letters A-F/],
    ['#16A34A;x', /digits 0-9 and the letters A-F/],
  ]

  it('accepts 3- and 6-digit values, any letter case, with surrounding spaces', () => {
    for (const value of VALID) assert.equal(theme.hexColorProblem(value), null, JSON.stringify(value))
  })

  it('rejects everything else with a message that says what is wrong and shows an example', () => {
    for (const [value, expected] of INVALID) {
      const problem = theme.hexColorProblem(value)
      assert.match(String(problem), expected, JSON.stringify(value))
      assert.match(String(problem), /#16A34A/, `${JSON.stringify(value)}: the message gives an example`)
    }
  })

  it('stores one canonical text: #RRGGBB in capitals, 3-digit colors expanded', () => {
    assert.equal(theme.normalizeHex('#16a34a'), '#16A34A')
    assert.equal(theme.normalizeHex('#abc'), '#AABBCC')
    assert.equal(theme.normalizeHex(' #fff '), '#FFFFFF')
    for (const [value] of INVALID) assert.equal(theme.normalizeHex(value), null, JSON.stringify(value))
  })

  it('is judged the same by the web app and the API, with the same messages and the same stored text', () => {
    for (const value of [...VALID, ...INVALID.map(([v]) => v), '#１２３４５６', '#16A34A\n', '＃16A34A']) {
      assert.equal(serverHexProblem(value), theme.hexColorProblem(value), JSON.stringify(value))
      const parsed = loginThemeSchema.safeParse({ colors: { ...preset('light'), accent: value } })
      assert.equal(parsed.success, theme.hexColorProblem(value) === null, JSON.stringify(value))
      if (parsed.success) assert.equal(parsed.data.colors.accent, theme.normalizeHex(value), JSON.stringify(value))
      else assert.equal(parsed.error.issues[0].message, theme.hexColorProblem(value), JSON.stringify(value))
    }
  })
})

describe('contrast check', () => {
  it('measures WCAG contrast the way the API does', () => {
    assert.equal(Math.round(theme.contrastRatio('#000000', '#FFFFFF') * 100) / 100, 21)
    assert.equal(theme.contrastRatio('#336699', '#336699'), 1)
    assert.equal(theme.contrastRatio('#16A34A', '#FFFFFF'), theme.contrastRatio('#FFFFFF', '#16A34A'))
    for (const [a, b] of [['#16A34A', '#FFFFFF'], ['#0F172A', '#F1F5F9'], ['#777777', '#888888']]) assert.equal(theme.contrastRatio(a, b), serverContrast(a, b))
  })

  it('warns, but does not refuse, white button text on #16A34A green (3.3 : 1, below the recommended 4.5 : 1)', () => {
    const colors = withColor('green', { buttonBg: '#16A34A', buttonText: '#FFFFFF' })
    const issues = theme.contrastIssues(colors)
    assert.deepEqual(issues.map((i: { id: string }) => i.id), ['button'])
    assert.equal(issues[0].level, 'warning')
    assert.equal(issues[0].ratio.toFixed(1), '3.3')
    assert.equal(theme.describeIssue(issues[0]), 'Primary button text on the button: 3.3 : 1 (4.5 : 1 is recommended)')
    assert.ok(loginThemeSchema.safeParse({ colors }).success, 'the API accepts it')
  })

  it('refuses a theme in which the sign-in form could not be read, and says which pair', () => {
    const cases: Array<[string, Colors, string]> = [
      ['text-page', withColor('light', { text: '#FFFFFF' }), 'Main text on the page background'],
      ['button', withColor('light', { buttonText: '#1D4ED8' }), 'Primary button text on the button'],
      ['text-input', withColor('light', { inputBg: '#0F172A', text: '#1E293B', pageBg: '#FFFFFF' }), 'Text typed into fields'],
    ]
    for (const [id, colors, label] of cases) {
      const issue = theme.contrastIssues(colors).find((i: { id: string }) => i.id === id)
      assert.equal(issue?.level, 'error', id)
      assert.match(theme.describeIssue(issue), new RegExp(`^${label}: \\d\\.\\d : 1\\. At least 3 : 1 is required to save, and 4\\.5 : 1 is recommended$`), id)
      const parsed = loginThemeSchema.safeParse({ colors })
      assert.equal(parsed.success, false, `${id}: the API refuses it too`)
      assert.match(String(parsed.error?.issues[0].message), new RegExp(label), id)
    }
  })

  it('only warns about the pairs a visitor does not need in order to sign in (secondary text, links, field edges)', () => {
    const colors = withColor('light', { textSecondary: '#F8FAFC', accent: '#E2E8F0', inputBorder: '#FEFEFE' })
    const issues = theme.contrastIssues(colors)
    assert.deepEqual(issues.map((i: { id: string }) => i.id).sort(), ['accent-input', 'accent-page', 'field-edge', 'secondary-input', 'secondary-page'])
    assert.ok(issues.every((i: { level: string }) => i.level === 'warning'))
    assert.ok(loginThemeSchema.safeParse({ colors }).success)
  })

  it('does not worry about a plain border when the field is filled differently from the page', () => {
    const colors = withColor('light', { pageBg: '#F1F5F9', inputBg: '#0F172A', text: '#FFFFFF', textSecondary: '#CBD5E1', inputBorder: '#F1F5F9' })
    assert.equal(theme.contrastIssues(colors).some((i: { id: string }) => i.id === 'field-edge'), false)
  })

  it('lists errors before warnings, worst first', () => {
    const issues = theme.contrastIssues(withColor('light', { accent: '#FAFAFA', text: '#FEFEFE' }))
    const levels = issues.map((i: { level: string }) => i.level)
    assert.equal(levels[0], 'error')
    assert.deepEqual(levels, [...levels].sort((a: string, b: string) => (a === 'error' ? -1 : 0) - (b === 'error' ? -1 : 0)))
  })

  it('agrees with the API about what is refused, over presets with one color changed', () => {
    const probes = ['#000000', '#FFFFFF', '#777777', '#16A34A', '#F1F5F9', '#0F172A']
    let refused = 0
    for (const p of theme.LOGIN_THEME_PRESETS) {
      for (const key of SERVER_COLOR_KEYS) {
        for (const probe of probes) {
          const colors = withColor(p.id, { [key]: probe })
          const webRefuses = theme.contrastIssues(colors).some((i: { level: string }) => i.level === 'error')
          assert.equal(!loginThemeSchema.safeParse({ colors }).success, webRefuses, `${p.id} ${key}=${probe}`)
          if (webRefuses) refused++
        }
      }
    }
    assert.ok(refused > 20, 'the sweep includes plenty of refused combinations')
    assert.equal(theme.LOGIN_THEME_MIN_RATIO, SERVER_MIN_RATIO)
  })
})

describe('applying a theme', () => {
  const green = preset('green')
  const vars: Record<string, string> = theme.loginThemeVars(green)

  it('changes nothing without a theme', () => {
    assert.equal(theme.loginThemeVars(null), undefined)
    assert.equal(theme.loginThemeVars(undefined), undefined)
    assert.equal(theme.loginThemeColors(null), null)
    assert.equal(theme.loginThemeColors({}), null)
  })

  it('turns each chosen color into the variables the login stylesheet reads', () => {
    assert.equal(vars['--theme-right-bg'], green.pageBg)
    assert.equal(vars['--theme-card-bg'], green.pageBg)
    for (const name of ['--theme-text-heading', '--theme-label', '--theme-input-text', '--theme-reg-text']) assert.equal(vars[name], green.text, name)
    for (const name of ['--theme-text-subtitle', '--theme-input-placeholder', '--theme-input-icon', '--theme-reg-desc']) assert.equal(vars[name], green.textSecondary, name)
    assert.equal(vars['--theme-btn-bg'], green.buttonBg)
    assert.equal(vars['--theme-btn-text'], green.buttonText)
    assert.equal(vars['--theme-input-bg'], green.inputBg)
    for (const name of ['--theme-input-border', '--theme-card-border', '--theme-divider-border']) assert.equal(vars[name], green.inputBorder, name)
    for (const name of ['--theme-link', '--theme-input-focus-border', '--theme-reg-btn-text', '--theme-reg-btn-border', '--theme-checkbox-accent', '--theme-accent']) assert.equal(vars[name], green.accent, name)
    assert.equal(vars['--theme-hero-bg'], green.heroOverlay)
    assert.match(vars['--theme-hero-overlay'], /^linear-gradient\(180deg, rgba\(5, 46, 22, 0\.78\) 0%/)
  })

  it('leaves no part of the built-in warm scheme showing: every variable that scheme defines is set by a theme', () => {
    const builtIn = css.match(/\.login-split \{\n  --theme-right-bg:[\s\S]*?\n\}/)?.[0] ?? ''
    const defined = [...builtIn.matchAll(/(--theme-[\w-]+):/g)].map((m) => m[1])
    assert.ok(defined.length > 25, 'the built-in scheme was found')
    const missing = defined.filter((name) => !(name in vars))
    assert.deepEqual(missing, [])
  })

  it('sets only variables the pages actually read (no dead settings)', () => {
    const readers = css + read('app/verify-email/page.tsx')
    const unused = Object.keys(vars).filter((name) => !new RegExp(`var\\(\\s*${name}\\b`).test(readers))
    assert.deepEqual(unused, [])
  })

  it('lets the hero panel follow the overlay color, with the stylesheet\'s own values as fallback so the default look is untouched', () => {
    assert.match(css, /\.login-left \{[^}]*color: var\(--theme-hero-text, #ffffff\);[^}]*background-color: var\(--theme-hero-bg, transparent\);/)
    assert.match(css, /\.login-left::after \{[\s\S]*?background: var\(\s*--theme-hero-overlay,\s*linear-gradient\(\s*180deg,\s*rgba\(0, 0, 0, 0\.55\) 0%,\s*rgba\(0, 0, 0, 0\.2\) 35%,\s*rgba\(0, 0, 0, 0\.15\) 60%,\s*rgba\(0, 0, 0, 0\.6\) 100%\s*\)\s*\);/)
    assert.match(css, /\.login-left-hero h2 \{[^}]*color: var\(--theme-hero-text, #ffffff\);/)
    assert.match(css, /\.login-left-hero p \{[^}]*color: var\(--theme-hero-text-muted, rgba\(255, 255, 255, 0\.9\)\);/)
    assert.match(css, /\.login-submit \.login-spinner \{[^}]*border-top-color: var\(--theme-btn-text, #ffffff\);/)
  })

  it('picks light or dark hero text, whichever reads better on the overlay', () => {
    for (const p of theme.LOGIN_THEME_PRESETS) assert.equal(theme.heroTextOn(p.colors.heroOverlay), '#FFFFFF', `${p.id} has a dark overlay`)
    assert.equal(theme.heroTextOn('#F5F5F5'), '#0F172A')
    assert.equal(theme.loginThemeVars(withColor('light', { heroOverlay: '#F5F5F5' }))!['--theme-hero-text'], '#0F172A')
    for (const hex of ['#000000', '#FFFFFF', '#808080', '#16A34A', '#F59E0B']) {
      assert.ok(theme.contrastRatio(theme.heroTextOn(hex), hex) >= 4.5, hex)
    }
  })

  it('uses the overlay color for the panel behind a landscape that cannot load', () => {
    assert.match(theme.heroFallbackGradient('#052E16'), /^linear-gradient\(135deg, #052E16 0%, #[0-9A-F]{6} 100%\)$/)
  })

  it('only accepts a complete set of #RRGGBB colors from the server, so nothing else can reach the stylesheet', () => {
    assert.deepEqual(theme.loginThemeColors({ colors: green }), green)
    const bad: unknown[] = [
      { colors: { ...green, accent: 'red' } },
      { colors: { ...green, accent: '#abc' } },
      { colors: { ...green, accent: '#16a34a' } },
      { colors: { ...green, accent: '#16A34A; background: url(https://evil.example/x)' } },
      { colors: { ...green, accent: 'url(https://evil.example/x)' } },
      { colors: { ...green, accent: 123456 } },
      { colors: { ...green, accent: null } },
      { colors: { ...green, accent: undefined } },
      { colors: 'green' },
      { colors: null },
      'green',
    ]
    for (const value of bad) assert.equal(theme.loginThemeColors(value), null, JSON.stringify(value))
    const { pageBg, ...incomplete } = green
    assert.equal(pageBg, green.pageBg)
    assert.equal(theme.loginThemeColors({ colors: incomplete }), null)
    for (const value of Object.values(vars)) assert.ok(!/[;{}<>]|url\(/.test(value), value)
  })

  it('is plain computation: no React, no document, no storage, no network', () => {
    const source = read('lib/login-theme.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    assert.ok(!/\bimport\b[^;]*from\s+['"](?!\.)/.test(source), 'imports nothing from outside the project')
    assert.ok(!/\b(document|window|localStorage|sessionStorage|fetch|navigator)\b|\buse[A-Z]\w+\(/.test(source))
  })
})
