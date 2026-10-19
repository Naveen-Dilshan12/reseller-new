/**
 * Pure helpers for the admin-managed portal appearance (hero image, logo, welcome texts, default color mode).
 * No React, no network: shared by the dashboard, the shells, the theme provider and the admin settings page.
 * (The login page's color theme has its own file, login-theme.ts.)
 */

import type { LoginTheme } from './login-theme'

export type ThemeMode = 'light' | 'dark' | 'system'
export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system']

/** What the portal looks like today when neither the admin nor the user has chosen a color mode. */
export const BUILT_IN_THEME: ThemeMode = 'dark'

/** The user's own choice (set by the theme toggle). It always wins over the admin default. */
export const THEME_STORAGE_KEY = 'hexalyte-theme-preference'
/** Last admin default seen on this browser; lets the page paint in the right mode before the API answers. */
export const THEME_DEFAULT_KEY = 'hexalyte-theme-default'

/**
 * The dashboard / page hero when no custom image is set: a neutral gradient, one per color mode. No picture ships with the
 * app. The same two values are written into the hero rules of globals.css (a test keeps them in step).
 */
export const HERO_FALLBACK_DARK = 'linear-gradient(135deg, #0e1526 0%, #14233f 55%, #1b2f4f 100%)'
export const HERO_FALLBACK_LIGHT = 'linear-gradient(135deg, #f8f6f0 0%, #efe8d8 55%, #e4dccb 100%)'

export const WELCOME_TEXT_MAX_LENGTH = 120

// ── Login page ──────────────────────────────────────────────────────────────────
// What the sign-in / registration screens show until the admin saves their own image, heading or supporting text.

/** Accessible name of the panel background, whether it is the Admin's picture or the default gradient. */
export const LOGIN_BACKGROUND_LABEL = 'Hexalyte Innovation login background'
/**
 * Behind the panel whenever there is no custom login picture, or it cannot be loaded. No picture ships with the app, so
 * nothing is downloaded for the default look.
 */
export const LOGIN_FALLBACK_GRADIENT = 'linear-gradient(135deg, #0a1f3d 0%, #0d3b66 50%, #17422d 100%)'
export const BUILT_IN_LOGIN_HEADING = 'Empowering Businesses Across Sri Lanka'
/** The built-in supporting text is two lines; a custom supporting text replaces both. */
export const BUILT_IN_LOGIN_TEXT = '“Simple Solutions for a Stronger Tomorrow”'
export const BUILT_IN_LOGIN_TAGLINE = '“Built for a Better Sri Lanka.”'
/** Login branding is served without a sign-in, so the image is fetched from this public path. */
export const LOGIN_IMAGE_PATH = '/public/login-branding/hero-image'
/** The login stylesheet hides the landscape panel at exactly this width and below (login.css, "Responsive"): keep the two in step. */
export const HERO_PANEL_HIDDEN_QUERY = '(max-width: 1024px)'

export const LOGIN_HEADING_MAX_LENGTH = 80
export const LOGIN_TEXT_MAX_LENGTH = 200

export const parseThemeMode = (value: unknown): ThemeMode | null => THEME_MODES.find((m) => m === value) ?? null

/** The mode to show: the user's own choice, else the admin default, else the built-in one. */
export const resolveThemeMode = (personal: unknown, adminDefault: unknown): ThemeMode =>
  parseThemeMode(personal) ?? parseThemeMode(adminDefault) ?? BUILT_IN_THEME

export interface AppearanceSettings {
  defaultTheme: ThemeMode
  /** null = use the built-in translation for that language. */
  welcomeText: { en: string | null; si: string | null }
  /** `version` changes whenever the image is replaced. null = use the built-in image. */
  heroImage: { version: string } | null
  logo: { version: string } | null
}

export interface AppearanceDetail {
  custom: boolean
  updatedAt: string | null
  updatedBy: { name: string; email: string } | null
}

export interface ImageLimits {
  maxBytes: number
  minWidth: number
  minHeight: number
  maxSide: number
}

/**
 * The only branding a logged-out visitor receives. null = use the built-in heading, supporting text, image or colors.
 * `theme` is optional so an answer from a server that does not know it yet simply means "built-in colors".
 */
export interface LoginBranding {
  heading: string | null
  text: string | null
  heroImage: { version: string } | null
  theme?: LoginTheme | null
}

export interface AdminAppearance extends AppearanceSettings {
  loginBranding: LoginBranding
  details: Record<'heroImage' | 'logo' | 'welcomeTextEn' | 'welcomeTextSi' | 'defaultTheme' | 'loginImage' | 'loginHeading' | 'loginText' | 'loginTheme', AppearanceDetail>
  limits: {
    imageTypes: string[]
    hero: ImageLimits
    logo: ImageLimits
    login: ImageLimits
    welcomeTextMaxLength: number
    loginHeadingMaxLength: number
    loginTextMaxLength: number
  }
}

