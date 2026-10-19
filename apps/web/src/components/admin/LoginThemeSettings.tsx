'use client'

import { useState } from 'react'
import { api, ApiError } from '@/lib/api'
import { LOGIN_FALLBACK_GRADIENT, cssUrl, loginHeading, loginSupportingLines, type AdminAppearance, type AppearanceDetail } from '@/lib/appearance-utils'
import {
  LOGIN_THEME_COLOR_KEYS,
  LOGIN_THEME_FIELDS,
  LOGIN_THEME_PRESETS,
  LOGIN_THEME_TEXT_RATIO,
  LOGIN_THEME_UI_RATIO,
  contrastIssues,
  describeIssue,
  heroFallbackGradient,
  hexColorProblem,
  loginThemeColors,
  loginThemeVars,
  normalizeHex,
  presetOf,
  type LoginThemeColorKey,
  type LoginThemeColors,
} from '@/lib/login-theme'
import '@/app/login/login.css'

type Draft = Record<LoginThemeColorKey, string>

const problemOf = (err: unknown, fallback: string) =>
  err instanceof ApiError ? (err.status === 422 && err.errors.length ? err.errors.map((e) => e.replace(/^[\w.]+: /, '')).join(' ') : err.message) : fallback

/** Colors typed in the HEX fields are kept as typed until they are valid; the picker and the preview use the last valid value. */
const KEYS = LOGIN_THEME_COLOR_KEYS

/**
 * The login page as visitors will see it, drawn by the real login classes and the same `loginThemeVars` the auth layout uses,
 * so the preview cannot drift from the page. No behaviour: it is hidden from assistive technology and cannot be focused.
 * `colors` null = the built-in look.
 */
