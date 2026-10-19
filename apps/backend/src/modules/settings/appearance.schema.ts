import { z } from 'zod'
import { reason } from './settings.schema'

export const THEME_MODES = ['light', 'dark', 'system'] as const
export type ThemeMode = (typeof THEME_MODES)[number]

/** What the web app shows today when nobody (admin or reseller) has chosen a color mode. */
export const BUILT_IN_THEME: ThemeMode = 'dark'

export const WELCOME_TEXT_MAX_LENGTH = 120

/** One line of plain text. `{name}` is replaced with the reseller's name on the dashboard; no other placeholder exists. */
export const welcomeTextSchema = z
  .string()
  .trim()
  .min(1, 'Enter the welcome text, or reset it to the built-in text')
  .max(WELCOME_TEXT_MAX_LENGTH, `Welcome text can be at most ${WELCOME_TEXT_MAX_LENGTH} characters`)
  .refine((text) => !/[\u0000-\u001f\u007f]/.test(text), 'Welcome text must be a single line without control characters')
  .refine((text) => !/[{}]/.test(text.split('{name}').join('')), 'Only the {name} placeholder can be used in braces')

export const LOGIN_HEADING_MAX_LENGTH = 80
export const LOGIN_TEXT_MAX_LENGTH = 200

/** One line of plain text for the login page (React escapes it; there are no placeholders). */
const loginLine = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `Enter the ${label}, or reset it to the built-in text`)
    .max(max, `The ${label} can be at most ${max} characters`)
    .refine((text) => !/[\u0000-\u001f\u007f]/.test(text), `The ${label} must be a single line without control characters`)

export const loginHeadingSchema = loginLine('login heading', LOGIN_HEADING_MAX_LENGTH)
export const loginTextSchema = loginLine('login supporting text', LOGIN_TEXT_MAX_LENGTH)

// ── Login page theme ────────────────────────────────────────────────────────────
// The web app (apps/web/src/lib/login-theme.ts) applies these colors and shows the same checks while the admin edits;
// tests/login-theme.test.ts keeps the two copies of the rules in step.

export const LOGIN_THEME_COLOR_KEYS = ['pageBg', 'text', 'textSecondary', 'buttonBg', 'buttonText', 'inputBg', 'inputBorder', 'accent', 'heroOverlay'] as const
export type LoginThemeColorKey = (typeof LOGIN_THEME_COLOR_KEYS)[number]
export type LoginThemeColors = Record<LoginThemeColorKey, string>

export const LOGIN_THEME_LABELS: Record<LoginThemeColorKey, string> = {
  pageBg: 'Page and form background',
  text: 'Main text',
  textSecondary: 'Secondary text',
  buttonBg: 'Primary button background',
  buttonText: 'Primary button text',
  inputBg: 'Input background',
  inputBorder: 'Input border',
  accent: 'Accent / link color',
  heroOverlay: 'Left hero panel overlay',
}

/** What is wrong with a HEX color in plain words, or null when it is a valid 3- or 6-digit value. */
export function hexColorProblem(value: string): string | null {
  const v = value.trim()
  if (v === '') return 'Enter a HEX color such as #16A34A.'
  if (!v.startsWith('#')) return 'A HEX color starts with # (for example #16A34A).'
  if (!/^#[0-9a-fA-F]*$/.test(v)) return 'A HEX color can only use the digits 0-9 and the letters A-F (for example #16A34A).'
  if (v.length !== 4 && v.length !== 7) return 'A HEX color has 3 or 6 digits after the # (for example #16A34A).'
  return null
}

/** Stored and served as `#RRGGBB` in capitals, so the same color always has the same text (and "no change" is detectable). */
const hexColorSchema = z
  .string({ required_error: 'Enter a HEX color such as #16A34A.', invalid_type_error: 'A color must be text such as #16A34A.' })
  .superRefine((value, ctx) => {
    const problem = hexColorProblem(value)
    if (problem) ctx.addIssue({ code: 'custom', message: problem })
  })
  .transform((value) => {
    const v = value.trim().slice(1).toUpperCase()
    return `#${v.length === 3 ? [...v].map((d) => d + d).join('') : v}`
  })

const channelLuminance = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b)
}
export const contrastRatio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * Below this ratio the sign-in form can hardly be read, and everyone (admins included) signs in through it, so these pairs
 * are refused. Anything between this and WCAG's 4.5 : 1 is only a warning in the admin screen, never an API error.
 */
export const LOGIN_THEME_MIN_RATIO = 3
const REQUIRED_PAIRS: ReadonlyArray<[LoginThemeColorKey, LoginThemeColorKey, string]> = [
  ['text', 'pageBg', 'Main text on the page background'],
  ['buttonText', 'buttonBg', 'Primary button text on the button'],
  ['text', 'inputBg', 'Text typed into fields'],
]

export const loginThemeSchema = z
  .object({
    colors: z.object(Object.fromEntries(LOGIN_THEME_COLOR_KEYS.map((k) => [k, hexColorSchema])) as Record<LoginThemeColorKey, typeof hexColorSchema>).strict(),
  })
  .strict()
  .superRefine(({ colors }, ctx) => {
    for (const [fg, bg, label] of REQUIRED_PAIRS) {
      const ratio = contrastRatio(colors[fg], colors[bg])
      if (ratio < LOGIN_THEME_MIN_RATIO) {
        ctx.addIssue({
          code: 'custom',
          path: ['colors', fg],
          message: `${label} is too hard to read (${ratio.toFixed(1)} : 1). ${LOGIN_THEME_LABELS[fg]} and ${LOGIN_THEME_LABELS[bg]} need at least ${LOGIN_THEME_MIN_RATIO} : 1, or nobody could sign in.`,
        })
      }
    }
  })

export type LoginThemeInput = z.output<typeof loginThemeSchema>

/**
 * Each field is optional: leave it out to keep the current value, send `null` to go back to the built-in default.
 * Images are changed through their own upload/reset endpoints.
 */
export const updateAppearanceSchema = z
  .object({
    defaultTheme: z.enum(THEME_MODES).nullable().optional(),
    welcomeText: z
      .object({ en: welcomeTextSchema.nullable().optional(), si: welcomeTextSchema.nullable().optional() })
      .strict()
      .optional(),
    loginBranding: z
      .object({ heading: loginHeadingSchema.nullable().optional(), text: loginTextSchema.nullable().optional() })
      .strict()
      .optional(),
    /** The login page's colors; `null` goes back to the built-in colors. */
    loginTheme: loginThemeSchema.nullable().optional(),
    reason,
  })
  .strict()
  .refine(
    (v) =>
      v.defaultTheme !== undefined ||
      v.welcomeText?.en !== undefined ||
      v.welcomeText?.si !== undefined ||
      v.loginBranding?.heading !== undefined ||
      v.loginBranding?.text !== undefined ||
      v.loginTheme !== undefined,
    { message: 'Change at least one appearance setting' },
  )

/** Body of an image upload (multipart text field) and of an image reset. */
export const appearanceImageReasonSchema = z.object({ reason }).strict()

export type UpdateAppearanceInput = z.infer<typeof updateAppearanceSchema>
