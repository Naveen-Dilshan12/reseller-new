'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { isPlatformUser, logout, useCurrentUser } from '@/lib/auth'
import { AdminUserContext } from '@/lib/admin-context'

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
    title: 'Reseller Network',
    items: [
      { href: '/admin/resellers', label: 'Resellers', permission: 'resellers:read', match: ['/admin/reseller-applications'], icon: ICONS.resellers },
      { href: '/admin/products', label: 'SaaS Products', permission: 'products:manage', icon: ICONS.products },
      { href: '/admin/customer-accounts', label: 'Customers & Mapping', permission: 'accounts:read', icon: ICONS.customers },
    ],
  },
  {
    title: 'Operations & Billing',
    items: [
      { href: '/admin/trials', label: 'Trial Requests', permission: 'trials:read', icon: ICONS.trials },
      { href: '/admin/activations', label: 'Activation Requests', permission: 'activations:read', icon: ICONS.activations },
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

function isActive(pathname: string, item: NavItem) {
  if (item.href === '/admin') return pathname === '/admin'
  return [item.href, ...(item.match ?? [])].some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = useCurrentUser(isPlatformUser)
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
    : 'AD'

  return (
    <AdminUserContext.Provider value={user}>
      {/* Top Header - Sleek Dark Glass */}
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
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', width: '250px' }}>
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
              boxShadow: '0 0 18px rgba(99, 102, 241, 0.4)',
            }}
          >
            H
          </div>
          <div>
            <div style={{ fontWeight: 800, fontSize: '0.98rem', color: '#ffffff', letterSpacing: '-0.02em' }}>
              Hexalyte Admin
            </div>
            <div style={{ fontSize: '0.72rem', color: '#94a3b8', fontWeight: 500 }}>
              Central Platform
            </div>
          </div>
        </div>

        <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
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
            System Live · Asia/Colombo
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <Link
            href="/admin/notifications"
            style={{
              position: 'relative',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '38px',
              height: '38px',
              borderRadius: '9px',
              background: 'rgba(255, 255, 255, 0.04)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              color: '#cbd5e1',
            }}
            title="Notifications"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
              <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
            </svg>
            <span
              style={{
                position: 'absolute',
                top: '-3px',
                right: '-3px',
                background: '#ef4444',
                color: '#fff',
                fontSize: '0.65rem',
                fontWeight: 800,
                width: '18px',
                height: '18px',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: '2px solid #080c14',
                boxShadow: '0 0 8px rgba(239, 68, 68, 0.6)',
              }}
            >
              3
            </span>
          </Link>

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
            <div>
              <div style={{ fontSize: '0.82rem', fontWeight: 700, color: '#f8fafc' }}>{user.name}</div>
              <div style={{ fontSize: '0.68rem', color: '#34d399', fontWeight: 700 }}>SUPER ADMIN</div>
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

      {/* Main Container with Sidebar */}
      <div style={{ display: 'flex', minHeight: 'calc(100vh - 64px)' }}>
        {/* Dark Modern Cyber Sidebar */}
        <aside
          style={{
            width: '260px',
            background: '#090d16',
            borderRight: '1px solid rgba(255, 255, 255, 0.08)',
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
                          background: active ? 'linear-gradient(135deg, rgba(79, 70, 229, 0.25) 0%, rgba(139, 92, 246, 0.15) 100%)' : 'transparent',
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
        </aside>

        {/* Content Area */}
        <div className="admin-content" style={{ flex: 1, minWidth: 0, padding: '1.75rem 2.25rem', background: '#080b11' }}>
          {children}
        </div>
      </div>
    </AdminUserContext.Provider>
  )
}
