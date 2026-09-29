'use client'

import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import { isPlatformUser, logout, useCurrentUser, type CurrentUser } from '@/lib/auth'

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
  trials: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  ),
  activations: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
      <path d="m9 12 2 2 4-4" />
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

const GROUPS: NavGroup[] = [
  {
    title: 'Overview',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: ICONS.dashboard },
      { href: '/products', label: 'SaaS Products', permission: 'products:read', icon: ICONS.products },
    ],
  },
  {
    title: 'Customer Operations',
    items: [
      { href: '/customers', label: 'My Customers', permission: 'accounts:read', icon: ICONS.customers },
      { href: '/trials', label: 'Free Trials', permission: 'trials:read', match: ['/trials/new'], icon: ICONS.trials },
      { href: '/activations', label: 'Paid Activations', permission: 'activations:read', match: ['/activations/new'], icon: ICONS.activations },
    ],
  },
  {
    title: 'Earnings & Growth',
    items: [
      { href: '/commissions', label: 'Commissions & Payouts', permission: 'commissions:read', icon: ICONS.commissions },
    ],
  },
  {
    title: 'Settings',
    items: [
      { href: '/profile', label: 'Reseller Profile', icon: ICONS.profile },
    ],
  },
]

function isActive(pathname: string, item: NavItem) {
  if (item.href === '/dashboard') return pathname === '/dashboard'
  return [item.href, ...(item.match ?? [])].some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

export function ResellerShell({ children }: { children: (user: CurrentUser) => React.ReactNode }) {
  const user = useCurrentUser((u) => !isPlatformUser(u))
  const pathname = usePathname()
  const router = useRouter()

  if (!user) return null

  const initials = user.name
    ? user.name
        .split(' ')
        .map((p) => p[0])
        .slice(0, 2)
        .join('')
        .toUpperCase()
    : 'RS'

  const businessName = user.reseller?.businessName || 'Hexalyte Partner'
  const resellerCode = user.reseller?.code || 'RES-PARTNER'

  return (
    <div style={{ minHeight: '100vh', background: '#080b11', color: '#f8fafc' }}>
      {/* Top Header - Glassmorphic Cyber Dark */}
      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 40,
          background: 'rgba(8, 12, 20, 0.85)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
          height: '64px',
          display: 'flex',
          alignItems: 'center',
          padding: '0 1.5rem',
        }}
      >
        {/* Brand Area */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', width: '250px' }}>
          <div
            style={{
              width: '34px',
              height: '34px',
              borderRadius: '9px',
              background: 'linear-gradient(135deg, #6366f1 0%, #3b82f6 100%)',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 800,
              fontSize: '1rem',
              boxShadow: '0 0 18px rgba(99, 102, 241, 0.45)',
            }}
          >
            H
          </div>
          <div>
            <div style={{ fontWeight: 800, fontSize: '0.98rem', color: '#ffffff', letterSpacing: '-0.02em' }}>
              Hexalyte Partner
            </div>
            <div style={{ fontSize: '0.72rem', color: '#94a3b8', fontWeight: 500 }}>
              Reseller Console
            </div>
          </div>
        </div>

        {/* Live Status & Reseller ID Tag */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.45rem',
              background: 'rgba(255, 255, 255, 0.04)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              padding: '0.35rem 0.75rem',
              borderRadius: '20px',
              fontSize: '0.75rem',
              color: '#94a3b8',
              fontWeight: 600,
            }}
          >
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#10b981', boxShadow: '0 0 8px #10b981' }} />
            <span style={{ color: '#cbd5e1' }}>{businessName}</span>
            <span style={{ color: '#64748b' }}>·</span>
            <span className="mono" style={{ color: '#a5b4fc', fontSize: '0.72rem' }}>{resellerCode}</span>
          </div>
        </div>

        {/* Quick Actions & Profile Bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
          {user.permissions.includes('trials:create') && (
            <Link href="/trials/new" className="btn secondary small" style={{ display: 'inline-flex', gap: '0.35rem' }}>
              <span style={{ color: '#818cf8', fontWeight: 800 }}>+</span> New Trial
            </Link>
          )}

          {user.permissions.includes('activations:create') && (
            <Link href="/activations/new" className="btn small" style={{ display: 'inline-flex', gap: '0.35rem' }}>
              <span style={{ fontWeight: 800 }}>+</span> Activate
            </Link>
          )}

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.65rem',
              padding: '0.35rem 0.65rem',
              borderRadius: '9px',
              background: 'rgba(255, 255, 255, 0.04)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
            }}
          >
            <div
              style={{
                width: '30px',
                height: '30px',
                borderRadius: '8px',
                background: 'linear-gradient(135deg, #3b82f6 0%, #6366f1 100%)',
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
            <div>
              <div style={{ fontSize: '0.82rem', fontWeight: 700, color: '#f8fafc' }}>{user.name}</div>
              <div style={{ fontSize: '0.68rem', color: '#60a5fa', fontWeight: 700 }}>
                {user.role.replace('_', ' ')}
              </div>
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

      {/* Main Grid: Sidebar + Dynamic Content */}
      <div style={{ display: 'flex', minHeight: 'calc(100vh - 64px)' }}>
        {/* Next-Level Dark Sidebar */}
        <aside
          style={{
            width: '260px',
            background: '#090d16',
            borderRight: '1px solid rgba(255, 255, 255, 0.08)',
            padding: '1.5rem 0.85rem',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            gap: '1.6rem',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
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
                      color: '#64748b',
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
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.75rem',
                            padding: '0.58rem 0.75rem',
                            borderRadius: '9px',
                            fontSize: '0.88rem',
                            fontWeight: active ? 700 : 500,
                            color: active ? '#a5b4fc' : '#94a3b8',
                            background: active
                              ? 'linear-gradient(135deg, rgba(79, 70, 229, 0.25) 0%, rgba(139, 92, 246, 0.15) 100%)'
                              : 'transparent',
                            border: active ? '1px solid rgba(99, 102, 241, 0.35)' : '1px solid transparent',
                            boxShadow: active ? '0 0 15px rgba(99, 102, 241, 0.12)' : 'none',
                            transition: 'all 0.15s ease',
                          }}
                        >
                          <span style={{ color: active ? '#818cf8' : '#64748b', display: 'flex' }}>
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
          </div>

          {/* Bottom Partner Status Card */}
          <div
            style={{
              padding: '1rem',
              borderRadius: '12px',
              background: 'linear-gradient(145deg, rgba(15, 23, 42, 0.8) 0%, rgba(30, 27, 75, 0.4) 100%)',
              border: '1px solid rgba(99, 102, 241, 0.25)',
              boxShadow: '0 4px 15px rgba(0, 0, 0, 0.3)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
              <span style={{ fontSize: '0.7rem', fontWeight: 800, textTransform: 'uppercase', color: '#818cf8', letterSpacing: '0.04em' }}>
                Partner Tier
              </span>
              <span className="badge ACTIVE" style={{ fontSize: '0.62rem', padding: '0.1rem 0.4rem' }}>
                ACTIVE
              </span>
            </div>
            <div style={{ fontWeight: 700, fontSize: '0.86rem', color: '#ffffff', marginBottom: '0.15rem' }}>
              {businessName}
            </div>
            <div style={{ fontSize: '0.74rem', color: '#94a3b8' }}>
              Earn recurring monthly commissions on active SaaS customers.
            </div>
          </div>
        </aside>

        {/* Reseller Main Content View */}
        <main className="reseller-content" style={{ flex: 1, minWidth: 0, padding: '1.75rem 2.25rem', background: '#080b11' }}>
          {children(user)}
        </main>
      </div>
    </div>
  )
}
