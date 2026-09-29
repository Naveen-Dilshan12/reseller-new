'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import { logout, type CurrentUser } from '@/lib/auth'

interface Props {
  user: CurrentUser
  links?: { href: string; label: string }[]
  /** Shows an unread-count badge linking to this page. */
  notificationsHref?: string
  wide?: boolean
}

export function TopBar({ user, links = [], notificationsHref, wide }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const [unread, setUnread] = useState(0)

  useEffect(() => {
    if (!notificationsHref) return
    api<{ count: number }>('/notifications/unread-count')
      .then((r) => setUnread(r.count))
      .catch(() => undefined)
  }, [notificationsHref, pathname])

  const initials = user.name
    ? user.name
        .split(' ')
        .map((p) => p[0])
        .slice(0, 2)
        .join('')
        .toUpperCase()
    : 'U'

  return (
    <header className="topbar">
      <div className={`container ${wide ? 'wide' : ''}`}>
        <Link href={user.role.startsWith('RESELLER') ? '/dashboard' : '/admin'} className="brand">
          Hexalyte Reseller
        </Link>

        {links.length > 0 && (
          <nav style={{ display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
            {links.map((l) => {
              const isActive = pathname === l.href || pathname.startsWith(`${l.href}/`)
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  style={
                    isActive
                      ? {
                          background: 'linear-gradient(135deg, rgba(79, 70, 229, 0.25) 0%, rgba(139, 92, 246, 0.15) 100%)',
                          color: '#a5b4fc',
                          fontWeight: 700,
                          border: '1px solid rgba(99, 102, 241, 0.35)',
                          borderRadius: '8px',
                          boxShadow: '0 0 12px rgba(99, 102, 241, 0.15)',
                        }
                      : {
                          color: '#94a3b8',
                          borderRadius: '8px',
                        }
                  }
                >
                  {l.label}
                </Link>
              )
            })}
          </nav>
        )}

        <span className="spacer" />

        {notificationsHref && (
          <Link href={notificationsHref} className="bell" aria-label={`Notifications (${unread} unread)`}>
            🔔 Notifications
            {unread > 0 && <span className="bell-count">{unread > 99 ? '99+' : unread}</span>}
          </Link>
        )}

        <div className="topbar-user">
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '24px',
              height: '24px',
              borderRadius: '9999px',
              background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)',
              color: '#fff',
              fontSize: '0.72rem',
              fontWeight: 800,
            }}
          >
            {initials}
          </span>
          <span style={{ fontWeight: 600, color: 'var(--text)' }}>{user.name}</span>
          <span className="badge ACTIVE" style={{ fontSize: '0.68rem', padding: '0.1rem 0.45rem' }}>
            {user.role.replace('_', ' ')}
          </span>
        </div>

        <button
          className="btn secondary small"
          onClick={async () => {
            await logout()
            router.replace('/login')
          }}
        >
          Log out
        </button>
      </div>
    </header>
  )
}
