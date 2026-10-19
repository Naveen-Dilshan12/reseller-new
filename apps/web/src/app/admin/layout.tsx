'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { isPlatformUser, logout, useCurrentUser } from '@/lib/auth'
import { AdminUserContext } from '@/lib/admin-context'
import { ThemeToggle } from '@/components/ThemeToggle'
import { PlatformLogo } from '@/components/PlatformLogo'
import { NotificationBell } from '@/components/notifications/NotificationBell'
import { useAppearance } from '@/lib/appearance'
import { roleLabel } from '@/lib/role-label'

interface NavGroup {
  title: string
  items: NavItem[]
}

interface NavItem {
  href: string
  label: string
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
  resellers: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
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
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
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
  bankSlips: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="20" height="14" x="2" y="5" rx="2" />
      <line x1="2" x2="22" y1="10" y2="10" />
    </svg>
  ),
  commissions: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" x2="12" y1="2" y2="22" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  ),
  notifications: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  ),
  auditLogs: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </svg>
  ),
  settings: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2v-.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
}

const GROUPS: NavGroup[] = [
  {
    title: 'Overview',
    items: [{ href: '/admin', label: 'Dashboard', icon: ICONS.dashboard }],
  },
  {
    title: 'Partner Network',
    items: [
      { href: '/admin/resellers', label: 'Partners', permission: 'resellers:read', match: ['/admin/reseller-applications'], icon: ICONS.resellers },
      { href: '/admin/products', label: 'SaaS Products', permission: 'products:manage', icon: ICONS.products },
      { href: '/admin/customer-accounts', label: 'Customers & Mapping', permission: 'accounts:read', icon: ICONS.customers },
    ],
  },
  {
    title: 'Operations & Billing',
    items: [
      { href: '/admin/activations', label: 'Activation Requests', permission: 'activations:read', icon: ICONS.activations },
      { href: '/admin/demo-requests', label: 'Demo Requests', permission: 'demos:read', icon: ICONS.demos },
      { href: '/admin/bank-slips', label: 'Bank Slips Register', permission: 'bankslips:read', icon: ICONS.bankSlips },
      { href: '/admin/commissions', label: 'Commissions & Payouts', permission: 'commissions:read', icon: ICONS.commissions },
    ],
  },
  {
    title: 'Platform System',
    items: [
      { href: '/admin/notifications', label: 'Notifications', icon: ICONS.notifications },
      { href: '/admin/audit-logs', label: 'Audit Logs', permission: 'audit:read', icon: ICONS.auditLogs },
      { href: '/admin/settings', label: 'Platform Settings', permission: 'settings:read', icon: ICONS.settings },
    ],
  },
]

/**
 * Up to this width the sidebar is a drawer opened from the header's menu button; above it, the fixed sidebar. Keep it equal to the
 * `max-width` of the "Admin shell" rules in globals.css (a test compares the two).
 */
const DRAWER_QUERY = '(max-width: 1024px)'

