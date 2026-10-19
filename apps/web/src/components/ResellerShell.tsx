'use client'

import { useState, useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import { isPlatformUser, logout, useCurrentUser, type CurrentUser } from '@/lib/auth'
import { ThemeToggle } from '@/components/ThemeToggle'
import { PlatformLogo } from '@/components/PlatformLogo'
import { LanguageToggle } from '@/components/LanguageToggle'
import { NotificationBell } from '@/components/notifications/NotificationBell'
import { api } from '@/lib/api'
import { useAppearance, useProtectedImage } from '@/lib/appearance'
import { heroBackgroundVars } from '@/lib/appearance-utils'
import type { CommissionSummary } from '@/lib/commission-types'
import { useLanguage } from '@/lib/i18n'
import { LevelBadge } from '@/components/commissions/LevelBadge'
import { LevelUpCelebration } from '@/components/commissions/LevelUpCelebration'
import { PartnerSummaryProvider } from '@/components/commissions/PartnerSummaryContext'
import { ApplicationPopups, ApplicationStatusCard } from '@/components/onboarding/ApplicationNotices'

interface NavGroupDef {
  titleKey: string
  items: NavItemDef[]
}

interface NavItemDef {
  href: string
  labelKey: string
  permission?: string
  match?: string[]
  icon: React.ReactNode
}

const ICONS = {
  dashboard: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </svg>
  ),
  products: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m7.5 4.27 9 5.15" />
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
    </svg>
  ),
  customers: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  activations: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  ),
  demos: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18" />
      <path d="m9 15 2 2 4-4" />
    </svg>
  ),
  bank: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3 9 9-6 9 6" />
      <path d="M5 9v10M9.5 9v10M14.5 9v10M19 9v10" />
      <path d="M3 21h18" />
    </svg>
  ),
  commissions: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" x2="12" y1="2" y2="22" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  ),
  profile: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="5" />
      <path d="M20 21a8 8 0 1 0-16 0" />
    </svg>
  ),
}

const GROUPS: NavGroupDef[] = [
  {
    titleKey: 'nav.overview',
    items: [
      { href: '/dashboard', labelKey: 'nav.dashboard', icon: ICONS.dashboard },
      { href: '/products', labelKey: 'nav.products', permission: 'products:read', icon: ICONS.products },
    ],
  },
  {
    titleKey: 'nav.customerOperations',
    items: [
      { href: '/customers', labelKey: 'nav.customers', permission: 'accounts:read', icon: ICONS.customers },
      { href: '/activations', labelKey: 'nav.activations', permission: 'activations:read', match: ['/activations/new'], icon: ICONS.activations },
      // Same permission as the payment-info endpoint it reads.
      { href: '/bank-details', labelKey: 'nav.bankDetails', permission: 'activations:read', icon: ICONS.bank },
      { href: '/demo-requests', labelKey: 'nav.demos', permission: 'demos:read', match: ['/demo-requests/new'], icon: ICONS.demos },
    ],
  },
  {
    titleKey: 'nav.earningsGrowth',
    items: [
      { href: '/commissions', labelKey: 'nav.commissions', permission: 'commissions:read', icon: ICONS.commissions },
    ],
  },
  {
    titleKey: 'nav.settings',
    items: [
      { href: '/profile', labelKey: 'nav.profile', icon: ICONS.profile },
    ],
  },
]

/**
 * The seller's actual partner level and commission rate (never a placeholder). Hidden until the
 * data loads, for resellers that aren't ACTIVE yet, for users without commission access, and if
 * the request fails.
 */
/** The signed-in seller's own commission summary (null until loaded, for ineligible users, or on failure). */
function usePartnerSummary(user: CurrentUser | null) {
  const [summary, setSummary] = useState<CommissionSummary | null>(null)
  const eligible = Boolean(user && user.permissions.includes('commissions:read') && user.reseller?.status === 'ACTIVE')

  useEffect(() => {
    if (!eligible) return
    let active = true
    api<CommissionSummary>('/commissions/summary')
      .then((s) => active && setSummary(s))
      .catch(() => active && setSummary(null))
    return () => {
      active = false
    }
  }, [eligible])

  return eligible ? summary : null
}

