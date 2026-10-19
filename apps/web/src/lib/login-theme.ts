/**
 * Pure helpers for the admin-managed login-page theme (Admin → Settings → Appearance → Login page theme).
 * No React, no network, no browser APIs: shared by the auth layout, the admin editor and its live preview, so the preview
 * is drawn by exactly the code that draws the real page. The server (appearance.schema.ts) has the final say on the same
 * rules; tests/login-theme.test.ts keeps the two in step.
 *
 * The theme only ever becomes CSS variables on the auth layout's own root element (see `loginThemeVars`). It never touches
 * the document, localStorage or the portal's light/dark preference, so the signed-in portal is unaffected by it.
 */

export const LOGIN_THEME_COLOR_KEYS = ['pageBg', 'text', 'textSecondary', 'buttonBg', 'buttonText', 'inputBg', 'inputBorder', 'accent', 'heroOverlay'] as const
export type LoginThemeColorKey = (typeof LOGIN_THEME_COLOR_KEYS)[number]
export type LoginThemeColors = Record<LoginThemeColorKey, string>

/** What the server stores and the public login-branding endpoint serves. null = the built-in login colors. */
export interface LoginTheme {
  colors: LoginThemeColors
}

export const LOGIN_THEME_FIELDS: ReadonlyArray<{ key: LoginThemeColorKey; label: string; hint: string }> = [
  { key: 'pageBg', label: 'Page and form background', hint: 'Behind the sign-in form.' },
  { key: 'text', label: 'Main text', hint: 'Headings, labels and typed text.' },
  { key: 'textSecondary', label: 'Secondary text', hint: 'Descriptions, placeholders and icons.' },
  { key: 'buttonBg', label: 'Primary button background', hint: 'The Sign in / Next button.' },
  { key: 'buttonText', label: 'Primary button text', hint: 'The label on that button.' },
  { key: 'inputBg', label: 'Input background', hint: 'Inside text fields.' },
  { key: 'inputBorder', label: 'Input border', hint: 'Around text fields and dividers.' },
  { key: 'accent', label: 'Accent / link color', hint: 'Links, focus ring and the secondary button.' },
  { key: 'heroOverlay', label: 'Left hero panel overlay', hint: 'Tints the picture; also the panel background when there is no picture or it cannot load.' },
]

// ── HEX colors ─────────────────────────────────────────────────────────────────

/** Same rules as the server. Returns what is wrong in plain words, or null when the value is a valid 3- or 6-digit HEX color. */
export function hexColorProblem(value: string): string | null {
  const v = value.trim()
  if (v === '') return 'Enter a HEX color such as #16A34A.'
  if (!v.startsWith('#')) return 'A HEX color starts with # (for example #16A34A).'
  if (!/^#[0-9a-fA-F]*$/.test(v)) return 'A HEX color can only use the digits 0-9 and the letters A-F (for example #16A34A).'
  if (v.length !== 4 && v.length !== 7) return 'A HEX color has 3 or 6 digits after the # (for example #16A34A).'
  return null
}

/** `#RRGGBB` in capitals (3-digit colors are expanded), or null when the value is not a valid HEX color. */
export function normalizeHex(value: string): string | null {
  if (hexColorProblem(value)) return null
  const v = value.trim().slice(1).toUpperCase()
  return `#${v.length === 3 ? [...v].map((d) => d + d).join('') : v}`
}

const FULL_HEX = /^#[0-9A-F]{6}$/

const channels = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
const toHex = (rgb: number[]) => `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`.toUpperCase()
const rgba = (hex: string, alpha: number) => `rgba(${channels(hex).join(', ')}, ${alpha})`
/** `amount` of `other` mixed into `hex` (0 = hex, 1 = other). */
const mix = (hex: string, other: string, amount: number) => {
  const [a, b] = [channels(hex), channels(other)]
  return toHex(a.map((c, i) => c + (b[i] - c) * amount))
}

// ── Contrast (WCAG 2.x) ────────────────────────────────────────────────────────

const channelLuminance = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex)
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b)
}
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** The ratio WCAG asks for normal text (AA). Below it the admin is warned. */
export const LOGIN_THEME_TEXT_RATIO = 4.5
/** The ratio WCAG asks for interface parts such as field borders. */
export const LOGIN_THEME_UI_RATIO = 3
/**
 * Below this the sign-in page can hardly be read at all, so for the pairs a visitor needs in order to sign in (`required`)
 * the theme is refused instead of only warned about. Everyone, including the admins, signs in through this page.
 */
