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

  return (
    <header className="topbar">
      <div className={`container ${wide ? 'wide' : ''}`}>
        <span className="brand">Hexalyte Reseller</span>
        {links.map((l) => (
          <Link key={l.href} href={l.href}>
            {l.label}
          </Link>
        ))}
        <span className="spacer" />
        {notificationsHref && (
          <Link href={notificationsHref} className="bell" aria-label={`Notifications (${unread} unread)`}>
            Notifications
            {unread > 0 && <span className="bell-count">{unread > 99 ? '99+' : unread}</span>}
          </Link>
        )}
        <span className="muted small topbar-user">
          {user.name} · {user.role.replace('_', ' ').toLowerCase()}
        </span>
        <button
          className="btn secondary"
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