function PartnerTierCard({ summary }: { summary: CommissionSummary | null }) {
  const { t } = useLanguage()
  const level = summary?.level

  if (!level) return null

  const hasLevel = level.level !== null
  const name = level.name ?? (hasLevel ? `Level ${level.level}` : t('header.partnerTierNone'))
  const rate = Number(hasLevel ? level.ratePercent : level.effectiveRatePercent)

  return (
    <div style={{ position: 'relative' }}>
      <div
        style={{
          padding: '0.85rem 1rem',
          borderRadius: '12px',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          boxShadow: 'var(--shadow-sm)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
          <span style={{ fontSize: '0.68rem', fontWeight: 800, textTransform: 'uppercase', color: 'var(--primary-light)', letterSpacing: '0.06em' }}>
            {t('header.partnerTier')}
          </span>
          <span className="badge ACTIVE" style={{ fontSize: '0.62rem', padding: '0.12rem 0.45rem', borderRadius: '9999px' }}>
            {t('header.partnerTierStatus')}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
          <LevelBadge level={level.level} name={level.name} size="md" />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: '0.96rem', color: 'var(--text-heading)', marginBottom: '0.12rem' }}>{name}</div>
            <div style={{ fontSize: '0.74rem', color: 'var(--muted)' }}>
              {hasLevel ? t('header.partnerTierRate', { rate }) : t('header.partnerTierFirst', { rate })}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function isActive(pathname: string, item: NavItemDef) {
  if (item.href === '/dashboard') return pathname === '/dashboard'
  return [item.href, ...(item.match ?? [])].some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

export function ResellerShell({ children }: { children: (user: CurrentUser) => React.ReactNode }) {
  const user = useCurrentUser((u) => !isPlatformUser(u))
  const pathname = usePathname()
  const router = useRouter()
  const { t } = useLanguage()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const partnerSummary = usePartnerSummary(user)
  // Loads the admin-managed appearance and applies its default color mode (unless this user chose their own).
  const appearance = useAppearance()
  // The Admin's hero image is set once here, as --dash-hero-image, so every hero below (the dashboard's and the shared
  // PageHero on all other reseller pages) inherits the same value and changes or resets together. Unset or failed: the
  // stylesheet's built-in picture.
  const customHero = appearance?.heroImage ?? null
  const heroImage = useProtectedImage(customHero ? '/appearance/hero-image' : null, customHero?.version)
  const heroVars = heroBackgroundVars(heroImage, customHero !== null)

  // Until the reseller application is approved only the dashboard (application status), the application
  // form, the profile and notifications are available. The backend enforces the same rule on its APIs.
  const approved = user?.reseller?.status === 'ACTIVE'
  const allowedWhileUnapproved = ['/dashboard', '/profile', '/notifications'].some((p) => pathname.startsWith(p))
  const blocked = Boolean(user) && !approved && !allowedWhileUnapproved
  useEffect(() => {
    if (blocked) router.replace('/dashboard')
  }, [blocked, router])

  // Automatically close mobile menu when navigating to another route
  useEffect(() => {
    setMobileMenuOpen(false)
  }, [pathname])

  // Safe loading skeleton to prevent blank screen flicker on initial load before session verification
  if (!user) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)', transition: 'background-color 0.2s ease, color 0.2s ease' }}>
        <header
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 40,
            background: 'var(--header-bg)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            borderBottom: '1px solid var(--border)',
            height: '56px',
            display: 'flex',
            alignItems: 'center',
            padding: '0 1.25rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', width: '220px' }}>
            <PlatformLogo
              size={32}
              fallback={
                <div
                  style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: '8px',
                    background: 'var(--primary)',
                    color: '#fff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontWeight: 800,
                    fontSize: '0.92rem',
                  }}
                >
                  H
                </div>
              }
            />
            <div>
              <div style={{ fontWeight: 800, fontSize: '0.94rem', color: 'var(--text-heading)', letterSpacing: '-0.02em', lineHeight: 1.2 }}>
                {t('brand.title')}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--muted)', fontWeight: 500, lineHeight: 1.2 }}>
                {t('brand.subtitle')}
              </div>
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <LanguageToggle />
            <ThemeToggle />
            <div
              style={{
                width: '100px',
                height: '30px',
                borderRadius: '8px',
                background: 'var(--badge-bg-subtle)',
                border: '1px solid var(--border)',
                opacity: 0.6,
              }}
            />
          </div>
        </header>

        <div style={{ display: 'flex', minHeight: 'calc(100vh - 56px)' }}>
          <aside
            className="reseller-sidebar"
            style={{
              background: 'var(--sidebar-bg)',
              borderRight: '1px solid var(--border)',
              padding: '1.5rem 0.85rem',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              gap: '1.6rem',
              zIndex: 30,
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              {GROUPS.map((group) => (
                <div key={group.titleKey}>
                  <div
                    style={{
                      fontSize: '0.68rem',
                      fontWeight: 800,
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                      color: 'var(--muted)',
                      padding: '0 0.75rem 0.5rem',
                    }}
                  >
                    {t(group.titleKey)}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                    {group.items.map((item) => {
                      const active = isActive(pathname, item)
                      return (
                        <div
                          key={item.href}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.75rem',
                            padding: '0.58rem 0.75rem',
                            borderRadius: '9px',
                            fontSize: '0.88rem',
                            fontWeight: active ? 700 : 500,
                            color: active ? 'var(--primary)' : 'var(--text-secondary)',
                            background: active ? 'rgba(37, 99, 235, 0.08)' : 'transparent',
                            border: active ? '1px solid rgba(37, 99, 235, 0.22)' : '1px solid transparent',
                          }}
                        >
                          <span style={{ color: active ? 'var(--primary)' : 'var(--muted)', display: 'flex' }}>
                            {item.icon}
                          </span>
                          {t(item.labelKey)}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </aside>

          <main className="reseller-content" style={{ flex: 1, minWidth: 0, padding: '1.75rem 2.25rem', background: 'var(--bg)' }}>
            <div style={{ maxWidth: 1240, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <div style={{ width: '220px', height: '32px', borderRadius: '8px', background: 'var(--surface)', border: '1px solid var(--border)' }} />
              <div style={{ width: '360px', height: '16px', borderRadius: '4px', background: 'var(--surface)', border: '1px solid var(--border)' }} />
              <div style={{ height: '220px', borderRadius: 'var(--radius)', background: 'var(--surface)', border: '1px solid var(--border)', marginTop: '1rem' }} />
            </div>
          </main>
        </div>
      </div>
    )
  }

  const initials = user.name
    ? user.name
        .split(' ')
        .map((p) => p[0])
        .slice(0, 2)
        .join('')
        .toUpperCase()
    : 'RS'

  const businessName = user.reseller?.businessName || 'Hexalyte Partner'

  return (
    <div style={{ ...heroVars, minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)', transition: 'background-color 0.2s ease, color 0.2s ease' } as React.CSSProperties}>
      {/* Top Header */}
      <header
        className="reseller-header"
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 40,
          background: 'var(--header-bg)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          borderBottom: '1px solid var(--border)',
          height: '56px',
          display: 'flex',
          alignItems: 'center',
          padding: '0 1.25rem',
        }}
      >
        {/* Mobile menu toggle button (hidden on desktop via CSS) */}
        <button
          className="reseller-mobile-menu-btn"
          onClick={() => setMobileMenuOpen((prev) => !prev)}
          aria-label={mobileMenuOpen ? 'Close navigation' : 'Open navigation'}
          style={{
            display: 'none',
            alignItems: 'center',
            justifyContent: 'center',
            width: '32px',
            height: '32px',
            borderRadius: '8px',
            background: 'var(--badge-bg-subtle)',
            border: '1px solid var(--border)',
            color: 'var(--text)',
            cursor: 'pointer',
            marginRight: '0.55rem',
            padding: 0,
            flexShrink: 0,
          }}
        >
          {mobileMenuOpen ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          )}
        </button>

        {/* Brand Area */}
        <div className="reseller-header-brand" style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', width: '220px' }}>
          <PlatformLogo
            size={32}
            className="reseller-header-logo"
            fallback={
              <div
                className="reseller-header-logo"
                style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '8px',
                  background: 'var(--primary)',
                  color: '#fff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 800,
                  fontSize: '0.92rem',
                }}
              >
                H
              </div>
            }
          />
          <div className="reseller-header-brand-text">
            <div style={{ fontWeight: 800, fontSize: '0.94rem', color: 'var(--text-heading)', letterSpacing: '-0.02em', lineHeight: 1.2 }}>
              {t('brand.title')}
            </div>
            <div style={{ fontSize: '0.7rem', color: 'var(--muted)', fontWeight: 500, lineHeight: 1.2 }}>
              {t('brand.subtitle')}
            </div>
          </div>
        </div>

        <div style={{ flex: 1 }} />

        {/* Controls: Language, Theme, Quick Actions, User Profile & Sign Out */}
        <div className="reseller-header-controls" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {/* Language Switcher (සිංහල / EN) */}
          <LanguageToggle />

          {/* Theme Toggle (Light / Dark / System) */}
          <ThemeToggle className="reseller-header-theme" />

          {/* Notifications: unread count from GET /notifications/unread-count */}
          <NotificationBell href="/notifications" label={t('nav.notifications')} />

          <div
            className="reseller-header-user-badge"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.55rem',
              padding: '0.22rem 0.55rem',
              borderRadius: '8px',
              background: 'var(--badge-bg-subtle)',
              border: '1px solid var(--border)',
            }}
          >
            <div
              style={{
                width: '28px',
                height: '28px',
                borderRadius: '7px',
                background: 'var(--primary)',
                color: '#fff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 800,
                fontSize: '0.74rem',
              }}
            >
              {initials}
            </div>
            <div>
              <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-heading)', lineHeight: 1.2 }}>{user.name}</div>
              <div style={{ fontSize: '0.66rem', color: 'var(--primary-light)', fontWeight: 700, lineHeight: 1.2 }}>
                {user.role.replace('_', ' ')}
              </div>
            </div>
          </div>

          <button
            className="btn secondary small"
            style={{ padding: '0.32rem 0.65rem', fontSize: '0.8rem', borderRadius: '8px' }}
            onClick={async () => {
              await logout()
              router.replace('/login')
            }}
          >
            {t('header.signOut')}
          </button>
        </div>
      </header>

      {/* Mobile Backdrop Overlay */}
      {mobileMenuOpen && (
        <div
          className="reseller-mobile-backdrop"
          onClick={() => setMobileMenuOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Main Grid: Sidebar + Dynamic Content */}
      <div className="reseller-layout-body" style={{ display: 'flex', minHeight: 'calc(100vh - 56px)' }}>
        {/* Stationary Sticky Sidebar */}
        <aside
          className={`reseller-sidebar ${mobileMenuOpen ? 'mobile-open' : ''}`}
          style={{
            // position / size come from .reseller-sidebar (fixed under the header)
            background: 'var(--sidebar-bg)',
            borderRight: '1px solid var(--border)',
            padding: '1.5rem 0.85rem',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            gap: '1.6rem',
            transition: 'background 0.2s ease, border-color 0.2s ease, transform 0.25s ease',
            zIndex: 30,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {GROUPS.map((group) => {
              const accessible = group.items.filter((item) => !item.permission || user.permissions.includes(item.permission))
              if (accessible.length === 0) return null

              return (
                <div key={group.titleKey}>
                  <div
                    style={{
                      fontSize: '0.68rem',
                      fontWeight: 800,
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                      color: 'var(--muted)',
                      padding: '0 0.75rem 0.5rem',
                    }}
                  >
                    {t(group.titleKey)}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                    {accessible.map((item) => {
                      const active = isActive(pathname, item)
                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          onClick={() => setMobileMenuOpen(false)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.75rem',
                            padding: '0.58rem 0.75rem',
                            borderRadius: '9px',
                            fontSize: '0.88rem',
                            fontWeight: active ? 700 : 500,
                            color: active ? 'var(--primary)' : 'var(--text-secondary)',
                            background: active ? 'rgba(37, 99, 235, 0.08)' : 'transparent',
                            border: active ? '1px solid rgba(37, 99, 235, 0.22)' : '1px solid transparent',
                            boxShadow: 'none',
                            transition: 'all 0.15s ease',
                          }}
                        >
                          <span style={{ color: active ? 'var(--primary)' : 'var(--muted)', display: 'flex' }}>
                            {item.icon}
                          </span>
                          {t(item.labelKey)}
                        </Link>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Partner Tier Card: real level + rate from GET /commissions/summary */}
          <PartnerTierCard summary={partnerSummary} />
          <ApplicationStatusCard user={user} />
        </aside>

        {/* Partner Main Content View */}
        <main
          className="reseller-content"
          style={{
            flex: 1,
            minWidth: 0,
            padding: '1.75rem 2.25rem',
            background: 'var(--bg)',
            transition: 'background 0.2s ease',
          }}
        >
          <PartnerSummaryProvider value={partnerSummary}>{blocked ? null : children(user)}</PartnerSummaryProvider>
        </main>
      </div>

      {/* Shown once when the backend has recorded a new level for this seller (outside the sidebar so it can cover the page) */}
      <LevelUpCelebration summary={partnerSummary} resellerId={user.resellerId} />

      {/* One-time welcome (first login, application not submitted) and "approved" popups */}
      <ApplicationPopups user={user} />
    </div>
  )
}