export const LOGIN_THEME_MIN_RATIO = 3

interface ContrastRule {
  id: string
  label: string
  fg: LoginThemeColorKey
  bg: LoginThemeColorKey
  min: number
  /** Needed to read the form and sign in: refused (not just warned about) below LOGIN_THEME_MIN_RATIO. */
  required?: boolean
}
const CONTRAST_RULES: readonly ContrastRule[] = [
  { id: 'text-page', label: 'Main text on the page background', fg: 'text', bg: 'pageBg', min: LOGIN_THEME_TEXT_RATIO, required: true },
  { id: 'button', label: 'Primary button text on the button', fg: 'buttonText', bg: 'buttonBg', min: LOGIN_THEME_TEXT_RATIO, required: true },
  { id: 'text-input', label: 'Text typed into fields', fg: 'text', bg: 'inputBg', min: LOGIN_THEME_TEXT_RATIO, required: true },
  { id: 'secondary-page', label: 'Secondary text on the page background', fg: 'textSecondary', bg: 'pageBg', min: LOGIN_THEME_TEXT_RATIO },
  { id: 'secondary-input', label: 'Placeholder text inside fields', fg: 'textSecondary', bg: 'inputBg', min: LOGIN_THEME_TEXT_RATIO },
  { id: 'accent-page', label: 'Links and accent on the page background', fg: 'accent', bg: 'pageBg', min: LOGIN_THEME_TEXT_RATIO },
  { id: 'accent-input', label: 'Secondary button text on its background', fg: 'accent', bg: 'inputBg', min: LOGIN_THEME_TEXT_RATIO },
]

export interface ContrastIssue {
  id: string
  label: string
  ratio: number
  /** The ratio that would be fine. */
  min: number
  /** `error` = refused on save; `warning` = allowed, but hard to read for some people. */
  level: 'error' | 'warning'
}

/** Every pair of colors that is too close, worst first. Empty = all fine. Expects valid `#RRGGBB` colors. */
export function contrastIssues(colors: LoginThemeColors): ContrastIssue[] {
  const issues: ContrastIssue[] = []
  for (const rule of CONTRAST_RULES) {
    const ratio = contrastRatio(colors[rule.fg], colors[rule.bg])
    if (ratio >= rule.min) continue
    issues.push({ id: rule.id, label: rule.label, ratio, min: rule.min, level: rule.required && ratio < LOGIN_THEME_MIN_RATIO ? 'error' : 'warning' })
  }
  // A field is found by its fill or by its border: only when neither stands out from the page is it hard to see.
  const edge = Math.max(contrastRatio(colors.inputBorder, colors.pageBg), contrastRatio(colors.inputBg, colors.pageBg))
  if (edge < LOGIN_THEME_UI_RATIO) {
    issues.push({ id: 'field-edge', label: 'Field borders against the page', ratio: edge, min: LOGIN_THEME_UI_RATIO, level: 'warning' })
  }
  return issues.sort((a, b) => Number(b.level === 'error') - Number(a.level === 'error') || a.ratio / a.min - b.ratio / b.min)
}

/** "Main text on the page background: 1.4 : 1 (4.5 : 1 is recommended)", or what is required when the theme would be refused. */
export const describeIssue = (issue: ContrastIssue): string =>
  issue.level === 'error'
    ? `${issue.label}: ${issue.ratio.toFixed(1)} : 1. At least ${LOGIN_THEME_MIN_RATIO} : 1 is required to save, and ${issue.min} : 1 is recommended`
    : `${issue.label}: ${issue.ratio.toFixed(1)} : 1 (${issue.min} : 1 is recommended)`

// ── Presets ────────────────────────────────────────────────────────────────────

export type LoginThemePresetId = 'light' | 'dark' | 'gray' | 'green'

/**
 * Starting points. Every one passes every contrast check above (tests/login-theme.test.ts), so a preset is always readable;
 * choosing one only fills the color fields, which can then be adjusted before saving.
 */
