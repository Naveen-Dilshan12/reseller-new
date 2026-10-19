import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { mountPage } from './helpers/render-page'

/**
 * Regression tests for the login-theme visual defects found in browser QA:
 *  1. the Admin preview let "Remember me" and "Forgot password?" collide at medium widths (it stacked by viewport width, but the
 *     admin sidebar takes 260px of it) — it now stacks by its own width and its actions row can wrap;
 *  2. error / info / warning notices were fixed pale boxes, jarring on the Dark preset — they now follow the theme;
 *  3. the forgot-password success notice (class "success") had no CSS rule at all, so it showed with no box;
 *  4. verify-email's badge, email chip and code-box highlight used a hard-coded sky blue instead of the theme's accent;
 *  5. the built-in placeholder text was 2.56 : 1 on white.
 * The built-in look (no saved theme) must stay as it was, apart from the two defects that were in the built-in look itself
 * (the placeholder color and the missing success box).
 *
 * No browser here: the markup, the CSS rules and the computed colors are checked. Database-free; nothing here reads `.env`,
 * runs Prisma or opens a connection.
 */

const WEB = path.resolve(__dirname, '../../web/src')
const read = (file: string) => fs.readFileSync(path.join(WEB, file), 'utf8').replace(/\r\n/g, '\n')
const css = read('app/login/login.css')
const theme = require('../../web/src/lib/login-theme')

type Colors = Record<string, string>
const preset = (id: string): Colors => ({ ...theme.LOGIN_THEME_PRESETS.find((p: { id: string }) => p.id === id).colors })
const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
const TONES = ['error', 'info', 'warning', 'success'] as const

/** The declarations of the first top-level rule with exactly this selector. */
const rule = (selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = css.match(new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`))
  assert.ok(m, `rule not found: ${selector}`)
  return m[1]
}

describe('notice boxes follow the login theme', () => {
  it('give every preset and every tone text that passes 4.5 : 1 on its own background, and a box that differs from the page', () => {
    for (const p of theme.LOGIN_THEME_PRESETS) {
      for (const tone of TONES) {
        const n = theme.noticeColors(tone, p.colors)
        assert.ok(theme.contrastRatio(n.text, n.bg) >= 4.5, `${p.id} ${tone}: ${theme.contrastRatio(n.text, n.bg).toFixed(2)}`)
        assert.notEqual(n.bg, p.colors.pageBg, `${p.id} ${tone}: the box is tinted`)
        assert.ok(theme.contrastRatio(n.border, n.bg) > 1.1, `${p.id} ${tone}: the border shows`)
        for (const color of [n.bg, n.text, n.border]) assert.match(color, /^#[0-9A-F]{6}$/)
      }
    }
  })

  it('stay readable on any page color, from black through every gray and saturated colors to white', () => {
    // Mid-grays are the hard case (neither white nor black text is far ahead there), so every third gray level is swept.
    const grays = Array.from({ length: 86 }, (_, i) => `#${Math.min(255, i * 3).toString(16).padStart(2, '0').toUpperCase().repeat(3)}`)
    const pages = [...grays, '#0F172A', '#1E293B', '#6B7280', '#9CA3AF', '#F1F5F9', '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF', '#7C3AED', '#F59E0B', '#14532D', '#450A0A', '#FEF3C7']
    for (const pageBg of pages) {
      for (const tone of TONES) {
        const n = theme.noticeColors(tone, { pageBg })
        assert.ok(theme.contrastRatio(n.text, n.bg) >= 4.5, `${pageBg} ${tone}: ${theme.contrastRatio(n.text, n.bg).toFixed(2)}`)
      }
    }
  })

  it('under Dark the boxes are dark (not the old pale panels) and still look like an error / info / warning / success', () => {
    const dark = preset('dark')
    const lum = (hex: string) => theme.luminance(hex)
    const dominant = { error: 0, info: 2, warning: 0, success: 1 } as const // index of the strongest channel of the tint
    for (const tone of TONES) {
      const n = theme.noticeColors(tone, dark)
      assert.ok(lum(n.bg) < 0.08, `${tone}: bg ${n.bg} is dark`)
      assert.ok(lum(n.text) > 0.4, `${tone}: text ${n.text} is light`)
      const [r, g, b] = channels(n.bg)
      assert.equal([r, g, b].indexOf(Math.max(r, g, b)), dominant[tone], `${tone}: ${n.bg} carries its hue`)
    }
    for (const oldPale of ['#FEF2F2', '#EFF6FF', '#FFFBEB', '#F0FDF4']) {
      assert.ok(!TONES.some((tone) => theme.noticeColors(tone, dark).bg === oldPale))
    }
  })

  it('under Light the boxes are pale with dark text, as before', () => {
    const light = preset('light')
    for (const tone of TONES) {
      const n = theme.noticeColors(tone, light)
      assert.ok(theme.luminance(n.bg) > 0.8, `${tone}: bg ${n.bg}`)
      assert.ok(theme.luminance(n.text) < 0.2, `${tone}: text ${n.text}`)
    }
  })

  it('are set by a theme as the twelve variables login.css reads', () => {
    const vars = theme.loginThemeVars(preset('dark'))
    for (const tone of TONES) {
      const n = theme.noticeColors(tone, preset('dark'))
      assert.equal(vars[`--theme-notice-${tone}-bg`], n.bg)
      assert.equal(vars[`--theme-notice-${tone}-text`], n.text)
      assert.equal(vars[`--theme-notice-${tone}-border`], n.border)
    }
    assert.equal(Object.keys(vars).filter((k) => k.startsWith('--theme-notice-')).length, 12)
  })

  it('are read by the stylesheet with the built-in colors as fallback, so the unthemed notices are unchanged', () => {
    const builtIn = {
      error: ['#fef2f2', '#991b1b', '#fecaca'],
      info: ['#eff6ff', '#1e40af', '#bfdbfe'],
      warning: ['#fffbeb', '#92400e', '#fed7aa'],
    } as const
    for (const [tone, [bg, text, border]] of Object.entries(builtIn)) {
      const body = rule(`.login-notice.${tone}`)
      assert.ok(body.includes(`background: var(--theme-notice-${tone}-bg, ${bg});`), `${tone} bg`)
      assert.ok(body.includes(`color: var(--theme-notice-${tone}-text, ${text});`), `${tone} text`)
      assert.ok(body.includes(`border: 1px solid var(--theme-notice-${tone}-border, ${border});`), `${tone} border`)
    }
  })
})