function isActive(pathname: string, item: NavItem) {
  if (item.href === '/admin') return pathname === '/admin'
  return [item.href, ...(item.match ?? [])].some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = useCurrentUser(isPlatformUser)
  const pathname = usePathname()
  const router = useRouter()
  // Loads the shared appearance (default color mode for admins who have not chosen one) once signed in.
  useAppearance()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuButton = useRef<HTMLButtonElement>(null)
  const sidebar = useRef<HTMLElement>(null)

  // Going to another page closes the drawer (links also close it themselves, for a link to the page already open).
  useEffect(() => {
    setMenuOpen(false)
  }, [pathname])

  // While the drawer is open: focus moves into it; Escape closes it and returns focus to the menu button; Tab stays between the menu
  // button and the drawer's links; the page behind does not scroll; and growing to a desktop width closes it (the sidebar is then
  // permanent, so nothing may stay locked).
  useEffect(() => {
    if (!menuOpen) return
    const links = () => Array.from(sidebar.current?.querySelectorAll<HTMLElement>('a[href]') ?? [])
    links()[0]?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false)
        menuButton.current?.focus()
        return
      }
      if (event.key !== 'Tab') return
      const ring = [menuButton.current, ...links()].filter((el): el is HTMLElement => Boolean(el))
      const at = ring.indexOf(document.activeElement as HTMLElement)
      const next = at === -1 ? 0 : (at + (event.shiftKey ? -1 : 1) + ring.length) % ring.length
      event.preventDefault()
      ring[next]?.focus()
    }
    const media = typeof window.matchMedia === 'function' ? window.matchMedia(DRAWER_QUERY) : null
    const onChange = () => {
      if (media && !media.matches) setMenuOpen(false)
    }
    document.addEventListener('keydown', onKey)
    media?.addEventListener('change', onChange)
    const scrollBefore = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      media?.removeEventListener('change', onChange)
      document.body.style.overflow = scrollBefore
    }
  }, [menuOpen])
  if (!user) return null

  const initials = user.name
    ? user.name
        .split(' ')
        .map((p) => p[0])
        .slice(0, 2)
        .join('')
        .toUpperCase()
    : 'AD'

  return (
    <AdminUserContext.Provider value={user}>
      {/* Top Header */}
      <header
        className="admin-header"
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 40,
          background: 'var(--header-bg)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          borderBottom: '1px solid var(--border)',
          height: '64px',
          display: 'flex',
          alignItems: 'center',
          // horizontal padding comes from .admin-header (it shrinks on small screens)
        }}
      >
        {/* Opens the sidebar drawer; only shown on tablets and phones (see "Admin shell" in globals.css). */}
        <button
          ref={menuButton}
          type="button"
          className="admin-menu-btn"
          aria-label="Admin navigation menu"
          aria-expanded={menuOpen}
          aria-controls="admin-sidebar"
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          )}
        </button>

        <div className="admin-header-brand">
          <PlatformLogo
            size={34}
            radius={9}
            fallback={
              <div
                style={{
                  width: '34px',
                  height: '34px',
                  borderRadius: '9px',
                  background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)',
                  color: '#fff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 800,
                  fontSize: '1rem',
                  boxShadow: '0 0 18px rgba(99, 102, 241, 0.35)',
                }}
              >
                H
              </div>
            }
          />
          <div className="admin-header-brand-text">
            <div style={{ fontWeight: 800, fontSize: '0.98rem', color: 'var(--text-heading)', letterSpacing: '-0.02em' }}>
              Hexalyte Admin
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 500 }}>
              Central Platform
            </div>
          </div>
        </div>

        <div style={{ flex: 1, display: 'flex', alignItems: 'center', minWidth: 0 }}>
          <div
            className="admin-header-status"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.45rem',
              background: 'var(--badge-bg-subtle)',
              border: '1px solid var(--border)',
              padding: '0.35rem 0.75rem',
              borderRadius: '20px',
              fontSize: '0.75rem',
              color: 'var(--muted)',
              fontWeight: 600,
            }}
          >
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#10b981', boxShadow: '0 0 8px #10b981' }} />
            System Live · Asia/Colombo
          </div>
        </div>

        <div className="admin-header-controls">
          <ThemeToggle className="admin-header-theme" />

          {/* Real unread count from GET /notifications/unread-count; the badge is hidden at 0 or if it cannot be loaded. */}
          <NotificationBell href="/admin/notifications" />

          <div
            className="admin-header-user"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.65rem',
              padding: '0.35rem 0.65rem',
              borderRadius: '9px',
              background: 'var(--badge-bg-subtle)',
              border: '1px solid var(--border)',
            }}
          >
            <div
              style={{
                width: '30px',
                height: '30px',
                borderRadius: '8px',
                background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)',
                color: '#fff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 800,
                fontSize: '0.76rem',
              }}
            >
              {initials}
            </div>
            <div className="admin-header-user-text">
              <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-heading)' }}>{user.name}</div>
              <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', fontWeight: 700, textTransform: 'uppercase' }}>{roleLabel(user.role)}</div>
            </div>
          </div>

          <button
            className="btn secondary small"
            onClick={async () => {
              await logout()
              router.replace('/login')
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Dims the page behind the open drawer (tablets and phones only); a tap on it closes the drawer. Under the header, so the menu button stays reachable. */}
      {menuOpen && (
        <div
          className="admin-drawer-backdrop"
          onClick={() => {
            setMenuOpen(false)
            menuButton.current?.focus()
          }}
          aria-hidden="true"
        />
      )}

      {/* Main Container with Sidebar */}
      <div style={{ display: 'flex', minHeight: 'calc(100vh - 64px)' }}>
        {/* Dark Modern Cyber Sidebar: fixed on desktop, a slide-in drawer on tablets and phones */}
        <nav
          id="admin-sidebar"
          ref={sidebar}
          aria-label="Admin navigation"
          className={`admin-sidebar${menuOpen ? ' open' : ''}`}
          style={{
            // position / size / stacking / transitions come from .admin-sidebar (fixed under the header)
            background: 'var(--sidebar-bg)',
            borderRight: '1px solid var(--border)',
            padding: '1.5rem 0.85rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '1.6rem',
          }}
        >
          {GROUPS.map((group) => {
            const accessible = group.items.filter((item) => !item.permission || user.permissions.includes(item.permission))
            if (accessible.length === 0) return null

            return (
              <div key={group.title}>
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
                  {group.title}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                  {accessible.map((item) => {
                    const active = isActive(pathname, item)
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={() => setMenuOpen(false)}
                        aria-current={active ? 'page' : undefined}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.75rem',
                          padding: '0.58rem 0.75rem',
                          borderRadius: '9px',
                          fontSize: '0.88rem',
                          fontWeight: active ? 700 : 500,
                          color: active ? 'var(--primary)' : 'var(--text-secondary)',
                          background: active ? 'linear-gradient(135deg, rgba(79, 70, 229, 0.16) 0%, rgba(139, 92, 246, 0.10) 100%)' : 'transparent',
                          border: active ? '1px solid rgba(99, 102, 241, 0.35)' : '1px solid transparent',
                          boxShadow: active ? '0 0 12px rgba(99, 102, 241, 0.12)' : 'none',
                          // not `all`: that would also animate the inherited visibility of a closing/opening drawer, and a link still
                          // "hidden" for that first frame cannot take focus
                          transition: 'background 0.15s ease, color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease',
                        }}
                      >
                        <span style={{ color: active ? 'var(--primary)' : 'var(--muted)', display: 'flex' }}>
                          {item.icon}
                        </span>
                        {item.label}
                      </Link>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </nav>

        {/* Content Area. Padding comes from .admin-content (it shrinks on small screens); `inert` keeps keyboard focus out of the page behind an open drawer. */}
        <div className="admin-content" inert={menuOpen || undefined} style={{ flex: 1, minWidth: 0, background: 'var(--bg)', transition: 'background 0.2s ease' }}>
          {children}
        </div>
      </div>
    </AdminUserContext.Provider>
  )
}