export const LOGIN_THEME_PRESETS: ReadonlyArray<{ id: LoginThemePresetId; label: string; description: string; colors: LoginThemeColors }> = [
  {
    id: 'light',
    label: 'Light',
    description: 'White form, blue button',
    colors: { pageBg: '#FFFFFF', text: '#0F172A', textSecondary: '#475569', buttonBg: '#1D4ED8', buttonText: '#FFFFFF', inputBg: '#FFFFFF', inputBorder: '#8493A8', accent: '#1D4ED8', heroOverlay: '#0F172A' },
  },
  {
    id: 'dark',
    label: 'Dark',
    description: 'Navy form, light text',
    colors: { pageBg: '#0F172A', text: '#F1F5F9', textSecondary: '#A3B1C6', buttonBg: '#2563EB', buttonText: '#FFFFFF', inputBg: '#1E293B', inputBorder: '#64748B', accent: '#60A5FA', heroOverlay: '#020617' },
  },
  {
    id: 'gray',
    label: 'Gray',
    description: 'Soft gray form, slate button',
    colors: { pageBg: '#F3F4F6', text: '#111827', textSecondary: '#4B5563', buttonBg: '#374151', buttonText: '#FFFFFF', inputBg: '#FFFFFF', inputBorder: '#6B7280', accent: '#334E68', heroOverlay: '#1F2937' },
  },
  {
    id: 'green',
    label: 'Green',
    description: 'Mint form, green button',
    colors: { pageBg: '#F0FDF4', text: '#052E16', textSecondary: '#3F5F4A', buttonBg: '#15803D', buttonText: '#FFFFFF', inputBg: '#FFFFFF', inputBorder: '#5E8E70', accent: '#166534', heroOverlay: '#052E16' },
  },
]

/** The preset whose colors these are exactly, or null for a custom palette. */
export function presetOf(colors: LoginThemeColors | null | undefined): LoginThemePresetId | null {
  if (!colors) return null
  return LOGIN_THEME_PRESETS.find((p) => LOGIN_THEME_COLOR_KEYS.every((k) => p.colors[k] === colors[k]?.toUpperCase()))?.id ?? null
}

// ── Applying a theme ───────────────────────────────────────────────────────────

/**
 * The colors of a served theme, or null when there is none or the answer is not a complete set of `#RRGGBB` colors.
 * Values end up in CSS, so anything that is not exactly a hex color is ignored and the built-in look is shown instead.
 */
export function loginThemeColors(theme: { colors?: Partial<Record<string, unknown>> } | null | undefined): LoginThemeColors | null {
  const colors = theme?.colors
  if (!colors || typeof colors !== 'object') return null
  const out: Partial<LoginThemeColors> = {}
  for (const key of LOGIN_THEME_COLOR_KEYS) {
    const value = colors[key]
    if (typeof value !== 'string' || !FULL_HEX.test(value)) return null
    out[key] = value
  }
  return out as LoginThemeColors
}

/** Light or dark text for the hero panel, whichever reads better on the overlay color. */
export const heroTextOn = (overlay: string): string => (contrastRatio('#FFFFFF', overlay) >= contrastRatio('#0F172A', overlay) ? '#FFFFFF' : '#0F172A')

/** The tint over the landscape: the overlay color, strongest at the top and bottom edges. */
export const heroOverlayGradient = (overlay: string): string =>
  `linear-gradient(180deg, ${rgba(overlay, 0.78)} 0%, ${rgba(overlay, 0.62)} 35%, ${rgba(overlay, 0.62)} 60%, ${rgba(overlay, 0.82)} 100%)`

/** Behind the panel when the landscape cannot be loaded (the built-in fallback gradient is used without a theme). */
export const heroFallbackGradient = (overlay: string): string => `linear-gradient(135deg, ${overlay} 0%, ${mix(overlay, '#000000', 0.35)} 100%)`

// ── Notice boxes (error / info / warning / success) ───────────────────────────

export type NoticeTone = 'error' | 'info' | 'warning' | 'success'
export const NOTICE_TONES: readonly NoticeTone[] = ['error', 'info', 'warning', 'success']
/** What each tone is called in login.css and the pages (`login-notice error`, …). The hue is blended into the theme's page color. */
const NOTICE_HUES: Record<NoticeTone, string> = { error: '#DC2626', info: '#2563EB', warning: '#D97706', success: '#16A34A' }

/**
 * Colors of a notice box on this theme: a tint of the tone's hue over the page background, a border between the two, and text
 * pushed toward white or black (whichever suits the background) until it passes 4.5 : 1 — so a notice is readable on Light, Dark,
 * Gray, Green and any custom page color, and still reads as an error / info / warning / success.
 */