export function LoginThemePreview({ colors, heading, imageUrl, supporting }: { colors: LoginThemeColors | null; heading: string; imageUrl: string | null; supporting: { text: string; tagline?: string } }) {
  // Same choice as the real page: the Admin's picture, else the theme's gradient, else the built-in gradient (no picture ships with the app).
  const background = (imageUrl ? cssUrl(imageUrl) : null) ?? (colors ? heroFallbackGradient(colors.heroOverlay) : LOGIN_FALLBACK_GRADIENT)
  return (
    // The frame only measures the room available (see "login-preview" in login.css): the two panels stack when it is narrow.
    <div className="login-theme-preview-frame">
      <div className="login-split login-theme-preview" style={loginThemeVars(colors)} aria-hidden="true" inert>
        <section className="login-left">
          <div className="login-left-bg loaded" style={{ backgroundImage: background, backgroundColor: 'var(--theme-hero-bg, #0f172a)' }} />
          <div className="login-left-content">
            <div className="login-left-logo">
              <div className="login-left-logo-icon">
                <img src="/hexalytelogo.jpeg" alt="" width={36} height={36} className="login-left-logo-img" />
              </div>
              <div>
                <div className="login-left-logo-text">Hexalyte Innovation</div>
                <div className="login-left-logo-sub">Central Partner Platform</div>
              </div>
            </div>
            <div className="login-left-hero">
              <h2>{heading}</h2>
              <p>{supporting.text}</p>
              {supporting.tagline && <p className="tagline">{supporting.tagline}</p>}
            </div>
          </div>
        </section>
        <section className="login-right">
          <div className="login-form-wrapper">
            <div className="login-form-heading">Sign in</div>
            <p className="login-form-subtitle">Welcome back. Enter your details to continue.</p>
            <div className="login-field">
              <span className="login-field-label">Email</span>
              <div className="login-field-input-wrap">
                <input className="login-field-input" readOnly tabIndex={-1} placeholder="you@company.com" style={{ paddingLeft: '0.85rem' }} />
              </div>
            </div>
            <div className="login-field">
              <span className="login-field-label">Password</span>
              <div className="login-field-input-wrap">
                <input className="login-field-input" readOnly tabIndex={-1} defaultValue="secret-password" type="password" style={{ paddingLeft: '0.85rem' }} />
              </div>
            </div>
            <div className="login-actions-row">
              <span className="login-remember">
                <input type="checkbox" readOnly tabIndex={-1} defaultChecked /> Remember me
              </span>
              <span className="login-forgot">Forgot password?</span>
            </div>
            <button type="button" className="login-submit" tabIndex={-1}>
              Sign in
            </button>
            <div className="login-divider">New here?</div>
            <div className="login-register-cta">
              <span className="login-register-btn">Create an account</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

/**
 * Admin → Settings → Appearance → Login page theme: four presets, a color picker plus HEX field for each color, a live preview
 * and a contrast check. Saving uses the same audited appearance endpoint as the other settings (reason required); nothing
 * changes for visitors until it is saved, and "Reset to default" removes the saved theme.
 */
export function LoginThemeSettings({
  data,
  canManage,
  imageUrl,
  onSaved,
}: {
  data: AdminAppearance
  canManage: boolean
  /** The login hero picture currently in use (a custom one, once loaded); null = the default gradient. */
  imageUrl: string | null
  onSaved: (updated: AdminAppearance, message: string) => void
}) {
  const savedColors = loginThemeColors(data.loginBranding.theme)
  const [draft, setDraft] = useState<Draft | null>(savedColors)
  // The last valid value of every color: while a HEX field is half-typed (so invalid) the preview and the picker keep showing it.
  const [good, setGood] = useState<LoginThemeColors | null>(savedColors)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const problems = Object.fromEntries(KEYS.map((k) => [k, draft ? hexColorProblem(draft[k]) : null])) as Record<LoginThemeColorKey, string | null>
  const valid = draft && KEYS.every((k) => !problems[k]) ? (Object.fromEntries(KEYS.map((k) => [k, normalizeHex(draft[k])])) as LoginThemeColors) : null
  const fallback = savedColors ?? LOGIN_THEME_PRESETS[0].colors
  const shownColor = (key: LoginThemeColorKey): string => (draft ? normalizeHex(draft[key]) : null) ?? good?.[key] ?? fallback[key]
  const previewColors = draft ? (Object.fromEntries(KEYS.map((k) => [k, shownColor(k)])) as LoginThemeColors) : savedColors
  const issues = valid ? contrastIssues(valid) : []
  const dirty = Boolean(draft) && (!valid || !savedColors || KEYS.some((k) => valid[k] !== savedColors[k]))
  const activePreset = presetOf(valid)

  const detail: AppearanceDetail = data.details.loginTheme
  const status = detail.custom
    ? `Custom · updated ${detail.updatedAt ? new Date(detail.updatedAt).toLocaleString() : ''}${detail.updatedBy ? ` by ${detail.updatedBy.name}` : ''}`
    : 'Using the built-in login colors'

  /** Replaces the whole draft (a preset, the saved colors, or what the server stored). */
  const adopt = (colors: Draft | null) => {
    setError(null)
    setDraft(colors)
    setGood(colors && (Object.fromEntries(KEYS.map((k) => [k, normalizeHex(colors[k]) ?? fallback[k]])) as LoginThemeColors))
  }
  const choosePreset = (colors: LoginThemeColors) => adopt({ ...colors })
  const setColor = (key: LoginThemeColorKey, value: string) => {
    setError(null)
    setDraft((d) => ({ ...(d ?? LOGIN_THEME_PRESETS[0].colors), [key]: value }))
    const valid = normalizeHex(value)
    if (valid) setGood((g) => ({ ...(g ?? fallback), [key]: valid }))
  }
  const discard = () => adopt(savedColors)

  const send = async (loginTheme: { colors: LoginThemeColors } | null, done: string) => {
    setBusy(true)
    setError(null)
    try {
      const updated = await api<AdminAppearance>('/admin/settings/appearance', { method: 'PUT', body: JSON.stringify({ loginTheme, reason: reason.trim() }) })
      adopt(loginThemeColors(updated.loginBranding.theme))
      setReason('')
      onSaved(updated, `${done} All admins have been notified.`)
    } catch (err) {
      setError(problemOf(err, 'Save failed'))
    } finally {
      setBusy(false)
    }
  }

  const save = async (e?: { preventDefault(): void }) => {
    e?.preventDefault()
    if (!draft) return setError('Nothing to save yet. Choose a preset or change a color first.')
    for (const field of LOGIN_THEME_FIELDS) {
      const problem = problems[field.key]
      if (problem) return setError(`${field.label}: ${problem}`)
    }
    if (!valid) return
    if (!dirty) return setError('Nothing to save yet. Change a color first.')
    const blocking = issues.find((i) => i.level === 'error')
    if (blocking) return setError(`These colors cannot be saved because the sign-in page would be unreadable. ${describeIssue(blocking)}.`)
    if (reason.trim().length < 5) return setError('Give a reason for the change (at least 5 characters).')
    await send({ colors: valid }, 'Login page theme saved.')
  }

  const reset = async () => {
    if (reason.trim().length < 5) return setError('Give a reason for the change (at least 5 characters).')
    if (!confirm('Reset the login page colors to the built-in look? The saved theme will be removed.')) return
    await send(null, 'Login page theme reset to the built-in colors.')
  }

  return (
    <form id="login-theme" onSubmit={save} noValidate>
      <h3 style={{ marginBottom: '0.25rem' }}>Login page theme</h3>
      <p className="small muted" style={{ marginTop: 0 }}>
        Colors for the sign-in, registration, forgot-password, reset-password and email-verification pages. They are shown to everyone who opens those pages, and
        they never change the theme of the signed-in portal. {status}.
      </p>

      {canManage && (
        <div className="row" role="group" aria-label="Theme presets" style={{ marginBottom: '0.75rem' }}>
          {LOGIN_THEME_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`btn small ${activePreset === preset.id ? '' : 'secondary'}`}
              aria-pressed={activePreset === preset.id}
              title={preset.description}
              disabled={busy}
              onClick={() => choosePreset(preset.colors)}
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}

      {draft && (
        <>
          <div className="grid-2">
            {LOGIN_THEME_FIELDS.map(({ key, label, hint }) => {
              const problem = problems[key]
              const shown = shownColor(key)
              return (
                <div className={`field${problem ? ' has-error' : ''}`} key={key}>
                  <label htmlFor={`login-color-${key}`}>{label}</label>
                  <div className="row" style={{ flexWrap: 'nowrap', gap: '0.5rem' }}>
                    <input
                      id={`login-color-${key}-picker`}
                      type="color"
                      aria-label={`${label}: color picker`}
                      value={shown.toLowerCase()}
                      disabled={!canManage || busy}
                      onChange={(e) => setColor(key, e.target.value.toUpperCase())}
                      style={{ width: 46, height: 40, padding: 2, cursor: canManage ? 'pointer' : 'default', flexShrink: 0 }}
                    />
                    <input
                      id={`login-color-${key}`}
                      type="text"
                      value={draft[key]}
                      maxLength={7}
                      placeholder="#16A34A"
                      spellCheck={false}
                      autoComplete="off"
                      aria-invalid={Boolean(problem)}
                      aria-describedby={`login-color-${key}-note`}
                      disabled={!canManage || busy}
                      onChange={(e) => setColor(key, e.target.value)}
                      style={{ fontFamily: 'monospace', minWidth: 0, width: '100%' }}
                    />
                  </div>
                  {problem ? (
                    <div className="error" id={`login-color-${key}-note`} role="alert">
                      {problem}
                    </div>
                  ) : (
                    <div className="hint" id={`login-color-${key}-note`}>
                      {hint}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          <div role="status" aria-live="polite" style={{ margin: '0.75rem 0' }}>
            {!valid ? (
              <p className="small muted" style={{ margin: 0 }}>
                Enter a valid HEX color in every field to check the contrast.
              </p>
            ) : issues.length === 0 ? (
              <div className="alert success small">
                Contrast is good: text meets {LOGIN_THEME_TEXT_RATIO} : 1 and field borders meet {LOGIN_THEME_UI_RATIO} : 1.
              </div>
            ) : (
              issues.map((issue) => (
                <div key={issue.id} className={`alert ${issue.level === 'error' ? 'error' : 'warning'} small`}>
                  {issue.level === 'error' ? 'Cannot be saved. ' : 'Hard to read for some people. '}
                  {describeIssue(issue)}
                </div>
              ))
            )}
          </div>
        </>
      )}

      <p className="small muted" style={{ marginBottom: '0.35rem' }}>
        Preview{draft && dirty ? ' (not saved yet)' : ''}: this is the login page with {previewColors ? 'these colors' : 'the built-in colors'}, your current heading, text and picture.
      </p>
      <LoginThemePreview colors={previewColors} heading={loginHeading(data.loginBranding)} supporting={loginSupportingLines(data.loginBranding)} imageUrl={imageUrl} />

      {canManage && (
        <>
          <div className="field" style={{ marginTop: '0.75rem' }}>
            <label htmlFor="login-theme-reason">Reason for change (audited)</label>
            <input id="login-theme-reason" maxLength={300} value={reason} onChange={(e) => (setReason(e.target.value), setError(null))} disabled={busy} />
          </div>
          {error && (
            <div className="alert error small" role="alert">
              {error}
            </div>
          )}
          <div className="row">
            <span className="spacer" />
            {dirty && (
              <button type="button" className="btn secondary" onClick={discard} disabled={busy}>
                Discard changes
              </button>
            )}
            {detail.custom && (
              <button type="button" className="btn secondary" onClick={reset} disabled={busy}>
                Reset to default
              </button>
            )}
            <button type="submit" className="btn" disabled={busy}>
              {busy ? 'Saving…' : 'Save login theme'}
            </button>
          </div>
        </>
      )}
    </form>
  )
}