export type ImageKind = 'hero' | 'logo' | 'login'

/** The sections of Admin → Settings → Appearance. An `id` is also the URL hash (`/admin/settings#login-theme`), so a section can be linked to. */
export const APPEARANCE_SECTIONS = [
  { id: 'general', label: 'General appearance' },
  { id: 'login-branding', label: 'Login page branding' },
  { id: 'login-theme', label: 'Login page theme' },
] as const
export type AppearanceSectionId = (typeof APPEARANCE_SECTIONS)[number]['id']
export const DEFAULT_APPEARANCE_SECTION: AppearanceSectionId = 'general'

/** The section a URL hash (with or without the `#`) points at, or null when it is not one of ours. */
export const appearanceSectionFromHash = (hash: string): AppearanceSectionId | null => APPEARANCE_SECTIONS.find((s) => s.id === hash.replace(/^#/, ''))?.id ?? null

/** The admin's welcome text for this language, or null to use the built-in translation. */
export function customWelcomeText(language: 'en' | 'si', appearance: AppearanceSettings | null): string | null {
  return appearance?.welcomeText?.[language] || null
}

/** Puts the reseller's name into the text. A function replacer keeps `$` characters in names literal. */
export const fillWelcomeName = (template: string, name: string): string => template.replace(/\{name\}/g, () => name)

/**
 * The dashboard heading: the admin's text for this language (with the reseller's name filled in), or `builtIn`, the
 * translation that ships with the app. The other language's custom text is never used as a stand-in.
 */
export function welcomeHeading(language: 'en' | 'si', appearance: AppearanceSettings | null, name: string, builtIn: string): string {
  const custom = customWelcomeText(language, appearance)
  return custom ? fillWelcomeName(custom, name) : builtIn
}

/**
 * Inline style for the dashboard hero: the custom image through a CSS variable (the stylesheet falls back to the
 * default gradient when the variable is not set). While a custom image is still downloading the picture is switched
 * off instead, so the default gradient does not flash first.
 */
export function heroBackgroundVars(hero: { url: string | null; status: string }, hasCustomImage: boolean): Record<string, string> | undefined {
  const image = hero.url ? cssUrl(hero.url) : null
  if (image) return { '--dash-hero-image': image }
  if (hasCustomImage && hero.status === 'loading') return { '--dash-hero-image': 'none' }
  return undefined
}

/** `url("…")` for a CSS value, or null when the address holds a character that could break out of it. */
export const cssUrl = (url: string): string | null => (/["')\\\s]/.test(url) ? null : `url("${url}")`)

/** The login heading to show: the admin's text, else the built-in one. */
export const loginHeading = (branding: LoginBranding | null): string => branding?.heading || BUILT_IN_LOGIN_HEADING

/** The login supporting lines to show: the admin's single text, else the two built-in lines. */
export const loginSupportingLines = (branding: LoginBranding | null): { text: string; tagline?: string } =>
  branding?.text ? { text: branding.text } : { text: BUILT_IN_LOGIN_TEXT, tagline: BUILT_IN_LOGIN_TAGLINE }

/** Same rules as the server (which has the final say) for the login heading / supporting text. Returns the problem, or null. */
export function validateLoginText(text: string, max: number): string | null {
  const value = text.trim()
  if (value.length > max) return `Can be at most ${max} characters.`
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'Must be a single line.'
  return null
}

/** Same rules as the server (which has the final say). Returns the problem, or null when the text is fine. */
export function validateWelcomeText(text: string): string | null {
  const value = text.trim()
  if (value.length > WELCOME_TEXT_MAX_LENGTH) return `Welcome text can be at most ${WELCOME_TEXT_MAX_LENGTH} characters.`
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'Welcome text must be a single line.'
  if (/[{}]/.test(value.split('{name}').join(''))) return 'Only the {name} placeholder can be used in braces.'
  return null
}

export function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

const EXTENSIONS: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }

/**
 * Quick check before uploading, so an obviously wrong file is refused without a round trip. The browser's idea of the
 * type is only a hint: the server identifies the file from its content and also checks the pixel size.
 */
export function checkImageChoice(file: { name: string; size: number; type: string }, limits: Pick<ImageLimits, 'maxBytes'>, imageTypes: string[]): string | null {
  const byExtension = EXTENSIONS[file.name.split('.').pop()?.toLowerCase() ?? '']
  const declared = imageTypes.includes(file.type) ? file.type : byExtension
  if (!declared || !imageTypes.includes(declared)) return 'Choose a JPG, PNG or WEBP image.'
  if (file.size === 0) return 'That file is empty.'
  if (file.size > limits.maxBytes) return `The image must be ${formatBytes(limits.maxBytes)} or smaller (this one is ${formatBytes(file.size)}).`
  return null
}