export function noticeColors(tone: NoticeTone, colors: Pick<LoginThemeColors, 'pageBg'>): { bg: string; text: string; border: string } {
  const page = colors.pageBg
  const hue = NOTICE_HUES[tone]
  const towardWhite = contrastRatio('#FFFFFF', page) > contrastRatio('#000000', page)
  const bg = mix(page, hue, towardWhite ? 0.2 : 0.1)
  const border = mix(page, hue, towardWhite ? 0.5 : 0.3)
  const pole = contrastRatio('#FFFFFF', bg) >= contrastRatio('#000000', bg) ? '#FFFFFF' : '#000000'
  let text = mix(hue, pole, towardWhite ? 0.65 : 0.45)
  for (let i = 0; i < 24 && contrastRatio(text, bg) < LOGIN_THEME_TEXT_RATIO; i++) text = mix(text, pole, 0.15)
  // The better of white and black always gives at least 4.58 : 1, so landing on it is a guaranteed pass (mid-gray pages need this).
  if (contrastRatio(text, bg) < LOGIN_THEME_TEXT_RATIO) text = pole
  return { bg, text, border }
}

/**
 * The CSS variables login.css already reads (`--theme-*`), as an inline style for the auth layout's root element.
 * undefined = no theme: nothing is overridden and the stylesheet's built-in colors show.
 */
export function loginThemeVars(colors: LoginThemeColors | null | undefined): Record<string, string> | undefined {
  if (!colors) return undefined
  const c = colors
  const light = luminance(c.buttonBg) > 0.5
  const heroText = heroTextOn(c.heroOverlay)
  return {
    '--theme-right-bg': c.pageBg,
    '--theme-card-bg': c.pageBg,
    '--theme-card-border': c.inputBorder,
    '--theme-card-shadow': '0 10px 30px -10px rgba(0, 0, 0, 0.28), 0 2px 8px rgba(0, 0, 0, 0.08)',
    '--theme-text-heading': c.text,
    '--theme-text-subtitle': c.textSecondary,
    '--theme-label': c.text,
    '--theme-input-bg': c.inputBg,
    '--theme-input-border': c.inputBorder,
    '--theme-input-text': c.text,
    '--theme-input-placeholder': c.textSecondary,
    '--theme-input-icon': c.textSecondary,
    '--theme-input-focus-border': c.accent,
    '--theme-input-focus-ring': rgba(c.accent, 0.25),
    '--theme-btn-bg': c.buttonBg,
    '--theme-btn-bg-hover': light ? mix(c.buttonBg, '#000000', 0.15) : mix(c.buttonBg, '#FFFFFF', 0.12),
    '--theme-btn-text': c.buttonText,
    '--theme-btn-shadow': `0 4px 14px ${rgba(c.buttonBg, 0.35)}`,
    '--theme-spinner-track': rgba(c.buttonText, 0.35),
    '--theme-divider-border': c.inputBorder,
    '--theme-divider-text': c.textSecondary,
    '--theme-reg-text': c.text,
    '--theme-reg-desc': c.textSecondary,
    '--theme-reg-btn-bg': c.inputBg,
    '--theme-reg-btn-border': c.accent,
    '--theme-reg-btn-text': c.accent,
    '--theme-reg-btn-hover': rgba(c.accent, 0.12),
    '--theme-link': c.accent,
    '--theme-link-hover': mix(c.accent, c.text, 0.4),
    '--theme-accent': c.accent,
    // Soft tints of the accent (verify-email's badge, email chip and code-box highlight)
    '--theme-accent-soft': rgba(c.accent, 0.12),
    '--theme-accent-faint': rgba(c.accent, 0.08),
    '--theme-accent-line': rgba(c.accent, 0.22),
    '--theme-accent-glow': rgba(c.accent, 0.15),
    '--theme-checkbox-accent': c.accent,
    '--theme-mobile-border': c.inputBorder,
    ...Object.fromEntries(
      NOTICE_TONES.flatMap((tone) => {
        const n = noticeColors(tone, c)
        return [[`--theme-notice-${tone}-bg`, n.bg], [`--theme-notice-${tone}-text`, n.text], [`--theme-notice-${tone}-border`, n.border]]
      }),
    ),
    '--theme-hero-bg': c.heroOverlay,
    '--theme-hero-overlay': heroOverlayGradient(c.heroOverlay),
    '--theme-hero-text': heroText,
    '--theme-hero-text-muted': rgba(heroText, 0.9),
    '--theme-hero-text-soft': rgba(heroText, 0.78),
    '--theme-hero-text-shadow': heroText === '#FFFFFF' ? '0 1px 4px rgba(0, 0, 0, 0.35)' : '0 1px 3px rgba(255, 255, 255, 0.45)',
  }
}
