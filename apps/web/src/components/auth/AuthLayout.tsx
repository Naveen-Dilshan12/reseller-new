'use client'

import React, { useEffect, useState } from 'react'
import { useProtectedImage } from '@/lib/appearance'
import { HERO_PANEL_HIDDEN_QUERY, LOGIN_BACKGROUND_LABEL, LOGIN_FALLBACK_GRADIENT, LOGIN_IMAGE_PATH, cssUrl, loginHeading, loginSupportingLines } from '@/lib/appearance-utils'
import { useLoginBranding } from '@/lib/login-branding'
import { heroFallbackGradient, loginThemeColors, loginThemeVars } from '@/lib/login-theme'
import '@/app/login/login.css'

/**
 * Whether the landscape panel has been visible at least once. The stylesheet hides the panel at HERO_PANEL_HIDDEN_QUERY,
 * and nothing may be downloaded for a panel nobody sees. It starts false — on the server and in the first client render
 * alike, so the markup cannot differ between them — and turns true after mount on a wide viewport, or later if the window
 * grows past the breakpoint. It never turns back, so a picture that has already loaded is kept if the window shrinks again.
 */
function useHeroPanelShown(): boolean {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (shown) return
    if (typeof window.matchMedia !== 'function') {
      setShown(true) // cannot tell, so behave as before: load the picture
      return
    }
    const hidden = window.matchMedia(HERO_PANEL_HIDDEN_QUERY)
    const update = () => {
      if (!hidden.matches) setShown(true)
    }
    update()
    hidden.addEventListener('change', update)
    return () => hidden.removeEventListener('change', update)
  }, [shown])
  return shown
}

/**
 * The single shell for every authentication page (login, register, forgot/reset password,
 * email verification): branded landscape panel on the left, and the page's own form (`children`)
 * on the right. The landscape, heading and supporting text are the Admin's login branding
 * (Admin → Settings → Appearance) and fall back to the built-in ones. So do the colors: the Admin's login theme is applied
 * here, as CSS variables on this layout's own root element only — never on the document and never through the portal's
 * light/dark preference. Pages keep all of their own form state, validation and API calls — this component only provides
 * the shared presentation.
 */
export function AuthLayout({ ariaLabel, children }: { ariaLabel: string; children: React.ReactNode }) {
  const { branding, status } = useLoginBranding()
  const panelShown = useHeroPanelShown()
  const customVersion = branding?.heroImage?.version
  const custom = useProtectedImage(panelShown && customVersion ? LOGIN_IMAGE_PATH : null, customVersion)

  // Nothing is downloaded while the panel is hidden, and nothing is painted until we know whether a custom picture
  // exists, so the default gradient never flashes before it. No picture ships with the app: without a custom one the
  // panel is the gradient below and nothing at all is downloaded for it.
  const known = panelShown && status !== 'loading' && custom.status !== 'loading'
  const src = known ? custom.url : null

  const [settled, setSettled] = useState<{ src: string; ok: boolean } | null>(null)
  useEffect(() => {
    if (!src) return
    let active = true
    const img = new Image()
    img.onload = () => active && setSettled({ src, ok: true })
    img.onerror = () => active && setSettled({ src, ok: false })
    img.src = src
    return () => {
      active = false
    }
  }, [src])
  const pictureSettled = src !== null && settled?.src === src
  // The gradient is ready at once; only a custom picture has to be waited for (and fades in over the gradient).
  const loaded = pictureSettled || (known && src === null)
  // null = no theme saved (or an unusable answer): the stylesheet's built-in colors apply untouched.
  const themeColors = loginThemeColors(branding?.theme)
  const themeVars = loginThemeVars(themeColors)
  const fallback = themeColors ? heroFallbackGradient(themeColors.heroOverlay) : LOGIN_FALLBACK_GRADIENT
  const background = (pictureSettled && settled?.ok && src ? cssUrl(src) : null) ?? fallback

  const supporting = loginSupportingLines(branding)

  return (
    <main className="login-split" style={themeVars}>
      {/* ─── LEFT: landscape + Hexalyte branding ────────────────────────────── */}
      <section className="login-left" aria-label="Hexalyte Innovation Overview">
        <div
          className={`login-left-bg ${loaded ? 'loaded' : 'loading'}`}
          style={{ backgroundImage: background, backgroundColor: 'var(--theme-hero-bg, #0f172a)' }}
          role="img"
          aria-label={LOGIN_BACKGROUND_LABEL}
        />

        <div className="login-left-content">
          <div className="login-left-logo">
            <div className="login-left-logo-icon">
              <img src="/hexalytelogo.jpeg" alt="Hexalyte Innovation Logo" width={40} height={40} className="login-left-logo-img" />
            </div>
            <div>
              <div className="login-left-logo-text">Hexalyte Innovation</div>
              <div className="login-left-logo-sub">Central Partner Platform</div>
            </div>
          </div>

          <div className={`login-left-hero${status === 'loading' ? ' pending' : ''}`}>
            <h2>{loginHeading(branding)}</h2>
            <p>{supporting.text}</p>
            {supporting.tagline && <p className="tagline">{supporting.tagline}</p>}
          </div>
        </div>
      </section>

      {/* ─── RIGHT: the page's form ─────────────────────────────────────────── */}
      <section className="login-right" aria-label={ariaLabel}>
        <div className="login-form-wrapper">
          <div className="login-mobile-brand">
            <div className="login-mobile-brand-icon">
              <img src="/hexalytelogo.jpeg" alt="Hexalyte Innovation Logo" width={38} height={38} className="login-mobile-brand-img" />
            </div>
            <div>
              <div className="login-mobile-brand-text">Hexalyte Innovation</div>
              <div className="login-mobile-brand-sub">Central Partner Platform</div>
            </div>
          </div>
          {children}
        </div>
      </section>
    </main>
  )
}
