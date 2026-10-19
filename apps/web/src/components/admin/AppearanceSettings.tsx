'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '@/lib/api'
import { refreshAppearance, useProtectedImage } from '@/lib/appearance'
import {
  APPEARANCE_SECTIONS,
  BUILT_IN_LOGIN_HEADING,
  BUILT_IN_LOGIN_TAGLINE,
  BUILT_IN_LOGIN_TEXT,
  DEFAULT_APPEARANCE_SECTION,
  HERO_FALLBACK_DARK,
  LOGIN_FALLBACK_GRADIENT,
  LOGIN_IMAGE_PATH,
  appearanceSectionFromHash,
  checkImageChoice,
  formatBytes,
  validateLoginText,
  validateWelcomeText,
  type AdminAppearance,
  type AppearanceDetail,
  type AppearanceSectionId,
  type ImageKind,
  type ThemeMode,
} from '@/lib/appearance-utils'
import { builtInText } from '@/lib/i18n'
import { LoginThemeSettings } from './LoginThemeSettings'

const IMAGES: Record<
  ImageKind,
  { path: string; label: string; builtIn: string; detail: 'heroImage' | 'logo' | 'loginImage'; upload: string; reset: string; audience: string; about: string }
> = {
  hero: {
    path: 'hero-image',
    label: 'Dashboard hero image',
    builtIn: 'default background',
    detail: 'heroImage',
    upload: 'Upload hero image',
    reset: 'Reset hero image',
    audience: 'Partners',
    about: 'Background of the banner at the top of every partner page (dashboard, customers, products, activations and the rest).',
  },
  logo: {
    path: 'logo',
    label: 'Platform logo',
    builtIn: 'built-in “H” mark',
    detail: 'logo',
    upload: 'Upload logo',
    reset: 'Reset logo',
    audience: 'Partners',
    about: 'Shown in the header of the partner and admin consoles.',
  },
  login: {
    path: 'login-image',
    label: 'Login page hero image',
    builtIn: 'default background',
    detail: 'loginImage',
    upload: 'Upload login image',
    reset: 'Reset login image',
    audience: 'Visitors',
    about: 'Landscape beside the sign-in and registration forms. It is shown to everyone who opens those pages, signed in or not, so only upload a picture that is fine to show publicly.',
  },
}
// The three sections, in the order of APPEARANCE_SECTIONS (the ids live there only).
const [GENERAL, LOGIN_BRANDING, LOGIN_COLORS] = APPEARANCE_SECTIONS
// What stands in for a picture that has not been uploaded: a plain gradient swatch (no picture ships with the app).
const DEFAULT_BACKGROUND: Record<'hero' | 'login', string> = { hero: HERO_FALLBACK_DARK, login: LOGIN_FALLBACK_GRADIENT }
const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'si', label: 'Sinhala' },
] as const
const THEME_LABELS: Record<ThemeMode, string> = { light: 'Light', dark: 'Dark', system: 'System (follow the device)' }

interface ImageForm {
  file: File | null
  reason: string
  error: string | null
}
const emptyImage: ImageForm = { file: null, reason: '', error: null }

const problemOf = (err: unknown, fallback: string) =>
  err instanceof ApiError ? (err.status === 422 && err.errors.length ? err.errors.map((e) => e.replace(/^[\w.]+: /, '')).join(' ') : err.message) : fallback

/** A preview of the file the admin just picked. The temporary URL is released when the file changes or the page closes. */
function useObjectUrl(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!file) {
      setUrl(null)
      return
    }
    const next = URL.createObjectURL(file)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [file])
  return url
}

/**
 * Admin → Settings → Appearance. Everything here is global (one setting for all resellers). Each change needs a reason
 * and is audited; an image or text that has never been customized shows the built-in one and says so.
 */