describe('the forgot-password success notice is styled', () => {
  it('has a rule of its own (it had none, so it showed with no box), in the same shape as the other tones', () => {
    const body = rule('.login-notice.success')
    assert.match(body, /background: var\(--theme-notice-success-bg, #f0fdf4\);/)
    assert.match(body, /color: var\(--theme-notice-success-text, #166534\);/)
    assert.match(body, /border: 1px solid var\(--theme-notice-success-border, #bbf7d0\);/)
  })

  it('and every tone any authentication page can show has a rule, built-in text passing 4.5 : 1 on its box', () => {
    const used = new Set<string>()
    for (const page of ['login', 'register', 'forgot-password', 'reset-password', 'verify-email']) {
      const source = read(`app/${page}/page.tsx`)
      for (const m of source.matchAll(/tone: '(\w+)'/g)) used.add(m[1])
      for (const m of source.matchAll(/login-notice (error|info|warning|success)\b/g)) used.add(m[1])
      for (const m of source.matchAll(/tone === 'success' \? '(\w+)' : '(\w+)'/g)) (used.add(m[1]), used.add(m[2]))
    }
    assert.deepEqual([...used].sort(), ['error', 'info', 'success', 'warning'])
    for (const tone of used) {
      const body = rule(`.login-notice.${tone}`)
      const [bg, text] = [body.match(/background: var\([^,]+, (#[0-9a-f]{6})\)/)?.[1], body.match(/color: var\([^,]+, (#[0-9a-f]{6})\)/)?.[1]]
      assert.ok(bg && text, `${tone} has built-in colors`)
      assert.ok(theme.contrastRatio(text!.toUpperCase(), bg!.toUpperCase()) >= 4.5, `${tone}: built-in ${text} on ${bg}`)
    }
  })
})

describe('built-in placeholder text', () => {
  const builtIn = css.match(/\.login-split \{\n  --theme-right-bg:[\s\S]*?\n\}/)?.[0] ?? ''
  const value = (name: string) => builtIn.match(new RegExp(`${name}: (#[0-9a-fA-F]{6});`))?.[1].toUpperCase()

  it('passes 4.5 : 1 on the field background (it was #94A3B8, 2.56 : 1)', () => {
    const [placeholder, field] = [value('--theme-input-placeholder'), value('--theme-input-bg')]
    assert.ok(placeholder && field)
    assert.notEqual(placeholder, '#94A3B8')
    assert.ok(theme.contrastRatio(placeholder!, field!) >= 4.5, `${placeholder} on ${field}: ${theme.contrastRatio(placeholder!, field!).toFixed(2)}`)
  })

  it('is still lighter than typed text, and is what the fields actually use', () => {
    assert.ok(theme.luminance(value('--theme-input-placeholder')!) > theme.luminance(value('--theme-input-text')!))
    assert.match(rule('.login-field-input::placeholder'), /color: var\(--theme-input-placeholder\);/)
  })

  it('a theme\'s placeholder (its secondary text) passes 4.5 : 1 on its fields for every preset', () => {
    for (const p of theme.LOGIN_THEME_PRESETS) assert.ok(theme.contrastRatio(p.colors.textSecondary, p.colors.inputBg) >= 4.5, p.id)
  })
})

describe('verify-email tints follow the accent', () => {
  const source = read('app/verify-email/page.tsx')

  it('no sky-blue rgba(2, 132, 199, …) is left outside a theme variable with that same color as its fallback', () => {
    const all = [...source.matchAll(/rgba\(2, 132, 199, [\d.]+\)/g)].length
    const wrapped = [...source.matchAll(/var\(--theme-accent-(soft|faint|line|glow), rgba\(2, 132, 199, [\d.]+\)\)/g)].length
    assert.equal(all, 4)
    assert.equal(wrapped, all, 'every sky-blue tint is a fallback')
  })

  it('uses a variable for the badge, the email chip (fill and border) and the code-box highlight, with the old alphas as fallback', () => {
    assert.ok(source.includes("background: 'var(--theme-accent-soft, rgba(2, 132, 199, 0.12))'"))
    assert.ok(source.includes("background: 'var(--theme-accent-faint, rgba(2, 132, 199, 0.08))'"))
    assert.ok(source.includes("border: '1px solid var(--theme-accent-line, rgba(2, 132, 199, 0.22))'"))
    assert.ok(source.includes("'0 0 0 2px var(--theme-accent-glow, rgba(2, 132, 199, 0.15))'"))
  })

  it('a theme turns its accent into those four tints, at the same strengths the built-in tints had', () => {
    for (const p of theme.LOGIN_THEME_PRESETS) {
      const vars = theme.loginThemeVars(p.colors)
      const [r, g, b] = channels(p.colors.accent)
      assert.equal(vars['--theme-accent-soft'], `rgba(${r}, ${g}, ${b}, 0.12)`, p.id)
      assert.equal(vars['--theme-accent-faint'], `rgba(${r}, ${g}, ${b}, 0.08)`, p.id)
      assert.equal(vars['--theme-accent-line'], `rgba(${r}, ${g}, ${b}, 0.22)`, p.id)
      assert.equal(vars['--theme-accent-glow'], `rgba(${r}, ${g}, ${b}, 0.15)`, p.id)
    }
    assert.notEqual(theme.loginThemeVars(preset('green'))['--theme-accent-soft'], theme.loginThemeVars(preset('light'))['--theme-accent-soft'])
  })
})

describe('Admin login-theme preview layout', () => {
  it('measures its own room and stacks below 640px of it, not by the viewport (the admin sidebar takes 260px of that)', () => {
    assert.match(rule('.login-theme-preview-frame'), /container-type: inline-size;/)
    assert.match(rule('.login-theme-preview-frame'), /container-name: login-preview;/)
    assert.match(css, /@container login-preview \(max-width: 640px\) \{\n  \.login-split\.login-theme-preview \{\n    grid-template-columns: 1fr;\n  \}/)
    const previewMedia = [...css.matchAll(/@media \(max-width: 640px\) \{([\s\S]*?)\n\}/g)].filter((m) => m[1].includes('login-theme-preview'))
    assert.equal(previewMedia.length, 0, 'the old viewport-based stacking rule is gone')
  })

  it('lets the "Remember me" / "Forgot password?" row wrap instead of overlapping when its column is narrow', () => {
    const body = rule('.login-split.login-theme-preview .login-actions-row')
    assert.match(body, /flex-wrap: wrap;/)
    assert.match(body, /gap: 0\.35rem 0\.75rem;/)
    assert.match(rule('.login-actions-row'), /display: flex;[\s\S]*justify-content: space-between;/, 'the real page row is unchanged')
  })

  it('renders the preview inside that frame, with both texts in the actions row', async () => {
    const page = mountPage(
      path.join(WEB, 'components/admin/LoginThemeSettings.tsx'),
      {
        '@/lib/api': { ApiError: class extends Error {}, api: async () => ({}) },
        '@/lib/appearance-utils': require('../../web/src/lib/appearance-utils'),
        '@/lib/login-theme': theme,
        '@/app/login/login.css': {},
      },
      {
        exportName: 'LoginThemeSettings',
        props: {
          canManage: true,
          imageUrl: null,
          onSaved() {},
          data: { loginBranding: { heading: null, text: null, heroImage: null, theme: null }, details: { loginTheme: { custom: false, updatedAt: null, updatedBy: null } } },
        },
      },
    )
    await page.settle()
    const all = (node: any, out: any[] = []): any[] => (!node || typeof node !== 'object' ? out : Array.isArray(node) ? (node.forEach((n) => all(n, out)), out) : (out.push(node), all(node.props?.children, out), out))
    const cls = (el: any) => (typeof el.props?.className === 'string' ? el.props.className.split(/\s+/) : [])
    const frame = all(page.root()).find((el) => cls(el).includes('login-theme-preview-frame'))
    assert.ok(frame, 'the frame exists')
    const inside = all(frame.props.children)
    assert.ok(inside.some((el) => cls(el).includes('login-theme-preview')), 'the preview is inside the frame')
    assert.equal(cls(frame).includes('login-theme-preview'), false, 'the frame is not itself the preview')
    const row = inside.find((el) => cls(el).includes('login-actions-row'))
    const text = String(JSON.stringify(row)).replace(/\s+/g, ' ')
    assert.ok(text.includes('Remember me') && text.includes('Forgot password?'))
  })
})