export function AppearanceSettings({ canManage }: { canManage: boolean }) {
  const [data, setData] = useState<AdminAppearance | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [images, setImages] = useState<Record<ImageKind, ImageForm>>({ hero: emptyImage, logo: emptyImage, login: emptyImage })
  // Changing a file input's key empties it, which is how a rejected or finished choice is cleared from the picker.
  const [pickers, setPickers] = useState<Record<ImageKind, number>>({ hero: 0, logo: 0, login: 0 })
  const [text, setText] = useState<{ en: string; si: string; theme: ThemeMode; reason: string; error: string | null }>({
    en: '',
    si: '',
    theme: 'dark',
    reason: '',
    error: null,
  })
  const [loginText, setLoginText] = useState<{ heading: string; text: string; reason: string; error: string | null }>({ heading: '', text: '', reason: '', error: null })
  // Only the open section is shown, but every section stays mounted (hidden), so a half-filled form or a picked file survives switching.
  // Nothing is drawn from this before the settings have loaded, so reading the URL hash here cannot disagree with the server render.
  const [section, setSection] = useState<AppearanceSectionId>(() => appearanceSectionFromHash(typeof window === 'undefined' ? '' : window.location.hash) ?? DEFAULT_APPEARANCE_SECTION)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const follow = () => setSection((open) => appearanceSectionFromHash(window.location.hash) ?? open)
    window.addEventListener('hashchange', follow)
    return () => window.removeEventListener('hashchange', follow)
  }, [])

  const previews: Record<ImageKind, string | null> = {
    hero: useObjectUrl(images.hero.file),
    logo: useObjectUrl(images.logo.file),
    login: useObjectUrl(images.login.file),
  }
  const currents: Record<ImageKind, ReturnType<typeof useProtectedImage>> = {
    hero: useProtectedImage(data?.heroImage ? '/appearance/hero-image' : null, data?.heroImage?.version),
    logo: useProtectedImage(data?.logo ? '/appearance/logo' : null, data?.logo?.version),
    // Served by the public login endpoint, the same one the logged-out login page uses.
    login: useProtectedImage(data?.loginBranding.heroImage ? LOGIN_IMAGE_PATH : null, data?.loginBranding.heroImage?.version),
  }

  // Each form refreshes only its own fields, so saving one never discards what is typed in the other.
  const syncWelcome = (d: AdminAppearance) => setText((t) => ({ ...t, en: d.welcomeText.en ?? '', si: d.welcomeText.si ?? '', theme: d.defaultTheme }))
  const syncLogin = (d: AdminAppearance) => setLoginText((t) => ({ ...t, heading: d.loginBranding.heading ?? '', text: d.loginBranding.text ?? '' }))

  const load = useCallback(() => {
    setLoadError(null)
    api<AdminAppearance>('/admin/settings/appearance')
      .then((d) => {
        setData(d)
        syncWelcome(d)
        syncLogin(d)
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Failed to load the appearance settings'))
  }, [])
  useEffect(() => {
    load()
  }, [load])

  const setImage = (kind: ImageKind, patch: Partial<ImageForm>) => setImages((all) => ({ ...all, [kind]: { ...all[kind], ...patch } }))
  const clearPicker = (kind: ImageKind) => setPickers((all) => ({ ...all, [kind]: all[kind] + 1 }))

  const choose = (kind: ImageKind, files: ArrayLike<File> | null | undefined) => {
    setMessage(null)
    const file = files?.[0] ?? null
    if (!file || !data) return setImage(kind, { file: null, error: null })
    const problem = checkImageChoice(file, data.limits[kind], data.limits.imageTypes)
    if (problem) {
      clearPicker(kind)
      return setImage(kind, { file: null, error: problem })
    }
    setImage(kind, { file, error: null })
  }

  /** Shared by upload and reset: both are audited and need a reason. */
  const finishImage = (kind: ImageKind, updated: AdminAppearance, done: string) => {
    setData(updated)
    setImages((all) => ({ ...all, [kind]: emptyImage }))
    clearPicker(kind)
    setMessage(`${done} All admins have been notified.`)
    void refreshAppearance()
  }

  const uploadImage = async (kind: ImageKind) => {
    const form = images[kind]
    if (!form.file) return setImage(kind, { error: 'Choose an image first.' })
    if (form.reason.trim().length < 5) return setImage(kind, { error: 'Give a reason for the change (at least 5 characters).' })
    setBusy(kind)
    setImage(kind, { error: null })
    setMessage(null)
    try {
      const body = new FormData()
      body.append('image', form.file)
      body.append('reason', form.reason.trim())
      finishImage(kind, await api<AdminAppearance>(`/admin/settings/appearance/${IMAGES[kind].path}`, { method: 'PUT', body }), `${IMAGES[kind].label} updated.`)
    } catch (err) {
      // The previous image is untouched on the server, so the preview keeps showing it; the choice stays for a retry.
      setImage(kind, { error: problemOf(err, 'Upload failed') })
    } finally {
      setBusy(null)
    }
  }

  const resetImage = async (kind: ImageKind) => {
    const form = images[kind]
    if (form.reason.trim().length < 5) return setImage(kind, { error: 'Give a reason for the change (at least 5 characters).' })
    if (!confirm(`Reset the ${IMAGES[kind].label.toLowerCase()} to the ${IMAGES[kind].builtIn}? The uploaded file will be deleted.`)) return
    setBusy(kind)
    setImage(kind, { error: null })
    setMessage(null)
    try {
      const updated = await api<AdminAppearance>(`/admin/settings/appearance/${IMAGES[kind].path}/reset`, { method: 'POST', body: JSON.stringify({ reason: form.reason.trim() }) })
      finishImage(kind, updated, `${IMAGES[kind].label} reset to the built-in image.`)
    } catch (err) {
      setImage(kind, { error: problemOf(err, 'Reset failed') })
    } finally {
      setBusy(null)
    }
  }

  const saveText = async (e?: { preventDefault(): void }) => {
    e?.preventDefault()
    if (!data) return
    const welcomeText: Record<string, string | null> = {}
    for (const { code, label } of LANGUAGES) {
      const next = text[code].trim()
      if (next === (data.welcomeText[code] ?? '')) continue
      const problem = next ? validateWelcomeText(next) : null
      if (problem) return setText((t) => ({ ...t, error: `${label} welcome text: ${problem}` }))
      welcomeText[code] = next || null // empty = back to the built-in translation
    }
    const body: Record<string, unknown> = {}
    if (Object.keys(welcomeText).length > 0) body.welcomeText = welcomeText
    if (text.theme !== data.defaultTheme) body.defaultTheme = text.theme
    if (Object.keys(body).length === 0) return setText((t) => ({ ...t, error: 'Nothing to save yet. Change a welcome text or the default color mode first.' }))
    if (text.reason.trim().length < 5) return setText((t) => ({ ...t, error: 'Give a reason for the change (at least 5 characters).' }))

    setBusy('text')
    setText((t) => ({ ...t, error: null }))
    setMessage(null)
    try {
      const updated = await api<AdminAppearance>('/admin/settings/appearance', { method: 'PUT', body: JSON.stringify({ ...body, reason: text.reason.trim() }) })
      setData(updated)
      syncWelcome(updated)
      setText((t) => ({ ...t, reason: '' }))
      setMessage('Welcome text and color mode saved. All admins have been notified.')
      void refreshAppearance()
    } catch (err) {
      setText((t) => ({ ...t, error: problemOf(err, 'Save failed') }))
    } finally {
      setBusy(null)
    }
  }

  const saveLoginText = async (e?: { preventDefault(): void }) => {
    e?.preventDefault()
    if (!data) return
    const loginBranding: Record<string, string | null> = {}
    for (const { key, label, max } of [
      { key: 'heading', label: 'Heading', max: data.limits.loginHeadingMaxLength },
      { key: 'text', label: 'Supporting text', max: data.limits.loginTextMaxLength },
    ] as const) {
      const next = loginText[key].trim()
      if (next === (data.loginBranding[key] ?? '')) continue
      const problem = next ? validateLoginText(next, max) : null
      if (problem) return setLoginText((t) => ({ ...t, error: `Login page ${label.toLowerCase()}: ${problem}` }))
      loginBranding[key] = next || null // empty = back to the built-in text
    }
    if (Object.keys(loginBranding).length === 0) return setLoginText((t) => ({ ...t, error: 'Nothing to save yet. Change the heading or the supporting text first.' }))
    if (loginText.reason.trim().length < 5) return setLoginText((t) => ({ ...t, error: 'Give a reason for the change (at least 5 characters).' }))

    setBusy('loginText')
    setLoginText((t) => ({ ...t, error: null }))
    setMessage(null)
    try {
      const updated = await api<AdminAppearance>('/admin/settings/appearance', { method: 'PUT', body: JSON.stringify({ loginBranding, reason: loginText.reason.trim() }) })
      setData(updated)
      syncLogin(updated)
      setLoginText((t) => ({ ...t, reason: '' }))
      setMessage('Login page text saved. All admins have been notified.')
    } catch (err) {
      setLoginText((t) => ({ ...t, error: problemOf(err, 'Save failed') }))
    } finally {
      setBusy(null)
    }
  }

  if (loadError) {
    return (
      <section className="card">
        <h2>Appearance</h2>
        <div className="alert error">{loadError}</div>
        <button className="btn secondary small" onClick={load}>
          Retry
        </button>
      </section>
    )
  }
  if (!data) {
    return (
      <section className="card">
        <h2>Appearance</h2>
        <p className="muted">Loading appearance settings…</p>
      </section>
    )
  }

  const status = (d: AppearanceDetail, builtIn: string) =>
    d.custom ? `Custom · updated ${d.updatedAt ? new Date(d.updatedAt).toLocaleString() : ''}${d.updatedBy ? ` by ${d.updatedBy.name}` : ''}` : `Using the ${builtIn}`

  const selectSection = (id: AppearanceSectionId) => {
    setSection(id)
    if (typeof window === 'undefined') return
    // Keeps the section in the address (reload and links land on it) without adding a history entry for every click.
    window.history.replaceState(window.history.state, '', `#${id}`)
    // A shorter section would otherwise leave the page scrolled past the top of the card.
    const card = document.getElementById('appearance')
    if (card && card.getBoundingClientRect().top < 0) card.scrollIntoView({ block: 'start' })
  }
  const panelProps = (id: AppearanceSectionId) => ({
    id: `appearance-panel-${id}`,
    className: 'appearance-panel',
    role: 'region',
    'aria-labelledby': `appearance-tab-${id}`,
    hidden: section !== id,
  })

  const imageSection = (kind: ImageKind) => {
    const form = images[kind]
    const spec = IMAGES[kind]
    const limits = data.limits[kind]
    const custom = data.details[spec.detail]
    const current = currents[kind]
    const chosenPreview = previews[kind]
    const working = busy === kind
    const rules = `JPG, PNG or WEBP, up to ${formatBytes(limits.maxBytes)}, at least ${limits.minWidth} × ${limits.minHeight} px.`
    const shape = kind === 'logo' ? { width: 64, height: 64 } : { width: '100%', maxWidth: 420, aspectRatio: kind === 'hero' ? '16 / 6' : '4 / 3' }

    return (
      <div className="field" id={`appearance-${kind}`}>
        <h3 style={{ marginBottom: '0.25rem' }}>{spec.label}</h3>
        <p className="small muted" style={{ marginTop: 0 }}>
          {spec.about} {rules}
        </p>
        <div className="row" style={{ alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
          <div>
            {custom.custom && current.status === 'loading' ? (
              <div className="small muted">Loading preview…</div>
            ) : kind !== 'logo' ? (
              current.url ? (
                <img src={current.url} alt={`Current ${spec.label.toLowerCase()}`} style={{ ...shape, objectFit: 'cover', borderRadius: 10, border: '1px solid var(--border)', display: 'block' }} />
              ) : (
                <div role="img" aria-label={`Default ${spec.label.toLowerCase()} (no picture uploaded)`} style={{ ...shape, background: DEFAULT_BACKGROUND[kind], borderRadius: 10, border: '1px solid var(--border)' }} />
              )
            ) : current.url ? (
              <img src={current.url} alt="Current platform logo" style={{ ...shape, objectFit: 'contain', borderRadius: 10, border: '1px solid var(--border)', display: 'block' }} />
            ) : (
              <div aria-label="Built-in logo" style={{ ...shape, borderRadius: 10, background: 'var(--primary)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: '1.6rem' }}>
                H
              </div>
            )}
            <div className="small muted" style={{ marginTop: '0.35rem' }}>
              {status(custom, spec.builtIn)}
            </div>
            {custom.custom && current.status === 'failed' && (
              <div className="alert warning small" role="status">
                The uploaded image could not be loaded here. {spec.audience} see the {spec.builtIn} until it is replaced or reset.
              </div>
            )}
          </div>
          {chosenPreview && form.file && (
            <div>
              <img src={chosenPreview} alt={`Selected ${spec.label.toLowerCase()} (not saved yet)`} style={{ ...shape, objectFit: kind === 'logo' ? 'contain' : 'cover', borderRadius: 10, border: '1px dashed var(--primary)', display: 'block' }} />
              <div className="small muted" style={{ marginTop: '0.35rem' }}>
                New: {form.file.name} · {formatBytes(form.file.size)} · not saved yet
              </div>
            </div>
          )}
        </div>
        {canManage && (
          <>
            <div className="field" style={{ marginTop: '0.75rem' }}>
              <label htmlFor={`${kind}-file`}>Choose a new image</label>
              <input key={pickers[kind]} id={`${kind}-file`} type="file" accept={data.limits.imageTypes.join(',')} disabled={working} onChange={(e) => choose(kind, e.target.files)} />
            </div>
            <div className="field">
              <label htmlFor={`${kind}-reason`}>Reason for change (audited)</label>
              <input id={`${kind}-reason`} maxLength={300} value={form.reason} onChange={(e) => setImage(kind, { reason: e.target.value })} disabled={working} />
            </div>
            {form.error && <div className="alert error small">{form.error}</div>}
            <div className="row">
              <span className="spacer" />
              {custom.custom && (
                <button className="btn secondary" onClick={() => resetImage(kind)} disabled={working}>
                  {spec.reset}
                </button>
              )}
              <button className="btn" onClick={() => uploadImage(kind)} disabled={working || !form.file}>
                {working ? 'Saving…' : spec.upload}
              </button>
            </div>
          </>
        )}
      </div>
    )
  }

  return (
    <section className="card appearance-card" id="appearance">
      <div className="panel-head">
        <h2>Appearance</h2>
      </div>
      <p className="small muted">
        These settings apply to every partner. Nothing changes until you save: anything not customized keeps the built-in image, text or color mode.
        {!canManage && ' Read-only: only an Admin can change them.'}
      </p>
      {message && <div className="alert success">{message}</div>}

      <div className="appearance-shell">
        <div className="appearance-layout">
          <nav className="appearance-nav" aria-label="Appearance sections">
            {APPEARANCE_SECTIONS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                id={`appearance-tab-${id}`}
                className={`appearance-nav-item${id === section ? ' active' : ''}`}
                aria-current={id === section ? 'true' : undefined}
                aria-controls={`appearance-panel-${id}`}
                onClick={() => selectSection(id)}
              >
                {label}
              </button>
            ))}
          </nav>

          <div className="appearance-content">
            <div {...panelProps(GENERAL.id)}>
              <div className="appearance-grid">
                {imageSection('hero')}
                {imageSection('logo')}
              </div>

              <h3 style={{ marginBottom: '0.25rem' }}>Welcome text and default color mode</h3>
              <form onSubmit={saveText}>
                <div className="grid-2">
                  {LANGUAGES.map(({ code, label }) => {
                    const builtIn = builtInText(code, 'dash.hero.welcome')
                    const detail = data.details[code === 'en' ? 'welcomeTextEn' : 'welcomeTextSi']
                    return (
                      <div className="field" key={code}>
                        <label htmlFor={`welcome-${code}`}>{label} welcome text</label>
                        <input
                          id={`welcome-${code}`}
                          maxLength={data.limits.welcomeTextMaxLength}
                          value={text[code]}
                          placeholder={builtIn}
                          disabled={!canManage || busy === 'text'}
                          onChange={(e) => setText((t) => ({ ...t, [code]: e.target.value, error: null }))}
                        />
                        <div className="small muted">
                          {detail.custom ? status(detail, builtIn) : `Using the built-in text: ${builtIn}`}. Use {'{name}'} for the partner’s name; clear the field and save to go back to the built-in text.
                        </div>
                      </div>
                    )
                  })}
                </div>
                <div className="field">
                  <label htmlFor="appearance-theme">Default color mode</label>
                  <select id="appearance-theme" value={text.theme} disabled={!canManage || busy === 'text'} onChange={(e) => setText((t) => ({ ...t, theme: e.target.value as ThemeMode, error: null }))}>
                    {(Object.keys(THEME_LABELS) as ThemeMode[]).map((mode) => (
                      <option key={mode} value={mode}>
                        {THEME_LABELS[mode]}
                      </option>
                    ))}
                  </select>
                  <div className="small muted">
                    {status(data.details.defaultTheme, 'built-in mode (Dark)')}. Used only for people who have not chosen a color mode with the theme switch; anyone who has keeps their own choice.
                  </div>
                </div>
                {canManage && (
                  <>
                    <div className="field">
                      <label htmlFor="appearance-text-reason">Reason for change (audited)</label>
                      <input id="appearance-text-reason" maxLength={300} value={text.reason} onChange={(e) => setText((t) => ({ ...t, reason: e.target.value, error: null }))} disabled={busy === 'text'} />
                    </div>
                    {text.error && <div className="alert error small">{text.error}</div>}
                    <div className="row">
                      <span className="spacer" />
                      <button className="btn" type="submit" disabled={busy === 'text'}>
                        {busy === 'text' ? 'Saving…' : 'Save welcome text and color mode'}
                      </button>
                    </div>
                  </>
                )}
              </form>
            </div>

            <div {...panelProps(LOGIN_BRANDING.id)}>
              <p className="small muted">
                Branding on the sign-in and registration pages. Everyone who opens them sees it, signed in or not, so the picture and text here, and the colors under Login page theme, are public.
              </p>
              <div className="appearance-grid">
                {imageSection('login')}

                <div>
                  <h3 style={{ marginBottom: '0.25rem' }}>Login page heading and supporting text</h3>
                  <form onSubmit={saveLoginText}>
                    <div className="field">
                      <label htmlFor="login-heading">Heading</label>
                      <input
                        id="login-heading"
                        maxLength={data.limits.loginHeadingMaxLength}
                        value={loginText.heading}
                        placeholder={BUILT_IN_LOGIN_HEADING}
                        disabled={!canManage || busy === 'loginText'}
                        onChange={(e) => setLoginText((t) => ({ ...t, heading: e.target.value, error: null }))}
                      />
                      <div className="small muted">
                        {data.details.loginHeading.custom ? status(data.details.loginHeading, 'built-in heading') : `Using the built-in heading: ${BUILT_IN_LOGIN_HEADING}`}. Clear the field and save to go back to the built-in heading.
                      </div>
                    </div>
                    <div className="field">
                      <label htmlFor="login-text">Supporting text</label>
                      <input
                        id="login-text"
                        maxLength={data.limits.loginTextMaxLength}
                        value={loginText.text}
                        placeholder={BUILT_IN_LOGIN_TEXT}
                        disabled={!canManage || busy === 'loginText'}
                        onChange={(e) => setLoginText((t) => ({ ...t, text: e.target.value, error: null }))}
                      />
                      <div className="small muted">
                        {data.details.loginText.custom
                          ? status(data.details.loginText, 'built-in text')
                          : `Using the built-in text: ${BUILT_IN_LOGIN_TEXT} ${BUILT_IN_LOGIN_TAGLINE}`}
                        . A custom text replaces both built-in lines; clear the field and save to go back to them.
                      </div>
                    </div>
                    {canManage && (
                      <>
                        <div className="field">
                          <label htmlFor="login-text-reason">Reason for change (audited)</label>
                          <input id="login-text-reason" maxLength={300} value={loginText.reason} onChange={(e) => setLoginText((t) => ({ ...t, reason: e.target.value, error: null }))} disabled={busy === 'loginText'} />
                        </div>
                        {loginText.error && <div className="alert error small">{loginText.error}</div>}
                        <div className="row">
                          <span className="spacer" />
                          <button className="btn" type="submit" disabled={busy === 'loginText'}>
                            {busy === 'loginText' ? 'Saving…' : 'Save login page text'}
                          </button>
                        </div>
                      </>
                    )}
                  </form>
                </div>
              </div>
            </div>

            <div {...panelProps(LOGIN_COLORS.id)}>
              <LoginThemeSettings
                data={data}
                canManage={canManage}
                imageUrl={currents.login.url}
                onSaved={(updated, done) => {
                  setData(updated)
                  setMessage(done)
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
